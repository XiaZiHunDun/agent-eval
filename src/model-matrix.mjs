/**
 * 模型矩阵：同一批能力任务，分别用两个模型各跑一次，输出配对 lift。
 *
 * 用法（两个 provider 的 key 都要在环境里）：
 *   npm run eval:matrix -- --repeats 1
 *
 * 默认任务取自 baselines/capability-real.json，保证与 nightly 基线同源。
 * 产物写入 .eval-runs/matrix/<时间戳>/{summary.json,matrix.md}。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRuns } from "./compare.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASELINE = join(ROOT, "baselines", "capability-real.json");

const ARMS = [
  {
    label: "minimax-m3.1",
    model: "MiniMax-M3.1-Flash",
    env: {
      BUTLER_V5_MODEL_PLAN: "MiniMax-M3.1-Flash",
      BUTLER_V5_MODEL_EXEC: "MiniMax-M3.1-Flash",
      BUTLER_V5_MODEL_INTAKE: "MiniMax-M3.1-Flash",
    },
  },
  {
    label: "deepseek-flash",
    model: "deepseek-flash",
    env: {
      BUTLER_V5_MODEL_PLAN: "deepseek-flash",
      BUTLER_V5_MODEL_EXEC: "deepseek-flash",
      BUTLER_V5_MODEL_INTAKE: "deepseek-flash",
    },
  },
];

function parseArgs(argv) {
  const opts = {
    repeats: 1,
    tasks: undefined,
    out: undefined,
    suite: "capability",
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repeats") opts.repeats = Number(argv[++i] ?? 1);
    else if (argv[i] === "--tasks")
      opts.tasks = String(argv[++i] ?? "")
        .split(",")
        .filter(Boolean);
    else if (argv[i] === "--out") opts.out = argv[++i];
    else if (argv[i] === "--suite")
      opts.suite = String(argv[++i] ?? "capability");
  }
  return opts;
}

function loadTaskIds() {
  const raw = JSON.parse(readFileSync(BASELINE, "utf8"));
  const ids = Object.keys(raw.taskRates ?? {});
  if (ids.length === 0)
    throw new Error(`${BASELINE} 没有 taskRates，请用 --tasks 指定`);
  return ids;
}

/** 非 capability 套件按目录扫描任务 id，便于对 heldout 等更难的任务跑矩阵。 */
function loadSuiteTaskIds(suite) {
  const dir = join(ROOT, "tasks", suite);
  const ids = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")).id);
  if (ids.length === 0) throw new Error(`tasks/${suite} 没有任务`);
  return ids;
}

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function summarize(summary) {
  const results = summary.results ?? [];
  const passed = results.filter((result) => result.passed).length;
  const cost = results.reduce(
    (sum, result) =>
      sum + (typeof result.costUsd === "number" ? result.costUsd : 0),
    0,
  );
  return {
    passed,
    total: results.length,
    passRate: summary.passRate ?? 0,
    p95: p95(results.map((result) => result.durationMs ?? 0)),
    costUsd: cost,
  };
}

function runArm(arm, { suite, taskIds, repeats, baseDir }) {
  const dir = join(baseDir, arm.label);
  console.log(`\n▶ ${arm.label}（${arm.model}）`);
  const child = spawnSync(
    process.execPath,
    [
      "src/cli.mjs",
      "run",
      "--suite",
      suite,
      "--runtime",
      "wfxm",
      "--real",
      "--repeats",
      String(repeats),
      "--tasks",
      taskIds.join(","),
      "--label",
      arm.label,
      "--out",
      dir,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, ...arm.env },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const tail = `${child.stdout ?? ""}\n${child.stderr ?? ""}`
    .trim()
    .split("\n")
    .slice(-3);
  for (const line of tail) console.log(`  ${line}`);
  // 单条任务失败是矩阵要比较的数据，不是基础设施故障；以 summary 是否落盘为准。
  const summaryPath = join(dir, "summary.json");
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch {
    throw new Error(
      `${arm.label} 运行失败（exit ${child.status}），且没有生成 ${summaryPath}`,
    );
  }
  if (child.status !== 0)
    console.log(`  ⚠ 有任务未全过（exit ${child.status}），按数据继续比较`);
  return summary;
}

function renderMarkdown({ generatedAt, suite, repeats, arms, compare }) {
  const lines = [];
  lines.push(`# 模型矩阵 — ${suite} 子集`);
  lines.push("");
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push(`- 每任务重复：${repeats} 次`);
  lines.push("");
  lines.push("| 臂 | 模型 | 任务全过 | 平均通过率 | P95(ms) | 总成本 |");
  lines.push("|---|---|---|---|---|---|");
  for (const arm of arms) {
    lines.push(
      `| ${arm.label} | ${arm.model} | ${arm.stats.passed}/${arm.stats.total} | ${(arm.stats.passRate * 100).toFixed(1)}% | ${arm.stats.p95} | $${arm.stats.costUsd.toFixed(4)} |`,
    );
  }
  lines.push("");
  if (compare.blocked) {
    lines.push("## BLOCKED（不报告 headline）");
    lines.push("");
    for (const issue of compare.issues) lines.push(`- ${issue}`);
    return lines.join("\n") + "\n";
  }
  lines.push(`## 配对 lift（${compare.labelB} − ${compare.labelA}）`);
  lines.push("");
  lines.push(
    `headline：**${(compare.headline * 100).toFixed(1)}pp**；改善 ${compare.improved} / 回退 ${compare.regressed} / 持平 ${compare.unchanged}`,
  );
  lines.push("");
  lines.push(`| 任务 | ${compare.labelA} | ${compare.labelB} | lift |`);
  lines.push("|---|---|---|---|");
  for (const pair of compare.pairs) {
    lines.push(
      `| ${pair.taskId} | ${(pair.aRate * 100).toFixed(0)}% | ${(pair.bRate * 100).toFixed(0)}% | ${(pair.lift * 100).toFixed(0)}pp |`,
    );
  }
  return lines.join("\n") + "\n";
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const taskIds = opts.tasks?.length
    ? opts.tasks
    : opts.suite === "capability"
      ? loadTaskIds()
      : loadSuiteTaskIds(opts.suite);
  const generatedAt = new Date().toISOString();
  const baseDir = resolve(
    opts.out ??
      join(ROOT, ".eval-runs", "matrix", generatedAt.replace(/[:.]/g, "-")),
  );
  mkdirSync(baseDir, { recursive: true });

  if (!process.env.MINIMAX_API_KEY || !process.env.DEEPSEEK_API_KEY) {
    throw new Error(
      "两个 provider 的 key 都需要在环境里：MINIMAX_API_KEY、DEEPSEEK_API_KEY",
    );
  }

  const arms = [];
  for (const arm of ARMS) {
    const summary = runArm(arm, {
      suite: opts.suite,
      taskIds,
      repeats: opts.repeats,
      baseDir,
    });
    arms.push({ ...arm, stats: summarize(summary), summary });
  }

  const compare = compareRuns({
    a: arms[0].summary,
    b: arms[1].summary,
    labelA: arms[0].label,
    labelB: arms[1].label,
  });
  const markdown = renderMarkdown({
    generatedAt,
    suite: opts.suite,
    repeats: opts.repeats,
    arms,
    compare,
  });
  writeFileSync(join(baseDir, "matrix.md"), markdown, "utf8");
  writeFileSync(
    join(baseDir, "matrix.json"),
    JSON.stringify(
      {
        generatedAt,
        suite: opts.suite,
        repeats: opts.repeats,
        tasks: taskIds,
        arms: arms.map(({ label, model, stats }) => ({
          label,
          model,
          ...stats,
        })),
        compare,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`\n${markdown}`);
  console.log(`产物：${join(baseDir, "matrix.md")}`);
  if (compare.blocked) {
    console.error("配对比较被阻断，请检查缺失/重复/未评分任务。");
    process.exitCode = 1;
  }
}

main();
