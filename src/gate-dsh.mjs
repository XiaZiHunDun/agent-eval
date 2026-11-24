/**
 * dsh-wfxm 的离线门禁判定：只比较套件通过率与阈值，不读 runtime 内部状态。
 * advisory 期间照常给出 ok=false，但 exitOk=true，便于 nightly 先观察两周。
 */

export const DEFAULT_DSH_THRESHOLDS = {
  smoke: 1,
  tools: 0.9,
  approval: 1,
  adversarial: 1,
}

/**
 * @param {{ suites: {name: string, passed: number, total: number}[], thresholds?: Record<string, number>, advisory?: boolean }} args
 */
export function evaluateDshGate({ suites, thresholds = DEFAULT_DSH_THRESHOLDS, advisory = false }) {
  const byName = new Map(suites.map((suite) => [suite.name, suite]))
  const checks = []

  for (const [name, min] of Object.entries(thresholds)) {
    const suite = byName.get(name)
    if (!suite) {
      checks.push({ name: `suite.${name}`, ok: false, detail: `未运行（要求 >= ${min}）` })
      continue
    }
    const total = suite.total ?? 0
    const passed = suite.passed ?? 0
    const rate = total === 0 ? 0 : passed / total
    checks.push({
      name: `suite.${name}`,
      ok: total > 0 && rate >= min,
      detail: `${passed}/${total}（${(rate * 100).toFixed(1)}%）要求 >= ${min}`,
    })
  }

  const ok = checks.every((check) => check.ok)
  return { ok, advisory, exitOk: advisory ? true : ok, checks }
}
