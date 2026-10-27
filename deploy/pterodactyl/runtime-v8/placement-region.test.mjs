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

function agentWith(obligations, { preflight } = {}) {
  const game = new FakeFactorio({ inventory: { [DRILL]: 2 }, preflight })
  game.status.actor_id = 10
  const native = game.command.bind(game)
  game.command = async text => (text.includes("'autorio_preflight'") ? JSON.stringify(preflight ? preflight(text) : { ok: true }) : native(text))
  const agent = new NpcAgentLoop({ rcon: game, memory: new CanonicalTaskBoardMemory(), systemPrompt: 'placement region unit test', stateFile: null, traceFile: null,
    decisionTraceFile: null, provider: async () => ({ content: '{}' }) })
  agent.epoch = { ...game.status }
  agent.active = true
  agent.currentContractObligations = () => obligations
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
  assert.deepEqual(compilePlacementScope(undefined, [CIRCLE, other]), { region: undefined, injected: false }, 'two counted areas: no single hard region')
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
      assert.deepEqual(error.details.committed_region, CIRCLE)
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
