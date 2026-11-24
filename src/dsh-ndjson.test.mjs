import assert from "node:assert/strict"
import test from "node:test"
import { parseDshNdjson } from "./dsh-ndjson.mjs"
import { validateTrace } from "./trace.mjs"

const ndjson = (events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n"

test("dsh-ndjson: 工具链映射为 trace 与 obs", () => {
  const stdout = ndjson([
    { type: "session", sessionId: "s-1" },
    { type: "status", phase: "step_end", usage: { inputTokens: 10, outputTokens: 4 } },
    { type: "tool_call", tool: "svc_list", args: { runtime: "all" } },
    { type: "tool_result", name: "svc_list", ok: true },
    { type: "final", text: "当前有 systemd 与 docker 两类运行时。" },
  ])
  const { trace, obs } = parseDshNdjson(stdout, { runId: "r1" })

  assert.deepEqual(validateTrace(trace), [])
  assert.equal(obs.reply, "当前有 systemd 与 docker 两类运行时。")
  assert.deepEqual(obs.toolNames, ["svc_list"])
  assert.deepEqual(obs.toolCalls, [{ name: "svc_list", args: { runtime: "all" } }])
  assert.deepEqual(obs.toolResults, [{ name: "svc_list", ok: true }])
  assert.equal(obs.steps, 1)
  assert.deepEqual(obs.model, { calls: 1, inputTokens: 10, outputTokens: 4, totalTokens: 14 })
})

test("dsh-ndjson: 多次 step 的 usage 累加", () => {
  const stdout = ndjson([
    { type: "session", sessionId: "s-2" },
    { type: "status", phase: "step_end", usage: { inputTokens: 3, outputTokens: 1 } },
    { type: "status", phase: "step_end", usage: { inputTokens: 5, outputTokens: 2 } },
    { type: "final", text: "done" },
  ])
  const { obs } = parseDshNdjson(stdout, { runId: "r2" })
  assert.equal(obs.steps, 2)
  assert.equal(obs.model.totalTokens, 11)
})

test("dsh-ndjson: 非 completed 的 turn_end 记为 error", () => {
  const stdout = ndjson([
    { type: "session", sessionId: "s-3" },
    { type: "status", phase: "turn_end", reason: { kind: "error", error: { message: "model timeout" } } },
  ])
  const { trace, obs } = parseDshNdjson(stdout, { runId: "r3" })
  assert.equal(obs.reply, "")
  assert.equal(trace.at(-1).payload.status, "error")
  assert.ok(trace.some((event) => event.type === "error" && event.payload.message === "model timeout"))
  assert.ok(validateTrace(trace).some((problem) => problem.includes("status=error")))
})

test("dsh-ndjson: 空输入仍然产出成对 trace", () => {
  const { trace, obs } = parseDshNdjson("", { runId: "r4" })
  assert.deepEqual(validateTrace(trace), [])
  assert.equal(obs.reply, "")
  assert.deepEqual(obs.toolNames, [])
  assert.equal(obs.toolResults, undefined)
  assert.equal(trace[0].type, "run.start")
  assert.equal(trace.at(-1).type, "run.end")
})

test("dsh-ndjson: 缺少 tool_result 时按失败处理（fail-closed）", () => {
  const stdout = ndjson([
    { type: "session", sessionId: "s-5" },
    { type: "tool_call", tool: "svc_status", args: {} },
    { type: "tool_result", name: "other_tool", ok: true },
    { type: "final", text: "ok" },
  ])
  const { obs } = parseDshNdjson(stdout, { runId: "r5" })
  assert.deepEqual(obs.toolResults, [{ name: "svc_status", ok: false }])
})
