import test from "node:test"
import assert from "node:assert/strict"
import { loadTrajectoryTasks, normalizeTrajectory, trajectoryDir } from "./trajectory.mjs"

const base = {
  id: "traj-x",
  title: "示例",
  turns: ["你好"],
  script: {
    plan: [{ content: "在", toolCalls: [], stopReason: "end_turn" }],
    seedFiles: [{ path: "a.txt", content: "a" }],
  },
  expect: {
    toolSetIncludes: ["read_file"],
    finalDecisionIn: ["Respond"],
    files: { "src/a.ts": "export const x = 1" },
    reply: { mustMatch: ["好"], mustNotMatch: ["mcp_"] },
    budget: { maxLlmCalls: 4 },
  },
}

test("normalizes a trajectory into the runner task vocabulary", () => {
  const task = normalizeTrajectory(base)
  assert.equal(task.suite, "trajectory")
  assert.deepEqual(task.expect.requiredTools, ["read_file"])
  assert.deepEqual(task.expect.finalDecisionIn, ["Respond"])
  assert.deepEqual(task.expect.containsAll, ["好"])
  assert.deepEqual(task.expect.containsNone, ["mcp_"])
  assert.deepEqual(task.expect.workspaceState, [{ path: "src/a.ts", equals: "export const x = 1" }])
  assert.equal(task.expect.budget.maxModelCalls, 4)
  assert.equal(task.runtimeHints.wfxm.fixtures.seedFiles[0].path, "a.txt")
})

test("rejects implementation-coupled assertions", () => {
  assert.throws(
    () => normalizeTrajectory({ ...base, expect: { toolSequence: ["a", "b"] } }),
    /被禁止的断言/,
  )
  assert.throws(
    () => normalizeTrajectory({ ...base, expect: { llmCalls: 2 } }),
    /被禁止的断言/,
  )
})

test("requires at least one verifiable expectation", () => {
  assert.throws(() => normalizeTrajectory({ ...base, expect: {} }), /没有任何可验证断言/)
})

test("loads the WFXM trajectory fixtures", async () => {
  const tasks = await loadTrajectoryTasks(trajectoryDir())
  assert.ok(tasks.length >= 18, `轨迹数量应 >= 18，实际 ${tasks.length}`)
  const ids = new Set(tasks.map((task) => task.id))
  assert.equal(ids.size, tasks.length)
  for (const task of tasks) {
    assert.ok(Object.keys(task.expect).length > 0, `${task.id} 缺少断言`)
  }
})
