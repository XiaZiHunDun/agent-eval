import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))
const WFXM_ROOT = process.env.WFXM_ROOT ?? "/home/ailearn/projects/WFXM"
const BUTLER_DIR = WFXM_ROOT
const DRIVER =
  process.env.WFXM_EVAL_DRIVER === "pi"
    ? join(BUTLER_DIR, "scripts/eval/run-pi-task.mts")
    : join(BUTLER_DIR, "scripts/eval/run-task.ts")
const RESULT_PREFIX = "__EVAL_RESULT__"

/** WFXM 侧的脚本化 LLM fixture 属于 adapter 私有装配，不进入任务契约。 */
async function loadFixtures(task) {
  const scenarioId = task.runtimeHints?.wfxm?.scenarioId ?? task.id
  // 轨迹/开放任务把 fixture 直接内联在任务里（数据在 WFXM，执行在 agent-eval）。
  const inline = task.runtimeHints?.wfxm?.fixtures
  if (inline) return { scenarioId, fixtures: inline }
  const file = join(ADAPTER_DIR, "fixtures", "wfxm", `${scenarioId}.json`)
  try {
    return { scenarioId, fixtures: JSON.parse(await readFile(file, "utf8")) }
  } catch (err) {
    throw new Error(`读取 fixture 失败 ${file}：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 把 EvalTask 交给 WFXM 侧驱动执行，解析 stdout 末行结果。 */
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
      rejectPromise(new Error(`WFXM 驱动超时（${timeoutMs}ms）`))
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
        rejectPromise(new Error(`WFXM 驱动无结果（exit=${code}）：${stderr.trim().slice(-800)}`))
        return
      }
      const parsed = JSON.parse(line.slice(RESULT_PREFIX.length))
      if (parsed.error) {
        rejectPromise(new Error(`WFXM 驱动失败：${parsed.error}`))
        return
      }
      resolvePromise(parsed)
    })

    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

export default {
  id: "wfxm",
  async run(task, { timeoutMs }) {
    const realModel = process.env.AGENT_EVAL_REAL_MODEL === "1"
    const scenarioId = task.runtimeHints?.wfxm?.scenarioId ?? task.id
    // 真实模型模式不回放 LLM fixture，但仍注入 seedFiles 搭建任务工作区；
    // 没有 fixture 的任务（如 RAG）允许缺失。RAG 额外透传入库文档与检索真值。
    const loaded = realModel
      ? await loadFixtures(task).catch(() => null)
      : await loadFixtures(task)
    const fixtures = realModel
      ? loaded?.fixtures?.seedFiles
        ? { seedFiles: loaded.fixtures.seedFiles }
        : undefined
      : loaded.fixtures
    const rag = task.runtimeHints?.wfxm?.rag
    // 开放任务的产物断言写在 rubric.hard 里，同样需要回读工作区。
    const rubricPaths = (task.rubric?.hard ?? [])
      .filter((rule) => typeof rule.path === "string")
      .map((rule) => rule.path)
    const workspacePaths = [
      ...new Set([
        ...(task.expect?.workspaceState ?? []).map((s) => s.path),
        ...(task.workspacePaths ?? []),
        ...rubricPaths,
      ]),
    ]
    const repoFixture = task.repo?.fixture
      ? resolve(ADAPTER_DIR, "fixtures", "repos", task.repo.fixture)
      : undefined
    const testsRule = (task.rubric?.hard ?? []).find((rule) => rule.type === "tests_passed")
    const testsSpec = task.expect?.tests ?? testsRule
    const tests = testsSpec?.command
      ? {
          command: testsSpec.command,
          ...(testsSpec.timeoutMs ? { timeoutMs: testsSpec.timeoutMs } : {}),
        }
      : undefined
    return runDriver(
      {
        id: task.id,
        turns: task.turns,
        ...(task.messageIds ? { messageIds: task.messageIds } : {}),
        ...(task.budget ? { budget: task.budget } : {}),
        ...(workspacePaths.length > 0 ? { workspacePaths } : {}),
        ...(repoFixture ? { repoFixture } : {}),
        ...(tests ? { tests } : {}),
        ...(realModel ? { realModel: true } : {}),
        runtimeHints: {
          wfxm: { scenarioId, ...(fixtures ? { fixtures } : {}), ...(rag ? { rag } : {}) },
        },
      },
      timeoutMs,
    )
  },
}
