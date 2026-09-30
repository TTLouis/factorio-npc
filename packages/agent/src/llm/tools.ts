import { createLogg } from '@guiiai/logg'
import { v2FactorioConsoleCommandRawPost } from 'factorio-rcon-api-client'
import { z } from 'zod'
import { factorioNameSchema, renderLuaString } from './operations'

const logger = createLogg('tools').useGlobalConfig()

interface ToolFunction {
  name: string
  description: string
  schema: z.Schema
  fn: (args: any) => Promise<any>
}

const nearbyEntitiesSchema = z.object({
  radius: z.number().int().min(1).max(64).default(20),
  name: factorioNameSchema.optional(),
  type: factorioNameSchema.optional(),
  limit: z.number().int().min(1).max(40).default(20),
}).strict()

const longRangeEntitiesSchema = z.object({
  name: factorioNameSchema,
  max_radius: z.number().int().min(64).max(4096).default(1024),
  limit: z.number().int().min(1).max(16).default(8),
}).strict()

const nearestEnemySchema = z.object({
  max_distance: z.number().int().min(1).max(4096).default(1024),
}).strict()

const entityStatusSchema = z.object({
  name: factorioNameSchema,
  radius: z.number().int().min(1).max(32).default(8),
}).strict()

const entityGeometrySchema = z.object({
  unit_number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict()

const logisticsTopologySchema = z.object({
  unit_number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  radius: z.number().int().min(1).max(16).default(8),
}).strict()

const playerStatusSchema = z.object({
  player_name: factorioNameSchema,
}).strict()

const recipeDetailsSchema = z.object({
  item_or_recipe: factorioNameSchema,
  requested_count: z.number().int().min(1).max(1000).default(1),
  fuel_name: factorioNameSchema.optional().describe('Fuel item; adds its burn per minute on burner machines'),
}).strict()

const prototypeDetailsSchema = z.object({
  name: factorioNameSchema,
}).strict()

const prototypeDiscoverySchema = z.object({
  capability: z.enum(['mining', 'crafting', 'entity-type', 'harvest']),
  resource_name: factorioNameSchema.optional(),
  resource_category: factorioNameSchema.optional(),
  crafting_category: factorioNameSchema.optional(),
  entity_type: factorioNameSchema.optional(),
  product_name: factorioNameSchema.optional(),
  energy_source: z.enum(['burner', 'electric', 'heat', 'fluid', 'void', 'none']).optional(),
  availability: z.enum(['force-available', 'all']).default('force-available'),
  limit: z.number().int().min(1).max(12).default(6),
}).strict()

const placementCandidatesSchema = z.object({
  entity_name: factorioNameSchema,
  center: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }).strict().optional(),
  radius: z.number().int().min(1).max(24).default(8),
  target_resource: factorioNameSchema.optional(),
  limit: z.number().int().min(1).max(8).default(5),
}).strict()

async function readRemoteStatus(interfaceName: 'autorio_actor' | 'autorio_operations' | 'autorio_navigation' | 'autorio_crafting' | 'autorio_research' | 'autorio_combat' | 'autorio_follow' | 'autorio_defense' | 'autorio_equipment') {
  const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("${interfaceName}", "status")))`
  const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
  return response.data.output
}

const technologySchema = z.object({ name: factorioNameSchema }).strict()

export const tools: ToolFunction[] = [
  {
    name: 'getActorStatus',
    description: 'Get SGLuna\'s controlled actor mode, identity, position, validity, and connected-human count',
    schema: z.object({}),
    fn: async () => {
      const output = await readRemoteStatus('autorio_actor')
      logger.withFields({ output }).debug('Actor status')
      return output
    },
  },
  {
    name: 'getTaskStatus',
    description: 'Get SGLuna\'s current Autorio task state, bounded queue/progress state, and controlled actor snapshot',
    schema: z.object({}),
    fn: async () => {
      const output = await readRemoteStatus('autorio_operations')
      logger.withFields({ output }).debug('Task status')
      return output
    },
  },
  {
    name: 'getInventoryItems',
    description: 'Get the items in SGLuna\'s controlled actor main inventory. Equipment slots are separate; use getEquipmentStatus for guns, ammo, armor, selected gun slot, health, and cursor stack.',
    schema: z.object({}),
    fn: async () => {
      const response = await v2FactorioConsoleCommandRawPost({ body: { input: '/c remote.call("autorio_tools", "get_inventory_items")' } })
      logger.withFields({ response: response.data.output }).debug('Inventory items')
      return response.data.output
    },
  },
  {
    name: 'getEquipmentStatus',
    description: 'Inspect SGLuna health and equipment state: selected gun slot, equipped guns, matching ammo slots, armor, and cursor stack. Use this before combat instead of inferring equipment from the main inventory.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_equipment'),
  },
  {
    name: 'getRecipe',
    description: 'Get the recipe for a given item for SGLuna\'s controlled actor',
    schema: z.object({
      item: factorioNameSchema.describe('The item to get the recipe for'),
    }).strict(),
    fn: async ({ parameters }) => {
      const item = factorioNameSchema.parse(parameters.item)
      logger.withFields({ item }).debug('Try to get recipe for item')
      const response = await v2FactorioConsoleCommandRawPost({
        body: { input: `/c remote.call("autorio_tools", "get_recipe", ${renderLuaString(item)})` },
      })
      logger.withFields({ response: response.data.output }).debug('Recipe')
      return response.data.output
    },
  },
  {
    name: 'getRecipeDetails',
    description: 'Get bounded deterministic recipe knowledge for an item/fluid or recipe name, including categories, ingredients/products, relevant current inventory counts, bootstrap dependency status, hand-crafting compatibility, and compatible crafting-machine prototypes. requested_count scopes required ingredient quantities without dumping unrelated inventory. Name fuel_name to also get that fuel\'s burn per minute on burner machines.',
    schema: recipeDetailsSchema,
    fn: async ({ parameters }) => {
      const parsed = recipeDetailsSchema.parse(parameters)
      const fuel = parsed.fuel_name !== undefined ? `, ${renderLuaString(parsed.fuel_name)}` : ''
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "recipe_details", ${renderLuaString(parsed.item_or_recipe)}, ${parsed.requested_count}${fuel})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Detailed recipe knowledge')
      return response.data.output
    },
  },
  {
    name: 'discoverPrototypes',
    description: 'Discover a bounded canonical set of current-game entity prototypes by engine-backed capability/type. Harvest accepts product_name and groups mineable non-resource entities by the item they yield; mining remains resource-drill discovery.',
    schema: prototypeDiscoverySchema,
    fn: async ({ parameters }) => {
      const parsed = prototypeDiscoverySchema.parse(parameters)
      const request = renderLuaString(JSON.stringify(parsed))
      const input = `/silent-command local request=helpers.json_to_table(${request}); rcon.print(helpers.table_to_json(remote.call("autorio_prototypes", "discover", request)))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Prototype capability discovery')
      return response.data.output
    },
  },
  {
    name: 'getPrototypeDetails',
    description: 'Read bounded static prototype/build knowledge for an item, fluid, or entity name, including mineable products/yields for harvestable entities plus build/crafting/transport metadata.',
    schema: prototypeDetailsSchema,
    fn: async ({ parameters }) => {
      const parsed = prototypeDetailsSchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_prototypes", "details", ${renderLuaString(parsed.name)})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Prototype build details')
      return response.data.output
    },
  },
  {
    name: 'getPlayerStatus',
    description: 'Inspect one exact human player by name: connection/character availability, surface, position, and distance from SGLuna when comparable.',
    schema: playerStatusSchema,
    fn: async ({ parameters }) => {
      const parsed = playerStatusSchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_player_status", ${renderLuaString(parsed.player_name)})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Player status')
      return response.data.output
    },
  },
  {
    name: 'getNearbyEntities',
    description: 'Inspect a bounded area around SGLuna and return compact nearby entity summaries. Entities with runtime item-transfer/output or fluid connection geometry may include a compact spatial field from the current game instance. Use optional exact prototype name/type filters to reduce noise.',
    schema: nearbyEntitiesSchema,
    fn: async ({ parameters }) => {
      const parsed = nearbyEntitiesSchema.parse(parameters ?? {})
      const name = parsed.name ? renderLuaString(parsed.name) : 'nil'
      const entityType = parsed.type ? renderLuaString(parsed.type) : 'nil'
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_nearby_entities", ${parsed.radius}, ${name}, ${entityType}, ${parsed.limit})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Nearby entities')
      return response.data.output
    },
  },
  {
    name: 'getPlacementCandidates',
    description: 'Ask the local Factorio harness to enumerate a small set of live legal placement candidates for an entity using the running game prototype and surface.can_place_entity. For resource-bound mining placement, provide target_resource so candidates without live target-resource coverage are rejected and remaining candidates include current coverage. Use this instead of manually guessing coordinates for terrain/resource-constrained placement.',
    schema: placementCandidatesSchema,
    fn: async ({ parameters }) => {
      const parsed = placementCandidatesSchema.parse(parameters ?? {})
      const request = renderLuaString(JSON.stringify(parsed))
      const input = `/silent-command local request=helpers.json_to_table(${request}); rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_placement_candidates", request)))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Placement candidates')
      return response.data.output
    },
  },
  {
    name: 'findLongRangeEntities',
    description: 'Search outward in bounded rings for an exact Factorio prototype name, up to 4096 tiles, returning only a small number of matching distant targets. Use this for resource/world discovery, not broad local inspection.',
    schema: longRangeEntitiesSchema,
    fn: async ({ parameters }) => {
      const parsed = longRangeEntitiesSchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery", "find_entities", ${renderLuaString(parsed.name)}, ${parsed.max_radius}, ${parsed.limit})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Long-range entities')
      return response.data.output
    },
  },
  {
    name: 'findNearestEnemy',
    description: 'Use Factorio native nearest-enemy search to discover the closest hostile entity without knowing its prototype name, up to 4096 tiles. Use this when hunting/clearing enemies after the local 64-tile area is empty.',
    schema: nearestEnemySchema,
    fn: async ({ parameters }) => {
      const parsed = nearestEnemySchema.parse(parameters ?? {})
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery", "find_nearest_enemy", ${parsed.max_distance})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Nearest hostile')
      return response.data.output
    },
  },
  {
    name: 'getEntityStatus',
    description: 'Inspect the nearest local entity with an exact prototype name and return bounded inventory summaries plus compact runtime spatial semantics when the entity exposes relevant I/O geometry. Use this to verify placed chests and nearby machines without dumping the map.',
    schema: entityStatusSchema,
    fn: async ({ parameters }) => {
      const parsed = entityStatusSchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_entity_status", ${renderLuaString(parsed.name)}, ${parsed.radius})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Entity status')
      return response.data.output
    },
  },
  {
    name: 'getEntityGeometry',
    description: 'Inspect one exact same-surface entity by Factorio unit_number and return bounded runtime I/O geometry: inserter pickup/drop positions and targets, mining-drill output position/target, and fluidbox production roles and absolute pipe connection positions/targets.',
    schema: entityGeometrySchema,
    fn: async ({ parameters }) => {
      const parsed = entityGeometrySchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "entity_geometry", ${parsed.unit_number})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Exact entity geometry')
      return response.data.output
    },
  },
  {
    name: 'getLogisticsTopology',
    description: 'Inspect a bounded semantic logistics graph centered on one exact same-surface entity: engine belt inputs/outputs, actual inserter pickup/drop routes touching the center, direct mining-drill output, and connected fluidbox neighbours. Use this instead of inferring logistics from nearby coordinates.',
    schema: logisticsTopologySchema,
    fn: async ({ parameters }) => {
      const parsed = logisticsTopologySchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge", "logistics_topology", ${parsed.unit_number}, ${parsed.radius})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      logger.withFields({ output: response.data.output, parameters: parsed }).debug('Bounded logistics topology')
      return response.data.output
    },
  },
  {
    name: 'getNavigationStatus',
    description: 'Read SGLuna navigation state, bound target, active path request/attempt count, and last bounded navigation result. Use it to distinguish reached from no-target, unreachable, path timeout, stuck, or ownership failures.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_navigation'),
  },
  {
    name: 'getFollowStatus',
    description: 'Read SGLuna persistent player-follow state, target player, configured distance, current distance, and whether follow movement is active, waiting for player availability, or blocked by surface mismatch.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_follow'),
  },
  {
    name: 'getDefenseStatus',
    description: 'Read SGLuna persistent follow auto-defense policy, defensive radius, and any current nearby hostile target. Auto-defense may shoot while following but does not chase.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_defense'),
  },
  {
    name: 'getCraftingStatus',
    description: 'Read SGLuna native hand-crafting state and last bounded crafting result. Use it to distinguish verified output completion from a busy native queue, missing ingredients/output, cancellation, timeout, or ownership failure.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_crafting'),
  },
  {
    name: 'getResearchStatus',
    description: 'Read current force research, progress, a bounded queue, and the last research-request result. A request being accepted is not technology completion.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_research'),
  },
  {
    name: 'getTechnology',
    description: 'Inspect one exact technology: researched state, level, prerequisites, science requirements, and whether it is actually researched.',
    schema: technologySchema,
    fn: async ({ parameters }) => {
      const { name } = technologySchema.parse(parameters)
      const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research", "technology", ${renderLuaString(name)})))`
      const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
      return response.data.output
    },
  },
  {
    name: 'getCombatStatus',
    description: 'Read SGLuna combat state, the currently bound target when valid, and the last bounded combat result. Use it to distinguish a destroyed target from no-target, no-ammo, stuck, timeout, or ownership failures.',
    schema: z.object({}).strict(),
    fn: async () => readRemoteStatus('autorio_combat'),
  },
]
