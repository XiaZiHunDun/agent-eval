/**
 * 格式化字节数。
 * 期望：B 不带小数；KB/MB 保留一位小数；1024 进位。
 */
export function formatBytes(bytes) {
  const units = ["B", "KB", "MB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}
