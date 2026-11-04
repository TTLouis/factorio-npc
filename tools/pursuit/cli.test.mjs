import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { OPERATOR_TOOL_METHODS } from '../../deploy/pterodactyl/runtime-v8/operator-tool-surface.mjs'
import { RED_SCIENCE_AUTOMATION_GOAL } from '../../deploy/pterodactyl/runtime-v8/pursuit-supervisor.mjs'
import { main, parseProfile, worldIdForSession } from './cli.mjs'

const SESSION = 'external-00000000-0000-4000-8000-0000000000aa'
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

async function fixture({ replies, satisfied = true, profile = {} }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pursuit-cli-'))
  const profilePath = path.join(dir, 'profile.json')
  await fs.writeFile(profilePath, JSON.stringify({ runId: 'run-1', goalId: 'goal-1', model: 'operator-model', brief: 'BRIEF', wallCapMs: 600000,
    goal: RED_SCIENCE_AUTOMATION_GOAL, ...profile }))
  const env = { SGLUNA_RCON_PASSWORD: 'test-password', EXTERNAL_HARNESS_SESSION: SESSION, EXTERNAL_HARNESS_STATE_DIR: path.join(dir, 'state'),
    OPERATOR_PROVIDER_BASE: 'http://127.0.0.1:8317/v1', CLI_PROXY_GATEWAY_KEY: 'test-gateway-key' }
  const runtime = { closed: 0, close: async () => { runtime.closed++ } }
  for (const method of Object.values(OPERATOR_TOOL_METHODS)) runtime[method] = async () => ({ ok: true, method })
  const out = []
  const deps = {
    rcon: { command: async () => '{}' }, runtime,
    complete: async () => { const next = replies.shift(); if (!next) throw new Error('exhausted'); return next },
    evaluate: async definition => ({ satisfied, baselines: {}, results: definition.done_when.map(row => ({ id: row.id, kind: row.kind, satisfied })) }),
    stdout: { write: line => out.push(line) }, stopPollMs: 20,
  }
  return { dir, profilePath, env, deps, out, runtime, goalDir: path.join(dir, 'state', 'pursuit', 'goal-1') }
}

async function evidence(goalDir) {
  return (await fs.readFile(path.join(goalDir, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

test('profile requires explicit ids, model, brief, wall cap and goal', () => {
  const ok = { runId: 'r', goalId: 'g', model: 'm', brief: 'b', wallCapMs: 60000, goal: {} }
  assert.equal(parseProfile(ok).goalId, 'g')
  for (const bad of [{ ...ok, goal: undefined }, { ...ok, wallCapMs: 10 }, { ...ok, key: 'x' }, { ...ok, goalId: '../x' }, { ...ok, brief: '' }]) {
    assert.throws(() => parseProfile(bad))
  }
  assert.match(worldIdForSession(SESSION), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(worldIdForSession(SESSION), worldIdForSession(SESSION))
})

test('a run is accepted natively, persists state and evidence, and reports controller stop', async () => {
  const t = await fixture({ replies: [
    { message: { tool_calls: [call('a', 'factorio_submit', { request_id: 'r1', operation: { name: 'wait', args: { ticks: 60 } } })] }, usage: { prompt_tokens: 100, completion_tokens: 5 } },
    { message: { tool_calls: [call('b', 'updateNotebook', { scope: 'goal', expectedRevision: 0, text: 'note' })] } },
    { message: { content: 'Running.' } },
  ] })
  const report = await main(['--profile', t.profilePath], t.env, t.deps)
  assert.deepEqual(report, { stopped: true, goalId: 'goal-1', session: SESSION, outcome: 'accepted', stop_cause: null })
  assert.deepEqual(JSON.parse(t.out[0]), report)
  assert.equal(t.runtime.closed, 1)
  const state = JSON.parse(await fs.readFile(path.join(t.goalDir, 'state.json'), 'utf8'))
  assert.equal(state.pursuit.outcome, 'accepted')
  assert.equal(state.requests, 3)
  const notebook = JSON.parse(await fs.readFile(path.join(t.goalDir, 'notebook.json'), 'utf8'))
  assert.equal(notebook.records[0].goal.text, 'note')
  const events = await evidence(t.goalDir)
  assert.ok(events.every(event => event.run_id === 'run-1' && event.goal_id === 'goal-1' && event.session === SESSION && event.ts))
  const types = events.map(event => event.type)
  assert.equal(types[0], 'pursuit_started')
  assert.equal(types.at(-1), 'controller_stop')
  assert.ok(types.includes('goal_evaluated') && types.includes('tool_result') && types.includes('provider_response'))
  // Requests log only new messages: seed (2), then assistant+tool each round.
  const requests = events.filter(event => event.type === 'provider_request')
  assert.deepEqual(requests.map(event => event.new_messages.length), [2, 2, 2])
  assert.deepEqual(requests.map(event => event.message_count), [2, 4, 6])
  const submit = events.find(event => event.type === 'tool_result' && event.tool === 'factorio_submit')
  assert.deepEqual(submit.arguments, { request_id: 'r1', operation: { name: 'wait', args: { ticks: 60 } } })
  const text = JSON.stringify(events)
  assert.doesNotMatch(text, /test-gateway-key|test-password|127\.0\.0\.1:8317/)
})

test('a finished goal is not run again on restart', async () => {
  const t = await fixture({ replies: [{ message: { content: 'done' } }] })
  await main(['--profile', t.profilePath], t.env, t.deps)
  const again = await main(['--profile', t.profilePath], t.env, { ...t.deps, complete: async () => { throw new Error('must not call the model') } })
  assert.equal(again.outcome, 'accepted')
})

test('a matching STOP request aborts the run and reports its cause', async () => {
  const t = await fixture({ replies: [], satisfied: false })
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.deps.complete = async ({ signal }) => {
    await fs.writeFile(path.join(t.goalDir, 'STOP'), JSON.stringify({ goalId: 'goal-1', session: SESSION }))
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    release()
    throw Object.assign(new Error('aborted'), { code: 'aborted' })
  }
  const report = await main(['--profile', t.profilePath], t.env, t.deps)
  await gate
  assert.equal(report.outcome, 'aborted')
  assert.equal(report.stop_cause, 'stop_request')
})

test('a STOP request for another session is ignored', async () => {
  const t = await fixture({ replies: [{ message: { content: 'done' } }] })
  await fs.mkdir(t.goalDir, { recursive: true })
  await fs.writeFile(path.join(t.goalDir, 'STOP'), JSON.stringify({ goalId: 'goal-1', session: 'other-session' }))
  assert.equal((await main(['--profile', t.profilePath], t.env, t.deps)).outcome, 'accepted')
})
