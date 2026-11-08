import assert from 'node:assert/strict'
import test from 'node:test'

import { capabilities, NativeBridge, OPERATION_NAMES, parseExternalOperation, renderExternalOperation } from './native-bridge.mjs'

// The Factorio engine is deliberately mocked here. These tests execute the
// actual native adapter, policy parser, v2 wrapper and reconciliation code.
const session = 'external-75ccaf8f-9ab3-4878-a37d-387b809339c1'
const operation = { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }
function world() {
  return {
    guard: { revision: 'sgluna-deploy-v8-npc-staging', session, mode: 'npc', actor_kind: 'standalone_character', actor_id: 7, epoch: 3, allowed: true, surface_index: 1, force_index: 1 },
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
    if (fake.onCommand) { const reply = fake.onCommand(command); if (reply !== undefined) return reply }
    if (command.includes('local refusal=')) {
      if (fake.onSubmit) return fake.onSubmit(command)
      const marker = command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'queued']], admission: fake.admission })}`
    }
    if (command.includes('get_item_count')) return JSON.stringify(fake.probe ?? { example: true })
    if (command.includes('local g=') && command.includes('cancel_all_tasks')) {
      if (fake.onCancel) return fake.onCancel(command)
      return '{"ok":true,"code":"cancel_requested"}'
    }
    if (command.includes('local g=') && command.includes('configure')) return '{"ok":true}'
    if (command.includes('{guard=remote.call')) return JSON.stringify(state)
    if (command.includes('\"fluid_preservation_candidate\"')) {
      if (fake.freezeThrows) throw new Error('socket closed after freeze write')
      if (fake.freezeError) return JSON.stringify({ ok: false, code: fake.freezeError, ...fake.freezeExtra })
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
  assert.equal(f.calls.length, 3)
  assert.match(f.calls[1], /autorio_preflight.*craft_item/)
  assert.match(f.calls[2], /get_item_count/, 'read-only effect probe follows a passing preflight')
  assert.equal(prepared.observed_before, null, 'an unreadable probe never blocks preparation')
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
  assert.equal(f.calls.length, 4)
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

// Trial 4r r4-063: the atomic re-run of the preflight refused, and the receipt had no cause.
test('an admission-time preflight refusal carries its native code, tile and blockers', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/op_1')
  let gate
  const refuse = text => command => { gate = command; return `${command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]}${JSON.stringify({ ok: false, result: text, prefix: {} })}` }
  f.onSubmit = refuse('external_guard_refused:preflight_rejected:placement_footprint_occupied@0;character:character::33.50:16.50;item-entity:item-on-ground:coal:-3.25:4.00')
  await assert.rejects(f.bridge.submit(prepared), error => {
    assert.equal(error.notAdmitted, true); assert.equal(error.code, 'preflight_rejected')
    assert.deepEqual(error.details, { native_code: 'placement_footprint_occupied', tile_index: 0, blockers: [
      { name: 'character', type: 'character', position: { x: 33.5, y: 16.5 } },
      { name: 'item-on-ground', type: 'item-entity', position: { x: -3.25, y: 4 }, item: 'coal' }] })
    return true
  })
  // The gate renders the refused preflight's cause into its refusal text.
  assert.match(gate, /if p\.ok~=true then return "preflight_rejected"\.\.\(function\(p\)/)
  // A detail suffix on another guard code, or a malformed one, proves nothing.
  f.onSubmit = refuse('external_guard_refused:native_busy:placement_footprint_occupied')
  await assert.rejects(f.bridge.submit(prepared), error => error.notAdmitted !== true)
  f.onSubmit = refuse('external_guard_refused:preflight_rejected:Bad Code')
  await assert.rejects(f.bridge.submit(prepared), error => error.notAdmitted !== true)
})

test('tampered prepared operation cannot use the original durable signature', async () => {
  const f = fixture(); const prepared = await f.bridge.prepare(operation, 'run/op_1')
  prepared.operation.args.count = 2
  await assert.rejects(f.bridge.submit(prepared), { code: 'prepared_signature_mismatch' })
  assert.equal(f.calls.length, 3)
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
  for (const fragment of ['world_safety_capability_missing', '"sgluna_world_safety","preflight",\'set_machine_recipe\',42', 'external_world_safety=w.external_world_safety']) {
    assert.ok(f.calls[1].includes(fragment), `prepare: ${fragment}`)
    assert.ok(f.calls.at(-1).includes(fragment), `atomic admission: ${fragment}`)
  }
  assert.match(f.calls.at(-1), /autorio_operations','set_machine_recipe',42,'automation-science-pack'/)
  for (const name of ['getEntityGeometry', 'getTransportCapacity']) assert.ok(capabilities().observations.includes(name))
  await f.bridge.observe('getEntityGeometry', { unit_number: 42 })
  assert.match(f.calls.at(-1), /entity_geometry/)
  await f.bridge.observe('getTransportCapacity', { kind: 'inserter_instance', unit_number: 42 })
  await assert.rejects(f.bridge.observe('getEntityGeometry', { unit_number: 0 }))
  assert.ok(capabilities().observations.includes('getResourceAmounts'))
  await f.bridge.observe('getResourceAmounts', { resource_name: 'iron-ore', center: { x: 4, y: -3 }, radius: 2 })
  assert.match(f.calls.at(-1), /remote\.call\("autorio_tools","get_resource_amounts",\{resource_name='iron-ore',center=\{x=4,y=-3\},radius=2\}\)/)
  await assert.rejects(f.bridge.observe('getResourceAmounts', { radius: 49 }), { code: 'invalid_observation_arguments' })
  // Trial 4r: an area with no ore came back with tiles {} (an empty Lua table); list fields are lists.
  f.onCommand = command => command.includes('get_resource_amounts') ? JSON.stringify({ ok: true, resources: {}, tiles: {}, tiles_truncated: false, unseen_chunks: {}, area: {} }) : undefined
  const empty = await f.bridge.observe('getResourceAmounts', { resource_name: 'iron-ore', radius: 2 })
  assert.deepEqual([empty.resources, empty.tiles, empty.unseen_chunks], [[], [], []])
  assert.deepEqual(empty.area, {})
})

test('native rejection of an empty connected fluid assembler cannot queue a recipe task', async () => {
  const f = fixture()
  // Real Lua branch/connection proof belongs to the native lane. This test
  // checks how its authoritative rejection crosses the external boundary.
  f.preflight = { ok: false, code: 'external_hydraulic_target_unproven' }
  await assert.rejects(f.bridge.prepare({ name: 'set_machine_recipe', args: { unit_number: 42, recipe_name: 'automation-science-pack' } }, 'run/fluid-recipe'), error => error.code === 'preflight_rejected' && error.notAdmitted)
  assert.match(f.calls[1], /"sgluna_world_safety","preflight",'set_machine_recipe',42/)
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

test('generic prototype parsing grants no placement authority without a native nonfluid footprint witness', async () => {
  const f = fixture(); f.state.status.placement_no_clear_supported = true
  for (const entity_name of ['fixture-modded-machine', 'chemical-plant', 'arbitrary-prototype']) {
    const operation = { name: 'place_entity', args: { entity_name, x: 2, y: 2 } }
    assert.deepEqual(parseExternalOperation(operation), operation)
    f.preflight = { ok: false, code: 'nonfluid_footprint_unproven' }
    await assert.rejects(f.bridge.prepare(operation, `run/${entity_name}`), error => error.code === 'preflight_rejected'
      && error.notAdmitted && error.details.native_code === 'nonfluid_footprint_unproven')
  }
  assert.equal(f.calls.some(command => command.includes('local refusal=')), false)
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

test('crash-site setup is an owned operator action, never a tool, and reports the native record', async () => {
  const f = fixture()
  const native = { ok: true, already_done: false, tick: 9, position: { x: -5, y: -6 }, entity_count: 2,
    entities: [{ name: 'crash-site-spaceship', unit_number: 1, position: { x: -5, y: -6 } }, { name: 'crash-site-spaceship-wreck-big-1', unit_number: 2, position: { x: -1, y: -4 } }],
    starter_items: [{ name: 'iron-plate', requested: 8, inserted: 8 }], freeplay_crash_site_disabled: true }
  f.onCommand = command => command.includes('"autorio_setup","spawn_crash_site"') ? JSON.stringify(native) : undefined
  const report = await f.bridge.spawnCrashSite()
  assert.deepEqual(report, { already_done: false, tick: 9, position: { x: -5, y: -6 }, entity_count: 2,
    entities: ['crash-site-spaceship', 'crash-site-spaceship-wreck-big-1'], starter_items: [{ name: 'iron-plate', requested: 8, inserted: 8 }], freeplay_crash_site_disabled: true })
  const command = f.calls.at(-1)
  assert.match(command, /g\.session~='external-/)
  assert.match(command, /crash_site_setup_unsupported/)
  assert.match(command, /unresolved_native_operation/)
  for (const list of [capabilities().observations, capabilities().operations.map(operation => operation.name)]) {
    assert.ok(!list.some(name => /crash/i.test(name)))
  }
  f.onCommand = command => command.includes('spawn_crash_site') ? '{"ok":false,"code":"freeplay_start_already_ran"}' : undefined
  await assert.rejects(f.bridge.spawnCrashSite(), { code: 'freeplay_start_already_ran' })
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

test('fractional-grid footprints and fluid coordinate refusals come from native current-world evidence', async () => {
  const f = fixture(); f.state.status.placement_no_clear_supported = true
  for (const entity_name of ['lab', 'small-electric-pole']) {
    const operation = { name: 'place_entity', args: { entity_name, x: 0.5, y: -1.5 } }
    assert.deepEqual((await f.bridge.prepare(operation, 'run/nonfluid')).operation, operation)
    assert.match(f.calls.at(-2), /preservation_nonfluid_output/)
    assert.match(f.calls.at(-2), /exact_grid_required/)
    assert.match(renderExternalOperation(operation), /,true\)$/)
  }
  for (const entity_name of ['boiler', 'steam-engine', 'pipe', 'offshore-pump', 'electric-mining-drill']) {
    f.preflight = { ok: false, code: 'nonfluid_footprint_unproven' }
    await assert.rejects(f.bridge.prepare({ name: 'place_entity', args: { entity_name, x: 0, y: 0 } }, 'run/fluid-coordinate'), { code: 'preflight_rejected' })
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
    assert.equal(capabilities().limits.placement_domain, 'native-nonfluid-or-proven-fluid-candidate')
    assert.match(f.calls[1], /preservation_clears_count~=0/)
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

// Operator-feedback regressions from the 2026-11-01 cheap-model trial
// (test-results/external-cheap-redscience-20261101/FINDINGS.md findings 1-6).
test('walk limit refusal states distance, limit and actor position without any game call', async () => {
  const f = fixture(); f.state.status.actor.position = { x: 10, y: 0 }
  await assert.rejects(f.bridge.prepare({ name: 'walk_to_position', args: { x: 150, y: 0 } }, 'run/walk'), error => error.code === 'operation_limit'
    && /140\.0 tiles/.test(error.publicMessage) && /limit is 128/.test(error.publicMessage)
    && error.details.maximum === 128 && error.details.distance === 140 && error.details.actor_position.x === 10)
  assert.equal(f.calls.length, 1, 'only the snapshot read ran')
})

test('placement refusal names footprint blockers such as items on the ground', async () => {
  const f = fixture(); f.state.status.placement_no_clear_supported = true
  f.preflight = { ok: false, code: 'placement_footprint_occupied', planned_footprint: { position: { x: -48.5, y: 24.5 }, world_box: { left_top: { x: -49, y: 24 }, right_bottom: { x: -48, y: 25 } } },
    blockers: [{ name: 'item-on-ground', type: 'item-entity', position: { x: -48.4, y: 24.6 }, item: 'copper-plate' }] }
  await assert.rejects(f.bridge.prepare({ name: 'place_entity', args: { entity_name: 'transport-belt', x: -48.5, y: 24.5, direction: 12 } }, 'run/belt'), error =>
    error.code === 'preflight_rejected' && error.notAdmitted && error.details.native_code === 'placement_footprint_occupied'
    && error.details.blockers[0].item === 'copper-plate' && error.details.planned_footprint.position.x === -48.5
    && /item-entity \(copper-plate\)/.test(error.publicMessage) && /never clears/.test(error.publicMessage))
  assert.match(f.calls[1], /blockers\[#blockers\+1\]=\{name=e\.name,type=e\.type/, 'native preflight collects blockers rather than a bare code')
  assert.equal(f.calls.some(command => command.includes('local refusal=')), false)
})

test('unknown or unsafe native preflight codes are not echoed verbatim', async () => {
  const f = fixture(); f.preflight = { ok: false, code: 'Raw <native> text' }
  await assert.rejects(f.bridge.prepare(operation, 'run/op_1'), error => error.details.native_code === 'unknown' && !/Raw/.test(error.publicMessage))
})

test('observation argument errors name the expected schema before any game call', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.observe('getEntityGeometry', { unit: 5 }), error => error.code === 'invalid_observation_arguments'
    && /unit_number/.test(error.publicMessage) && error.details.observation === 'getEntityGeometry')
  assert.equal(f.calls.length, 0)
})

test('effect probe records actor position and the operation item count before submission', async () => {
  const f = fixture(); f.probe = { ok: true, tick: 120, actor_id: 7, position: { x: 3, y: 4 }, items: { 'iron-gear-wheel': 2 } }
  const prepared = await f.bridge.prepare(operation, 'run/op_1')
  assert.deepEqual(prepared.observed_before, { tick: 120, actor_id: 7, position: { x: 3, y: 4 }, items: { 'iron-gear-wheel': 2 } })
  assert.match(f.calls.at(-1), /get_entity_by_unit_number\(g\.actor_id\).*e\.type~="character".*\{'iron-gear-wheel'\}/)
})

test('capabilities state craft count, inserter direction and research receipt semantics', () => {
  const notes = capabilities().operation_notes
  assert.match(notes.craft_item, /number of recipe crafts, not items/)
  assert.match(notes.place_entity, /inserters it names the pickup side/)
  assert.match(notes.research_technology, /started and queued, not finished/)
  assert.match(notes.research_technology, /appended behind it in the native queue \(queued_behind\)/)
  assert.match(notes.walk_to_position, /128 tiles/)
})

test('only read-only prepare refusals are marked not sent; a native claim freeze fault never is', async () => {
  const f = fixture(); f.state.status.task_state = 'mining'
  await assert.rejects(f.bridge.prepare(operation, 'run/busy'), error => error.code === 'native_busy' && error.notSent === true)
  const g = fixture(); g.state.status.placement_no_clear_supported = true; g.state.status.external_fluid_candidates_supported = 1
  g.preflight = { ok: true, preservation_join: { connects_to: { unit_number: 42 } } }
  const candidate = { name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }
  g.freezeThrows = true
  await assert.rejects(g.bridge.prepare(candidate, 'run/fluid'), error => /socket closed/.test(error.message) && error.notSent !== true)
  g.freezeThrows = false; g.freezeError = 'preservation_guard_already_claimed'
  await assert.rejects(g.bridge.prepare(candidate, 'run/fluid'), error => error.code === 'fluid_preservation_refused' && error.notSent !== true)
})

test('native blocker text is pattern-checked and unknown codes never index object prototypes', async () => {
  const f = fixture(); f.state.status.placement_no_clear_supported = true
  f.preflight = { ok: false, code: 'constructor', blockers: [{ name: 'Bad Name<script>', type: 'item-entity', position: { x: 1, y: 2 }, item: 'x y' }] }
  await assert.rejects(f.bridge.prepare({ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 0, y: 0 } }, 'run/odd'), error =>
    !/function|script|x y/.test(error.publicMessage) && error.details.blockers[0].name === 'unknown' && error.details.blockers[0].item === 'unknown')
})

test('effect probe guards each item count natively', async () => {
  const f = fixture()
  await f.bridge.effectProbe({ name: 'mine_resource_at', args: { resource_name: 'crude-oil', x: 0, y: 0 } })
  assert.match(f.calls.at(-1), /pcall\(e\.get_item_count,n\)/)
})

test('placement candidates are annotated with the same footprint rule external placement enforces', async () => {
  const f = fixture()
  const box = (x, y) => ({ left_top: { x: x - 0.25, y: y - 0.25 }, right_bottom: { x: x + 0.25, y: y + 0.25 } })
  const native = { ok: true, entity_name: 'transport-belt', legal_candidate_count: 2, execution_eligibility: 'eligible', candidates: [
    { id: 'candidate-1', position: { x: 4.5, y: 0.5 }, footprint: { world_box: box(4.5, 0.5) } },
    { id: 'candidate-2', position: { x: 6.5, y: 0.5 }, footprint: { world_box: box(6.5, 0.5) } }] }
  f.onCommand = command => command.includes('rows=out')
    ? JSON.stringify({ ok: true, tick: 5361, rows: [{ code: 'placement_footprint_occupied', blockers: [{ name: 'item-on-ground', type: 'item-entity', position: { x: 4.5, y: 0.5 }, item: 'iron-plate' }], resources: {} }, { code: 'clear', blockers: {}, resources: [{ name: 'iron-ore', tiles: 1 }, { name: 'bad name!', tiles: 2 }, { name: 'stone', tiles: 0 }] }] })
    : command.includes('get_placement_candidates') ? JSON.stringify(native) : undefined
  const result = await f.bridge.observe('getPlacementCandidates', { entity_name: 'transport-belt', covers_position: { x: 4.5, y: 0.5 } })
  assert.equal(result.legal_candidate_count, 2, 'native fields are preserved')
  assert.deepEqual(result.candidates[0].external_footprint, { eligible: false, code: 'placement_footprint_occupied',
    blockers: [{ name: 'item-on-ground', type: 'item-entity', position: { x: 4.5, y: 0.5 }, item: 'iron-plate' }] })
  assert.deepEqual(result.candidates[1].external_footprint, { eligible: true })
  // Trial 4r: buildings landed on the ore patch. The resource tiles under each footprint are a fact on the candidate.
  assert.equal(result.candidates[0].covers_resources, undefined, 'no resource tiles, no field')
  assert.deepEqual(result.candidates[1].covers_resources, [{ name: 'iron-ore', tiles: 1 }, { name: 'unknown', tiles: 2 }])
  assert.match(result.external_placement.rule, /covers_resources lists the resource tiles/)
  assert.ok(f.calls.at(-1).includes('find_entities_filtered{area=box,type="resource",limit=256}'))
  assert.equal(result.external_placement.checked, true)
  assert.equal(result.external_placement.blocked_candidate_count, 1)
  assert.equal(result.external_placement.eligible_candidate_count, 1)
  const annotation = f.calls.at(-1)
  assert.ok(annotation.includes('{{4.25,0.25},{4.75,0.75}}'))
  // The candidate check and placement preflight must send one identical rule.
  const rule = command => command.match(/local function external_footprint\(surface,box,own\).*?return nil,blockers end;/)?.[0]
  f.state.status.placement_no_clear_supported = true; f.onCommand = undefined
  await f.bridge.prepare({ name: 'place_entity', args: { entity_name: 'transport-belt', x: 6.5, y: 0.5 } }, 'run/rule')
  assert.ok(rule(annotation))
  assert.equal(rule(f.calls[1]), rule(annotation))
  // The NPC's hidden vision vehicle follows the actor and has no collision; the mod's own scans skip it, and so does this rule
  // (native line lane: a line under the actor was refused for "sgluna-npc-vision [car]").
  assert.ok(rule(annotation).includes('e.name~="sgluna-npc-vision"'))
})

test('candidate annotation fails visibly, never by dropping or inventing eligibility', async () => {
  const f = fixture()
  const native = { ok: true, candidates: [{ id: 'candidate-1', footprint: { world_box: { left_top: { x: 0, y: 0 }, right_bottom: { x: 1, y: 1 } } } }] }
  f.onCommand = command => command.includes('rows=out') ? '{"ok":false}' : command.includes('get_placement_candidates') ? JSON.stringify(native) : undefined
  const unavailable = await f.bridge.observe('getPlacementCandidates', { entity_name: 'transport-belt' })
  assert.deepEqual(unavailable.external_placement, { rule: unavailable.external_placement.rule, checked: false, reason: 'footprint_check_unavailable' })
  assert.equal(unavailable.candidates[0].external_footprint, undefined)
  const calls = f.calls.length
  native.candidates[0].footprint = {}
  const missing = await f.bridge.observe('getPlacementCandidates', { entity_name: 'transport-belt' })
  assert.equal(missing.external_placement.reason, 'candidate_geometry_missing')
  assert.equal(f.calls.length, calls + 1, 'no footprint command without native geometry')
})

test('candidate annotation survives a transport failure and place_candidate shares the rule', async () => {
  const f = fixture()
  const native = { ok: true, candidates: [{ id: 'candidate-1', footprint: { world_box: { left_top: { x: 0, y: 0 }, right_bottom: { x: 1, y: 1 } } } }] }
  f.onCommand = command => {
    if (command.includes('rows=out')) throw new Error('socket closed')
    return command.includes('get_placement_candidates') ? JSON.stringify(native) : undefined
  }
  const result = await f.bridge.observe('getPlacementCandidates', { entity_name: 'transport-belt' })
  assert.equal(result.external_placement.checked, false)
  assert.equal(result.candidates[0].id, 'candidate-1')
  f.onCommand = undefined
  f.state.status.placement_no_clear_supported = true; f.state.status.external_fluid_candidates_supported = 1
  f.preflight = { ok: false, code: 'placement_footprint_occupied' }
  await assert.rejects(f.bridge.prepare({ name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }, 'run/fluid'))
  const preflight = f.calls.find(command => command.includes('external_candidate_unproven'))
  assert.match(preflight, /local function external_footprint\(surface,box,own\)/)
  assert.match(preflight, /local code,blockers=external_footprint\(surface,f\.world_box\)/)
})

// 2026-11-03 trial finding 1 (test-results/external-sonnet-redscience-20261103):
// a 17th pipe was listed eligible, then refused by the 16-entity network guard.
test('candidates of an unprovable fluid join are marked ineligible with the native reason', async () => {
  const f = fixture()
  const box = { left_top: { x: 0, y: 0 }, right_bottom: { x: 1, y: 1 } }
  const native = { ok: true, entity_name: 'pipe', candidates: [{ id: 'candidate-1', footprint: { world_box: box } }, { id: 'candidate-2', footprint: { world_box: box } }],
    connects_to: { unit_number: 42, preservation_network: { version: 1, limit: 16, provable: false, reason: 'protected_network_over_limit', entity_count_at_least: 17 } } }
  f.onCommand = command => command.includes('rows=out')
    ? JSON.stringify({ ok: true, tick: 9, rows: [{ code: 'clear', blockers: {} }, { code: 'clear', blockers: {} }] })
    : command.includes('get_placement_candidates') ? JSON.stringify(native) : undefined
  const result = await f.bridge.observe('getPlacementCandidates', { entity_name: 'pipe', connects_to: { unit_number: 42 } })
  for (const candidate of result.candidates) {
    assert.deepEqual(candidate.external_footprint, { eligible: true }, 'the footprint rule alone still passes')
    assert.deepEqual(candidate.external_preservation, { eligible: false, code: 'protected_network_over_limit' })
  }
  assert.deepEqual(result.connects_to.preservation_network, native.connects_to.preservation_network, 'native fact is preserved')
  assert.equal(result.external_placement.eligible_candidate_count, 0)
  assert.equal(result.external_placement.blocked_candidate_count, 2)

  native.connects_to.preservation_network = { version: 1, limit: 16, provable: true, entity_count: 16 }
  const provable = await f.bridge.observe('getPlacementCandidates', { entity_name: 'pipe', connects_to: { unit_number: 42 } })
  assert.equal(provable.candidates[0].external_preservation, undefined)
  assert.equal(provable.external_placement.eligible_candidate_count, 2)

  native.connects_to.preservation_network = { version: 1, limit: 16, provable: false, reason: 'protected_geometry_unavailable', unit_number: 77 }
  native.candidates = [{ id: 'candidate-1', footprint: {} }]
  const unreadable = await f.bridge.observe('getPlacementCandidates', { entity_name: 'pipe', connects_to: { unit_number: 42 } })
  assert.equal(unreadable.external_placement.reason, 'candidate_geometry_missing')
  assert.deepEqual(unreadable.candidates[0].external_preservation, { eligible: false, code: 'protected_geometry_unavailable' }, 'marked even when the footprint check cannot run')
})

test('a network over the guard limit is refused with the limit and count, before any admission', async () => {
  const f = fixture(); f.state.status.placement_no_clear_supported = true; f.state.status.external_fluid_candidates_supported = 1
  f.preflight = { ok: true, preservation_join: { connects_to: { unit_number: 42 } } }
  const candidate = { name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }
  f.freezeError = 'preservation_guard_network_over_limit'; f.freezeExtra = { limit: 16, entity_count_at_least: 17 }
  await assert.rejects(f.bridge.prepare(candidate, 'run/fluid'), error => error.code === 'fluid_preservation_refused' && error.notAdmitted
    && /at least 17 entities/.test(error.publicMessage) && /at most 16/.test(error.publicMessage)
    && error.details.native_code === 'preservation_guard_network_over_limit' && error.details.limit === 16 && error.details.entity_count_at_least === 17)
  f.freezeError = 'preservation_guard_geometry_unproven'; f.freezeExtra = { limit: 16, entity_count_at_least: 17 }
  await assert.rejects(f.bridge.prepare(candidate, 'run/fluid'), error => !/at most/.test(error.publicMessage)
    && error.details.native_code === 'preservation_guard_geometry_unproven' && error.details.limit === undefined)
  assert.equal(f.calls.some(command => command.includes('local refusal=')), false)
})

const sharedWorldReads = [
  ['getProductionScope', { calculation_id: 'fixture', target: { type: 'item', name: 'fixture-item' } }, /"autorio_planning","scope_context"/],
  ['solveProduction', { calculation_id: 'fixture', target: { type: 'item', name: 'fixture-item', rate_per_second: 1 } }, /"autorio_planning","solve"/],
  ['getMiningDetails', { resource_or_item: 'fixture-item' }, /"autorio_knowledge","mining_details"/],
  ['estimateProductionTime', { target: 'fixture-item', count: 2, steps: [{ item: 'fixture-item' }] }, /"autorio_knowledge","production_estimate"/],
  ['getResearchPath', { name: 'fixture-technology' }, /"autorio_planning","research_path"/],
  ['findLongRangeEntities', { name: 'fixture-entity' }, /"autorio_discovery","find_entities"/],
  ['getLogisticsTopology', { unit_number: 42 }, /"autorio_knowledge","logistics_topology",42/],
  ['getLocalSpatialObservation', { position: { x: 1, y: 1 } }, /"autorio_planning","spatial_observation"/],
  ['planPlacement', { entity_name: 'fixture-entity', position: { x: 1, y: 1 } }, /"autorio_planning","plan_placement"/],
  ['findConstructionSites', { width: 2, height: 2, position: { x: 1, y: 1 } }, /"autorio_planning","find_construction_sites"/],
  ['getMapContext', {}, /"autorio_map","crop"/],
  ['getTaskStatus', {}, /"autorio_operations","status"/],
  ['getResearchRequest', { request_id: 42 }, /"autorio_research","request_result",42/],
]
for (const [name, args, route] of sharedWorldReads) {
  test(`shared world observation ${name} reaches its native facts route`, async () => {
    const f = fixture()
    const native = { ok: true, observed_tick: 100, state: 'unknown', code: 'fixture-native-unavailable', truncated: true }
    f.onCommand = command => route.test(command) ? JSON.stringify(native) : undefined
    assert.deepEqual(await f.bridge.observe(name, args), native, 'native unknown/truncation must not become invented successful facts')
    assert.equal(f.calls.length, 1)
    assert.match(f.calls[0], route)
  })
}

test('expanded world reads retain typed bounds and reject executable or caller-owned context before transport', async () => {
  const f = fixture()
  for (const [name, args] of [
    ['getMiningDetails', { resource_or_item: 'fixture-item', lua: 'game.print(1)' }],
    ['getResearchPath', { name: 'fixture-technology', max_nodes: 65 }],
    ['getLogisticsTopology', { unit_number: 42, radius: 17 }],
    ['getMapContext', { radius: 5 }],
    ['getLocalSpatialObservation', { half_size: 17 }],
    ['findLongRangeEntities', { name: 'fixture-entity', max_radius: 4097 }],
    ['measureTransportThroughput', { kind: 'belt_lane', unit_number: 42, lane_index: 3 }],
    ['getResearchRequest', { request_id: 42, actor_id: 999 }],
  ]) {
    await assert.rejects(f.bridge.observe(name, args), { code: 'invalid_observation_arguments' }, name)
  }
  assert.equal(f.calls.length, 0, 'invalid world queries cannot reach RCON')
})

for (const operation of [
  { name: 'walk_to_entity_exact', args: { unit_number: 42 } },
  { name: 'gather_resource', args: { resource_name: 'fixture-resource', count: 2, search_radius: 32 } },
  { name: 'supply_entity', args: { unit_number: 42, items: [{ item_name: 'fixture-item', count: 2 }] } },
]) {
  test(`core world action ${operation.name} retains atomic authority and canonical admission`, async () => {
    const f = fixture(); const prepared = await f.bridge.prepare(operation, `run/${operation.name}`)
    f.admission = row(prepared.pending)
    await f.bridge.submit(prepared)
    const command = f.calls.at(-1)
    assert.match(command, new RegExp(`autorio_operations','${operation.name}'`))
    for (const fragment of ['g.session~=', 'g.actor_id~=7', 'g.epoch~=3', 's.task_state~="idle"',
      's.batch_generation~=2', 'j.high_water~=4', 'unresolved_native_operation', 'autorio_operation_admission","begin']) {
      assert.ok(command.includes(fragment), `${operation.name}: ${fragment}`)
    }
    assert.ok(command.indexOf('autorio_preflight') < command.indexOf('autorio_operation_admission","begin'))
    const tampered = structuredClone(prepared)
    tampered.operation.args.lua = 'game.print(1)'
    const before = f.calls.length
    await assert.rejects(f.bridge.submit(tampered))
    assert.equal(f.calls.length, before, 'untyped action cannot enter the transport')
  })
}

test('exact world facts derive native ownership and preserve unavailable evidence without binding a world', async () => {
  const f = fixture()
  const args = { request_id: 'facts/one', members: [{ unit_number: 42, name: 'fixture-entity', position: { x: 2, y: -1 }, surface_index: 1, force_index: 1 }] }
  const native = { ok: false, code: 'world_unbound' }
  f.onCommand = command => command.includes('"sgluna_factory","observe"') ? JSON.stringify(native) : undefined
  assert.deepEqual(await f.bridge.observe('getWorldEntityFacts', args), native)
  const command = f.calls.at(-1)
  for (const fragment of ['"sgluna_factory","world_identity"', 'q.world_id=w.world_id', 'q.actor_id=g.actor_id',
    'q.surface_index=g.surface_index', 'q.force_index=g.force_index', '"sgluna_factory","observe",q']) assert.ok(command.includes(fragment), fragment)
  assert.equal(command.includes('bind_world_id'), false, 'a model observation cannot create or replace world identity')
  const calls = f.calls.length
  for (const bad of [
    { ...args, world_id: 'caller-world' }, { ...args, actor_id: 999 }, { ...args, schema_version: 999 },
    { ...args, members: [args.members[0], args.members[0]] }, { ...args, members: [] },
    { ...args, members: Array.from({ length: 33 }, (_, i) => ({ ...args.members[0], unit_number: i + 1 })) },
    { ...args, members: [{ ...args.members[0], position: { x: Number.NaN, y: 0 } }] },
    { ...args, members: [{ ...args.members[0], lua: 'game.print(1)' }] },
  ]) await assert.rejects(f.bridge.observe('getWorldEntityFacts', bad), { code: 'invalid_observation_arguments' })
  assert.equal(f.calls.length, calls, 'invalid ownership or member claims never reach transport')
})

for (const name of ['mine_entity_exact', 'rotate_entity']) {
  test(`exact ${name} requires a fresh native safety witness at prepare and atomic admission`, async () => {
    const f = fixture()
    const operation = { name, args: { unit_number: 42 } }
    const prepared = await f.bridge.prepare(operation, `run/${name}`)
    f.admission = row(prepared.pending)
    await f.bridge.submit(prepared)
    for (const command of [f.calls[1], f.calls.at(-1)]) assert.ok(command.includes(`"sgluna_world_safety","preflight",'${name}',42`))
    assert.match(renderExternalOperation(operation), /,true\)$/, 'execution-time safety is forced by trusted adapter')
    assert.throws(() => parseExternalOperation({ name, args: { unit_number: 42, external_world_guard: false } }))
    const sent = f.calls.filter(command => command.includes('local refusal=')).length
    f.preflight = { ok: false, code: name === 'mine_entity_exact' ? 'removal_inventory_full' : 'external_hydraulic_target_unproven' }
    await assert.rejects(f.bridge.prepare(operation, `run/${name}/refused`), error => error.code === 'preflight_rejected' && error.notAdmitted)
    assert.equal(f.calls.filter(command => command.includes('local refusal=')).length, sent)
    f.onSubmit = command => `${command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]}${JSON.stringify({ ok: false, result: 'external_guard_refused:preflight_rejected', prefix: {} })}`
    await assert.rejects(f.bridge.submit(prepared), error => error.notAdmitted && error.code === 'preflight_rejected')
  })
}

test('expanded resource and supply work remains bounded before transport', async () => {
  const f = fixture()
  for (const raw of [
    { name: 'gather_resource', args: { resource_name: 'fixture-resource', count: 101 } },
    { name: 'gather_resource', args: { resource_name: 'fixture-resource', count: 1, search_radius: 129 } },
    { name: 'walk_to_entity', args: { entity_name: 'fixture-entity', search_radius: 129 } },
    { name: 'supply_entity', args: { unit_number: 42, items: [{ item_name: 'fixture-item', count: 1001 }] } },
  ]) await assert.rejects(f.bridge.prepare(raw, 'run/oversized'))
  assert.equal(f.calls.length, 0)
})

test('throughput observation waits for its exact owned native measurement instead of returning only start admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const complete = { measurement_id: 71, state: 'completed', transferred: 2, observed_ticks: 60 }
  f.onCommand = command => command.includes('"throughput_measurement_start"') ? '{"ok":true,"measurement_id":71,"started_tick":100}'
    : command.includes('"throughput_measurement_status"') ? JSON.stringify({ tick: 160, result: complete }) : undefined
  const result = f.bridge.observe('measureTransportThroughput', { kind: 'inserter_instance', unit_number: 42, warmup_ticks: 0, window_ticks: 60 })
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(250)
  assert.deepEqual(await result, complete)
  const commands = f.calls.filter(command => command.includes('throughput_measurement_'))
  assert.equal(commands.length, 2)
  assert.match(commands[1], /"throughput_measurement_status",71/)
  for (const command of commands) {
    for (const fragment of ['g.session~=', 'g.actor_id~=7', 'g.epoch~=3', 's.task_state~="idle"', 'unresolved_native_operation']) assert.ok(command.includes(fragment), fragment)
  }
})

test('throughput authority loss cancels only the exact measurement and does not retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.onCommand = command => command.includes('"throughput_measurement_start"') ? '{"ok":true,"measurement_id":71,"started_tick":100}'
    : command.includes('"throughput_measurement_status"') ? '{"ok":false,"code":"measurement_authority_changed"}' : undefined
  const rejected = assert.rejects(f.bridge.observe('measureTransportThroughput', { kind: 'inserter_instance', unit_number: 42 }), { code: 'measurement_authority_changed' })
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(250)
  await rejected
  assert.equal(f.calls.filter(command => command.includes('"throughput_measurement_start"')).length, 1)
  assert.match(f.calls.at(-1), /"throughput_measurement_cancel",71/)
})

test('machine delivery binding uses the armed native key as metadata without operation admission', async () => {
  const f = fixture()
  f.onCommand = command => command.includes('"bind_current_machine_delivery"')
    ? JSON.stringify({ ok: true, acceptance_key: 'native-armed-key', unit_number: 42 }) : undefined
  const result = await f.bridge.bindMachineDelivery({ unit_number: 42 })
  assert.deepEqual(result, { ok: true, acceptance_key: 'native-armed-key', unit_number: 42,
    metadata_only: true, world_mutated: false, goal_verified: false })
  assert.equal(f.calls.length, 3, 'native scope is observed before and after the atomic metadata update')
  const command = f.calls[1]
  assert.match(command, /remote.call\("autorio_tools","bind_current_machine_delivery",\{unit_number=42\}\)/)
  for (const field of ['g.session~=', 'g.actor_id~=7', 'g.epoch~=3', 'g.surface_index~=1', 'g.force_index~=1']) assert.ok(command.includes(field), field)
  assert.doesNotMatch(command, /acceptance_key|arm_machine_delivery|reset|baseline/)
  assert.equal(f.state.journal.high_water, 4)
  assert.deepEqual(f.state.status.admission_journal, [])
  for (const sent of f.calls) assert.doesNotMatch(sent, /autorio_operation_admission","(?:begin|slot|finish)|local refusal=/)
})

test('machine delivery rejects caller keys, resets and executable arguments before any transport', async () => {
  const f = fixture()
  for (const input of [
    {}, { unit_number: 0 }, { unit_number: 1.5 }, { unit_number: 1000000000 },
    { unit_number: 42, acceptance_key: 'caller-key' }, { unit_number: 42, reset: true },
    { unit_number: 42, baseline: 0 }, { unit_number: 42, actor_id: 99 },
    { unit_number: 42, lua: 'game.print(1)' }, { unit_number: 42, method: 'arm_machine_delivery' },
  ]) await assert.rejects(f.bridge.bindMachineDelivery(input), { code: 'invalid_machine_delivery_binding' })
  assert.equal(f.calls.length, 0)
})

for (const [label, mutate, code] of [
  ['actor', state => { state.guard.actor_id++ }, 'machine_delivery_scope_changed'],
  ['epoch', state => { state.guard.epoch++ }, 'machine_delivery_scope_changed'],
  ['session', state => { state.guard.session = 'replacement-session' }, 'session_not_owned'],
  ['surface', state => { state.guard.surface_index++ }, 'machine_delivery_scope_changed'],
  ['force', state => { state.guard.force_index++ }, 'machine_delivery_scope_changed'],
]) {
  test(`machine delivery refuses a changed ${label} after the native metadata reply`, async () => {
    const f = fixture()
    f.onCommand = command => {
      if (!command.includes('"bind_current_machine_delivery"')) return undefined
      mutate(f.state)
      return '{"ok":true,"acceptance_key":"native-armed-key","unit_number":42}'
    }
    await assert.rejects(f.bridge.bindMachineDelivery({ unit_number: 42 }), { code })
    assert.equal(f.calls.filter(command => command.includes('"bind_current_machine_delivery"')).length, 1, 'no retry after a possibly applied metadata selection')
  })
}

test('machine delivery cannot bind without owned current world scope or a passing atomic native fence', async () => {
  for (const scope of ['surface_index', 'force_index']) {
    const f = fixture(); delete f.state.guard[scope]
    await assert.rejects(f.bridge.bindMachineDelivery({ unit_number: 42 }), { code: 'machine_delivery_world_scope_unavailable' })
    assert.equal(f.calls.length, 1)
  }
  const f = fixture(); f.state.guard.session = 'other-owner'
  await assert.rejects(f.bridge.bindMachineDelivery({ unit_number: 42 }), { code: 'session_not_owned' })
  assert.equal(f.calls.length, 1)
  f.state.guard.session = session
  f.onCommand = command => command.includes('"bind_current_machine_delivery"') ? '{"ok":false,"error":"machine_delivery_scope_changed"}' : undefined
  await assert.rejects(f.bridge.bindMachineDelivery({ unit_number: 42 }), { code: 'machine_delivery_scope_changed' })
  assert.equal(f.calls.filter(command => command.includes('"bind_current_machine_delivery"')).length, 1)
})

const line = { name: 'place_line', args: { entity_name: 'transport-belt', x: 2.5, y: -3.5, direction: 4, line_direction: 4, count: 3 } }
function lineFixture() {
  const f = fixture()
  Object.assign(f.state.status, { placement_no_clear_supported: true, external_line_placement_supported: 1 })
  return f
}

test('place_line parses exact bounded arguments, fills defaults and renders one native remote call', () => {
  assert.deepEqual(parseExternalOperation(line).args, { ...line.args, spacing: 1 })
  assert.deepEqual(parseExternalOperation({ name: 'place_line', args: { entity_name: 'small-electric-pole', x: 0.5, y: 0.5, line_direction: 8, count: 4, spacing: 5 } }).args,
    { entity_name: 'small-electric-pole', x: 0.5, y: 0.5, direction: 0, line_direction: 8, count: 4, spacing: 5 })
  assert.equal(renderExternalOperation(line), `remote.call("autorio_operations","place_line",'transport-belt',2.5,-3.5,4,4,3,1)`)
  for (const args of [
    { ...line.args, entity_name: 'stone-furnace' }, { ...line.args, count: 0 }, { ...line.args, count: 33 }, { ...line.args, spacing: 9 },
    { ...line.args, line_direction: 2 }, { ...line.args, direction: 6 }, { ...line.args, x: Number.NaN }, { ...line.args, refuse_clearance: false },
    { ...line.args, lua: 'game.print(1)' }, { ...line.args, count: 2.5 },
  ]) assert.throws(() => parseExternalOperation({ name: 'place_line', args }), JSON.stringify(args))
  const catalog = capabilities()
  assert.deepEqual(catalog.limits.line_prototypes, ['transport-belt', 'small-electric-pole'])
  assert.equal(catalog.limits.line_count, 32)
  assert.equal(catalog.limits.line_spacing, 8)
  assert.ok(catalog.operations.find(item => item.name === 'place_line').external_only)
})

test('place_line needs both safety capabilities and every tile within walk range before any game call', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.prepare(line, 'run/line'), error => error.code === 'line_placement_capability_missing' && error.notSent)
  f.state.status.placement_no_clear_supported = true
  await assert.rejects(f.bridge.prepare(line, 'run/line'), { code: 'line_placement_capability_missing' })
  f.state.status.external_line_placement_supported = 1
  f.state.status.actor.position = { x: -100, y: -3.5 }
  const far = { name: 'place_line', args: { ...line.args, x: 20.5, count: 10, spacing: 1 } }
  await assert.rejects(f.bridge.prepare(far, 'run/line'), error => error.code === 'operation_limit' && error.details.tile_index === 8 && error.notSent)
  assert.ok(!f.calls.some(command => command.includes('autorio_preflight')))
})

test('place_line preflight checks every tile with the external footprint rule and names the refused tile', async () => {
  const f = lineFixture()
  f.preflight = { ok: false, code: 'placement_footprint_occupied', tile_index: 1, blockers: [{ name: 'item-on-ground', type: 'item-entity', position: { x: 3.5, y: -3.5 }, item: 'iron-plate' }] }
  await assert.rejects(f.bridge.prepare(line, 'run/line'), error => error.notSent && error.details.native_code === 'placement_footprint_occupied'
    && error.details.tile_index === 1 && error.details.blockers[0].item === 'iron-plate' && /Line tile 1 refused/.test(error.publicMessage))
  const command = f.calls.find(text => text.includes('autorio_preflight'))
  for (const fragment of ['"place_line"', 'limit=129', 'tile_index=i-1', 'preservation_nonfluid_output']) assert.ok(command.includes(fragment), fragment)
  // Trial 4r: only the line's re-check exempts the actor's own character (the runtime steps out of each tile before placing).
  assert.ok(command.includes('local own=remote.call("sgluna_deployment","status").actor_id') && command.includes('external_footprint(surface,t.world_box,own)'))
  assert.ok(command.includes('not (own and e.type=="character" and e.unit_number==own)'))
  f.preflight = { ok: false, code: 'line_placement_items_insufficient', placement_item: { item_name: 'transport-belt', count: 3, held_count: 1, required_count: 3 } }
  await assert.rejects(f.bridge.prepare(line, 'run/line'), error => error.details.native_code === 'line_placement_items_insufficient'
    && error.details.placement_item.held_count === 1 && /Requires 3 transport-belt, holds 1/.test(error.publicMessage))
})

test('place_line submit rechecks the line capability atomically and proves a guard refusal not admitted', async () => {
  const f = lineFixture()
  const prepared = await f.bridge.prepare(line, 'run/line')
  f.onSubmit = command => {
    assert.ok(command.includes('s.external_line_placement_supported~=1 then return "line_placement_capability_missing"'))
    assert.ok(command.includes('for _,t in ipairs({{2.5,-3.5},{3.5,-3.5},{4.5,-3.5}}) do if (p.x-(t[1]))^2+(p.y-(t[2]))^2>16384 then return "walk_out_of_range"'), 'every tile is rechecked against the live actor position')
    assert.ok(command.includes(`remote.call("autorio_operations","place_line",'transport-belt',2.5,-3.5,4,4,3,1)`))
    return `${command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]}${JSON.stringify({ ok: false, result: 'external_guard_refused:line_placement_capability_missing', prefix: {} })}`
  }
  await assert.rejects(f.bridge.submit(prepared), error => error.notAdmitted && error.code === 'line_placement_capability_missing')
})

function lineRecord(pending, placed, extra = {}) {
  return { ok: true, line: { line_id: 4, actor_id: 7, entity_name: 'transport-belt', count: 3, origin: { x: 2.5, y: -3.5 }, direction: 4, line_direction: 4, spacing: 1,
    batch_id: 1, batch_generation: 2, batch_ref: 'batch-g2-1',
    placed: placed.map(index => ({ index, unit_number: 50 + index, name: 'transport-belt', position: { x: 2.5 + index, y: -3.5 }, direction: 4, tick: 120 + index })), ...extra } }
}

test('a completed line receipt lists each placed entity; a short native line record is never completion', async () => {
  const f = lineFixture()
  const prepared = await f.bridge.prepare(line, 'run/line')
  const admission = row(prepared.pending, 'completed'); admission.slots[0].queued_tasks = 3
  f.state.status.admission_journal = [admission]
  f.state.status.receipt_journal = [{ batch_id: 1, batch_generation: 2, batch_ref: 'batch-g2-1', state: 'completed', task_count: 3, task_types: ['placing', 'placing', 'placing'], tick: 180 }]
  f.state.journal.high_water = 5
  let record = lineRecord(prepared.pending, [0, 1, 2])
  f.onCommand = command => command.includes("\"line_placement_status\",'batch-g2-1'") ? JSON.stringify(record) : undefined
  const done = await f.bridge.receipt(prepared.pending)
  assert.equal(done.state, 'completed')
  assert.equal(done.goal_verified, false)
  assert.deepEqual(done.line_placement.placed.map(entity => [entity.index, entity.unit_number, entity.position.x]), [[0, 50, 2.5], [1, 51, 3.5], [2, 52, 4.5]])
  assert.equal(done.line_placement.placed_count, 3)
  assert.equal(done.line_placement.refusal, null)
  record = lineRecord(prepared.pending, [0, 1])
  const short = await f.bridge.receipt(prepared.pending)
  assert.equal(short.state, 'uncertain')
  assert.equal(short.reason, 'line_receipt_incomplete')
  assert.equal(short.requires_reconciliation, true)
  record = { ...lineRecord(prepared.pending, [0, 1, 2]), line: { ...lineRecord(prepared.pending, [0, 1, 2]).line, batch_ref: 'batch-g2-9' } }
  const foreign = await f.bridge.receipt(prepared.pending)
  assert.equal(foreign.state, 'uncertain', 'a line record of another batch is not this receipt')
  assert.equal(foreign.line_placement, null)
  record = { ...lineRecord(prepared.pending, [0, 1, 2]), line: { ...lineRecord(prepared.pending, [0, 1, 2]).line, spacing: 2 } }
  const other = await f.bridge.receipt(prepared.pending)
  assert.equal(other.state, 'uncertain', 'a record whose arguments do not reproduce the request identity is not this line')
  assert.equal(other.line_placement, null)
})

// Trial 4r: ore a drill dropped on the ground blocked belt tiles, and nothing could pick it up. Placement still never clears;
// pick_up_ground_items is the separate, bounded operation for items on the ground.
const pickup = { name: 'pick_up_ground_items', args: { x: 3.4, y: -2.7, radius: 1 } }
function pickupFixture() {
  const f = fixture()
  f.state.status.external_ground_pickup_supported = 1
  f.preflight = { ok: true, operation: 'pick_up_ground_items', items: [
    { name: 'iron-ore', count: 3, position: { x: 3.3, y: -2.6 } }, { name: 'stone', count: 1, position: { x: 4.1, y: -2.2 } },
    { name: 'iron-ore', count: 2, position: { x: 2.9, y: -3.1 } }] }
  return f
}

test('pick_up_ground_items parses bounded arguments, fills the radius and renders one native remote call', () => {
  assert.deepEqual(parseExternalOperation(pickup).args, pickup.args)
  assert.deepEqual(parseExternalOperation({ name: 'pick_up_ground_items', args: { x: -1, y: 2 } }).args, { x: -1, y: 2, radius: 0 })
  assert.equal(renderExternalOperation(pickup), 'remote.call("autorio_operations","pick_up_ground_items",3.4,-2.7,1)')
  for (const args of [
    { ...pickup.args, radius: 3 }, { ...pickup.args, radius: -1 }, { ...pickup.args, radius: 1.5 }, { ...pickup.args, x: Number.NaN },
    { y: 0, radius: 0 }, { ...pickup.args, entity_name: 'tree' }, { ...pickup.args, lua: 'game.print(1)' }, { ...pickup.args, x: 2000000 },
  ]) assert.throws(() => parseExternalOperation({ name: 'pick_up_ground_items', args }), JSON.stringify(args))
  const catalog = capabilities()
  assert.ok(OPERATION_NAMES.includes('pick_up_ground_items'))
  assert.ok(catalog.operations.find(item => item.name === 'pick_up_ground_items').external_only)
  assert.equal(catalog.limits.pickup_radius, 2)
  assert.match(catalog.operation_notes.pick_up_ground_items, /Nothing else in the box is mined/)
  assert.match(catalog.operation_notes.place_entity, /picked up with pick_up_ground_items/)
})

test('pick_up_ground_items needs the native capability and a box within walk range before any game call', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.prepare(pickup, 'run/pickup'), error => error.code === 'ground_pickup_capability_missing' && error.notSent)
  f.state.status.external_ground_pickup_supported = 1
  f.state.status.actor.position = { x: 200, y: 0 }
  await assert.rejects(f.bridge.prepare(pickup, 'run/pickup'), error => error.code === 'operation_limit' && error.details.maximum === 128 && error.notSent)
  assert.ok(!f.calls.some(command => command.includes('autorio_preflight')))
})

test('pick_up_ground_items preflight names what it refuses and probes the inventory of every item it found', async () => {
  const f = pickupFixture()
  f.probe = { ok: true, tick: 120, actor_id: 7, position: { x: 0, y: 0 }, items: { 'iron-ore': 10, stone: 0 } }
  const prepared = await f.bridge.prepare(pickup, 'run/pickup')
  assert.ok(f.calls.some(command => command.includes('remote.call("autorio_preflight","operation","pick_up_ground_items",{x=3.4,y=-2.7,radius=1})')))
  assert.match(f.calls.at(-1), /\{'iron-ore','stone'\}/, 'each found item once')
  assert.deepEqual(prepared.observed_before.items, { 'iron-ore': 10, stone: 0 })
  // The runtime passes the names in observed_before back for the receipt's after-probe.
  await f.bridge.effectProbe(pickup, Object.keys(prepared.observed_before.items))
  assert.match(f.calls.at(-1), /\{'iron-ore','stone'\}/)
  for (const code of ['no_ground_items', 'ground_items_over_limit', 'inventory_full']) {
    f.preflight = { ok: false, code }
    await assert.rejects(f.bridge.prepare(pickup, 'run/pickup'), error => error.notSent && error.details.native_code === code
      && !/Re-observe the target before choosing different arguments/.test(error.publicMessage))
  }
})

test('a placement refused by an item on the ground points at pick_up_ground_items', async () => {
  const f = fixture(); f.state.status.placement_no_clear_supported = true
  f.preflight = { ok: false, code: 'placement_footprint_occupied', blockers: [{ name: 'item-on-ground', type: 'item-entity', position: { x: 1, y: 2 }, item: 'iron-ore' }] }
  await assert.rejects(f.bridge.prepare({ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 0, y: 0 } }, 'run/blocked'),
    error => /picked up first with pick_up_ground_items/.test(error.publicMessage))
})

test('pick_up_ground_items submit rechecks capability, range and the box atomically, and a refusal is not admitted', async () => {
  const f = pickupFixture()
  const prepared = await f.bridge.prepare(pickup, 'run/pickup')
  f.onSubmit = command => {
    assert.ok(command.includes('if s.external_ground_pickup_supported~=1 then return "ground_pickup_capability_missing" end'))
    assert.ok(command.includes('(p.x-(3.4))^2+(p.y-(-2.7))^2>16384 then return "walk_out_of_range"'))
    assert.ok(command.includes('local p=remote.call("autorio_preflight","operation","pick_up_ground_items",{x=3.4,y=-2.7,radius=1}); if p.ok~=true then return "preflight_rejected"'))
    assert.ok(command.includes('remote.call("autorio_operations","pick_up_ground_items",3.4,-2.7,1)'))
    assert.ok(!command.includes('placement_no_clear_supported'), 'a pickup is not a placement')
    return `${command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]}${JSON.stringify({ ok: false, result: 'external_guard_refused:preflight_rejected:no_ground_items', prefix: {} })}`
  }
  await assert.rejects(f.bridge.submit(prepared), error => error.notAdmitted && error.code === 'preflight_rejected'
    && error.details.native_code === 'no_ground_items')
  f.onSubmit = command => `${command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]}${JSON.stringify({ ok: false, result: 'external_guard_refused:ground_pickup_capability_missing', prefix: {} })}`
  await assert.rejects(f.bridge.submit(prepared), error => error.notAdmitted && error.code === 'ground_pickup_capability_missing')
})
