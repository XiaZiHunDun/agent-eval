/**
 * 生成 URL slug。
 * 期望：去掉首尾空白，把连续空白/下划线/连字符折叠成单个 "-"，保留中文。
 */
export function slugify(input) {
  return input.toLowerCase().replace(/\s+/g, "-")
}
