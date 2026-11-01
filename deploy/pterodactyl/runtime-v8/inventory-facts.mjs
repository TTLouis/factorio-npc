// get_inventory_items prints serpent.block(get_actor_inventory_items(actor)). The
// native projection is a list of name/count tables, or {} for an empty list. This
// deliberately recognizes only that shape, not Lua expressions or arbitrary tables.
const ITEM_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/
const SERPENT_ITEM = /\{\s*(?:count\s*=\s*(0|[1-9]\d*)\s*,\s*name\s*=\s*"([a-z0-9][a-z0-9._-]{0,99})"|name\s*=\s*"([a-z0-9][a-z0-9._-]{0,99})"\s*,\s*count\s*=\s*(0|[1-9]\d*))\s*\}/y

/** Complete validated inventory counts; undefined means unreadable, never empty. */
export function parseInventoryCounts(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (!text) return undefined
  const counts = new Map()
  const add = (name, count) => {
    if (typeof name !== 'string' || !ITEM_NAME.test(name) || !Number.isSafeInteger(count) || count < 0) return false
    // get_contents can return separate quality rows; the native projection drops
    // quality. Preserve their sum by name, but never return an unsafe total.
    const total = (counts.get(name) ?? 0) + count
    if (!Number.isSafeInteger(total)) return false
    counts.set(name, total)
    return true
  }
  let parsed
  try { parsed = JSON.parse(text) }
  catch { /* The native Serpent format is checked below. */ }
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some(key => !['name', 'count', 'quality'].includes(key))
        || (entry.quality !== undefined && (typeof entry.quality !== 'string' || !ITEM_NAME.test(entry.quality)))
        || !add(entry.name, entry.count)) return undefined
    }
    return counts
  }
  if (/^\{\s*\}$/.test(text)) return counts
  if (!text.startsWith('{') || !text.endsWith('}')) return undefined
  const body = text.slice(1, -1).trim()
  let offset = 0
  // A sticky, fixed-schema row match consumes every byte. Partial rows, extra
  // fields, errors, truncated outer tables and trailing output cannot be salvaged.
  while (offset < body.length) {
    SERPENT_ITEM.lastIndex = offset
    const match = SERPENT_ITEM.exec(body)
    if (!match || !add(match[2] ?? match[3], Number(match[1] ?? match[4]))) return undefined
    offset = SERPENT_ITEM.lastIndex
    while (offset < body.length && /\s/.test(body[offset])) offset += 1
    if (offset === body.length) return counts
    if (body[offset] !== ',') return undefined
    offset += 1
    while (offset < body.length && /\s/.test(body[offset])) offset += 1
    if (offset === body.length) return undefined
  }
  return undefined
}
