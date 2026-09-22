import test from 'node:test'
import assert from 'node:assert/strict'
import { approvedOperationNames, operationArgumentKeys, operationMetadataCatalog, operationMetadataForName, parseOperation, parsePlan, renderOperation, renderOperationPreflight, toolCommand, toolDefinitions } from './structured-policy.mjs'

test('structured operations apply bounded defaults and render only approved Autorio calls', () => {
  assert.deepEqual(parseOperation({ name: 'mine_entity', args: { entity_name: 'iron-ore' } }), {
    name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 },
  })
  assert.deepEqual(parseOperation({ name: 'harvest_product', args: { product_name: 'stone', count: 6 } }), {
    name: 'harvest_product', args: { product_name: 'stone', count: 6, search_radius: 256 },
  })
  assert.deepEqual(parseOperation({ name: 'clear_construction_area', args: { x: 10, y: -4, width: 12, height: 8 } }), {
    name: 'clear_construction_area', args: { x: 10, y: -4, width: 12, height: 8 },
  })
  assert.equal(
    renderOperation({ name: 'clear_construction_area', args: { x: 10, y: -4, width: 12, height: 8 } }),
    "remote.call('autorio_operations','clear_construction_area',10,-4,12,8)",
  )
  assert.equal(
    renderOperation({ name: 'harvest_product', args: { product_name: 'wood', count: 10, search_radius: 128 } }),
    "remote.call('autorio_operations','harvest_product','wood',10,128)",
  )
  assert.deepEqual(parseOperation({ name: 'attack_nearest_enemy', args: {} }), {
    name: 'attack_nearest_enemy', args: { search_radius: 50 },
  })
  assert.deepEqual(parseOperation({ name: 'follow_player', args: { player_name: 'TTLouis' } }), {
    name: 'follow_player', args: { player_name: 'TTLouis', follow_distance: 4 },
  })
  assert.deepEqual(parseOperation({ name: 'set_auto_defense', args: { enabled: false } }), {
    name: 'set_auto_defense', args: { enabled: false },
  })
  assert.deepEqual(parseOperation({ name: 'walk_to_player', args: { player_name: 'TTLouis' } }), {
    name: 'walk_to_player', args: { player_name: 'TTLouis' },
  })
  assert.deepEqual(parseOperation({ name: 'equip_weapon', args: { item_name: 'rocket-launcher' } }), {
    name: 'equip_weapon', args: { item_name: 'rocket-launcher', slot: 1 },
  })
  assert.deepEqual(parseOperation({ name: 'equip_ammo', args: { item_name: 'atomic-bomb' } }), {
    name: 'equip_ammo', args: { item_name: 'atomic-bomb', slot: 1 },
  })
  assert.deepEqual(parseOperation({ name: 'equip_armor', args: { item_name: 'modular-armor' } }), {
    name: 'equip_armor', args: { item_name: 'modular-armor' },
  })
  assert.deepEqual(parseOperation({ name: 'select_weapon_slot', args: { slot: 2 } }), {
    name: 'select_weapon_slot', args: { slot: 2 },
  })
  assert.deepEqual(parseOperation({ name: 'move_items_exact', args: { item_name: 'firearm-magazine', unit_number: 4242, max_count: 10, to_entity: true } }), {
    name: 'move_items_exact', args: { item_name: 'firearm-magazine', unit_number: 4242, max_count: 10, to_entity: true },
  })
  assert.deepEqual(parseOperation({ name: 'set_machine_recipe', args: { unit_number: 4242, recipe_name: 'iron-gear-wheel' } }), {
    name: 'set_machine_recipe', args: { unit_number: 4242, recipe_name: 'iron-gear-wheel' },
  })
  assert.deepEqual(parseOperation({ name: 'move_items_with_player', args: { item_name: 'stone', player_name: 'TTLouis', max_count: 10, to_player: true } }), {
    name: 'move_items_with_player', args: { item_name: 'stone', player_name: 'TTLouis', max_count: 10, to_player: true },
  })
  assert.deepEqual(parseOperation({ name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 4096 } }), {
    name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 4096 },
  })
  assert.deepEqual(parseOperation({ name: 'place_entity', args: { entity_name: 'assembling-machine-1', x: 12.5, y: -4, direction: 6 } }), {
    name: 'place_entity', args: { entity_name: 'assembling-machine-1', x: 12.5, y: -4, direction: 6 },
  })
  assert.equal(renderOperation({ name: 'wait', args: { ticks: 60 } }), "remote.call('autorio_operations','wait',60)")
  assert.equal(renderOperation({ name: 'place_entity', args: { entity_name: "mod's-chest" } }), "remote.call('autorio_operations','place_entity','mod\\'s-chest')")
  assert.equal(renderOperation({ name: 'place_entity', args: { entity_name: 'transport-belt', direction: 4 } }), "remote.call('autorio_operations','place_entity','transport-belt',nil,nil,4)")
  assert.equal(renderOperation({ name: 'place_entity', args: { entity_name: 'assembling-machine-1', x: 12.5, y: -4, direction: 6 } }), "remote.call('autorio_operations','place_entity','assembling-machine-1',12.5,-4,6)")
  assert.equal(renderOperation({ name: 'follow_player', args: { player_name: 'TTLouis', follow_distance: 3.5 } }), "remote.call('autorio_operations','follow_player','TTLouis',3.5)")
  assert.equal(renderOperation({ name: 'set_auto_defense', args: { enabled: true } }), "remote.call('autorio_operations','set_auto_defense',true)")
  assert.equal(renderOperation({ name: 'walk_to_player', args: { player_name: 'TTLouis' } }), "remote.call('autorio_operations','walk_to_player','TTLouis')")
  assert.equal(renderOperation({ name: 'equip_weapon', args: { item_name: 'rocket-launcher', slot: 2 } }), "remote.call('autorio_operations','equip_weapon','rocket-launcher',2)")
  assert.equal(renderOperation({ name: 'equip_ammo', args: { item_name: 'atomic-bomb', slot: 2 } }), "remote.call('autorio_operations','equip_ammo','atomic-bomb',2)")
  assert.equal(renderOperation({ name: 'equip_armor', args: { item_name: 'modular-armor' } }), "remote.call('autorio_operations','equip_armor','modular-armor')")
  assert.equal(renderOperation({ name: 'select_weapon_slot', args: { slot: 2 } }), "remote.call('autorio_operations','select_weapon_slot',2)")
  assert.equal(renderOperation({ name: 'move_items_exact', args: { item_name: 'firearm-magazine', unit_number: 4242, max_count: 10, to_entity: true } }), "remote.call('autorio_operations','move_items_exact','firearm-magazine',4242,10,true)")
  assert.equal(renderOperation({ name: 'set_machine_recipe', args: { unit_number: 4242, recipe_name: "mod's-recipe" } }), "remote.call('autorio_operations','set_machine_recipe',4242,'mod\\'s-recipe')")
  assert.equal(renderOperation({ name: 'move_items_with_player', args: { item_name: 'stone', player_name: 'TTLouis', max_count: 10, to_player: true } }), "remote.call('autorio_operations','move_items_with_player','stone','TTLouis',10,true)")
  assert.equal(renderOperation({ name: 'stop_follow_player', args: {} }), "remote.call('autorio_operations','stop_follow_player')")
})

test('operation policy rejects arbitrary code, extra args, and oversized bounded values', () => {
  for (const operation of [
    { name: 'game.clear', args: {} },
    { name: 'wait', args: { ticks: 60, lua: 'game.clear()' } },
    { name: 'wait', args: { ticks: 360001 } },
    { name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 4097 } },
    { name: 'walk_to_player', args: { player_name: 'TTLouis', search_radius: 10 } },
    { name: 'follow_player', args: { player_name: 'TTLouis', follow_distance: 65 } },
    { name: 'follow_player', args: { player_name: 'TTLouis\n/c game.clear()' } },
    { name: 'set_auto_defense', args: { enabled: 'yes' } },
    { name: 'equip_weapon', args: { item_name: 'rocket-launcher', slot: 65 } },
    { name: 'equip_ammo', args: { item_name: 'atomic-bomb', slot: 0 } },
    { name: 'equip_armor', args: { item_name: 'modular-armor', slot: 1 } },
    { name: 'select_weapon_slot', args: { slot: 0 } },
    { name: 'move_items_exact', args: { item_name: 'firearm-magazine', unit_number: 0, max_count: 10, to_entity: true } },
    { name: 'move_items_exact', args: { item_name: 'firearm-magazine', unit_number: 1.5, max_count: 10, to_entity: true } },
    { name: 'move_items_exact', args: { item_name: 'firearm-magazine', unit_number: 4242, max_count: 10, to_entity: 'yes' } },
    { name: 'set_machine_recipe', args: { unit_number: 0, recipe_name: 'iron-gear-wheel' } },
    { name: 'set_machine_recipe', args: { unit_number: 1.5, recipe_name: 'iron-gear-wheel' } },
    { name: 'set_machine_recipe', args: { unit_number: 4242, recipe_name: 'iron-gear-wheel\n/c game.clear()' } },
    { name: 'set_machine_recipe', args: { unit_number: 4242, recipe_name: 'iron-gear-wheel', force: 'enemy' } },
    { name: 'move_items_with_player', args: { item_name: 'stone', player_name: 'TTLouis', max_count: 10, to_player: 'yes' } },
    { name: 'stop_follow_player', args: { player_name: 'TTLouis' } },
    { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1001 } },
    { name: 'mine_entity', args: { entity_name: 'iron-ore\n/c game.clear()', count: 1 } },
    { name: 'harvest_product', args: { product_name: 'stone', count: 100001, search_radius: 64 } },
    { name: 'clear_construction_area', args: { x: 0, y: 0, width: 65, height: 1 } },
    { name: 'place_entity', args: { entity_name: 'steel-chest', x: 1 } },
    { name: 'place_entity', args: { entity_name: 'steel-chest', y: 1 } },
    { name: 'place_entity', args: { entity_name: 'steel-chest', x: 1, y: 1, direction: 16 } },
    { name: 'place_entity', args: { entity_name: 'steel-chest', x: 1000001, y: 0 } },
  ]) assert.throws(() => parseOperation(operation))
})

test('provider plan requires exactly the structured response surface', () => {
  const plan = parsePlan({
    chatMessage: 'Working on it.',
    plan: ['Wait briefly'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 60 } }],
  })
  assert.equal(plan.operations[0].name, 'wait')
  assert.throws(() => parsePlan({ ...plan, operationCommands: [] }))
  assert.throws(() => parsePlan({ chatMessage: '', plan: [], currentStep: 0, operations: Array.from({ length: 17 }, () => ({ name: 'wait', args: { ticks: 1 } })) }))
})

test('tool surface matches current NPC observation contract and uses strict schemas', () => {
  assert.deepEqual(toolDefinitions.map(tool => tool.function.name), [
    'getActorStatus',
    'getTaskStatus',
    'getInventoryItems',
    'getEquipmentStatus',
    'getRecipe',
    'getRecipeDetails',
    'discoverPrototypes',
    'getPrototypeDetails',
    'findSkills',
    'getSkillDetails',
    'getPlayerStatus',
    'getNearbyEntities',
    'findLongRangeEntities',
    'findNearestEnemy',
    'getEntityStatus',
    'getEntityGeometry',
    'getLogisticsTopology',
    'measureTransportThroughput',
    'getNavigationStatus',
    'getFollowStatus',
    'getDefenseStatus',
    'getCraftingStatus',
    'getResearchStatus',
    'getResearchRequest',
    'getTechnology',
    'getCombatStatus',
  ])
  for (const tool of toolDefinitions) assert.equal(tool.function.parameters.additionalProperties, false)
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'getRecipe').function.parameters.required, ['item'])
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'getRecipeDetails').function.parameters.required, ['item_or_recipe'])
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'discoverPrototypes').function.parameters.required, ['capability'])
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'getPrototypeDetails').function.parameters.required, ['name'])
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'findSkills').function.parameters.required, ['query'])
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'getSkillDetails').function.parameters.required, ['id'])
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'getEntityGeometry').function.parameters.required, ['unit_number'])
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'getLogisticsTopology').function.parameters.required, ['unit_number'])
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'getPlayerStatus').function.parameters.required, ['player_name'])
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'findLongRangeEntities').function.parameters.required, ['name'])
  assert.deepEqual(toolDefinitions.find(tool => tool.function.name === 'getResearchRequest').function.parameters.required, ['request_id'])
})

test('read-only tool renderer targets native actor-aware interfaces without player indexes', () => {
  assert.equal(toolCommand('getActorStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor","status")))')
  assert.equal(toolCommand('getEquipmentStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_equipment","status")))')
  assert.equal(toolCommand('getFollowStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_follow","status")))')
  assert.equal(toolCommand('getDefenseStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_defense","status")))')
  assert.equal(toolCommand('getCraftingStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_crafting","status")))')
  assert.equal(toolCommand('getResearchRequest', { request_id: 42 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research","request_result",42)))')
  assert.equal(toolCommand('getRecipe', { item: 'iron-gear-wheel' }), '/silent-command remote.call("autorio_tools","get_recipe",\'iron-gear-wheel\')')
  assert.equal(toolCommand('getRecipeDetails', { item_or_recipe: "mod's-fluid" }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","recipe_details",\'mod\\\'s-fluid\',1)))')
  assert.equal(toolCommand('getRecipeDetails', { item_or_recipe: 'iron-gear-wheel', requested_count: 3 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","recipe_details",\'iron-gear-wheel\',3)))')
  assert.match(toolCommand('discoverPrototypes', { capability: 'mining', resource_name: 'iron-ore' }), /autorio_prototypes.*discover/)
  assert.match(toolCommand('discoverPrototypes', { capability: 'harvest', product_name: 'stone' }), /"capability":"harvest".*"product_name":"stone"/)
  assert.equal(toolCommand('getPrototypeDetails', { name: "mod's-machine" }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_prototypes","details",\'mod\\\'s-machine\')))')
  assert.equal(toolCommand('findSkills', { query: 'early iron plate smelting' }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_skills","find",\'early iron plate smelting\',3)))')
  assert.equal(toolCommand('findSkills', { query: '煤蛇', limit: 2 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_skills","find",\'煤蛇\',2)))')
  assert.equal(toolCommand('getSkillDetails', { id: 'burner-coal-loop' }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_skills","get",\'burner-coal-loop\')))')
  assert.equal(toolCommand('getPlayerStatus', { player_name: 'TTLouis' }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_player_status",\'TTLouis\')))')
  assert.equal(toolCommand('getNearbyEntities', { radius: 32, name: 'iron-ore', type: 'resource', limit: 25 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_nearby_entities",32,\'iron-ore\',\'resource\',25)))')
  assert.equal(toolCommand('findLongRangeEntities', { name: 'iron-ore', max_radius: 2048, limit: 4 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery","find_entities",\'iron-ore\',2048,4)))')
  assert.equal(toolCommand('findLongRangeEntities', { name: 'copper-ore' }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery","find_entities",\'copper-ore\',1024,8)))')
  assert.equal(toolCommand('findNearestEnemy', { max_distance: 2048 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery","find_nearest_enemy",2048)))')
  assert.equal(toolCommand('findNearestEnemy', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery","find_nearest_enemy",1024)))')
  assert.equal(toolCommand('getEntityStatus', { name: 'steel-chest' }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_entity_status",\'steel-chest\',8)))')
  assert.equal(toolCommand('getEntityGeometry', { unit_number: 4242 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","entity_geometry",4242)))')
  assert.equal(toolCommand('getLogisticsTopology', { unit_number: 4242 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","logistics_topology",4242,8)))')
  assert.equal(toolCommand('getLogisticsTopology', { unit_number: 4242, radius: 16 }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","logistics_topology",4242,16)))')
})

test('mutation identity preflight is read-only and limited to operations that need deterministic identities', () => {
  const craft = renderOperationPreflight({ name: 'craft_item', args: { item_name: 'burner-mining-drill', count: 1 } })
  assert.match(craft, /^\/silent-command rcon\.print\(helpers\.table_to_json\(remote\.call\("autorio_preflight","operation",/)
  assert.match(craft, /'craft_item'/)
  assert.match(craft, /'burner-mining-drill'/)

  const harvest = renderOperationPreflight({ name: 'harvest_product', args: { product_name: 'wood', count: 4, search_radius: 64 } })
  assert.match(harvest, /'harvest_product'/)
  assert.match(harvest, /'wood'/)

  const gather = renderOperationPreflight({ name: 'gather_resource', args: { resource_name: 'tree-02-red', count: 4, search_radius: 64 } })
  assert.match(gather, /'gather_resource'/)
  assert.match(gather, /'tree-02-red'/)

  const research = renderOperationPreflight({ name: 'research_technology', args: { technology_name: 'automation' } })
  assert.match(research, /^\/silent-command rcon\.print\(helpers\.table_to_json\(remote\.call\("autorio_preflight","operation",/)
  assert.match(research, /'research_technology'/)
  assert.match(research, /'automation'/)

  assert.equal(renderOperationPreflight({ name: 'wait', args: { ticks: 60 } }), null)
})

test('tool calls reject unknown names, unsafe names, extras, and out-of-bound scans', () => {
  assert.throws(() => toolCommand('shell', {}))
  assert.throws(() => toolCommand('getEquipmentStatus', { slot: 1 }))
  assert.throws(() => toolCommand('getDefenseStatus', { enabled: false }))
  assert.throws(() => toolCommand('getRecipe', { item: 'iron-plate', force: 'enemy' }))
  assert.throws(() => toolCommand('getRecipe', { item: 'iron-plate\n/c game.clear()' }))
  assert.throws(() => toolCommand('getRecipeDetails', { item_or_recipe: 'iron-plate', force: 'enemy' }))
  assert.throws(() => toolCommand('getRecipeDetails', { item_or_recipe: 'iron-plate\n/c game.clear()' }))
  assert.throws(() => toolCommand('discoverPrototypes', { capability: 'mining', resource_name: 'iron-ore', limit: 13 }))
  assert.throws(() => toolCommand('discoverPrototypes', { capability: 'mining', resource_name: 'iron-ore', lua: 'game.clear()' }))
  assert.throws(() => toolCommand('getPrototypeDetails', { name: 'inserter', force: 'enemy' }))
  assert.throws(() => toolCommand('getPrototypeDetails', { name: 'inserter\n/c game.clear()' }))
  assert.throws(() => toolCommand('findSkills', { query: '' }))
  assert.throws(() => toolCommand('findSkills', { query: 'coal', limit: 6 }))
  assert.throws(() => toolCommand('findSkills', { query: 'coal', lua: 'game.clear()' }))
  assert.throws(() => toolCommand('getSkillDetails', { id: '../escape' }))
  assert.throws(() => toolCommand('getSkillDetails', { id: 'burner-coal-loop', extra: true }))
  assert.throws(() => toolCommand('getEntityGeometry', { unit_number: 0 }))
  assert.throws(() => toolCommand('getEntityGeometry', { unit_number: 1.5 }))
  assert.throws(() => toolCommand('getEntityGeometry', { unit_number: 42, radius: 8 }))
  assert.throws(() => toolCommand('getLogisticsTopology', { unit_number: 0 }))
  assert.throws(() => toolCommand('getLogisticsTopology', { unit_number: 1.5 }))
  assert.throws(() => toolCommand('getLogisticsTopology', { unit_number: 42, radius: 17 }))
  assert.throws(() => toolCommand('getLogisticsTopology', { unit_number: 42, radius: 8, name: 'steel-chest' }))
  assert.throws(() => toolCommand('getPlayerStatus', { player_name: 'TTLouis', force: 'enemy' }))
  assert.throws(() => toolCommand('getPlayerStatus', { player_name: 'TTLouis\n/c game.clear()' }))
  assert.throws(() => toolCommand('getNearbyEntities', { radius: 65 }))
  assert.throws(() => toolCommand('findLongRangeEntities', { name: 'iron-ore', max_radius: 4097 }))
  assert.throws(() => toolCommand('findLongRangeEntities', { name: 'iron-ore', limit: 17 }))
  assert.throws(() => toolCommand('findLongRangeEntities', { name: 'iron-ore', force: 'enemy' }))
  assert.throws(() => toolCommand('findLongRangeEntities', { name: 'iron-ore\n/c game.clear()' }))
  assert.throws(() => toolCommand('findNearestEnemy', { max_distance: 4097 }))
  assert.throws(() => toolCommand('findNearestEnemy', { force: 'enemy' }))
  assert.throws(() => toolCommand('getFollowStatus', { player_name: 'TTLouis' }))
  assert.throws(() => toolCommand('getEntityStatus', { name: 'steel-chest', radius: 33 }))
  assert.throws(() => toolCommand('getResearchRequest', { request_id: 0 }))
  assert.throws(() => toolCommand('getResearchRequest', { request_id: 1.5 }))
  assert.throws(() => toolCommand('getResearchRequest', { request_id: 42, force: 'enemy' }))
})


test('operation metadata is the authoritative base operation registry', () => {
  const catalog = operationMetadataCatalog()
  assert.deepEqual(Object.keys(catalog), approvedOperationNames())
  assert.equal(new Set(approvedOperationNames()).size, approvedOperationNames().length)

  for (const name of approvedOperationNames()) {
    const metadata = operationMetadataForName(name)
    assert.equal(metadata.name, name)
    assert.deepEqual(Object.keys(metadata.arguments), operationArgumentKeys(name))
    assert.ok(metadata.scopes.length >= 1)
    assert.equal(new Set(metadata.scopes).size, metadata.scopes.length)
    assert.ok(['low', 'moderate', 'high', 'combat'].includes(metadata.risk))
    assert.equal(typeof metadata.preflight, 'boolean')
    for (const spec of Object.values(metadata.arguments)) {
      assert.ok([
        'closed_enum',
        'boolean',
        'deterministic_numeric',
        'planner_numeric',
        'runtime_candidate',
        'exact_entity_identity',
        'planner_semantic_value',
        'deterministic_default',
      ].includes(spec.kind))
      assert.equal(typeof spec.required, 'boolean')
      assert.equal(typeof spec.defaulted, 'boolean')
      assert.equal(spec.required && spec.defaulted, false)
    }
  }
})

test('operation metadata captures projection ownership for representative operations', () => {
  assert.deepEqual(operationMetadataForName('gather_resource').arguments, {
    resource_name: {
      kind: 'runtime_candidate',
      required: true,
      defaulted: false,
      provenance: 'nearby_resources',
    },
    count: {
      kind: 'planner_numeric',
      required: false,
      defaulted: true,
    },
    search_radius: {
      kind: 'deterministic_numeric',
      required: false,
      defaulted: true,
    },
  })

  assert.equal(operationMetadataForName('mine_entity_exact').arguments.unit_number.kind, 'exact_entity_identity')
  assert.equal(operationMetadataForName('set_machine_recipe').arguments.recipe_name.provenance, 'live_recipe_candidates')
  assert.equal(operationMetadataForName('research_technology').arguments.technology_name.provenance, 'live_researchable_technologies')
  assert.deepEqual(operationMetadataForName('supply_entity').scopes, ['logistics', 'production'])
})
