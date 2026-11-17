import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** 任务契约版本；任务 JSON 结构变化时递增。 */
export const SUITE_CONTRACT_VERSION = "eval-task/v0"

/** 从 trace 事件里取实际调用过的模型名（去重、排序）。 */
export function modelsFromEvents(events) {
  const models = new Set()
  for (const event of events) {
    if (event?.type !== "model.request") continue
    const model = event.payload?.model
    if (typeof model === "string" && model.trim()) models.add(model.trim())
  }
  return [...models].sort()
}

async function readTraceModels(tracePath) {
  try {
    const raw = await readFile(tracePath, "utf8")
    const events = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    return modelsFromEvents(events)
  } catch {
    return []
  }
}

function gitState() {
  const root = process.env.WFXM_ROOT ?? "/home/ailearn/projects/WFXM"
  const cwd = join(root, "butler-v5")
  try {
    const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const dirty =
      execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length > 0
    return { sha, dirty }
  } catch {
    return { sha: null, dirty: null }
  }
}

/**
 * 冻结一次运行的可复现配置，写入 summary.json / gate.json。
 *
 * temperature 为 null 表示 runtime 未显式设置（当前生产 wiring 确实没设），
 * 不是“没记录”；用 temperatureNote 把语义写清楚，避免读者误判。
 */
export async function collectRunConfig({ results, real }) {
  const models = new Set()
  for (const result of results) {
    const paths = result.tracePaths ?? (result.tracePath ? [result.tracePath] : [])
    for (const path of paths) {
      if (!path) continue
      for (const model of await readTraceModels(path)) models.add(model)
    }
  }

  const embeddingKey = (process.env.DASHSCOPE_API_KEY ?? "").trim()
  const git = gitState()
  const rawTemperature = (process.env.BUTLER_MODEL_TEMPERATURE ?? "").trim()
  const parsedTemperature = rawTemperature ? Number(rawTemperature) : null
  const temperature = Number.isFinite(parsedTemperature) ? parsedTemperature : null
  return {
    contractVersion: SUITE_CONTRACT_VERSION,
    fixtureMode: !real,
    models: [...models].sort(),
    temperature,
    temperatureNote:
      temperature === null
        ? "runtime 未显式设置，使用 provider 默认值"
        : "评测固定采样温度（BUTLER_MODEL_TEMPERATURE）",
    retrievalEmbedding: embeddingKey ? "dashscope:text-embedding-v3" : null,
    runtimeGitSha: git.sha,
    runtimeGitDirty: git.dirty,
  }
}
