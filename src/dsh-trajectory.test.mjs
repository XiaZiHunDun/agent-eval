/**
 * P2-5：生产脱敏轨迹目录的加载规则。
 *
 * 目录有效且非空时整体替换内置种子；未设置、不存在或为空时返回 null，
 * 让 PR CI 继续使用仓库内 fixture。
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { loadDshTrajectoryTasks } from "./trajectory.mjs"

function task(id) {
  return {
    id,
    title: `生产轨迹 ${id}`,
    suite: "dsh-trajectory",
    turns: ["（生产轨迹回放）"],
    expect: { requiredTools: ["svc_list"] },
    runtimeHints: { dsh: { traceFile: `eval/trajectory/${id}.ndjson` } },
  }
}

test("未设置或空字符串时返回 null", async () => {
  const saved = process.env.DSH_EVAL_TRAJECTORY_DIR
  delete process.env.DSH_EVAL_TRAJECTORY_DIR
  try {
    assert.equal(await loadDshTrajectoryTasks(""), null)
    assert.equal(await loadDshTrajectoryTasks(undefined), null)
  } finally {
    if (saved !== undefined) process.env.DSH_EVAL_TRAJECTORY_DIR = saved
  }
})

test("目录不存在或为空时返回 null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-trajectory-"))
  try {
    assert.equal(await loadDshTrajectoryTasks(join(dir, "missing")), null)
    assert.equal(await loadDshTrajectoryTasks(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("目录有任务时整体替换", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-trajectory-"))
  try {
    writeFileSync(join(dir, "dsh-prod-b.json"), JSON.stringify(task("dsh-prod-b")))
    writeFileSync(join(dir, "dsh-prod-a.json"), JSON.stringify(task("dsh-prod-a")))
    const tasks = await loadDshTrajectoryTasks(dir)
    assert.deepEqual(tasks.map((item) => item.id), ["dsh-prod-a", "dsh-prod-b"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
