// Shared sanitizer for text and values that outlive the request that produced
// them (durable memory, handoff packets). Pure.
//
// One rule set: exact entity identities (`unit_number` and friends) are
// request-scoped in Factorio. A number written into durable text and read back
// by a later conversation would steer it to a stale or reused entity, so the
// numbers are replaced by an explicit "historical" marker. The agent loop's
// durable memory and the handoff packet's note both call this; do not copy the
// rules.

export function cleanMemoryText(value, max) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

export function sanitizeDurableModelText(value, max = 2000) {
  let text = cleanMemoryText(value, max)
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return cleanMemoryText(JSON.stringify(sanitizeDurableModelValue(JSON.parse(trimmed))), max)
    }
    catch {}
  }
  text = text
    .replace(/(["']?(?:target_)?unit_number["']?\s*[:=]\s*)\d+/gi, '$1[historical-id-omitted]')
    .replace(/(["']?observed_unit_numbers["']?\s*[:=]\s*)\[[^\]]*\]/gi, '$1[historical-ids-omitted]')
    .replace(/\b(?:unit_number|target_unit_number)[_:#-]?\d+\b/gi, 'historical-exact-identity-[omitted]')
    .replace(/\bunit[_:#-]\d+\b/gi, 'historical-exact-identity-[omitted]')
    .replace(/\b(?:exact\s+entity\s+target\s+|target\s+)?unit\s+#?\d+\b/gi, 'historical exact identity [omitted]')
  return cleanMemoryText(text, max)
}

export function sanitizeDurableModelValue(value) {
  if (Array.isArray(value)) return value.map(item => sanitizeDurableModelValue(item))
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? sanitizeDurableModelText(value, Math.max(2000, value.length)) : value
  }
  const staleExact = value.code === 'stale_exact_target' || value.reason_code === 'stale_exact_target'
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (/(?:^|_)unit_number$/i.test(key) || /(?:^|_)unit_numbers$/i.test(key)) continue
    if (key === 'unit' && Number.isSafeInteger(child)) continue
    if (staleExact && key === 'identity' && Number.isSafeInteger(child)) continue
    result[key] = sanitizeDurableModelValue(child)
  }
  return result
}
