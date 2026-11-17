import assert from "node:assert/strict"
import test from "node:test"
import { renderReport } from "./report.mjs"

test("report: 输出执行矩阵与失败归因", () => {
  const report = renderReport({
    runId: "r1",
    runtime: "wfxm",
    suite: "rag",
    startedAt: "a",
    finishedAt: "b",
    results: [
      {
        taskId: "rag-a",
        taxonomy: "retrieval",
        passed: true,
        score: 1,
        steps: 2,
        durationMs: 100,
        finalDecision: "Respond",
        attemptsTotal: 1,
        attemptsPassed: 1,
        metrics: {
          toolCallsByName: { recall_document: 2 },
          approvals: 0,
          tokens: { calls: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
        failures: [],
      },
      {
        taskId: "repo-b",
        taxonomy: "code-edit",
        passed: false,
        score: 0.5,
        steps: 4,
        durationMs: 200,
        finalDecision: "Respond",
        attemptsTotal: 1,
        attemptsPassed: 0,
        failureCategories: ["tool"],
        metrics: {
          toolCallsByName: { read_file: 1, write_file: 1 },
          approvals: 1,
          diff: { filesChanged: 3, added: 9, removed: 2 },
        },
        failures: [{ check: "tool.required:write_file", detail: "缺失" }],
      },
    ],
  })

  assert.match(report, /## 执行矩阵/)
  assert.match(report, /recall_document×2/)
  assert.match(report, /\+9\/-2/)
  assert.match(report, /分类计数：tool 1/)
  assert.match(report, /\| repo-b \| tool \| tool\.required:write_file \|/)
})
