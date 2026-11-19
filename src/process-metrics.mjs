/**
 * 轨迹过程指标：只看外部可观察的调用与结果，不读 runtime 内部状态。
 *
 * - 必要工具召回：任务声明 requiredTools，实际调用序列里命中的比例
 * - 冗余调用：同名且参数完全相同的重复调用占比
 * - 参数正确率：任务声明 toolArgs 时，期望用法被实际调用覆盖的比例
 * - 失败归因：复用 runner 的 failureCategories 汇总
 */

function round(value) {
  return Math.round(value * 1000) / 1000
}

function rate(hit, total) {
  return total === 0 ? null : round(hit / total)
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
}

/** 期望参数是实际参数的子集即视为命中（与 verify.toolArgs 语义一致）。 */
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
 * @param {readonly object[]} tasks
 * @param {readonly object[]} results
 */
export function computeProcessMetrics(tasks, results) {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  let expectedTools = 0
  let recalledTools = 0
  let calls = 0
  let uniqueCalls = 0
  let paramSpecs = 0
  let paramHits = 0

  for (const result of results) {
    const task = taskById.get(result.taskId)
    const toolNames = result.toolNames ?? []
    const toolCalls = result.toolCalls ?? []

    for (const name of task?.expect?.requiredTools ?? []) {
      expectedTools += 1
      if (toolNames.includes(name)) recalledTools += 1
    }

    calls += toolCalls.length
    const seen = new Set()
    for (const call of toolCalls) {
      const key = `${call.name}:${stableJson(call.args ?? {})}`
      if (!seen.has(key)) {
        seen.add(key)
        uniqueCalls += 1
      }
    }

    for (const spec of task?.expect?.toolArgs ?? []) {
      paramSpecs += 1
      const hit = toolCalls.some(
        (call) => call.name === spec.name && matchesSubset(call.args ?? {}, spec.args ?? {}),
      )
      if (hit) paramHits += 1
    }
  }

  const failureCategories = {}
  for (const result of results) {
    for (const category of result.failureCategories ?? []) {
      failureCategories[category] = (failureCategories[category] ?? 0) + 1
    }
  }

  return {
    toolRecall: {
      expected: expectedTools,
      hit: recalledTools,
      rate: rate(recalledTools, expectedTools),
    },
    redundant: {
      calls,
      unique: uniqueCalls,
      rate: rate(calls - uniqueCalls, calls),
    },
    paramAccuracy: {
      specs: paramSpecs,
      hit: paramHits,
      rate: rate(paramHits, paramSpecs),
    },
    failureCategories,
  }
}
