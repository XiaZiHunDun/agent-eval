import assert from "node:assert/strict"
import test from "node:test"
import { DEFAULT_DSH_THRESHOLDS, evaluateDshGate } from "./gate-dsh.mjs"

const suites = [
  { name: "smoke", passed: 6, total: 6 },
  { name: "tools", passed: 11, total: 12 },
  { name: "approval", passed: 8, total: 8 },
  { name: "adversarial", passed: 8, total: 8 },
]

test("gate-dsh: 达到阈值则通过", () => {
  const verdict = evaluateDshGate({ suites })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.exitOk, true)
  assert.equal(verdict.checks.length, Object.keys(DEFAULT_DSH_THRESHOLDS).length)
})

test("gate-dsh: 低于阈值或缺少套件则失败", () => {
  const verdict = evaluateDshGate({
    suites: suites.filter((suite) => suite.name !== "approval").map((suite) =>
      suite.name === "tools" ? { ...suite, passed: 9 } : suite,
    ),
  })
  assert.equal(verdict.ok, false)
  assert.deepEqual(
    verdict.checks.filter((check) => !check.ok).map((check) => check.name).sort(),
    ["suite.approval", "suite.tools"],
  )
})

test("gate-dsh: advisory 不阻断退出码", () => {
  const verdict = evaluateDshGate({ suites: [], advisory: true })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.exitOk, true)
  assert.equal(verdict.advisory, true)
})
