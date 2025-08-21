#!/usr/bin/env node
/**
 * GemFlow DeepResearch — 热榜日报生成脚本
 * - 功能：
 *   1) 拉取 GitHub（基于 Search API 的“近 N 天新增按 star 排序”）与 Hacker News Top Stories 热榜
 *   2) 生成 Markdown 报告
 *   3) 使用 GH REST API 将报告提交到目标仓库（Repo B）
 *
 * 运行环境：
 * - Node.js 20（全局 fetch 可用）
 * - 需要环境变量：
 *   - GH_TOKEN (必需)：访问 Repo B 的 PAT（工作流已注入：secrets.REPO_B_TOKEN -> GH_TOKEN）
 *   - REPO_B (可选)：owner/repo，未设置时默认：${GITHUB_REPOSITORY_OWNER}/DeepResearch-Archive 或 owner/DeepResearch-Archive
 *   - TZ (可选)：默认 Asia/Shanghai
 *   - TRENDING_SINCE_DAYS (可选)：GitHub 热榜统计范围（默认 1 天）
 *   - GITHUB_TRENDING_PER_PAGE (可选)：GitHub 热榜条数（默认 20）
 *   - HN_TOP_N (可选)：Hacker News Top Stories 条数（默认 20）
 */

import { setTimeout as delay } from 'node:timers/promises';

const UA = 'GemFlow-DeepResearchBot/1.0';
const TZ = process.env.TZ || 'Asia/Shanghai';
const GH_TOKEN =
  process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.REPO_B_TOKEN || '';
const REPO_B =
  process.env.REPO_B ||
  (process.env.GITHUB_REPOSITORY_OWNER
    ? `${process.env.GITHUB_REPOSITORY_OWNER}/DeepResearch-Archive`
    : 'owner/DeepResearch-Archive');

const TRENDING_SINCE_DAYS = Number(process.env.TRENDING_SINCE_DAYS || 1);
const GITHUB_TRENDING_PER_PAGE = Number(process.env.GITHUB_TRENDING_PER_PAGE || 20);
const HN_TOP_N = Number(process.env.HN_TOP_N || 20);
const BAIDU_TOP_N = Number(process.env.BAIDU_TOP_N || 30);
const BAIDU_TAB = process.env.BAIDU_TAB || 'realtime';

// 基础日志输出
function log(...args) {
  const nowUTC = new Date().toISOString();
  console.log(`[DeepResearch][${nowUTC}]`, ...args);
}

// 日期工具（按 TZ 输出 YYYY-MM-DD）
function dateParts(tz = TZ) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const date = fmt.format(now); // YYYY-MM-DD
  const [y, m, d] = date.split('-');
  return { y, m, d, date, iso: now.toISOString() };
}

// 简单重试封装
async function fetchWithRetry(url, options = {}, tries = 3, backoffMs = 500) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      log(`fetch failed (${i + 1}/${tries}) for ${url}:`, err.message || err);
      if (i < tries - 1) await delay(backoffMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}

async function fetchJSON(url, options = {}, tries = 3, backoffMs = 500) {
  const res = await fetchWithRetry(url, options, tries, backoffMs);
  return res.json();
}

// GitHub API 封装
function ghHeaders(extra = {}) {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    ...extra,
  };
  if (GH_TOKEN) headers.Authorization = `token ${GH_TOKEN}`;
  return headers;
}

async function ghGet(path) {
  const url = `https://api.github.com${path}`;
  return fetchJSON(url, { headers: ghHeaders() });
}

async function ghRequest(method, path, body) {
  const url = `https://api.github.com${path}`;
  const res = await fetchWithRetry(url, {
    method,
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// 热榜数据源 —— GitHub（基于 Search API 的“近 N 天新增按 star 排序”）
async function getGitHubTrending({ sinceDays = TRENDING_SINCE_DAYS, perPage = GITHUB_TRENDING_PER_PAGE } = {}) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);
  const sinceStr = since.toISOString().slice(0, 10); // YYYY-MM-DD

  const q = `created:%3E=${sinceStr}`; // created:>=YYYY-MM-DD
  const searchUrl = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}`;
  log('Fetching GitHub trending:', searchUrl.replace(/&/g, '&'));

  const data = await fetchJSON(searchUrl.replace(/&/g, '&'), { headers: ghHeaders() });
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((r) => ({
    full_name: r.full_name,
    html_url: r.html_url,
    description: r.description,
    language: r.language,
    stargazers_count: r.stargazers_count,
    stars: r.stargazers_count,
  }));
}

// 热榜数据源 —— Hacker News Top Stories
async function getHackerNewsTop(n = HN_TOP_N) {
  const base = 'https://hacker-news.firebaseio.com/v0';
  const ids = await fetchJSON(`${base}/topstories.json`, { headers: { 'User-Agent': UA } });
  const pick = (ids || []).slice(0, n);

  const chunks = await Promise.all(
    pick.map(async (id) => {
      try {
        const item = await fetchJSON(`${base}/item/${id}.json`, { headers: { 'User-Agent': UA } });
        return {
          id,
          title: item.title,
          url: item.url,
          score: item.score,
          by: item.by,
          descendants: item.descendants,
          hn_url: `https://news.ycombinator.com/item?id=${id}`,
        };
      } catch {
        return null;
      }
    }),
  );
  return chunks.filter(Boolean);
}

// 热榜数据源 —— 百度热搜（实时榜）
async function getBaiduHotSearch(n = BAIDU_TOP_N, tab = BAIDU_TAB) {
  const url = `https://top.baidu.com/api/board?tab=${encodeURIComponent(tab)}`;
  log('Fetching Baidu Hot Search:', url);
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': `https://top.baidu.com/board?tab=${tab}`,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    },
    3,
    500
  );
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  const cards = (data && data.data && Array.isArray(data.data.cards)) ? data.data.cards : [];
  let content = [];
  for (const card of cards) {
    if (Array.isArray(card.content)) content = content.concat(card.content);
    else if (Array.isArray(card.items)) content = content.concat(card.items);
    else if (card.card && Array.isArray(card.card.content)) content = content.concat(card.card.content);
  }

  const items = (content || []).slice(0, n).map((it) => ({
    title: it.word || it.query || it.title || it.name || it.keyword || '',
    desc: it.desc || it.summary || '',
    url: it.url || it.appUrl || it.rawUrl || '',
    hotScore: it.hotScore || it.hotScoreNum || it.hot || it.index || 0,
    label: it.hotTag || it.tag || it.category || '',
  })).filter((i) => i.title);

  return items;
}

// Markdown 生成
function toMarkdown({ baidu = [], gh = [], hn = [], meta }) {
  const { date } = meta;

  const baiduLines = baidu.map(
    (r, i) =>
      `${i + 1}. [${r.title}](${r.url || 'https://top.baidu.com/board?tab=' + BAIDU_TAB})` +
      `${r.hotScore ? ' — 热度 ' + r.hotScore : ''}` +
      `${r.label ? ' — ' + r.label : ''}` +
      `${r.desc ? ' — ' + String(r.desc).replace(/\r?\n/g, ' ') : ''}`,
  );

  const ghLines = gh.map(
    (r, i) =>
      `${i + 1}. [${r.full_name}](${r.html_url}) — ★ ${r.stars}` +
      `${r.language ? ' — ' + r.language : ''}` +
      `${r.description ? ' — ' + r.description.replace(/\r?\n/g, ' ') : ''}`,
  );

  const hnLines = hn.map(
    (r, i) =>
      `${i + 1}. [${r.title}](${r.url || r.hn_url}) ` +
      `[HN](${r.hn_url}) — ${r.score ?? 0} points | ${r.descendants ?? 0} comments`,
  );

  return [
    `# 每日热榜 ${date} (CST)\n`,
    `> 生成时间：${meta.generatedAt}（时区：${TZ}）`,
    '',
    '## 百度热搜榜（tab: ' + BAIDU_TAB + '）',
    baiduLines.length ? baiduLines.join('\n') : '_暂无数据_',
    '',
    '## GitHub 热门仓库（近 ' + TRENDING_SINCE_DAYS + ' 天新增，按 Star 排序）',
    ghLines.length ? ghLines.join('\n') : '_暂无数据_',
    '',
    '## Hacker News Top Stories',
    hnLines.length ? hnLines.join('\n') : '_暂无数据_',
    '',
    '---',
    '由 GemFlow DeepResearch 自动生成',
    '',
  ].join('\n');
}

// 提交到 Repo B：Create or update file
async function commitToRepoB({ path, content, message }) {
  if (!GH_TOKEN) {
    log('GH_TOKEN 未提供，跳过提交。仅输出 Markdown：\n', content.slice(0, 500));
    return { skipped: true };
  }

  if (!REPO_B || !REPO_B.includes('/')) {
    throw new Error(`REPO_B 配置不正确：${REPO_B}`);
  }
  const [owner, repo] = REPO_B.split('/');

  let branch = 'main';
  try {
    const repoInfo = await ghGet(`/repos/${owner}/${repo}`);
    branch = repoInfo.default_branch || 'main';
  } catch (e) {
    log('获取目标仓库信息失败，将默认使用 main 分支：', e.message || e);
  }

  // 查询是否已存在
  let sha = null;
  try {
    const fileInfo = await ghGet(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/') }?ref=${branch}`);
    sha = fileInfo.sha || null;
  } catch (e) {
    // 404 正常表示文件不存在
    log('目标文件不存在，将创建新文件：', path);
  }

  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
    committer: {
      name: 'github-actions[bot]',
      email: '41898282+github-actions[bot]@users.noreply.github.com',
    },
    author: {
      name: 'github-actions[bot]',
      email: '41898282+github-actions[bot]@users.noreply.github.com',
    },
    sha: sha || undefined,
  };

  const resp = await ghRequest('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/') }`, body);
  if (!resp.content) {
    throw new Error(`提交失败：${JSON.stringify(resp)}`);
  }
  log(`提交成功：${owner}/${repo}@${resp.commit?.sha || 'unknown'} -> ${path}`);
  return resp;
}

async function main() {
  const { y, date, iso } = dateParts();
  log('目标仓库(REPO_B)：', REPO_B);
  log('时区(TZ)：', TZ);
  log('当前时间(UTC)：', new Date().toISOString());

  // 1) 拉取热榜
  const [baidu, gh, hn] = await Promise.all([
    getBaiduHotSearch(BAIDU_TOP_N),
    getGitHubTrending({}),
    getHackerNewsTop(HN_TOP_N),
  ]);

  // 2) 生成 Markdown
  const md = toMarkdown({
    baidu,
    gh,
    hn,
    meta: { date, generatedAt: iso },
  });

  // 3) 提交到 Repo B（目录：trending/YYYY/YYYY-MM-DD.md）
  const targetPath = `trending/${y}/${date}.md`;
  const message = `chore(trending): ${date} 热榜日报（百度热搜 + GitHub + Hacker News）`;
  await commitToRepoB({ path: targetPath, content: md, message });
}

// 执行
main().catch((err) => {
  console.error('[DeepResearch] 任务失败：', err);
  process.exitCode = 1;
});