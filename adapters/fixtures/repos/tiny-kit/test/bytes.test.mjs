import test from "node:test"
import assert from "node:assert/strict"
import { formatBytes } from "../src/bytes.mjs"

test("formatBytes: KB 保留一位小数", () => {
  assert.equal(formatBytes(1536), "1.5 KB")
  assert.equal(formatBytes(1024), "1.0 KB")
})

test("formatBytes: 小文件用字节", () => {
  assert.equal(formatBytes(512), "512 B")
})
