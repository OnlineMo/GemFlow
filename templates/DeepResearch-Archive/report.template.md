---
title: {{TITLE}} # 可为中文或英文（建议：中文更友好；英文用于跨平台兼容）
title_en: {{TITLE_EN}} # 可选：若提供则用于文件名优先，其次回退到 title
date: {{DATE}} # YYYY-MM-DD
edition: {{EDITION}} # e.g., v1
category_slug: {{CATEGORY_SLUG}}
category_display: {{CATEGORY_DISPLAY}}
source: {{SOURCE}}
slug: {{SLUG}} # 可选：内部索引/去重使用，不参与文件名
# tags: [{{TAG1}}, {{TAG2}}] # optional
---

来源 Source: {{SOURCE}}

# 摘要 Summary
- 核心发现/要点（3-5 条）
- Key findings / bullets (3-5)

# 背景 Background
- 背景信息与跨源验证
- Context and cross-source validation

# 深度分析 Deep Dive
- 论点 1 / Point 1
- 论点 2 / Point 2
- 论点 3 / Point 3

# 数据与引用 Data & References
- [来源 1](...) / Source 1
- [来源 2](...) / Source 2

# 结论与建议 Conclusions & Recommendations
- 结论与可执行建议
- Actionable recommendations

# 元信息 Metadata
- category_slug: {{CATEGORY_SLUG}}
- category_display: {{CATEGORY_DISPLAY}}
- date: {{DATE}}
- edition: {{EDITION}}
- title / title_en: {{TITLE}} / {{TITLE_EN}}
- slug: {{SLUG}} (optional)

<!--
命名规则（文件名已改为“中文或英文标题”，弃用拼音）:
- 优先使用 title_en 作为文件名中的标题；若未提供，则使用 title（可为中文）
- 文件名模式（见 categories.default.json 中 filePattern）:
  - {title}-{date}--v{edition}.md
  - 示例（中文）: AI 本地小模型优化-2025-08-20--v1.md
  - 示例（英文）: Local-LLM-Optimization-2025-08-20--v1.md
- 规范化处理（生成器应当执行）:
  - 移除非法字符: / \ : * ? " < > | 等
  - 多空白压缩为单空格；开头/结尾空白去除
  - 将连续的分隔符（空格/连字符/下划线）统一压缩为单个连字符或空格（实现自定）
  - 路径编码: UTF-8；建议在 Windows/Mac/Linux 上保持一致
- 版次: 同日同题重复生成 → 递增 vN（--v2、--v3…）
- slug 字段: 作为内部稳定 ID（history.json / 去重使用），不参与文件命名

渲染指引（库 A）:
- 使用 templates/DeepResearch-Archive/categories.default.json 的 filePattern = {title}-{date}--v{edition}.md
  - title 的实际取值: title_en ?? title
- README（today）与 NAVIGATION 使用对应模板:
  - templates/DeepResearch-Archive/readme.today.md
  - templates/DeepResearch-Archive/navigation.skeleton.md
-->