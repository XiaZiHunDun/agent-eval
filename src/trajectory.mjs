/**
 * 轨迹套件（L3）：数据在 WFXM 的 tests/trajectories/*.json，执行与判定在 agent-eval。
 *
 * 轨迹只声明外部可观察结果：用了哪些工具（集合，不要求顺序/次数）、最终决策、
 * 产物文件内容、用户可见回复片段、预算上限。这里把轨迹格式归一化成 runner 通用的
 * EvalTask 形态，复用 wfxm adapter 与 verify；不引入第二套执行路径。
 */
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const DEFAULT_WFXM_ROOT = "/home/ailearn/projects/WFXM"

/** 轨迹目录默认取 WFXM 仓库；可用 WFXM_ROOT 覆盖。 */
export function trajectoryDir() {
  return join(process.env.WFXM_ROOT ?? DEFAULT_WFXM_ROOT, "tests", "trajectories")
}

/** 明确禁止的实现细节断言，避免轨迹集退化成实现快照。 */
const FORBIDDEN_EXPECT_KEYS = ["toolSequence", "exactToolCalls", "llmCalls", "promptContains"]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * 把一条轨迹归一化成 EvalTask。
 *
 * @param {object} raw
 * @param {string} filename
 * @returns {object}
 */
export function normalizeTrajectory(raw, filename = "<inline>") {
  assert(raw && typeof raw === "object", `${filename} 不是对象`)
  for (const key of ["id", "title", "turns", "expect"]) {
    assert(key in raw, `${filename} 缺少字段 ${key}`)
  }
  assert(Array.isArray(raw.turns) && raw.turns.length > 0, `${filename} 的 turns 不能为空`)
  assert(raw.expect && typeof raw.expect === "object", `${filename} 的 expect 必须是对象`)
  for (const key of FORBIDDEN_EXPECT_KEYS) {
    assert(
      !(key in raw.expect),
      `${filename} 使用了被禁止的断言 ${key}：轨迹只允许结果/契约断言`,
    )
  }

  const script = raw.script ?? {}
  const reply = raw.expect.reply ?? {}
  const budget = raw.expect.budget ?? {}
  const files = raw.expect.files ?? {}

  const expect = {}
  if (Array.isArray(raw.expect.toolSetIncludes) && raw.expect.toolSetIncludes.length > 0) {
    expect.requiredTools = raw.expect.toolSetIncludes
  }
  if (Array.isArray(raw.expect.toolSetExcludes) && raw.expect.toolSetExcludes.length > 0) {
    expect.forbiddenTools = raw.expect.toolSetExcludes
  }
  if (Array.isArray(raw.expect.finalDecisionIn) && raw.expect.finalDecisionIn.length > 0) {
    expect.finalDecisionIn = raw.expect.finalDecisionIn
  }
  if (Array.isArray(raw.expect.statusIn) && raw.expect.statusIn.length > 0) {
    expect.statusIn = raw.expect.statusIn
  }
  if (Array.isArray(reply.mustMatch) && reply.mustMatch.length > 0) {
    expect.containsAll = reply.mustMatch
  }
  if (Array.isArray(reply.mustNotMatch) && reply.mustNotMatch.length > 0) {
    expect.containsNone = reply.mustNotMatch
  }
  const workspaceState = Object.entries(files).map(([path, equals]) => ({
    path,
    equals: String(equals),
  }))
  if (workspaceState.length > 0) expect.workspaceState = workspaceState

  const taskBudget = {}
  if (typeof budget.maxLlmCalls === "number") taskBudget.maxModelCalls = budget.maxLlmCalls
  if (typeof budget.maxToolCalls === "number") taskBudget.maxToolCalls = budget.maxToolCalls
  if (Object.keys(taskBudget).length > 0) expect.budget = taskBudget

  assert(
    Object.keys(expect).length > 0,
    `${filename} 没有任何可验证断言（toolSet/finalDecision/reply/files/budget 至少一项）`,
  )

  return {
    id: raw.id,
    title: raw.title,
    suite: "trajectory",
    ...(raw.group ? { taxonomy: raw.group } : {}),
    ...(raw.difficulty ? { difficulty: raw.difficulty } : {}),
    source: raw.source ?? "trajectory",
    split: raw.split ?? "test",
    turns: raw.turns,
    ...(Array.isArray(raw.messageIds) ? { messageIds: raw.messageIds } : {}),
    expect,
    runtimeHints: {
      wfxm: {
        scenarioId: `trajectory-${raw.id}`,
        fixtures: {
          plan: script.plan ?? [],
          exec: script.exec ?? [],
          intake: script.intake ?? [],
          seedFiles: script.seedFiles ?? [],
        },
      },
    },
  }
}

/** 读取目录下所有轨迹（按 id 排序）。 */
export async function loadTrajectoryTasks(dir = trajectoryDir()) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()
  const tasks = []
  for (const name of names) {
    const raw = JSON.parse(await readFile(join(dir, name), "utf8"))
    tasks.push(normalizeTrajectory(raw, name))
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id))
  return tasks
}
