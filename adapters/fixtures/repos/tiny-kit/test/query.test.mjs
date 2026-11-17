import test from "node:test"
import assert from "node:assert/strict"
import { parseQuery } from "../src/query.mjs"

test("parseQuery: 解码百分号与加号", () => {
  assert.deepEqual(parseQuery("?a=hello%20world&b=x+y"), { a: "hello world", b: "x y" })
})

test("parseQuery: 忽略空片段", () => {
  assert.deepEqual(parseQuery("?a=1&&b=2"), { a: "1", b: "2" })
})
