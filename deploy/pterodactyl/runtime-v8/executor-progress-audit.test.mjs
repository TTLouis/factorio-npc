import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FakeFactorio, answersStepContract, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'
import { auditExecutorProgress, compareProgress, progressObligationKey, progressVector, preservationTravelConflict, PROGRESS_AUDIT_LIMITS } from './executor-progress-audit.mjs'
import { configuration } from './supervisor.mjs'

const KEY = 'npc:audit'
function world({ gains = [0, 0, 10], target = 10, sameApproach = false, enabled = true, stateFile = null, onTrace } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const game = new FakeFactorio()
  game.status.connected_players = 0
  const calls = []; const rows = []
  let reviewed = false
  const checkpoint = inventoryCheckpoint('iron-ore', target)
  const description = `Gather ${target} iron ore`
  const agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'audit', completionProtocolVersion: 3,
    executorProgressAudit: enabled, allowEphemeralProgressAudit: !stateFile, stateFile, traceFile: null, decisionTraceFile: null,
    systemPrompt: 'Scripted offline progress audit fixture.', maxContinuations: 64,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (messages, context) => {
      calls.push({ role: context.role, messages: structuredClone(messages) })
      if (context.role === 'planner' && !getActivePlan(memory.planningState(KEY))) return planReply({
        plan: [description, 'Gather one copper ore'], operations: [],
        goal: { scope: 'long_horizon', summary: 'Launch a rocket', doneWhen: [{ kind: 'rockets_launched', minimum: 1 }] },
        roadmap: [{ id: 'ore', intent: 'Acquire ore' }],
        stepCompletions: [checkpoint, inventoryCheckpoint('copper-ore', 1)].map(checkpoint => ({ kind: 'deterministic', checkpoint })),
        executionGuidance: [description, 'Gather one copper ore'].map(approach => ({ approach, rationale: 'Use native inventory.', constraints: [], skillIds: [], materialSupply: null })) })
      const plan = getActivePlan(memory.planningState(KEY))
      if (context.role === 'planner') {
        reviewed = true
        return planReply({ plan: [], operations: [], chatMessage: 'Use the smaller supported gather batch; do not repeat the failed search.' })
      }
      const step = plan.steps[plan.active_step_index]
      return planReply({ stepId: step.step_id, operations: [gather(plan.active_step_index ? 'copper-ore' : 'iron-ore', reviewed && !sameApproach ? 5 : 10)] })
    }) })
  game.onMutation = () => { game.inventory['iron-ore'] = (game.inventory['iron-ore'] ?? 0) + (gains[game.batchId - 1] ?? 0) }
  agent.behaviorTrace = { emit: async row => { rows.push(row); await onTrace?.(row, agent) } }
  return { agent, memory, game, calls, rows, start: () => agent.request('Launch a rocket, starting with iron ore.', { sender: 'Louis' }),
    episode: () => [...(memory.progressAudits?.values() ?? [])][0] }
}

test('reconciled no-progress retry requests planner refinement and valid work then closes the original step', async () => {
  const w = world()
  await w.start()
  assert.equal(w.game.mutations.length, 1)
  await w.agent.completed()
  assert.equal(w.game.mutations.length, 2, 'first miss receives one retry')
  await w.agent.completed()
  assert.equal(w.game.mutations.length, 3)
  assert.equal(w.episode().reviews, 1)
  const review = w.calls.find(row => row.role === 'planner' && row.messages.some(m => String(m.content).includes('harness_progress_audit')))
  assert.ok(review, 'actual planner receives native before/after facts and original attempts')
  await w.agent.completed()
  assert.equal(getActivePlan(w.memory.planningState(KEY)).active_step_index, 1)
  assert.deepEqual(w.episode().history.map(row => row.decision), ['no_progress', 'no_progress', 'progress'])
  assert.equal(w.episode().history.at(-1).complete, true)
})

test('progress buys bounded continuation, while identical post-review approach is refused before transport', async () => {
  const progressing = world({ gains: [2, 2, 6] })
  await progressing.start(); await progressing.agent.completed(); await progressing.agent.completed(); await progressing.agent.completed()
  assert.equal(progressing.episode().reviews, 0)
  assert.deepEqual(progressing.episode().history.map(row => row.decision), ['progress', 'progress', 'progress'])
  const stuck = world({ sameApproach: true })
  await stuck.start(); await stuck.agent.completed(); const result = await stuck.agent.completed()
  assert.equal(stuck.game.mutations.length, 2)
  assert.equal(result.goalStatus, 'paused')
  assert.ok(stuck.rows.some(row => row.event === 'executor.progress_audit' && row.data.reason === 'unchanged_failed_approach'))
})

test('durable attempt cap terminates even with verified progress', async () => {
  const w = world({ gains: Array.from({ length: 8 }, () => 5), target: 100 })
  await w.start()
  for (let i = 0; i < PROGRESS_AUDIT_LIMITS.attempts; i++) await w.agent.completed()
  assert.equal(w.game.mutations.length, PROGRESS_AUDIT_LIMITS.attempts)
  assert.equal(w.episode().attempts, PROGRESS_AUDIT_LIMITS.attempts)
  assert.ok(w.rows.some(row => row.event === 'executor.progress_audit' && row.data.reason === 'attempt_limit_exhausted'))
})

test('restart preserves claimed attempt and consumes exact receipt only once', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'progress-audit-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const w = world({ gains: [2, 2], stateFile: path.join(dir, 'state.json') })
  await w.start()
  const saved = JSON.parse(await fsp.readFile(w.agent.stateFile, 'utf8'))
  const restored = new CanonicalTaskBoardMemory(); restored.restore(saved)
  assert.equal(restored.progressAuditFault, false)
  w.agent.memory = restored
  await w.agent.taskStatusReceipt()
  await auditExecutorProgress(w.agent)
  await auditExecutorProgress(w.agent)
  const episode = [...restored.progressAudits.values()][0]
  assert.equal(episode.attempts, 1)
  assert.equal(episode.history.length, 1)
  assert.equal(episode.history[0].decision, 'progress')
})

test('unknown, busy, partial and superseded receipts cannot grant another execution', async () => {
  for (const mode of ['busy', 'uncertain', 'stale']) {
    const w = world({ gains: [2] })
    await w.start()
    if (mode === 'busy') w.game.craftingStatus = { task_active: true, native_queue: [{ count: 1 }] }
    if (mode === 'uncertain') w.game.admissions[0].state = 'uncertain'
    if (mode === 'stale') w.game.status.epoch++
    await w.agent.completed().catch(error => { assert.match(error.message, /epoch|stale|superseded/i) })
    assert.equal(w.game.mutations.length, 1, mode)
  }
  let replace = false
  const w = world({ gains: [2], onTrace: (row, agent) => {
    if (replace && row.event === 'executor.progress_audit') { agent.traceRequest = { id: 'replacement' }; replace = false }
  } })
  await w.start(); replace = true
  await assert.rejects(w.agent.completed(), /cancelled|superseded/i)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.agent.traceRequest.id, 'replacement')
})

test('high-water comparison rejects oscillation, noise and stale facts; canonical obligation ignores IDs/order', () => {
  const contract = inventoryCheckpoint('iron-ore', 100)
  const facts = count => ({ iron_ore_target: null, 'iron-ore_target': { kind: 'inventory_count', authoritative: true, item_name: 'iron-ore', current: count } })
  const vector = count => progressVector(contract, facts(count))
  const episode = { baseline: vector(0), previous: vector(0), peak: vector(10) }
  assert.equal(compareProgress(contract, episode, vector(10)), 'no_progress')
  assert.equal(compareProgress(contract, episode, vector(11)), 'no_progress')
  assert.equal(compareProgress(contract, episode, vector(15)), 'progress')
  assert.equal(progressVector(contract, { 'iron-ore_target': { ...facts(20)['iron-ore_target'], stale: true } }), undefined)
  assert.equal(progressObligationKey(contract), progressObligationKey({ ...contract, requirements: contract.requirements.map(row => ({ ...row, id: 'new-id' })) }))
  const restored = new CanonicalTaskBoardMemory(); restored.restore({ ...restored.snapshot(), executor_progress_audits: [['bad', {}]] })
  assert.equal(restored.progressAuditFault, true)
})

test('shared travel prevention refuses opaque excursions while preserving local work', () => {
  const step = { obligations: { preserve: [1] }, obligation_proof: { preserved: [{ entity: { position: { x: 0, y: 0 } } }] } }
  assert.equal(preservationTravelConflict(step, [gather('coal')]), true)
  assert.equal(preservationTravelConflict(step, [{ name: 'walk_to_position', args: { x: 100, y: 0 } }]), true)
  assert.equal(preservationTravelConflict(step, [{ name: 'walk_to_position', args: { x: 2, y: 0 } }]), false)
  assert.equal(preservationTravelConflict(step, [{ name: 'craft_item', args: { recipe_name: 'gear', count: 1 } }]), false)
  assert.equal(preservationTravelConflict(step, [{ name: 'place_entity', args: { x: 100, y: 0 } }]), true)
  assert.equal(preservationTravelConflict(step, [{ name: 'move_items_exact', args: { unit_number: 23 } }], () => ({ position: { x: 100, y: 0 } })), true)
})

test('disabled baseline repeats idle work without automatic review; pending review cannot be lost across restore', async () => {
  const baseline = world({ enabled: false, gains: [0, 0, 0] })
  await baseline.start(); await baseline.agent.completed(); await baseline.agent.completed()
  assert.equal(baseline.game.mutations.length, 3)
  assert.equal(baseline.calls.filter(call => call.role === 'planner').length, 1, 'old behavior never consulted planner after the retry')
  let interrupt = false
  const w = world({ onTrace: row => {
    if (interrupt && row.event === 'executor.progress_audit' && row.data.reason === 'no_verified_progress') throw new Error('injected interruption before planner handoff')
  } })
  await w.start(); await w.agent.completed(); interrupt = true
  await assert.rejects(w.agent.completed(), /injected interruption/)
  const saved = w.memory.snapshot()
  w.memory.restore(saved); interrupt = false
  assert.equal(w.episode().state, 'review')
  assert.equal(w.episode().reviews, 1)
  const result = await auditExecutorProgress(w.agent)
  assert.equal(result.goalStatus, 'paused')
  assert.equal(w.game.mutations.length, 2)
  assert.equal(w.calls.filter(call => call.role === 'planner').length, 1, 'interrupted review cannot create an extra planner allowance')
})

test('persistence failure before transport consumes no world action and cannot permit later execution', async () => {
  const w = world()
  const persist = w.agent.persistState.bind(w.agent)
  w.agent.persistState = async options => {
    if (w.episode()?.state === 'claimed') throw new Error('injected write failure')
    return persist(options)
  }
  await w.start().catch(error => assert.match(error.message, /write failure/))
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.progressAuditFault, true)
})

test('experimental configuration is off by default and environment takes precedence', () => {
  const env = { OPENAI_API_KEY: 'fixture-key-xxxxxxxxxxxxxxxxxxxx', OPENAI_API_BASEURL: 'https://provider.invalid/v1' }
  assert.equal(configuration({}, env).executorProgressAudit, false)
  assert.equal(configuration({ executorProgressAudit: true }, env).executorProgressAudit, true)
  assert.equal(configuration({ executorProgressAudit: true }, { ...env, SGLUNA_EXECUTOR_PROGRESS_AUDIT: 'false' }).executorProgressAudit, false)
})
