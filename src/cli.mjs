#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { collectRunConfig } from "./config.mjs"
import { loadTasks, runSuite } from "./runner.mjs"
import { renderReport } from "./report.mjs"
import {
  DEFAULT_MIN_RAG_HIT_AT3,
  DEFAULT_MIN_RAG_MRR,
  evaluateGate,
} from "./gate.mjs"
import { evaluateRetrieval } from "./rag.mjs"
import {
  DEFAULT_ANNOTATION_QUEUE,
  buildLangfuseBatch,
  enqueueAnnotationTrace,
  ensureAnnotationQueue,
  langfuseConfigFromEnv,
  langfuseEnabled,
  pushLangfuseBatch,
} from "./langfuse.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const ADAPTERS = {
  wfxm: () => import("../adapters/wfxm.mjs"),
}

const USAGE = [
  "用法：",
  "  node src/cli.mjs run --suite <baseline|repo|capability|heldout|rag> [--runtime wfxm] [--task <id>] [--out <dir>] [--repeats N] [--real]",
  "  node src/cli.mjs gate [--with-capability --with-rag --real] [--repeats N] [--min-capability 0.8] [--min-rag 0.9] [--max-flaky 0.2] [--out <dir>]",
  "环境变量：AGENT_EVAL_LANGFUSE=1 导出 Langfuse batch（无凭证时写 langfuse.json dry-run）",
].join("\n")

const MODEL_KEYS = [
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "DASHSCOPE_API_KEY",
]

/**
 * 把每个任务的 trace 映射为 Langfuse batch。
 *
 * - `AGENT_EVAL_LANGFUSE=1` 时启用；
 * - 无论是否有凭证都会写 `langfuse.json`（dry-run，便于 CI 检查）；
 * - 凭证齐全才推送，失败只告警，不影响 gate 判定。
 *
 * @param {{ results: readonly { taskId: string, tracePath?: string }[], log: (msg: string) => void }} args
 */
async function exportLangfuse({ results, log }) {
  if (!langfuseEnabled()) return
  const config = langfuseConfigFromEnv()
  /** @type {{ taskId: string, traceId: string }[]} */
  const failures = []
  for (const result of results) {
    const tracePaths = result.tracePaths ?? (result.tracePath ? [result.tracePath] : [])
    for (const [attemptIndex, tracePath] of tracePaths.entries()) {
      const raw = await readFile(tracePath, "utf8")
      const events = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const batch = buildLangfuseBatch(events, { sessionId: result.taskId })
      const outPath = join(dirname(tracePath), "langfuse.json")
      await writeFile(outPath, JSON.stringify({ batch }, null, 2) + "\n", "utf8")
      if (!config) {
        log(`  langfuse dry-run ${result.taskId} → ${outPath}`)
        continue
      }
      try {
        await pushLangfuseBatch(batch, config)
        log(`  langfuse ↑ ${result.taskId} (${batch.length} events)`)
      } catch (err) {
        log(`  langfuse ✗ ${result.taskId}: ${err instanceof Error ? err.message : String(err)}`)
      }
      const attempt = result.attempts?.[attemptIndex]
      const passed = attempt?.passed ?? result.passed
      const traceId = events.find((event) => event.type === "run.start")?.traceId ?? events[0]?.traceId
      if (!passed && traceId) failures.push({ taskId: result.taskId, traceId })
    }
  }

  if (!config || failures.length === 0) return
  const queueName = (process.env.AGENT_EVAL_LANGFUSE_QUEUE ?? "").trim() || DEFAULT_ANNOTATION_QUEUE
  try {
    const queue = await ensureAnnotationQueue(config, { name: queueName })
    for (const failure of failures) {
      await enqueueAnnotationTrace(config, queue.id, failure.traceId)
    }
    log(`  langfuse queue ↑ ${failures.length} 条失败样本 → ${queue.name}`)
  } catch (err) {
    // 标注队列是辅助闭环，失败不影响 gate 判定。
    log(`  langfuse queue ✗ ${err instanceof Error ? err.message : String(err)}`)
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const opts = {
    command,
    suite: "baseline",
    runtime: "wfxm",
    task: undefined,
    out: undefined,
    real: false,
    withCapability: false,
    withRag: false,
    minCapability: 0.8,
    minRag: 0.9,
    maxFlaky: 0.2,
    repeats: 1,
  }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === "--suite") opts.suite = rest[++i]
    else if (arg === "--runtime") opts.runtime = rest[++i]
    else if (arg === "--task") opts.task = rest[++i]
    else if (arg === "--out") opts.out = rest[++i]
    else if (arg === "--real") opts.real = true
    else if (arg === "--with-capability") opts.withCapability = true
    else if (arg === "--with-rag") opts.withRag = true
    else if (arg === "--min-capability") opts.minCapability = parseRate(rest[++i])
    else if (arg === "--min-rag") opts.minRag = parseRate(rest[++i])
    else if (arg === "--max-flaky") opts.maxFlaky = parseRate(rest[++i])
    else if (arg === "--repeats") opts.repeats = parseRepeats(rest[++i])
    else throw new Error(`未知参数：${arg}`)
  }
  return opts
}

function parseRepeats(raw) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("--repeats 需要 1–5 之间的整数（成本随次数线性增长）")
  }
  return value
}

function parseRate(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("--min-capability 需要 0–1 之间的数字")
  }
  return value
}

/** 没有凭证时会静默回落到 stub 回复，真实模型模式必须快速失败。 */
function assertRealModelKeys() {
  if (!MODEL_KEYS.some((key) => (process.env[key] ?? "").trim() !== "")) {
    throw new Error("--real 需要至少一个模型 API key（可先 source ~/.config/butler-v5/env）")
  }
}

/**
 * 执行一个套件并落盘 summary/report。
 *
 * @param {{ suiteName: string, runtime: string, runDir: string, runId: string, task?: string, real: boolean, repeats?: number, log?: (msg: string) => void }} args
 */
async function executeSuite({
  suiteName,
  runtime,
  runDir,
  runId,
  task,
  real,
  repeats = 1,
  log = (msg) => console.log(msg),
}) {
  const factory = ADAPTERS[runtime]
  if (!factory) throw new Error(`未注册的 runtime：${runtime}`)

  if (real) process.env.AGENT_EVAL_REAL_MODEL = "1"
  else delete process.env.AGENT_EVAL_REAL_MODEL

  const tasksDir = join(ROOT, "tasks", suiteName)
  let tasks = await loadTasks(tasksDir)
  if (task) tasks = tasks.filter((t) => t.id === task)
  if (tasks.length === 0) throw new Error(`没有匹配的任务：suite=${suiteName} task=${task ?? "*"}`)

  const startedAt = new Date().toISOString()
  await mkdir(runDir, { recursive: true })
  const adapter = (await factory()).default
  // 真实模型运行锁定采样温度；子进程继承该 env，summary 也记录同一值。
  if (real) process.env.BUTLER_MODEL_TEMPERATURE ??= "0"
  const suite = await runSuite({ adapter, tasks, runDir, runId, repeats, log })
  await exportLangfuse({ results: suite.results, log })
  const config = await collectRunConfig({ results: suite.results, real })
  const summary = {
    ...suite,
    suite: suiteName,
    startedAt,
    finishedAt: new Date().toISOString(),
    config,
  }

  await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8")
  await writeFile(join(runDir, "report.md"), renderReport(summary), "utf8")

  const passed = suite.results.filter((r) => r.passed).length
  return {
    passed,
    total: suite.results.length,
    results: suite.results,
    config,
    runDir,
    repeats: suite.repeats,
    passRate: suite.passRate,
    attemptsTotal: suite.attemptsTotal,
    attemptsPassed: suite.attemptsPassed,
    flaky: suite.flaky,
  }
}

async function runCommand(opts) {
  if (opts.withCapability) throw new Error("--with-capability 仅用于 gate 子命令")
  if (opts.withRag) throw new Error("--with-rag 仅用于 gate 子命令")

  // capability 套件衡量模型能力，fixture 驱动没有意义，必须显式 --real。
  if (opts.suite === "capability" && !opts.real) {
    throw new Error("capability 套件必须使用 --real（真实模型）运行")
  }
  if (opts.real) assertRealModelKeys()

  const startedAt = new Date().toISOString()
  const runId = `${opts.runtime}-${startedAt.replace(/[:.]/g, "-")}`
  const runDir = opts.out ? resolve(opts.out) : join(ROOT, ".eval-runs", runId)
  const { passed, total, runDir: outDir, passRate, flaky } = await executeSuite({
    suiteName: opts.suite,
    runtime: opts.runtime,
    runDir,
    runId,
    task: opts.task,
    real: opts.real,
    repeats: opts.repeats,
  })

  console.log(`\n${passed}/${total} 任务全过，平均任务通过率 ${(passRate * 100).toFixed(1)}%`)
  if (flaky.length > 0) {
    console.log(`Flaky：${flaky.map((f) => `${f.taskId} ${f.attemptsPassed}/${f.attemptsTotal}`).join("、")}`)
  }
  console.log(`报告：${join(outDir, "report.md")}`)
  process.exit(passed === total ? 0 : 1)
}

async function gateCommand(opts) {
  if (opts.withCapability && !opts.real) {
    throw new Error("--with-capability 需要 --real（真实模型）")
  }
  if (opts.withRag && !opts.real) {
    throw new Error("--with-rag 需要 --real（真实模型）")
  }
  if (opts.withCapability || opts.withRag) assertRealModelKeys()

  const startedAt = new Date().toISOString()
  const gateId = `gate-${startedAt.replace(/[:.]/g, "-")}`
  const gateDir = opts.out ? resolve(opts.out) : join(ROOT, ".eval-runs", gateId)

  // baseline 永远走 fixture：它验证接线与审批路径，不应消耗模型额度。
  console.log("▶ gate baseline（fixture）")
  const baseline = await executeSuite({
    suiteName: "baseline",
    runtime: opts.runtime,
    runDir: join(gateDir, "baseline"),
    runId: `${gateId}-baseline`,
    real: false,
  })

  let capability
  if (opts.withCapability) {
    console.log(`▶ gate capability（真实模型，每任务 ${opts.repeats} 次）`)
    capability = await executeSuite({
      suiteName: "capability",
      runtime: opts.runtime,
      runDir: join(gateDir, "capability"),
      runId: `${gateId}-capability`,
      real: true,
      repeats: opts.repeats,
    })
  }

  let rag
  if (opts.withRag) {
    console.log(`▶ gate rag（真实模型，每任务 ${opts.repeats} 次）`)
    const ragRun = await executeSuite({
      suiteName: "rag",
      runtime: opts.runtime,
      runDir: join(gateDir, "rag"),
      runId: `${gateId}-rag`,
      real: true,
      repeats: opts.repeats,
    })
    // 检索指标是确定性的，从 trace 直接算；Ragas 生成指标不参与 gate。
    const ragTasks = await loadTasks(join(ROOT, "tasks", "rag"))
    const retrieval = await evaluateRetrieval(ragTasks, ragRun.results)
    rag = {
      passed: ragRun.passed,
      total: ragRun.total,
      rate: ragRun.passRate,
      repeats: ragRun.repeats,
      attemptsTotal: ragRun.attemptsTotal,
      attemptsPassed: ragRun.attemptsPassed,
      flaky: ragRun.flaky.map((f) => f.taskId),
      retrieval,
      config: ragRun.config,
      report: join(ragRun.runDir, "report.md"),
    }
  }

  const verdict = evaluateGate({
    baseline: { passed: baseline.passed, total: baseline.total },
    ...(capability
      ? {
          capability: {
            passed: capability.passed,
            total: capability.total,
            rate: capability.passRate,
            flaky: capability.flaky.map((f) => f.taskId),
          },
        }
      : {}),
    minCapability: opts.minCapability,
    ...(rag
      ? {
          rag: {
            passed: rag.passed,
            total: rag.total,
            rate: rag.rate,
            flaky: rag.flaky,
            retrieval: rag.retrieval,
          },
        }
      : {}),
    minRagRate: opts.minRag,
    maxFlakyRate: opts.maxFlaky,
  })

  const gate = {
    gateId,
    runtime: opts.runtime,
    startedAt,
    finishedAt: new Date().toISOString(),
    thresholds: {
      baseline: 1,
      flakyRate: opts.maxFlaky,
      ...(capability ? { capability: opts.minCapability } : {}),
      ...(rag
        ? {
            rag: {
              passRate: opts.minRag,
              hitAt3: DEFAULT_MIN_RAG_HIT_AT3,
              mrr: DEFAULT_MIN_RAG_MRR,
            },
          }
        : {}),
    },
    baseline: {
      runId: `${gateId}-baseline`,
      passed: baseline.passed,
      total: baseline.total,
      rate: verdict.baselineRate,
      config: baseline.config,
      report: join(gateDir, "baseline", "report.md"),
    },
    ...(capability
      ? {
          capability: {
            runId: `${gateId}-capability`,
            passed: capability.passed,
            total: capability.total,
            rate: verdict.capabilityRate,
            repeats: capability.repeats,
            attemptsTotal: capability.attemptsTotal,
            attemptsPassed: capability.attemptsPassed,
            flaky: capability.flaky,
            config: capability.config,
            report: join(gateDir, "capability", "report.md"),
          },
        }
      : {}),
    ...(rag
      ? {
          rag: {
            runId: `${gateId}-rag`,
            passed: rag.passed,
            total: rag.total,
            rate: verdict.ragRate,
            repeats: rag.repeats,
            attemptsTotal: rag.attemptsTotal,
            attemptsPassed: rag.attemptsPassed,
            flaky: rag.flaky,
            retrieval: rag.retrieval,
            config: rag.config,
            report: rag.report,
          },
        }
      : {}),
    checks: verdict.checks,
    ok: verdict.ok,
  }
  await writeFile(join(gateDir, "gate.json"), JSON.stringify(gate, null, 2) + "\n", "utf8")

  console.log(`\n${verdict.ok ? "GATE PASS" : "GATE FAIL"}`)
  for (const check of verdict.checks) {
    console.log(`  ${check.ok ? "✓" : "✗"} ${check.name} — ${check.detail}`)
  }
  console.log(`gate.json：${join(gateDir, "gate.json")}`)
  process.exit(verdict.ok ? 0 : 1)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.command === "run") return runCommand(opts)
  if (opts.command === "gate") return gateCommand(opts)

  console.log(USAGE)
  process.exit(opts.command === "help" ? 0 : 2)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exit(2)
})
