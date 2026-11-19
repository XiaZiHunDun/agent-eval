import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { validateTrace, writeTraceJsonl } from "./trace.mjs"
import { failureCategories } from "./failures.mjs"
import { verify } from "./verify.mjs"
import { evaluateOpenTask } from "./judge.mjs"

/** 读取目录下所有 *.json 任务，按 id 排序。 */
export async function loadTasks(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort()
  const tasks = []
  for (const name of names) {
    const raw = await readFile(join(dir, name), "utf8")
    const task = JSON.parse(raw)
    for (const key of ["id", "title", "suite", "turns"]) {
      if (!(key in task)) throw new Error(`${name} 缺少字段 ${key}`)
    }
    if (!("expect" in task) && !("rubric" in task)) {
      throw new Error(`${name} 缺少字段 expect 或 rubric`)
    }
    validateAntiCheatFields(task, name)
    tasks.push(task)
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id))
  return tasks
}

/** 防作弊字段的轻量结构校验（JSON Schema 不在这里执行）。 */
function validateAntiCheatFields(task, name) {
  if (task.hiddenChecks !== undefined) {
    if (!Array.isArray(task.hiddenChecks)) throw new Error(`${name} hiddenChecks 必须是数组`)
    const allowed = new Set([
      "file_exists",
      "file_absent",
      "file_equals",
      "file_contains",
      "file_matches",
    ])
    for (const [i, rule] of task.hiddenChecks.entries()) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
        throw new Error(`${name} hiddenChecks[${i}] 必须是对象`)
      }
      if (!allowed.has(rule.type)) throw new Error(`${name} hiddenChecks[${i}] 类型未知`)
      if (typeof rule.path !== "string" || rule.path.length === 0) {
        throw new Error(`${name} hiddenChecks[${i}] 缺少 path`)
      }
    }
  }
  if (task.tamperPolicy !== undefined) {
    const policy = task.tamperPolicy
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      throw new Error(`${name} tamperPolicy 必须是对象`)
    }
    for (const key of ["allowed", "forbidden"]) {
      if (policy[key] !== undefined && !Array.isArray(policy[key])) {
        throw new Error(`${name} tamperPolicy.${key} 必须是数组`)
      }
    }
  }
  const detector = task.expect?.detector
  if (detector !== undefined) {
    if (!detector || typeof detector !== "object" || Array.isArray(detector)) {
      throw new Error(`${name} expect.detector 必须是对象`)
    }
    if (!detector.check && !detector.prefix && !detector.category) {
      throw new Error(`${name} expect.detector 需要 check / prefix / category 之一`)
    }
  }
}

/** 任务元信息，单次运行与聚合结果共用。 */
function taskMeta(task) {
  return {
    ...(task.taxonomy ? { taxonomy: task.taxonomy } : {}),
    ...(task.difficulty ? { difficulty: task.difficulty } : {}),
    ...(task.source ? { source: task.source } : {}),
    ...(task.split ? { split: task.split } : {}),
  }
}

const OBSERVATION_FIELDS = [
  "reply",
  "replies",
  "finalDecision",
  "turns",
  "model",
  "tests",
  "toolNames",
  "toolCalls",
  "costUsd",
  "workspaceChanges",
  "baselineHash",
  "workspaceHash",
]

/**
 * 单次尝试的执行结果。
 *
 * @param {{ task: object, runtime: string, obs?: object, verdict: object, traceProblems: string[], durationMs: number, index: number }} args
 */
function buildMetrics(obs, trace) {
  const toolCallsByName = {}
  for (const name of obs?.toolNames ?? []) {
    toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1
  }
  const approvals = trace.filter((event) => event?.type === "approval.request").length
  return {
    toolCallsByName,
    approvals,
    ...(obs?.model ? { tokens: { ...obs.model } } : {}),
    ...(obs?.diff ? { diff: obs.diff } : {}),
  }
}

function buildAttempt({ task, runtime, obs, verdict, traceProblems, durationMs, index }) {
  const failures = [
    ...verdict.failures,
    ...traceProblems.map((p) => ({ check: "trace.invalid", detail: p })),
  ]
  return {
    index,
    taskId: task.id,
    runtime,
    ...taskMeta(task),
    passed: verdict.passed && failures.length === 0,
    score: verdict.score,
    steps: obs?.steps ?? 0,
    ...(obs?.costUsd !== undefined ? { costUsd: obs.costUsd } : {}),
    durationMs,
    metrics: buildMetrics(obs, obs?.trace ?? []),
    ...(failures.length > 0 ? { failureCategories: failureCategories(failures) } : {}),
    ...(obs?.reply !== undefined ? { reply: obs.reply } : {}),
    ...(obs?.replies !== undefined ? { replies: obs.replies } : {}),
    ...(obs?.finalDecision !== undefined ? { finalDecision: obs.finalDecision } : {}),
    ...(obs?.turns !== undefined ? { turns: obs.turns } : {}),
    ...(obs?.toolNames !== undefined ? { toolNames: obs.toolNames } : {}),
    ...(obs?.toolCalls !== undefined ? { toolCalls: obs.toolCalls } : {}),
    ...(obs?.model !== undefined ? { model: obs.model } : {}),
    ...(obs?.tests !== undefined ? { tests: obs.tests } : {}),
    ...(obs?.workspaceChanges !== undefined ? { workspaceChanges: obs.workspaceChanges } : {}),
    ...(obs?.baselineHash !== undefined ? { baselineHash: obs.baselineHash } : {}),
    ...(obs?.workspaceHash !== undefined ? { workspaceHash: obs.workspaceHash } : {}),
    failures,
  }
}

/**
 * 把同一任务的多次尝试聚合成一条结果。
 *
 * `passed` 要求全部尝试通过；`passRate` 是尝试级通过率，供 gate 计算，
 * 不做 best-of，避免靠多跑几次刷分。
 */
/** 把多次 attempt 的执行矩阵合并成任务级汇总（计数求和，diff 取均值）。 */
function aggregateMetrics(attempts) {
  const toolCallsByName = {}
  let approvals = 0
  const tokens = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let hasTokens = false
  const diff = { filesChanged: 0, added: 0, removed: 0 }
  let hasDiff = false

  for (const attempt of attempts) {
    const metrics = attempt.metrics ?? {}
    for (const [name, count] of Object.entries(metrics.toolCallsByName ?? {})) {
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + count
    }
    approvals += metrics.approvals ?? 0
    if (metrics.tokens) {
      hasTokens = true
      tokens.calls += metrics.tokens.calls ?? 0
      tokens.inputTokens += metrics.tokens.inputTokens ?? 0
      tokens.outputTokens += metrics.tokens.outputTokens ?? 0
      tokens.totalTokens += metrics.tokens.totalTokens ?? 0
    }
    if (metrics.diff) {
      hasDiff = true
      diff.filesChanged += metrics.diff.filesChanged ?? 0
      diff.added += metrics.diff.added ?? 0
      diff.removed += metrics.diff.removed ?? 0
    }
  }

  return {
    toolCallsByName,
    approvals,
    ...(hasTokens ? { tokens } : {}),
    ...(hasDiff
      ? {
          diff: {
            filesChanged: Math.round(diff.filesChanged / attempts.length),
            added: Math.round(diff.added / attempts.length),
            removed: Math.round(diff.removed / attempts.length),
          },
        }
      : {}),
  }
}

function aggregateAttempts({ task, runtime, attempts }) {
  const total = attempts.length
  const passedCount = attempts.filter((a) => a.passed).length
  const mean = (key) => attempts.reduce((sum, a) => sum + (a[key] ?? 0), 0) / total
  const first = attempts[0]
  const categories = [...new Set(attempts.flatMap((attempt) => attempt.failureCategories ?? []))]

  const result = {
    taskId: task.id,
    runtime,
    ...taskMeta(task),
    passed: passedCount === total,
    passRate: round(passedCount / total),
    attemptsPassed: passedCount,
    attemptsTotal: total,
    score: round(mean("score")),
    steps: Math.round(mean("steps")),
    ...(attempts.some((a) => a.costUsd !== undefined) ? { costUsd: round(mean("costUsd")) } : {}),
    durationMs: Math.round(mean("durationMs")),
    metrics: aggregateMetrics(attempts),
    ...(categories.length > 0 ? { failureCategories: categories } : {}),
    failures:
      total === 1
        ? first.failures
        : attempts
            .filter((a) => !a.passed)
            .flatMap((a) =>
              a.failures.map((f) => ({ check: `attempt${a.index}.${f.check}`, detail: f.detail })),
            ),
    ...(total === 1
      ? { tracePath: first.tracePath }
      : { tracePaths: attempts.map((a) => a.tracePath).filter(Boolean) }),
    attempts: attempts.map((a) => ({
      index: a.index,
      passed: a.passed,
      score: a.score,
      steps: a.steps,
      durationMs: a.durationMs,
      failures: a.failures,
      tracePath: a.tracePath,
    })),
  }

  if (total === 1) {
    for (const key of OBSERVATION_FIELDS) {
      if (key in first) result[key] = first[key]
    }
  }
  return result
}

/**
 * 顺序执行任务集。每个任务独立目录，产出 trace.jsonl + result.json。
 *
 * `repeats > 1` 时每条任务跑 N 次，写入 `attempt-<n>/` 子目录，
 * 任务目录下的 result.json 是聚合结果（含 attempts 明细）。
 *
 * @param {object} args
 * @param {{ id: string, run: (task: object, opts: object) => Promise<object> }} args.adapter
 * @param {readonly object[]} args.tasks
 * @param {string} args.runDir
 * @param {string} args.runId
 * @param {number} [args.repeats]
 * @param {(msg: string) => void} [args.log]
 */
export async function runSuite({ adapter, tasks, runDir, runId, repeats = 1, log = () => {} }) {
  await mkdir(runDir, { recursive: true })
  const repeatCount = Math.max(1, Math.trunc(repeats) || 1)
  const results = []

  for (const task of tasks) {
    const taskDir = join(runDir, task.id)
    await mkdir(taskDir, { recursive: true })
    const attempts = []

    for (let index = 1; index <= repeatCount; index += 1) {
      const attemptDir = repeatCount === 1 ? taskDir : join(taskDir, `attempt-${index}`)
      if (repeatCount > 1) await mkdir(attemptDir, { recursive: true })
      const label = repeatCount > 1 ? `▶ ${task.id} (${index}/${repeatCount}) — ${task.title}` : `▶ ${task.id} — ${task.title}`
      log(label)
      const startedAt = Date.now()

      /** @type {object | undefined} */
      let obs
      let crash
      try {
        obs = await adapter.run(task, { runId, timeoutMs: task.timeoutMs ?? 180_000 })
      } catch (err) {
        crash = err instanceof Error ? err.message : String(err)
      }

      const durationMs = Date.now() - startedAt
      const trace = obs?.trace ?? []
      const traceProblems = obs ? validateTrace(trace) : []
      const verdict = obs
        ? task.suite === "butler-open"
          ? await evaluateOpenTask(task, obs)
          : verify(task, obs)
        : { passed: false, score: 0, checks: [], failures: [{ check: "adapter.run", detail: crash ?? "unknown" }] }

      const tracePath = obs ? join(attemptDir, "trace.jsonl") : ""
      if (obs) await writeTraceJsonl(tracePath, trace)

      const attempt = {
        ...buildAttempt({ task, runtime: adapter.id, obs, verdict, traceProblems, durationMs, index }),
        tracePath,
      }
      if (repeatCount > 1) {
        await writeFile(join(attemptDir, "result.json"), JSON.stringify(attempt, null, 2) + "\n", "utf8")
      }
      attempts.push(attempt)
      if (repeatCount > 1) {
        log(`  #${index} ${attempt.passed ? "PASS" : "FAIL"} score=${attempt.score} steps=${attempt.steps} ${durationMs}ms`)
      }
    }

    const result = aggregateAttempts({ task, runtime: adapter.id, attempts })
    await writeFile(join(taskDir, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8")
    results.push(result)
    const rate = result.attemptsTotal > 1 ? ` passRate=${result.passRate}` : ""
    log(`  ${result.passed ? "PASS" : "FAIL"}${rate} score=${result.score} steps=${result.steps} ${result.durationMs}ms`)
  }

  const attemptsTotal = results.reduce((sum, r) => sum + r.attemptsTotal, 0)
  const attemptsPassed = results.reduce((sum, r) => sum + r.attemptsPassed, 0)
  const passRate = results.length === 0 ? 0 : results.reduce((sum, r) => sum + r.passRate, 0) / results.length
  const flaky = results
    .filter((r) => r.passRate > 0 && r.passRate < 1)
    .map((r) => ({
      taskId: r.taskId,
      passRate: r.passRate,
      attemptsPassed: r.attemptsPassed,
      attemptsTotal: r.attemptsTotal,
    }))

  return {
    runId,
    runtime: adapter.id,
    repeats: repeatCount,
    results,
    attemptsTotal,
    attemptsPassed,
    passRate: round(passRate),
    flaky,
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000
}
