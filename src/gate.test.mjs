import assert from "node:assert/strict"
import test from "node:test"
import { evaluateGate } from "./gate.mjs"

test("gate: baseline 全过且 capability 达到阈值", () => {
  const verdict = evaluateGate({
    baseline: { passed: 34, total: 34 },
    capability: { passed: 16, total: 16 },
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.baselineRate, 1)
  assert.equal(verdict.capabilityRate, 1)
})

test("gate: baseline 有失败即不通过", () => {
  const verdict = evaluateGate({ baseline: { passed: 33, total: 34 } })
  assert.equal(verdict.ok, false)
  assert.match(verdict.checks[0].detail, /33\/34/)
})

test("gate: capability 低于阈值不通过，达到阈值通过", () => {
  const below = evaluateGate({
    baseline: { passed: 34, total: 34 },
    capability: { passed: 12, total: 16 },
  })
  assert.equal(below.ok, false)
  assert.equal(below.capabilityRate, 0.75)

  const above = evaluateGate({
    baseline: { passed: 34, total: 34 },
    capability: { passed: 13, total: 16 },
  })
  assert.equal(above.ok, true)
  assert.equal(above.capabilityRate, 0.813)

  const boundary = evaluateGate({
    baseline: { passed: 34, total: 34 },
    capability: { passed: 8, total: 10 },
    minCapability: 0.8,
  })
  assert.equal(boundary.ok, true)
})

test("gate: butler 低于阈值不通过", () => {
  const pass = evaluateGate({
    baseline: { passed: 34, total: 34 },
    butler: { passed: 9, total: 10 },
  })
  assert.equal(pass.ok, true)
  assert.equal(pass.butlerRate, 0.9)

  const fail = evaluateGate({
    baseline: { passed: 34, total: 34 },
    butler: { passed: 8, total: 10 },
  })
  assert.equal(fail.ok, false)
  assert.ok(fail.checks.some((check) => check.name === "butler.passRate" && !check.ok))
})

test("gate: 空任务集视为 0 通过率", () => {
  const verdict = evaluateGate({ baseline: { passed: 0, total: 0 } })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.baselineRate, 0)
})

test("gate: capability 使用任务级平均通过率，不按全过任务数", () => {
  const verdict = evaluateGate({
    baseline: { passed: 34, total: 34 },
    capability: { passed: 14, total: 16, rate: 0.9375, flaky: ["cap-a"] },
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.capabilityRate, 0.938)
  assert.match(verdict.checks[1].detail, /平均通过率 93\.8%/)
  assert.match(verdict.checks[1].detail, /flaky 1 条：cap-a/)
})

test("gate: flaky 拉低平均通过率到阈值以下则失败", () => {
  const verdict = evaluateGate({
    baseline: { passed: 34, total: 34 },
    capability: { passed: 8, total: 16, rate: 0.75, flaky: ["a", "b", "c"] },
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.capabilityRate, 0.75)
  assert.match(verdict.checks[1].detail, /flaky 3 条/)
})

test("gate: rag 与 capability 分开判定", () => {
  const verdict = evaluateGate({
    baseline: { passed: 34, total: 34 },
    capability: { passed: 10, total: 10 },
    rag: {
      passed: 9,
      total: 10,
      rate: 0.9,
      flaky: ["rag-a"],
      retrieval: { casesTotal: 10, hitAt1: 0.8, hitAt3: 1, mrr: 0.9 },
    },
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.ragRate, 0.9)
  assert.ok(verdict.checks.some((check) => check.name === "rag.hitAt3" && check.ok))
})

test("gate: rag Hit@3 或 MRR 低于阈值时不通过", () => {
  const lowHit = evaluateGate({
    baseline: { passed: 34, total: 34 },
    rag: {
      passed: 10,
      total: 10,
      rate: 1,
      retrieval: { casesTotal: 10, hitAt1: 0.5, hitAt3: 0.8, mrr: 0.9 },
    },
  })
  assert.equal(lowHit.ok, false)
  assert.ok(lowHit.checks.some((check) => check.name === "rag.hitAt3" && !check.ok))

  const lowMrr = evaluateGate({
    baseline: { passed: 34, total: 34 },
    rag: {
      passed: 10,
      total: 10,
      rate: 1,
      retrieval: { casesTotal: 10, hitAt1: 0.6, hitAt3: 1, mrr: 0.7 },
    },
  })
  assert.equal(lowMrr.ok, false)
  assert.ok(lowMrr.checks.some((check) => check.name === "rag.mrr" && !check.ok))
})

test("gate: flaky 超过预算时失败，通过率仍独立计算", () => {
  const within = evaluateGate({
    baseline: { passed: 34, total: 34 },
    capability: { passed: 36, total: 40, rate: 0.95, flaky: Array(8).fill(0).map((_, i) => `t${i}`) },
  })
  assert.equal(within.ok, true)

  const over = evaluateGate({
    baseline: { passed: 34, total: 34 },
    capability: { passed: 36, total: 40, rate: 0.95, flaky: Array(9).fill(0).map((_, i) => `t${i}`) },
  })
  assert.equal(over.ok, false)
  assert.ok(over.checks.some((check) => check.name === "capability.flakyBudget" && !check.ok))
})

test("gate: rag flaky 同样受预算约束", () => {
  const verdict = evaluateGate({
    baseline: { passed: 34, total: 34 },
    rag: {
      passed: 8,
      total: 10,
      rate: 0.95,
      flaky: Array(3).fill(0).map((_, i) => `r${i}`),
      retrieval: { casesTotal: 10, hitAt1: 0.9, hitAt3: 1, mrr: 0.95 },
    },
  })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.checks.some((check) => check.name === "rag.flakyBudget" && !check.ok))
})

test("gate: rag 没有检索真值时失败", () => {
  const verdict = evaluateGate({
    baseline: { passed: 34, total: 34 },
    rag: {
      passed: 10,
      total: 10,
      rate: 1,
      retrieval: { casesTotal: 0, hitAt1: 0, hitAt3: 0, mrr: 0 },
    },
  })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.checks.some((check) => check.name === "rag.retrievalCases" && !check.ok))
})

test("gate: 无 flaky 时显式标注", () => {
  const verdict = evaluateGate({
    baseline: { passed: 34, total: 34 },
    capability: { passed: 16, total: 16, rate: 1, flaky: [] },
  })
  assert.equal(verdict.ok, true)
  assert.match(verdict.checks[1].detail, /无 flaky/)
})

test("gate: butler-open 低于阈值不通过，达到阈值通过", () => {
  const below = evaluateGate({
    baseline: { passed: 34, total: 34 },
    butlerOpen: { passed: 16, total: 20 },
  })
  assert.equal(below.ok, false)
  assert.equal(below.butlerOpenRate, 0.8)

  const above = evaluateGate({
    baseline: { passed: 34, total: 34 },
    butlerOpen: { passed: 17, total: 20 },
  })
  assert.equal(above.ok, true)
  assert.equal(above.butlerOpenRate, 0.85)
})
