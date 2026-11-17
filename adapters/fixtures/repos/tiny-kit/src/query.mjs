/**
 * 解析 URL query string。
 * 期望：去掉前导 "?"，解码百分号编码，把 "+" 还原为空格，忽略空片段。
 */
export function parseQuery(input) {
  const out = {}
  for (const pair of input.replace(/^\?/, "").split("&")) {
    if (!pair) continue
    const [key, value = ""] = pair.split("=")
    out[key] = value
  }
  return out
}
