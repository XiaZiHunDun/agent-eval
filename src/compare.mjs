/**
 * 两臂配对比较（lift）。
 *
 * 同一套件分别用两种配置（模型 / prompt / 上下文）各跑一次，再比较任务级
 * 通过率。规则对照 pi 的 evals：
 * - 任一臂缺任务、任务重复、任务未评分、套件不一致 → blocked；
 * - blocked 时不报告 headline lift，调用方应以非零退出；
 * - lift = 臂 B 平均通过率 − 臂 A 平均通过率。
 */

function round(value) {
  return Math.round(value * 1000) / 1000
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * @param {{
 *   a: { suite?: string, results?: readonly { taskId: string, passRate?: number }[] },
 *   b: { suite?: string, results?: readonly { taskId: string, passRate?: number }[] },
 *   labelA?: string,
 *   labelB?: string,
 * }} input
 */
export function compareRuns({ a, b, labelA = "a", labelB = "b" }) {
  const issues = []

  if (a?.suite !== b?.suite) {
    issues.push(`suite 不一致：${a?.suite ?? "<none>"} vs ${b?.suite ?? "<none>"}`)
  }

  const toMap = (summary, label) => {
    const map = new Map()
    for (const result of summary?.results ?? []) {
      const taskId = result?.taskId
      if (typeof taskId !== "string" || taskId.length === 0) {
        issues.push(`${label} 存在缺少 taskId 的结果`)
        continue
      }
      if (map.has(taskId)) {
        issues.push(`${label} 任务重复：${taskId}`)
        continue
      }
      if (typeof result.passRate !== "number" || Number.isNaN(result.passRate)) {
        issues.push(`${label} 任务未评分：${taskId}`)
        continue
      }
      map.set(taskId, result.passRate)
    }
    return map
  }

  const aMap = toMap(a, labelA)
  const bMap = toMap(b, labelB)
  const pairs = []
  for (const taskId of [...new Set([...aMap.keys(), ...bMap.keys()])].sort()) {
    if (!aMap.has(taskId)) {
      issues.push(`${labelA} 缺少任务：${taskId}`)
      continue
    }
    if (!bMap.has(taskId)) {
      issues.push(`${labelB} 缺少任务：${taskId}`)
      continue
    }
    pairs.push({
      taskId,
      aRate: aMap.get(taskId),
      bRate: bMap.get(taskId),
      lift: round(bMap.get(taskId) - aMap.get(taskId)),
    })
  }

  if (pairs.length === 0 && issues.length === 0) issues.push("没有可配对的任务")

  const blocked = issues.length > 0
  return {
    suite: a?.suite ?? b?.suite ?? null,
    labelA,
    labelB,
    blocked,
    issues,
    pairs,
    aRate: pairs.length === 0 ? null : round(mean(pairs.map((pair) => pair.aRate))),
    bRate: pairs.length === 0 ? null : round(mean(pairs.map((pair) => pair.bRate))),
    headline: blocked
      ? null
      : round(mean(pairs.map((pair) => pair.bRate)) - mean(pairs.map((pair) => pair.aRate))),
    improved: pairs.filter((pair) => pair.lift > 0).length,
    regressed: pairs.filter((pair) => pair.lift < 0).length,
    unchanged: pairs.filter((pair) => pair.lift === 0).length,
  }
}
