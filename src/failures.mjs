/** 失败自动归因。只根据断言名分类，不读 runtime 内部状态。 */
export const FAILURE_CATEGORIES = [
  "model",
  "tool",
  "retrieval",
  "approval",
  "budget",
  "harness",
  "task",
  "unknown",
]

const EXACT = {
  approval: "approval",
  tests: "task",
  "http.status": "harness",
  "adapter.run": "harness",
  "task.hasExpectation": "model",
}

/**
 * 把一个 failure.check 映射到固定分类。
 *
 * - model：回答内容 / 决策 / 多轮不符合预期
 * - tool：工具选择、参数、执行成功性、步数
 * - retrieval：RAG 检索指标与召回断言
 * - approval：审批链路
 * - budget：轮次 / 工具调用 / 成本预算
 * - harness：trace 完整度、HTTP 接线、adapter 崩溃
 * - task：工作区 / 测试 oracle
 * - unknown：新增断言未登记，提示补映射
 */
export function classifyFailure(check) {
  if (typeof check !== "string" || !check.trim()) return "unknown"
  if (EXACT[check]) return EXACT[check]
  if (check.startsWith("rag.")) return "retrieval"
  if (check.startsWith("budget.")) return "budget"
  if (check.startsWith("trace.")) return "harness"
  if (check.startsWith("tool.") || check.startsWith("toolArgs") || check.startsWith("tools.")) {
    return "tool"
  }
  if (check.startsWith("steps.")) return "tool"
  if (check.startsWith("reply.") || check.startsWith("followUp") || check === "decision") {
    return "model"
  }
  if (check.startsWith("workspace") || check.startsWith("tests.")) return "task"
  return "unknown"
}

/** 汇总一组 failures 的分类（去重、保持固定顺序）。 */
export function failureCategories(failures) {
  const seen = new Set(failures.map((failure) => classifyFailure(failure.check)))
  return FAILURE_CATEGORIES.filter((category) => seen.has(category))
}
