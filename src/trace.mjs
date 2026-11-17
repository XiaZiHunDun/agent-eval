const REQUIRED = ["schema", "traceId", "runId", "runtime", "seq", "ts", "type", "actor", "payload"]

/**
 * 创建一条 trace 的事件收集器。
 * @param {{ runtime: "wfxm" | "dsh-wfxm", runId: string, traceId?: string }} init
 */
export function createTrace(init) {
  const traceId = init.traceId ?? crypto.randomUUID()
  const events = []
  let seq = 0
  let rootSpanId

  function emit(type, payload = {}, extra = {}) {
    const event = {
      schema: "wfxm.trace/0",
      traceId,
      runId: init.runId,
      runtime: init.runtime,
      seq: seq++,
      ts: new Date().toISOString(),
      type,
      spanId: crypto.randomUUID(),
      parentSpanId: extra.parentSpanId ?? rootSpanId ?? null,
      actor: extra.actor ?? { kind: "system", id: init.runtime },
      payload,
      ...(extra.usage ? { usage: extra.usage } : {}),
      ...(extra.redaction ? { redaction: extra.redaction } : {}),
    }
    if (type === "run.start") rootSpanId = event.spanId
    events.push(event)
    return event
  }

  return { traceId, events, emit }
}

/** 校验 trace 的基本不变量，返回问题列表（空数组表示通过）。 */
export function validateTrace(events) {
  const problems = []
  if (!Array.isArray(events) || events.length === 0) return ["trace 为空"]

  for (const [i, e] of events.entries()) {
    for (const key of REQUIRED) {
      if (!(key in e)) problems.push(`event[${i}] 缺少字段 ${key}`)
    }
    if (e.schema !== "wfxm.trace/0") problems.push(`event[${i}] schema 非 wfxm.trace/0`)
    if (e.seq !== i) problems.push(`event[${i}] seq=${e.seq} 非连续（期望 ${i}）`)
  }

  if (events[0]?.type !== "run.start") problems.push("首个事件必须是 run.start")
  if (events.at(-1)?.type !== "run.end") problems.push("最后一个事件必须是 run.end")
  else if (events.at(-1)?.payload?.status === "error") {
    problems.push("run.end status=error")
  }
  return problems
}

/** @param {string} filePath @param {readonly object[]} events */
export function writeTraceJsonl(filePath, events) {
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
  return import("node:fs/promises").then((fs) => fs.writeFile(filePath, body, "utf8"))
}
