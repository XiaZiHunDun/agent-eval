/**
 * 去重并保持首次出现顺序。
 * 期望：字符串按大小写不敏感去重，保留第一次出现的写法。
 */
export function unique(items) {
  return [...new Set(items)]
}
