import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkpointMachineRequirements,
  compactMachineFacts,
  compactMachineInventories,
  conditionWakeCause,
  freshReadCondition,
  isWaitOnlyBatch,
  mostRecentWorkingUnit,
  waitOnlyTicks,
  WAIT_FACT_MAX_MACHINES,
} from './production-wait.mjs'

// Repair unit B pure helpers: when a batch is a blind timer, which machines a fresh read targets, and how the
// engine's answers are shaped into bounded facts.

const waitOp = ticks => ({ name: 'wait', args: { ticks } })

// The shape autorio_tools.get_entity_status returns for a stone furnace (fuel, source, result, modules).
function furnaceEntity({ fuel = [], input = [], output = [] } = {}) {
  return {
    name: 'stone-furnace',
    type: 'furnace',
    unit_number: 582,
    status: 1,
    working: true,
    inventories: [
      { index: 1, items: fuel },
      { index: 2, items: input },
      { index: 3, items: output },
      { index: 4, items: [] },
      { index: 6, items: [] },
    ],
  }
}

test('only a non-empty batch of wait operations is wait-only', () => {
  assert.equal(isWaitOnlyBatch([waitOp(600)]), true)
  assert.equal(isWaitOnlyBatch([waitOp(600), waitOp(60)]), true)
  assert.equal(isWaitOnlyBatch([]), false)
  assert.equal(isWaitOnlyBatch(undefined), false)
  assert.equal(isWaitOnlyBatch([waitOp(600), { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }]), false)
  assert.equal(isWaitOnlyBatch([{ name: 'craft_item', args: {} }]), false)
  assert.equal(waitOnlyTicks([waitOp(600), waitOp(60)]), 660)
  assert.equal(waitOnlyTicks([waitOp(600), { name: 'craft_item', args: {} }]), 0)
})

test('checkpoint machine requirements name exact machines, unique and bounded', () => {
  const contract = {
    mode: 'all',
    requirements: [
      { id: 'a', kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 50 },
      { id: 'b', kind: 'inventory_count', item_name: 'coal', minimum: 5 },
      { id: 'c', kind: 'entity_inventory_count', unit_number: 582, item_name: 'copper-plate', minimum: 5 },
      { id: 'd', kind: 'entity_state', unit_number: 583, expected: 'working' },
      { id: 'e', kind: 'entity_exists', unit_number: 584 },
      { id: 'f', kind: 'entity_exists', unit_number: 585 },
    ],
  }
  const found = checkpointMachineRequirements(contract)
  assert.deepEqual(found.map(requirement => requirement.unit_number), [582, 583, 584])
  assert.equal(found.length, WAIT_FACT_MAX_MACHINES)
  assert.deepEqual(checkpointMachineRequirements(undefined), [])
  assert.deepEqual(checkpointMachineRequirements({ mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'coal', minimum: 1 }] }), [])
})

test('the most recently observed working machine wins, newest first', () => {
  const observations = [
    { unit_number: 1, working: true },
    { unit_number: 2, working: true },
    { unit_number: 3, working: false },
    { name: 'tree', working: true },
  ]
  assert.equal(mostRecentWorkingUnit(observations), 2)
  assert.equal(mostRecentWorkingUnit([{ unit_number: 3, working: false }]), undefined)
  assert.equal(mostRecentWorkingUnit(undefined), undefined)
})

test('a fresh read evaluates the checkpoint count for its own machine and the working state otherwise', () => {
  const requirement = { id: 'a', kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 50 }
  assert.deepEqual(freshReadCondition(582, requirement), { kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 50 })
  assert.deepEqual(freshReadCondition(583, requirement), { kind: 'entity_state', unit_number: 583, expected: 'working' })
  assert.deepEqual(freshReadCondition(582, undefined), { kind: 'entity_state', unit_number: 582, expected: 'working' })
})

test('crafter inventories report fuel, input and output counts and keep an empty fuel slot visible', () => {
  const inventories = compactMachineInventories(furnaceEntity({
    fuel: [],
    input: [{ name: 'iron-ore', quality: 'normal', count: 2 }],
    output: [{ name: 'iron-plate', quality: 'normal', count: 47 }],
  }))
  assert.deepEqual(inventories, { fuel: {}, input: { 'iron-ore': 2 }, output: { 'iron-plate': 47 } })
  // A non-crafter keeps raw inventory indexes.
  assert.deepEqual(
    compactMachineInventories({ type: 'container', inventories: [{ index: 1, items: [{ name: 'coal', count: 9 }] }] }),
    { inventory_1: { coal: 9 } },
  )
  assert.equal(compactMachineInventories(undefined), undefined)
})

test('machine facts carry status, checkpoint target against current, eta and inventories', () => {
  const facts = compactMachineFacts({
    unitNumber: 582,
    known: { name: 'stone-furnace', recipe: undefined },
    requirement: { kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 50 },
    raw: {
      ok: true,
      kind: 'entity_inventory_count',
      satisfied: false,
      current: 47,
      minimum: 50,
      unit_number: 582,
      progressing: true,
      progress_known: true,
      entity_status: 1,
      eta: { recipe: 'iron-plate', seconds_per_craft: 3.2, crafts_needed: 3, seconds_to_target: 9.6, seconds_until_idle: 12.5, basis: 'ignored long basis text' },
    },
    entity: furnaceEntity({ fuel: [{ name: 'coal', count: 4 }], input: [{ name: 'iron-ore', count: 2 }], output: [{ name: 'iron-plate', count: 47 }] }),
    inventoryRead: 'matched',
  })
  assert.equal(facts.unit_number, 582)
  assert.equal(facts.name, 'stone-furnace')
  assert.equal(facts.working, true)
  assert.equal(facts.status_code, 1)
  assert.deepEqual(facts.checkpoint, { item_name: 'iron-plate', minimum: 50, current: 47, satisfied: false })
  assert.equal(facts.eta.seconds_to_target, 9.6)
  assert.equal('basis' in facts.eta, false, 'the long basis text is not carried')
  assert.deepEqual(facts.inventories, { fuel: { coal: 4 }, input: { 'iron-ore': 2 }, output: { 'iron-plate': 47 } })
  assert.equal(facts.inventory_read, 'matched')
  assert.ok(JSON.stringify(facts).length < 600, 'one machine stays compact')
})

test('a failed or stale read is reported, never invented', () => {
  assert.deepEqual(
    compactMachineFacts({ unitNumber: 9, raw: { ok: false, error: 'stale_exact_identity', stale: true } }),
    { unit_number: 9, read: 'fresh', error: 'stale_exact_identity', stale: true },
  )
  assert.equal(compactMachineFacts({ unitNumber: 9, raw: undefined }).error, 'machine_read_failed')
})

test('the wake cause comes from the engine limit, the stop kind or the deadline', () => {
  const machine = limited => ({ eta: limited ? { limited_by: limited } : undefined })
  assert.equal(conditionWakeCause({ action: 'verified' }), 'satisfied')
  assert.equal(conditionWakeCause({ action: 'timeout', reason: 'condition_timeout', machine: machine('fuel') }), 'timeout')
  assert.equal(conditionWakeCause({ action: 'failed', reason: 'condition_unsatisfied_and_not_progressing', machine: machine('fuel') }), 'missing_fuel')
  assert.equal(conditionWakeCause({ action: 'failed', reason: 'condition_unsatisfied_and_not_progressing', machine: machine('inputs') }), 'missing_input')
  assert.equal(conditionWakeCause({ action: 'failed', reason: 'condition_unsatisfied_and_not_progressing', machine: machine('output_full') }), 'output_full')
  assert.equal(conditionWakeCause({ action: 'failed', reason: 'condition_unsatisfied_and_not_progressing', machine: machine('power') }), 'no_power')
  assert.equal(conditionWakeCause({ action: 'wake', reason: 'passive_progress_stopped', machine: machine() }), 'machine_stopped')
  assert.equal(conditionWakeCause({ action: 'failed', reason: 'stale_exact_identity' }), 'machine_gone')
  assert.equal(conditionWakeCause({ action: 'failed', reason: 'condition_lifecycle_changed' }), 'condition_lifecycle_changed')
})
