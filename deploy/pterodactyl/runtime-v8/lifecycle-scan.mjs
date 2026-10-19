#!/usr/bin/env node
// Lifecycle projection scan (restage detectors, advisory).
//
// Projects an NPC's lifecycle state offline from a run's behaviour trace and
// tabulates which lifecycle EVENTS happened in which STATE. The trace has no
// lifecycle snapshot yet, so each axis starts 'unknown' and moves only on
// positive evidence (a pause row, a resume row, a persisted plan, ...). A few
// known-bad (event, state) pairs are flagged: the executor restaged onto a
// paused plan (run H), a checkpoint persisted against a closed goal (run J),
// a batch sent while paused or while another batch is still in flight.
//
// Once a runtime ships `lifecycle.entered` rows ({ event, state }), those rows
// name the event and their state axes win over the projection.
//
// Advisory only: the CLI always exits 0 and reads retained logs, never writes.

import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GOAL_VALUES = new Set(['none', 'active', 'paused', 'completed', 'blocked', 'cancelled', 'other', 'unknown'])
const RUN_VALUES = new Set(['running', 'paused', 'unknown'])
const ROLE_VALUES = new Set(['planner', 'executor', 'unknown'])
const BATCH_VALUES = new Set(['idle', 'in_flight', 'unknown'])
const REQUEST_VALUES = new Set(['active', 'idle', 'unknown'])

// Player "continue" arrives as a request with this intent; every other intent
// (new_goal, amend_current, ...) says nothing about the pause.
const CONTINUE_INTENTS = new Set(['continue_current'])

const SIMPLE_EVENTS = {
  'request.received': 'request.start',
  'context.planner_resumed': 'planner.return',
  'factorio.completion_continuation': 'continuation',
  'factorio.error_continuation': 'continuation',
  'planning.slice_completion_continuation': 'continuation',
  'step.checkpoint_validated': 'checkpoint.persist',
  'step.checkpoint_change_ignored': 'checkpoint.persist',
  'operation.pending_recorded': 'batch.send',
  'runtime.recovery_started': 'recovery.interrupted',
  'recovery.auto_resume_started': 'auto_resume.start',
  'request.cancelled': 'reset',
}

export function initialState() {
  return { goal: 'unknown', run: 'unknown', pause_class: null, role: 'unknown', batch: 'unknown', request: 'unknown' }
}

export function stateKey(state) {
  return `goal=${state.goal} run=${state.run} pause=${state.pause_class ?? '-'} role=${state.role} batch=${state.batch} request=${state.request}`
}

// pause_class is printed, so only identifier-shaped strings pass through.
function cleanClass(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,40}$/.test(value) ? value : null
}

// A trace with lifecycle.entered rows names its events itself; the older rows still move the state but
// would count the same event twice.
function lifecycleEventFor(row, entered = false) {
  const data = row?.data
  if (row?.event === 'lifecycle.entered') {
    if (typeof data?.event !== 'string' || !data.event) return null
    return data.event === 'restage' && (data.role === 'executor' || data.role === 'planner') ? `restage.${data.role}` : data.event
  }
  if (entered) return null
  if (row?.event === 'context.restaged') {
    return data?.role === 'executor' || data?.role === 'planner' ? `restage.${data.role}` : null
  }
  return SIMPLE_EVENTS[row?.event] ?? null
}

// Applies one row's evidence to `state` in place.
function applyRow(state, row) {
  const data = row?.data ?? {}
  switch (row?.event) {
    case 'goal.paused':
      state.run = 'paused'
      state.goal = 'paused'
      state.pause_class = cleanClass(data.pause_class)
      break
    case 'recovery.auto_resume_plan_resumed':
      state.run = 'running'
      state.goal = 'active'
      state.pause_class = null
      break
    case 'plan.persisted': {
      const status = data.task_board?.status
      if (status === 'active' || status === 'paused' || status === 'completed') state.goal = status
      else if (data.task_board && typeof data.task_board === 'object') state.goal = 'unknown'
      break
    }
    case 'context.restaged':
      if (data.role === 'executor' || data.role === 'planner') state.role = data.role
      break
    case 'context.planner_resumed':
      state.role = 'planner'
      break
    case 'operation.pending_recorded':
      state.batch = 'in_flight'
      break
    case 'operation.reconciled':
    case 'factorio.completed_signal':
      state.batch = 'idle'
      break
    case 'request.received':
      state.request = 'active'
      if (CONTINUE_INTENTS.has(data.interaction_intent) && (state.goal === 'paused' || state.run === 'paused')) {
        state.run = 'running'
        state.goal = 'active'
        state.pause_class = null
      }
      break
    case 'request.completed':
    case 'request.failed':
    case 'request.cancelled':
      state.request = 'idle'
      break
    case 'lifecycle.entered':
      mergeEntered(state, data.state)
      break
    default:
      break
  }
}

function mergeEntered(state, entered) {
  if (!entered || typeof entered !== 'object') return
  if (GOAL_VALUES.has(entered.goal)) state.goal = entered.goal
  if (RUN_VALUES.has(entered.run)) state.run = entered.run
  if (ROLE_VALUES.has(entered.role)) state.role = entered.role
  if (BATCH_VALUES.has(entered.batch)) state.batch = entered.batch
  if (REQUEST_VALUES.has(entered.request)) state.request = entered.request
  if ('pause_class' in entered) state.pause_class = cleanClass(entered.pause_class)
}

/**
 * Walk behaviour rows once. Each row that maps to a lifecycle event yields the
 * state BEFORE the row applies (except a `lifecycle.entered` row, whose own
 * state axes are merged into what is reported).
 */
export function projectLifecycle(rows) {
  const state = initialState()
  const projected = []
  const entered = rows.some(row => row?.event === 'lifecycle.entered')
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const lifecycleEvent = lifecycleEventFor(row, entered)
    if (lifecycleEvent) {
      const reported = { ...state }
      if (row.event === 'lifecycle.entered') mergeEntered(reported, row.data?.state)
      projected.push({ index, event: row.event, lifecycle_event: lifecycleEvent, state: reported })
    }
    applyRow(state, row)
  }
  return projected
}

const FLAG_RULES = [
  { kind: 'executor_restage_while_paused', test: (event, state) => event === 'restage.executor' && (state.run === 'paused' || state.goal === 'paused') },
  { kind: 'checkpoint_on_inactive_goal', test: (event, state) => event === 'checkpoint.persist' && (state.goal === 'completed' || state.goal === 'paused') },
  { kind: 'batch_send_while_paused', test: (event, state) => event === 'batch.send' && state.run === 'paused' },
  { kind: 'batch_send_while_in_flight', test: (event, state) => event === 'batch.send' && state.batch === 'in_flight' },
]

export const FLAG_KINDS = Object.freeze(FLAG_RULES.map(rule => rule.kind))

export function scanLifecycle(rows) {
  const pairs = new Map()
  const flags = []
  for (const item of projectLifecycle(rows)) {
    const key = stateKey(item.state)
    const id = `${item.lifecycle_event}\u0000${key}`
    const pair = pairs.get(id)
    if (pair) pair.count++
    else pairs.set(id, { lifecycle_event: item.lifecycle_event, state_key: key, count: 1, first_index: item.index })
    for (const rule of FLAG_RULES) {
      if (rule.test(item.lifecycle_event, item.state)) flags.push({ kind: rule.kind, index: item.index, event: item.lifecycle_event, state: item.state })
    }
  }
  return { pairs: [...pairs.values()], flags }
}

// --- retained behaviour logs --------------------------------------------------------------

export function parseLines(text) {
  const rows = []
  let errors = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row)
      else errors++
    }
    catch { errors++ }
  }
  return { rows, errors }
}

async function readBehavior(file) {
  try { return parseLines(await readFile(file, 'utf8')) }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') return { rows: [], errors: 0, missing: true }
    throw error
  }
}

function behaviorFile(input) {
  const abs = path.resolve(input)
  if (existsSync(abs) && statSync(abs).isFile()) return abs
  const logs = path.basename(abs) === 'logs' ? abs : path.join(abs, 'data', 'logs')
  return path.join(logs, 'sgluna-behavior.jsonl')
}

function runName(input) {
  const abs = path.resolve(input)
  const parts = abs.split(path.sep)
  const idx = parts.lastIndexOf('logs')
  const dir = idx >= 2 && parts[idx - 1] === 'data' ? parts[idx - 2] : path.basename(abs)
  return dir.replace(/^red-automation-live-/, '')
}

export async function scanRun(input) {
  const behavior = await readBehavior(behaviorFile(input))
  const run = runName(input)
  if (behavior.missing) return { run, missing: true, rows: 0, parse_errors: 0, pairs: [], flags: [] }
  return { run, rows: behavior.rows.length, parse_errors: behavior.errors, ...scanLifecycle(behavior.rows) }
}

export function flagCounts(flags) {
  const counts = Object.fromEntries(FLAG_KINDS.map(kind => [kind, 0]))
  for (const flag of flags) counts[flag.kind] = (counts[flag.kind] ?? 0) + 1
  return counts
}

export function totalsFor(runs) {
  const merged = new Map()
  const flags = []
  let rows = 0
  let parseErrors = 0
  for (const run of runs) {
    rows += run.rows
    parseErrors += run.parse_errors
    flags.push(...run.flags)
    for (const pair of run.pairs) {
      const id = `${pair.lifecycle_event}\u0000${pair.state_key}`
      const existing = merged.get(id)
      if (existing) existing.count += pair.count
      else merged.set(id, { lifecycle_event: pair.lifecycle_event, state_key: pair.state_key, count: pair.count })
    }
  }
  const pairs = [...merged.values()].sort((a, b) => b.count - a.count || a.lifecycle_event.localeCompare(b.lifecycle_event) || a.state_key.localeCompare(b.state_key))
  return { rows, parse_errors: parseErrors, flags: flagCounts(flags), pairs }
}

export async function main(argv) {
  const json = argv.includes('--json')
  const dirs = argv.filter(arg => !arg.startsWith('--'))
  if (dirs.length === 0) {
    console.error('usage: lifecycle-scan.mjs <run-dir|logs-dir>... [--json]')
    return 0
  }
  const runs = []
  for (const dir of dirs) runs.push(await scanRun(dir))
  const totals = totalsFor(runs)
  if (json) {
    console.log(JSON.stringify({ runs: runs.map(run => ({ ...run, flag_counts: flagCounts(run.flags) })), totals }, null, 2))
    return 0
  }
  for (const run of runs) {
    if (run.missing) { console.log(`${run.run}: no sgluna-behavior.jsonl`); continue }
    const counts = flagCounts(run.flags)
    const summary = FLAG_KINDS.map(kind => `${kind}=${counts[kind]}`).join(' ')
    console.log(`${run.run}: rows=${run.rows} ${summary}${run.parse_errors ? ` parse_errors=${run.parse_errors}` : ''}`)
    for (const flag of run.flags) console.log(`  ${flag.kind} row=${flag.index} ${stateKey(flag.state)}`)
  }
  console.log('')
  console.log(`total: rows=${totals.rows} ${FLAG_KINDS.map(kind => `${kind}=${totals.flags[kind]}`).join(' ')}${totals.parse_errors ? ` parse_errors=${totals.parse_errors}` : ''}`)
  console.log('count\tlifecycle_event\tstate')
  for (const pair of totals.pairs) console.log(`${pair.count}\t${pair.lifecycle_event}\t${pair.state_key}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error) => {
    console.error(`lifecycle-scan failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(0)
  })
}
