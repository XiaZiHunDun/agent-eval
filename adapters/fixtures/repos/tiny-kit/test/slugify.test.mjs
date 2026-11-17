import test from "node:test"
import assert from "node:assert/strict"
import { slugify } from "../src/slugify.mjs"

test("slugify: 折叠空白与连字符", () => {
  assert.equal(slugify("  Hello   World  "), "hello-world")
  assert.equal(slugify("a--b__c"), "a-b-c")
})

test("slugify: 保留中文", () => {
  assert.equal(slugify("微信 管家"), "微信-管家")
})
