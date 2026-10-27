import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { toolSignature } from '../staging/npc-agent-loop.mjs'
import { candidateScopeVerdict, committedPlacementRegions, compilePlacementScope, describeRegion, regionWithinCircle } from './placement-region.mjs'
import { parseOperation, parsePlacementRegion, toolCommand, toolDefinitions } from './structured-policy.mjs'
import { FakeFactorio } from './task-loop-fixtures.mjs'

// M2 (constraint-aware placement candidates), runtime half. BC C: the committed step counted drills within six tiles of an
// anchor, the executor searched radius 8 and read a ranked top-8 that lay outside that circle, and concluded the area had no
// room although a legal in-circle candidate existed. These tests pin the committed-constraint compilation (the search region comes
// from the step contract, never from the model), the pre-admission check of place_candidate, the region schema and the contract.

const contract = JSON.parse(await readFile(new URL('../../../contracts/factorio-tool-contract.json', import.meta.url), 'utf8'))

const DRILL = 'burner-mining-drill'
const CIRCLE = { shape: 'circle', center: { x: 10, y: 10 }, radius: 6 }
const obligationsFor = (...requirements) => ({ outcome: { mode: 'all', requirements }, preserve: [] })
const drillCount = (extra = {}) => ({ id: 'requirement_1', kind: 'entity_count', prototype: DRILL, minimum: 2, radius: 6, anchor: { x: 10, y: 10 }, ...extra })
const COMMITTED = obligationsFor(drillCount())

const REGION_LUA = "region={shape='circle',center={x=10,y=10},radius=6}"

// The plan the agent sees as active. Searches are scoped only under a committed plan; admission also under a draft (its first
// batch's preflight is what commits it).
const planningWith = status => ({ goal: { goal_id: 'goal-1' }, active_plan_id: 'plan-1', plans: [{ plan_id: 'plan-1', status, active_step_index: 0, steps: [{ step_id: 'step-1' }] }] })

function agentWith(obligations, { preflight, status = 'COMMITTED' } = {}) {
  const game = new FakeFactorio({ inventory: { [DRILL]: 2 }, preflight })
  game.status.actor_id = 10
  const native = game.command.bind(game)
  game.command = async text => (text.includes("'autorio_preflight'") ? JSON.stringify(preflight ? preflight(text) : { ok: true }) : native(text))
  const agent = new NpcAgentLoop({ rcon: game, memory: new CanonicalTaskBoardMemory(), systemPrompt: 'placement region unit test', stateFile: null, traceFile: null,
    decisionTraceFile: null, provider: async () => ({ content: '{}' }) })
  agent.epoch = { ...game.status }
  agent.active = true
  agent.currentContractObligations = () => obligations
  agent.memory.planningState = () => planningWith(status)
  return { agent, game }
}

const callOf = args => ({ tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'getPlacementCandidates', arguments: JSON.stringify(args) } }] })

// ---- the region schema and the request -------------------------------------------------------------------------------

test('getPlacementCandidates advertises and parses the region: a circle or a box, with the interface bounds', () => {
  const tool = toolDefinitions.find(row => row.function.name === 'getPlacementCandidates')
  const region = tool.function.parameters.properties.region
  assert.deepEqual(region.oneOf.map(branch => branch.properties.shape.enum[0]), ['circle', 'box'])
  assert.ok(region.oneOf.every(branch => branch.additionalProperties === false))
  assert.equal(region.oneOf[0].properties.radius.maximum, 256)
  assert.equal(toolCommand('getPlacementCandidates', { entity_name: DRILL, region: CIRCLE }),
    `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_placement_candidates",{entity_name='${DRILL}',${REGION_LUA}})))`)
  const box = { shape: 'box', left_top: { x: -4, y: -3.5 }, right_bottom: { x: 4, y: 3.5 } }
  assert.match(toolCommand('getPlacementCandidates', { entity_name: DRILL, region: box }), /region=\{shape='box',left_top=\{x=-4,y=-3\.5\},right_bottom=\{x=4,y=3\.5\}\}/)
  assert.deepEqual(parsePlacementRegion(box), box)
  assert.doesNotMatch(toolCommand('getPlacementCandidates', { entity_name: DRILL }), /region/)
})

test('an invalid region is refused before anything is sent', () => {
  const bad = [
    null, 'circle', [], {}, { shape: 'ring', center: { x: 0, y: 0 }, radius: 3 },
    { shape: 'circle', center: { x: 0, y: 0 } }, { shape: 'circle', radius: 3 },
    { shape: 'circle', center: { x: 0, y: 0 }, radius: 0 }, { shape: 'circle', center: { x: 0, y: 0 }, radius: -1 },
    { shape: 'circle', center: { x: 0, y: 0 }, radius: 256.5 }, { shape: 'circle', center: { x: 0, y: 0 }, radius: 3, extra: 1 },
    { shape: 'circle', center: { x: 'a', y: 0 }, radius: 3 },
    { shape: 'box', left_top: { x: 0, y: 0 } }, { shape: 'box', left_top: { x: 5, y: 0 }, right_bottom: { x: 1, y: 4 } },
    { shape: 'box', left_top: { x: 0, y: 5 }, right_bottom: { x: 4, y: 1 } },
    { shape: 'box', left_top: { x: 0, y: 0 }, right_bottom: { x: 513, y: 4 } },
  ]
  for (const region of bad) assert.throws(() => toolCommand('getPlacementCandidates', { entity_name: DRILL, region }), JSON.stringify(region))
  assert.doesNotThrow(() => toolCommand('getPlacementCandidates', { entity_name: DRILL, region: { shape: 'box', left_top: { x: 0, y: 0 }, right_bottom: { x: 512, y: 512 } } }))
})

test('the manifest lists getPlacementCandidates arguments including region, and the runtime schema matches them exactly', () => {
  const entry = contract.tools.getPlacementCandidates
  assert.ok(entry.args.includes('region'))
  const tool = toolDefinitions.find(row => row.function.name === 'getPlacementCandidates')
  assert.deepEqual(Object.keys(tool.function.parameters.properties).sort(), [...entry.args].sort())
})

// ---- committed-region geometry ---------------------------------------------------------------------------------------

test('committed regions come only from anchored entity_count requirements of the same prototype', () => {
  assert.deepEqual(committedPlacementRegions(COMMITTED, DRILL), [CIRCLE])
  assert.deepEqual(committedPlacementRegions(COMMITTED, 'stone-furnace'), [])
  assert.deepEqual(committedPlacementRegions(obligationsFor(drillCount({ anchor: undefined })), DRILL), [], 'no anchor, no region')
  assert.deepEqual(committedPlacementRegions(obligationsFor({ id: 'r', kind: 'inventory_count', item_name: DRILL, minimum: 2 }), DRILL), [])
  assert.deepEqual(committedPlacementRegions(undefined, DRILL), [])
  assert.deepEqual(committedPlacementRegions(obligationsFor(drillCount(), drillCount({ id: 'requirement_2' })), DRILL), [CIRCLE], 'identical circles are one region')
})

test('a model region is wholly inside the committed circle only when every point is: circle by distance plus radius, box by corners', () => {
  const circle = (x, y, radius) => ({ shape: 'circle', center: { x, y }, radius })
  assert.equal(regionWithinCircle(circle(10, 10, 6), CIRCLE), true, 'the same circle')
  assert.equal(regionWithinCircle(circle(12, 10, 4), CIRCLE), true, 'tangent from inside, boundary inclusive')
  assert.equal(regionWithinCircle(circle(12, 10, 4.01), CIRCLE), false)
  assert.equal(regionWithinCircle(circle(10, 10, 8), CIRCLE), false, 'the BC C radius 8')
  const box = (x1, y1, x2, y2) => ({ shape: 'box', left_top: { x: x1, y: y1 }, right_bottom: { x: x2, y: y2 } })
  assert.equal(regionWithinCircle(box(8, 8, 12, 12), CIRCLE), true)
  assert.equal(regionWithinCircle(box(6, 6, 14, 14), CIRCLE), true, 'corners at 5.66 from the anchor')
  assert.equal(regionWithinCircle(box(5, 5, 15, 15), CIRCLE), false, 'corners at 7.07')
})

test('compilePlacementScope injects, admits, refuses and passes through', () => {
  assert.deepEqual(compilePlacementScope(undefined, [CIRCLE]), { region: CIRCLE, injected: true })
  const inside = { shape: 'circle', center: { x: 11, y: 10 }, radius: 3 }
  assert.deepEqual(compilePlacementScope(inside, [CIRCLE]), { region: inside, injected: false })
  const outside = { shape: 'circle', center: { x: 10, y: 10 }, radius: 7 }
  assert.equal(compilePlacementScope(outside, [CIRCLE]).refusal.code, 'region_outside_committed_scope')
  assert.deepEqual(compilePlacementScope(outside, []), { region: outside, injected: false })
  assert.deepEqual(compilePlacementScope(undefined, []), { region: undefined, injected: false })
  const other = { shape: 'circle', center: { x: 40, y: 40 }, radius: 6 }
  assert.deepEqual(compilePlacementScope(undefined, [CIRCLE, other]), { refusal: { code: 'region_choice_required', committed_regions: [CIRCLE, other] } },
    'two counted areas: no single area to inject, and an unscoped search is not sent')
  const inOther = { shape: 'circle', center: { x: 41, y: 40 }, radius: 3 }
  assert.deepEqual(compilePlacementScope(inOther, [CIRCLE, other]), { region: inOther, injected: false }, 'a region inside one of them is a choice')
  const straddling = { shape: 'box', left_top: { x: 10, y: 10 }, right_bottom: { x: 40, y: 40 } }
  assert.equal(compilePlacementScope(straddling, [CIRCLE, other]).refusal.code, 'region_outside_committed_scope')
  assert.equal(describeRegion(CIRCLE), 'circle center (10, 10) radius 6')
})

test('candidateScopeVerdict: inside admits, outside and a missing position are distinct refusals, no requirement does not apply', () => {
  assert.deepEqual(candidateScopeVerdict([CIRCLE], { x: 12, y: 12 }), { applies: true, ok: true })
  assert.deepEqual(candidateScopeVerdict([CIRCLE], { x: 16, y: 10 }), { applies: true, ok: true }, 'boundary inclusive')
  assert.equal(candidateScopeVerdict([CIRCLE], { x: 16.5, y: 10 }).code, 'candidate_outside_committed_region')
  assert.equal(candidateScopeVerdict([CIRCLE], undefined).code, 'candidate_region_unproven')
  assert.equal(candidateScopeVerdict([CIRCLE], { x: Number.NaN, y: 1 }).code, 'candidate_region_unproven')
  assert.deepEqual(candidateScopeVerdict([], { x: 99, y: 99 }), { applies: false })
})

// ---- injection at the observation seam -------------------------------------------------------------------------------

test('a candidate search for the committed prototype is sent with the committed circle even though the model gave a larger radius and no region', () => {
  const { agent } = agentWith(COMMITTED)
  const command = agent.observationToolCommand('getPlacementCandidates', { entity_name: DRILL, radius: 8, limit: 8 })
  assert.ok(command.includes(REGION_LUA), command)
  assert.match(command, /radius=8/)
  const [entry] = agent.prepareToolBatch(callOf({ entity_name: DRILL, radius: 8, limit: 8 }))
  assert.ok(entry.command.includes(REGION_LUA))
  assert.deepEqual(entry.args.region, CIRCLE)
  assert.equal(entry.signature, toolSignature('getPlacementCandidates', { entity_name: DRILL, radius: 8, limit: 8, region: CIRCLE }))
  assert.notEqual(entry.signature, toolSignature('getPlacementCandidates', { entity_name: DRILL, radius: 8, limit: 8 }), 'a scoped read is not the unscoped read')
})

test('no injection for another prototype, for a requirement without an anchor, or without any obligation', () => {
  const unscoped = { entity_name: DRILL, radius: 8 }
  const plain = toolCommand('getPlacementCandidates', unscoped)
  for (const obligations of [obligationsFor(drillCount({ prototype: 'stone-furnace' })), obligationsFor(drillCount({ anchor: undefined })), undefined]) {
    const { agent } = agentWith(obligations)
    assert.equal(agent.observationToolCommand('getPlacementCandidates', unscoped), plain)
    const [entry] = agent.prepareToolBatch(callOf(unscoped))
    assert.equal(entry.args.region, undefined)
    assert.equal(entry.signature, toolSignature('getPlacementCandidates', unscoped))
  }
  const { agent } = agentWith(obligationsFor(drillCount({ prototype: 'stone-furnace' })))
  const own = { shape: 'circle', center: { x: 200, y: 200 }, radius: 50 }
  assert.ok(agent.observationToolCommand('getPlacementCandidates', { entity_name: DRILL, region: own }).includes('center={x=200,y=200},radius=50'), 'with no matching requirement the model region passes unchanged')
})

test('a model region wholly inside the committed one is admitted as written; one that reaches outside is refused with the committed region stated', () => {
  const { agent } = agentWith(COMMITTED)
  const inside = { shape: 'circle', center: { x: 11, y: 10 }, radius: 4 }
  assert.ok(agent.observationToolCommand('getPlacementCandidates', { entity_name: DRILL, region: inside }).includes("region={shape='circle',center={x=11,y=10},radius=4}"))
  const box = { shape: 'box', left_top: { x: 8, y: 8 }, right_bottom: { x: 12, y: 12 } }
  assert.ok(agent.observationToolCommand('getPlacementCandidates', { entity_name: DRILL, region: box }).includes("region={shape='box'"))
  const [entry] = agent.prepareToolBatch(callOf({ entity_name: DRILL, region: inside }))
  assert.deepEqual(entry.args.region, inside, 'an admitted model region is not replaced')
  for (const region of [{ shape: 'circle', center: { x: 10, y: 10 }, radius: 8 }, { shape: 'circle', center: { x: 15, y: 10 }, radius: 3 },
    { shape: 'box', left_top: { x: 4, y: 4 }, right_bottom: { x: 16, y: 16 } }]) {
    assert.throws(() => agent.observationToolCommand('getPlacementCandidates', { entity_name: DRILL, region }), (error) => {
      assert.equal(error.code, 'region_outside_committed_scope')
      assert.equal(error.failureClass, 'tool_validation')
      assert.deepEqual(error.details.committed_regions, [CIRCLE])
      assert.match(error.message, /circle center \(10, 10\) radius 6/)
      assert.match(error.message, /entity_count requirement for burner-mining-drill/)
      return true
    }, JSON.stringify(region))
    assert.throws(() => agent.prepareToolBatch(callOf({ entity_name: DRILL, region })), error => error.code === 'region_outside_committed_scope')
  }
})

// ---- place_candidate pre-admission -----------------------------------------------------------------------------------

const PLACE = { name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }
const nativeFor = (position, extra = {}) => () => ({ ok: true, operation: 'place_candidate', placement_item: { entity_name: DRILL, item_name: DRILL, count: 1, held_count: 2 },
  ...(position ? { candidate_position: position, candidate_direction: 0 } : {}), ...extra })

async function preflightOf(obligations, native, operations = [PLACE]) {
  const { agent, game } = agentWith(obligations, { preflight: native })
  try { return { results: await agent.preflightOperations(operations), game } }
  catch (error) { return { error, game } }
}

test('a candidate the native preflight places outside the committed circle is refused before admission as a correctable argument error', async () => {
  const { error, results } = await preflightOf(COMMITTED, nativeFor({ x: 20, y: 10 }))
  assert.equal(results, undefined)
  assert.equal(error.preflight.code, 'candidate_outside_committed_region')
  assert.equal(error.preflight.refusal_class, 'argument')
  assert.equal(error.preflight.operation_index, 0)
  assert.deepEqual(error.preflight.candidate_position, { x: 20, y: 10 })
  assert.deepEqual(error.preflight.committed_regions, [CIRCLE])
  assert.match(error.preflight.correction_message, /places this candidate's burner-mining-drill at \(20, 10\), 10 from anchor \(10, 10\)/)
  assert.match(error.preflight.correction_message, /circle center \(10, 10\) radius 6/)
  assert.match(error.preflight.correction_message, /no mutation from this batch ran/)
})

test('a candidate without a reported native position cannot be proven inside and is refused as unproven', async () => {
  const { error } = await preflightOf(COMMITTED, nativeFor(undefined))
  assert.equal(error.preflight.code, 'candidate_region_unproven')
  assert.equal(error.preflight.refusal_class, 'argument')
  assert.equal(error.preflight.candidate_position, undefined)
})

test('a candidate the native preflight places inside the committed circle is admitted, and the native result is kept as it was', async () => {
  const { error, results } = await preflightOf(COMMITTED, nativeFor({ x: 12.5, y: 11.5 }))
  assert.equal(error, undefined)
  assert.equal(results.length, 1)
  assert.deepEqual(results[0].candidate_position, { x: 12.5, y: 11.5 })
  assert.equal(results[0].placement_item.entity_name, DRILL, 'the fence reads the same placement_item')
})

test('without a matching anchored requirement the preflight is unchanged, whatever position the candidate has', async () => {
  for (const obligations of [obligationsFor(drillCount({ prototype: 'stone-furnace' })), obligationsFor(drillCount({ anchor: undefined })), undefined]) {
    assert.equal((await preflightOf(obligations, nativeFor({ x: 99, y: 99 }))).error, undefined)
    assert.equal((await preflightOf(obligations, nativeFor(undefined))).error, undefined)
  }
})

test('a result that does not name its prototype cannot be matched to a requirement and is left to the existing checks', async () => {
  const { error } = await preflightOf(COMMITTED, () => ({ ok: true, operation: 'place_candidate', candidate_position: { x: 90, y: 90 } }))
  assert.equal(error, undefined)
})

test('a model-supplied position or hash cannot ride on a place_candidate: the operation takes registry ids only, and the native result decides', async () => {
  const forged = { name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1', x: 10, y: 10, hash: 'inside' } }
  assert.throws(() => parseOperation(forged))
  const { error, game } = await preflightOf(COMMITTED, nativeFor({ x: 30, y: 30 }), [PLACE])
  assert.equal(error.preflight.code, 'candidate_outside_committed_region')
  assert.equal(game.mutations.length, 0, 'nothing was admitted')
})

// ---- review O2 round 1 -----------------------------------------------------------------------------------------------

const OTHER = { shape: 'circle', center: { x: 40, y: 40 }, radius: 6 }
const TWO_AREAS = obligationsFor(drillCount(), drillCount({ id: 'requirement_2', anchor: { x: 40, y: 40 } }))

test('R1-2: two committed areas for one prototype: a search without a region is refused with both areas, one inside either is sent as written', () => {
  const { agent } = agentWith(TWO_AREAS)
  assert.throws(() => agent.observationToolCommand('getPlacementCandidates', { entity_name: DRILL, radius: 8, limit: 8 }), error => {
    assert.equal(error.code, 'region_choice_required')
    assert.equal(error.failureClass, 'tool_validation')
    assert.deepEqual(error.details.committed_regions, [CIRCLE, OTHER])
    assert.match(error.message, /circle center \(10, 10\) radius 6/)
    assert.match(error.message, /circle center \(40, 40\) radius 6/)
    return true
  })
  const inOther = { shape: 'circle', center: { x: 41, y: 40 }, radius: 3 }
  assert.ok(agent.observationToolCommand('getPlacementCandidates', { entity_name: DRILL, region: inOther }).includes("region={shape='circle',center={x=41,y=40},radius=3}"))
  assert.throws(() => agent.observationToolCommand('getPlacementCandidates', { entity_name: DRILL, region: { shape: 'circle', center: { x: 25, y: 25 }, radius: 4 } }),
    error => error.code === 'region_outside_committed_scope' && /inside one of them/.test(error.message))
})

test('R1-2: with two committed areas a place_candidate is admitted inside either and refused outside both', async () => {
  assert.equal((await preflightOf(TWO_AREAS, nativeFor({ x: 41, y: 41 }))).error, undefined)
  assert.equal((await preflightOf(TWO_AREAS, nativeFor({ x: 25, y: 25 }))).error.preflight.code, 'candidate_outside_committed_region')
})

const placeEntity = (args, footprint) => ({ operation: { name: 'place_entity', args: { entity_name: DRILL, ...args } },
  native: () => ({ ok: true, operation: 'place_entity', placement_item: { entity_name: DRILL, item_name: DRILL, count: 1, held_count: 2 }, ...(footprint ? { planned_footprint: { entity_name: DRILL, position: footprint, direction: 0 } } : {}) }) })

test('R1-1: a place_entity whose native planned footprint centre lies outside the committed circle is refused before admission', async () => {
  const outside = placeEntity({ x: 20, y: 10 }, { x: 20, y: 10 })
  const { error, game } = await preflightOf(COMMITTED, outside.native, [outside.operation])
  assert.equal(error.preflight.code, 'placement_outside_committed_region')
  assert.equal(error.preflight.refusal_class, 'argument')
  assert.equal(error.preflight.operation, 'place_entity')
  assert.deepEqual(error.preflight.placement_position, { x: 20, y: 10 })
  assert.match(error.preflight.correction_message, /places this place_entity's burner-mining-drill at \(20, 10\), 10 from anchor \(10, 10\)/)
  assert.equal(game.mutations.length, 0)
  // The snapped centre decides, not the requested coordinates: (16.4, 10) snaps to (16, 10), on the boundary.
  const snappedInside = placeEntity({ x: 16.4, y: 10 }, { x: 16, y: 10 })
  assert.equal((await preflightOf(COMMITTED, snappedInside.native, [snappedInside.operation])).error, undefined)
  const inside = placeEntity({ x: 12, y: 11 }, { x: 12, y: 11 })
  assert.equal((await preflightOf(COMMITTED, inside.native, [inside.operation])).error, undefined)
})

test('R1-1: a coordinate-free place_entity of a committed prototype cannot be proven inside and is refused; another prototype is untouched', async () => {
  const free = placeEntity({}, undefined)
  const { error } = await preflightOf(COMMITTED, free.native, [free.operation])
  assert.equal(error.preflight.code, 'placement_region_unproven')
  assert.match(error.preflight.correction_message, /has no coordinates, so the runtime would choose where/)
  const furnace = { name: 'place_entity', args: { entity_name: 'stone-furnace' } }
  assert.equal((await preflightOf(COMMITTED, () => ({ ok: true, operation: 'place_entity' }), [furnace])).error, undefined)
})

test('R1-1: a construction plan is refused when one validated placement of the committed prototype snaps outside the circle', async () => {
  const plan = { name: 'execute_construction_plan', args: { validation_id: 7, placement_count: 2 } }
  const witness = drillPosition => () => ({ ok: true, validation_id: 7, placement_count: 2, construction_placements: [
    { entity_name: 'stone-furnace', x: 30, y: 30, direction: 0, position: { x: 30, y: 30 }, fluidbox_count: 0 },
    { entity_name: DRILL, x: drillPosition.x, y: drillPosition.y, direction: 0, ...(drillPosition.snapped ? { position: drillPosition.snapped } : {}), fluidbox_count: 0 }] })
  const outside = await preflightOf(COMMITTED, witness({ x: 20, y: 10, snapped: { x: 20, y: 10 } }), [plan])
  assert.equal(outside.error.preflight.code, 'placement_outside_committed_region')
  assert.equal(outside.error.preflight.operation, 'execute_construction_plan')
  assert.equal(outside.error.preflight.entity_name, DRILL)
  const unproven = await preflightOf(COMMITTED, witness({ x: 12, y: 10 }), [plan])
  assert.equal(unproven.error.preflight.code, 'placement_region_unproven', 'raw coordinates are not the resolved position')
  // An unusable witness is left to the existing checks (the preservation gate, native re-validation), not refused as out of area.
  const unreadable = await preflightOf(COMMITTED, () => ({ ok: false, code: 'construction_plan_unavailable' }), [plan])
  assert.notEqual(unreadable.error?.preflight?.code?.startsWith('placement_'), true)
  const unrelated = await preflightOf(obligationsFor(drillCount({ anchor: undefined })), () => { throw new Error('no witness read without an anchored requirement') }, [plan])
  assert.equal(unrelated.error, undefined)
  const inside = await preflightOf(COMMITTED, witness({ x: 12, y: 10, snapped: { x: 12, y: 10 } }), [plan])
  assert.notEqual(inside.error?.preflight?.code?.endsWith('committed_region'), true)
  assert.notEqual(inside.error?.preflight?.code, 'placement_region_unproven')
})

test('R1-1: planPlacement for a committed prototype is refused with the area as facts; another prototype still plans', () => {
  const { agent } = agentWith(COMMITTED)
  assert.throws(() => agent.observationToolCommand('planPlacement', { entity_name: DRILL, position: { x: 30, y: 10 } }), error => {
    assert.equal(error.code, 'placement_search_unscoped')
    assert.equal(error.failureClass, 'tool_validation')
    assert.match(error.message, /circle center \(10, 10\) radius 6/)
    assert.match(error.message, /getPlacementCandidates for burner-mining-drill is filtered by that area/)
    return true
  })
  assert.match(agent.observationToolCommand('planPlacement', { entity_name: 'stone-furnace' }), /plan_placement/)
})

test('R1-3: a draft plan does not scope searches, but its first batch is still checked against the contract it would commit', async () => {
  for (const status of ['DRAFT', 'RUNTIME_VALIDATION', 'READY']) {
    const { agent } = agentWith(COMMITTED, { status })
    assert.ok(!agent.observationToolCommand('getPlacementCandidates', { entity_name: DRILL, radius: 8 }).includes('region='), status)
    assert.match(agent.observationToolCommand('planPlacement', { entity_name: DRILL }), /plan_placement/, status)
    const { error } = await (async () => {
      const { agent: gate } = agentWith(COMMITTED, { status, preflight: nativeFor({ x: 20, y: 10 }) })
      try { await gate.preflightOperations([PLACE]); return {} }
      catch (failure) { return { error: failure } }
    })()
    assert.equal(error?.preflight?.code, 'candidate_outside_committed_region', status)
  }
  for (const status of ['COMMITTED', 'EXECUTING']) {
    const { agent } = agentWith(COMMITTED, { status })
    assert.ok(agent.observationToolCommand('getPlacementCandidates', { entity_name: DRILL, radius: 8 }).includes(REGION_LUA), status)
  }
})
