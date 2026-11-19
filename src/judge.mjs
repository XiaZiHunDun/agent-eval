/**
 * 开放任务（L4）评分：硬性规则优先，全部通过后才进入软性 judge。
 *
 * 规则只看外部可观察结果（产物文件、测试、工具集合、预算、用户可见回复），
 * 不比对实现细节。软性评分用固定 judge 模型的 1–5 分，缺省要求双评均值达标；
 * 没有 judge 时只记录 `judge.pending`，不把“未评分”误当成失败。
 */

function failure(check, detail) {
  return { check, detail }
}

function textAt(obs, path) {
  const value = obs.workspace?.[path]
  return typeof value === "string" ? value : undefined
}

function toolNames(obs) {
  return Array.isArray(obs.toolNames) ? obs.toolNames : []
}

function replyText(obs) {
  if (Array.isArray(obs.replies) && obs.replies.length > 0) return obs.replies.join("\n")
  return typeof obs.reply === "string" ? obs.reply : ""
}

/**
 * 执行 rubric.hard。
 *
 * @param {object} rubric
 * @param {object} obs
 * @returns {{ checks: {name: string, ok: boolean, detail: string}[], failures: {check: string, detail: string}[] }}
 */
export function evaluateHardRules(rubric, obs) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  const rules = Array.isArray(rubric?.hard) ? rubric.hard : []

  for (const [index, rule] of rules.entries()) {
    const id = rule.id ?? `${rule.type}[${index}]`
    switch (rule.type) {
      case "file_exists": {
        const content = textAt(obs, rule.path)
        add(id, content !== undefined, content === undefined ? `缺少 ${rule.path}` : `${rule.path} 存在`)
        break
      }
      case "file_contains": {
        const content = textAt(obs, rule.path)
        add(
          id,
          content !== undefined && content.includes(rule.text),
          content === undefined ? `缺少 ${rule.path}` : `未包含「${rule.text}」`,
        )
        break
      }
      case "file_equals": {
        const content = textAt(obs, rule.path)
        add(
          id,
          content === rule.text,
          content === undefined ? `缺少 ${rule.path}` : `内容与期望不一致`,
        )
        break
      }
      case "tool_used_any": {
        const names = toolNames(obs)
        const hit = (rule.tools ?? []).some((name) => names.includes(name))
        add(id, hit, hit ? `命中 ${rule.tools.join("/")}` : `调用序列：${names.join(",") || "<none>"}`)
        break
      }
      case "tool_forbidden": {
        const names = toolNames(obs)
        const hit = (rule.tools ?? []).find((name) => names.includes(name))
        add(id, hit === undefined, hit ? `不应调用 ${hit}` : "未调用禁用工具")
        break
      }
      case "tool_success": {
        const results = Array.isArray(obs.toolResults) ? obs.toolResults : []
        const scoped = rule.name ? results.filter((r) => r.name === rule.name) : results
        const ok = scoped.length > 0 && scoped.every((r) => r.ok)
        add(id, ok, ok ? "工具执行成功" : `失败或未执行：${rule.name ?? "全部工具"}`)
        break
      }
      case "tests_passed": {
        const after = obs.tests?.after ?? {}
        const ok = after.passed === true || after.exitCode === 0
        add(id, ok, `exit=${after.exitCode ?? "<none>"}`)
        break
      }
      case "reply_contains": {
        const text = replyText(obs)
        const missing = (rule.texts ?? []).filter((needle) => !text.includes(needle))
        add(id, missing.length === 0, missing.length === 0 ? "回复满足" : `缺少「${missing.join("、")}」`)
        break
      }
      case "reply_excludes": {
        const text = replyText(obs)
        const hit = (rule.texts ?? []).filter((needle) => text.includes(needle))
        add(id, hit.length === 0, hit.length === 0 ? "回复未泄漏" : `出现「${hit.join("、")}」`)
        break
      }
      case "max_tool_calls": {
        const steps = obs.steps ?? 0
        add(id, steps <= rule.value, `期望 <= ${rule.value}，实际 ${steps}`)
        break
      }
      case "max_model_calls": {
        const calls = obs.model?.calls ?? 0
        add(id, calls <= rule.value, `期望 <= ${rule.value}，实际 ${calls}`)
        break
      }
      default:
        add(id, false, `未知规则类型：${rule.type}`)
    }
  }

  return { checks, failures: checks.filter((c) => !c.ok).map((c) => failure(c.name, c.detail)) }
}

/** 构造交给固定 judge 模型的评分提示（无实现细节、只看目标达成与禁忌）。 */
export function buildJudgePrompt(task, obs) {
  const criteria = task.rubric?.soft?.criteria ?? []
  return [
    "你是严格的评审员。根据用户任务、可观察结果和评分标准打分（1–5 分）。",
    "只评价目标是否达成、是否违反禁忌；不要评价实现方式、函数名或代码风格。",
    "",
    `任务：${task.title}`,
    `用户请求：${(task.turns ?? []).join(" / ")}`,
    `评分标准：${criteria.map((item, i) => `${i + 1}. ${item}`).join("；")}`,
    "",
    `用户可见回复：${replyText(obs).slice(0, 4000)}`,
    `使用工具：${toolNames(obs).join(", ") || "<none>"}`,
    `改动文件：${
      Object.entries(obs.workspace ?? {})
        .filter(([, value]) => typeof value === "string")
        .map(([path]) => path)
        .join(", ") || "<none>"
    }`,
    "",
    "只输出一行：SCORE=<1-5>",
  ].join("\n")
}

/** 从 judge 输出里解析 1–5 分；无法解析时返回 null。 */
export function parseJudgeScore(text) {
  if (typeof text !== "string") return null
  const match = /SCORE\s*=\s*([1-5])/i.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * 开放任务总评分。
 *
 * @param {object} task
 * @param {object} obs
 * @param {{ judge?: (args: { task: object, obs: object, prompt: string }) => Promise<{ scores: number[] } | { text: string }> }} [opts]
 */
export async function evaluateOpenTask(task, obs, opts = {}) {
  const rubric = task.rubric ?? {}
  const hard = evaluateHardRules(rubric, obs)
  const checks = [...hard.checks]
  const failures = [...hard.failures]
  let judge

  const hardOk = failures.length === 0
  const soft = rubric.soft
  if (hardOk && soft && opts.judge) {
    const prompt = buildJudgePrompt(task, obs)
    const result = await opts.judge({ task, obs, prompt })
    const scores = result?.scores ?? (result?.text ? [parseJudgeScore(result.text)].filter(Boolean) : [])
    if (scores.length === 0) {
      checks.push({ name: "judge.score", ok: false, detail: "judge 未给出可解析分数" })
      failures.push(failure("judge.score", "judge 未给出可解析分数"))
    } else {
      const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length
      const min = soft.minScore ?? 4
      const ok = mean >= min
      checks.push({ name: "judge.score", ok, detail: `均值 ${mean.toFixed(2)}，期望 >= ${min}` })
      if (!ok) failures.push(failure("judge.score", `均值 ${mean.toFixed(2)} < ${min}`))
      judge = { scores, mean }
    }
  } else if (hardOk && soft) {
    checks.push({ name: "judge.pending", ok: true, detail: "未配置 judge，已记录待评分" })
  }

  const passedCount = checks.filter((c) => c.ok).length
  const score = checks.length === 0 ? 0 : passedCount / checks.length
  return {
    passed: failures.length === 0,
    score: Math.round(score * 1000) / 1000,
    checks,
    failures,
    ...(judge ? { judge } : {}),
  }
}
