import assert from "node:assert/strict";
import test from "node:test";
import { computeProcessMetrics } from "./process-metrics.mjs";

test("process metrics: 必要工具召回与冗余调用", () => {
  const tasks = [
    { id: "t1", expect: { requiredTools: ["read_file", "write_file"] } },
    { id: "t2", expect: { requiredTools: ["run_command"] } },
  ];
  const results = [
    {
      taskId: "t1",
      toolNames: ["read_file", "write_file"],
      toolCalls: [
        { name: "read_file", args: { path: "a.txt" } },
        { name: "read_file", args: { path: "a.txt" } },
        { name: "write_file", args: { path: "a.txt", content: "x" } },
      ],
    },
    { taskId: "t2", toolNames: [], toolCalls: [] },
  ];
  const metrics = computeProcessMetrics(tasks, results);
  assert.deepEqual(metrics.toolRecall, { expected: 3, hit: 2, rate: 0.667 });
  assert.deepEqual(metrics.redundant, { calls: 3, unique: 2, rate: 0.333 });
});

test("process metrics: 参数正确率按子集匹配", () => {
  const tasks = [
    {
      id: "t1",
      expect: {
        toolArgs: [
          { name: "read_file", args: { path: "a.txt" } },
          { name: "run_command", args: { command: "pnpm test" } },
        ],
      },
    },
  ];
  const results = [
    {
      taskId: "t1",
      toolNames: ["read_file"],
      toolCalls: [{ name: "read_file", args: { path: "a.txt", offset: 1 } }],
    },
  ];
  const metrics = computeProcessMetrics(tasks, results);
  assert.deepEqual(metrics.paramAccuracy, { specs: 2, hit: 1, rate: 0.5 });
});

test("process metrics: 无声明时返回 null 比率，不伪造 0", () => {
  const metrics = computeProcessMetrics(
    [{ id: "t1", expect: {} }],
    [{ taskId: "t1" }],
  );
  assert.equal(metrics.toolRecall.rate, null);
  assert.equal(metrics.redundant.rate, null);
  assert.equal(metrics.paramAccuracy.rate, null);
});

test("process metrics: 多次重复按尝试统计，不因聚合丢失工具信息", () => {
  const tasks = [{ id: "t1", expect: { requiredTools: ["read_file"] } }];
  const results = [
    {
      taskId: "t1",
      toolNames: [],
      attempts: [
        {
          toolNames: ["read_file"],
          toolCalls: [{ name: "read_file", args: { path: "a" } }],
        },
        { toolNames: [], toolCalls: [] },
      ],
    },
  ];
  const metrics = computeProcessMetrics(tasks, results);
  assert.deepEqual(metrics.toolRecall, { expected: 2, hit: 1, rate: 0.5 });
  assert.deepEqual(metrics.redundant, { calls: 1, unique: 1, rate: 0 });
});

test("process metrics: 失败归因按类别聚合", () => {
  const metrics = computeProcessMetrics(
    [{ id: "t1" }, { id: "t2" }],
    [
      { taskId: "t1", failureCategories: ["tool", "model"] },
      { taskId: "t2", failureCategories: ["tool"] },
    ],
  );
  assert.deepEqual(metrics.failureCategories, { tool: 2, model: 1 });
});
