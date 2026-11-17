/**
 * 将 agent-eval 的 trace 事件映射为 Langfuse ingestion batch。
 *
 * 设计约束：
 * - 只导出结构化元数据（模型、token、耗时、检索命中、工具参数），不导出 prompt 正文；
 * - 纯函数生成 batch，便于单测；网络推送由 pushLangfuseBatch 单独负责；
 * - Langfuse 仅作观测层，gate 判定仍以自研 verifier 为准。
 */

const TRACE_SCHEMA = "wfxm.trace/0"

/** 失败样本默认进入的 Langfuse 标注队列。 */
export const DEFAULT_ANNOTATION_QUEUE = "agent-eval-failures"

/** 队列必须绑定至少一个 score config，人工复核用 0–1 判定。 */
const QUEUE_SCORE_CONFIG = {
  name: "eval-failure-verdict",
  dataType: "NUMERIC",
  minValue: 0,
  maxValue: 1,
  description: "人工复核：该失败样本是否可接受（0 不可接受，1 可接受）",
}

/** @typedef {Record<string, any>} TraceEvent */

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function payload(event) {
  return isObject(event?.payload) ? event.payload : {}
}

function parentOf(event, rootSpanId) {
  const parent = event?.parentSpanId
  if (!parent || parent === rootSpanId) return undefined
  return parent
}

function usageFrom(response) {
  if (!response) return undefined
  const input = Number(response.payload?.inputTokens ?? NaN)
  const output = Number(response.payload?.outputTokens ?? NaN)
  const total = Number(response.payload?.totalTokens ?? NaN)
  if (![input, output, total].every(Number.isFinite)) return undefined
  return { input, output, total, unit: "TOKENS" }
}

/**
 * @param {readonly TraceEvent[]} events
 * @param {{ sessionId?: string, traceName?: string }} [options]
 * @returns {Array<{ id: string, type: string, timestamp: string, body: Record<string, unknown> }>}
 */
export function buildLangfuseBatch(events, options = {}) {
  if (!Array.isArray(events) || events.length === 0) return []
  const start = events.find((event) => event.type === "run.start") ?? events[0]
  if (start?.schema !== TRACE_SCHEMA) {
    throw new Error(`不支持的 trace schema：${String(start?.schema)}`)
  }
  const traceId = options.traceId ?? start.traceId
  const rootSpanId = start.spanId
  const runEnd = events.find((event) => event.type === "run.end")
  const startPayload = payload(start)

  /** @type {Array<{ id: string, type: string, timestamp: string, body: Record<string, unknown> }>} */
  const batch = []
  const add = (type, body, timestamp) => {
    batch.push({ id: crypto.randomUUID(), type, timestamp, body })
  }

  add(
    "trace-create",
    {
      id: traceId,
      name: options.traceName ?? String(startPayload.taskId ?? traceId),
      timestamp: start.ts,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      input: { taskId: startPayload.taskId },
      metadata: {
        runtime: start.runtime,
        scenarioId: startPayload.scenarioId,
        modelMode: startPayload.model,
      },
    },
    start.ts,
  )

  const consumed = new Set()
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (consumed.has(event.seq)) continue
    const parentObservationId = parentOf(event, rootSpanId)
    const base = {
      traceId,
      ...(parentObservationId ? { parentObservationId } : {}),
    }

    if (event.type === "run.start" || event.type === "run.end") continue

    if (event.type === "model.request") {
      const response = events
        .slice(i + 1)
        .find((candidate) => candidate.type === "model.response" && !consumed.has(candidate.seq))
      if (response) consumed.add(response.seq)
      const usage = usageFrom(response)
      const costUsd = response?.payload?.costUsd
      add(
        "generation-create",
        {
          ...base,
          id: event.spanId,
          name: "llm.call",
          startTime: event.ts,
          endTime: response?.ts ?? event.ts,
          ...(typeof event.payload.model === "string" ? { model: event.payload.model } : {}),
          input: {
            messages: event.payload.messages,
            tools: event.payload.tools,
            promptChars: event.payload.promptChars,
          },
          ...(response
            ? {
                output: {
                  contentChars: response.payload.contentChars,
                  toolCallCount: response.payload.toolCallCount,
                },
              }
            : {}),
          ...(usage ? { usage } : {}),
          // Langfuse v3 只落库 costDetails；`cost` 会被静默忽略。
          ...(typeof costUsd === "number" ? { costDetails: { total: costUsd } } : {}),
          metadata: {
            status: response?.payload.status ?? event.payload.status,
            durationMs: response?.payload.durationMs,
            ...(response?.payload.reason ? { error: response.payload.reason } : {}),
          },
          ...(response?.payload.status === "error" ? { level: "ERROR" } : {}),
        },
        event.ts,
      )
      continue
    }

    if (event.type === "model.response") {
      // 无 request 的孤儿 response（例如上游只记录完成事件）。
      const usage = usageFrom(event)
      add(
        "generation-create",
        {
          ...base,
          id: event.spanId,
          name: "llm.call",
          startTime: event.ts,
          endTime: event.ts,
          ...(usage ? { usage } : {}),
          metadata: { status: event.payload.status, durationMs: event.payload.durationMs },
          ...(event.payload.status === "error" ? { level: "ERROR" } : {}),
        },
        event.ts,
      )
      continue
    }

    if (event.type === "tool.call") {
      const name = String(event.payload.name ?? "tool")
      const result = events
        .slice(i + 1)
        .find(
          (candidate) =>
            candidate.type === "tool.result" &&
            candidate.payload?.name === event.payload.name &&
            !consumed.has(candidate.seq),
        )
      if (result) consumed.add(result.seq)
      add(
        "span-create",
        {
          ...base,
          id: event.spanId,
          name: `tool.${name}`,
          startTime: event.ts,
          endTime: result?.ts ?? event.ts,
          input: event.payload.args ?? {},
          ...(result ? { output: result.payload } : {}),
          metadata: { ok: result?.payload?.ok },
          ...(result && result.payload?.ok === false ? { level: "WARNING" } : {}),
        },
        event.ts,
      )
      continue
    }

    if (event.type === "tool.result") {
      add(
        "span-create",
        {
          ...base,
          id: event.spanId,
          name: `tool.${String(event.payload.name ?? "tool")}`,
          startTime: event.ts,
          endTime: event.ts,
          output: event.payload,
          ...(event.payload.ok === false ? { level: "WARNING" } : {}),
        },
        event.ts,
      )
      continue
    }

    if (event.type === "rag.retrieve") {
      add(
        "span-create",
        {
          ...base,
          id: event.spanId,
          name: "rag.retrieve",
          startTime: event.ts,
          endTime: event.ts,
          input: {
            scope: event.payload.scope,
            query: event.payload.query,
            limit: event.payload.limit,
          },
          output: { hits: event.payload.hits ?? [] },
          metadata: { capability: event.payload.capability },
        },
        event.ts,
      )
      continue
    }

    if (event.type === "turn.start") {
      const end = events
        .slice(i + 1)
        .find((candidate) => candidate.type === "turn.end" && !consumed.has(candidate.seq))
      if (end) consumed.add(end.seq)
      add(
        "span-create",
        {
          ...base,
          id: event.spanId,
          name: `turn.${event.payload.turn ?? event.payload.index ?? "?"}`,
          startTime: event.ts,
          endTime: end?.ts ?? event.ts,
          input: { content: event.payload.content ?? event.payload.input },
          ...(end ? { output: end.payload } : {}),
        },
        event.ts,
      )
      continue
    }

    if (event.type === "turn.end") continue

    // 其他事件保留为通用 span，避免静默丢失。
    add(
      "span-create",
      {
        ...base,
        id: event.spanId,
        name: event.type,
        startTime: event.ts,
        endTime: event.ts,
        input: payload(event),
      },
      event.ts,
    )
  }

  if (runEnd) {
    add(
      "trace-create",
      {
        id: traceId,
        name: options.traceName ?? String(startPayload.taskId ?? traceId),
        timestamp: start.ts,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        input: { taskId: startPayload.taskId },
        output: payload(runEnd),
        metadata: {
          runtime: start.runtime,
          scenarioId: startPayload.scenarioId,
          modelMode: startPayload.model,
          status: runEnd.payload?.status,
        },
      },
      runEnd.ts,
    )
  }

  return batch
}

/**
 * 推送 batch 到 Langfuse ingestion API（Basic auth）。
 *
 * @param {readonly object[]} batch
 * @param {{ host: string, publicKey: string, secretKey: string }} config
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export async function pushLangfuseBatch(batch, config, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") throw new Error("当前运行时不支持 fetch")
  const host = String(config.host ?? "").replace(/\/+$/, "")
  if (!host || !config.publicKey || !config.secretKey) {
    throw new Error("缺少 LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY")
  }
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")
  const response = await fetchImpl(`${host}/api/public/ingestion`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ batch }),
  })
  const text = await response.text().catch(() => "")
  if (!response.ok) {
    throw new Error(`Langfuse ingestion ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`)
  }
  // ingestion 用 207 表示批量部分成功；errors 非空时不能当成功。
  const parsed = safeJson(text)
  const errors = Array.isArray(parsed?.errors) ? parsed.errors : []
  if (errors.length > 0) {
    const detail = errors
      .slice(0, 3)
      .map((item) => item?.message ?? item?.error ?? JSON.stringify(item))
      .join("; ")
    throw new Error(
      `Langfuse ingestion 部分失败（${errors.length}/${batch.length}）：${detail.slice(0, 300)}`,
    )
  }
  return { ok: true, status: response.status, count: batch.length }
}

function safeJson(text) {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 统一调用 Langfuse public API（Basic auth + JSON）。 */
async function langfuseRequest(config, path, { method = "GET", body, fetchImpl } = {}) {
  const impl = fetchImpl ?? globalThis.fetch
  if (typeof impl !== "function") throw new Error("当前运行时不支持 fetch")
  const host = String(config?.host ?? "").replace(/\/+$/, "")
  if (!host || !config.publicKey || !config.secretKey) {
    throw new Error("缺少 LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY")
  }
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")
  const response = await impl(`${host}/api/public${path}`, {
    method,
    headers: {
      authorization: `Basic ${auth}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text().catch(() => "")
  if (!response.ok) {
    throw new Error(`Langfuse ${method} ${path} ${response.status}: ${text.slice(0, 300)}`)
  }
  const parsed = safeJson(text)
  if (parsed === undefined) throw new Error(`Langfuse ${method} ${path} 返回非 JSON`)
  return parsed
}

/**
 * 确保标注队列存在，返回队列对象。队列不存在时先确保 score config 存在，
 * 再创建队列（Langfuse v3 要求 scoreConfigIds 至少 1 个）。
 */
export async function ensureAnnotationQueue(config, options = {}) {
  const name = options.name ?? DEFAULT_ANNOTATION_QUEUE
  const fetchImpl = options.fetchImpl
  const queues = await langfuseRequest(config, "/annotation-queues?limit=100", { fetchImpl })
  const existing = (queues.data ?? []).find((queue) => queue.name === name)
  if (existing) return existing

  const configs = await langfuseRequest(config, "/score-configs?limit=100", { fetchImpl })
  let scoreConfig = (configs.data ?? []).find((item) => item.name === QUEUE_SCORE_CONFIG.name)
  if (!scoreConfig) {
    scoreConfig = await langfuseRequest(config, "/score-configs", {
      method: "POST",
      body: QUEUE_SCORE_CONFIG,
      fetchImpl,
    })
  }
  return langfuseRequest(config, "/annotation-queues", {
    method: "POST",
    body: {
      name,
      description: "评估失败样本，待人工复核后决定是否转为回归任务",
      scoreConfigIds: [scoreConfig.id],
    },
    fetchImpl,
  })
}

/** 把一条 trace 放入标注队列（objectType 固定 TRACE）。 */
export function enqueueAnnotationTrace(config, queueId, traceId, options = {}) {
  return langfuseRequest(config, `/annotation-queues/${queueId}/items`, {
    method: "POST",
    body: { objectId: traceId, objectType: "TRACE" },
    fetchImpl: options.fetchImpl,
  })
}

/** 环境变量是否启用 Langfuse 导出。 */
export function langfuseEnabled(env = process.env) {
  return (env.AGENT_EVAL_LANGFUSE ?? "").trim() === "1"
}

/** 从环境变量构造 Langfuse 配置；不完整时返回 null。 */
export function langfuseConfigFromEnv(env = process.env) {
  const host = (env.LANGFUSE_HOST ?? "").trim()
  const publicKey = (env.LANGFUSE_PUBLIC_KEY ?? "").trim()
  const secretKey = (env.LANGFUSE_SECRET_KEY ?? "").trim()
  if (!host || !publicKey || !secretKey) return null
  return { host, publicKey, secretKey }
}
