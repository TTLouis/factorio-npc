#!/usr/bin/env node
// Dangling context references (restage detectors, unit A1).
//
// Some observations are delivered relative to an earlier delivery: an entity
// status or nearby scan answered as a diff or "unchanged", a static prototype
// answered "already present in [STATIC_PROTOTYPE_CACHE]", a task receipt sent as
// a diff of the previous receipt. Each is readable only while the baseline it
// refers to is still in the prompt. A conversation swap (restage, planner
// resume, reasoning-epoch rebuild, capsule fallback, compaction) can drop the
// baseline and keep the reference; Run N stopped on exactly that shape
// (docs/validation/RED_AUTOMATION_LIVE_RUN_N_2026-10-15.md).
//
// The invariant checked here: every relative observation in one provider
// request resolves to a baseline somewhere in that same request. Pure: it reads
// the outgoing message array only and never repairs it. The loop traces each
// new violation as `context.dangling_reference`; run-check reports those rows;
// the CLI scans retained sgluna-prompts.jsonl files.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Severity 'high': the relative answer is meaningless without its baseline.
// 'low': a task-receipt diff still names the task state and queue; only the
// unchanged batch fields are unreadable.
export const DANGLING_REFERENCE_KINDS = Object.freeze({
  entity_status: { source: 'live_factorio_entity_status', baseline_marker: '[ENTITY_STATUS_BASELINE]', severity: 'high' },
  nearby_entities: { source: 'live_factorio_nearby_entities', baseline_marker: '[NEARBY_ENTITIES_BASELINE]', severity: 'high' },
  static_prototype: { source: 'runtime_static_prototype_cache', baseline_marker: '[STATIC_PROTOTYPE_CACHE]', severity: 'high' },
  task_status: { source: null, baseline_marker: null, severity: 'low' },
})

const RELATIVE_MODES = new Set(['diff', 'unchanged'])
const MODE_PATTERN = /"observation_mode"\s*:\s*"([a-z_]+)"/g
const PROTOTYPE_TOOL = 'getPrototypeDetails'

function contentText(message) {
  return typeof message?.content === 'string' ? message.content : ''
}

// Sorted keys, so the same query written in another key order still matches.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// The JSON object enclosing `index`, found by brace matching outside string
// literals. Receipts embed the observation in prose ("Detailed task receipt:
// {...}"), so a whole-message JSON.parse is not enough.
function enclosingObject(text, index) {
  let depth = 0
  let start = -1
  for (let at = index; at >= 0; at--) {
    const char = text[at]
    if (char === '}') depth++
    else if (char === '{') {
      if (depth === 0) { start = at; break }
      depth--
    }
  }
  if (start < 0) return undefined
  let inString = false
  let escaped = false
  depth = 0
  for (let at = start; at < text.length; at++) {
    const char = text[at]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, at + 1)) }
        catch { return undefined }
      }
    }
  }
  return undefined
}

function observationsIn(text) {
  const found = []
  if (!text.includes('observation_mode')) return found
  for (const match of text.matchAll(MODE_PATTERN)) {
    const object = enclosingObject(text, match.index)
    if (object && object.observation_mode === match[1]) found.push(object)
  }
  return found
}

function observationKey(object) {
  if (object.source === DANGLING_REFERENCE_KINDS.entity_status.source) {
    return typeof object.reference === 'string' ? { kind: 'entity_status', key: object.reference } : undefined
  }
  if (object.source === DANGLING_REFERENCE_KINDS.nearby_entities.source) {
    return object.query && typeof object.query === 'object' ? { kind: 'nearby_entities', key: canonical(object.query) } : undefined
  }
  if (object.source === DANGLING_REFERENCE_KINDS.static_prototype.source) {
    return typeof object.reference === 'string' ? { kind: 'static_prototype', key: object.reference } : undefined
  }
  if (object.source === undefined && Object.hasOwn(object, 'task_state')) return { kind: 'task_status', key: 'task_status' }
  return undefined
}

function baselineEntries(text, marker) {
  const at = text.indexOf(marker)
  if (at < 0) return []
  const newline = text.indexOf('\n', at)
  if (newline < 0) return []
  const rest = text.slice(newline + 1)
  const end = rest.lastIndexOf(']')
  try {
    const parsed = JSON.parse(rest.slice(0, end + 1))
    return Array.isArray(parsed) ? parsed : []
  }
  catch { return [] }
}

function toolCallNames(messages) {
  const calls = new Map()
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      let args
      try { args = JSON.parse(call?.function?.arguments ?? '{}') }
      catch { args = undefined }
      if (typeof call?.id === 'string') calls.set(call.id, { name: call?.function?.name, args })
    }
  }
  return calls
}

/**
 * The relative observations in one outgoing provider request whose baseline is
 * not in that request. The leading system messages are skipped: they describe
 * blocks, they never deliver observations.
 * @param {Array<{role: string, content?: unknown, tool_calls?: unknown[], tool_call_id?: string}>} messages
 * @returns {Array<{kind: string, severity: string, key: string, mode: string, message_index: number, role: string}>} one row per dangling reference
 */
export function findDanglingReferences(messages) {
  if (!Array.isArray(messages)) return []
  const provided = new Set()
  const relative = []
  const calls = toolCallNames(messages)
  let first = 0
  while (first < messages.length && messages[first]?.role === 'system') first++
  for (let index = first; index < messages.length; index++) {
    const message = messages[index]
    const text = contentText(message)
    if (!text) continue
    for (const kind of ['entity_status', 'nearby_entities', 'static_prototype']) {
      const marker = DANGLING_REFERENCE_KINDS[kind].baseline_marker
      if (!text.includes(marker)) continue
      for (const entry of baselineEntries(text, marker)) {
        const key = kind === 'nearby_entities' ? (entry?.query && canonical(entry.query)) : entry?.reference
        if (typeof key === 'string') provided.add(`${kind}\u0000${key}`)
      }
    }
    if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id)
      if (call?.name === PROTOTYPE_TOOL && typeof call.args?.name === 'string') {
        // A raw read is a baseline whatever its shape; the cache path answers in
        // observation modes and is handled below.
        if (!text.includes('"observation_mode"')) provided.add(`static_prototype\u0000prototype:${call.args.name.slice(0, 200)}`)
      }
    }
    for (const object of observationsIn(text)) {
      const ref = observationKey(object)
      if (!ref) continue
      const id = `${ref.kind}\u0000${ref.key}`
      if (RELATIVE_MODES.has(object.observation_mode)) relative.push({ ...ref, id, mode: object.observation_mode, message_index: index, role: message.role })
      else provided.add(id)
    }
  }
  const dangling = []
  const reported = new Set()
  for (const item of relative) {
    if (provided.has(item.id)) continue
    const once = `${item.id}\u0000${item.message_index}`
    if (reported.has(once)) continue
    reported.add(once)
    dangling.push({
      kind: item.kind,
      severity: DANGLING_REFERENCE_KINDS[item.kind].severity,
      key: item.key.slice(0, 200),
      mode: item.mode,
      message_index: item.message_index,
      role: item.role,
    })
  }
  return dangling
}

// --- retained prompt logs -------------------------------------------------------------------

function parseLines(text) {
  const rows = []
  let errors = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) }
    catch { errors++ }
  }
  return { rows, errors }
}

const SWAP_EVENTS = new Set(['context.restaged', 'context.planner_resumed', 'planning.reasoning_epoch_reset', 'budget.handoff_restage_fallback'])

/**
 * Scan one run's sgluna-prompts.jsonl rows. A violation repeats in every later
 * round that still carries the message, so each (request, kind, key, message
 * content) is reported once, at its first round, with the last conversation
 * swap traced before it in the same request (when behavior rows are given).
 */
export function scanPromptRows(promptRows, behaviorRows = []) {
  const swaps = behaviorRows
    .filter(row => SWAP_EVENTS.has(row?.event))
    .map(row => ({ event: row.event, ts: Date.parse(row.ts), request_id: row.request_id ?? row.data?.request_id }))
    .filter(row => Number.isFinite(row.ts))
    .sort((a, b) => a.ts - b.ts)
  const seen = new Set()
  const findings = []
  let requests = 0
  for (const row of promptRows) {
    const messages = row?.payload?.messages
    if (row?.event !== 'provider.request' || !Array.isArray(messages)) continue
    requests++
    for (const item of findDanglingReferences(messages)) {
      const body = contentText(messages[item.message_index]).slice(0, 400)
      const id = `${row.request_id}\u0000${item.kind}\u0000${item.key}\u0000${body}`
      if (seen.has(id)) continue
      seen.add(id)
      const ts = Date.parse(row.ts)
      const swap = [...swaps].reverse().find(candidate => candidate.ts <= ts && (!candidate.request_id || candidate.request_id === row.request_id))
      findings.push({ ...item, request_id: row.request_id, round: row.round, ts: row.ts, after_swap: swap?.event })
    }
  }
  return { requests, findings }
}

async function readRows(file) {
  try { return parseLines(await readFile(file, 'utf8')) }
  catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], errors: 0, missing: true }
    throw error
  }
}

function logsDir(dir) {
  return path.basename(dir) === 'logs' ? dir : path.join(dir, 'data', 'logs')
}

async function main(argv) {
  const json = argv.includes('--json')
  const dirs = argv.filter(arg => arg !== '--json')
  if (dirs.length === 0) {
    console.error('usage: context-references.mjs <run-dir|logs-dir>... [--json]')
    process.exitCode = 2
    return
  }
  const runs = []
  for (const dir of dirs) {
    const logs = logsDir(dir)
    const prompts = await readRows(path.join(logs, 'sgluna-prompts.jsonl'))
    const behavior = await readRows(path.join(logs, 'sgluna-behavior.jsonl'))
    if (prompts.missing) { runs.push({ run: path.basename(dir), missing: true }); continue }
    runs.push({ run: path.basename(dir), parse_errors: prompts.errors + behavior.errors, ...scanPromptRows(prompts.rows, behavior.rows) })
  }
  if (json) {
    console.log(JSON.stringify(runs, null, 2))
  }
  else {
    for (const run of runs) {
      if (run.missing) { console.log(`${run.run}: no sgluna-prompts.jsonl`); continue }
      const byKind = {}
      for (const finding of run.findings) byKind[`${finding.kind}/${finding.after_swap ?? 'no_swap'}`] = (byKind[`${finding.kind}/${finding.after_swap ?? 'no_swap'}`] ?? 0) + 1
      console.log(`${run.run}: requests=${run.requests} dangling=${run.findings.length} ${JSON.stringify(byKind)}${run.parse_errors ? ` parse_errors=${run.parse_errors}` : ''}`)
    }
  }
  process.exitCode = runs.some(run => run.findings?.some(finding => finding.severity === 'high')) ? 1 : 0
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`context-references failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  })
}
