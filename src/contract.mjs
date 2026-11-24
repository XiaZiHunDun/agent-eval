/**
 * 任务契约校验：零依赖的 JSON Schema 子集实现。
 *
 * 只覆盖 `schema/eval-task.schema.json` 实际用到的关键字，避免为了评测再引入依赖。
 * 目的不是通用校验器，而是让「任务写错字段」在 PR 阶段变红，而不是在真实跑模型时静默失效。
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export function loadTaskSchema() {
  return JSON.parse(readFileSync(join(ROOT, "schema", "eval-task.schema.json"), "utf8"))
}

function typeOf(value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (Number.isInteger(value)) return "integer"
  return typeof value
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected]
  const actual = typeOf(value)
  return types.some((type) => {
    if (type === "number") return actual === "number" || actual === "integer"
    if (type === "integer") return actual === "integer"
    return actual === type
  })
}

function joinPath(base, key) {
  return `${base}.${key}`
}

/**
 * 按 schema 校验一个值，返回问题列表（空数组表示通过）。
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [path]
 * @returns {string[]}
 */
export function validateTaskSchema(value, schema, path = "$") {
  const errors = []

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${path} 类型应为 ${JSON.stringify(schema.type)}，实际 ${typeOf(value)}`)
    return errors
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} 应为常量 ${JSON.stringify(schema.const)}`)
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path} 应为 ${schema.enum.join("/")} 之一，实际 ${JSON.stringify(value)}`)
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} 长度应 >= ${schema.minLength}`)
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path} 不匹配 ${schema.pattern}`)
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} 应 >= ${schema.minimum}，实际 ${value}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} 至少 ${schema.minItems} 项`)
    }
    if (schema.items !== undefined) {
      for (const [i, item] of value.entries()) {
        errors.push(...validateTaskSchema(item, schema.items, `${path}[${i}]`))
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${joinPath(path, key)} 缺少必填字段`)
    }
    const properties = schema.properties ?? {}
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key]
      if (childSchema === undefined) {
        if (schema.additionalProperties === false) {
          errors.push(`${joinPath(path, key)} 是未声明字段`)
        } else if (typeof schema.additionalProperties === "object") {
          errors.push(...validateTaskSchema(child, schema.additionalProperties, joinPath(path, key)))
        }
        continue
      }
      errors.push(...validateTaskSchema(child, childSchema, joinPath(path, key)))
    }
  }

  return errors
}

/** 任务级契约：schema + expect/rubric 二选一。 */
export function validateTask(task, schema = loadTaskSchema()) {
  const errors = validateTaskSchema(task, schema)
  if (task.expect === undefined && task.rubric === undefined) {
    errors.push("$.expect 与 $.rubric 至少需要一个")
  }
  return errors
}

/** 递归加载目录下所有 *.json，返回 [{ file, task }]；解析失败也作为错误返回。 */
export function loadTaskFiles(dir) {
  const files = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...loadTaskFiles(path))
    } else if (name.endsWith(".json")) {
      files.push(path)
    }
  }
  return files
}

/**
 * 校验整个任务根目录。
 * @param {string} dir
 * @returns {{ total: number, errors: string[] }}
 */
export function validateTaskTree(dir) {
  const errors = []
  const schema = loadTaskSchema()
  const files = loadTaskFiles(dir)
  for (const file of files) {
    const rel = file.slice(dir.length + 1)
    let task
    try {
      task = JSON.parse(readFileSync(file, "utf8"))
    } catch (err) {
      errors.push(`${rel}: JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    for (const error of validateTask(task, schema)) errors.push(`${rel}: ${error}`)
  }
  return { total: files.length, errors }
}
