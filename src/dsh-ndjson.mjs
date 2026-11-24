/**
 * dsh headless NDJSON → 统一 trace（wfxm.trace/0）+ observation。
 *
 * 真实运行与离线回放共用同一条路径：adapter 只负责拿到 NDJSON，
 * 这里负责把它变成 `verify` 能读的外部可观察行为。
 */

import { createTrace } from "./trace.mjs"

function asName(event) {
  return event.tool ?? event.name ?? event.path ?? event.toolName
}

/**
 * @param {string} stdout dsh `--json` 输出的 NDJSON
 * @param {{ runtime?: "wfxm" | "dsh-wfxm", runId: string, turnIndex?: number, prompt?: string }} opts
 * @returns {{ trace: object[], obs: object }}
 */
export function parseDshNdjson(stdout, { runtime = "dsh-wfxm", runId, turnIndex = 0, prompt } = {}) {
  const lines = []
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "") continue
    try {
      lines.push(JSON.parse(line))
    } catch {
      // dsh 可能在 stdout 打非 JSON 诊断；不是失败信号。
    }
  }

  const sessionId = lines.find(
    (event) => event?.type === "session" && typeof event.sessionId === "string",
  )?.sessionId

  const trace = createTrace({ runtime, runId })
  trace.emit("run.start", { ...(sessionId ? { sessionId } : {}) })
  trace.emit("turn.start", { turnIndex, ...(prompt ? { prompt } : {}) })

  /** @type {{ name: string, args?: Record<string, unknown> }[]} */
  const toolCalls = []
  /** @type {({ name: string, ok: boolean } | undefined)[]} */
  const toolResults = []
  const pending = []
  const tokens = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  let steps = 0
  let reply = ""
  let error
  let sawToolResult = false

  for (const event of lines) {
    if (!event || typeof event !== "object") continue
    const type = event.type

    if (type === "tool_call") {
      const name = asName(event)
      if (typeof name !== "string") continue
      const args =
        event.args ?? event.arguments ?? (event.input && typeof event.input === "object" ? event.input : undefined)
      const index = toolCalls.push({ name, ...(args ? { args } : {}) }) - 1
      pending.push(index)
      trace.emit("tool.call", { name, ...(args ? { args } : {}) }, {
        actor: { kind: "agent", id: runtime },
      })
      continue
    }

    if (type === "tool_result") {
      sawToolResult = true
      const name = asName(event)
      const ok = event.ok !== false && event.success !== false
      let index = -1
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (name === undefined || toolCalls[pending[i]].name === name) {
          index = pending[i]
          pending.splice(i, 1)
          break
        }
      }
      if (index >= 0) {
        toolResults[index] = { name: toolCalls[index].name, ok }
        trace.emit("tool.result", { name: toolCalls[index].name, ok }, {
          actor: { kind: "system", id: runtime },
        })
      }
      continue
    }

    if (type === "status" && event.phase === "step_end") {
      steps += 1
      const usage = event.usage ?? {}
      tokens.inputTokens += Number(usage.inputTokens) || 0
      tokens.outputTokens += Number(usage.outputTokens) || 0
      tokens.costUsd += Number(usage.costUsd) || 0
      trace.emit(
        "model.response",
        { phase: "step_end" },
        {
          usage: {
            inputTokens: Number(usage.inputTokens) || 0,
            outputTokens: Number(usage.outputTokens) || 0,
            ...(Number(usage.costUsd) ? { costUsd: Number(usage.costUsd) } : {}),
          },
        },
      )
      continue
    }

    if (type === "status" && event.phase === "turn_end") {
      const kind = event.reason?.kind
      if (typeof kind === "string" && kind !== "completed") {
        error = event.reason?.error?.message ?? kind
      }
      continue
    }

    if (type === "final" && typeof event.text === "string") {
      reply = event.text
      continue
    }

    if (type === "text" && typeof event.text === "string" && reply === "") {
      reply = event.text
      continue
    }

    if (type === "error") {
      error = event.message ?? "dsh error event"
    }
  }

  if (error !== undefined) trace.emit("error", { message: String(error) })
  trace.emit("turn.end", { text: reply })
  trace.emit("run.end", { status: error === undefined ? "ok" : "error" })

  const hasToolResults = sawToolResult || toolResults.some((entry) => entry !== undefined)
  const model = {
    calls: steps,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.inputTokens + tokens.outputTokens,
  }

  const obs = {
    reply,
    replies: [reply],
    toolNames: toolCalls.map((call) => call.name),
    toolCalls,
    ...(hasToolResults
      ? {
          toolResults: toolCalls.map(
            (call, index) => toolResults[index] ?? { name: call.name, ok: false },
          ),
        }
      : {}),
    steps,
    turns: 1,
    model,
    ...(tokens.costUsd > 0 ? { costUsd: Number(tokens.costUsd.toFixed(6)) } : {}),
    trace: trace.events,
  }
  return { trace: trace.events, obs }
}
