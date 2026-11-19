import assert from "node:assert/strict"
import test from "node:test"
import { compareRuns } from "./compare.mjs"

const a = {
  suite: "capability",
  results: [
    { taskId: "t1", passRate: 0 },
    { taskId: "t2", passRate: 1 },
  ],
}

test("compare: 配对 lift 与改善/回退计数", () => {
  const b = {
    suite: "capability",
    results: [
      { taskId: "t1", passRate: 1 },
      { taskId: "t2", passRate: 1 },
    ],
  }
  const result = compareRuns({ a, b, labelA: "base", labelB: "new" })
  assert.equal(result.blocked, false)
  assert.equal(result.headline, 0.5)
  assert.equal(result.aRate, 0.5)
  assert.equal(result.bRate, 1)
  assert.equal(result.improved, 1)
  assert.equal(result.unchanged, 1)
})

test("compare: 缺任务时 blocked 且不给 headline", () => {
  const b = { suite: "capability", results: [{ taskId: "t1", passRate: 1 }] }
  const result = compareRuns({ a, b })
  assert.equal(result.blocked, true)
  assert.equal(result.headline, null)
  assert.ok(result.issues.some((issue) => issue.includes("缺少任务：t2")))
})

test("compare: 任务重复或未评分时 blocked", () => {
  const duplicated = {
    suite: "capability",
    results: [
      { taskId: "t1", passRate: 1 },
      { taskId: "t1", passRate: 1 },
      { taskId: "t2", passRate: 1 },
    ],
  }
  const dup = compareRuns({ a, b: duplicated })
  assert.equal(dup.blocked, true)
  assert.ok(dup.issues.some((issue) => issue.includes("任务重复：t1")))

  const unscored = {
    suite: "capability",
    results: [
      { taskId: "t1", passRate: 1 },
      { taskId: "t2" },
    ],
  }
  const missingScore = compareRuns({ a, b: unscored })
  assert.equal(missingScore.blocked, true)
  assert.ok(missingScore.issues.some((issue) => issue.includes("任务未评分：t2")))
})

test("compare: 套件不一致时 blocked", () => {
  const b = {
    suite: "rag",
    results: [
      { taskId: "t1", passRate: 1 },
      { taskId: "t2", passRate: 1 },
    ],
  }
  const result = compareRuns({ a, b })
  assert.equal(result.blocked, true)
  assert.ok(result.issues.some((issue) => issue.includes("suite 不一致")))
})
