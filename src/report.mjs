/** 渲染 markdown 报告。数值只来自 result.json，不做二次推断。 */
export function renderReport(summary) {
  const { runId, runtime, suite, startedAt, finishedAt, results } = summary
  const total = results.length
  const passed = results.filter((r) => r.passed).length
  const repeats = summary.repeats ?? 1
  const passRate =
    summary.passRate ?? (total === 0 ? 0 : results.reduce((s, r) => s + rateOf(r), 0) / total)
  const flaky = summary.flaky ?? results.filter((r) => rateOf(r) > 0 && rateOf(r) < 1)
  const avgScore = total === 0 ? 0 : results.reduce((s, r) => s + r.score, 0) / total
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b)
  const p95 = durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]

  const lines = []
  lines.push(`# Agent Eval 报告 — ${runtime} / ${suite}`)
  lines.push("")
  lines.push(`- runId：\`${runId}\``)
  lines.push(`- startedAt：${startedAt}`)
  lines.push(`- finishedAt：${finishedAt}`)
  lines.push(`- 任务数：${total}`)
  if (repeats > 1) lines.push(`- 每任务重复：${repeats} 次`)
  lines.push(`- 任务全过：${passed} / 失败：${total - passed}`)
  lines.push(`- 平均任务通过率：${(passRate * 100).toFixed(1)}%`)
  if (flaky.length > 0) {
    lines.push(
      `- Flaky 任务：${flaky
        .map((f) => `${f.taskId}（${f.attemptsPassed}/${f.attemptsTotal}）`)
        .join("、")}`,
    )
  }
  lines.push(`- 平均分：${avgScore.toFixed(3)}`)
  lines.push(`- P95 时延：${p95}ms`)
  const costs = results.map((r) => r.costUsd).filter((value) => typeof value === "number")
  if (costs.length > 0) {
    const avgCost = costs.reduce((sum, value) => sum + value, 0) / costs.length
    lines.push(`- 平均成本：$${avgCost.toFixed(4)}（${costs.length}/${total} 条有计价）`)
  }
  lines.push("")

  const suiteToolCalls = {}
  let suiteApprovals = 0
  const suiteTokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let hasTokens = false
  for (const result of results) {
    for (const [name, count] of Object.entries(result.metrics?.toolCallsByName ?? {})) {
      suiteToolCalls[name] = (suiteToolCalls[name] ?? 0) + count
    }
    suiteApprovals += result.metrics?.approvals ?? 0
    if ((result.metrics?.tokens?.totalTokens ?? 0) > 0) {
      hasTokens = true
      suiteTokens.inputTokens += result.metrics.tokens.inputTokens ?? 0
      suiteTokens.outputTokens += result.metrics.tokens.outputTokens ?? 0
      suiteTokens.totalTokens += result.metrics.tokens.totalTokens ?? 0
    }
  }
  const totalToolCalls = Object.values(suiteToolCalls).reduce((sum, count) => sum + count, 0)
  if (totalToolCalls > 0 || suiteApprovals > 0 || hasTokens) {
    lines.push(
      `- 工具调用：${totalToolCalls} 次${
        totalToolCalls > 0 ? `（${formatToolCounts(suiteToolCalls)}）` : ""
      }；审批请求：${suiteApprovals} 次${
        hasTokens
          ? `；tokens：in ${suiteTokens.inputTokens} / out ${suiteTokens.outputTokens} / 合计 ${suiteTokens.totalTokens}`
          : ""
      }`,
    )
    lines.push("")
  }

  const groups = new Map()
  for (const r of results) {
    if (!r.taxonomy) continue
    const g = groups.get(r.taxonomy) ?? { total: 0, passed: 0, rate: 0, score: 0, durations: [] }
    g.total += 1
    if (r.passed) g.passed += 1
    g.rate += rateOf(r)
    g.score += r.score
    g.durations.push(r.durationMs)
    groups.set(r.taxonomy, g)
  }
  if (groups.size > 0) {
    lines.push("## 分层统计")
    lines.push("")
    lines.push("| 维度 | 任务 | 任务全过 | 平均通过率 | 平均分 | P95(ms) |")
    lines.push("|---|---|---|---|---|---|")
    for (const [taxonomy, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const ds = [...g.durations].sort((a, b) => a - b)
      const groupP95 = ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))]
      lines.push(
        `| ${taxonomy} | ${g.total} | ${g.passed} | ${((g.rate / g.total) * 100).toFixed(0)}% | ${(g.score / g.total).toFixed(3)} | ${groupP95} |`,
      )
    }
    lines.push("")
  }

  lines.push("## 执行矩阵")
  lines.push("")
  if (repeats > 1) lines.push(`计数为 ${repeats} 次尝试合计；变更规模为单次均值。`)
  lines.push("| 任务 | 工具调用 | 审批 | Tokens(in/out) | 平均成本 | 变更文件 | +行/-行 |")
  lines.push("|---|---|---|---|---|---|---|")
  for (const r of results) {
    const metrics = r.metrics ?? {}
    const tokens = metrics.tokens
    const diff = metrics.diff
    const cost = typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(4)}` : "—"
    lines.push(
      `| ${r.taskId} | ${formatToolCounts(metrics.toolCallsByName)} | ${metrics.approvals ?? 0} | ${
        tokens && tokens.totalTokens > 0 ? `${tokens.inputTokens}/${tokens.outputTokens}` : "—"
      } | ${cost} | ${diff ? diff.filesChanged : "—"} | ${diff ? `+${diff.added}/-${diff.removed}` : "—"} |`,
    )
  }
  lines.push("")

  lines.push("| 任务 | 维度 | 结果 | 通过率 | 分数 | 步数 | 时延(ms) | finalDecision | 失败项 |")
  lines.push("|---|---|---|---|---|---|---|---|---|")
  for (const r of results) {
    const failed = r.failures.map((f) => `${f.check}: ${f.detail}`).join("<br>") || "—"
    lines.push(
      `| ${r.taskId} | ${r.taxonomy ?? "—"} | ${r.passed ? "PASS" : "FAIL"} | ${formatRate(r)} | ${r.score} | ${r.steps} | ${r.durationMs} | ${r.finalDecision ?? "—"} | ${failed} |`,
    )
  }
  lines.push("")

  if (flaky.length > 0) {
    lines.push("## Flaky 任务")
    lines.push("")
    lines.push("| 任务 | 通过次数 | 每次结果 |")
    lines.push("|---|---|---|")
    for (const r of results.filter((item) => rateOf(item) > 0 && rateOf(item) < 1)) {
      const seq = (r.attempts ?? []).map((a) => (a.passed ? "PASS" : "FAIL")).join(", ")
      lines.push(`| ${r.taskId} | ${r.attemptsPassed}/${r.attemptsTotal} | ${seq || "—"} |`)
    }
    lines.push("")
  }

  lines.push("## 失败归因（自动分类，待人工复核）")
  lines.push("")
  const failedResults = results.filter((r) => !r.passed)
  if (failedResults.length === 0) {
    lines.push("本轮无失败样本。")
  } else {
    const counts = new Map()
    for (const r of failedResults) {
      for (const category of r.failureCategories ?? ["unknown"]) {
        counts.set(category, (counts.get(category) ?? 0) + 1)
      }
    }
    lines.push(
      `分类计数：${[...counts].map(([category, count]) => `${category} ${count}`).join("、")}`,
    )
    lines.push("")
    lines.push("| 任务 | 自动归因 | 自动证据 |")
    lines.push("|---|---|---|")
    for (const r of failedResults) {
      const categories = (r.failureCategories ?? ["unknown"]).join(", ")
      lines.push(`| ${r.taskId} | ${categories} | ${r.failures.map((f) => f.check).join(", ")} |`)
    }
  }
  return lines.join("\n") + "\n"
}

function rateOf(result) {
  return result.passRate ?? (result.passed ? 1 : 0)
}

function formatToolCounts(counts) {
  const entries = Object.entries(counts ?? {})
  if (entries.length === 0) return "—"
  entries.sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
  const shown = entries.slice(0, 4).map(([name, count]) => `${name}×${count}`)
  if (entries.length > 4) shown.push(`+${entries.length - 4}`)
  return shown.join(", ")
}

function formatRate(result) {
  const rate = rateOf(result)
  if ((result.attemptsTotal ?? 1) > 1) {
    return `${(rate * 100).toFixed(0)}% (${result.attemptsPassed}/${result.attemptsTotal})`
  }
  return `${(rate * 100).toFixed(0)}%`
}
