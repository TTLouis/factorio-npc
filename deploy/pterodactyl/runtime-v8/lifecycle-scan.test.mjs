import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FLAG_KINDS, main, parseLines, projectLifecycle, scanLifecycle, stateKey } from './lifecycle-scan.mjs'

const row = (event, data = {}) => ({ schema: 1, event, data })
const board = status => row('plan.persisted', { task_board: { status } })
const paused = (pauseClass = 'model_recoverable') => row('goal.paused', { pause_class: pauseClass })
const restage = role => row('context.restaged', { role })
const flagKinds = rows => scanLifecycle(rows).flags.map(flag => flag.kind)

test('maps each trace event to its lifecycle event', () => {
  const rows = [
    row('request.received', { interaction_intent: 'new_goal' }),
    restage('executor'),
    restage('planner'),
    row('context.planner_resumed'),
    row('factorio.completion_continuation'),
    row('factorio.error_continuation'),
    row('planning.slice_completion_continuation'),
    row('step.checkpoint_validated'),
    row('step.checkpoint_change_ignored'),
    row('operation.pending_recorded'),
    row('runtime.recovery_started'),
    row('recovery.auto_resume_started'),
    row('request.cancelled'),
  ]
  assert.deepEqual(projectLifecycle(rows).map(item => item.lifecycle_event), [
    'request.start',
    'restage.executor',
    'restage.planner',
    'planner.return',
    'continuation',
    'continuation',
    'continuation',
    'checkpoint.persist',
    'checkpoint.persist',
    'batch.send',
    'recovery.interrupted',
    'auto_resume.start',
    'reset',
  ])
})

test('rows without a lifecycle meaning are skipped; index is the row position', () => {
  const items = projectLifecycle([row('provider.request'), row('tool.call'), row('request.received'), restage('someone-else')])
  assert.deepEqual(items.map(item => [item.index, item.lifecycle_event]), [[2, 'request.start']])
})

test('every axis is unknown until positive evidence', () => {
  const [first] = projectLifecycle([row('step.checkpoint_validated')])
  assert.deepEqual(first.state, { goal: 'unknown', run: 'unknown', pause_class: null, role: 'unknown', batch: 'unknown', request: 'unknown' })
  assert.equal(stateKey(first.state), 'goal=unknown run=unknown pause=- role=unknown batch=unknown request=unknown')
})

test('state is the tuple BEFORE the row applies', () => {
  const items = projectLifecycle([restage('executor'), restage('planner'), row('request.received')])
  assert.equal(items[0].state.role, 'unknown')
  assert.equal(items[1].state.role, 'executor')
  assert.equal(items[2].state.role, 'planner')
  assert.equal(items[2].state.request, 'unknown')
})

test('goal.paused and auto-resume move run, goal and pause_class', () => {
  const rows = [
    paused('guard'),
    row('runtime.recovery_started'),
    row('recovery.auto_resume_plan_resumed'),
    row('runtime.recovery_started'),
  ]
  const [whilePaused, afterResume] = projectLifecycle(rows)
  assert.deepEqual([whilePaused.state.run, whilePaused.state.goal, whilePaused.state.pause_class], ['paused', 'paused', 'guard'])
  assert.deepEqual([afterResume.state.run, afterResume.state.goal, afterResume.state.pause_class], ['running', 'active', null])
})

test('a player continue request resumes a paused goal; other intents do not', () => {
  const [, afterNewGoal] = projectLifecycle([paused(), row('request.received', { interaction_intent: 'new_goal' }), restage('executor')])
  assert.equal(afterNewGoal.state.run, 'paused')
  const [, afterContinue] = projectLifecycle([paused(), row('request.received', { interaction_intent: 'continue_current' }), restage('executor')])
  assert.deepEqual([afterContinue.state.run, afterContinue.state.goal, afterContinue.state.pause_class], ['running', 'active', null])
  const [lone] = projectLifecycle([row('request.received', { interaction_intent: 'continue_current' }), row('request.received')])
  assert.equal(lone.state.run, 'unknown')
})

test('plan.persisted sets goal from task_board.status; other statuses are unknown', () => {
  const after = [board('active'), board('paused'), board('completed'), board('blocked'), row('plan.persisted', {})]
    .map(persist => projectLifecycle([row('request.cancelled'), persist, row('request.cancelled')])[1].state.goal)
  assert.deepEqual(after, ['active', 'paused', 'completed', 'unknown', 'unknown'])
})

test('context.restaged and planner_resumed set the role', () => {
  const items = projectLifecycle([restage('executor'), row('request.cancelled'), row('context.planner_resumed'), row('request.cancelled')])
  assert.deepEqual(items.map(item => item.state.role), ['unknown', 'executor', 'executor', 'planner'])
})

test('batch goes in_flight on pending_recorded and idle on reconcile or completed signal', () => {
  const rows = [
    row('operation.pending_recorded'),
    row('operation.pending_recorded'),
    row('operation.reconciled'),
    row('operation.pending_recorded'),
    row('factorio.completed_signal'),
    row('request.cancelled'),
  ]
  assert.deepEqual(projectLifecycle(rows).map(item => item.state.batch), ['unknown', 'in_flight', 'idle', 'idle'])
})

test('request axis follows received / completed / failed / cancelled', () => {
  const probe = row('step.checkpoint_validated')
  const states = [
    [row('request.received'), probe],
    [row('request.received'), row('request.completed'), probe],
    [row('request.received'), row('request.failed'), probe],
    [row('request.received'), row('request.cancelled'), probe],
  ].map(rows => projectLifecycle(rows).at(-1).state.request)
  assert.deepEqual(states, ['active', 'idle', 'idle', 'idle'])
})

test('run H shape: executor restaged onto a paused plan is flagged once per attempt', () => {
  const attempt = [
    row('recovery.auto_resume_started'),
    row('request.cancelled'),
    row('runtime.recovery_started'),
    restage('executor'),
  ]
  const rows = [restage('executor'), paused(), ...attempt, paused(), ...attempt]
  const flags = scanLifecycle(rows).flags
  assert.deepEqual(flags.map(flag => flag.kind), ['executor_restage_while_paused', 'executor_restage_while_paused'])
  assert.deepEqual(flags.map(flag => flag.index), [5, 10])
  assert.equal(flags[0].event, 'restage.executor')
  assert.equal(flags[0].state.pause_class, 'model_recoverable')
})

test('a resume between the pause and the restage clears the flag', () => {
  const rows = [paused(), row('recovery.auto_resume_started'), row('recovery.auto_resume_plan_resumed'), row('request.cancelled'), restage('executor')]
  assert.deepEqual(flagKinds(rows), [])
  assert.deepEqual(flagKinds([paused(), row('request.received', { interaction_intent: 'continue_current' }), restage('executor')]), [])
})

test('a planner restage on a paused plan is not flagged', () => {
  assert.deepEqual(flagKinds([paused(), restage('planner')]), [])
})

test('run J shape: goal reads completed after the completed board is persisted', () => {
  const rows = [
    row('request.received'),
    board('active'),
    board('completed'),
    row('request.time_split'),
    row('request.failed', { message: 'checkpoint_requires_active_step' }),
    row('request.cancelled'),
  ]
  const items = projectLifecycle(rows)
  assert.deepEqual(items.map(item => [item.index, item.state.goal, item.state.request]), [[0, 'unknown', 'unknown'], [5, 'completed', 'idle']])
  assert.deepEqual(flagKinds(rows), [])
})

test('checkpoint on a completed or paused goal is flagged, on an active goal is not', () => {
  assert.deepEqual(flagKinds([board('completed'), row('step.checkpoint_validated')]), ['checkpoint_on_inactive_goal'])
  assert.deepEqual(flagKinds([board('paused'), row('step.checkpoint_change_ignored')]), ['checkpoint_on_inactive_goal'])
  assert.deepEqual(flagKinds([board('active'), row('step.checkpoint_validated')]), [])
})

test('batch.send while paused or while in flight is flagged', () => {
  assert.deepEqual(flagKinds([paused(), row('operation.pending_recorded')]), ['batch_send_while_paused'])
  assert.deepEqual(flagKinds([row('operation.pending_recorded'), row('operation.pending_recorded')]), ['batch_send_while_in_flight'])
  assert.deepEqual(flagKinds([row('operation.pending_recorded'), row('operation.reconciled'), row('operation.pending_recorded')]), [])
  assert.deepEqual(new Set(FLAG_KINDS).size, 4)
})

test('pairs count each (event, state) with the first row index', () => {
  const { pairs } = scanLifecycle([restage('executor'), row('request.cancelled'), row('request.cancelled'), row('request.cancelled')])
  const resets = pairs.filter(pair => pair.lifecycle_event === 'reset')
  assert.deepEqual(resets.map(pair => [pair.count, pair.first_index, pair.state_key]), [
    [1, 1, 'goal=unknown run=unknown pause=- role=executor batch=unknown request=unknown'],
    [2, 2, 'goal=unknown run=unknown pause=- role=executor batch=unknown request=idle'],
  ])
})

test('lifecycle.entered rows name the event and their state axes win, merged over the projection', () => {
  const rows = [
    paused(),
    row('lifecycle.entered', { event: 'restage.executor', state: { run: 'running', goal: 'active', pause_class: null, role: 'executor' } }),
    row('lifecycle.entered', { event: 'batch.send', state: { batch: 'in_flight' } }),
    row('lifecycle.entered', { event: 'batch.send', state: { run: 'not-a-value' } }),
  ]
  const [restaged, send, junk] = projectLifecycle(rows)
  assert.equal(restaged.lifecycle_event, 'restage.executor')
  assert.equal(restaged.event, 'lifecycle.entered')
  assert.deepEqual(restaged.state, { goal: 'active', run: 'running', pause_class: null, role: 'executor', batch: 'unknown', request: 'unknown' })
  // The entered state also becomes the running projection; omitted axes keep what was projected.
  assert.equal(send.state.run, 'running')
  assert.equal(send.state.batch, 'in_flight')
  assert.equal(junk.state.run, 'running')
  assert.equal(junk.state.batch, 'in_flight')
  // The second and third batch.send each arrive with a batch already in flight.
  assert.deepEqual(flagKinds(rows), ['batch_send_while_in_flight', 'batch_send_while_in_flight'])
})

test('a lifecycle.entered state can expose a flag the projection missed', () => {
  const rows = [row('lifecycle.entered', { event: 'restage.executor', state: { run: 'paused' } })]
  assert.deepEqual(flagKinds(rows), ['executor_restage_while_paused'])
})

test('malformed lines, blanks and non-object rows are tolerated', () => {
  const { rows, errors } = parseLines('{"event":"request.received"}\n\nnot json\n[1,2]\n{"event":"request.cancelled"}\n"text"\n')
  assert.equal(rows.length, 2)
  assert.equal(errors, 3)
  assert.doesNotThrow(() => scanLifecycle([null, undefined, 3, {}, { event: 'goal.paused' }, { event: 'plan.persisted', data: null }]))
})

test('CLI --json shape on a temp run dir, with a missing run and a bad line', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lifecycle-scan-'))
  try {
    const logs = path.join(root, 'red-automation-live-2026-10-19zz', 'data', 'logs')
    await mkdir(logs, { recursive: true })
    const rows = [paused(), row('recovery.auto_resume_started'), restage('executor')]
    await writeFile(path.join(logs, 'sgluna-behavior.jsonl'), `${rows.map(r => JSON.stringify(r)).join('\n')}\nnot json\n`)
    await mkdir(path.join(root, 'empty-run'))

    const script = fileURLToPath(new URL('./lifecycle-scan.mjs', import.meta.url))
    const run = args => promisify(execFile)(process.execPath, [script, ...args])
    const { stdout } = await run([path.join(root, 'red-automation-live-2026-10-19zz'), path.join(root, 'empty-run'), '--json'])
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.runs.length, 2)
    const [first, second] = parsed.runs
    assert.equal(first.run, '2026-10-19zz')
    assert.equal(first.rows, 3)
    assert.equal(first.parse_errors, 1)
    assert.equal(first.flag_counts.executor_restage_while_paused, 1)
    assert.deepEqual(Object.keys(first.flags[0]), ['kind', 'index', 'event', 'state'])
    assert.deepEqual(Object.keys(first.pairs[0]), ['lifecycle_event', 'state_key', 'count', 'first_index'])
    assert.equal(second.missing, true)
    assert.equal(parsed.totals.rows, 3)
    assert.equal(parsed.totals.flags.executor_restage_while_paused, 1)
    assert.deepEqual(Object.keys(parsed.totals.pairs[0]), ['lifecycle_event', 'state_key', 'count'])

    const text = await run([path.join(root, 'red-automation-live-2026-10-19zz')])
    assert.match(text.stdout, /2026-10-19zz: rows=3 executor_restage_while_paused=1/)
    assert.match(text.stdout, /count\tlifecycle_event\tstate/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('main exits 0 and prints usage with no arguments', async () => {
  const originalError = console.error
  const lines = []
  console.error = line => lines.push(line)
  try { assert.equal(await main([]), 0) }
  finally { console.error = originalError }
  assert.match(lines[0], /usage: lifecycle-scan/)
})

test('a trace with runtime lifecycle.entered rows counts each event once and names a restage by its role', () => {
  const rows = [
    row('goal.paused', { pause_class: 'model_recoverable' }),
    row('lifecycle.entered', { event: 'restage', role: 'executor', state: { goal: 'paused', run: 'paused', role: 'planner' } }),
    row('context.restaged', { role: 'executor' }),
    row('lifecycle.entered', { event: 'batch.send', state: { goal: 'blocked', run: 'running', batch: 'idle' } }),
    row('operation.pending_recorded', {}),
  ]
  const projected = projectLifecycle(rows)
  assert.deepEqual(projected.map(item => item.lifecycle_event), ['restage.executor', 'batch.send'])
  assert.equal(projected[1].state.goal, 'blocked', 'the runtime goal values beyond the projection are kept')
  assert.deepEqual(scanLifecycle(rows).flags.map(flag => flag.kind), ['executor_restage_while_paused'])
})

test('a folded review handback puts the projected role back on the executor, and counts as an executor restage', () => {
  const items = projectLifecycle([restage('executor'), row('context.planner_resumed'), row('context.restage_folded', { role: 'executor', checkpoint: 'C8', folded_from: 'C3' }), row('request.cancelled')])
  assert.deepEqual(items.map(item => item.state.role), ['unknown', 'executor', 'planner', 'executor'])
  assert.deepEqual(items.map(item => item.lifecycle_event).filter(Boolean), ['restage.executor', 'planner.return', 'restage.executor', 'reset'])
})
