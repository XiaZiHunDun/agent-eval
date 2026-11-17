import assert from "node:assert/strict"
import test from "node:test"
import {
  buildLangfuseBatch,
  enqueueAnnotationTrace,
  ensureAnnotationQueue,
  langfuseConfigFromEnv,
  langfuseEnabled,
  pushLangfuseBatch,
} from "./langfuse.mjs"

const CONFIG = { host: "http://x", publicKey: "pk", secretKey: "sk" }

function jsonResponse(value) {
  return { ok: true, status: 200, text: async () => JSON.stringify(value) }
}

/**
 * 构造一条最小可用的 wfxm trace。
 * @param {Array<{ type: string, payload?: object, ts?: string, seq?: number }>} specs
 */
function trace(specs) {
  const traceId = "trace-1"
  let rootSpanId
  return specs.map((spec, index) => {
    const event = {
      schema: "wfxm.trace/0",
      traceId,
      runId: "run-1",
      runtime: "wfxm",
      seq: index,
      ts: spec.ts ?? `2026-11-11T00:00:0${index}.000Z`,
      type: spec.type,
      spanId: `span-${index}`,
      parentSpanId: rootSpanId ?? null,
      actor: { kind: "system", id: "wfxm" },
      payload: spec.payload ?? {},
    }
    if (spec.type === "run.start") rootSpanId = event.spanId
    return event
  })
}

test("buildLangfuseBatch: trace + generation + tool + rag + run end", () => {
  const events = trace([
    { type: "run.start", payload: { taskId: "cap-demo", scenarioId: "S1", model: "real" } },
    { type: "turn.start", payload: { turn: 1, content: "hi" } },
    {
      type: "model.request",
      payload: { model: "MiniMax-M3.1-Flash", messages: 3, tools: 8, promptChars: 120 },
    },
    {
      type: "model.response",
      payload: {
        status: "ok",
        durationMs: 900,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        contentChars: 12,
        toolCallCount: 1,
        costUsd: 0.0004,
      },
    },
    { type: "tool.call", payload: { name: "read_file", args: { path: "a.ts" } } },
    { type: "tool.result", payload: { name: "read_file", ok: true } },
    {
      type: "rag.retrieve",
      payload: {
        capability: "recall_document",
        scope: "document",
        query: "架构",
        limit: 3,
        hits: [{ docId: "d1", rank: 1, title: "架构.md", chars: 80 }],
      },
    },
    { type: "turn.end", payload: { turn: 1, status: "responded" } },
    { type: "run.end", payload: { status: "ok", steps: 2 } },
  ])

  const batch = buildLangfuseBatch(events, { sessionId: "cap-demo" })
  assert.ok(batch.length >= 6, `batch 太小：${batch.length}`)
  assert.equal(batch[0].type, "trace-create")
  assert.equal(batch[0].body.id, "trace-1")
  assert.equal(batch[0].body.sessionId, "cap-demo")

  const generation = batch.find((item) => item.type === "generation-create")
  assert.ok(generation)
  assert.equal(generation.body.model, "MiniMax-M3.1-Flash")
  assert.deepEqual(generation.body.usage, { input: 100, output: 20, total: 120, unit: "TOKENS" })
  // v3 只认 costDetails；旧的 cost 字段会被静默丢弃。
  assert.deepEqual(generation.body.costDetails, { total: 0.0004 })
  assert.equal(generation.body.cost, undefined)
  assert.equal(generation.body.startTime, "2026-11-11T00:00:02.000Z")
  assert.equal(generation.body.endTime, "2026-11-11T00:00:03.000Z")

  const tool = batch.find((item) => item.body?.name === "tool.read_file")
  assert.ok(tool)
  assert.deepEqual(tool.body.input, { path: "a.ts" })

  const rag = batch.find((item) => item.body?.name === "rag.retrieve")
  assert.ok(rag)
  assert.deepEqual(rag.body.output.hits, [{ docId: "d1", rank: 1, title: "架构.md", chars: 80 }])

  const turns = batch.filter((item) => item.body?.name === "turn.1")
  assert.equal(turns.length, 1)
  assert.equal(turns[0].body.endTime, "2026-11-11T00:00:07.000Z")

  const finalTrace = batch.filter((item) => item.type === "trace-create").at(-1)
  assert.deepEqual(finalTrace.body.output, { status: "ok", steps: 2 })
  // JSON 可序列化，且不包含 undefined 字段。
  const json = JSON.stringify({ batch })
  assert.equal(json.includes("undefined"), false)
})

test("buildLangfuseBatch: error generation is marked ERROR", () => {
  const events = trace([
    { type: "run.start", payload: { taskId: "cap-demo" } },
    { type: "model.request", payload: { model: "m", messages: 1, tools: 0, promptChars: 3 } },
    { type: "model.response", payload: { status: "error", durationMs: 50, reason: "timeout" } },
    { type: "run.end", payload: { status: "error" } },
  ])
  const generation = buildLangfuseBatch(events).find((item) => item.type === "generation-create")
  assert.equal(generation.body.level, "ERROR")
  assert.equal(generation.body.metadata.error, "timeout")
  assert.equal(generation.body.usage, undefined)
})

test("buildLangfuseBatch: empty or invalid input", () => {
  assert.deepEqual(buildLangfuseBatch([]), [])
  assert.throws(() => buildLangfuseBatch([{ schema: "other", type: "run.start", payload: {} }]), /schema/)
})

test("pushLangfuseBatch sends Basic auth to ingestion endpoint", async () => {
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url, init }
    return { ok: true, status: 207, text: async () => "" }
  }
  const result = await pushLangfuseBatch(
    [{ id: "1", type: "trace-create", timestamp: "t", body: {} }],
    { host: "http://localhost:3000/", publicKey: "pk", secretKey: "sk" },
    { fetchImpl },
  )
  assert.equal(captured.url, "http://localhost:3000/api/public/ingestion")
  assert.equal(captured.init.method, "POST")
  assert.equal(
    captured.init.headers.authorization,
    `Basic ${Buffer.from("pk:sk").toString("base64")}`,
  )
  assert.equal(JSON.parse(captured.init.body).batch.length, 1)
  assert.deepEqual(result, { ok: true, status: 207, count: 1 })
})

test("pushLangfuseBatch surfaces ingestion errors", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "unauthorized" })
  await assert.rejects(
    pushLangfuseBatch([], { host: "http://x", publicKey: "pk", secretKey: "sk" }, { fetchImpl }),
    /401/,
  )
})

test("pushLangfuseBatch treats 207 partial failures as errors", async () => {
  const body = JSON.stringify({
    successes: [{ id: "1", status: 201 }],
    errors: [{ id: "2", status: 400, message: "invalid type" }],
  })
  const fetchImpl = async () => ({ ok: true, status: 207, text: async () => body })
  await assert.rejects(
    pushLangfuseBatch(
      [{ id: "1" }, { id: "2" }],
      { host: "http://x", publicKey: "pk", secretKey: "sk" },
      { fetchImpl },
    ),
    /部分失败（1\/2）：invalid type/,
  )
})

test("ensureAnnotationQueue reuses an existing queue without creating configs", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method })
    return jsonResponse({
      data: [{ id: "q1", name: "agent-eval-failures", scoreConfigIds: ["s1"] }],
    })
  }
  const queue = await ensureAnnotationQueue(CONFIG, { fetchImpl })
  assert.equal(queue.id, "q1")
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/api\/public\/annotation-queues\?limit=100$/)
})

test("ensureAnnotationQueue creates score config then queue when missing", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body })
    if (url.endsWith("/annotation-queues?limit=100")) return jsonResponse({ data: [] })
    if (url.endsWith("/score-configs?limit=100")) return jsonResponse({ data: [] })
    if (url.endsWith("/score-configs")) return jsonResponse({ id: "s1", name: "eval-failure-verdict" })
    if (url.endsWith("/annotation-queues")) {
      return jsonResponse({ id: "q1", name: "agent-eval-failures" })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const queue = await ensureAnnotationQueue(CONFIG, { fetchImpl })
  assert.equal(queue.id, "q1")
  assert.deepEqual(
    calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    [
      "GET /api/public/annotation-queues",
      "GET /api/public/score-configs",
      "POST /api/public/score-configs",
      "POST /api/public/annotation-queues",
    ],
  )
  const queueBody = JSON.parse(calls.at(-1).body)
  assert.deepEqual(queueBody.scoreConfigIds, ["s1"])
  assert.equal(queueBody.name, "agent-eval-failures")
})

test("enqueueAnnotationTrace posts a TRACE item", async () => {
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url, method: init.method, body: JSON.parse(init.body) }
    return jsonResponse({ id: "item-1", status: "PENDING" })
  }
  const item = await enqueueAnnotationTrace(CONFIG, "q1", "trace-1", { fetchImpl })
  assert.equal(item.id, "item-1")
  assert.match(captured.url, /\/api\/public\/annotation-queues\/q1\/items$/)
  assert.equal(captured.method, "POST")
  assert.deepEqual(captured.body, { objectId: "trace-1", objectType: "TRACE" })
})

test("env helpers", () => {
  assert.equal(langfuseEnabled({ AGENT_EVAL_LANGFUSE: "1" }), true)
  assert.equal(langfuseEnabled({}), false)
  assert.deepEqual(
    langfuseConfigFromEnv({ LANGFUSE_HOST: "http://x", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }),
    { host: "http://x", publicKey: "pk", secretKey: "sk" },
  )
  assert.equal(langfuseConfigFromEnv({ LANGFUSE_HOST: "http://x" }), null)
})
