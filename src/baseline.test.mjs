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

const processMetrics = {
  toolRecall: { expected: 4, hit: 4, rate: 1 },
  redundant: { calls: 10, unique: 9, rate: 0.1 },
  paramAccuracy: { specs: 2, hit: 2, rate: 1 },
}

test("baseline: 录制时写入过程指标观测值（不参与判定）", () => {
  const baseline = buildBaseline({ suite: "capability", results, passRate: 0.75, processMetrics })
  assert.deepEqual(baseline.processMetricsObserved, {
    toolRecall: 1,
    redundantRate: 0.1,
    paramAccuracy: 1,
  })
})

test("baseline: 过程指标阈值通过", () => {
  const verdict = compareToBaseline({
    suite: "capability",
    results,
    passRate: 0.75,
    processMetrics,
    baseline: {
      suite: "capability",
      tasks: ["cap-a", "cap-b"],
      overallRate: 0.7,
      processMetrics: {
        minToolRecall: 0.9,
        maxRedundantRate: 0.2,
        minParamAccuracy: 0.95,
      },
    },
  })
  assert.equal(verdict.ok, true)
  assert.ok(verdict.checks.some((check) => check.name === "process.toolRecall" && check.ok))
})

test("baseline: 过程指标越界时失败", () => {
  const verdict = compareToBaseline({
    suite: "capability",
    results,
    passRate: 1,
    processMetrics,
    baseline: {
      suite: "capability",
      tasks: ["cap-a", "cap-b"],
      overallRate: 0.7,
      processMetrics: {
        minToolRecall: 1,
        maxRedundantRate: 0.05,
        minParamAccuracy: 1,
      },
    },
  })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.checks.some((check) => check.name === "process.redundant" && !check.ok))
})

test("baseline: 过程指标无样本视为不达标", () => {
  const verdict = compareToBaseline({
    suite: "capability",
    results,
    passRate: 1,
    processMetrics: {
      toolRecall: { expected: 0, hit: 0, rate: null },
      redundant: { calls: 0, unique: 0, rate: null },
      paramAccuracy: { specs: 0, hit: 0, rate: null },
    },
    baseline: {
      suite: "capability",
      tasks: ["cap-a", "cap-b"],
      overallRate: 0.7,
      processMetrics: { minToolRecall: 0.9 },
    },
  })
  assert.equal(verdict.ok, false)
  assert.match(
    verdict.checks.find((check) => check.name === "process.toolRecall").detail,
    /无样本/,
  )
})
