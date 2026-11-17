import test from "node:test"
import assert from "node:assert/strict"
import { unique } from "../src/unique.mjs"

test("unique: 大小写不敏感去重", () => {
  assert.deepEqual(unique(["A", "a", "b"]), ["A", "b"])
})

test("unique: 保持首次出现顺序", () => {
  assert.deepEqual(unique([3, 1, 3, 2]), [3, 1, 2])
})
