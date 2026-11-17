/** 把数组按固定大小分块，最后一块保留余数。 */
export function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, size))
  }
  return out
}
