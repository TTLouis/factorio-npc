import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
}))

vi.mock('factorio-rcon-api-client', () => ({
  v2FactorioConsoleCommandRawPost: mocks.raw,
}))

import prompt from './prompt.md?raw'
import { tools } from './tools'

function getTool(name: string) {
  const tool = tools.find(tool => tool.name === name)
  if (!tool) throw new Error(`missing tool: ${name}`)
  return tool
}

beforeEach(() => {
  mocks.raw.mockReset()
  mocks.raw.mockResolvedValue({ data: { output: '{"ok":true}' } })
})

describe('agent observation tools', () => {
  it('exposes the bounded observation tool set', () => {
    expect(tools.map(tool => tool.name)).toEqual([
      'getActorStatus',
      'getTaskStatus',
      'getInventoryItems',
      'getEquipmentStatus',
      'getRecipe',
      'getRecipeDetails',
      'discoverPrototypes',
      'getPrototypeDetails',
      'getPlayerStatus',
      'getNearbyEntities',
      'getPlacementCandidates',
      'findLongRangeEntities',
      'findNearestEnemy',
      'getEntityStatus',
      'getEntityGeometry',
      'getLogisticsTopology',
      'getNavigationStatus',
      'getFollowStatus',
      'getDefenseStatus',
      'getCraftingStatus',
      'getResearchStatus',
      'getTechnology',
      'getCombatStatus',
    ])
  })

  it('reads actor and equipment status through read-only interfaces', async () => {
    const result = await getTool('getActorStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor", "status")))',
    } })
    expect(result).toBe('{"ok":true}')

    mocks.raw.mockClear()
    await getTool('getEquipmentStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_equipment", "status")))',
    } })
  })

  it('reads task status through the existing Autorio status operation', async () => {
    await getTool('getTaskStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations", "status")))',
    } })
  })

  it('escapes recipe item names and rejects control characters', async () => {
    await getTool('getRecipe').fn({ parameters: { item: "mod's-item" } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/c remote.call("autorio_tools", "get_recipe", \'mod\\\'s-item\')',
    } })

    mocks.raw.mockClear()
    await expect(getTool('getRecipe').fn({ parameters: { item: 'iron-plate\n/c game.clear()' } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('reads detailed recipe and compatible-machine knowledge by item or recipe name', async () => {
    await getTool('getRecipeDetails').fn({ parameters: { item_or_recipe: "mod's-fluid" } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "recipe_details", \'mod\\\'s-fluid\', 1)))',
    } })

    mocks.raw.mockClear()
    await getTool('getRecipeDetails').fn({ parameters: { item_or_recipe: 'iron-gear-wheel', requested_count: 3 } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "recipe_details", \'iron-gear-wheel\', 3)))',
    } })

    mocks.raw.mockClear()
    await getTool('getRecipeDetails').fn({ parameters: { item_or_recipe: 'iron-plate', fuel_name: 'coal' } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "recipe_details", \'iron-plate\', 1, \'coal\')))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('getRecipeDetails').fn({ parameters: { item_or_recipe: 'iron-plate', fuel_name: 'coal\n/c game.clear()' } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()

    mocks.raw.mockClear()
    await expect(getTool('getRecipeDetails').fn({ parameters: { item_or_recipe: 'oil\n/c game.clear()' } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders bounded prototype capability discovery without arbitrary Lua', async () => {
    await getTool('discoverPrototypes').fn({ parameters: { capability: 'mining', resource_name: "iron-ore", limit: 6 } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command local request=helpers.json_to_table(\'{"capability":"mining","resource_name":"iron-ore","availability":"force-available","limit":6}\'); rcon.print(helpers.table_to_json(remote.call("autorio_prototypes", "discover", request)))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('discoverPrototypes').fn({ parameters: { capability: 'mining', resource_name: 'iron-ore', limit: 13 } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('reads bounded prototype/build details and rejects unsafe names or extras', async () => {
    await getTool('getPrototypeDetails').fn({ parameters: { name: "mod's-machine" } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_prototypes", "details", \'mod\\\'s-machine\')))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('getPrototypeDetails').fn({ parameters: { name: 'inserter\n/c game.clear()' } })).rejects.toThrow()
    await expect(getTool('getPrototypeDetails').fn({ parameters: { name: 'inserter', unit_number: 42 } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('reads exact human player status by name', async () => {
    await getTool('getPlayerStatus').fn({ parameters: { player_name: 'TTLouis' } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_player_status", \'TTLouis\')))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('getPlayerStatus').fn({ parameters: { player_name: 'TTLouis\n/c game.clear()' } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders bounded nearby-entity filters and rejects oversized local queries', async () => {
    await getTool('getNearbyEntities').fn({ parameters: {
      radius: 32,
      name: 'iron-ore',
      type: 'resource',
      limit: 25,
    } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_nearby_entities", 32, \'iron-ore\', \'resource\', 25)))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('getNearbyEntities').fn({ parameters: { radius: 65 } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders exact-name long-range discovery and bounds it to 4096 tiles', async () => {
    await getTool('findLongRangeEntities').fn({ parameters: {
      name: 'copper-ore',
      max_radius: 2048,
      limit: 4,
    } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery", "find_entities", \'copper-ore\', 2048, 4)))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('findLongRangeEntities').fn({ parameters: { name: 'copper-ore', max_radius: 4097 } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders engine-native hostile discovery and bounds it to 4096 tiles', async () => {
    await getTool('findNearestEnemy').fn({ parameters: { max_distance: 2048 } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery", "find_nearest_enemy", 2048)))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('findNearestEnemy').fn({ parameters: { max_distance: 4097 } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders a bounded exact-name entity-status lookup', async () => {
    await getTool('getEntityStatus').fn({ parameters: { name: 'wooden-chest' } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_entity_status", \'wooden-chest\', 8)))',
    } })
  })

  it('renders exact unit-number geometry lookup and rejects invalid ids', async () => {
    await getTool('getEntityGeometry').fn({ parameters: { unit_number: 4242 } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "entity_geometry", 4242)))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('getEntityGeometry').fn({ parameters: { unit_number: 0 } })).rejects.toThrow()
    await expect(getTool('getEntityGeometry').fn({ parameters: { unit_number: 1.5 } })).rejects.toThrow()
    await expect(getTool('getEntityGeometry').fn({ parameters: { unit_number: 42, radius: 8 } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders bounded exact logistics topology and rejects invalid bounds', async () => {
    await getTool('getLogisticsTopology').fn({ parameters: { unit_number: 4242 } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "logistics_topology", 4242, 8)))',
    } })

    mocks.raw.mockClear()
    await getTool('getLogisticsTopology').fn({ parameters: { unit_number: 4242, radius: 16 } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "logistics_topology", 4242, 16)))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('getLogisticsTopology').fn({ parameters: { unit_number: 0 } })).rejects.toThrow()
    await expect(getTool('getLogisticsTopology').fn({ parameters: { unit_number: 1.5 } })).rejects.toThrow()
    await expect(getTool('getLogisticsTopology').fn({ parameters: { unit_number: 42, radius: 17 } })).rejects.toThrow()
    await expect(getTool('getLogisticsTopology').fn({ parameters: { unit_number: 42, radius: 8, name: 'steel-chest' } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })
})

describe('navigation and follow observation tools', () => {
  it('reads navigation state', async () => {
    await getTool('getNavigationStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_navigation", "status")))',
    } })
  })

  it('reads persistent follow state', async () => {
    await getTool('getFollowStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_follow", "status")))',
    } })
  })

  it('reads persistent follow auto-defense state', async () => {
    await getTool('getDefenseStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_defense", "status")))',
    } })
  })
})

describe('crafting, research, and combat observation tools', () => {
  it('reads crafting state', async () => {
    await getTool('getCraftingStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_crafting", "status")))',
    } })
  })

  it('reads research and exact technology state', async () => {
    await getTool('getResearchStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research", "status")))',
    } })

    mocks.raw.mockClear()
    await getTool('getTechnology').fn({ parameters: { name: 'automation' } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research", "technology", \'automation\')))',
    } })
  })

  it('reads combat state', async () => {
    await getTool('getCombatStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_combat", "status")))',
    } })
  })
})

describe('prompt contract', () => {
  it('documents equipment, discovery, static prototype knowledge, recipe knowledge, geometry, topology, player interaction, follow, defense, navigation, crafting, research, and combat tools', () => {
    for (const name of ['getEquipmentStatus', 'discoverPrototypes', 'getPrototypeDetails', 'getRecipeDetails', 'getEntityGeometry', 'getLogisticsTopology', 'getPlayerStatus', 'findLongRangeEntities', 'findNearestEnemy', 'getFollowStatus', 'getDefenseStatus', 'getNavigationStatus', 'getCraftingStatus', 'getResearchStatus', 'getTechnology', 'getCombatStatus']) {
      expect(tools.some(tool => tool.name === name)).toBe(true)
      expect(prompt).toContain(name)
    }
    for (const operation of ['walk_to_player', 'move_items_with_player', 'follow_player', 'stop_follow_player', 'set_auto_defense', 'equip_weapon', 'equip_ammo', 'equip_armor', 'select_weapon_slot', 'set_machine_recipe', 'clear_enemy_area']) {
      expect(prompt).toContain(operation)
    }
    expect(prompt).toContain('4096')
    expect(prompt).toContain('[CHAT] <username>: <message>')
  })

  it('retains explicit verification requirements', () => {
    expect(prompt).toContain('Navigation completion must be verified')
    expect(prompt).toContain('Hand-crafting completion must be verified')
    expect(prompt).toContain('Machine recipe configuration must be verified')
    expect(prompt).toContain('does not mean the technology is unlocked')
    expect(prompt).toContain('Combat completion must be verified')
  })
})
