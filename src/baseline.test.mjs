import assert from "node:assert/strict"
import test from "node:test"
import { buildBaseline, compareToBaseline } from "./baseline.mjs"

const results = [
  { taskId: "cap-a", passRate: 1, passed: true },
  { taskId: "cap-b", passRate: 0.5, passed: false },
]

test("baseline: 生成基线包含任务清单与整体通过率", () => {
  const baseline = buildBaseline({ suite: "capability", results, passRate: 0.75 })
  assert.equal(baseline.suite, "capability")
  assert.deepEqual(baseline.tasks, ["cap-a", "cap-b"])
  assert.equal(baseline.overallRate, 0.75)
  assert.equal(baseline.taskRates["cap-b"], 0.5)
})

test("baseline: 达到阈值且任务齐全即通过", () => {
  const verdict = compareToBaseline({
    suite: "capability",
    results,
    passRate: 0.75,
    baseline: { suite: "capability", tasks: ["cap-a", "cap-b"], overallRate: 0.7 },
  })
  assert.equal(verdict.ok, true)
})

test("baseline: 通过率下降或缺少任务时失败", () => {
  const low = compareToBaseline({
    suite: "capability",
    results,
    passRate: 0.6,
    baseline: { suite: "capability", tasks: ["cap-a", "cap-b"], overallRate: 0.7 },
  })
  assert.equal(low.ok, false)
  assert.ok(low.checks.some((check) => check.name === "baseline.overall" && !check.ok))

  const missing = compareToBaseline({
    suite: "capability",
    results,
    passRate: 0.9,
    baseline: { suite: "capability", tasks: ["cap-a", "cap-b", "cap-c"], overallRate: 0.7 },
  })
  assert.equal(missing.ok, false)
  assert.match(missing.checks.find((check) => check.name === "baseline.tasks").detail, /cap-c/)
})

test("baseline: 套件不匹配时失败", () => {
  const verdict = compareToBaseline({
    suite: "capability",
    results,
    passRate: 1,
    baseline: { suite: "rag", tasks: [], overallRate: 0 },
  })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.checks.some((check) => check.name === "baseline.suite" && !check.ok))
})
