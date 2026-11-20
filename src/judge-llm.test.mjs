import test from "node:test"
import assert from "node:assert/strict"
import { createOpenAIJudge, judgeFromEnv } from "./judge-llm.mjs"

function jsonResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

test("judge: 双评返回两次分数", async () => {
  const replies = ["SCORE=4", "SCORE=5"]
  let calls = 0
  const judge = createOpenAIJudge({
    apiKey: "sk-j",
    baseUrl: "https://api.deepseek.com",
    fetchImpl: async () => jsonResponse(replies[calls++]),
  })
  const result = await judge({ prompt: "rate" })
  assert.deepEqual(result.scores, [4, 5])
  assert.equal(calls, 2)
})

test("judge: 请求体固定 temperature=0 并使用配置的模型", async () => {
  let body
  let url
  const judge = createOpenAIJudge({
    apiKey: "sk-j",
    baseUrl: "https://relay.internal/v1/",
    model: "judge-x",
    samples: 1,
    fetchImpl: async (input, init) => {
      url = String(input)
      body = JSON.parse(String(init.body))
      return jsonResponse("SCORE=3")
    },
  })
  await judge({ prompt: "rate" })
  assert.equal(url, "https://relay.internal/v1/chat/completions")
  assert.equal(body.model, "judge-x")
  assert.equal(body.temperature, 0)
})

test("judge: 无法解析的回复不计入分数", async () => {
  let calls = 0
  const judge = createOpenAIJudge({
    apiKey: "sk-j",
    samples: 2,
    fetchImpl: async () => jsonResponse(calls++ === 0 ? "SCORE=4" : "no score"),
  })
  const result = await judge({ prompt: "rate" })
  assert.deepEqual(result.scores, [4])
})

test("judge: HTTP 失败抛错（调用方决定是否阻断）", async () => {
  const judge = createOpenAIJudge({
    apiKey: "sk-j",
    samples: 1,
    fetchImpl: async () => new Response("boom", { status: 502 }),
  })
  await assert.rejects(() => judge({ prompt: "rate" }), /judge HTTP 502/)
})

test("judgeFromEnv: DEEPSEEK_API_KEY 作为 fallback，缺 key 返回 undefined", () => {
  assert.equal(judgeFromEnv({}), undefined)
  assert.equal(typeof judgeFromEnv({ DEEPSEEK_API_KEY: "sk-ds" }), "function")
  assert.equal(typeof judgeFromEnv({ JUDGE_API_KEY: "sk-j" }), "function")
})
