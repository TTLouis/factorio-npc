import assert from 'node:assert/strict'
import test from 'node:test'

import * as base from '../staging/structured-policy.mjs'
import {
  approvedOperationNames,
  approvedOperationScopes,
  mergeOperationMetadataCatalog,
  operationArgumentKeys,
  operationMetadataCatalog,
  operationMetadataForName,
  operationNamesForScope,
  operationScopesForName,
  operationTypeCatalog,
  operationTypeCatalogForScope,
  parseOperation,
} from './structured-policy.mjs'

const fixtures = Object.freeze({
  walk_to_entity: { name: 'walk_to_entity', args: { entity_name: 'stone-furnace', search_radius: 64 } },
  walk_to_entity_exact: { name: 'walk_to_entity_exact', args: { unit_number: 1 } },
  walk_to_position: { name: 'walk_to_position', args: { x: 0, y: 0 } },
  walk_to_player: { name: 'walk_to_player', args: { player_name: 'player' } },
  follow_player: { name: 'follow_player', args: { player_name: 'player' } },
  stop_follow_player: { name: 'stop_follow_player', args: {} },
  set_auto_defense: { name: 'set_auto_defense', args: { enabled: true } },
  equip_weapon: { name: 'equip_weapon', args: { item_name: 'pistol' } },
  equip_ammo: { name: 'equip_ammo', args: { item_name: 'firearm-magazine' } },
  equip_armor: { name: 'equip_armor', args: { item_name: 'light-armor' } },
  select_weapon_slot: { name: 'select_weapon_slot', args: { slot: 1 } },
  mine_entity: { name: 'mine_entity', args: { entity_name: 'tree-01' } },
  mine_entity_exact: { name: 'mine_entity_exact', args: { unit_number: 1 } },
  mine_resource_at: { name: 'mine_resource_at', args: { resource_name: 'iron-ore', x: 0, y: 0 } },
  gather_resource: { name: 'gather_resource', args: { resource_name: 'iron-ore' } },
  harvest_product: { name: 'harvest_product', args: { product_name: 'wood' } },
  clear_construction_area: { name: 'clear_construction_area', args: { x: 0, y: 0, width: 2, height: 2 } },
  supply_entity: { name: 'supply_entity', args: { unit_number: 1, items: [{ item_name: 'coal', count: 1 }] } },
  execute_construction_plan: { name: 'execute_construction_plan', args: { validation_id: 1, placement_count: 1 } },
  place_entity: { name: 'place_entity', args: { entity_name: 'stone-furnace' } },
  place_candidate: { name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } },
  rotate_entity: { name: 'rotate_entity', args: { unit_number: 1 } },
  move_items: { name: 'move_items', args: { item_name: 'coal', entity_name: 'stone-furnace', max_count: 1, to_entity: true } },
  move_items_exact: { name: 'move_items_exact', args: { item_name: 'coal', unit_number: 1, max_count: 1, to_entity: true } },
  set_machine_recipe: { name: 'set_machine_recipe', args: { unit_number: 1, recipe_name: 'iron-gear-wheel' } },
  move_items_with_player: { name: 'move_items_with_player', args: { item_name: 'coal', player_name: 'player', max_count: 1, to_player: true } },
  craft_item: { name: 'craft_item', args: { item_name: 'iron-gear-wheel' } },
  attack_nearest_enemy: { name: 'attack_nearest_enemy', args: {} },
  clear_enemy_area: { name: 'clear_enemy_area', args: {} },
  research_technology: { name: 'research_technology', args: { technology_name: 'automation' } },
  wait: { name: 'wait', args: { ticks: 60 } },
})

test('every approved runtime operation has one deterministic metadata record', () => {
  const names = approvedOperationNames()
  const catalog = operationMetadataCatalog()

  assert.equal(new Set(names).size, names.length)
  assert.deepEqual(Object.keys(catalog), names)
  assert.deepEqual(Object.keys(fixtures).sort(), [...names].sort())

  for (const name of names) {
    assert.equal(catalog[name].name, name)
    assert.deepEqual(operationMetadataForName(name), catalog[name])
  }
})

test('all operation scopes are declared, deterministic, and duplicate-free', () => {
  const scopes = approvedOperationScopes()
  assert.equal(new Set(scopes).size, scopes.length)

  for (const scope of scopes) {
    const names = operationNamesForScope(scope)
    assert.equal(new Set(names).size, names.length)
    assert.deepEqual(names, operationNamesForScope(scope))
    for (const name of names) {
      assert.ok(approvedOperationNames().includes(name))
      assert.ok(operationScopesForName(name).includes(scope))
    }

    const typed = operationTypeCatalogForScope(scope)
    assert.deepEqual(typed.map(entry => entry.name), names)
    assert.ok(typed.every(entry => entry.scopes.includes(scope)))
  }
})

test('operation argument metadata and parseOperation stay structurally aligned', () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    const metadata = operationMetadataForName(name)
    const accepted = operationArgumentKeys(name)
    assert.deepEqual(Object.keys(metadata.arguments), accepted)

    const parsed = parseOperation(fixture)
    assert.equal(parsed.name, name)
    assert.ok(Object.keys(parsed.args).every(key => accepted.includes(key)))

    for (const [key, spec] of Object.entries(metadata.arguments)) {
      if (spec.required || spec.defaulted) {
        assert.equal(Object.hasOwn(parsed.args, key), true, `${name} parser omitted required/defaulted metadata argument ${key}`)
      }
    }

    assert.throws(
      () => parseOperation({ name, args: { ...fixture.args, __metadata_drift_probe__: true } }),
      /Unexpected argument/,
    )
  }
})

test('runtime extension operations are present without redefining base operations', () => {
  const baseNames = new Set(base.approvedOperationNames())
  assert.equal(baseNames.has('place_candidate'), false)
  assert.equal(approvedOperationNames().includes('place_candidate'), true)

  const place = operationMetadataForName('place_candidate')
  assert.deepEqual(place.scopes, ['construction'])
  assert.equal(place.arguments.candidate_set_id.provenance, 'placement_candidate_registry')
  assert.equal(place.arguments.candidate_id.provenance, 'placement_candidate_registry')

  for (const name of baseNames) {
    assert.deepEqual(operationMetadataForName(name), base.operationMetadataForName(name))
  }
})

test('metadata extensions cannot silently redefine incompatible base metadata', () => {
  const baseCatalog = base.operationMetadataCatalog()
  const conflicting = {
    ...baseCatalog.walk_to_entity,
    risk: baseCatalog.walk_to_entity.risk === 'low' ? 'high' : 'low',
  }

  assert.throws(
    () => mergeOperationMetadataCatalog(baseCatalog, { walk_to_entity: conflicting }),
    /cannot redefine walk_to_entity/,
  )

  assert.doesNotThrow(() => mergeOperationMetadataCatalog(baseCatalog, {
    walk_to_entity: baseCatalog.walk_to_entity,
  }))
})

test('scope-specific type catalogs are projections of the authoritative metadata catalog', () => {
  const full = operationTypeCatalog()
  assert.deepEqual(full.map(entry => entry.name), approvedOperationNames())

  for (const entry of full) {
    assert.deepEqual(entry.args, operationArgumentKeys(entry.name))
    assert.deepEqual(entry.arguments, operationMetadataForName(entry.name).arguments)
    assert.deepEqual(entry.scopes, operationScopesForName(entry.name))
  }

  assert.ok(operationNamesForScope('logistics').includes('supply_entity'))
  assert.ok(operationNamesForScope('production').includes('supply_entity'))
  assert.ok(operationNamesForScope('logistics').includes('move_items_exact'))
  assert.ok(operationNamesForScope('production').includes('move_items_exact'))
  assert.ok(operationNamesForScope('construction').includes('place_candidate'))
})
