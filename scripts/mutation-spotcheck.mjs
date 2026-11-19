#!/usr/bin/env node
/**
 * 变异抽查：把 golden bug 任务里“修复后写入的内容”替换回种子中的缺陷版本，
 * 任务必须失败。用来证明断言真的能抓住回归，而不是恒为真。
 *
 * 一次性检查，不进 CI；默认跑全部 golden-bug 任务，可用 MUTATION_LIMIT 限制。
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import adapter from "../adapters/wfxm.mjs"
import { loadTasks, runSuite } from "../src/runner.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** 把 plan 中写文件的内容替换成同路径的种子内容（即缺陷版本）。 */
function mutate(task) {
  const fixtures = task.runtimeHints?.wfxm?.fixtures
  const seeds = new Map((fixtures?.seedFiles ?? []).map((seed) => [seed.path, seed.content]))
  let mutated = false
  for (const entry of fixtures?.plan ?? []) {
    for (const call of entry.toolCalls ?? []) {
      if (call.name !== "write_file") continue
      const path = call.args?.path
      if (typeof path !== "string" || !seeds.has(path)) continue
      call.args = { ...call.args, content: seeds.get(path) }
      mutated = true
    }
  }
  return mutated
}

const all = await loadTasks(join(ROOT, "tasks", "golden"))
const targets = all.filter((task) => task.id.startsWith("golden-bug-"))
const rawLimit = Number(process.env.MUTATION_LIMIT ?? targets.length)
const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : targets.length
const selected = targets.slice(0, limit)
if (selected.length === 0) {
  console.error("没有可变异的任务")
  process.exit(2)
}

let missed = 0
for (const original of selected) {
  const task = structuredClone(original)
  if (!mutate(task)) {
    console.log(`? ${task.id} 无法定位写入内容，跳过`)
    continue
  }
  const runDir = await mkdtemp(join(tmpdir(), "eval-mutation-"))
  try {
    const suite = await runSuite({
      adapter,
      tasks: [task],
      runDir,
      runId: `mutation-${task.id}`,
      log: () => {},
    })
    const result = suite.results[0]
    if (result?.passed) {
      missed += 1
      console.log(`✗ ${task.id} 未被抓住（score=${result.score}）`)
      for (const failure of result.failures ?? []) console.log(`    ${failure.check}: ${failure.detail}`)
      continue
    }
    const checks = (result?.failures ?? [])
      .map((failure) => failure.check)
      .slice(0, 3)
      .join(", ")
    console.log(`✓ ${task.id} 已抓住${checks ? `（${checks}）` : ""}`)
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
}

console.log(`\n${selected.length - missed}/${selected.length} 个变异被抓住`)
process.exit(missed === 0 ? 0 : 1)
