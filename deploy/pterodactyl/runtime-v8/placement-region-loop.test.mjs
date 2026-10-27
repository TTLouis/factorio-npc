import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { compileObligations } from './contract-obligations.mjs'
import { answersStepContract, FakeFactorio, planReply } from './task-loop-fixtures.mjs'

// BC C through the real agent loop. The committed step counts burner mining drills within six tiles of an anchor. The executor
// searches with radius 8 and no region (what it did in the run). The runtime compiles the step contract into the search, the
// answer reports in-region status, and a later place_candidate whose native position lies outside the circle is refused before
// admission; the corrected candidate inside it is admitted. Native replies are scripted substitutions (labelled in the fixture);
// the loop, memory, step contract, preflight and admission code are the production ones.

const KEY = 'npc:region-fixture'
const DRILL = 'burner-mining-drill'
const ANCHOR = { x: 10, y: 10 }
const CIRCLE = { shape: 'circle', center: ANCHOR, radius: 6 }
const REGION_LUA = "region={shape='circle',center={x=10,y=10},radius=6}"
const OUTSIDE = { candidate: 'candidate-2', position: { x: 20, y: 10 } }
const INSIDE = { candidate: 'candidate-1', position: { x: 12, y: 11 } }

const OBLIGATIONS = { outcome: { mode: 'all', requirements: [{ kind: 'entity_count', prototype: DRILL, minimum: 2, anchor: ANCHOR, radius: 6 }] }, preserve: [] }

function world({ obligations = OBLIGATIONS, contractOnly = false, secondPick, nativePosition = id => ({ 'candidate-1': INSIDE.position, 'candidate-2': OUTSIDE.position })[id] } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const game = new FakeFactorio({ inventory: { [DRILL]: 2 } })
  game.status.actor_id = 10
  game.status.connected_players = 0
  const native = game.command.bind(game)
  const rows = []; const searches = []; const calls = []; const mutationsAt = []
  game.command = async text => {
    if (text.includes('projection="next_slice_ownership_v1"')) return native(text)
    if (text.includes('"autorio_tools","get_placement_candidates"')) {
      searches.push(text)
      return JSON.stringify({ ok: true, entity_name: DRILL, region: CIRCLE, region_semantics: 'entity_center', spatial_status: 'candidates_found',
        search_completeness: { complete: true, search_shape: 'square_rings', search_center: ANCHOR, search_radius: 9, evaluated_positions: 361, legal_candidate_count: 2, returned_count: 2, region_rejected_count: 150 },
        material_status: { status: 'held', item_name: DRILL, held_count: 2, required_count: 1 }, execution_eligibility: 'eligible',
        candidate_set_id: 'placement-1', ordering: 'nearest_to_anchor_first', legal_candidate_count: 2, returned_candidate_count: 2,
        candidates: [{ id: 'candidate-1', position: INSIDE.position, direction: 0, distance_from_anchor: 2.24, in_region: true }, { id: 'candidate-2', position: { x: 15, y: 10 }, direction: 0, distance_from_anchor: 5, in_region: true }] })
    }
    if (text.includes('"autorio_preflight"') && /["']place_entity["']/.test(text)) {
      // Scripted native place_entity preflight: the grid-snapped planned footprint centre of the requested coordinates.
      const x = Number(/\['x'\]=(-?[\d.]+)/.exec(text)?.[1]); const y = Number(/\['y'\]=(-?[\d.]+)/.exec(text)?.[1])
      return JSON.stringify({ ok: true, operation: 'place_entity', placement_item: { entity_name: DRILL, item_name: DRILL, count: 1, held_count: 2 },
        ...(Number.isFinite(x) && Number.isFinite(y) ? { planned_footprint: { entity_name: DRILL, position: { x, y }, direction: 0 } } : {}) })
    }
    if (text.includes("'autorio_preflight'") && text.includes("'place_candidate'")) {
      const id = /candidate_id='(candidate-\d+)'/.exec(text)?.[1]
      const position = nativePosition(id)
      return JSON.stringify({ ok: true, operation: 'place_candidate', placement_item: { entity_name: DRILL, item_name: DRILL, count: 1, held_count: 2 },
        ...(position ? { candidate_position: position, candidate_direction: 0 } : {}) })
    }
    if (text.includes('evaluate_condition') && text.includes('entity_count')) return JSON.stringify({ ok: true, kind: 'entity_count', prototype: DRILL, current: 0, found: 0, satisfied: false, truncated: false })
    if (text.includes('autorio_crafting') && text.includes('status')) return JSON.stringify({ task_active: false, native_queue: [] })
    if (text.includes('autorio_operations","status')) {
      const status = JSON.parse(await native(text))
      if (status.last_completed_batch) {
        Object.assign(status.last_completed_batch, { batch_generation: 1, batch_ref: `batch-g1-${game.batchId}` })
        status.receipt_journal = [{ ...status.last_completed_batch, state: 'completed' }]
      }
      return JSON.stringify(status)
    }
    return native(text)
  }
  game.onMutation = text => {
    if (text.includes("'place_candidate'")) {
      game.lastTaskTypes = ['placing']; game.inventory[DRILL] -= 1
      game.lastBasicResult = { operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 10, type: 'placing', accepted: true, completed: true, code: 'completed',
        entity_name: DRILL, placed_unit_number: 2, placed_entity_type: 'mining-drill', placed_position: INSIDE.position, placed_surface_index: 1, placed_direction: 0 }
    }
  }
  let round = 0
  const agent = new NpcAgentLoop({ memory, rcon: game, npcId: 'region-fixture', completionProtocolVersion: 3, requireTypedObligations: !contractOnly, replacementWake: true,
    stateFile: null, traceFile: null, decisionTraceFile: null, systemPrompt: 'Scripted offline fixture: BC C committed drill area.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (messages, context) => {
      calls.push({ role: context.role, messages: structuredClone(messages) })
      if (context.role === 'planner') {
        return planReply({ plan: ['Place two burner mining drills within six tiles of the anchor.'], currentStep: 0, operations: [],
          goal: { scope: 'long_horizon', summary: 'Mine copper ore with drills near the anchor.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 99 }] },
          roadmap: [{ id: 'drills', intent: 'Drills at the anchor.' }],
          stepCompletions: [contractOnly ? { kind: 'deterministic', checkpoint: compileObligations(obligations) } : { kind: 'deterministic', checkpoint: compileObligations(obligations), obligations }],
          executionGuidance: [{ approach: 'Place the drills near the anchor.', rationale: 'Committed area.', constraints: [], skillIds: [], materialSupply: null }] })
      }
      const held = getActivePlan(memory.planningState(KEY)); const step = held.steps[held.active_step_index]
      mutationsAt.push(game.mutations.length)
      const place = pick => planReply({ stepId: step.step_id, operations: [{ name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: pick.candidate } }] })
      if (round++ === 0) return { content: '', tool_calls: [{ id: 'search-1', index: 0, type: 'function', function: { name: 'getPlacementCandidates', arguments: JSON.stringify({ entity_name: DRILL, radius: 8, limit: 8 }) } }] }
      return round === 2 ? (secondPick ? planReply({ stepId: step.step_id, operations: [secondPick] }) : place(OUTSIDE)) : place(INSIDE)
    }) })
  agent.behaviorTrace = { emit: async row => { rows.push(row) } }
  return { agent, memory, game, rows, searches, calls, mutationsAt, start: () => agent.request('Mine copper ore with drills near the anchor.', { sender: 'Louis' }) }
}

const toolAnswers = call => call.messages.filter(message => message.role === 'tool').map(message => String(message.content))

test('BC C: the executor searches radius 8 with no region; the sent command carries the committed circle and the answer reports in-region status', async () => {
  const w = world()
  await w.start()
  assert.equal(w.searches.length, 1, JSON.stringify(w.rows.filter(row => /failed|paused|refused|rejected/.test(row.event)).slice(-4)))
  assert.ok(w.searches[0].includes(REGION_LUA), w.searches[0])
  assert.match(w.searches[0], /radius=8/, 'the model keeps its own radius; the region decides the area')
  const compiled = w.rows.find(row => row.event === 'observation.placement_scope_compiled')
  assert.deepEqual(compiled?.data.region, CIRCLE)
  // The executor's next call reads the rendered answer.
  const rendered = toolAnswers(w.calls[2]).map(text => { try { return JSON.parse(text) } catch { return undefined } }).find(value => value?.spatial_status)
  assert.equal(rendered.spatial_status, 'candidates_found')
  assert.deepEqual(rendered.region, CIRCLE)
  assert.equal(rendered.execution_eligibility, 'eligible')
  assert.ok(rendered.candidates.every(candidate => candidate.in_region === true))
  assert.deepEqual(Object.keys(rendered).slice(0, 3), ['ok', 'entity_name', 'region'])
})

test('BC C: a later place_candidate whose native position is outside the committed circle is refused before admission, then the inside candidate is admitted', async () => {
  const w = world()
  await w.start()
  assert.equal(w.calls.filter(call => call.role !== 'planner').length >= 3, true, JSON.stringify(w.calls.map(call => call.role)))
  // The refusal sent nothing; the correction names the facts; the corrected candidate is the only thing admitted.
  const refused = w.rows.find(row => row.event === 'operations.placement_scope_refused')
  assert.equal(refused?.data.code, 'candidate_outside_committed_region')
  assert.deepEqual(refused.data.candidate_position, OUTSIDE.position)
  assert.deepEqual(refused.data.committed_regions, [CIRCLE])
  const recoverable = w.rows.find(row => row.event === 'operations.preflight_recoverable')
  assert.equal(recoverable?.data.failure_class, 'model_correctable_candidate_outside_committed_region')
  assert.equal(recoverable.data.refusal_class, 'argument')
  assert.equal(w.mutationsAt.at(-1), 0, 'nothing had been admitted when the executor was asked to correct')
  const correction = w.calls.at(-1).messages.map(message => String(message.content ?? '')).join('\n')
  assert.match(correction, /candidate_outside_committed_region/)
  assert.match(correction, /\(20, 10\), 10 from anchor \(10, 10\)/)
  assert.match(correction, /circle center \(10, 10\) radius 6/)
  assert.equal(w.game.mutations.length, 1)
  assert.ok(w.game.mutations[0].includes("'place_candidate'") && w.game.mutations[0].includes('candidate-1'))
  assert.ok(!w.game.mutations[0].includes('candidate-2'))
  assert.equal(w.rows.some(row => row.event === 'goal.paused'), false)
})

test('a native preflight without a position cannot be admitted under the committed region', async () => {
  const w = world({ nativePosition: () => undefined })
  await w.start()
  assert.equal(w.rows.find(row => row.event === 'operations.placement_scope_refused')?.data.code, 'candidate_region_unproven')
  assert.equal(w.game.mutations.length, 0)
})

test('with no anchor on the requirement the search is not scoped and the same candidates are admitted', async () => {
  const unanchored = { outcome: { mode: 'all', requirements: [{ kind: 'entity_count', prototype: DRILL, minimum: 2 }] }, preserve: [] }
  const w = world({ obligations: unanchored })
  await w.start()
  assert.ok(!w.searches[0].includes('region='), w.searches[0])
  assert.equal(w.rows.some(row => row.event === 'operations.placement_scope_refused'), false)
  assert.equal(w.game.mutations.length, 1)
  assert.ok(w.game.mutations[0].includes('candidate-2'), 'the first candidate the model picked is admitted')
})

test('BC C shape: the anchored area only in the step completion contract (no typed obligations) still scopes the search and the admission', async () => {
  const w = world({ contractOnly: true })
  await w.start()
  const step = getActivePlan(w.memory.planningState(KEY))?.steps?.[0]
  assert.equal(step?.obligations, undefined, 'the fixture must carry the area only in the completion contract')
  assert.equal(step?.completion_contract?.requirements?.[0]?.radius, 6)
  assert.ok(w.searches[0].includes(REGION_LUA), w.searches[0])
  assert.equal(w.rows.find(row => row.event === 'operations.placement_scope_refused')?.data.code, 'candidate_outside_committed_region')
  assert.equal(w.game.mutations.length, 1)
  assert.ok(w.game.mutations[0].includes('candidate-1'))
})

test('review R1-1: a place_entity with explicit coordinates outside the committed circle is refused before admission, then the inside candidate is admitted', async () => {
  const w = world({ secondPick: { name: 'place_entity', args: { entity_name: DRILL, x: 20, y: 10 } } })
  await w.start()
  const refused = w.rows.find(row => row.event === 'operations.placement_scope_refused')
  assert.equal(refused?.data.code, 'placement_outside_committed_region')
  assert.equal(refused.data.operation, 'place_entity')
  assert.deepEqual(refused.data.placement_position, { x: 20, y: 10 })
  assert.equal(w.rows.find(row => row.event === 'operations.preflight_recoverable')?.data.refusal_class, 'argument')
  assert.equal(w.mutationsAt.at(-1), 0, 'nothing had been admitted when the executor was asked to correct')
  assert.match(w.calls.at(-1).messages.map(message => String(message.content ?? '')).join('\n'), /places this place_entity's burner-mining-drill at \(20, 10\), 10 from anchor \(10, 10\)/)
  assert.equal(w.game.mutations.length, 1)
  assert.ok(w.game.mutations[0].includes("'place_candidate'") && w.game.mutations[0].includes('candidate-1'))
  assert.equal(w.rows.some(row => row.event === 'goal.paused'), false)
})
