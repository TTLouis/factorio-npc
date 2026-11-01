// Prompt prefix stability report (work plan item 2.9), read from the prompt
// trace (sgluna-prompts.jsonl). For every provider call it compares the
// message array and tool block with the previous call of the same request
// chain and names why the shared prefix ended (prompt-prefix.mjs
// classifyPrefixBreak), next to the cache hit that call got. This is the
// audit that found which changes were costing cache hits.
//
// Only structure and token counts are read: message roles and marker prefixes
// (never their text), and the provider's usage numbers.

import { classifyPrefixBreak } from './prompt-prefix.mjs'

// Reasons that are the layout working as intended, and the ones that are
// defects a later change should not reintroduce.
export const EXPECTED_PREFIX_REASONS = Object.freeze(['tail_only', 'compaction', 'continuation_reset', 'role_switch'])
export const DEFECT_PREFIX_REASONS = Object.freeze(['tools_removed', 'tools_changed', 'tail_reorder', 'history_rewrite'])

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

// Provider usage as the prompt trace stores it (OpenAI-shaped, with the
// DeepSeek and OpenRouter cache fields).
function traceUsage(usage) {
  const input = integer(usage?.prompt_tokens ?? usage?.input_units)
  const hit = integer(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_input_units)
  return { input_units: input, cached_input_units: Math.min(hit, input) }
}

function emptyBucket() {
  return { transitions: 0, input_units: 0, cached_input_units: 0 }
}

export function buildPrefixReport(rows) {
  const transitions = []
  let previous
  let open
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.event === 'provider.request') {
      const payload = row.payload
      if (!Array.isArray(payload?.messages)) continue
      // The interaction router is its own tiny role, not part of the planner's
      // prefix chain: leave the chain as it was.
      if (row.reasoning_policy_reason === 'interaction_router') { open = undefined; continue }
      const current = { messages: payload.messages, tools: payload.tools }
      open = previous
        ? { ...classifyPrefixBreak(previous, current), ts: row.ts, round: row.round, policy: row.reasoning_policy_reason, tools_sent: Array.isArray(payload.tools) && payload.tools.length > 0 }
        : { reason: 'first_call', shared_messages: 0, ts: row.ts, round: row.round, policy: row.reasoning_policy_reason, tools_sent: Array.isArray(payload.tools) && payload.tools.length > 0 }
      transitions.push(open)
      previous = current
      continue
    }
    if (row?.event === 'provider.response' && open && open.usage === undefined) {
      open.usage = traceUsage(row.usage)
    }
  }

  const byReason = new Map()
  for (const item of transitions) {
    if (!byReason.has(item.reason)) byReason.set(item.reason, emptyBucket())
    const bucket = byReason.get(item.reason)
    bucket.transitions++
    bucket.input_units += item.usage?.input_units ?? 0
    bucket.cached_input_units += item.usage?.cached_input_units ?? 0
  }
  const reasons = [...byReason.entries()].map(([reason, bucket]) => ({
    reason,
    expected: EXPECTED_PREFIX_REASONS.includes(reason) || reason === 'first_call',
    ...bucket,
    cached_input_share: bucket.input_units > 0 ? Math.round(bucket.cached_input_units / bucket.input_units * 1000) / 1000 : undefined,
    cache_miss_input_units: bucket.input_units - bucket.cached_input_units,
  })).sort((a, b) => b.cache_miss_input_units - a.cache_miss_input_units)
  const defects = transitions.filter(item => DEFECT_PREFIX_REASONS.includes(item.reason))
  return {
    calls: transitions.length,
    reasons,
    defect_transitions: defects.length,
    defects: defects.slice(0, 20).map(item => ({ ts: item.ts, round: item.round, policy: item.policy, reason: item.reason, shared_messages: item.shared_messages, previous_stable_messages: item.previous_stable_messages, cached_input_share: item.usage?.input_units > 0 ? Math.round(item.usage.cached_input_units / item.usage.input_units * 1000) / 1000 : undefined })),
  }
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'
}

function thousands(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—'
}

export function formatPrefixReport(report) {
  if (!report || report.calls === 0) return 'Prompt prefix stability: no provider request payloads in the prompt trace.'
  const lines = [
    'Prompt prefix stability (2.9): why each call stopped sharing the previous call\'s prefix, and the cache hit it got',
    `calls: ${report.calls} · defect transitions (tools removed/changed, tail reorder, history rewrite): ${report.defect_transitions}`,
  ]
  for (const row of report.reasons) {
    lines.push(`- ${row.reason}${row.expected ? '' : ' (DEFECT)'}: ${row.transitions} calls · in ${thousands(row.input_units)} (${percent(row.cached_input_share)} cached, ${thousands(row.cache_miss_input_units)} miss)`)
  }
  for (const item of report.defects) lines.push(`  defect ${item.ts ?? '—'} round ${item.round ?? '—'} ${item.policy ?? '—'}: ${item.reason}, shared ${item.shared_messages} of ${item.previous_stable_messages} stable messages, ${percent(item.cached_input_share)} cached`)
  return lines.join('\n')
}
