import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { collectRunConfig, modelsFromEvents } from "./config.mjs"

test("config: 从 model.request 提取模型名并去重", () => {
  const models = modelsFromEvents([
    { type: "model.request", payload: { model: "MiniMax-M3.1" } },
    { type: "model.request", payload: { model: "MiniMax-M3.1" } },
    { type: "model.request", payload: { model: "deepseek-chat" } },
    { type: "model.request", payload: {} },
    { type: "run.start", payload: { model: "real" } },
  ])
  assert.deepEqual(models, ["MiniMax-M3.1", "deepseek-chat"])
})

test("config: 汇总 fixture 模式、模型与 embedding 配置", async () => {
  const dir = join(tmpdir(), `eval-config-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  const tracePath = join(dir, "trace.jsonl")
  await writeFile(
    tracePath,
    [
      JSON.stringify({ type: "model.request", payload: { model: "test-model" } }),
      JSON.stringify({ type: "run.end", payload: {} }),
    ].join("\n") + "\n",
    "utf8",
  )

  const previousKey = process.env.DASHSCOPE_API_KEY
  const previousRoot = process.env.WFXM_ROOT
  const previousTemperature = process.env.BUTLER_MODEL_TEMPERATURE
  process.env.DASHSCOPE_API_KEY = "test-key"
  process.env.WFXM_ROOT = join(dir, "missing-root")
  delete process.env.BUTLER_MODEL_TEMPERATURE
  try {
    const config = await collectRunConfig({
      results: [{ taskId: "t1", tracePath }],
      real: false,
    })
    assert.equal(config.contractVersion, "eval-task/v0")
    assert.equal(config.fixtureMode, true)
    assert.deepEqual(config.models, ["test-model"])
    assert.equal(config.temperature, null)
    assert.equal(config.retrievalEmbedding, "dashscope:text-embedding-v3")
    assert.equal(config.runtimeGitSha, null)
    assert.equal(config.runtimeGitDirty, null)
  } finally {
    if (previousKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousKey
    if (previousRoot === undefined) delete process.env.WFXM_ROOT
    else process.env.WFXM_ROOT = previousRoot
    if (previousTemperature === undefined) delete process.env.BUTLER_MODEL_TEMPERATURE
    else process.env.BUTLER_MODEL_TEMPERATURE = previousTemperature
  }
})

test("config: 记录评测固定温度", async () => {
  const previous = process.env.BUTLER_MODEL_TEMPERATURE
  process.env.BUTLER_MODEL_TEMPERATURE = "0"
  try {
    const config = await collectRunConfig({ results: [], real: true })
    assert.equal(config.temperature, 0)
    assert.match(config.temperatureNote, /BUTLER_MODEL_TEMPERATURE/)
  } finally {
    if (previous === undefined) delete process.env.BUTLER_MODEL_TEMPERATURE
    else process.env.BUTLER_MODEL_TEMPERATURE = previous
  }
})
