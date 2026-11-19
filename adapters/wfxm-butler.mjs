import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))
const WFXM_ROOT = process.env.WFXM_ROOT ?? "/home/ailearn/projects/WFXM"
const BUTLER_DIR = WFXM_ROOT
const DRIVER = join(BUTLER_DIR, "scripts/eval/run-butler.mts")
const RESULT_PREFIX = "__EVAL_RESULT__"

async function loadFixtures(task) {
  const scenarioId = task.runtimeHints?.wfxm?.scenarioId
  if (!scenarioId) throw new Error(`任务 ${task.id} 缺少 runtimeHints.wfxm.scenarioId`)
  const file = join(ADAPTER_DIR, "fixtures", "wfxm-butler", "cases.json")
  try {
    const cases = JSON.parse(await readFile(file, "utf8"))
    const fixtures = cases[scenarioId]
    if (!fixtures) throw new Error(`没有场景 ${scenarioId}`)
    return fixtures
  } catch (err) {
    throw new Error(
      `读取 fixture 失败 ${file}#${scenarioId}：${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function runDriver(payload, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("pnpm", ["exec", "tsx", DRIVER], {
      cwd: BUTLER_DIR,
      env: { ...process.env, VITEST: "true", NODE_ENV: "test" },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      rejectPromise(new Error(`WFXM butler 驱动超时（${timeoutMs}ms）`))
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
        .find((l) => l.startsWith(RESULT_PREFIX))
      if (!line) {
        rejectPromise(new Error(`WFXM butler 驱动无结果（exit=${code}）：${stderr.trim().slice(-800)}`))
        return
      }
      const parsed = JSON.parse(line.slice(RESULT_PREFIX.length))
      if (parsed.error) {
        rejectPromise(new Error(`WFXM butler 驱动失败：${parsed.error}`))
        return
      }
      resolvePromise(parsed)
    })

    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

export default {
  id: "wfxm-butler",
  async run(task, { timeoutMs }) {
    const fixtures = await loadFixtures(task)
    return runDriver(
      {
        id: task.id,
        turns: task.turns,
        runtimeHints: {
          wfxm: {
            scenarioId: task.runtimeHints.wfxm.scenarioId,
            fixtures,
          },
        },
      },
      timeoutMs,
    )
  },
}
