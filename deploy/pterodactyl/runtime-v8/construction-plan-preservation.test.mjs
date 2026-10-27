import assert from 'node:assert/strict'
import test from 'node:test'
import { candidateWorld, KEY } from './fluid-candidate-recovery-fixtures.mjs'
import { getActivePlan } from './planning-state.mjs'
import { planReply } from './task-loop-fixtures.mjs'
import { fluidFixture } from './fluid-preservation-fixtures.mjs'
import { constructionPlanWitnessCommand, fluidPreservationMutationUnsafe, nonfluidConstructionWitness } from './contract-obligation-runtime.mjs'

// Run BC A and C: a nonfluid batch validated beside a protected pump/boiler/steam-engine plant was refused by NAME when the
// executor submitted the validate/execute pair the provider guidance recommends. These tests drive the real admission seam
// (prepareFluidPreservationAdmission) with the native witness replaced by scripted replies, the only offline substitution.
const SHAPES = {
  chest_inserter_pole: ['wooden-chest', 'burner-inserter', 'small-electric-pole'],
  lab_pole: ['lab', 'small-electric-pole'],
}

function witness(names, overrides = {}) {
  const id = overrides.validation_id ?? 7; const count = names.length
  return { ok: true, operation: 'execute_construction_plan', validation_id: id, plan_id: 'plan-bc', placement_count: count,
    created_tick: 100, expires_tick: 3700, preservation_clears_count: 0, execution_clearance: 'refused',
    construction_placements: names.map((entity_name, i) => ({ entity_name, x: 10 + 3 * i, y: 8, direction: 0, fluidbox_count: 0 })),
    preservation_nonfluid_output: { version: 1, actor_id: 10, surface_index: 1, force_index: 1, validation_id: id,
      placement_count: count, entity_names: [...names], execution_clearance: 'refused', fluid_port_count: 0 },
    ...overrides }
}

const witnessRead = text => text.includes('autorio_preflight') && text.includes('execute_construction_plan')
function planWorld(names, { reply, id = 7, count = names.length, extra = [] } = {}) {
  return candidateWorld({
    response: ({ text }) => witnessRead(text) ? (typeof reply === 'function' ? reply(text) : reply ?? witness(names)) : undefined,
    executor: ({ step }) => planReply({ stepId: step.step_id,
      operations: [{ name: 'execute_construction_plan', args: { validation_id: id, placement_count: count } }, ...extra] }),
  })
}
const refused = async (w, pattern = /preservation_protected_mutation_refused/) => {
  await assert.rejects(w.start(), pattern)
  assert.equal(w.game.mutations.length, 0, 'a refused composite never reaches native transport')
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  assert.equal(getActivePlan(w.memory.planningState(KEY)).active_step_index, 0)
}

for (const [shape, names] of Object.entries(SHAPES)) {
  test(`Run BC ${shape}: validated nonfluid batch beside the protected plant is admitted once, bound to its exact validation`, async () => {
    const w = await planWorld(names)
    await w.start()
    assert.equal(w.game.mutations.length, 1, JSON.stringify(w.rows.filter(row => /failed|paused|refused/.test(row.event)).slice(-4)))
    assert.match(w.game.mutations[0], new RegExp(`'execute_construction_plan',7,${names.length}\\b`))
    const reads = w.nativeReads.filter(witnessRead)
    assert.equal(reads.length, 1, 'one witness read, not a second differently-timed one')
    assert.match(reads[0], new RegExp(`validation_id=7,placement_count=${names.length}`))
    assert.equal(Object.keys(getActivePlan(w.memory.planningState(KEY)).execution.preservation_admissions ?? {}).length, 0,
      'a nonfluid composite writes no fluid admission envelope')
  })
}

// The pre-repair predicate refused every execute_construction_plan by name, whatever the placements were. A bare
// fluidPreservationMutationUnsafe call (no witness) is exactly that behaviour and must keep failing closed.
test('negative control: without a verified native witness the same operation is still unsafe (pre-repair behaviour)', () => {
  const operation = { name: 'execute_construction_plan', args: { validation_id: 7, placement_count: 2 } }
  assert.equal(fluidPreservationMutationUnsafe({ preserved: [] }, [operation]), true)
  assert.equal(fluidPreservationMutationUnsafe({ preserved: [] }, [operation], [], { nonfluidComposites: new Set() }), true)
  assert.equal(fluidPreservationMutationUnsafe({ preserved: [] }, [operation], [], { nonfluidComposites: new Set([operation]) }), false)
  // The proof is per operation object: an equal-looking clone, or a different submitted batch, is not covered.
  assert.equal(fluidPreservationMutationUnsafe({ preserved: [] }, [structuredClone(operation)], [], { nonfluidComposites: new Set([operation]) }), true)
})

const FAULTS = {
  unreadable: { reply: () => 'not json' },
  missing_witness: { reply: () => ({}) },
  not_ok: { reply: () => ({ ok: false, code: 'construction_plan_unavailable', operation: 'execute_construction_plan' }) },
  remote_plan: { reply: () => ({ ok: false, code: 'construction_plan_remote_unsupported', operation: 'execute_construction_plan' }) },
  expired: { reply: () => ({ ok: false, code: 'construction_plan_expired', operation: 'execute_construction_plan' }) },
  fluid_bearing: { reply: names => { const w = witness(names); delete w.preservation_nonfluid_output; w.construction_placements[0].fluidbox_count = 2; return w } },
  fluid_port_count: { reply: names => { const w = witness(names); w.preservation_nonfluid_output.fluid_port_count = 1; return w } },
  clears: { reply: names => witness(names, { preservation_clears_count: 1 }) },
  clearance_absent: { reply: names => { const w = witness(names); delete w.execution_clearance; delete w.preservation_nonfluid_output.execution_clearance; return w } },
  clearance_top_level_absent: { reply: names => { const w = witness(names); delete w.execution_clearance; return w } },
  clearance_output_absent: { reply: names => { const w = witness(names); delete w.preservation_nonfluid_output.execution_clearance; return w } },
  clearance_allowed: { reply: names => witness(names, { execution_clearance: 'allowed' }) },
  clearance_output_allowed: { reply: names => { const w = witness(names); w.preservation_nonfluid_output.execution_clearance = 'allowed'; return w } },
  validation_id: { reply: names => witness(names, { validation_id: 8 }) },
  output_validation_id: { reply: names => { const w = witness(names); w.preservation_nonfluid_output.validation_id = 8; return w } },
  placement_count: { reply: names => { const w = witness(names); w.placement_count = 9; return w } },
  fewer_placements: { reply: names => { const w = witness(names); w.construction_placements.pop(); return w } },
  actor: { reply: names => { const w = witness(names); w.preservation_nonfluid_output.actor_id = 11; return w } },
  surface: { reply: names => { const w = witness(names); w.preservation_nonfluid_output.surface_index = 2; return w } },
  force: { reply: names => { const w = witness(names); w.preservation_nonfluid_output.force_index = 2; return w } },
}
for (const [fault, { reply }] of Object.entries(FAULTS)) {
  test(`unproven composite stays refused before native transport: ${fault}`, async () => {
    const names = SHAPES.lab_pole
    await refused(await planWorld(names, { reply: () => reply(names) }))
  })
}

test('submitting an id the witness does not describe stays refused', async () => {
  // The scripted native reply describes validation 7; the executor submitted 9 (a stale or invented id).
  await refused(await planWorld(SHAPES.lab_pole, { id: 9, reply: () => witness(SHAPES.lab_pole) }))
})

for (const extra of [
  [{ name: 'rotate_entity', args: { unit_number: 1 } }],
  [{ name: 'clear_construction_area', args: { x: 0, y: 0, width: 4, height: 4 } }],
]) test(`a proven composite cannot carry ${extra[0].name} through the same admission`, async () => {
  await refused(await planWorld(['lab'], { extra }))
})

test('a proven composite never waives the other unsafe operations of its batch', () => {
  const fixture = fluidFixture()
  const composite = { name: 'execute_construction_plan', args: { validation_id: 7, placement_count: 2 } }
  const proven = { nonfluidComposites: new Set([composite]) }
  assert.equal(fluidPreservationMutationUnsafe(fixture.fresh, [composite], [], proven), false)
  for (const other of [{ name: 'clear_construction_area', args: {} }, { name: 'reserve_construction_area', args: {} }, { name: 'prepare_pump_site', args: {} },
    { name: 'rotate_entity', args: { unit_number: 1 } }, { name: 'mine_entity_exact', args: { unit_number: 1 } }, { name: 'mine_entity', args: { entity_name: 'offshore-pump' } }]) {
    assert.equal(fluidPreservationMutationUnsafe(fixture.fresh, [composite, other], [], proven), true, other.name)
    // Listing the unsafe operation as "proven" does not help: only execute_construction_plan consults the set.
    assert.equal(fluidPreservationMutationUnsafe(fixture.fresh, [other], [], { nonfluidComposites: new Set([other]) }), true, other.name)
  }
  assert.equal(fluidPreservationMutationUnsafe(fixture.fresh, [composite, { name: 'supply_entity', args: { unit_number: 2 } }], [], proven), false)
})

test('witness command is harness-built from validated integers only and is a read of autorio_preflight', () => {
  const command = constructionPlanWitnessCommand({ name: 'execute_construction_plan', args: { validation_id: 7, placement_count: 2 } })
  assert.equal(command, '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_preflight","operation","execute_construction_plan",{validation_id=7,placement_count=2})))')
  for (const args of [{ validation_id: '7', placement_count: 2 }, { validation_id: 0, placement_count: 2 }, { validation_id: 7, placement_count: 17 },
    { validation_id: 7.5, placement_count: 2 }, { validation_id: 7 }, undefined]) {
    assert.equal(constructionPlanWitnessCommand({ name: 'execute_construction_plan', args }), undefined)
  }
  assert.equal(constructionPlanWitnessCommand({ name: 'place_entity', args: { validation_id: 7, placement_count: 2 } }), undefined)
})

test('witness verifier binds the exact operation and the fresh preservation scope', () => {
  const names = SHAPES.chest_inserter_pole
  const operation = { name: 'execute_construction_plan', args: { validation_id: 7, placement_count: 3 } }
  const fresh = { actor_id: 10, preserved: [{ surface_index: 1, force_index: 1 }, { surface_index: 1, force_index: 1 }] }
  assert.equal(nonfluidConstructionWitness(witness(names), operation, fresh), true)
  assert.equal(nonfluidConstructionWitness(witness(names), { ...operation, name: 'place_entity' }, fresh), false)
  assert.equal(nonfluidConstructionWitness(witness(names), { ...operation, args: { ...operation.args, placement_count: 2 } }, fresh), false)
  assert.equal(nonfluidConstructionWitness(witness(names), operation, { ...fresh, actor_id: 99 }), false)
  assert.equal(nonfluidConstructionWitness(witness(names), operation, { ...fresh, preserved: [{ surface_index: 1, force_index: 2 }] }), false)
  assert.equal(nonfluidConstructionWitness(witness(names), operation, undefined), false)
  assert.equal(nonfluidConstructionWitness(witness(names, { operation: 'place_entity' }), operation, fresh), false)
  const renamed = witness(names); renamed.preservation_nonfluid_output.entity_names[1] = 'pipe'
  assert.equal(nonfluidConstructionWitness(renamed, operation, fresh), false, 'output and per-placement names must agree')
  for (const mutate of [w => { delete w.execution_clearance }, w => { delete w.preservation_nonfluid_output.execution_clearance },
    w => { w.execution_clearance = 'allowed' }, w => { w.preservation_nonfluid_output.execution_clearance = 'allowed' }, w => { w.execution_clearance = true }]) {
    const w = witness(names); mutate(w)
    assert.equal(nonfluidConstructionWitness(w, operation, fresh), false, 'a witness that does not state execution_clearance:refused is not accepted')
  }
})
