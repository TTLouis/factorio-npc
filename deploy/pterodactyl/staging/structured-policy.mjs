export class PolicyError extends Error {}

function check(ok, message) {
  if (!ok) throw new PolicyError(message)
}

export function factorioName(value) {
  check(typeof value === 'string' && value.length >= 1 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value), 'Invalid Factorio name')
  return value
}

function boundedText(value, label, max) {
  check(typeof value === 'string' && value.trim().length >= 1 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), `Invalid ${label}`)
  return value.trim()
}

function skillId(value) {
  check(typeof value === 'string' && value.length >= 1 && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value), 'Invalid skill id')
  return value
}

function integer(value, label, min, max) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be an integer from ${min} to ${max}`)
  return value
}

function finiteNumber(value, label, min, max) {
  check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `${label} must be a number from ${min} to ${max}`)
  return value
}

function positiveNumber(value, label, max) {
  check(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max, `${label} must be > 0 and <= ${max}`)
  return value
}

export function luaString(value) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= 16384, 'Invalid Lua string')
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
}

function exactKeys(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected object')
  const keys = Object.keys(value)
  check(keys.every(key => allowed.includes(key)), 'Unexpected argument')
}

export const OPERATION_ARGUMENT_KINDS = Object.freeze([
  'closed_enum',
  'boolean',
  'deterministic_numeric',
  'planner_numeric',
  'runtime_candidate',
  'exact_entity_identity',
  'planner_semantic_value',
  'deterministic_default',
])

export const OPERATION_RISK_CLASSES = Object.freeze(['low', 'moderate', 'high', 'combat'])

const SEMANTIC_OPERATION_SCOPES = Object.freeze([
  'navigation',
  'combat',
  'resources',
  'construction',
  'logistics',
  'production',
  'research',
  'runtime',
])

function argumentMetadata(kind, { required = true, defaulted = false, provenance } = {}) {
  check(OPERATION_ARGUMENT_KINDS.includes(kind), `Unknown operation argument kind: ${kind}`)
  check(typeof required === 'boolean' && typeof defaulted === 'boolean', 'Invalid operation argument requirement metadata')
  check(!(required && defaulted), 'Required operation arguments cannot be defaulted')
  const value = { kind, required, defaulted }
  if (provenance !== undefined) {
    check(typeof provenance === 'string' && provenance.length >= 1 && provenance.length <= 120, 'Invalid operation argument provenance')
    value.provenance = provenance
  }
  return Object.freeze(value)
}

function operationMetadata(scopes, { preflight, risk, arguments: args }) {
  check(Array.isArray(scopes) && scopes.length >= 1, 'Operation metadata requires at least one scope')
  check(scopes.every(scope => SEMANTIC_OPERATION_SCOPES.includes(scope)), 'Operation metadata references an unknown scope')
  check(new Set(scopes).size === scopes.length, 'Operation metadata scopes must be duplicate-free')
  check(typeof preflight === 'boolean', 'Operation metadata preflight flag must be boolean')
  check(OPERATION_RISK_CLASSES.includes(risk), 'Operation metadata has an unknown risk class')
  check(args && typeof args === 'object' && !Array.isArray(args), 'Operation metadata arguments must be an object')
  for (const [name, spec] of Object.entries(args)) {
    check(/^[A-Za-z0-9_]+$/.test(name), 'Invalid operation argument metadata name')
    check(spec && typeof spec === 'object' && !Array.isArray(spec), 'Invalid operation argument metadata')
    check(OPERATION_ARGUMENT_KINDS.includes(spec.kind), 'Operation metadata has an unknown argument kind')
    check(typeof spec.required === 'boolean' && typeof spec.defaulted === 'boolean', 'Invalid operation argument requirement metadata')
    check(!(spec.required && spec.defaulted), 'Required operation arguments cannot be defaulted')
  }
  return Object.freeze({
    scopes: Object.freeze([...scopes]),
    preflight,
    risk,
    arguments: Object.freeze({ ...args }),
  })
}

const OPERATION_METADATA = Object.freeze({
  walk_to_entity: operationMetadata(['navigation'], {
    preflight: true,
    risk: 'low',
    arguments: {
      entity_name: argumentMetadata('runtime_candidate', { provenance: 'nearby_entities' }),
      search_radius: argumentMetadata('deterministic_numeric'),
    },
  }),
  walk_to_entity_exact: operationMetadata(['navigation'], {
    preflight: true,
    risk: 'low',
    arguments: {
      unit_number: argumentMetadata('exact_entity_identity', { provenance: 'live_entity_unit' }),
      reach_distance: argumentMetadata('deterministic_numeric', { required: false, defaulted: true }),
    },
  }),
  walk_to_position: operationMetadata(['navigation'], {
    preflight: false,
    risk: 'low',
    arguments: {
      x: argumentMetadata('planner_numeric'),
      y: argumentMetadata('planner_numeric'),
      reach_distance: argumentMetadata('deterministic_numeric', { required: false, defaulted: true }),
    },
  }),
  walk_to_player: operationMetadata(['navigation'], {
    preflight: false,
    risk: 'low',
    arguments: {
      player_name: argumentMetadata('runtime_candidate', { provenance: 'connected_players' }),
    },
  }),
  follow_player: operationMetadata(['navigation'], {
    preflight: false,
    risk: 'low',
    arguments: {
      player_name: argumentMetadata('runtime_candidate', { provenance: 'connected_players' }),
      follow_distance: argumentMetadata('deterministic_numeric', { required: false, defaulted: true }),
    },
  }),
  stop_follow_player: operationMetadata(['navigation'], {
    preflight: false,
    risk: 'low',
    arguments: {},
  }),
  set_auto_defense: operationMetadata(['combat'], {
    preflight: false,
    risk: 'moderate',
    arguments: {
      enabled: argumentMetadata('boolean'),
    },
  }),
  equip_weapon: operationMetadata(['combat'], {
    preflight: false,
    risk: 'moderate',
    arguments: {
      item_name: argumentMetadata('runtime_candidate', { provenance: 'inventory_weapon_items' }),
      slot: argumentMetadata('closed_enum', { required: false, defaulted: true }),
    },
  }),
  equip_ammo: operationMetadata(['combat'], {
    preflight: false,
    risk: 'moderate',
    arguments: {
      item_name: argumentMetadata('runtime_candidate', { provenance: 'inventory_ammo_items' }),
      slot: argumentMetadata('closed_enum', { required: false, defaulted: true }),
    },
  }),
  equip_armor: operationMetadata(['combat'], {
    preflight: false,
    risk: 'moderate',
    arguments: {
      item_name: argumentMetadata('runtime_candidate', { provenance: 'inventory_armor_items' }),
    },
  }),
  select_weapon_slot: operationMetadata(['combat'], {
    preflight: false,
    risk: 'moderate',
    arguments: {
      slot: argumentMetadata('closed_enum'),
    },
  }),
  mine_entity: operationMetadata(['resources'], {
    preflight: true,
    risk: 'moderate',
    arguments: {
      entity_name: argumentMetadata('runtime_candidate', { provenance: 'nearby_mineable_entities' }),
      count: argumentMetadata('planner_numeric', { required: false, defaulted: true }),
    },
  }),
  mine_entity_exact: operationMetadata(['resources'], {
    preflight: true,
    risk: 'high',
    arguments: {
      unit_number: argumentMetadata('exact_entity_identity', { provenance: 'live_entity_unit' }),
    },
  }),
  mine_resource_at: operationMetadata(['resources'], {
    preflight: true,
    risk: 'moderate',
    arguments: {
      resource_name: argumentMetadata('runtime_candidate', { provenance: 'nearby_resources' }),
      x: argumentMetadata('planner_numeric'),
      y: argumentMetadata('planner_numeric'),
      count: argumentMetadata('planner_numeric', { required: false, defaulted: true }),
    },
  }),
  gather_resource: operationMetadata(['resources'], {
    preflight: true,
    risk: 'moderate',
    arguments: {
      resource_name: argumentMetadata('runtime_candidate', { provenance: 'nearby_resources' }),
      count: argumentMetadata('planner_numeric', { required: false, defaulted: true }),
      search_radius: argumentMetadata('deterministic_numeric', { required: false, defaulted: true }),
    },
  }),
  harvest_product: operationMetadata(['resources'], {
    preflight: true,
    risk: 'moderate',
    arguments: {
      product_name: argumentMetadata('runtime_candidate', { provenance: 'mineable_products' }),
      count: argumentMetadata('planner_numeric', { required: false, defaulted: true }),
      search_radius: argumentMetadata('deterministic_numeric', { required: false, defaulted: true }),
    },
  }),
  clear_construction_area: operationMetadata(['construction'], {
    preflight: true,
    risk: 'high',
    arguments: {
      x: argumentMetadata('planner_numeric'),
      y: argumentMetadata('planner_numeric'),
      width: argumentMetadata('planner_numeric'),
      height: argumentMetadata('planner_numeric'),
    },
  }),
  supply_entity: operationMetadata(['logistics', 'production'], {
    preflight: true,
    risk: 'moderate',
    arguments: {
      unit_number: argumentMetadata('exact_entity_identity', { provenance: 'live_entity_unit' }),
      items: argumentMetadata('planner_semantic_value'),
    },
  }),
  execute_construction_plan: operationMetadata(['construction'], {
    preflight: false,
    risk: 'high',
    arguments: {
      validation_id: argumentMetadata('runtime_candidate', { provenance: 'construction_validation' }),
      placement_count: argumentMetadata('deterministic_numeric', { provenance: 'construction_validation' }),
    },
  }),
  place_entity: operationMetadata(['construction'], {
    preflight: true,
    risk: 'high',
    arguments: {
      entity_name: argumentMetadata('runtime_candidate', { provenance: 'placeable_inventory_entities' }),
      x: argumentMetadata('planner_numeric', { required: false }),
      y: argumentMetadata('planner_numeric', { required: false }),
      direction: argumentMetadata('closed_enum', { required: false }),
    },
  }),
  rotate_entity: operationMetadata(['construction'], {
    preflight: true,
    risk: 'moderate',
    arguments: {
      unit_number: argumentMetadata('exact_entity_identity', { provenance: 'live_entity_unit' }),
      reverse: argumentMetadata('boolean', { required: false, defaulted: true }),
    },
  }),
  move_items: operationMetadata(['logistics', 'production'], {
    preflight: false,
    risk: 'moderate',
    arguments: {
      item_name: argumentMetadata('runtime_candidate', { provenance: 'inventory_or_entity_items' }),
      entity_name: argumentMetadata('runtime_candidate', { provenance: 'nearby_entities' }),
      max_count: argumentMetadata('planner_numeric'),
      to_entity: argumentMetadata('boolean'),
    },
  }),
  move_items_exact: operationMetadata(['logistics', 'production'], {
    preflight: true,
    risk: 'moderate',
    arguments: {
      item_name: argumentMetadata('runtime_candidate', { provenance: 'inventory_or_entity_items' }),
      unit_number: argumentMetadata('exact_entity_identity', { provenance: 'live_entity_unit' }),
      max_count: argumentMetadata('planner_numeric'),
      to_entity: argumentMetadata('boolean'),
    },
  }),
  set_machine_recipe: operationMetadata(['production'], {
    preflight: true,
    risk: 'moderate',
    arguments: {
      unit_number: argumentMetadata('exact_entity_identity', { provenance: 'live_entity_unit' }),
      recipe_name: argumentMetadata('runtime_candidate', { provenance: 'live_recipe_candidates' }),
    },
  }),
  move_items_with_player: operationMetadata(['logistics'], {
    preflight: false,
    risk: 'moderate',
    arguments: {
      item_name: argumentMetadata('runtime_candidate', { provenance: 'inventory_items' }),
      player_name: argumentMetadata('runtime_candidate', { provenance: 'connected_players' }),
      max_count: argumentMetadata('planner_numeric'),
      to_player: argumentMetadata('boolean'),
    },
  }),
  craft_item: operationMetadata(['production'], {
    preflight: true,
    risk: 'moderate',
    arguments: {
      item_name: argumentMetadata('runtime_candidate', { provenance: 'craftable_items' }),
      count: argumentMetadata('planner_numeric', { required: false, defaulted: true }),
    },
  }),
  attack_nearest_enemy: operationMetadata(['combat'], {
    preflight: false,
    risk: 'combat',
    arguments: {
      search_radius: argumentMetadata('deterministic_numeric', { required: false, defaulted: true }),
    },
  }),
  clear_enemy_area: operationMetadata(['combat'], {
    preflight: false,
    risk: 'combat',
    arguments: {
      search_radius: argumentMetadata('deterministic_numeric', { required: false, defaulted: true }),
    },
  }),
  research_technology: operationMetadata(['research'], {
    preflight: true,
    risk: 'high',
    arguments: {
      technology_name: argumentMetadata('runtime_candidate', { provenance: 'live_researchable_technologies' }),
    },
  }),
  wait: operationMetadata(['runtime'], {
    preflight: false,
    risk: 'low',
    arguments: {
      ticks: argumentMetadata('planner_numeric'),
    },
  }),
})

function cloneOperationMetadata(name, metadata) {
  return {
    name,
    scopes: [...metadata.scopes],
    preflight: metadata.preflight,
    risk: metadata.risk,
    arguments: Object.fromEntries(Object.entries(metadata.arguments).map(([key, value]) => [key, { ...value }])),
  }
}

function normalizeCatalogRecord(name, metadata) {
  check(typeof name === 'string' && name.length >= 1 && name.length <= 120, 'Invalid operation metadata name')
  check(metadata && typeof metadata === 'object' && !Array.isArray(metadata), `Invalid operation metadata for ${name}`)
  check(metadata.name === undefined || metadata.name === name, `Operation metadata name mismatch for ${name}`)
  return operationMetadata(metadata.scopes, {
    preflight: metadata.preflight,
    risk: metadata.risk,
    arguments: metadata.arguments,
  })
}

export function mergeOperationMetadataCatalog(baseCatalog, extensionCatalog) {
  check(baseCatalog && typeof baseCatalog === 'object' && !Array.isArray(baseCatalog), 'Base operation metadata catalog must be an object')
  check(extensionCatalog && typeof extensionCatalog === 'object' && !Array.isArray(extensionCatalog), 'Extension operation metadata catalog must be an object')
  const merged = {}
  for (const [name, metadata] of Object.entries(baseCatalog)) merged[name] = normalizeCatalogRecord(name, metadata)
  for (const [name, metadata] of Object.entries(extensionCatalog)) {
    const normalized = normalizeCatalogRecord(name, metadata)
    if (Object.hasOwn(merged, name)) {
      const current = JSON.stringify(cloneOperationMetadata(name, merged[name]))
      const incoming = JSON.stringify(cloneOperationMetadata(name, normalized))
      check(current === incoming, `Operation metadata extension cannot redefine ${name}`)
      continue
    }
    merged[name] = normalized
  }
  return Object.freeze(merged)
}

export function operationMetadataCatalog() {
  return Object.fromEntries(Object.entries(OPERATION_METADATA).map(([name, metadata]) => [name, cloneOperationMetadata(name, metadata)]))
}

export function operationMetadataForName(name) {
  check(typeof name === 'string' && Object.hasOwn(OPERATION_METADATA, name), `Unapproved operation: ${name}`)
  return cloneOperationMetadata(name, OPERATION_METADATA[name])
}

export function approvedOperationNames() {
  return Object.keys(OPERATION_METADATA)
}

export function operationArgumentKeys(name) {
  return Object.keys(operationMetadataForName(name).arguments)
}

export function approvedOperationScopes() {
  return [...SEMANTIC_OPERATION_SCOPES]
}

export function operationNamesForScope(scope) {
  check(typeof scope === 'string' && SEMANTIC_OPERATION_SCOPES.includes(scope), `Unknown operation scope: ${scope}`)
  return approvedOperationNames().filter(name => OPERATION_METADATA[name].scopes.includes(scope))
}

export function operationScopesForName(name) {
  return operationMetadataForName(name).scopes
}

export function operationTypeCatalog() {
  return approvedOperationNames().map(name => {
    const metadata = operationMetadataForName(name)
    return {
      name,
      args: Object.keys(metadata.arguments),
      arguments: metadata.arguments,
      scopes: metadata.scopes,
      preflight: metadata.preflight,
      risk: metadata.risk,
    }
  })
}

export function operationTypeCatalogForScope(scope) {
  const allowed = new Set(operationNamesForScope(scope))
  return operationTypeCatalog().filter(entry => allowed.has(entry.name))
}

export function isApprovedOperationName(name) {
  return typeof name === 'string' && Object.hasOwn(OPERATION_METADATA, name)
}

export function parseOperation(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Operation must be an object')
  exactKeys(value, ['name', 'args'])
  const { name, args } = value
  check(typeof name === 'string', 'Operation name must be a string')
  check(Object.hasOwn(OPERATION_METADATA, name), `Unapproved operation: ${name}`)
  exactKeys(args, operationArgumentKeys(name))

  switch (name) {
    case 'walk_to_entity':
      return { name, args: { entity_name: factorioName(args.entity_name), search_radius: integer(args.search_radius, 'search_radius', 1, 4096) } }
    case 'walk_to_entity_exact':
      return { name, args: { unit_number: integer(args.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER), reach_distance: finiteNumber(args.reach_distance ?? 2.5, 'reach_distance', 0.25, 64) } }
    case 'walk_to_position':
      return { name, args: { x: finiteNumber(args.x, 'x', -1000000, 1000000), y: finiteNumber(args.y, 'y', -1000000, 1000000), reach_distance: finiteNumber(args.reach_distance ?? 0.75, 'reach_distance', 0.25, 64) } }
    case 'walk_to_player':
      return { name, args: { player_name: factorioName(args.player_name) } }
    case 'follow_player':
      return { name, args: { player_name: factorioName(args.player_name), follow_distance: finiteNumber(args.follow_distance ?? 4, 'follow_distance', 1, 64) } }
    case 'stop_follow_player':
      return { name, args: {} }
    case 'set_auto_defense':
      check(typeof args.enabled === 'boolean', 'enabled must be boolean')
      return { name, args: { enabled: args.enabled } }
    case 'equip_weapon':
      return { name, args: { item_name: factorioName(args.item_name), slot: integer(args.slot ?? 1, 'slot', 1, 64) } }
    case 'equip_ammo':
      return { name, args: { item_name: factorioName(args.item_name), slot: integer(args.slot ?? 1, 'slot', 1, 64) } }
    case 'equip_armor':
      return { name, args: { item_name: factorioName(args.item_name) } }
    case 'select_weapon_slot':
      return { name, args: { slot: integer(args.slot, 'slot', 1, 64) } }
    case 'mine_entity':
      return { name, args: { entity_name: factorioName(args.entity_name), count: integer(args.count ?? 1, 'count', 1, 1000) } }
    case 'mine_entity_exact':
      return { name, args: { unit_number: integer(args.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER) } }
    case 'mine_resource_at':
      return {
        name,
        args: {
          resource_name: factorioName(args.resource_name),
          x: finiteNumber(args.x, 'x', -1000000, 1000000),
          y: finiteNumber(args.y, 'y', -1000000, 1000000),
          count: integer(args.count ?? 1, 'count', 1, 1000),
        },
      }
    case 'gather_resource':
      return {
        name,
        args: {
          resource_name: factorioName(args.resource_name),
          count: integer(args.count ?? 1, 'count', 1, 1000),
          search_radius: integer(args.search_radius ?? 256, 'search_radius', 1, 4096),
        },
      }
    case 'harvest_product':
      return {
        name,
        args: {
          product_name: factorioName(args.product_name),
          count: integer(args.count ?? 1, 'count', 1, 100000),
          search_radius: integer(args.search_radius ?? 256, 'search_radius', 1, 4096),
        },
      }
    case 'clear_construction_area': {
      const width = integer(args.width, 'width', 1, 64)
      const height = integer(args.height, 'height', 1, 64)
      check(width * height <= 4096, 'construction clearing area exceeds 4096 tiles')
      return {
        name,
        args: {
          x: finiteNumber(args.x, 'x', -1000000, 1000000),
          y: finiteNumber(args.y, 'y', -1000000, 1000000),
          width,
          height,
        },
      }
    }
    case 'supply_entity': {
      check(Array.isArray(args.items) && args.items.length >= 1 && args.items.length <= 8, 'items must contain between 1 and 8 entries')
      const seen = new Set()
      const items = args.items.map((item, index) => {
        exactKeys(item, ['item_name', 'count'])
        const itemName = factorioName(item.item_name)
        check(!seen.has(itemName), `duplicate supply item at index ${index}`)
        seen.add(itemName)
        return { item_name: itemName, count: integer(item.count, `items[${index}].count`, 1, 100000) }
      })
      return {
        name,
        args: {
          unit_number: integer(args.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER),
          items,
        },
      }
    }
    case 'execute_construction_plan':
      return {
        name,
        args: {
          validation_id: integer(args.validation_id, 'validation_id', 1, Number.MAX_SAFE_INTEGER),
          placement_count: integer(args.placement_count, 'placement_count', 1, 16),
        },
      }
    case 'place_entity': {
      const hasX = args.x !== undefined
      const hasY = args.y !== undefined
      check(hasX === hasY, 'x and y must be provided together')
      const parsed = { entity_name: factorioName(args.entity_name) }
      if (hasX) {
        parsed.x = finiteNumber(args.x, 'x', -1000000, 1000000)
        parsed.y = finiteNumber(args.y, 'y', -1000000, 1000000)
      }
      if (args.direction !== undefined) parsed.direction = integer(args.direction, 'direction', 0, 15)
      return { name, args: parsed }
    }
    case 'rotate_entity':
      check(args.reverse === undefined || typeof args.reverse === 'boolean', 'reverse must be boolean')
      return { name, args: { unit_number: integer(args.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER), reverse: args.reverse ?? false } }
    case 'move_items':
      check(typeof args.to_entity === 'boolean', 'to_entity must be boolean')
      return { name, args: { item_name: factorioName(args.item_name), entity_name: factorioName(args.entity_name), max_count: integer(args.max_count, 'max_count', 1, 100000), to_entity: args.to_entity } }
    case 'move_items_exact':
      check(typeof args.to_entity === 'boolean', 'to_entity must be boolean')
      return { name, args: { item_name: factorioName(args.item_name), unit_number: integer(args.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER), max_count: integer(args.max_count, 'max_count', 1, 100000), to_entity: args.to_entity } }
    case 'set_machine_recipe':
      return { name, args: { unit_number: integer(args.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER), recipe_name: factorioName(args.recipe_name) } }
    case 'move_items_with_player':
      check(typeof args.to_player === 'boolean', 'to_player must be boolean')
      return { name, args: { item_name: factorioName(args.item_name), player_name: factorioName(args.player_name), max_count: integer(args.max_count, 'max_count', 1, 100000), to_player: args.to_player } }
    case 'craft_item':
      return { name, args: { item_name: factorioName(args.item_name), count: integer(args.count ?? 1, 'count', 1, 1000) } }
    case 'attack_nearest_enemy':
      return { name, args: { search_radius: integer(args.search_radius ?? 50, 'search_radius', 1, 256) } }
    case 'clear_enemy_area':
      return { name, args: { search_radius: integer(args.search_radius ?? 96, 'search_radius', 1, 256) } }
    case 'research_technology':
      return { name, args: { technology_name: factorioName(args.technology_name) } }
    case 'wait':
      return { name, args: { ticks: integer(args.ticks, 'ticks', 1, 360000) } }
    default:
      throw new PolicyError(`Unapproved operation: ${name}`)
  }
}

function luaPreflightValue(value) {
  if (value === null || value === undefined) return 'nil'
  if (typeof value === 'string') return luaString(value)
  if (typeof value === 'number') {
    check(Number.isFinite(value), 'Invalid preflight number')
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `{${value.map(luaPreflightValue).join(',')}}`
  check(typeof value === 'object', 'Invalid preflight value')
  return `{${Object.keys(value).sort().map(key => `[${luaString(key)}]=${luaPreflightValue(value[key])}`).join(',')}}`
}

export function renderOperationPreflight(value) {
  const operation = parseOperation(value)
  if (!operationMetadataForName(operation.name).preflight) return null
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_preflight","operation",${luaString(operation.name)},${luaPreflightValue(operation.args)})))`
}

export function renderOperation(value) {
  const operation = parseOperation(value)
  switch (operation.name) {
    case 'walk_to_entity': return `remote.call('autorio_operations','walk_to_entity',${luaString(operation.args.entity_name)},${operation.args.search_radius})`
    case 'walk_to_entity_exact': return `remote.call('autorio_operations','walk_to_entity_exact',${operation.args.unit_number},${operation.args.reach_distance})`
    case 'walk_to_position': return `remote.call('autorio_operations','walk_to_position',${operation.args.x},${operation.args.y},${operation.args.reach_distance})`
    case 'walk_to_player': return `remote.call('autorio_operations','walk_to_player',${luaString(operation.args.player_name)})`
    case 'follow_player': return `remote.call('autorio_operations','follow_player',${luaString(operation.args.player_name)},${operation.args.follow_distance})`
    case 'stop_follow_player': return `remote.call('autorio_operations','stop_follow_player')`
    case 'set_auto_defense': return `remote.call('autorio_operations','set_auto_defense',${operation.args.enabled})`
    case 'equip_weapon': return `remote.call('autorio_operations','equip_weapon',${luaString(operation.args.item_name)},${operation.args.slot})`
    case 'equip_ammo': return `remote.call('autorio_operations','equip_ammo',${luaString(operation.args.item_name)},${operation.args.slot})`
    case 'equip_armor': return `remote.call('autorio_operations','equip_armor',${luaString(operation.args.item_name)})`
    case 'select_weapon_slot': return `remote.call('autorio_operations','select_weapon_slot',${operation.args.slot})`
    case 'mine_entity': return `remote.call('autorio_operations','mine_entity',${luaString(operation.args.entity_name)},${operation.args.count})`
    case 'mine_entity_exact': return `remote.call('autorio_operations','mine_entity_exact',${operation.args.unit_number})`
    case 'mine_resource_at': return `remote.call('autorio_operations','mine_resource_at',${luaString(operation.args.resource_name)},${operation.args.x},${operation.args.y},${operation.args.count})`
    case 'gather_resource': return `remote.call('autorio_operations','gather_resource',${luaString(operation.args.resource_name)},${operation.args.count},${operation.args.search_radius})`
    case 'harvest_product': return `remote.call('autorio_operations','harvest_product',${luaString(operation.args.product_name)},${operation.args.count},${operation.args.search_radius})`
    case 'clear_construction_area': return `remote.call('autorio_operations','clear_construction_area',${operation.args.x},${operation.args.y},${operation.args.width},${operation.args.height})`
    case 'supply_entity': {
      const items = operation.args.items.map(item => `{item_name=${luaString(item.item_name)},count=${item.count}}`).join(',')
      return `remote.call('autorio_operations','supply_entity',${operation.args.unit_number},{${items}})`
    }
    case 'execute_construction_plan': return `remote.call('autorio_operations','execute_construction_plan',${operation.args.validation_id},${operation.args.placement_count})`
    case 'place_entity': {
      const name = luaString(operation.args.entity_name)
      if (operation.args.x !== undefined && operation.args.y !== undefined) {
        const direction = operation.args.direction === undefined ? 'nil' : operation.args.direction
        return `remote.call('autorio_operations','place_entity',${name},${operation.args.x},${operation.args.y},${direction})`
      }
      if (operation.args.direction !== undefined) return `remote.call('autorio_operations','place_entity',${name},nil,nil,${operation.args.direction})`
      return `remote.call('autorio_operations','place_entity',${name})`
    }
    case 'rotate_entity': return `remote.call('autorio_operations','rotate_entity',${operation.args.unit_number},${operation.args.reverse})`
    case 'move_items': return `remote.call('autorio_operations','move_items',${luaString(operation.args.item_name)},${luaString(operation.args.entity_name)},${operation.args.max_count},${operation.args.to_entity})`
    case 'move_items_exact': return `remote.call('autorio_operations','move_items_exact',${luaString(operation.args.item_name)},${operation.args.unit_number},${operation.args.max_count},${operation.args.to_entity})`
    case 'set_machine_recipe': return `remote.call('autorio_operations','set_machine_recipe',${operation.args.unit_number},${luaString(operation.args.recipe_name)})`
    case 'move_items_with_player': return `remote.call('autorio_operations','move_items_with_player',${luaString(operation.args.item_name)},${luaString(operation.args.player_name)},${operation.args.max_count},${operation.args.to_player})`
    case 'craft_item': return `remote.call('autorio_operations','craft_item',${luaString(operation.args.item_name)},${operation.args.count})`
    case 'attack_nearest_enemy': return `remote.call('autorio_operations','attack_nearest_enemy',${operation.args.search_radius})`
    case 'clear_enemy_area': return `remote.call('autorio_operations','clear_enemy_area',${operation.args.search_radius})`
    case 'research_technology': return `remote.call('autorio_operations','research_technology',${luaString(operation.args.technology_name)})`
    case 'wait': return `remote.call('autorio_operations','wait',${operation.args.ticks})`
    default: throw new PolicyError(`Unapproved operation: ${operation.name}`)
  }
}

export function parsePlan(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Provider response must be an object')
  exactKeys(value, ['chatMessage', 'plan', 'currentStep', 'operations'])
  check(typeof value.chatMessage === 'string' && value.chatMessage.length <= 2000, 'Invalid chatMessage')
  check(Array.isArray(value.plan) && value.plan.length <= 30 && value.plan.every(item => typeof item === 'string' && item.length <= 500), 'Invalid plan')
  integer(value.currentStep, 'currentStep', 0, 30)
  check(Array.isArray(value.operations) && value.operations.length <= 16, 'Invalid operations')
  return {
    chatMessage: value.chatMessage,
    plan: [...value.plan],
    currentStep: value.currentStep,
    operations: value.operations.map(parseOperation),
  }
}

const emptyObjectSchema = Object.freeze({ type: 'object', properties: {}, additionalProperties: false })
const nameStringSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 200 })

function functionTool(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } }
}

const throughputMeasurementDefinition = functionTool(
  'measureTransportThroughput',
  'Measure achieved live throughput over a bounded simulation window for one exact placed inserter or one exact straight transport-belt lane. Call this tool alone; the harness waits and polls internally without spending extra model turns. Inserter results count real delivered held-stack items. Belt-lane results count real item-stack crossings and observed stack heights. proven_sufficient means the measured lower bound covers required_rate_per_second with utilization_limit headroom. not_proven is not an impossibility claim because supply starvation, sink blocking, power, or contention may limit the sample.',
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'unit_number'],
    properties: {
      kind: { type: 'string', enum: ['inserter_instance', 'belt_lane'] },
      unit_number: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      lane_index: { type: 'integer', minimum: 1, maximum: 2 },
      item_name: nameStringSchema,
      warmup_ticks: { type: 'integer', minimum: 0, maximum: 600, default: 60 },
      window_ticks: { type: 'integer', minimum: 60, maximum: 3600, default: 300 },
      required_rate_per_second: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000 },
      utilization_limit: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.8 },
      required_stack_size: { type: 'integer', minimum: 1, maximum: 255 },
    },
  },
)

function parseThroughputMeasurement(args) {
  exactKeys(args, [
    'kind', 'unit_number', 'lane_index', 'item_name', 'warmup_ticks', 'window_ticks',
    'required_rate_per_second', 'utilization_limit', 'required_stack_size',
  ])
  check(args.kind === 'inserter_instance' || args.kind === 'belt_lane', 'kind must be inserter_instance or belt_lane')
  const parsed = {
    kind: args.kind,
    unit_number: integer(args.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER),
  }
  if (args.item_name !== undefined) parsed.item_name = factorioName(args.item_name)
  if (args.warmup_ticks !== undefined) parsed.warmup_ticks = integer(args.warmup_ticks, 'warmup_ticks', 0, 600)
  if (args.window_ticks !== undefined) parsed.window_ticks = integer(args.window_ticks, 'window_ticks', 60, 3600)
  if (args.required_rate_per_second !== undefined) parsed.required_rate_per_second = positiveNumber(args.required_rate_per_second, 'required_rate_per_second', 1000000000)
  if (args.utilization_limit !== undefined) parsed.utilization_limit = positiveNumber(args.utilization_limit, 'utilization_limit', 1)
  if (args.kind === 'inserter_instance') {
    check(args.lane_index === undefined && args.required_stack_size === undefined, 'inserter_instance does not accept lane_index or required_stack_size')
  }
  else {
    parsed.lane_index = integer(args.lane_index, 'lane_index', 1, 2)
    if (args.required_stack_size !== undefined) parsed.required_stack_size = integer(args.required_stack_size, 'required_stack_size', 1, 255)
  }
  return parsed
}

function renderThroughputMeasurement(args) {
  const parsed = parseThroughputMeasurement(args)
  const fields = [`kind=${luaString(parsed.kind)}`, `unit_number=${parsed.unit_number}`]
  if (parsed.lane_index !== undefined) fields.push(`lane_index=${parsed.lane_index}`)
  if (parsed.item_name !== undefined) fields.push(`item_name=${luaString(parsed.item_name)}`)
  if (parsed.warmup_ticks !== undefined) fields.push(`warmup_ticks=${parsed.warmup_ticks}`)
  if (parsed.window_ticks !== undefined) fields.push(`window_ticks=${parsed.window_ticks}`)
  if (parsed.required_rate_per_second !== undefined) fields.push(`required_rate_per_second=${parsed.required_rate_per_second}`)
  if (parsed.utilization_limit !== undefined) fields.push(`utilization_limit=${parsed.utilization_limit}`)
  if (parsed.required_stack_size !== undefined) fields.push(`required_stack_size=${parsed.required_stack_size}`)
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","throughput_measurement_start",{${fields.join(',')}})))`
}

export const toolDefinitions = [
  functionTool('getActorStatus', 'Read AIRI actor mode, identity, validity, position and connected-human count.', emptyObjectSchema),
  functionTool('getTaskStatus', 'Read current Autorio task and bounded queue state.', emptyObjectSchema),
  functionTool('getInventoryItems', 'Read AIRI standalone actor main inventory; equipment slots are separate.', emptyObjectSchema),
  functionTool('getEquipmentStatus', 'Read AIRI health, selected gun slot, equipped guns/ammo/armor, and cursor stack.', emptyObjectSchema),
  functionTool('getRecipe', 'Read one exact recipe for AIRI force.', {
    type: 'object', properties: { item: nameStringSchema }, required: ['item'], additionalProperties: false,
  }),
  functionTool('getRecipeDetails', 'Read bounded deterministic recipe knowledge, including relevant current inventory counts, bootstrap dependency status, categories, ingredients/products and compatible crafting-machine prototypes. requested_count scopes required quantities without dumping unrelated inventory.', {
    type: 'object', properties: { item_or_recipe: nameStringSchema, requested_count: { type: 'integer', minimum: 1, maximum: 1000, default: 1 } }, required: ['item_or_recipe'], additionalProperties: false,
  }),
  functionTool('discoverPrototypes', 'Discover a small canonical set of current-game entity prototype identities by engine-backed capability/type instead of guessing names. Harvest discovery groups non-resource mineable entities by item product and returns bounded engine-derived candidates.', {
    type: 'object',
    properties: {
      capability: { type: 'string', enum: ['mining', 'crafting', 'entity-type', 'harvest'] },
      resource_name: nameStringSchema,
      resource_category: nameStringSchema,
      crafting_category: nameStringSchema,
      entity_type: nameStringSchema,
      product_name: nameStringSchema,
      energy_source: { type: 'string', enum: ['burner', 'electric', 'heat', 'fluid', 'void', 'none'] },
      availability: { type: 'string', enum: ['force-available', 'all'], default: 'force-available' },
      limit: { type: 'integer', minimum: 1, maximum: 12, default: 6 },
    },
    required: ['capability'],
    additionalProperties: false,
  }),
  functionTool('getPrototypeDetails', 'Read bounded static prototype/build knowledge for an item, fluid, or entity, including mineable products for harvestable entities plus build/crafting/transport metadata.', {
    type: 'object', properties: { name: nameStringSchema }, required: ['name'], additionalProperties: false,
  }),
  functionTool('findSkills', 'Search AIRI\'s bounded local skill/pattern library for reusable gameplay experience relevant to a task. Skill matches are guidance, not live world truth or mutation authority; validate recipes, prototypes, inventory, geometry, and placement before acting.', {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 240 },
      limit: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
    },
    required: ['query'],
    additionalProperties: false,
  }),
  functionTool('getSkillDetails', 'Open one exact AIRI skill/pattern by id after discovery. Treat candidate/manual skills as experienced-player heuristics: reuse the decision pattern, but revalidate all mutable and game-version-specific facts before execution.', {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
    },
    required: ['id'],
    additionalProperties: false,
  }),
  functionTool('getPlayerStatus', 'Read one exact human player by name, including availability, surface, position, and distance from AIRI when comparable.', {
    type: 'object', properties: { player_name: nameStringSchema }, required: ['player_name'], additionalProperties: false,
  }),
  functionTool('getNearbyEntities', 'Inspect a bounded local area around AIRI.', {
    type: 'object',
    properties: {
      radius: { type: 'integer', minimum: 1, maximum: 64, default: 20 },
      name: nameStringSchema,
      type: nameStringSchema,
      limit: { type: 'integer', minimum: 1, maximum: 40, default: 20 },
    },
    additionalProperties: false,
  }),
  functionTool('findLongRangeEntities', 'Search outward for an exact Factorio prototype name, up to 4096 tiles, returning a bounded number of distant targets.', {
    type: 'object',
    properties: {
      name: nameStringSchema,
      max_radius: { type: 'integer', minimum: 64, maximum: 4096, default: 1024 },
      limit: { type: 'integer', minimum: 1, maximum: 16, default: 8 },
    },
    required: ['name'],
    additionalProperties: false,
  }),
  functionTool('findNearestEnemy', 'Use Factorio native nearest-enemy search to find the closest hostile entity without knowing its prototype name, up to 4096 tiles.', {
    type: 'object',
    properties: {
      max_distance: { type: 'integer', minimum: 1, maximum: 4096, default: 1024 },
    },
    additionalProperties: false,
  }),
  functionTool('getEntityStatus', 'Inspect one nearest exact-name local entity.', {
    type: 'object',
    properties: { name: nameStringSchema, radius: { type: 'integer', minimum: 1, maximum: 32, default: 8 } },
    required: ['name'],
    additionalProperties: false,
  }),
  functionTool('getEntityGeometry', 'Inspect exact same-surface runtime I/O geometry for one entity by stable Factorio unit_number.', {
    type: 'object',
    properties: { unit_number: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
    required: ['unit_number'],
    additionalProperties: false,
  }),
  functionTool('getLogisticsTopology', 'Inspect a bounded semantic logistics graph centered on one exact same-surface entity: belt inputs/outputs, actual inserter routes touching the center, direct mining output, and connected fluid neighbours.', {
    type: 'object',
    properties: {
      unit_number: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      radius: { type: 'integer', minimum: 1, maximum: 16, default: 8 },
    },
    required: ['unit_number'],
    additionalProperties: false,
  }),
  throughputMeasurementDefinition,
  functionTool('getNavigationStatus', 'Read bounded navigation target and last result.', emptyObjectSchema),
  functionTool('getFollowStatus', 'Read persistent player-follow state, target player, configured distance, and current distance.', emptyObjectSchema),
  functionTool('getDefenseStatus', 'Read persistent follow auto-defense policy, defensive radius, and current nearby hostile target.', emptyObjectSchema),
  functionTool('getCraftingStatus', 'Read bounded native crafting ownership and last result.', emptyObjectSchema),
  functionTool('getResearchStatus', 'Read force research and latest request/follow-through state.', emptyObjectSchema),
  functionTool('getResearchRequest', 'Read one exact correlated research request and follow-through record by request ID.', {
    type: 'object',
    properties: { request_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
    required: ['request_id'],
    additionalProperties: false,
  }),
  functionTool('getTechnology', 'Read one exact technology.', {
    type: 'object', properties: { name: nameStringSchema }, required: ['name'], additionalProperties: false,
  }),
  functionTool('getCombatStatus', 'Read bounded combat target and last result.', emptyObjectSchema),
]

function argsObject(args) {
  check(args && typeof args === 'object' && !Array.isArray(args), 'Invalid tool arguments')
  return args
}

function noExtra(args, allowed) {
  check(Object.keys(args).every(key => allowed.includes(key)), 'Unexpected tool argument')
}

export function isObservationToolName(name) {
  return typeof name === 'string' && toolDefinitions.some(tool => tool?.type === 'function' && tool.function?.name === name)
}

export function runtimeConditionCommand(rawCondition = {}) {
  const condition = argsObject(rawCondition)
  const kind = condition.kind
  check(['inventory_count', 'entity_inventory_count', 'entity_exists', 'entity_state'].includes(kind), 'Unsupported runtime condition kind')
  const request = { kind }

  if (kind === 'inventory_count') {
    noExtra(condition, ['kind', 'item_name', 'minimum'])
    request.item_name = factorioName(condition.item_name)
    request.minimum = integer(condition.minimum, 'minimum', 1, Number.MAX_SAFE_INTEGER)
  }
  else if (kind === 'entity_inventory_count') {
    noExtra(condition, ['kind', 'unit_number', 'item_name', 'minimum'])
    request.unit_number = integer(condition.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER)
    request.item_name = factorioName(condition.item_name)
    request.minimum = integer(condition.minimum, 'minimum', 1, Number.MAX_SAFE_INTEGER)
  }
  else if (kind === 'entity_exists') {
    noExtra(condition, ['kind', 'unit_number'])
    request.unit_number = integer(condition.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER)
  }
  else {
    noExtra(condition, ['kind', 'unit_number', 'expected'])
    request.unit_number = integer(condition.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER)
    check(['working', 'not_working', 'exists'].includes(condition.expected), 'Invalid entity_state expected value')
    request.expected = condition.expected
  }

  return `/silent-command local request=helpers.json_to_table(${luaString(JSON.stringify(request))}); rcon.print(helpers.table_to_json(remote.call("autorio_tools","evaluate_condition",request)))`
}

export function toolCommand(name, rawArgs = {}) {
  const args = argsObject(rawArgs)
  switch (name) {
    case 'getActorStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor","status")))'
    case 'getTaskStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))'
    case 'getInventoryItems':
      noExtra(args, [])
      return '/silent-command remote.call("autorio_tools","get_inventory_items")'
    case 'getEquipmentStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_equipment","status")))'
    case 'getRecipe':
      noExtra(args, ['item'])
      return `/silent-command remote.call("autorio_tools","get_recipe",${luaString(factorioName(args.item))})`
    case 'getRecipeDetails': {
      noExtra(args, ['item_or_recipe', 'requested_count'])
      const requestedCount = integer(args.requested_count ?? 1, 'requested_count', 1, 1000)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","recipe_details",${luaString(factorioName(args.item_or_recipe))},${requestedCount})))`
    }
    case 'discoverPrototypes': {
      noExtra(args, ['capability', 'resource_name', 'resource_category', 'crafting_category', 'entity_type', 'product_name', 'energy_source', 'availability', 'limit'])
      check(['mining', 'crafting', 'entity-type', 'harvest'].includes(args.capability), 'Invalid prototype discovery capability')
      const request = { capability: args.capability }
      if (args.resource_name !== undefined) request.resource_name = factorioName(args.resource_name)
      if (args.resource_category !== undefined) request.resource_category = factorioName(args.resource_category)
      if (args.crafting_category !== undefined) request.crafting_category = factorioName(args.crafting_category)
      if (args.entity_type !== undefined) request.entity_type = factorioName(args.entity_type)
      if (args.product_name !== undefined) request.product_name = factorioName(args.product_name)
      if (args.energy_source !== undefined) {
        check(['burner', 'electric', 'heat', 'fluid', 'void', 'none'].includes(args.energy_source), 'Invalid prototype discovery energy_source')
        request.energy_source = args.energy_source
      }
      if (args.availability !== undefined) {
        check(args.availability === 'force-available' || args.availability === 'all', 'Invalid prototype discovery availability')
        request.availability = args.availability
      }
      if (args.limit !== undefined) request.limit = integer(args.limit, 'limit', 1, 12)
      return `/silent-command local request=helpers.json_to_table(${luaString(JSON.stringify(request))}); rcon.print(helpers.table_to_json(remote.call("autorio_prototypes","discover",request)))`
    }
    case 'getPrototypeDetails':
      noExtra(args, ['name'])
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_prototypes","details",${luaString(factorioName(args.name))})))`
    case 'findSkills': {
      noExtra(args, ['query', 'limit'])
      const query = boundedText(args.query, 'skill search query', 240)
      const limit = integer(args.limit ?? 3, 'limit', 1, 5)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_skills","find",${luaString(query)},${limit})))`
    }
    case 'getSkillDetails':
      noExtra(args, ['id'])
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_skills","get",${luaString(skillId(args.id))})))`
    case 'getPlayerStatus':
      noExtra(args, ['player_name'])
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_player_status",${luaString(factorioName(args.player_name))})))`
    case 'getNearbyEntities': {
      noExtra(args, ['radius', 'name', 'type', 'limit'])
      const radius = integer(args.radius ?? 20, 'radius', 1, 64)
      const limit = integer(args.limit ?? 20, 'limit', 1, 40)
      const entityName = args.name === undefined ? 'nil' : luaString(factorioName(args.name))
      const entityType = args.type === undefined ? 'nil' : luaString(factorioName(args.type))
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_nearby_entities",${radius},${entityName},${entityType},${limit})))`
    }
    case 'findLongRangeEntities': {
      noExtra(args, ['name', 'max_radius', 'limit'])
      const entityName = factorioName(args.name)
      const maxRadius = integer(args.max_radius ?? 1024, 'max_radius', 64, 4096)
      const limit = integer(args.limit ?? 8, 'limit', 1, 16)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery","find_entities",${luaString(entityName)},${maxRadius},${limit})))`
    }
    case 'findNearestEnemy': {
      noExtra(args, ['max_distance'])
      const maxDistance = integer(args.max_distance ?? 1024, 'max_distance', 1, 4096)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery","find_nearest_enemy",${maxDistance})))`
    }
    case 'getEntityStatus': {
      noExtra(args, ['name', 'radius'])
      const radius = integer(args.radius ?? 8, 'radius', 1, 32)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_entity_status",${luaString(factorioName(args.name))},${radius})))`
    }
    case 'getEntityGeometry': {
      noExtra(args, ['unit_number'])
      const unitNumber = integer(args.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","entity_geometry",${unitNumber})))`
    }
    case 'getLogisticsTopology': {
      noExtra(args, ['unit_number', 'radius'])
      const unitNumber = integer(args.unit_number, 'unit_number', 1, Number.MAX_SAFE_INTEGER)
      const radius = integer(args.radius ?? 8, 'radius', 1, 16)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","logistics_topology",${unitNumber},${radius})))`
    }
    case 'measureTransportThroughput':
      return renderThroughputMeasurement(args)
    case 'getNavigationStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_navigation","status")))'
    case 'getFollowStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_follow","status")))'
    case 'getDefenseStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_defense","status")))'
    case 'getCraftingStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_crafting","status")))'
    case 'getResearchStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research","status")))'
    case 'getResearchRequest': {
      noExtra(args, ['request_id'])
      const requestId = integer(args.request_id, 'request_id', 1, Number.MAX_SAFE_INTEGER)
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research","request_result",${requestId})))`
    }
    case 'getTechnology':
      noExtra(args, ['name'])
      return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research","technology",${luaString(factorioName(args.name))})))`
    case 'getCombatStatus':
      noExtra(args, [])
      return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_combat","status")))'
    default:
      throw new PolicyError(`Unapproved tool: ${name}`)
  }
}
