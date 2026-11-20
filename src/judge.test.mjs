import test from "node:test"
import assert from "node:assert/strict"
import {
  buildJudgePrompt,
  evaluateHardRules,
  evaluateOpenTask,
  parseJudgeScore,
} from "./judge.mjs"

const rubric = {
  hard: [
    { id: "exists", type: "file_exists", path: "src/a.mjs" },
    { id: "content", type: "file_contains", path: "src/a.mjs", text: "export" },
    { id: "tools", type: "tool_used_any", tools: ["read_file", "grep"] },
    { id: "forbidden", type: "tool_forbidden", tools: ["run_command"] },
    { id: "budget", type: "max_tool_calls", value: 5 },
  ],
  soft: { minScore: 4, criteria: ["目标达成", "不违反禁忌"] },
}

function observation(overrides = {}) {
  return {
    replies: ["已经完成"],
    reply: "已经完成",
    workspace: { "src/a.mjs": "export const a = 1\n" },
    toolNames: ["read_file"],
    toolResults: [{ name: "read_file", ok: true }],
    steps: 2,
    model: { calls: 2 },
    ...overrides,
  }
}

test("hard rules pass only when every observable outcome matches", () => {
  const result = evaluateHardRules(rubric, observation())
  assert.equal(result.failures.length, 0)
})

test("hard rules report missing file, forbidden tool, and budget", () => {
  const result = evaluateHardRules(
    rubric,
    observation({ workspace: {}, toolNames: ["run_command"], steps: 9 }),
  )
  const names = result.failures.map((f) => f.check)
  assert.ok(names.includes("exists"))
  assert.ok(names.includes("forbidden"))
  assert.ok(names.includes("budget"))
})

test("parseJudgeScore accepts only 1-5 and ignores prose", () => {
  assert.equal(parseJudgeScore("SCORE=4"), 4)
  assert.equal(parseJudgeScore("评语\nSCORE = 5"), 5)
  assert.equal(parseJudgeScore("SCORE=9"), null)
  assert.equal(parseJudgeScore("没有分数"), null)
})

test("open task without judge records pending instead of failing", async () => {
  const verdict = await evaluateOpenTask({ title: "t", turns: ["x"], rubric }, observation())
  assert.equal(verdict.passed, true)
  assert.ok(verdict.checks.some((c) => c.name === "judge.pending"))
})

test("open task uses judge mean once hard rules pass", async () => {
  const judge = async () => ({ scores: [4, 5] })
  const verdict = await evaluateOpenTask(
    { title: "t", turns: ["x"], rubric },
    observation(),
    { judge },
  )
  assert.equal(verdict.passed, true)
  assert.equal(verdict.judge.mean, 4.5)
})

test("open task fails when judge mean is below the threshold", async () => {
  const judge = async () => ({ scores: [2, 3] })
  const verdict = await evaluateOpenTask(
    { title: "t", turns: ["x"], rubric },
    observation(),
    { judge },
  )
  assert.equal(verdict.passed, false)
  assert.ok(verdict.failures.some((f) => f.check === "judge.score"))
})

test("observe mode records low judge scores without failing", async () => {
  const judge = async () => ({ scores: [2, 3] })
  const verdict = await evaluateOpenTask(
    { title: "t", turns: ["x"], rubric },
    observation(),
    { judge, strict: false },
  )
  assert.equal(verdict.passed, true)
  assert.equal(verdict.judge.mean, 2.5)
  assert.ok(verdict.checks.some((c) => c.name === "judge.score" && c.detail.includes("观测")))
})

test("observe mode treats judge transport errors as non-blocking", async () => {
  const judge = async () => {
    throw new Error("judge HTTP 502")
  }
  const verdict = await evaluateOpenTask(
    { title: "t", turns: ["x"], rubric },
    observation(),
    { judge, strict: false },
  )
  assert.equal(verdict.passed, true)
  assert.ok(verdict.checks.some((c) => c.name === "judge.error" && c.ok))
})

test("judge prompt stays outcome-only", () => {
  const prompt = buildJudgePrompt(
    { title: "解释模块", turns: ["src/a.mjs 做什么"] },
    observation(),
  )
  assert.ok(prompt.includes("src/a.mjs 做什么"))
  assert.ok(prompt.includes("评价目标是否达成"))
  assert.ok(!prompt.includes("实现方式不要评价"))
})

test("every open task carries hard rules and soft criteria", async () => {
  const { loadTasks } = await import("./runner.mjs")
  const tasks = await loadTasks(new URL("../tasks/butler-open", import.meta.url).pathname)
  assert.equal(tasks.length, 20)
  const ids = new Set(tasks.map((task) => task.id))
  assert.equal(ids.size, tasks.length)
  for (const task of tasks) {
    assert.equal(task.suite, "butler-open", `${task.id} suite 不正确`)
    assert.ok(Array.isArray(task.rubric?.hard) && task.rubric.hard.length > 0, `${task.id} 缺硬规则`)
    assert.ok(
      Array.isArray(task.rubric?.soft?.criteria) && task.rubric.soft.criteria.length > 0,
      `${task.id} 缺软性标准`,
    )
  }
})
