import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { FakeFactorio } from './task-loop-fixtures.mjs'

// Run BA (Terra planner): a next-slice draft preserved a wooden chest, the Jev wake_planner route redrafted without it,
// and that one route draft hit an ordinary plan_category refusal (A: later steps without obligations; B: an active
// checkpoint equal to the declared outcome only). The route had no correction round, so each lane guard-paused.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/run-ba-recovery-route.json', import.meta.url), 'utf8'))
const lane = name => fixture.lanes.find(row => row.lane === name)
// The live provider layer drops an empty tool_calls array before the loop sees the reply (provider-base.mjs).
function wireMessage(message) {
  const out = structuredClone(message)
  if (out.tool_calls === null || (Array.isArray(out.tool_calls) && out.tool_calls.length === 0)) delete out.tool_calls
  return out
}

function baWorld(row, replies) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(row.snapshot)
  const key = row.snapshot.planning_states[0].key
  const game = new FakeFactorio()
  const command = game.command.bind(game)
  const units = new Map(row.units.map(unit => [unit.unit_number, unit]))
  game.command = async text => {
    const geometry = /"entity_geometry",(\d+)/.exec(text)
    if (geometry) {
      const unit = units.get(Number(geometry[1]))
      if (!unit) return JSON.stringify({ found: false })
      const position = { x: unit.unit_number * 3 + 0.5, y: 0.5 }
      const routed = ['mining-drill', 'inserter'].includes(unit.type)
      return JSON.stringify({ found: true, entity: { ...unit, position, direction: 0 }, fluid_box_count: 0,
        ...(routed ? { item_io: { drop_position: { x: position.x, y: position.y - 1.5 }, drop_target: null } } : {}),
        actor_id: game.status.actor_id, actor_surface_index: 1, actor_force_index: 1, surface_index: 1, force_index: 1 })
    }
    return command(text)
  }
  const calls = []
  // The production loop options (supervisor.mjs) that decide which drafts are refused.
  const agent = new NpcAgentLoop({ memory, rcon: game, completionProtocolVersion: 3, executorObservationRate: true,
    requireTypedObligations: true, replacementWake: true,
    provider: async (...args) => {
      calls.push(args)
      const reply = replies[calls.length - 1]
      if (!reply) throw new Error(`unexpected provider call ${calls.length}`)
      return wireMessage(typeof reply === 'function' ? reply(w, args) : reply)
    },
    interactionDecisionProvider: async () => ({ answers: { recovery_semantics: { choice: 'semantic_replan', confidence: 0.99 }, one_observation_can_resolve: { noul: 0 } } }),
    systemPrompt: 'BA offline exact-state replay', npcId: 'npc-1', stateFile: null, traceFile: null, decisionTraceFile: null, goalDefinitionPolicy: 'required' })
  const rows = []
  agent.behaviorTrace = { emit: async entry => { rows.push(entry) } }
  agent.lastMemoryKey = key
  // The live conversation had these skill details loaded (the live draft citing them passed); their bodies are not
  // in the trace, so only the identities are restored.
  const cited = JSON.parse(row.wire.submit.message.tool_calls[0].function.arguments).executionGuidance.flatMap(brief => brief.skillIds)
  agent.loadedSkillContext = new Map(cited.map(id => [id, { id }]))
  const w = { memory, game, agent, key, rows, calls }
  return w
}
function startAuthoring(w) {
  w.agent.epoch = w.game.status
  w.agent.active = true
  w.agent.requestInfo = { memoryKey: w.key, turnId: w.memory.maxTurnId() + 1, sender: '<server>', text: w.memory.planningState(w.key).goal.objective }
  w.agent.traceRequest = { id: 'ba_next_slice_authoring', seq: 0 }
  w.agent.replaceConversation({ baseMessages: [{ role: 'system', content: 'offline exact BA' }, { role: 'user', content: 'The previous immutable slice is complete. Author the next ordinary slice.' }] })
  w.agent.planUpdateReason = 'completion'
}
const routeDraft = row => JSON.parse(row.wire.route.message.content)
const contentReply = draft => ({ role: 'assistant', content: JSON.stringify(draft) })
const harnessCorrections = args => args[0].filter(message => message.role === 'user' && String(message.content).startsWith('[HARNESS] Recovery draft refused'))
const newPlans = (planning, before) => planning.plans.filter(plan => !before.some(old => old.plan_id === plan.plan_id))
const events = (w, name) => w.rows.filter(entry => entry.event === name)
const STOP = 'offline replay stops at the next model turn'
// Answers the next model call after the route: records what was durable then and ends the replay there.
function stopAt(seen) {
  return (w, args) => {
    seen.role = args[1]?.role ?? w.agent.agentContext.role
    seen.planning = structuredClone(w.memory.planningState(w.key))
    seen.pause = structuredClone(w.memory.pauseRecord(w.key))
    throw new Error(STOP)
  }
}
const fromPreservationRefusal = w => assert.deepEqual(events(w, 'replan.started').map(entry => entry.data.reason), ['preservation_type_unsupported'])
// Scripted correction (Terra never got this round): its route draft with obligations on every later step.
function correctedLaneA(row) {
  const fixed = routeDraft(row)
  const submitted = JSON.parse(row.wire.submit.message.tool_calls[0].function.arguments)
  fixed.stepCompletions = fixed.stepCompletions.map((declaration, index) => index === 0 ? declaration
    : { kind: 'deterministic', obligations: { outcome: submitted.stepCompletions[index].obligations.outcome, preserve: [] } })
  return contentReply(fixed)
}

test('BA lane B exact Terra route draft commits with the harness-compiled preservation rows', async () => {
  const row = lane('b')
  const seen = {}
  const w = baWorld(row, [row.wire.submit.message, row.wire.route.message, stopAt(seen)])
  const before = structuredClone(w.memory.planningState(w.key).plans)
  startAuthoring(w)
  await assert.rejects(w.agent.runGuarded(), new RegExp(STOP))
  fromPreservationRefusal(w)
  assert.equal(seen.role, 'executor')
  assert.notEqual(seen.pause.paused, true)
  const [committed] = newPlans(seen.planning, before)
  assert.equal(committed.status, 'COMMITTED')
  const contract = committed.steps[0].completion_contract
  assert.deepEqual(contract.requirements.filter(item => item.kind === 'entity_exists').map(item => item.unit_number).sort((a, b) => a - b), [22, 23, 25])
  assert.ok(contract.requirements.some(item => item.kind === 'inventory_count' && item.item_name === 'burner-inserter' && item.minimum === 1))
  assert.deepEqual(events(w, 'plan.checkpoint_compiled_from_obligations').map(entry => entry.data.preserve), [[22, 23, 25]])
  assert.equal(events(w, 'recovery.classified').filter(entry => entry.data.recovery_route).length, 0)
  assert.equal(harnessCorrections(w.calls[2]).length, 0)
})

test('BA lane A route draft is corrected once inside the route instead of guard-pausing', async () => {
  const row = lane('a')
  const seen = {}
  const w = baWorld(row, [row.wire.submit.message, row.wire.route.message, correctedLaneA(row), stopAt(seen)])
  const before = structuredClone(w.memory.planningState(w.key).plans)
  startAuthoring(w)
  await assert.rejects(w.agent.runGuarded(), new RegExp(STOP))
  fromPreservationRefusal(w)
  const [correction] = harnessCorrections(w.calls[2])
  assert.match(correction.content, /\(1\/3; missing_step_obligations\): typed_step_obligations_required/)
  assert.equal(w.calls[2][1]?.allowTools, false)
  assert.equal(seen.role, 'executor')
  assert.notEqual(seen.pause.paused, true)
  const [committed] = newPlans(seen.planning, before)
  assert.equal(committed.status, 'COMMITTED')
  assert.equal(committed.steps.length, 4)
  assert.ok(committed.steps.every(step => step.obligations))
  const corrected = events(w, 'recovery.classified').filter(entry => entry.data.recovery_route === 'wake_planner')
  assert.deepEqual(corrected.map(entry => [entry.data.failure_class, entry.data.reason_code, entry.data.retry, entry.data.tools_enabled]),
    [['plan_category', 'missing_step_obligations', 1, false]])
})

test('an injected non-outcome route checkpoint mismatch is still refused with its facts, then corrected through the route', async () => {
  const row = lane('b')
  const wrong = routeDraft(row)
  wrong.stepCompletions[0].checkpoint = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'burner-inserter', minimum: 2 }] }
  const seen = {}
  const w = baWorld(row, [row.wire.submit.message, contentReply(wrong), row.wire.route.message, stopAt(seen)])
  const before = structuredClone(w.memory.planningState(w.key).plans)
  startAuthoring(w)
  await assert.rejects(w.agent.runGuarded(), new RegExp(STOP))
  const [correction] = harnessCorrections(w.calls[2])
  assert.match(correction.content, /contract_obligation_mismatch; step 0: a checkpoint must be exactly obligations\.outcome plus entity_exists for each preserve unit/)
  assert.equal(newPlans(seen.planning, before).length, 1)
  assert.deepEqual(events(w, 'recovery.classified').filter(entry => entry.data.recovery_route).map(entry => entry.data.reason_code), ['invalid_semantic_checkpoint'])
})

test('repeated invalid route drafts exhaust the plan_category allowance and keep the visible guard pause', async () => {
  const row = lane('a')
  const w = baWorld(row, [row.wire.submit.message, ...Array(4).fill(row.wire.route.message)])
  const before = structuredClone(w.memory.planningState(w.key).plans)
  startAuthoring(w)
  await assert.rejects(w.agent.runGuarded(), /provider_jev_recovery_route_failed: typed_step_obligations_required/)
  assert.equal(w.calls.length, 2 + w.agent.maxToolValidationRetries)
  assert.equal(w.memory.pauseRecord(w.key).paused, true)
  assert.equal(w.memory.pauseRecord(w.key).pause_class, 'guard')
  assert.deepEqual(w.memory.planningState(w.key).plans, before)
  const retries = events(w, 'recovery.classified').filter(entry => entry.data.recovery_route).map(entry => entry.data.retry)
  assert.deepEqual(retries, [1, 2, 3, 4])
  assert.ok(events(w, 'planning.next_slice_settled').some(entry => entry.data.pause_class === 'guard'))
})

test('an authority change during a route correction call drops the stale reply without committing it', async () => {
  const row = lane('a')
  const seen = {}
  const w = baWorld(row, [row.wire.submit.message, row.wire.route.message, world => {
    world.agent.requestAdmissionOwner = { superseding: 'newer intake' }
    return correctedLaneA(row)
  }, stopAt(seen)])
  const before = structuredClone(w.memory.planningState(w.key).plans)
  startAuthoring(w)
  await assert.rejects(w.agent.runGuarded(), new RegExp(STOP))
  // The existing stale-reply path re-drives a fresh planner turn; the refused correction never reached commit.
  assert.equal(events(w, 'context.stale_reply_redriven').length, 1)
  assert.equal(events(w, 'plan.accepted').length, 0)
  assert.equal(seen.role, 'planner')
  assert.deepEqual(seen.planning.plans, before)
})
