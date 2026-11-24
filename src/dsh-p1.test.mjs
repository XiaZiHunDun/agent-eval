import assert from "node:assert/strict"
import test from "node:test"
import { mergeTurns, parseTap } from "../adapters/dsh-wfxm.mjs"
import { parseDshNdjson } from "./dsh-ndjson.mjs"
import { validateTrace } from "./trace.mjs"

const ndjson = (events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n"

test("mergeTurns: 两轮回复、工具与 usage 合并为一条 trace", () => {
  const first = parseDshNdjson(
    ndjson([
      { type: "session", sessionId: "s-1" },
      { type: "tool_call", tool: "svc_status", args: { unit: "api" } },
      { type: "tool_result", name: "svc_status", ok: true },
      { type: "status", phase: "step_end", usage: { inputTokens: 10, outputTokens: 2 } },
      { type: "final", text: "api 是 active。" },
    ]),
    { runId: "r", turnIndex: 0 },
  )
  const second = parseDshNdjson(
    ndjson([
      { type: "session", sessionId: "s-1" },
      { type: "tool_call", tool: "svc_status", args: { unit: "worker" } },
      { type: "tool_result", name: "svc_status", ok: true },
      { type: "status", phase: "step_end", usage: { inputTokens: 12, outputTokens: 3 } },
      { type: "final", text: "worker 是 active。" },
    ]),
    { runId: "r", turnIndex: 1 },
  )

  const obs = mergeTurns([first, second], { runtime: "dsh-wfxm", runId: "r" })
  assert.deepEqual(obs.replies, ["api 是 active。", "worker 是 active。"])
  assert.equal(obs.reply, "worker 是 active。")
  assert.equal(obs.turns, 2)
  assert.deepEqual(obs.toolNames, ["svc_status", "svc_status"])
  assert.equal(obs.model.totalTokens, 27)
  assert.deepEqual(validateTrace(obs.trace), [])
  assert.equal(obs.trace.filter((event) => event.type === "turn.start").length, 2)
})

test("parseTap: 解析通过/失败与缩进子测试", () => {
  const tap = [
    "TAP version 13",
    "1..3",
    "ok 1 - add returns sum",
    "not ok 2 - clamp keeps value inside range",
    "    ok 3 - nested case",
  ].join("\n")
  assert.deepEqual(parseTap(tap), [
    { name: "add returns sum", ok: true },
    { name: "clamp keeps value inside range", ok: false },
    { name: "nested case", ok: true },
  ])
})
