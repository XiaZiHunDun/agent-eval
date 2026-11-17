import { readFile } from "node:fs/promises"

/**
 * 从任务声明的检索真值取目标文档标题。
 *
 * RAG 真值放在 runtimeHints.wfxm.rag（与入库文档同一装配块），这里是
 * gate 专用指标的唯一读取点；通用 runner / verifier 仍然不读 runtimeHints。
 */
export function expectedDocTitles(task) {
  const titles = task?.runtimeHints?.wfxm?.rag?.expectation?.expectedDocTitles
  return Array.isArray(titles) ? titles.filter((title) => typeof title === "string" && title) : []
}

/** 读取单个 trace 中 document scope 的召回顺序（title 序列）。 */
async function readRetrievedTitles(tracePath) {
  const raw = await readFile(tracePath, "utf8")
  const titles = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== "rag.retrieve") continue
    const payload = event.payload ?? {}
    if (payload.scope !== "document") continue
    for (const hit of payload.hits ?? []) {
      titles.push(typeof hit.title === "string" ? hit.title : "")
    }
  }
  return titles
}

/**
 * 检索层确定性指标：Hit@1 / Hit@3 / MRR / precision@k。
 *
 * 只统计有真值的任务；每个 attempt 的 trace 单独算一行，不做 best-of。
 *
 * @param {readonly object[]} tasks
 * @param {readonly { taskId: string, tracePath?: string, tracePaths?: string[] }[]} results
 */
export async function evaluateRetrieval(tasks, results) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const rows = []

  for (const result of results) {
    const expected = new Set(expectedDocTitles(byId.get(result.taskId)))
    if (expected.size === 0) continue
    const paths = result.tracePaths ?? (result.tracePath ? [result.tracePath] : [])
    for (const path of paths) {
      if (!path) continue
      const titles = await readRetrievedTitles(path)
      const firstIndex = titles.findIndex((title) => expected.has(title))
      const relevant = titles.filter((title) => expected.has(title)).length
      rows.push({
        taskId: result.taskId,
        tracePath: path,
        firstRank: firstIndex >= 0 ? firstIndex + 1 : null,
        relevant,
        returned: titles.length,
      })
    }
  }

  const total = rows.length
  if (total === 0) {
    return {
      casesTotal: 0,
      hitAt1: 0,
      hitAt3: 0,
      mrr: 0,
      precisionAtK: 0,
      misses: [],
      details: rows,
    }
  }

  const hit1 = rows.filter((row) => row.firstRank === 1).length
  const hit3 = rows.filter((row) => row.firstRank !== null && row.firstRank <= 3).length
  const reciprocal = rows.reduce(
    (sum, row) => sum + (row.firstRank === null ? 0 : 1 / row.firstRank),
    0,
  )
  const precision = rows.reduce(
    (sum, row) => sum + (row.returned === 0 ? 0 : row.relevant / row.returned),
    0,
  )

  return {
    casesTotal: total,
    hitAt1: round(hit1 / total),
    hitAt3: round(hit3 / total),
    mrr: round(reciprocal / total),
    precisionAtK: round(precision / total),
    misses: rows.filter((row) => row.firstRank === null).map((row) => row.taskId),
    details: rows,
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000
}
