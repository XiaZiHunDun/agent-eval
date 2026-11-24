import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  loadTaskSchema,
  validateTask,
  validateTaskSchema,
  validateTaskTree,
} from "./contract.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("contract: 所有任务都符合 eval-task schema", () => {
  const { total, errors } = validateTaskTree(join(ROOT, "tasks"))
  assert.equal(errors.join("\n"), "", `共 ${total} 个任务文件`)
  assert.ok(total > 0)
})

test("contract: 负例——未声明字段被拒绝", () => {
  const task = {
    id: "x-1",
    title: "x",
    suite: "unit",
    turns: ["hi"],
    expect: { replyPattern: "ok" },
    unknownField: true,
  }
  assert.match(validateTask(task).join("\n"), /unknownField/)
})

test("contract: 负例——缺必填字段", () => {
  assert.match(validateTask({ id: "x-1" }).join("\n"), /缺少必填字段/)
})

test("contract: 负例——坏 pattern / 坏 enum / 类型不符", () => {
  const schema = loadTaskSchema()
  assert.match(
    validateTaskSchema("Bad ID", schema.properties.id).join("\n"),
    /不匹配/,
  )
  assert.match(
    validateTaskSchema("nope", schema.properties.difficulty).join("\n"),
    /应为/,
  )
  assert.match(
    validateTaskSchema({ maxTurns: "3" }, schema.properties.budget).join("\n"),
    /类型应为/,
  )
})

test("contract: expect 与 rubric 至少需要一个", () => {
  const task = { id: "x-2", title: "x", suite: "unit", turns: ["hi"] }
  assert.match(validateTask(task).join("\n"), /expect.*rubric/)
})

test("contract: verify.mjs 读取的字段都在 schema 中（防漂移）", () => {
  const source = readFileSync(join(ROOT, "src", "verify.mjs"), "utf8")
  const schema = loadTaskSchema()
  // 去掉字符串字面量，避免把检查项名称（如 "task.hasExpectation"）当成字段访问。
  const code = source
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
  const expectProps = schema.properties.expect.properties
  const taskProps = schema.properties

  const expectKeys = new Set(
    [...code.matchAll(/expect\.([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]),
  )
  for (const key of expectKeys) {
    assert.ok(key in expectProps, `expect.${key} 被 verify 读取，但 schema 未声明`)
  }

  const butlerProps = expectProps.butler.properties
  const butlerKeys = new Set(
    [...code.matchAll(/butlerExpect\.([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]),
  )
  for (const key of butlerKeys) {
    assert.ok(key in butlerProps, `expect.butler.${key} 被 verify 读取，但 schema 未声明`)
  }

  const taskKeys = new Set(
    [...code.matchAll(/(?<![\w.])task\.([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]),
  )
  for (const key of taskKeys) {
    assert.ok(key in taskProps, `task.${key} 被 verify 读取，但 schema 未声明`)
  }
})
