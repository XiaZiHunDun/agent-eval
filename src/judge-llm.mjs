import { parseJudgeScore } from "./judge.mjs"

/** 固定 judge 模型：OpenAI-compatible，默认 DeepSeek Flash。 */
function normalizeBaseUrl(baseUrl) {
  return (baseUrl || "https://api.deepseek.com").replace(/\/+$/, "")
}

/**
 * 构造软性评分函数：同一 prompt 采 `samples` 次（默认双评），
 * 只解析 `SCORE=<1-5>`，不解析自然语言理由。
 *
 * @param {{ apiKey: string, baseUrl?: string, model?: string, samples?: number, timeoutMs?: number, fetchImpl?: typeof fetch }} input
 */
export function createOpenAIJudge({
  apiKey,
  baseUrl,
  model = "deepseek-flash",
  samples = 2,
  timeoutMs = 20_000,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("judge 需要 API key")
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`

  const ask = async (prompt) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`judge HTTP ${response.status}`)
    const data = await response.json()
    return parseJudgeScore(data?.choices?.[0]?.message?.content ?? "")
  }

  return async ({ prompt }) => {
    const scores = (await Promise.all(Array.from({ length: samples }, () => ask(prompt)))).filter(
      (score) => score !== null,
    )
    return { scores }
  }
}

/** 从环境构造 judge；未配置任何 key 时返回 undefined（调用方决定是否报错）。 */
export function judgeFromEnv(env = process.env) {
  const apiKey = (env.JUDGE_API_KEY || env.DEEPSEEK_API_KEY || "").trim()
  if (!apiKey) return undefined
  return createOpenAIJudge({
    apiKey,
    baseUrl: env.JUDGE_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: (env.JUDGE_MODEL || "deepseek-flash").trim(),
  })
}
