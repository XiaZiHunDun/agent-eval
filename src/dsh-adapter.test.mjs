import assert from "node:assert/strict"
import test from "node:test"
import adapter from "../adapters/dsh-wfxm.mjs"
import { verify } from "./verify.mjs"

const events = [
  { type: "session", sessionId: "inline" },
  { type: "tool_call", tool: "svc_list", args: { runtime: "all" } },
  { type: "tool_result", name: "svc_list", ok: true },
  { type: "status", phase: "step_end", usage: { inputTokens: 5, outputTokens: 3 } },
  { type: "final", text: "受管服务：api、worker。" },
]

const task = {
  id: "inline-list",
  title: "内联 fixture",
  suite: "dsh-smoke",
  turns: ["列出受管服务。"],
  expect: { requiredTools: ["svc_list"], containsAny: ["受管服务"] },
  runtimeHints: { dsh: { events } },
}

test("dsh-wfxm adapter: 内联事件正例通过", async () => {
  const obs = await adapter.run(task, { runId: "r-inline", timeoutMs: 1000 })
  const verdict = verify(task, obs)
  assert.equal(verdict.passed, true)
  assert.deepEqual(obs.toolNames, ["svc_list"])
})

test("dsh-wfxm adapter: 删除工具调用后必须变红", async () => {
  const broken = {
    ...task,
    runtimeHints: { dsh: { events: events.filter((event) => event.type !== "tool_call") } },
  }
  const obs = await adapter.run(broken, { runId: "r-broken", timeoutMs: 1000 })
  const verdict = verify(broken, obs)
  assert.equal(verdict.passed, false)
})
