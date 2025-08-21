import { CreateLibraryAOptions, ModelParams } from "./types";

/**
 * 解析环境变量与入参，生成模型与运行配置
 * - 只读取 GEMINI_API_KEY 或 GOOGLE_API_KEY
 * - 模型名默认 gemini-1.5-pro，可由入参或 GEMINI_MODEL 覆盖
 */
export function resolveModelParams(
  options: CreateLibraryAOptions
): ModelParams {
  const apiKey =
    options.apiKey ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    "";

  if (!apiKey) {
    throw new Error(
      "缺少 Gemini API Key，请设置 GEMINI_API_KEY 或 GOOGLE_API_KEY，或通过 createLibraryA({ apiKey }) 传入。"
    );
  }

  const model =
    options.model ?? process.env.GEMINI_MODEL ?? "gemini-1.5-pro";

  const temperature =
    options.temperature ??
    toNumber(process.env.GEMINI_TEMPERATURE, undefined);

  const topK = toInt(process.env.GEMINI_TOP_K, options.topK);
  const topP = toNumber(process.env.GEMINI_TOP_P, options.topP);
  const maxTokens = toInt(process.env.GEMINI_MAX_TOKENS, options.maxTokens);

  const enableStreaming =
    options.enableStreaming ??
    toBool(process.env.GEMINI_STREAMING, true);

  return {
    apiKey,
    model,
    temperature,
    topK,
    topP,
    maxTokens,
    enableStreaming,
    systemPrompt: options.systemPrompt,
    timeouts: options.timeouts ?? parseTimeoutsFromEnv(),
    retries: options.retries ?? parseRetriesFromEnv(),
    rateLimit: options.rateLimit ?? parseRateLimitFromEnv(),
  };
}

function parseTimeoutsFromEnv() {
  return {
    perStepMs: toInt(process.env.TIMEOUT_PER_STEP_MS),
    totalMs: toInt(process.env.TIMEOUT_TOTAL_MS),
  };
}

function parseRetriesFromEnv() {
  return {
    max: toInt(process.env.RETRY_MAX, 3),
    initialDelayMs: toInt(process.env.RETRY_INITIAL_MS, 500),
    factor: toNumber(process.env.RETRY_FACTOR, 2),
    maxDelayMs: toInt(process.env.RETRY_MAX_DELAY_MS),
  };
}

function parseRateLimitFromEnv() {
  return {
    rpm: toInt(process.env.RATE_LIMIT_RPM),
    tpm: toInt(process.env.RATE_LIMIT_TPM),
    concurrent: toInt(process.env.RATE_LIMIT_CONCURRENT),
    enabled: toBool(process.env.RATE_LIMIT_ENABLED, true),
  };
}

function toInt(v: string | undefined, fallback?: number) {
  if (v == null || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toNumber(v: string | undefined, fallback?: number) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(v: string | undefined, fallback = false) {
  if (v == null || v === "") return fallback;
  const s = v.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}