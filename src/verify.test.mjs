import assert from "node:assert/strict"
import test from "node:test"
import { createTrace, validateTrace } from "./trace.mjs"
import { verify } from "./verify.mjs"

const task = {
  id: "t1",
  title: "样例",
  suite: "unit",
  turns: ["hi"],
  expect: {
    finalDecision: "Respond",
    replyPattern: "已读",
    minToolCalls: 1,
    maxToolCalls: 2,
    requireApproval: false,
  },
}

test("verify: 全部断言通过", () => {
  const v = verify(task, {
    status: 201,
    reply: "已读 README",
    finalDecision: "Respond",
    steps: 1,
  })
  assert.equal(v.passed, true)
  assert.equal(v.score, 1)
  assert.deepEqual(v.failures, [])
})

test("verify: 失败项被逐条记录，分数按比例", () => {
  const v = verify(task, { status: 500, reply: "随便", finalDecision: "Finish", steps: 5 })
  assert.equal(v.passed, false)
  assert.deepEqual(
    v.failures.map((f) => f.check).sort(),
    ["decision", "http.status", "reply.pattern", "steps.max"],
  )
  assert.equal(v.score, 0.2)
})

test("verify: 声明工具断言但 trace 无工具名 → 失败", () => {
  const v = verify(
    { ...task, expect: { requiredTools: ["read_file"] } },
    { finalDecision: "Respond", reply: "已读", steps: 1 },
  )
  assert.equal(v.passed, false)
  assert.equal(v.failures[0].check, "tools.trace")
})

test("verify: requiredAnyTools 接受等价命令", () => {
  const v = verify(
    {
      ...task,
      expect: { requiredAnyTools: ["read_file", "run_command"], forbiddenTools: ["write_file"] },
    },
    { finalDecision: "Respond", reply: "已读", steps: 2, toolNames: ["run_command"] },
  )
  assert.equal(v.passed, true)

  const missing = verify(
    { ...task, expect: { requiredAnyTools: ["read_file", "run_command"] } },
    { finalDecision: "Respond", reply: "已读", steps: 1, toolNames: ["list_dir"] },
  )
  assert.equal(missing.passed, false)
  assert.equal(missing.failures[0].check, "tool.requiredAny")
})

test("verify: 工具名齐全时按序列判定", () => {
  const v = verify(
    { ...task, expect: { requiredTools: ["read_file"], forbiddenTools: ["shell"] } },
    { finalDecision: "Respond", reply: "已读", steps: 1, toolNames: ["read_file"] },
  )
  assert.equal(v.passed, true)
})

test("verify: requireToolSuccess 全部成功才通过", () => {
  const ok = verify(
    { ...task, expect: { requireToolSuccess: true } },
    { finalDecision: "Respond", reply: "已读", steps: 1, toolResults: [{ name: "read_file", ok: true }] },
  )
  assert.equal(ok.passed, true)

  const failed = verify(
    { ...task, expect: { requireToolSuccess: true } },
    {
      finalDecision: "Respond",
      reply: "已读",
      steps: 2,
      toolResults: [
        { name: "read_file", ok: true },
        { name: "write_file", ok: false },
      ],
    },
  )
  assert.equal(failed.passed, false)
  assert.equal(failed.failures[0].check, "tools.success")
  assert.match(failed.failures[0].detail, /write_file/)
})

test("verify: requireToolSuccess 但 trace 无执行结果 → 失败（不默认成功）", () => {
  const v = verify(
    { ...task, expect: { requireToolSuccess: true } },
    { finalDecision: "Respond", reply: "已读", steps: 1 },
  )
  assert.equal(v.passed, false)
  assert.equal(v.failures[0].check, "tools.success")
})

test("verify: requireToolSuccess 且未执行工具 → 空真", () => {
  const v = verify(
    { ...task, expect: { requireToolSuccess: true } },
    { finalDecision: "Respond", reply: "已读", steps: 0, toolResults: [] },
  )
  assert.equal(v.passed, true)
})

test("verify: containsAll / containsNone 作用于首轮回复", () => {
  const v = verify(
    { ...task, expect: { containsAll: ["A", "B"], containsNone: ["C"] } },
    { replies: ["A 和 B", "无关"], statuses: [201, 201] },
  )
  assert.equal(v.passed, true)

  const bad = verify(
    { ...task, expect: { containsAll: ["A", "B"], containsNone: ["C"] } },
    { replies: ["A 和 C"] },
  )
  assert.equal(bad.passed, false)
  assert.deepEqual(
    bad.failures.map((f) => f.check).sort(),
    ["reply.contains:B", "reply.excludes:C"],
  )
})

test("verify: 多轮按轮次匹配 followUpPatterns", () => {
  const ok = verify(
    {
      ...task,
      turns: ["a", "b", "c"],
      expect: { replyPattern: "第一", followUpPatterns: ["第二", "第三"] },
    },
    { replies: ["第一轮", "第二轮", "第三轮"], statuses: [201, 201, 201], steps: 2 },
  )
  assert.equal(ok.passed, true)

  const missing = verify(
    { ...task, turns: ["a", "b"], expect: { followUpPatterns: ["第二"] } },
    { replies: ["第一轮"], statuses: [201], steps: 0 },
  )
  assert.equal(missing.passed, false)
  assert.equal(missing.failures[0].check, "followUp[0].pattern")
})

test("verify: 任一状态码非 2xx 即失败", () => {
  const v = verify(task, { replies: ["已读"], statuses: [201, 500], steps: 1 })
  assert.equal(v.passed, false)
  assert.equal(v.failures[0].check, "http.status")
})

test("verify: 非法正则不抛异常，记为失败", () => {
  const v = verify({ ...task, expect: { replyPattern: "(" } }, { reply: "x", steps: 0 })
  assert.equal(v.passed, false)
  assert.equal(v.failures[0].check, "reply.pattern")
})

test("verify: toolArgs 按名称 + 参数子集匹配", () => {
  const ok = verify(
    {
      ...task,
      expect: {
        toolArgs: [
          { name: "read_file", args: { path: "README.md" } },
          { name: "write_file", args: { path: "a.ts", options: { mode: "append" } } },
        ],
      },
    },
    {
      finalDecision: "Respond",
      toolCalls: [
        { name: "read_file", args: { path: "README.md", offset: 0 } },
        { name: "write_file", args: { path: "a.ts", content: "x", options: { mode: "append" } } },
      ],
    },
  )
  assert.equal(ok.passed, true)

  const bad = verify(
    { ...task, expect: { toolArgs: [{ name: "read_file", args: { path: "OTHER.md" } }] } },
    { toolCalls: [{ name: "read_file", args: { path: "README.md" } }] },
  )
  assert.equal(bad.passed, false)
  assert.equal(bad.failures[0].check, "toolArgs[0]:read_file")
})

test("verify: toolArgs 但 trace 无调用参数 → 失败", () => {
  const v = verify(
    { ...task, expect: { toolArgs: [{ name: "read_file", args: { path: "README.md" } }] } },
    { toolNames: ["read_file"] },
  )
  assert.equal(v.passed, false)
  assert.equal(v.failures[0].check, "tools.args")
})

test("verify: workspaceState 断言存在 / 内容 / 正则", () => {
  const ok = verify(
    {
      ...task,
      expect: {
        workspaceState: [
          { path: "README.md", exists: true, contains: "butler-v5", matches: "#\\s+butler" },
          { path: "a.ts", equals: "export const a = 1\n" },
          { path: "gone.txt", exists: false },
        ],
      },
    },
    {
      workspace: {
        "README.md": "# butler-v5\n内容",
        "a.ts": "export const a = 1\n",
        "gone.txt": null,
      },
    },
  )
  assert.equal(ok.passed, true)

  const bad = verify(
    {
      ...task,
      expect: { workspaceState: [{ path: "README.md", contains: "missing" }] },
    },
    { workspace: { "README.md": "# butler-v5" } },
  )
  assert.equal(bad.passed, false)
  assert.equal(bad.failures[0].check, "workspace[0]:README.md.contains")

  const missing = verify(
    { ...task, expect: { workspaceState: [{ path: "README.md" }] } },
    { workspace: { "README.md": null } },
  )
  assert.equal(missing.passed, false)
  assert.equal(missing.failures[0].check, "workspace[0]:README.md")
})

test("verify: workspaceState 但 adapter 未提供快照 → 失败", () => {
  const v = verify(
    { ...task, expect: { workspaceState: [{ path: "README.md" }] } },
    { reply: "已读" },
  )
  assert.equal(v.passed, false)
  assert.equal(v.failures[0].check, "workspace")
})

test("verify: repo-task 的 failToPass / passToPass 按前后对照判定", () => {
  const repoTask = {
    ...task,
    kind: "repo-task",
    expect: {
      tests: {
        command: "node --test --test-reporter=tap test/a.test.mjs",
        failToPass: ["bug 修复"],
        passToPass: ["既有行为"],
      },
    },
  }
  const obs = {
    tests: {
      command: "node --test --test-reporter=tap test/a.test.mjs",
      before: {
        exitCode: 1,
        results: [
          { name: "bug 修复", ok: false },
          { name: "既有行为", ok: true },
        ],
      },
      after: {
        exitCode: 0,
        results: [
          { name: "bug 修复", ok: true },
          { name: "既有行为", ok: true },
        ],
      },
    },
  }
  assert.equal(verify(repoTask, obs).passed, true)

  const notFixed = verify(repoTask, {
    ...obs,
    tests: { ...obs.tests, after: obs.tests.before },
  })
  assert.equal(notFixed.passed, false)
  assert.ok(notFixed.failures.some((f) => f.check === "tests.failToPass:bug 修复"))

  const alreadyPassed = verify(repoTask, {
    ...obs,
    tests: {
      ...obs.tests,
      before: { exitCode: 0, results: [{ name: "bug 修复", ok: true }] },
      after: { exitCode: 0, results: [{ name: "bug 修复", ok: true }] },
    },
  })
  assert.equal(alreadyPassed.passed, false)
})

test("verify: 缺少测试结果或测试名未出现 → 失败", () => {
  const repoTask = {
    ...task,
    expect: { tests: { command: "node --test", failToPass: ["未出现的测试"] } },
  }
  assert.equal(verify(repoTask, {}).failures[0].check, "tests")

  const v = verify(repoTask, {
    tests: { command: "node --test", before: { results: [] }, after: { exitCode: 0, results: [] } },
  })
  assert.equal(v.passed, false)
  assert.match(v.failures[0].detail, /未找到/)
})

test("verify: budget 断言轮次 / 工具调用 / 成本", () => {
  const budgeted = {
    ...task,
    expect: { replyPattern: "好的" },
    budget: { maxTurns: 2, maxToolCalls: 3, maxCostUsd: 0.01 },
  }
  assert.equal(
    verify(budgeted, { reply: "好的", turns: 2, steps: 3, costUsd: 0.005 }).passed,
    true,
  )
  const over = verify(budgeted, { reply: "好的", turns: 3, steps: 4, costUsd: 0.02 })
  assert.deepEqual(over.failures.map((f) => f.check).sort(), [
    "budget.costUsd",
    "budget.toolCalls",
    "budget.turns",
  ])
  // 未提供成本时不判失败（fixture runtime 无成本数据）。
  assert.equal(verify(budgeted, { reply: "好的", turns: 1, steps: 1 }).passed, true)
})

test("trace: 合法 trace 通过不变量校验", () => {
  const t = createTrace({ runtime: "wfxm", runId: "r1" })
  t.emit("run.start", { taskId: "t1" })
  t.emit("turn.start", { index: 1, input: "hi" })
  t.emit("run.end", { status: "ok" })
  assert.deepEqual(validateTrace(t.events), [])
})

test("trace: seq 不连续 / 缺少 run.end 会被发现", () => {
  const t = createTrace({ runtime: "wfxm", runId: "r1" })
  t.emit("run.start", {})
  t.events.push({ ...t.events[0], seq: 5 })
  const problems = validateTrace(t.events)
  assert.ok(problems.some((p) => p.includes("seq")))
  assert.ok(problems.some((p) => p.includes("run.end")))
})
