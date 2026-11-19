/**
 * 真实模型子集的基线与回归判定。
 *
 * 基线只约束「整体通过率 + 任务覆盖」，不逐条卡单任务通过率：
 * 真实模型有随机性，2 次重复下单任务 0/2→1/2 不应被当成回归。
 * `taskRates` 只写入基线文件供诊断，不参与判定。
 */

function round(value) {
  return Math.round(value * 1000) / 1000
}

/**
 * 从一次运行结果生成基线文件内容。
 *
 * @param {{ suite: string, results: readonly { taskId: string, passRate?: number }[], passRate: number, recordedAt?: string }} input
 */
export function buildBaseline({ suite, results, passRate, recordedAt = new Date().toISOString() }) {
  return {
    suite,
    recordedAt,
    tasks: results.map((result) => result.taskId),
    overallRate: round(passRate),
    taskRates: Object.fromEntries(results.map((result) => [result.taskId, round(result.passRate ?? 0)])),
  }
}

/**
 * 与基线比较。缺任务、通过率下降都会失败。
 *
 * @param {{ suite: string, results: readonly { taskId: string }[], passRate: number, baseline: object }} input
 * @returns {{ ok: boolean, checks: { name: string, ok: boolean, detail: string }[] }}
 */
export function compareToBaseline({ suite, results, passRate, baseline }) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })

  if (typeof baseline?.suite === "string" && baseline.suite !== suite) {
    add("baseline.suite", false, `基线属于 ${baseline.suite}，本次运行 ${suite}`)
  }

  const actualIds = new Set(results.map((result) => result.taskId))
  const expected = Array.isArray(baseline?.tasks) ? baseline.tasks : []
  const missing = expected.filter((id) => !actualIds.has(id))
  add(
    "baseline.tasks",
    missing.length === 0,
    missing.length === 0
      ? `${expected.length}/${expected.length} 条基线任务均已运行`
      : `缺少基线任务：${missing.join(", ")}`,
  )

  const threshold = typeof baseline?.overallRate === "number" ? baseline.overallRate : 0
  add(
    "baseline.overall",
    passRate + 1e-9 >= threshold,
    `平均任务通过率 ${(passRate * 100).toFixed(1)}%（期望 >= ${(threshold * 100).toFixed(1)}%）`,
  )

  return { ok: checks.every((check) => check.ok), checks }
}
