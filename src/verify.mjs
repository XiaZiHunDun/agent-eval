/**
 * 任务断言。只根据「可观察行为 + 轨迹」打分，不读取 runtime 内部状态。
 *
 * @typedef {object} Observation
 * @property {number} [status]
 * @property {number[]} [statuses]
 * @property {string} [reply]
 * @property {string[]} [replies]
 * @property {string} [finalDecision]
 * @property {number} [steps]
 * @property {string[]} [toolNames]
 * @property {{ name: string, ok: boolean }[]} [toolResults]
 * @property {{ name: string, args?: Record<string, unknown> }[]} [toolCalls]
 * @property {Record<string, string | null>} [workspace]
 * @property {{ command: string, before?: TestRun, after?: TestRun }} [tests]
 * @property {number} [turns]
 * @property {number} [costUsd]
 * @property {number} [durationMs]
 * @property {object} [butler] 管家层观测：route / rule / taskId / approvals / modelCalls
 *
 * @typedef {object} TestRun
 * @property {number} [exitCode]
 * @property {boolean} [passed]
 * @property {{ name: string, ok: boolean }[]} [results]
 *
 * @typedef {object} Check
 * @property {string} name
 * @property {boolean} ok
 * @property {string} detail
 */

/** 判断 actual 是否包含 expected 的所有字段（对象递归子集，数组按位置全等）。 */
function matchesSubset(actual, expected) {
  if (expected === null || typeof expected !== "object") return actual === expected
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false
    return expected.every((value, index) => matchesSubset(actual[index], value))
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false
  return Object.entries(expected).every(
    ([key, value]) => key in actual && matchesSubset(actual[key], value),
  )
}

/**
 * @param {object} task
 * @param {Observation} obs
 * @returns {{ passed: boolean, score: number, checks: Check[], failures: {check: string, detail: string}[] }}
 */
export function verify(task, obs) {
  /** @type {Check[]} */
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  const expect = task.expect ?? {}

  const statuses = obs.statuses ?? (obs.status !== undefined ? [obs.status] : [])
  if (statuses.length > 0) {
    add(
      "http.status",
      statuses.every((s) => s >= 200 && s < 300),
      `status=${statuses.join(",")}`,
    )
  }

  const firstReply = obs.replies?.[0] ?? obs.reply ?? ""

  if (expect.finalDecision) {
    add(
      "decision",
      obs.finalDecision === expect.finalDecision,
      `期望 ${expect.finalDecision}，实际 ${obs.finalDecision ?? "<none>"}`,
    )
  }

  if (expect.finalDecisionIn) {
    add(
      "decision.oneOf",
      expect.finalDecisionIn.includes(obs.finalDecision),
      `期望其一 ${expect.finalDecisionIn.join("/")}，实际 ${obs.finalDecision ?? "<none>"}`,
    )
  }

  if (expect.requireApproval === true) {
    add(
      "approval",
      obs.finalDecision === "WaitForApproval",
      `期望触发审批，实际 finalDecision=${obs.finalDecision ?? "<none>"}`,
    )
  }

  if (expect.replyPattern) {
    let re
    try {
      re = new RegExp(expect.replyPattern, "i")
    } catch (err) {
      add("reply.pattern", false, `非法正则：${String(err)}`)
    }
    if (re) {
      add("reply.pattern", re.test(firstReply), `pattern=${expect.replyPattern}`)
    }
  }

  if (expect.finalReplyPattern) {
    // Multi-turn suites assert on the last reply instead of the first.
    let re
    try {
      re = new RegExp(expect.finalReplyPattern, "i")
    } catch (err) {
      add("reply.final", false, `非法正则：${String(err)}`)
    }
    if (re) {
      add(
        "reply.final",
        re.test(obs.reply ?? firstReply),
        `pattern=${expect.finalReplyPattern}`,
      )
    }
  }

  if (expect.containsAll) {
    for (const needle of expect.containsAll) {
      add(`reply.contains:${needle}`, firstReply.includes(needle), `首轮回复缺少「${needle}」`)
    }
  }

  if (expect.containsNone) {
    for (const needle of expect.containsNone) {
      add(
        `reply.excludes:${needle}`,
        !firstReply.includes(needle),
        `首轮回复不应包含「${needle}」`,
      )
    }
  }

  if (expect.followUpPatterns) {
    for (const [i, pattern] of expect.followUpPatterns.entries()) {
      const text = obs.replies?.[i + 1]
      if (text === undefined) {
        add(`followUp[${i}].pattern`, false, "缺少对应轮次的回复")
        continue
      }
      let re
      try {
        re = new RegExp(pattern, "i")
      } catch (err) {
        add(`followUp[${i}].pattern`, false, `非法正则：${String(err)}`)
        continue
      }
      add(`followUp[${i}].pattern`, re.test(text), `pattern=${pattern}`)
    }
  }

  if (expect.minToolCalls !== undefined) {
    add(
      "steps.min",
      (obs.steps ?? 0) >= expect.minToolCalls,
      `期望 >= ${expect.minToolCalls}，实际 ${obs.steps ?? 0}`,
    )
  }

  if (expect.maxToolCalls !== undefined) {
    add(
      "steps.max",
      (obs.steps ?? 0) <= expect.maxToolCalls,
      `期望 <= ${expect.maxToolCalls}，实际 ${obs.steps ?? 0}`,
    )
  }

  const required = expect.requiredTools ?? []
  const requiredAny = expect.requiredAnyTools ?? []
  const forbidden = expect.forbiddenTools ?? []
  if (required.length > 0 || requiredAny.length > 0 || forbidden.length > 0) {
    if (!obs.toolNames) {
      add("tools.trace", false, "任务声明了工具断言，但 trace 未提供工具名")
    } else {
      for (const name of required) {
        add(`tool.required:${name}`, obs.toolNames.includes(name), `调用序列：${obs.toolNames.join(",")}`)
      }
      if (requiredAny.length > 0) {
        add(
          "tool.requiredAny",
          requiredAny.some((name) => obs.toolNames.includes(name)),
          `期望其一：${requiredAny.join("/")}；调用序列：${obs.toolNames.join(",")}`,
        )
      }
      for (const name of forbidden) {
        add(
          `tool.forbidden:${name}`,
          !obs.toolNames.includes(name),
          `调用序列：${obs.toolNames.join(",")}`,
        )
      }
    }
  }

  if (expect.requireToolSuccess === true) {
    if (!obs.toolResults) {
      add("tools.success", false, "任务要求工具执行成功，但 trace 未提供执行结果")
    } else if (expect.toolArgs && obs.toolCalls) {
      // 声明了 toolArgs 时，只要求「匹配期望参数的调用」有一次成功即可。
      // 真实模型常有探索性失败调用（读错路径、rg 无匹配），不应据此判负；
      // 但期望的工具用法本身必须真的执行成功。
      const problems = []
      for (const spec of expect.toolArgs) {
        const hit = obs.toolCalls.some(
          (call, index) =>
            call.name === spec.name &&
            matchesSubset(call.args ?? {}, spec.args ?? {}) &&
            obs.toolResults[index]?.ok === true,
        )
        if (!hit) problems.push(spec.name)
      }
      add(
        "tools.success",
        problems.length === 0,
        problems.length === 0
          ? "期望的工具调用均已成功"
          : `期望的工具调用未成功：${problems.join(", ")}`,
      )
    } else {
      const failed = obs.toolResults.filter((r) => !r.ok)
      add(
        "tools.success",
        failed.length === 0,
        failed.length === 0
          ? `全部 ${obs.toolResults.length} 次工具执行成功`
          : `失败：${failed.map((r) => r.name).join(", ")}`,
      )
    }
  }

  if (expect.toolArgs) {
    if (!obs.toolCalls) {
      add("tools.args", false, "任务声明了工具参数断言，但 trace 未提供工具调用参数")
    } else {
      const seen = obs.toolCalls.map((c) => c.name).join(",")
      for (const [i, spec] of expect.toolArgs.entries()) {
        const hit = obs.toolCalls.some(
          (call) => call.name === spec.name && matchesSubset(call.args ?? {}, spec.args ?? {}),
        )
        add(
          `toolArgs[${i}]:${spec.name}`,
          hit,
          hit ? "参数匹配" : `没有参数匹配的 ${spec.name} 调用；实际调用：${seen || "<none>"}`,
        )
      }
    }
  }

  if (expect.workspaceState) {
    if (!obs.workspace) {
      add("workspace", false, "任务声明了工作区断言，但 adapter 未提供工作区快照")
    } else {
      for (const [i, spec] of expect.workspaceState.entries()) {
        const content = obs.workspace[spec.path]
        const exists = typeof content === "string"
        if (spec.exists === false) {
          add(`workspace[${i}]:${spec.path}`, !exists, exists ? "文件不应存在" : "文件不存在")
          continue
        }
        add(`workspace[${i}]:${spec.path}`, exists, exists ? "文件存在" : "文件不存在")
        if (!exists) continue
        if (spec.equals !== undefined) {
          add(
            `workspace[${i}]:${spec.path}.equals`,
            content === spec.equals,
            content === spec.equals ? "内容一致" : "内容不一致",
          )
        }
        if (spec.contains !== undefined) {
          add(
            `workspace[${i}]:${spec.path}.contains`,
            content.includes(spec.contains),
            content.includes(spec.contains) ? "包含期望片段" : `未包含「${spec.contains}」`,
          )
        }
        if (spec.matches !== undefined) {
          let re
          try {
            re = new RegExp(spec.matches)
          } catch (err) {
            add(`workspace[${i}]:${spec.path}.matches`, false, `非法正则：${String(err)}`)
          }
          if (re) {
            add(`workspace[${i}]:${spec.path}.matches`, re.test(content), `pattern=${spec.matches}`)
          }
        }
      }
    }
  }

  if (expect.tests) {
    if (!obs.tests) {
      add("tests", false, "任务声明了测试断言，但 adapter 未提供测试结果")
    } else {
      const after = obs.tests.after ?? {}
      add(
        "tests.pass",
        after.passed === true || after.exitCode === 0,
        `命令 ${expect.tests.command} exit=${after.exitCode ?? "<none>"}`,
      )
      const beforeResults = new Map((obs.tests.before?.results ?? []).map((r) => [r.name, r.ok]))
      const afterResults = new Map((after.results ?? []).map((r) => [r.name, r.ok]))
      const describe = (value) => (value === undefined ? "未找到" : value ? "通过" : "失败")

      for (const name of expect.tests.failToPass ?? []) {
        const before = beforeResults.get(name)
        const afterOk = afterResults.get(name)
        add(
          `tests.failToPass:${name}`,
          before === false && afterOk === true,
          `基线=${describe(before)}，终态=${describe(afterOk)}`,
        )
      }
      for (const name of expect.tests.passToPass ?? []) {
        const before = beforeResults.get(name)
        const afterOk = afterResults.get(name)
        add(
          `tests.passToPass:${name}`,
          before === true && afterOk === true,
          `基线=${describe(before)}，终态=${describe(afterOk)}`,
        )
      }
    }
  }

  const butlerExpect = expect.butler
  if (butlerExpect) {
    const actual = obs.butler ?? {}
    if (butlerExpect.route !== undefined) {
      add(
        "butler.route",
        actual.route === butlerExpect.route,
        `期望 ${butlerExpect.route}，实际 ${actual.route ?? "<none>"}`,
      )
    }
    if (butlerExpect.rule !== undefined) {
      add(
        "butler.rule",
        actual.rule === butlerExpect.rule,
        `期望 ${butlerExpect.rule}，实际 ${actual.rule ?? "<none>"}`,
      )
    }
    if (butlerExpect.result !== undefined) {
      add(
        "butler.result",
        matchesSubset(actual, butlerExpect.result),
        `期望 ${JSON.stringify(butlerExpect.result)}，实际 ${JSON.stringify(actual)}`,
      )
    }
  }

  // 用户可见消息的质量契约：结构不变量（确定性的），不是对措辞做精确匹配。
  const userReplies =
    obs.replies && obs.replies.length > 0 ? obs.replies : obs.reply === undefined ? [] : [obs.reply]
  const userText = userReplies.join("\n")

  if (task.suite === "butler" && userReplies.length > 0) {
    add(
      "userMessage.noMarkdown",
      !/```|\*\*|^#{1,6}\s/m.test(userText),
      "微信不渲染 markdown，消息不应包含代码围栏/加粗/标题标记",
    )
    add(
      "userMessage.noRawTool",
      !/待执行：(write|edit|bash|read|grep|find|ls)\b/.test(userText),
      "待执行动作应使用中文名称，不应暴露原始工具名",
    )
    add(
      "userMessage.length",
      userReplies.every((text) => text.length <= 1800),
      `单条消息不应超过 1800 字符，实际最长 ${Math.max(...userReplies.map((t) => t.length))}`,
    )
    add(
      "userMessage.nonEmpty",
      userReplies.every((text) => text.trim().length > 0),
      "每条用户可见消息都不应为空",
    )
  }

  const userExpect = expect.userMessage
  if (userExpect) {
    for (const needle of userExpect.mustMention ?? []) {
      add(
        `userMessage.mentions:${needle}`,
        userText.includes(needle),
        `用户可见消息缺少「${needle}」`,
      )
    }
    for (const pattern of userExpect.mustNotMatch ?? []) {
      let re
      try {
        re = new RegExp(pattern, "i")
      } catch (err) {
        add(`userMessage.excludes:${pattern}`, false, `非法正则：${String(err)}`)
        continue
      }
      add(`userMessage.excludes:${pattern}`, !re.test(userText), `用户可见消息不应匹配 /${pattern}/`)
    }
    if (userExpect.maxLength !== undefined) {
      const longest = userReplies.reduce((max, text) => Math.max(max, text.length), 0)
      add(
        "userMessage.maxLength",
        userReplies.length > 0 && longest <= userExpect.maxLength,
        `期望每条 <= ${userExpect.maxLength}，实际最长 ${longest}`,
      )
    }
  }

  if (task.budget) {
    if (task.budget.maxTurns !== undefined) {
      const turns = obs.turns ?? task.turns?.length ?? 0
      add("budget.turns", turns <= task.budget.maxTurns, `期望 <= ${task.budget.maxTurns}，实际 ${turns}`)
    }
    if (task.budget.maxToolCalls !== undefined) {
      add(
        "budget.toolCalls",
        (obs.steps ?? 0) <= task.budget.maxToolCalls,
        `期望 <= ${task.budget.maxToolCalls}，实际 ${obs.steps ?? 0}`,
      )
    }
    if (task.budget.maxCostUsd !== undefined && obs.costUsd !== undefined) {
      add(
        "budget.costUsd",
        obs.costUsd <= task.budget.maxCostUsd,
        `期望 <= $${task.budget.maxCostUsd}，实际 $${obs.costUsd}`,
      )
    }
    if (task.budget.maxModelCalls !== undefined) {
      const calls = obs.model?.calls ?? 0
      add(
        "budget.modelCalls",
        calls <= task.budget.maxModelCalls,
        `期望 <= ${task.budget.maxModelCalls}，实际 ${calls}`,
      )
    }
  }

  if (checks.length === 0) {
    add("task.hasExpectation", false, "任务没有任何可验证断言")
  }

  const passedCount = checks.filter((c) => c.ok).length
  const score = checks.length === 0 ? 0 : passedCount / checks.length
  const failures = checks.filter((c) => !c.ok).map((c) => ({ check: c.name, detail: c.detail }))
  return { passed: failures.length === 0, score: Math.round(score * 1000) / 1000, checks, failures }
}
