import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runSuite } from "./runner.mjs"

const TASK = {
  id: "t-demo",
  title: "demo",
  suite: "test",
  taxonomy: "demo",
  turns: ["hi"],
  expect: { replyPattern: "ok" },
}

function trace(runId) {
  return [
    {
      schema: "wfxm.trace/0",
      traceId: "trace-1",
      runId,
      runtime: "fake",
      seq: 0,
      ts: new Date().toISOString(),
      type: "run.start",
      actor: { kind: "system", id: "fake" },
      payload: {},
    },
    {
      schema: "wfxm.trace/0",
      traceId: "trace-1",
      runId,
      runtime: "fake",
      seq: 1,
      ts: new Date().toISOString(),
      type: "run.end",
      actor: { kind: "system", id: "fake" },
      payload: { status: "ok" },
    },
  ]
}

test("runner: repeats=1 保持单次结果结构", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-eval-"))
  try {
    const adapter = {
      id: "fake",
      async run(task, { runId }) {
        return { reply: "ok", steps: 1, trace: trace(runId) }
      },
    }
    const suite = await runSuite({ adapter, tasks: [TASK], runDir: dir, runId: "r1" })
    assert.equal(suite.repeats, 1)
    assert.equal(suite.passRate, 1)
    assert.deepEqual(suite.flaky, [])
    assert.equal(suite.attemptsTotal, 1)
    assert.equal(suite.attemptsPassed, 1)

    const [result] = suite.results
    assert.equal(result.passed, true)
    assert.equal(result.passRate, 1)
    assert.equal(result.attempts.length, 1)
    assert.match(result.tracePath, /t-demo[/\\]trace\.jsonl$/)

    const raw = JSON.parse(await readFile(join(dir, "t-demo", "result.json"), "utf8"))
    assert.equal(raw.passed, true)
    await readFile(join(dir, "t-demo", "trace.jsonl"), "utf8")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("runner: 汇总工具调用、tokens 与变更规模", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-eval-"))
  try {
    const adapter = {
      id: "fake",
      async run(task, { runId }) {
        return {
          reply: "ok",
          steps: 3,
          toolNames: ["read_file", "read_file", "write_file"],
          model: { calls: 2, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          costUsd: 0.01,
          diff: { filesChanged: 2, added: 7, removed: 3 },
          trace: trace(runId),
        }
      },
    }
    const suite = await runSuite({ adapter, tasks: [TASK], runDir: dir, runId: "r3" })
    const [result] = suite.results
    assert.deepEqual(result.metrics.toolCallsByName, { read_file: 2, write_file: 1 })
    assert.deepEqual(result.metrics.tokens, {
      calls: 2,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    })
    assert.deepEqual(result.metrics.diff, { filesChanged: 2, added: 7, removed: 3 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("runner: repeats 用平均通过率并标记 flaky", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-eval-"))
  try {
    let call = 0
    const adapter = {
      id: "fake",
      async run(task, { runId }) {
        call += 1
        return { reply: call === 1 ? "ok" : "nope", steps: 1, trace: trace(runId) }
      },
    }
    const suite = await runSuite({ adapter, tasks: [TASK], runDir: dir, runId: "r2", repeats: 2 })
    assert.equal(suite.repeats, 2)
    assert.equal(suite.passRate, 0.5)
    assert.equal(suite.attemptsTotal, 2)
    assert.equal(suite.attemptsPassed, 1)
    assert.equal(suite.flaky.length, 1)
    assert.equal(suite.flaky[0].taskId, "t-demo")
    assert.equal(suite.flaky[0].attemptsPassed, 1)
    assert.equal(suite.flaky[0].attemptsTotal, 2)

    const [result] = suite.results
    assert.equal(result.passed, false)
    assert.equal(result.passRate, 0.5)
    assert.equal(result.attemptsPassed, 1)
    assert.equal(result.attemptsTotal, 2)
    assert.deepEqual(
      result.attempts.map((a) => a.passed),
      [true, false],
    )
    assert.equal(result.tracePaths.length, 2)

    await readFile(join(dir, "t-demo", "attempt-1", "trace.jsonl"), "utf8")
    await readFile(join(dir, "t-demo", "attempt-2", "result.json"), "utf8")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
