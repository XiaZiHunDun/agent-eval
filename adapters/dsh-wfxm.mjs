import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDshNdjson } from "../src/dsh-ndjson.mjs"

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))
const DSH_ROOT = process.env.DSH_WFXM_ROOT ?? "/home/ailearn/projects/dsh-wfxm"
const DRIVER = join(DSH_ROOT, "scripts", "eval", "run-task.mjs")
const RESULT_PREFIX = "__EVAL_RESULT__"

/** 离线回放：优先任务内联事件，其次 adapters/fixtures/dsh/<id>.json。 */
async function loadFixture(task) {
  const inline = task.runtimeHints?.dsh?.events
  if (inline !== undefined) return { events: inline }
  const file = join(ADAPTER_DIR, "fixtures", "dsh", `${task.id}.json`)
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (err) {
    throw new Error(
      `读取 dsh fixture 失败 ${file}：${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function fixtureToNdjson(fixture) {
  if (typeof fixture.ndjson === "string") return fixture.ndjson
  const events = Array.isArray(fixture.events) ? fixture.events : []
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "")
}

/** 把 EvalTask 交给 dsh-wfxm 薄驱动执行，解析 stdout 末行结果。 */
function runDriver(payload, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [DRIVER], {
      cwd: DSH_ROOT,
      env: { ...process.env, DSH_WFXM_ROOT: DSH_ROOT },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      rejectPromise(new Error(`dsh 驱动超时（${timeoutMs}ms）`))
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(err)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const line = stdout
        .split("\n")
        .reverse()
        .find((candidate) => candidate.startsWith(RESULT_PREFIX))
      if (!line) {
        rejectPromise(new Error(`dsh 驱动无结果（exit=${code}）：${stderr.trim().slice(-800)}`))
        return
      }
      const parsed = JSON.parse(line.slice(RESULT_PREFIX.length))
      if (parsed.error) {
        rejectPromise(new Error(`dsh 驱动失败：${parsed.error}`))
        return
      }
      resolvePromise(parsed)
    })

    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

export default {
  id: "dsh-wfxm",
  async run(task, { runId, timeoutMs }) {
    const realModel = process.env.AGENT_EVAL_REAL_MODEL === "1"
    const prompt = task.turns?.[0]

    if (!realModel) {
      const fixture = await loadFixture(task)
      const { obs } = parseDshNdjson(fixtureToNdjson(fixture), {
        runtime: "dsh-wfxm",
        runId,
        turnIndex: 0,
        prompt,
      })
      return obs
    }

    const result = await runDriver(
      {
        id: task.id,
        turns: task.turns,
        timeoutMs,
        runtimeHints: {
          dsh: task.runtimeHints?.dsh ?? {},
        },
      },
      timeoutMs,
    )
    const { obs } = parseDshNdjson(result.ndjson ?? "", {
      runtime: "dsh-wfxm",
      runId,
      turnIndex: 0,
      prompt,
    })
    return {
      ...obs,
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    }
  },
}
