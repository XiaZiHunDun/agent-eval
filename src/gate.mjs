/** RAG 检索指标的默认门禁阈值（任务通过率由 --min-rag 单独传入）。 */
export const DEFAULT_MIN_RAG_HIT_AT3 = 0.9
export const DEFAULT_MIN_RAG_MRR = 0.8

/**
 * Gate 判定。通过率使用 0–1 的小数，阈值同样如此。
 *
 * capability 支持 `rate`（任务级平均通过率）与 `flaky`（部分尝试失败的 taskId 列表）：
 * 重复采样后不能用 best-of 或「任务全过数」，否则会把不稳定性藏起来。
 * flaky 另设独立预算（默认 20%），不参与通过率计算。
 *
 * RAG 与 capability 分开判：任务通过率沿用“任务级平均通过率”，检索指标用
 * Hit@3 / MRR。Ragas 生成指标是 LLM judge，有随机性与额外成本，不进 gate。
 *
 * @param {{
 *   baseline: { passed: number, total: number },
 *   butler?: { passed: number, total: number, rate?: number },
 *   minButler?: number,
 *   butlerOpen?: { passed: number, total: number, rate?: number },
 *   minButlerOpen?: number,
 *   capability?: { passed: number, total: number, rate?: number, flaky?: string[] },
 *   minCapability?: number,
 *   rag?: {
 *     passed: number,
 *     total: number,
 *     rate?: number,
 *     flaky?: string[],
 *     retrieval?: { casesTotal: number, hitAt1: number, hitAt3: number, mrr: number, misses?: string[] },
 *   },
 *   minRagRate?: number,
 *   minRagHitAt3?: number,
 *   minRagMrr?: number,
 *   maxFlakyRate?: number,
 * }} input
 */
export function evaluateGate({
  baseline,
  butler,
  minButler = 0.9,
  butlerOpen,
  minButlerOpen = 0.85,
  capability,
  minCapability = 0.8,
  rag,
  minRagRate = 0.9,
  minRagHitAt3 = DEFAULT_MIN_RAG_HIT_AT3,
  minRagMrr = DEFAULT_MIN_RAG_MRR,
  maxFlakyRate = 0.2,
}) {
  const baselineRate = passRate(baseline)
  const checks = [
    {
      name: "baseline.passRate",
      ok: baselineRate === 1,
      detail: `baseline ${baseline.passed}/${baseline.total}（期望 100%）`,
    },
  ]

  let butlerRate
  if (butler) {
    butlerRate = butler.rate ?? passRate(butler)
    checks.push({
      name: "butler.passRate",
      ok: butlerRate >= minButler,
      detail: `butler ${butler.passed}/${butler.total}（${percent(butlerRate)}，期望 >= ${percent(minButler)}）`,
    })
  }

  let butlerOpenRate
  if (butlerOpen) {
    butlerOpenRate = butlerOpen.rate ?? passRate(butlerOpen)
    checks.push({
      name: "butlerOpen.passRate",
      ok: butlerOpenRate >= minButlerOpen,
      detail: `butler-open ${butlerOpen.passed}/${butlerOpen.total}（${percent(butlerOpenRate)}，期望 >= ${percent(minButlerOpen)}）`,
    })
  }

  let capabilityRate
  if (capability) {    capabilityRate = capability.rate ?? passRate(capability)
    const flaky = capability.flaky ?? []
    const parts = [
      `capability 平均通过率 ${percent(capabilityRate)}`,
      `${capability.passed}/${capability.total} 任务全过`,
      flaky.length > 0 ? `flaky ${flaky.length} 条：${flaky.join(", ")}` : "无 flaky",
      `期望 >= ${percent(minCapability)}`,
    ]
    checks.push({
      name: "capability.passRate",
      ok: capabilityRate >= minCapability,
      detail: parts.join("；"),
    })
    checks.push(flakyCheck("capability", flaky, capability.total, maxFlakyRate))
  }

  let ragRate
  if (rag) {
    ragRate = rag.rate ?? passRate(rag)
    const flaky = rag.flaky ?? []
    checks.push({
      name: "rag.passRate",
      ok: ragRate >= minRagRate,
      detail: [
        `rag 平均通过率 ${percent(ragRate)}`,
        `${rag.passed}/${rag.total} 任务全过`,
        flaky.length > 0 ? `flaky ${flaky.length} 条：${flaky.join(", ")}` : "无 flaky",
        `期望 >= ${percent(minRagRate)}`,
      ].join("；"),
    })
    checks.push(flakyCheck("rag", flaky, rag.total, maxFlakyRate))

    const retrieval = rag.retrieval
    const cases = retrieval?.casesTotal ?? 0
    checks.push({
      name: "rag.retrievalCases",
      ok: cases > 0,
      detail: cases > 0 ? `检索用例 ${cases} 次` : "没有检索真值（expectedDocTitles）",
    })
    if (cases > 0) {
      const misses = retrieval?.misses ?? []
      checks.push({
        name: "rag.hitAt3",
        ok: (retrieval?.hitAt3 ?? 0) >= minRagHitAt3,
        detail: `Hit@3 ${percent(retrieval?.hitAt3 ?? 0)}（期望 >= ${percent(minRagHitAt3)}）${
          misses.length > 0 ? `；完全未命中：${misses.join(", ")}` : ""
        }`,
      })
      checks.push({
        name: "rag.mrr",
        ok: (retrieval?.mrr ?? 0) >= minRagMrr,
        detail: `MRR ${(retrieval?.mrr ?? 0).toFixed(3)}（期望 >= ${minRagMrr.toFixed(3)}）`,
      })
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    baselineRate: round(baselineRate),
    ...(butlerRate === undefined ? {} : { butlerRate: round(butlerRate) }),
    ...(butlerOpenRate === undefined ? {} : { butlerOpenRate: round(butlerOpenRate) }),
    ...(capabilityRate === undefined ? {} : { capabilityRate: round(capabilityRate) }),
    ...(ragRate === undefined ? {} : { ragRate: round(ragRate) }),
    checks,
  }
}

function flakyCheck(label, flaky, total, maxFlakyRate) {
  const rate = total > 0 ? flaky.length / total : 0
  return {
    name: `${label}.flakyBudget`,
    ok: rate <= maxFlakyRate,
    detail: [
      `flaky ${flaky.length}/${total}（${percent(rate)}）`,
      `预算 <= ${percent(maxFlakyRate)}`,
      flaky.length > 0 ? flaky.join(", ") : "",
    ]
      .filter(Boolean)
      .join("；"),
  }
}

function passRate({ passed, total }) {
  return total > 0 ? passed / total : 0
}

function percent(value) {
  return `${Number((value * 100).toFixed(1))}%`
}

function round(value) {
  return Math.round(value * 1000) / 1000
}
