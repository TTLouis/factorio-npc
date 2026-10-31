import assert from 'node:assert/strict'
import test from 'node:test'

import { capabilities, NativeBridge, OPERATION_NAMES, parseExternalOperation, renderExternalOperation } from './native-bridge.mjs'

// The Factorio engine is deliberately mocked here. These tests execute the
// actual native adapter, policy parser, v2 wrapper and reconciliation code.
const session = 'external-75ccaf8f-9ab3-4878-a37d-387b809339c1'
const operation = { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }
function world() {
  return {
    guard: { revision: 'sgluna-deploy-v8-npc-staging', session, mode: 'npc', actor_kind: 'standalone_character', actor_id: 7, epoch: 3, allowed: true, surface_index: 1 },
    status: { task_state: 'idle', queue_length: 0, queue_empty: true, batch_generation: 2, tasks_added: 0, admission_journal: [], receipt_journal: [], actor: { position: { x: 0, y: 0 } } },
    journal: { records: [], high_water: 4 }, tick: 100, speed: 1,
  }
}
function row(pending, state = 'admitted') {
  return { operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature,
    actor_id: pending.actor.actor_id, epoch: pending.actor.epoch, ordinal: pending.ordinal, operation_count: 1,
    state, generation: 2, tick: 100, ok: true,
    slots: [{ index: 1, ok: true, operation: pending.operations[0].name, queued_tasks: 1,
      batch_refs: [{ batch_id: 1, batch_generation: 2, batch_ref: 'batch-g2-1' }] }] }
}
function fixture() {
  const state = world()
  const calls = []
  const fake = { state, calls, preflight: { ok: true }, onSubmit: undefined, onCancel: undefined }
  const rcon = { command: async command => {
    calls.push(command)
    if (command.includes('local refusal=')) {
      if (fake.onSubmit) return fake.onSubmit(command)
      const marker = command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'queued']], admission: fake.admission })}`
    }
    if (command.includes('local g=') && command.includes('cancel_all_tasks')) {
      if (fake.onCancel) return fake.onCancel(command)
      return '{"ok":true,"code":"cancel_requested"}'
    }
    if (command.includes('local g=') && command.includes('configure')) return '{"ok":true}'
    if (command.includes('{guard=remote.call')) return JSON.stringify(state)
    if (command.includes('\"fluid_preservation_candidate\"')) {
      if (fake.freezeError) return JSON.stringify({ ok: false, code: fake.freezeError })
      const encoded = command.match(/helpers\.json_to_table\('([^']*)'\)/)[1]
      const context = JSON.parse(encoded)
      return JSON.stringify({ ok: true, preservation_join: { version: 4, candidate_set_id: 'placement-1', candidate_id: 'candidate-1',
        operation_key: fake.freezeKey ?? 'run/fluid', signature: context.signature, owner: context.owner, isolated: context.isolated === true } })
    }
    if (command.includes('autorio_preflight') || command.includes('validation="not_required"')) return JSON.stringify(fake.preflight)
    return '{"example":true}'
  } }
  fake.bridge = new NativeBridge({ rcon, session })
  return fake
}

for (const raw of [
  { name: 'place_entity', args: { entity_name: 'offshore-pump', x: 1, y: 1 } },
  { name: 'place_entity', args: { entity_name: 'stone-furnace' } },
  { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 101 } },
  { name: 'wait', args: { ticks: 3601 } },
  { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1, lua: 'game.print(1)' } },
]) {
  test(`safe external surface refuses ${JSON.stringify(raw)}`, () => assert.throws(() => parseExternalOperation(raw)))
}

test('capabilities are selected from authoritative catalog, never planner or arbitrary Lua', () => {
  assert.deepEqual(capabilities().operations.map(item => item.name).sort(), [...OPERATION_NAMES].sort())
  assert.ok(capabilities().observations.includes('getRecipeDetails'))
  assert.ok(!capabilities().observations.includes('submitPlan'))
})

test('prepare uses canonical parsing, native preflight and exact v2 lineage', async () => {
  const f = fixture()
  const prepared = await f.bridge.prepare({ name: 'craft_item', args: { item_name: 'iron-gear-wheel' } }, 'run/op_1')
  assert.deepEqual(prepared.operation, operation)
  assert.equal(prepared.pending.protocol_version, 2)
  assert.deepEqual(prepared.pending.actor, { actor_id: 7, epoch: 3 })
  assert.equal(prepared.pending.ordinal, 5)
  assert.equal(prepared.pending.surface_index, 1)
  assert.equal(prepared.pending.operation_key, 'run/op_1')
  assert.equal(f.calls.length, 2)
  assert.match(f.calls[1], /autorio_preflight.*craft_item/)
})

test('prepare rejects native preflight without sending a mutation', async () => {
  const f = fixture(); f.preflight = { ok: false, code: 'missing_items' }
  await assert.rejects(f.bridge.prepare(operation, 'run/op_1'), error => error.code === 'preflight_rejected' && error.notAdmitted)
  assert.equal(f.calls.some(command => command.includes('local refusal=')), false)
})

for (const [label, mutate, expected] of [
  ['other session', state => { state.guard.session = 'someone-else' }, 'session_not_owned'],
  ['actor busy', state => { state.status.task_state = 'crafting' }, 'native_busy'],
  ['accelerated game', state => { state.speed = 2 }, 'nonstandard_game_speed'],
  ['invalid journal', state => { state.status.admission_journal = null }, 'native_journal_invalid'],
  ['invalid highwater', state => { state.journal.high_water = -1 }, 'native_high_water_invalid'],
]) {
  test(`prepare refuses ${label} without preflight or mutation`, async () => {
    const f = fixture(); mutate(f.state)
    await assert.rejects(f.bridge.prepare(operation, 'run/op_1'), { code: expected })
    assert.equal(f.calls.length, 1)
  })
}

test('Factorio empty Lua tables normalize to empty native arrays', async () => {
  const f = fixture(); f.state.status.admission_journal = {}; f.state.status.receipt_journal = {}
  assert.deepEqual((await f.bridge.snapshot()).status.admission_journal, [])
})

test('walk distance is bounded relative to current native actor', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.prepare({ name: 'walk_to_position', args: { x: 129, y: 0 } }, 'run/op_1'), { code: 'operation_limit' })
  const prepared = await f.bridge.prepare({ name: 'walk_to_position', args: { x: 128, y: 0 } }, 'run/op_2')
  assert.equal(prepared.operation.args.reach_distance, 0.75)
})

test('submit reuses real v2 admission wrapper under an atomic external boundary', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/op_1')
  f.admission = row(prepared.pending)
  const answer = await f.bridge.submit(prepared)
  assert.equal(answer.admitted, true)
  assert.equal(f.calls.length, 3)
  const command = f.calls.at(-1)
  for (const fragment of ['g.session~=', 'g.actor_id~=7', 'g.epoch~=3', 's.task_state~="idle"', 'j.high_water~=4', 's.batch_generation~=2', 'unresolved_native_operation', 'autorio_preflight', 'autorio_operation_admission","begin', 'autorio_operation_admission","slot', 'autorio_operation_admission","finish']) assert.ok(command.includes(fragment), fragment)
  assert.ok(command.indexOf('autorio_preflight') < command.indexOf('autorio_operation_admission","begin'))
  assert.match(command, /else local prefix=\{\}/)
})

test('lost admission acknowledgement is sent once, never replayed', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/op_1')
  f.onSubmit = async () => { throw new Error('socket closed after write') }
  await assert.rejects(f.bridge.submit(prepared), /socket closed/)
  assert.equal(f.calls.filter(command => command.includes('local refusal=')).length, 1)
})

test('native atomic precondition refusal proves no admission; generic error does not', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/op_1')
  f.onSubmit = command => `${command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]}${JSON.stringify({ ok: false, result: 'external_guard_refused:native_busy', prefix: {} })}`
  await assert.rejects(f.bridge.submit(prepared), error => error.notAdmitted && error.code === 'native_busy')
  f.onSubmit = () => 'missing acknowledgement'
  await assert.rejects(f.bridge.submit(prepared), error => error.notAdmitted !== true)
})

test('tampered prepared operation cannot use the original durable signature', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/op_1')
  prepared.operation.args.count = 2
  await assert.rejects(f.bridge.submit(prepared), { code: 'prepared_signature_mismatch' })
  assert.equal(f.calls.length, 2)
})

test('exact admission completion is execution evidence, never goal success', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/op_1')
  f.state.status.admission_journal = [row(prepared.pending, 'completed')]
  f.state.status.receipt_journal = [{ batch_id: 1, batch_generation: 2, batch_ref: 'batch-g2-1', state: 'completed', task_count: 1, task_types: ['crafting'], tick: 180 }]
  f.state.journal.high_water = 5
  const result = await f.bridge.receipt(prepared.pending)
  assert.equal(result.state, 'completed')
  assert.equal(result.execution_completed, true)
  assert.equal(result.goal_verified, false)
  assert.equal(result.evidence.receipts.length, 1)
  assert.equal(result.evidence.basic_operation, undefined)
})

test('same key with wrong signature is uncertain, unrelated receipts do not count', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/op_1')
  const admission = row(prepared.pending, 'completed'); admission.signature = 'b'.repeat(64)
  f.state.status.admission_journal = [admission]
  f.state.status.receipt_journal = [{ batch_id: 2, batch_generation: 2, batch_ref: 'batch-g2-2', state: 'completed' }]
  const result = await f.bridge.receipt(prepared.pending)
  assert.equal(result.state, 'uncertain')
  assert.equal(result.reason, 'admission_lineage_mismatch')
  assert.equal(result.evidence.receipts.length, 0)
})

test('actor replacement never turns unfinished historical work into success', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/op_1')
  f.state.status.admission_journal = [row(prepared.pending)]
  f.state.guard.epoch++
  const result = await f.bridge.receipt(prepared.pending)
  assert.equal(result.state, 'uncertain')
  assert.equal(result.reason, 'actor_epoch_changed')
})

test('cancel is guarded by exact lineage and active batch, then reobserved; continuation remains fenced', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare({ name: 'wait', args: { ticks: 120 } }, 'run/op_1')
  f.state.status.admission_journal = [row(prepared.pending, 'uncertain')]
  f.state.status.receipt_journal = [{ batch_id: 1, batch_generation: 2, batch_ref: 'batch-g2-1', state: 'cancelled', task_count: 1, task_types: ['waiting'], tick: 110 }]
  const result = await f.bridge.cancel(prepared.pending)
  assert.equal(result.cancellation.ok, true)
  assert.equal(result.receipt.state, 'cancelled')
  assert.equal(result.receipt.requires_reconciliation, true)
  assert.equal(result.receipt.effect, 'partial_unknown')
  const command = f.calls.at(-2)
  for (const fragment of ['g.session==', 'r.signature==', 'r.attempt_id==', 'r.ordinal==5', 'r.slots[1].queued_tasks==s.active_batch.task_count', 'ref.batch_generation==s.active_batch.batch_generation']) assert.ok(command.includes(fragment), fragment)
  await assert.rejects(f.bridge.prepare(operation, 'run/op_2'), { code: 'unresolved_native_operation' })
})

test('cancel-completion race reports native completion rather than inventing cancellation', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/op_1')
  f.onCancel = () => '{"ok":false,"code":"operation_not_active"}'
  f.state.status.admission_journal = [row(prepared.pending, 'completed')]
  const result = await f.bridge.cancel(prepared.pending)
  assert.equal(result.cancellation.ok, false)
  assert.equal(result.receipt.state, 'completed')
})

test('read-only observation accepts only curated tools and existing argument validators', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.observe('submitPlan', {}), { code: 'observation_not_supported' })
  await assert.rejects(f.bridge.observe('getNearbyEntities', { radius: 100000 }))
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await f.bridge.observe('getRecipeDetails', { item_or_recipe: 'iron-gear-wheel' }), { example: true })
})

test('automatic production support keeps canonical recipe admission and bounded geometry reads', async () => {
  const f = fixture()
  const prepared = await f.bridge.prepare({ name: 'set_machine_recipe', args: { unit_number: 42, recipe_name: 'automation-science-pack' } }, 'run/recipe')
  f.admission = row(prepared.pending)
  await f.bridge.submit(prepared)
  assert.match(f.calls.at(-1), /autorio_preflight.*set_machine_recipe/)
  for (const fragment of ['external_recipe_target_unproven', 'e.name~="assembling-machine-1"', 'e.type~="assembling-machine"', 'e.unit_number~=t.unit_number', 'e.surface.index~=a.surface_index', 'e.force.index~=a.force_index', 'e.prototype.fluidbox_prototypes', 'for _,box in pairs(boxes)', '#e.fluidbox~=0', 'external_recipe_nonfluid=w', 'candidate.unit_number==42', 'radius=0.25']) {
    assert.ok(f.calls[1].includes(fragment), `prepare: ${fragment}`)
    assert.ok(f.calls.at(-1).includes(fragment), `atomic admission: ${fragment}`)
  }
  assert.match(f.calls.at(-1), /autorio_operations','set_machine_recipe',42,'automation-science-pack'/)
  for (const name of ['getEntityGeometry', 'getTransportCapacity']) assert.ok(capabilities().observations.includes(name))
  await f.bridge.observe('getEntityGeometry', { unit_number: 42 })
  assert.match(f.calls.at(-1), /entity_geometry/)
  await f.bridge.observe('getTransportCapacity', { kind: 'inserter_instance', unit_number: 42 })
  await assert.rejects(f.bridge.observe('getEntityGeometry', { unit_number: 0 }))
})

test('native rejection of an empty connected fluid assembler cannot queue a recipe task', async () => {
  const f = fixture()
  // Real Lua branch/connection proof belongs to the native lane. This test
  // checks how its authoritative rejection crosses the external boundary.
  f.preflight = { ok: false, code: 'external_recipe_target_unproven' }
  await assert.rejects(f.bridge.prepare({ name: 'set_machine_recipe', args: { unit_number: 42, recipe_name: 'automation-science-pack' } }, 'run/fluid-recipe'), error => error.code === 'preflight_rejected' && error.notAdmitted)
  assert.ok(f.calls[1].includes('external_recipe_target_unproven'))
  assert.equal(f.calls.some(command => command.includes('local refusal=')), false)
})

for (const name of ['assembling-machine-1', 'transport-belt', 'inserter', 'burner-inserter']) {
  test(`automatic production placement ${name} retains exact native no-clear fences`, async () => {
    const f = fixture()
    f.state.status.placement_no_clear_supported = true
    const operation = { name: 'place_entity', args: { entity_name: name, x: 2, y: 2, direction: 0 } }
    const prepared = await f.bridge.prepare(operation, 'run/place')
    f.admission = row(prepared.pending)
    await f.bridge.submit(prepared)
    assert.ok(f.calls.at(-1).includes('preservation_nonfluid_output'))
    assert.ok(f.calls.at(-1).includes('fluid_port_count~=0'))
    assert.ok(f.calls.at(-1).includes('placement_footprint_occupied'))
    assert.ok(renderExternalOperation(operation).endsWith(',true)'))
    assert.throws(() => parseExternalOperation({ name: 'place_entity', args: { entity_name: name } }))
  })
}

test('external placement still excludes advanced or arbitrary prototypes', () => {
  for (const entity_name of ['assembling-machine-2', 'fast-transport-belt', 'chemical-plant', 'arbitrary-prototype'])
    assert.throws(() => parseExternalOperation({ name: 'place_entity', args: { entity_name, x: 2, y: 2 } }), { code: 'placement_not_supported' })
})

test('explicit bind is not a tool capability and atomically refuses existing ownership/busy state', async () => {
  const f = fixture()
  await f.bridge.bind()
  const command = f.calls[0]
  assert.match(command, /g.session~=""/)
  assert.match(command, /s.task_state~="idle"/)
  assert.match(command, /session_already_bound/)
  assert.ok(!capabilities().observations.includes('bind'))
})


test('negative walk coordinates stay numeric Lua operands, never comment prefixes', async () => {
  const f = fixture()
  const prepared = await f.bridge.prepare({ name: 'walk_to_position', args: { x: -1, y: -2 } }, 'run/negative')
  f.admission = row(prepared.pending)
  await f.bridge.submit(prepared)
  const command = f.calls.at(-1)
  assert.ok(command.includes('(p.x-(-1))^2+(p.y-(-2))^2'))
  assert.ok(!command.includes('p.x--'))
  assert.ok(!command.includes('p.y--'))
})

test('capability discovery includes complete bounded observation input schemas', () => {
  const entries = capabilities().observation_schemas
  assert.equal(entries.length, capabilities().observations.length)
  assert.deepEqual(entries.find(entry => entry.name === 'getRecipeDetails').inputSchema.required, ['item_or_recipe'])
  assert.equal(entries.find(entry => entry.name === 'getNearbyEntities').inputSchema.properties.radius.maximum, 64)
})


test('narrow placement always forces execution-time no-clear and native nonfluid/occupancy checks', async () => {
  const f = fixture()
  const placement = { name: 'place_entity', args: { entity_name: 'stone-furnace', x: -2, y: -4 } }
  await assert.rejects(f.bridge.prepare(placement, 'run/place'), { code: 'placement_safety_capability_missing' })
  f.state.status.placement_no_clear_supported = true
  const prepared = await f.bridge.prepare(placement, 'run/place')
  f.admission = row(prepared.pending)
  await f.bridge.submit(prepared)
  const command = f.calls.at(-1)
  for (const fragment of ['placement_no_clear_supported~=true', 'preservation_nonfluid_output', 'build_check_type=defines.build_check_type.manual', 'placement_footprint_occupied', 'exact_grid_required']) assert.ok(command.includes(fragment), fragment)
  assert.equal(renderExternalOperation(placement), "remote.call('autorio_operations','place_entity','stone-furnace',-2,-4,nil,true)")
  assert.throws(() => parseExternalOperation({ ...placement, args: { ...placement.args, refuse_clearance: false } }))
})


test('atomic admission rejects native rollback or generation changes after preparation', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/rollback')
  f.onSubmit = command => `${command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]}${JSON.stringify({ ok: false, result: 'external_guard_refused:native_generation_changed', prefix: {} })}`
  await assert.rejects(f.bridge.submit(prepared), error => error.notAdmitted && error.code === 'native_generation_changed')
  const command = f.calls.at(-1)
  assert.ok(command.includes('j.high_water~=4'))
  assert.ok(command.includes('s.batch_generation~=2'))
})


test('research observation and submission reuse canonical native contracts without goal completion', async () => {
  const f = fixture()
  const prepared = await f.bridge.prepare({ name: 'research_technology', args: { technology_name: 'automation' } }, 'run/research')
  f.admission = row(prepared.pending)
  await f.bridge.submit(prepared)
  assert.match(f.calls.at(-1), /autorio_operations','research_technology','automation'/)
  assert.match(f.calls.at(-1), /autorio_preflight/)
  f.state.status.admission_journal = [row(prepared.pending, 'completed')]
  assert.equal((await f.bridge.receipt(prepared.pending)).goal_verified, false)
  await f.bridge.observe('getTechnology', { name: 'automation' })
  assert.match(f.calls.at(-1), /autorio_research.*technology.*automation/)
  await f.bridge.observe('getResearchStatus', {})
  assert.match(f.calls.at(-1), /autorio_research.*status/)
})

test('harvest canonicalizes its bounded default and refuses extended work', () => {
  assert.deepEqual(parseExternalOperation({ name: 'harvest_product', args: { product_name: 'wood' } }),
    { name: 'harvest_product', args: { product_name: 'wood', count: 1, search_radius: 64 } })
  for (const args of [{ product_name: 'wood', count: 101 }, { product_name: 'wood', search_radius: 65 }]) {
    assert.throws(() => parseExternalOperation({ name: 'harvest_product', args }), { code: 'operation_limit' })
  }
})

test('lab and pole use native fractional-grid footprints while fluid coordinate placement stays refused', async () => {
  const f = fixture(); f.state.status.placement_no_clear_supported = true
  for (const entity_name of ['lab', 'small-electric-pole']) {
    const operation = { name: 'place_entity', args: { entity_name, x: 0.5, y: -1.5 } }
    assert.deepEqual((await f.bridge.prepare(operation, 'run/nonfluid')).operation, operation)
    assert.match(f.calls.at(-1), /preservation_nonfluid_output/)
    assert.match(f.calls.at(-1), /exact_grid_required/)
    assert.match(renderExternalOperation(operation), /,true\)$/)
  }
  for (const entity_name of ['boiler', 'steam-engine', 'pipe', 'offshore-pump']) {
    assert.throws(() => parseExternalOperation({ name: 'place_entity', args: { entity_name, x: 0, y: 0 } }))
  }
})

for (const isolated of [false, true]) {
  test(`fluid ${isolated ? 'isolated source' : 'declared join'} freezes shared native claim and binds exact v2 owner`, async () => {
    const f = fixture()
    f.state.status.placement_no_clear_supported = true
    f.state.status.external_fluid_candidates_supported = 1
    f.preflight = { ok: true, ...(isolated ? { preservation_eligibility: { kind: 'relation_required' } }
      : { preservation_join: { connects_to: { unit_number: 42 } } }) }
    const operation = { name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }
    const prepared = await f.bridge.prepare(operation, 'run/fluid')
    assert.equal(prepared.preservation.candidate.isolated, isolated)
    assert.equal(prepared.preservation.owner.session, session)
    assert.equal(prepared.pending.goal_id, session)
    assert.equal(prepared.pending.step_id, 'run/fluid')
    assert.match(f.calls[1], /external_candidate_unproven/)
    assert.match(f.calls[1], /placement_footprint_occupied/)
    assert.ok(f.calls[2].includes(isolated ? ',{},helpers.json_to_table' : ',{42},helpers.json_to_table'))
    f.admission = row(prepared.pending)
    await f.bridge.submit(prepared)
    assert.match(f.calls.at(-1), /fluid_preservation/)
    assert.match(f.calls.at(-1), /autorio_operation_admission","leave/)
    assert.match(f.calls.at(-1), /external_fluid_candidates_supported~=1/)
    assert.match(f.calls.at(-1), /autorio_operations','place_candidate','placement-1','candidate-1'/)
    delete prepared.preservation
    await assert.rejects(f.bridge.submit(prepared), { code: 'fluid_preservation_required' })
  })
}

test('unknown fluid capability, native refusal and malformed relation cannot send admission', async () => {
  const f = fixture(); f.state.status.placement_no_clear_supported = true
  const operation = { name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }
  await assert.rejects(f.bridge.prepare(operation, 'run/fluid'), { code: 'fluid_safety_capability_missing' })
  f.state.status.external_fluid_candidates_supported = 1
  await assert.rejects(f.bridge.prepare(operation, 'run/fluid'), { code: 'fluid_candidate_relation_unproven' })
  f.preflight = { ok: true, preservation_join: { connects_to: { unit_number: 42 } } }
  f.freezeError = 'preservation_guard_geometry_unproven'
  await assert.rejects(f.bridge.prepare(operation, 'run/fluid'), error => error.code === 'fluid_preservation_refused' && error.notAdmitted)
  assert.equal(f.calls.some(command => command.includes('local refusal=')), false)
})
