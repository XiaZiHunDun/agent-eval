import { spawn, spawnSync } from "node:child_process"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDshNdjson } from "../src/dsh-ndjson.mjs"
import { createTrace } from "../src/trace.mjs"

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url))
const DSH_ROOT = process.env.DSH_WFXM_ROOT ?? "/home/ailearn/projects/dsh-wfxm"
const DRIVER = join(DSH_ROOT, "scripts", "eval", "run-task.mjs")
const REPO_FIXTURES = join(ADAPTER_DIR, "fixtures", "repos")
const RESULT_PREFIX = "__EVAL_RESULT__"

/** 离线回放：内联事件 > trace 文件 > 按任务 id 的 fixture。 */
async function loadFixture(task) {
  const hints = task.runtimeHints?.dsh ?? {}
  if (hints.events !== undefined) return { events: hints.events }
  if (hints.traceFile !== undefined) {
    // 离线回放必须自带夹具，PR 只 checkout agent-eval 也能跑；本仓缺失时回落到 dsh-wfxm。
    const local = join(ADAPTER_DIR, "fixtures", "dsh", hints.traceFile)
    try {
      return { ndjson: await readFile(local, "utf8") }
    } catch {
      return { ndjson: await readFile(join(DSH_ROOT, hints.traceFile), "utf8") }
    }
  }
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

/** 多轮：每轮 NDJSON 独立解析，再合并成一条 trace 与一份 observation。 */
export function mergeTurns(parsedTurns, { runtime, runId }) {
  const trace = createTrace({ runtime, runId })
  trace.emit("run.start", {})
  const toolCalls = []
  const toolResults = []
  const replies = []
  const model = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let steps = 0
  let costUsd = 0

  for (const [index, parsed] of parsedTurns.entries()) {
    trace.emit("turn.start", { turnIndex: index })
    for (const event of parsed.trace) {
      if (
        event.type === "run.start" ||
        event.type === "run.end" ||
        event.type === "turn.start" ||
        event.type === "turn.end"
      ) {
        continue
      }
      trace.emit(event.type, event.payload ?? {}, {
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.actor ? { actor: event.actor } : {}),
      })
    }
    steps += parsed.obs.steps ?? 0
    model.calls += parsed.obs.model?.calls ?? 0
    model.inputTokens += parsed.obs.model?.inputTokens ?? 0
    model.outputTokens += parsed.obs.model?.outputTokens ?? 0
    model.totalTokens += parsed.obs.model?.totalTokens ?? 0
    costUsd += parsed.obs.costUsd ?? 0
    if (parsed.obs.toolCalls) toolCalls.push(...parsed.obs.toolCalls)
    if (parsed.obs.toolResults) toolResults.push(...parsed.obs.toolResults)
    replies.push(parsed.obs.reply ?? "")
    trace.emit("turn.end", { text: parsed.obs.reply ?? "" })
  }
  trace.emit("run.end", { status: "ok" })

  return {
    reply: replies.at(-1) ?? "",
    replies,
    toolNames: toolCalls.map((call) => call.name),
    toolCalls,
    ...(toolResults.length > 0 ? { toolResults } : {}),
    steps,
    turns: parsedTurns.length,
    model,
    ...(costUsd > 0 ? { costUsd: Number(costUsd.toFixed(6)) } : {}),
    trace: trace.events,
  }
}

export function parseTap(stdout) {
  const results = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(not ok|ok)\s+\d+\s+-\s+(.*?)(?:\s+#.*)?$/.exec(line)
    if (match) results.push({ name: match[2].trim(), ok: match[1] === "ok" })
  }
  return results
}

function runTests(cwd, tests) {
  if (!tests) return undefined
  const run = spawnSync("sh", ["-c", tests.command], {
    cwd,
    encoding: "utf8",
    timeout: tests.timeoutMs ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    command: tests.command,
    exitCode: run.status ?? 1,
    passed: run.status === 0,
    results: parseTap(run.stdout ?? ""),
  }
}

function git(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
}

function parseNumstat(output) {
  const changes = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim())
    if (!match) continue
    changes.push({
      path: match[3],
      added: match[1] === "-" ? 0 : Number(match[1]),
      removed: match[2] === "-" ? 0 : Number(match[2]),
    })
  }
  return changes
}

async function snapshotWorkspace(root, paths) {
  const workspace = {}
  for (const path of paths) {
    try {
      workspace[path] = await readFile(join(root, path), "utf8")
    } catch {
      // 文件不存在时由 verify 按「不存在」处理。
    }
  }
  return workspace
}

function workspacePathsOf(task) {
  return [
    ...(task.workspacePaths ?? []),
    ...(task.expect?.workspaceState ?? []).map((spec) => spec.path),
    ...(task.hiddenChecks ?? []).map((rule) => rule.path),
  ].filter((path) => typeof path === "string" && !path.startsWith("/") && !path.includes(".."))
}

/** 仓库任务：复制夹具到临时目录 → 基线测试 → 真实 dsh → 终态测试与改动快照。 */
async function runRepoTask(task, { runId, timeoutMs }) {
  if (!process.env.AGENT_EVAL_REAL_MODEL) {
    throw new Error("repo-task 需要真实模型（AGENT_EVAL_REAL_MODEL=1）")
  }
  const fixtureName = task.repo?.fixture
  if (!fixtureName || fixtureName.includes("..") || fixtureName.startsWith("/")) {
    throw new Error(`非法 repo.fixture：${String(fixtureName)}`)
  }
  const fixture = join(REPO_FIXTURES, fixtureName)
  const work = await mkdtemp(join(tmpdir(), "dsh-eval-repo-"))
  try {
    await cp(fixture, work, { recursive: true })
    git(work, ["init"])
    git(work, ["-c", "user.email=eval@local", "-c", "user.name=eval", "add", "-A"])
    git(work, [
      "-c",
      "user.email=eval@local",
      "-c",
      "user.name=eval",
      "commit",
      "-m",
      "baseline",
    ])

    const before = runTests(work, task.expect?.tests)
    const result = await runDriver(
      {
        id: task.id,
        turns: task.turns,
        timeoutMs,
        runtimeHints: {
          dsh: { ...(task.runtimeHints?.dsh ?? {}), cwd: work },
        },
      },
      timeoutMs,
    )

    const parsedTurns = (result.turns ?? []).map((turn, index) =>
      parseDshNdjson(turn.ndjson ?? "", {
        runtime: "dsh-wfxm",
        runId,
        turnIndex: index,
        prompt: task.turns?.[index],
      }),
    )
    const obs =
      parsedTurns.length > 1
        ? mergeTurns(parsedTurns, { runtime: "dsh-wfxm", runId })
        : (parsedTurns[0]?.obs ??
          parseDshNdjson(result.ndjson ?? "", { runtime: "dsh-wfxm", runId }).obs)

    git(work, ["add", "-A"])
    const numstat = git(work, ["diff", "--cached", "--numstat"])
    const after = runTests(work, task.expect?.tests)
    const workspace = await snapshotWorkspace(work, workspacePathsOf(task))

    return {
      ...obs,
      ...(before ? { tests: { before, after } } : {}),
      workspaceChanges: parseNumstat(numstat.stdout ?? ""),
      workspace,
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export default {
  id: "dsh-wfxm",
  async run(task, { runId, timeoutMs }) {
    if (task.kind === "repo-task") return runRepoTask(task, { runId, timeoutMs })

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

    const parsedTurns = (result.turns ?? []).map((turn, index) =>
      parseDshNdjson(turn.ndjson ?? "", {
        runtime: "dsh-wfxm",
        runId,
        turnIndex: index,
        prompt: task.turns?.[index],
      }),
    )
    const obs =
      parsedTurns.length > 1
        ? mergeTurns(parsedTurns, { runtime: "dsh-wfxm", runId })
        : (parsedTurns[0]?.obs ??
          parseDshNdjson(result.ndjson ?? "", { runtime: "dsh-wfxm", runId, prompt }).obs)

    return {
      ...obs,
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    }
  },
}
