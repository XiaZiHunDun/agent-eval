import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { evaluateRetrieval, expectedDocTitles } from "./rag.mjs"

function task(id, titles) {
  return {
    id,
    runtimeHints: { wfxm: { rag: { expectation: { expectedDocTitles: titles } } } },
  }
}

async function writeTrace(dir, id, events) {
  const path = join(dir, `${id}.trace.jsonl`)
  await writeFile(
    path,
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  )
  return path
}

test("rag: 只读 document scope，并按首个相关文档计算 Hit/MRR", async () => {
  const dir = join(tmpdir(), `rag-metrics-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  const trace = await writeTrace(dir, "t1", [
    {
      type: "rag.retrieve",
      payload: {
        scope: "project_knowledge",
        hits: [{ title: "无关知识" }],
      },
    },
    {
      type: "rag.retrieve",
      payload: {
        scope: "document",
        hits: [{ title: "干扰文档" }, { title: "目标文档" }],
      },
    },
  ])

  const metrics = await evaluateRetrieval(
    [task("t1", ["目标文档"])],
    [{ taskId: "t1", tracePath: trace }],
  )

  assert.equal(metrics.casesTotal, 1)
  assert.equal(metrics.hitAt1, 0)
  assert.equal(metrics.hitAt3, 1)
  assert.equal(metrics.mrr, 0.5)
  assert.equal(metrics.precisionAtK, 0.5)
  assert.deepEqual(metrics.misses, [])
})

test("rag: 每个 attempt 单独统计，完全未命中进入 misses", async () => {
  const dir = join(tmpdir(), `rag-metrics-${Date.now()}-2`)
  await mkdir(dir, { recursive: true })
  const hit = await writeTrace(dir, "hit", [
    { type: "rag.retrieve", payload: { scope: "document", hits: [{ title: "目标文档" }] } },
  ])
  const miss = await writeTrace(dir, "miss", [
    { type: "rag.retrieve", payload: { scope: "document", hits: [{ title: "别的文档" }] } },
  ])

  const metrics = await evaluateRetrieval(
    [task("t1", ["目标文档"])],
    [{ taskId: "t1", tracePaths: [hit, miss] }],
  )

  assert.equal(metrics.casesTotal, 2)
  assert.equal(metrics.hitAt1, 0.5)
  assert.equal(metrics.hitAt3, 0.5)
  assert.deepEqual(metrics.misses, ["t1"])
})

test("rag: 无真值的任务不进入统计", async () => {
  const dir = join(tmpdir(), `rag-metrics-${Date.now()}-3`)
  await mkdir(dir, { recursive: true })
  const trace = await writeTrace(dir, "plain", [])
  const metrics = await evaluateRetrieval([{ id: "plain" }], [{ taskId: "plain", tracePath: trace }])
  assert.equal(metrics.casesTotal, 0)
  assert.deepEqual(expectedDocTitles({}), [])
})
