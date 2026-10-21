// Advisory offline report: what the model could see right before a conversation
// swap (restage / planner resume) versus right after, and whether it then had to
// re-read what was lost. Not a gate: losing context is the point of a restage.
// Reads retained live-run logs (sgluna-prompts.jsonl + sgluna-behavior.jsonl).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { observationToolFamily } from './structured-policy.mjs'

const SWAP_EVENTS = {
  'context.restaged': 'restaged',
  'context.planner_resumed': 'planner_resumed',
  'context.restage_folded': 'restage_folded',
  'planning.reasoning_epoch_reset': 'reasoning_epoch_reset',
  'budget.handoff_restage_fallback': 'handoff_restage_fallback',
}
const BLOCK_LINE = /^\[([A-Z][A-Z0-9_]*)\](?:\s|$)/
const BLOCKER_RE = /BLOCKED|world_blocked|plannerReview"?\s*:\s*(?!null\b)/
const PROBE_LEN = 40
const MIN_PROBE_TEXT = 24

// ---------- parsing helpers ----------

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('\n')
  }
  return ''
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

export function canonicalArgs(raw) {
  if (raw == null || raw === '') return '{}'
  if (typeof raw !== 'string') return JSON.stringify(canonical(raw))
  try {
    return JSON.stringify(canonical(JSON.parse(raw)))
  }
  catch {
    return raw.trim()
  }
}

function normalizeText(text) {
  return String(text).replace(/\s+/g, '').toLowerCase()
}

function observationMode(text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.observation_mode === 'string') return parsed.observation_mode
  }
  catch {}
  const match = /"observation_mode"\s*:\s*"([a-z_]+)"/.exec(text)
  return match ? match[1] : undefined
}

export function parseJsonl(text) {
  const rows = []
  let malformed = 0
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    }
    catch {
      malformed++
    }
  }
  return { rows, malformed }
}

// Streams line by line: prompt logs reach 10MB with ~100KB rows.
export async function readJsonlFile(file) {
  const rows = []
  let malformed = 0
  if (!fs.existsSync(file)) return { rows, malformed, missing: true }
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    }
    catch {
      malformed++
    }
  }
  return { rows, malformed, missing: false }
}

// ---------- fact extraction ----------

export function extractFacts(messages) {
  const facts = new Map()
  if (!Array.isArray(messages)) return facts
  const calls = new Map()
  let receiptOrdinal = 0
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    if (index === 0 && message.role === 'system') continue
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.id) calls.set(call.id, { name: call.function?.name, args: canonicalArgs(call.function?.arguments) })
      }
      continue
    }
    if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id)
      if (!call || !call.name) continue
      const text = messageText(message)
      const record = {
        kind: 'tool',
        name: call.name,
        family: observationToolFamily(call.name),
        chars: text.length,
        index,
        text,
      }
      const mode = observationMode(text)
      if (mode) record.observation_mode = mode
      facts.set(`tool:${call.name}:${call.args}`, record)
      continue
    }
    if (message.role !== 'user' && message.role !== 'system') continue
    collectBlocks(messageText(message), index, facts, () => receiptOrdinal++)
  }
  return facts
}

function collectBlocks(text, index, facts, nextOrdinal) {
  const lines = text.split('\n')
  let current = null
  const flush = () => {
    if (!current) return
    const body = current.lines.join('\n')
    if (current.marker === 'MOD') {
      const batch = /"batch_id"\s*:\s*(\d+)/.exec(body)
      const id = batch ? batch[1] : String(nextOrdinal())
      facts.set(`receipt:${id}`, { kind: 'receipt', name: 'MOD', chars: body.length, index, text: body })
    }
    else {
      const key = `block:${current.marker}`
      const prior = facts.get(key)
      if (prior) {
        prior.chars += body.length
        prior.count++
        prior.text += `\n${body}`
      }
      else facts.set(key, { kind: 'block', name: current.marker, chars: body.length, count: 1, index, text: body })
    }
    current = null
  }
  for (const line of lines) {
    const match = BLOCK_LINE.exec(line)
    const topology = !match && line.startsWith('fresh_topology:')
    if (match || topology) {
      flush()
      current = { marker: match ? match[1] : 'fresh_topology', lines: [line] }
    }
    else if (current) current.lines.push(line)
  }
  flush()
}

// ---------- swap events ----------

function tsMs(row) {
  const ms = Date.parse(row?.ts)
  return Number.isFinite(ms) ? ms : undefined
}

function reasonClass(reason) {
  if (typeof reason !== 'string' || !reason) return 'none'
  return reason.split(/\s/)[0].slice(0, 70)
}

export function swapEvents(behaviorRows) {
  const events = []
  for (const row of behaviorRows ?? []) {
    const kind = SWAP_EVENTS[row?.event]
    if (!kind) continue
    const ms = tsMs(row)
    if (ms === undefined) continue
    const data = { ...row, ...(row.data && typeof row.data === 'object' ? row.data : {}) }
    events.push({
      ts: row.ts,
      ms,
      seq: Number.isFinite(row.seq) ? row.seq : 0,
      request_id: row.request_id,
      actor_id: row.actor_id,
      epoch: row.epoch,
      event: row.event,
      kind,
      role: data.role,
      checkpoint: data.checkpoint,
      handoff_id: data.handoff_id,
      reason: reasonClass(data.reason),
      plan_id: data.plan_id,
      step_id: data.step_id,
      packet_chars: data.packet_chars,
    })
  }
  events.sort((a, b) => a.ms - b.ms || a.seq - b.seq)
  return events
}

function mergeSimultaneous(events) {
  const merged = []
  for (const event of events) {
    const prior = merged.find(other => other.ms === event.ms && other.actor_id === event.actor_id)
    if (prior) {
      if (!prior.kind.split('+').includes(event.kind)) prior.kind = `${prior.kind}+${event.kind}`
      prior.role ??= event.role
      prior.checkpoint ??= event.checkpoint
      prior.handoff_id ??= event.handoff_id
      prior.packet_chars ??= event.packet_chars
      if (prior.reason === 'none') prior.reason = event.reason
    }
    else merged.push({ ...event })
  }
  return merged
}

// ---------- per-run analysis ----------

function isRequest(row) {
  return Array.isArray(row?.payload?.messages) && (row.event === undefined || row.event === 'provider.request')
}

function sameActor(a, b) {
  return a === undefined || b === undefined || a === b
}

function packetText(messages) {
  const parts = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (index === 0 && message?.role === 'system') continue
    if (message?.role === 'user' || message?.role === 'system') parts.push(messageText(message))
  }
  return normalizeText(parts.join('\n'))
}

// A tool output counts as carried when a short normalized slice of it (a few
// evenly spaced probes, majority must hit) appears in a non-tool message.
function carriedInText(record, haystack) {
  const needle = normalizeText(record.text ?? '')
  if (needle.length < MIN_PROBE_TEXT) return false
  if (needle.length <= PROBE_LEN * 2) return haystack.includes(needle)
  const probes = [0.15, 0.5, 0.85].map((fraction) => {
    const start = Math.min(needle.length - PROBE_LEN, Math.floor(needle.length * fraction))
    return needle.slice(start, start + PROBE_LEN)
  })
  const hits = probes.filter(probe => haystack.includes(probe)).length
  return hits >= 2
}

function publicFact(record, key) {
  const out = { key, kind: record.kind, name: record.name, chars: record.chars }
  if (record.family) out.family = record.family
  if (record.observation_mode) out.observation_mode = record.observation_mode
  return out
}

function assistantSig(message) {
  const ids = (message.tool_calls ?? []).map(call => call?.id ?? '').join(',')
  return `${ids}|${messageText(message)}`
}

function scanWindow(window, lostTools) {
  const seenCalls = new Set()
  const seenAssistant = new Set()
  const consume = (messages, k, record) => {
    for (const message of messages) {
      if (message?.role !== 'assistant') continue
      const sig = assistantSig(message)
      const fresh = !seenAssistant.has(sig)
      seenAssistant.add(sig)
      if (record && fresh && BLOCKER_RE.test(messageText(message))) record.blockers++
      for (const call of message.tool_calls ?? []) {
        const id = call?.id ?? `${k}:${call?.function?.name}:${call?.function?.arguments}`
        if (seenCalls.has(id)) continue
        seenCalls.add(id)
        if (!record || !call?.function?.name) continue
        record.calls++
        const exact = `tool:${call.function.name}:${canonicalArgs(call.function.arguments)}`
        if (!record.exact.has(exact)) record.exact.set(exact, k)
        if (!record.loose.has(call.function.name)) record.loose.set(call.function.name, k)
      }
    }
  }
  const record = { exact: new Map(), loose: new Map(), blockers: 0, calls: 0 }
  window.forEach((row, k) => consume(row.payload.messages, k, k === 0 ? undefined : record))
  const reRead = []
  const looseOnly = []
  for (const fact of lostTools) {
    if (record.exact.has(fact.key)) reRead.push({ key: fact.key, name: fact.name, family: fact.family, rounds: record.exact.get(fact.key) })
    else if (record.loose.has(fact.name)) looseOnly.push({ key: fact.key, name: fact.name, family: fact.family, rounds: record.loose.get(fact.name) })
  }
  return { reRead, looseOnly, blockers: record.blockers, calls: record.calls }
}

export function analyzeRun({ prompts = [], behavior = [], run = '' } = {}) {
  const requests = prompts.filter(isRequest)
    .map(row => ({ row, ms: tsMs(row) }))
    .filter(entry => entry.ms !== undefined)
    .sort((a, b) => a.ms - b.ms)
  const swaps = mergeSimultaneous(swapEvents(behavior))
  const cache = new Map()
  const factsOf = (entry) => {
    if (!cache.has(entry)) cache.set(entry, extractFacts(entry.row.payload.messages))
    return cache.get(entry)
  }
  return swaps.map((swap) => {
    const actorRequests = requests.filter(entry => sameActor(swap.actor_id, entry.row.actor_id))
    const nextSwap = swaps.find(other => other.ms > swap.ms && sameActor(swap.actor_id, other.actor_id))
    const endMs = nextSwap ? nextSwap.ms : Infinity
    let beforeIndex = -1
    for (let i = 0; i < actorRequests.length; i++) {
      if (actorRequests[i].ms < swap.ms) beforeIndex = i
      else break
    }
    const afterIndex = actorRequests.findIndex(entry => entry.ms >= swap.ms)
    const before = beforeIndex >= 0 ? actorRequests[beforeIndex] : undefined
    const after = afterIndex >= 0 && actorRequests[afterIndex].ms < endMs ? actorRequests[afterIndex] : undefined
    const result = {
      run,
      ts: swap.ts,
      request_id: swap.request_id,
      actor_id: swap.actor_id,
      kind: swap.kind,
      role: swap.role,
      checkpoint: swap.checkpoint,
      handoff_id: swap.handoff_id,
      reason: swap.reason,
      packet_chars: swap.packet_chars,
      no_before: !before,
      no_after: !after,
      lost: [],
      carried: [],
      added: [],
      re_read: [],
      re_read_loose: [],
      blocker_after_swap: 0,
      window_prompts: 0,
      calls_after: 0,
    }
    if (!before || !after) return result
    const beforeFacts = factsOf(before)
    const afterFacts = factsOf(after)
    const haystack = packetText(after.row.payload.messages)
    for (const [key, record] of beforeFacts) {
      if (afterFacts.has(key)) result.carried.push({ ...publicFact(record, key), via: 'present' })
      else if (record.kind === 'tool' && carriedInText(record, haystack)) result.carried.push({ ...publicFact(record, key), via: 'text' })
      else result.lost.push(publicFact(record, key))
    }
    for (const [key, record] of afterFacts) {
      if (!beforeFacts.has(key)) result.added.push(publicFact(record, key))
    }
    const window = []
    for (let i = afterIndex; i < actorRequests.length && actorRequests[i].ms < endMs; i++) window.push(actorRequests[i].row)
    const scan = scanWindow(window, result.lost.filter(fact => fact.kind === 'tool'))
    result.re_read = scan.reRead
    result.re_read_loose = scan.looseOnly
    result.blocker_after_swap = scan.blockers
    result.window_prompts = window.length
    result.calls_after = scan.calls
    return result
  })
}

// ---------- aggregation ----------

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function bucket(map, key, init) {
  if (!map[key]) map[key] = init()
  return map[key]
}

const newStat = () => ({ present: 0, lost: 0, carried: 0, carried_text: 0, re_read: 0, re_read_loose: 0, chars_lost: 0, rounds: [], by_group: {} })

function finishStat(stat) {
  const { rounds, ...rest } = stat
  return {
    ...rest,
    re_read_rate: stat.lost ? stat.re_read / stat.lost : 0,
    median_rounds: median(rounds),
  }
}

function groupOf(result) {
  return `${result.kind}/${result.role ?? 'unknown'}`
}

export function aggregate(results) {
  const list = results.flat()
  const out = {
    swaps_total: list.length,
    swaps_analyzed: 0,
    no_before: 0,
    no_after: 0,
    blocker_after_swap: 0,
    by_group: {},
    by_reason: {},
    tools: {},
    families: {},
    blocks: {},
    receipts: newStat(),
    top: [],
  }
  const toolStats = out.tools
  const familyStats = out.families
  const blockStats = out.blocks
  for (const result of list) {
    const group = groupOf(result)
    const groupStat = bucket(out.by_group, group, () => ({ swaps: 0, analyzed: 0, lost: 0, re_read: 0, blocker_after_swap: 0, chars_lost: 0 }))
    const reasonStat = bucket(out.by_reason, `${group}|${result.reason ?? 'none'}`, () => ({ swaps: 0, analyzed: 0, lost: 0, re_read: 0 }))
    groupStat.swaps++
    reasonStat.swaps++
    if (result.no_before) out.no_before++
    if (result.no_after) out.no_after++
    if (result.no_before || result.no_after) continue
    out.swaps_analyzed++
    groupStat.analyzed++
    reasonStat.analyzed++
    groupStat.lost += result.lost.length
    groupStat.re_read += result.re_read.length
    groupStat.blocker_after_swap += result.blocker_after_swap
    reasonStat.lost += result.lost.length
    reasonStat.re_read += result.re_read.length
    out.blocker_after_swap += result.blocker_after_swap
    const reread = new Map(result.re_read.map(item => [item.key, item]))
    const loose = new Map(result.re_read_loose.map(item => [item.key, item]))
    const targets = (fact) => {
      if (fact.kind === 'tool') {
        const list = [bucket(toolStats, fact.name, newStat)]
        list[0].family ??= fact.family
        if (fact.family) list.push(bucket(familyStats, fact.family, newStat))
        return list
      }
      if (fact.kind === 'receipt') return [out.receipts]
      return [bucket(blockStats, fact.name, newStat)]
    }
    for (const fact of [...result.carried, ...result.lost]) {
      const lostFact = result.lost.includes(fact)
      for (const stat of targets(fact)) {
        stat.present++
        if (!lostFact) {
          stat.carried++
          if (fact.via === 'text') stat.carried_text++
          continue
        }
        stat.lost++
        stat.chars_lost += fact.chars
        const cell = bucket(stat.by_group, group, () => ({ lost: 0, re_read: 0 }))
        cell.lost++
        groupStat.chars_lost += fact.chars
        const hit = reread.get(fact.key)
        if (hit) {
          stat.re_read++
          cell.re_read++
          stat.rounds.push(hit.rounds)
        }
        else if (loose.has(fact.key)) stat.re_read_loose++
      }
    }
    out.top.push({
      run: result.run,
      ts: result.ts,
      kind: result.kind,
      role: result.role,
      checkpoint: result.checkpoint,
      reason: result.reason,
      lost: result.lost.length,
      chars_lost: result.lost.reduce((sum, fact) => sum + fact.chars, 0),
      re_read: result.re_read.length,
      re_read_keys: result.re_read.map(item => item.key),
      blocker_after_swap: result.blocker_after_swap,
    })
  }
  for (const map of [out.tools, out.families, out.blocks]) {
    for (const key of Object.keys(map)) map[key] = finishStat(map[key])
  }
  out.receipts = finishStat(out.receipts)
  out.top.sort((a, b) => b.re_read - a.re_read || b.chars_lost - a.chars_lost)
  out.top = out.top.slice(0, 25)
  return out
}

// ---------- rendering ----------

function redact(text) {
  return String(text).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|cloud)\b/gi, '<host>')
}

function pct(value) {
  return `${Math.round(value * 100)}%`
}

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
  return lines.join('\n')
}

function statRows(map, limit = 15, withFamily = true) {
  return Object.entries(map)
    .filter(([, stat]) => stat.lost > 0)
    .sort((a, b) => b[1].re_read - a[1].re_read || b[1].lost - a[1].lost)
    .slice(0, limit)
    .map(([name, stat]) => [
      name,
      ...(withFamily ? [stat.family ?? ''] : []),
      stat.present,
      stat.carried_text,
      stat.lost,
      stat.re_read,
      pct(stat.re_read_rate),
      stat.median_rounds ?? '-',
      stat.re_read_loose,
      stat.chars_lost,
    ])
}

export function renderMarkdown(agg, { top = 10 } = {}) {
  const lines = ['# Restage loss report (advisory)', '']
  lines.push(`Swaps: ${agg.swaps_total} total, ${agg.swaps_analyzed} analyzed (${agg.no_before} without a prior prompt, ${agg.no_after} without a prompt after). Blocker-mentioning assistant replies after swaps: ${agg.blocker_after_swap}.`, '')
  lines.push('## Swaps by kind/role', '')
  lines.push(table(['kind/role', 'swaps', 'analyzed', 'keys lost', 'keys re-read', 'chars lost', 'blocker replies'],
    Object.entries(agg.by_group).sort((a, b) => b[1].swaps - a[1].swaps)
      .map(([group, s]) => [group, s.swaps, s.analyzed, s.lost, s.re_read, s.chars_lost, s.blocker_after_swap])), '')
  lines.push('## Swaps by reason', '')
  lines.push(table(['kind/role|reason', 'swaps', 'analyzed', 'keys lost', 'keys re-read'],
    Object.entries(agg.by_reason).sort((a, b) => b[1].swaps - a[1].swaps)
      .map(([group, s]) => [group, s.swaps, s.analyzed, s.lost, s.re_read])), '')
  const headers = ['name', 'present before', 'carried via text', 'lost', 're-read', 're-read rate', 'median rounds', 'same tool other args', 'chars lost']
  lines.push('## Tools lost at a swap', '', table([headers[0], 'family', ...headers.slice(1)], statRows(agg.tools)), '')
  lines.push('## Tool families', '', table(headers, statRows(agg.families, 15, false)), '')
  lines.push('## Harness blocks (presence only; re-read does not apply)', '', table(headers, statRows(agg.blocks, 15, false)), '')
  lines.push(`## MOD receipts`, '', `present ${agg.receipts.present}, lost ${agg.receipts.lost}, chars lost ${agg.receipts.chars_lost}`, '')
  const groups = new Set()
  for (const stat of Object.values(agg.tools)) for (const group of Object.keys(stat.by_group)) groups.add(group)
  for (const group of [...groups].sort()) {
    const rows = Object.entries(agg.tools)
      .map(([name, stat]) => [name, stat.by_group[group]])
      .filter(([, cell]) => cell && cell.lost > 0)
      .sort((a, b) => b[1].re_read - a[1].re_read || b[1].lost - a[1].lost)
      .slice(0, 8)
      .map(([name, cell]) => [name, cell.lost, cell.re_read, pct(cell.lost ? cell.re_read / cell.lost : 0)])
    lines.push(`### ${group}: tools lost then re-read`, '', table(['tool', 'lost', 're-read', 'rate'], rows), '')
  }
  lines.push(`## Top ${top} swaps by re-reads`, '')
  lines.push(table(['run', 'ts', 'kind/role', 'checkpoint', 'reason', 'lost', 're-read', 'chars lost', 'blocker', 're-read keys'],
    agg.top.slice(0, top).map(item => [
      item.run,
      item.ts,
      `${item.kind}/${item.role ?? '?'}`,
      item.checkpoint ?? '-',
      item.reason,
      item.lost,
      item.re_read,
      item.chars_lost,
      item.blocker_after_swap,
      item.re_read_keys.map(key => (key.length > 70 ? `${key.slice(0, 70)}...` : key)).join('; ') || '-',
    ])), '')
  return redact(lines.join('\n'))
}

// ---------- CLI ----------

function resolveLogDirs(input) {
  const abs = path.resolve(input)
  const direct = [abs, path.join(abs, 'data', 'logs')].find(dir => fs.existsSync(path.join(dir, 'sgluna-prompts.jsonl')) || fs.existsSync(path.join(dir, 'sgluna-behavior.jsonl')))
  if (direct) return [direct]
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return []
  return fs.readdirSync(abs).sort().flatMap(child => resolveLogDirs(path.join(abs, child)).slice(0, 1))
}

function runName(logsDir) {
  const parts = path.resolve(logsDir).split(path.sep)
  const idx = parts.lastIndexOf('logs')
  const dir = idx >= 2 && parts[idx - 1] === 'data' ? parts[idx - 2] : parts[parts.length - 1]
  return dir.replace(/^red-automation-live-/, '')
}

export async function analyzeLogsDir(dir) {
  const prompts = await readJsonlFile(path.join(dir, 'sgluna-prompts.jsonl'))
  const behavior = await readJsonlFile(path.join(dir, 'sgluna-behavior.jsonl'))
  const run = runName(dir)
  if (prompts.missing || behavior.missing) return { run, skipped: true, results: [] }
  return { run, skipped: false, malformed: prompts.malformed + behavior.malformed, results: analyzeRun({ prompts: prompts.rows, behavior: behavior.rows, run }) }
}

export async function main(argv) {
  const json = argv.includes('--json')
  const inputs = argv.filter(arg => !arg.startsWith('--'))
  const dirs = inputs.flatMap(resolveLogDirs)
  const all = []
  let skipped = 0
  let malformed = 0
  for (const dir of dirs) {
    const analysis = await analyzeLogsDir(dir)
    if (analysis.skipped) {
      skipped++
      console.error(`skipped (missing logs): ${analysis.run}`)
      continue
    }
    malformed += analysis.malformed
    all.push(analysis.results)
  }
  const agg = { runs: all.length, skipped_runs: skipped, malformed_lines: malformed, ...aggregate(all) }
  process.stdout.write(json ? `${redact(JSON.stringify(agg, null, 2))}\n` : `${renderMarkdown(agg)}\n\nRuns: ${agg.runs}, malformed lines skipped: ${malformed}\n`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error) => {
    console.error(error?.message ?? error)
    process.exit(0)
  })
}
