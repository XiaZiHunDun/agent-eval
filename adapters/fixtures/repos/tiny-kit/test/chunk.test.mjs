import test from "node:test"
import assert from "node:assert/strict"
import { chunk } from "../src/chunk.mjs"

test("chunk: 最后一块保留余数", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test("chunk: 空数组返回空", () => {
  assert.deepEqual(chunk([], 3), [])
})
