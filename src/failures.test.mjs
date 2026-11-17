import assert from "node:assert/strict"
import test from "node:test"
import { classifyFailure, failureCategories } from "./failures.mjs"

test("failures: 断言名映射到固定分类", () => {
  assert.equal(classifyFailure("reply.pattern"), "model")
  assert.equal(classifyFailure("decision"), "model")
  assert.equal(classifyFailure("tool.required:write_file"), "tool")
  assert.equal(classifyFailure("toolArgs[0]:read_file"), "tool")
  assert.equal(classifyFailure("steps.max"), "tool")
  assert.equal(classifyFailure("rag.hitAt3"), "retrieval")
  assert.equal(classifyFailure("approval"), "approval")
  assert.equal(classifyFailure("budget.toolCalls"), "budget")
  assert.equal(classifyFailure("trace.invalid"), "harness")
  assert.equal(classifyFailure("http.status"), "harness")
  assert.equal(classifyFailure("workspace[0]:a.ts"), "task")
  assert.equal(classifyFailure("tests.pass"), "task")
  assert.equal(classifyFailure("new.check"), "unknown")
})

test("failures: 分类去重并按固定顺序输出", () => {
  const categories = failureCategories([
    { check: "budget.toolCalls" },
    { check: "tool.required:write_file" },
    { check: "reply.pattern" },
    { check: "tool.forbidden:run_command" },
  ])
  assert.deepEqual(categories, ["model", "tool", "budget"])
})
