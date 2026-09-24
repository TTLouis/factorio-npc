import * as base from '../staging/structured-policy.mjs'

export * from '../staging/structured-policy.mjs'

function check(ok, message) { if (!ok) throw new base.PolicyError(message) }
function exactKeys(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected object')
  check(Object.keys(value).every(key => allowed.includes(key)), 'Unexpected argument')
}
function positiveRate(value) {
  check(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000_000, 'rate_per_second must be a positive number up to 1000000000')
  return value
}
function positiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value > 0 && value <= max, `${label} must be a positive integer${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ''}`)
  return value
}
function optionalInteger(value, label, min, max) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be an integer from ${min} to ${max}`)
  return value
}
function finiteCoordinate(value, label) {
  check(typeof value === 'number' && Number.isFinite(value) && value >= -1_000_000 && value <= 1_000_000, `${label} must be a finite map coordinate`)
  return value
}
function stringArray(value, label) {
  check(Array.isArray(value) && value.length <= 64, `${label} must be an array with at most 64 entries`)
  return value.map(base.factorioName)
}
function optionalBoolean(value, label) {
  check(typeof value === 'boolean', `${label} must be boolean`)
  return value
}
function position(value) {
  exactKeys(value, ['x', 'y'])
  return { x: finiteCoordinate(value.x, 'position.x'), y: finiteCoordinate(value.y, 'position.y') }
}
function side(value, label) {
  check(['north', 'south', 'east', 'west', 'any'].includes(value), `${label} must be north, south, east, west, or any`)
  return value
}
function candidateReference(value, label, prefix) {
  check(typeof value === 'string' && new RegExp(`^${prefix}-[1-9][0-9]*$`).test(value), `${label} is invalid`)
  return value
}

const EXPERIMENT_OPERATION_METADATA = Object.freeze({
  place_candidate: Object.freeze({
    name: 'place_candidate',
    scopes: Object.freeze(['construction']),
    preflight: false,
    risk: 'high',
    arguments: Object.freeze({
      candidate_set_id: Object.freeze({
        kind: 'runtime_candidate',
        required: true,
        defaulted: false,
        provenance: 'placement_candidate_registry',
      }),
      candidate_id: Object.freeze({
        kind: 'runtime_candidate',
        required: true,
        defaulted: false,
        provenance: 'placement_candidate_registry',
      }),
    }),
  }),
})

const RUNTIME_OPERATION_METADATA = base.mergeOperationMetadataCatalog(
  base.operationMetadataCatalog(),
  EXPERIMENT_OPERATION_METADATA,
)

function runtimeMetadata(name) {
  check(typeof name === 'string' && Object.hasOwn(RUNTIME_OPERATION_METADATA, name), `Unapproved operation: ${name}`)
  const metadata = RUNTIME_OPERATION_METADATA[name]
  return {
    name,
    scopes: [...metadata.scopes],
    preflight: metadata.preflight,
    risk: metadata.risk,
    arguments: Object.fromEntries(Object.entries(metadata.arguments).map(([key, value]) => [key, { ...value }])),
  }
}

export function operationMetadataCatalog() {
  return Object.fromEntries(approvedOperationNames().map(name => [name, runtimeMetadata(name)]))
}

export function operationMetadataForName(name) {
  return runtimeMetadata(name)
}

export function approvedOperationNames() {
  return Object.keys(RUNTIME_OPERATION_METADATA)
}

export function operationArgumentKeys(name) {
  return Object.keys(runtimeMetadata(name).arguments)
}

export function approvedOperationScopes() {
  return base.approvedOperationScopes()
}

export function operationScopesForName(name) {
  return runtimeMetadata(name).scopes
}

export function operationNamesForScope(scope) {
  check(approvedOperationScopes().includes(scope), `Unknown operation scope: ${scope}`)
  return approvedOperationNames().filter(name => RUNTIME_OPERATION_METADATA[name].scopes.includes(scope))
}

export function operationTypeCatalog() {
  return approvedOperationNames().map(name => {
    const metadata = runtimeMetadata(name)
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

export function parseOperation(value) {
  if (value?.name !== 'place_candidate') return base.parseOperation(value)
  check(value && typeof value === 'object' && !Array.isArray(value), 'Operation must be an object')
  exactKeys(value, ['name', 'args'])
  exactKeys(value.args, operationArgumentKeys('place_candidate'))
  return {
    name: 'place_candidate',
    args: {
      candidate_set_id: candidateReference(value.args.candidate_set_id, 'candidate_set_id', 'placement'),
      candidate_id: candidateReference(value.args.candidate_id, 'candidate_id', 'candidate'),
    },
  }
}

export function renderOperation(value) {
  const operation = parseOperation(value)
  if (operation.name === 'place_candidate') {
    return `remote.call('autorio_operations','place_candidate',${base.luaString(operation.args.candidate_set_id)},${base.luaString(operation.args.candidate_id)})`
  }
  return base.renderOperation(operation)
}

export function renderOperationPreflight(value) {
  const operation = parseOperation(value)
  if (operation.name === 'place_candidate') return null
  return base.renderOperationPreflight(operation)
}

export function parsePlan(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Provider response must be an object')
  exactKeys(value, ['chatMessage', 'plan', 'currentStep', 'operations'])
  check(typeof value.chatMessage === 'string' && value.chatMessage.length <= 2000, 'Invalid chatMessage')
  check(Array.isArray(value.plan) && value.plan.length <= 30 && value.plan.every(item => typeof item === 'string' && item.length <= 500), 'Invalid plan')
  optionalInteger(value.currentStep, 'currentStep', 0, 30)
  check(Array.isArray(value.operations) && value.operations.length <= 16, 'Invalid operations')
  return {
    chatMessage: value.chatMessage,
    plan: [...value.plan],
    currentStep: value.currentStep,
    operations: value.operations.map(parseOperation),
  }
}

function parsePlacementCandidates(args) {
  exactKeys(args, ['entity_name', 'center', 'radius', 'target_resource', 'limit'])
  const parsed = { entity_name: base.factorioName(args.entity_name) }
  if (args.center !== undefined) parsed.center = position(args.center)
  if (args.radius !== undefined) parsed.radius = optionalInteger(args.radius, 'radius', 1, 24)
  if (args.target_resource !== undefined) parsed.target_resource = base.factorioName(args.target_resource)
  if (args.limit !== undefined) parsed.limit = optionalInteger(args.limit, 'limit', 1, 8)
  return parsed
}

function renderPlacementCandidates(args) {
  const parsed = parsePlacementCandidates(args)
  const fields = [`entity_name=${base.luaString(parsed.entity_name)}`]
  if (parsed.center !== undefined) fields.push(`center={x=${parsed.center.x},y=${parsed.center.y}}`)
  if (parsed.radius !== undefined) fields.push(`radius=${parsed.radius}`)
  if (parsed.target_resource !== undefined) fields.push(`target_resource=${base.luaString(parsed.target_resource)}`)
  if (parsed.limit !== undefined) fields.push(`limit=${parsed.limit}`)
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_placement_candidates",{${fields.join(',')}})))`
}

function parseProductionScope(args) {
  exactKeys(args, ['calculation_id', 'target', 'max_depth', 'max_materials'])
  exactKeys(args.target, ['type', 'name'])
  check(args.target.type === 'item' || args.target.type === 'fluid', 'target.type must be item or fluid')
  const parsed = {
    calculation_id: base.factorioName(args.calculation_id),
    target: { type: args.target.type, name: base.factorioName(args.target.name) },
  }
  if (args.max_depth !== undefined) parsed.max_depth = optionalInteger(args.max_depth, 'max_depth', 0, 6)
  if (args.max_materials !== undefined) parsed.max_materials = optionalInteger(args.max_materials, 'max_materials', 1, 32)
  return parsed
}

function renderProductionScope(args) {
  const parsed = parseProductionScope(args)
  const fields = [
    `calculation_id=${base.luaString(parsed.calculation_id)}`,
    `target={type=${base.luaString(parsed.target.type)},name=${base.luaString(parsed.target.name)}}`,
  ]
  if (parsed.max_depth !== undefined) fields.push(`max_depth=${parsed.max_depth}`)
  if (parsed.max_materials !== undefined) fields.push(`max_materials=${parsed.max_materials}`)
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","scope_context",{${fields.join(',')}})))`
}

function parseSolveProduction(args) {
  exactKeys(args, ['calculation_id', 'target', 'included_recipe_names', 'machine_selections'])
  exactKeys(args.target, ['type', 'name', 'rate_per_second'])
  check(args.target.type === 'item' || args.target.type === 'fluid', 'target.type must be item or fluid')
  const parsed = {
    calculation_id: base.factorioName(args.calculation_id),
    target: { type: args.target.type, name: base.factorioName(args.target.name), rate_per_second: positiveRate(args.target.rate_per_second) },
  }
  if (args.included_recipe_names !== undefined) parsed.included_recipe_names = stringArray(args.included_recipe_names, 'included_recipe_names')
  if (args.machine_selections !== undefined) {
    check(Array.isArray(args.machine_selections) && args.machine_selections.length <= 64, 'machine_selections must be an array with at most 64 entries')
    parsed.machine_selections = args.machine_selections.map(selection => {
      exactKeys(selection, ['recipe_name', 'machine_name'])
      return { recipe_name: base.factorioName(selection.recipe_name), machine_name: base.factorioName(selection.machine_name) }
    })
  }
  return parsed
}

function renderSolveProduction(args) {
  const parsed = parseSolveProduction(args)
  const fields = [
    `calculation_id=${base.luaString(parsed.calculation_id)}`,
    `target={type=${base.luaString(parsed.target.type)},name=${base.luaString(parsed.target.name)},rate_per_second=${parsed.target.rate_per_second}}`,
  ]
  if (parsed.included_recipe_names !== undefined) fields.push(`included_recipe_names={${parsed.included_recipe_names.map(base.luaString).join(',')}}`)
  if (parsed.machine_selections !== undefined) {
    const selections = parsed.machine_selections.map(selection => `{recipe_name=${base.luaString(selection.recipe_name)},machine_name=${base.luaString(selection.machine_name)}}`)
    fields.push(`machine_selections={${selections.join(',')}}`)
  }
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","solve",{${fields.join(',')}})))`
}

function parseTransportCapacity(args) {
  exactKeys(args, ['kind', 'prototype_name', 'scope', 'required_rate_per_second', 'item_name', 'unit_number'])
  check(args.kind === 'belt' || args.kind === 'inserter' || args.kind === 'inserter_instance', 'kind must be belt, inserter, or inserter_instance')
  if (args.kind === 'inserter_instance') {
    check(args.prototype_name === undefined && args.scope === undefined && args.required_rate_per_second === undefined && args.item_name === undefined, 'inserter_instance only accepts unit_number')
    return { kind: args.kind, unit_number: positiveInteger(args.unit_number, 'unit_number') }
  }

  check(args.unit_number === undefined, 'unit_number is only valid for inserter_instance')
  const parsed = { kind: args.kind, prototype_name: base.factorioName(args.prototype_name) }
  if (args.kind === 'belt') {
    check(args.item_name === undefined, 'item_name is only valid for inserter capacity')
    if (args.scope !== undefined) {
      check(args.scope === 'lane' || args.scope === 'belt', 'scope must be lane or belt')
      parsed.scope = args.scope
    }
    if (args.required_rate_per_second !== undefined) parsed.required_rate_per_second = positiveRate(args.required_rate_per_second)
  }
  else {
    check(args.scope === undefined && args.required_rate_per_second === undefined, 'scope and required_rate_per_second are only valid for belt capacity')
    if (args.item_name !== undefined) parsed.item_name = base.factorioName(args.item_name)
  }
  return parsed
}

function renderTransportCapacity(args) {
  const parsed = parseTransportCapacity(args)
  if (parsed.kind === 'inserter_instance') {
    return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","capacity",{kind='inserter_instance',unit_number=${parsed.unit_number}})))`
  }
  const fields = [`kind=${base.luaString(parsed.kind)}`, `prototype_name=${base.luaString(parsed.prototype_name)}`]
  if (parsed.scope !== undefined) fields.push(`scope=${base.luaString(parsed.scope)}`)
  if (parsed.required_rate_per_second !== undefined) fields.push(`required_rate_per_second=${parsed.required_rate_per_second}`)
  if (parsed.item_name !== undefined) fields.push(`item_name=${base.luaString(parsed.item_name)}`)
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","capacity",{${fields.join(',')}})))`
}

function parseSpatialObservation(args) {
  exactKeys(args, ['anchor_unit_number', 'position', 'half_size', 'requested_entity_name'])
  const parsed = {}
  if (args.anchor_unit_number !== undefined) parsed.anchor_unit_number = positiveInteger(args.anchor_unit_number, 'anchor_unit_number')
  if (args.position !== undefined) parsed.position = position(args.position)
  check(!(parsed.anchor_unit_number !== undefined && parsed.position !== undefined), 'provide anchor_unit_number or position, not both')
  if (args.half_size !== undefined) parsed.half_size = optionalInteger(args.half_size, 'half_size', 4, 16)
  if (args.requested_entity_name !== undefined) parsed.requested_entity_name = base.factorioName(args.requested_entity_name)
  return parsed
}

function parsePlacement(args) {
  exactKeys(args, ['entity_name', 'anchor_unit_number', 'position', 'side', 'direction', 'search_radius', 'max_candidates', 'reserve_input', 'reserve_output', 'reserve_power', 'extension_direction'])
  const parsed = { entity_name: base.factorioName(args.entity_name) }
  if (args.anchor_unit_number !== undefined) parsed.anchor_unit_number = positiveInteger(args.anchor_unit_number, 'anchor_unit_number')
  if (args.position !== undefined) parsed.position = position(args.position)
  check(!(parsed.anchor_unit_number !== undefined && parsed.position !== undefined), 'provide anchor_unit_number or position, not both')
  if (args.side !== undefined) parsed.side = side(args.side, 'side')
  if (args.direction !== undefined) parsed.direction = optionalInteger(args.direction, 'direction', 0, 15)
  if (args.search_radius !== undefined) parsed.search_radius = optionalInteger(args.search_radius, 'search_radius', 1, 12)
  if (args.max_candidates !== undefined) parsed.max_candidates = optionalInteger(args.max_candidates, 'max_candidates', 1, 8)
  if (args.reserve_input !== undefined) parsed.reserve_input = optionalBoolean(args.reserve_input, 'reserve_input')
  if (args.reserve_output !== undefined) parsed.reserve_output = optionalBoolean(args.reserve_output, 'reserve_output')
  if (args.reserve_power !== undefined) parsed.reserve_power = optionalBoolean(args.reserve_power, 'reserve_power')
  if (args.extension_direction !== undefined) parsed.extension_direction = side(args.extension_direction, 'extension_direction')
  return parsed
}

function parseConstructionSites(args) {
  exactKeys(args, ['width', 'height', 'anchor_unit_number', 'position', 'search_radius', 'max_candidates'])
  const parsed = {
    width: optionalInteger(args.width, 'width', 2, 32),
    height: optionalInteger(args.height, 'height', 2, 32),
  }
  if (args.anchor_unit_number !== undefined) parsed.anchor_unit_number = positiveInteger(args.anchor_unit_number, 'anchor_unit_number')
  if (args.position !== undefined) parsed.position = position(args.position)
  check(!(parsed.anchor_unit_number !== undefined && parsed.position !== undefined), 'provide anchor_unit_number or position, not both')
  if (args.search_radius !== undefined) parsed.search_radius = optionalInteger(args.search_radius, 'search_radius', 2, 64)
  if (args.max_candidates !== undefined) parsed.max_candidates = optionalInteger(args.max_candidates, 'max_candidates', 1, 8)
  return parsed
}

function renderConstructionSites(args) {
  const parsed = parseConstructionSites(args)
  const fields = [
    `width=${parsed.width}`,
    `height=${parsed.height}`,
  ]
  if (parsed.anchor_unit_number !== undefined) fields.push(`anchor_unit_number=${parsed.anchor_unit_number}`)
  if (parsed.position !== undefined) fields.push(`position={x=${parsed.position.x},y=${parsed.position.y}}`)
  if (parsed.search_radius !== undefined) fields.push(`search_radius=${parsed.search_radius}`)
  if (parsed.max_candidates !== undefined) fields.push(`max_candidates=${parsed.max_candidates}`)
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","find_construction_sites",{${fields.join(',')}})))`
}

function parseConstructionPlan(args) {
  exactKeys(args, ['plan_id', 'placements'])
  check(Array.isArray(args.placements) && args.placements.length >= 1 && args.placements.length <= 16, 'placements must contain between 1 and 16 entries')
  return {
    plan_id: base.factorioName(args.plan_id),
    placements: args.placements.map((placement, index) => {
      exactKeys(placement, ['entity_name', 'x', 'y', 'direction'])
      const parsed = {
        entity_name: base.factorioName(placement.entity_name),
        x: finiteCoordinate(placement.x, `placements[${index}].x`),
        y: finiteCoordinate(placement.y, `placements[${index}].y`),
      }
      if (placement.direction !== undefined) parsed.direction = optionalInteger(placement.direction, `placements[${index}].direction`, 0, 15)
      return parsed
    }),
  }
}

function parseConstructionIntent(args) {
  exactKeys(args, ['surface_index', 'x', 'y', 'entity_name', 'direction', 'prepare_execution'])
  const parsed = {
    x: finiteCoordinate(args.x, 'x'),
    y: finiteCoordinate(args.y, 'y'),
    entity_name: base.factorioName(args.entity_name),
    prepare_execution: args.prepare_execution === undefined ? false : optionalBoolean(args.prepare_execution, 'prepare_execution'),
  }
  if (args.surface_index !== undefined) parsed.surface_index = optionalInteger(args.surface_index, 'surface_index', 1, 4294967295)
  if (args.direction !== undefined) parsed.direction = optionalInteger(args.direction, 'direction', 0, 15)
  return parsed
}

function renderConstructionIntent(args) {
  const parsed = parseConstructionIntent(args)
  const surface = parsed.surface_index === undefined ? 'nil' : parsed.surface_index
  const direction = parsed.direction === undefined ? 'nil' : parsed.direction
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_map_construction","intent",${surface},${parsed.x},${parsed.y},${base.luaString(parsed.entity_name)},${direction},${parsed.prepare_execution})))`
}

function parseResearchPath(args) {
  exactKeys(args, ['name', 'max_nodes'])
  return {
    name: base.factorioName(args.name),
    max_nodes: optionalInteger(args.max_nodes ?? 32, 'max_nodes', 1, 64),
  }
}

function luaTable(parsed) {
  const fields = []
  if (parsed.entity_name !== undefined) fields.push(`entity_name=${base.luaString(parsed.entity_name)}`)
  if (parsed.anchor_unit_number !== undefined) fields.push(`anchor_unit_number=${parsed.anchor_unit_number}`)
  if (parsed.position !== undefined) fields.push(`position={x=${parsed.position.x},y=${parsed.position.y}}`)
  if (parsed.half_size !== undefined) fields.push(`half_size=${parsed.half_size}`)
  if (parsed.requested_entity_name !== undefined) fields.push(`requested_entity_name=${base.luaString(parsed.requested_entity_name)}`)
  if (parsed.side !== undefined) fields.push(`side=${base.luaString(parsed.side)}`)
  if (parsed.direction !== undefined) fields.push(`direction=${parsed.direction}`)
  if (parsed.search_radius !== undefined) fields.push(`search_radius=${parsed.search_radius}`)
  if (parsed.max_candidates !== undefined) fields.push(`max_candidates=${parsed.max_candidates}`)
  if (parsed.reserve_input !== undefined) fields.push(`reserve_input=${parsed.reserve_input}`)
  if (parsed.reserve_output !== undefined) fields.push(`reserve_output=${parsed.reserve_output}`)
  if (parsed.reserve_power !== undefined) fields.push(`reserve_power=${parsed.reserve_power}`)
  if (parsed.extension_direction !== undefined) fields.push(`extension_direction=${base.luaString(parsed.extension_direction)}`)
  return `{${fields.join(',')}}`
}

function renderConstructionPlan(args) {
  const parsed = parseConstructionPlan(args)
  const placements = parsed.placements.map((placement) => {
    const fields = [
      `entity_name=${base.luaString(placement.entity_name)}`,
      `x=${placement.x}`,
      `y=${placement.y}`,
    ]
    if (placement.direction !== undefined) fields.push(`direction=${placement.direction}`)
    return `{${fields.join(',')}}`
  }).join(',')
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","validate_construction_plan",{plan_id=${base.luaString(parsed.plan_id)},placements={${placements}}})))`
}

function renderResearchPath(args) {
  const parsed = parseResearchPath(args)
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","research_path",${base.luaString(parsed.name)},${parsed.max_nodes})))`
}

const productionScopeDefinition = {
  type: 'function',
  function: {
    name: 'getProductionScope',
    description: 'Read bounded current-surface observed production, consumption, and net flow for one target and relevant upstream materials over 1m and 10m windows. Use this before solveProduction when the user did not specify a production rate. Facts only: this tool never recommends a target rate; the model must choose the intended production scope. If the user already provided an explicit rate or scope, skip this extra observation.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['calculation_id', 'target'],
      properties: {
        calculation_id: { type: 'string', minLength: 1, maxLength: 200 },
        target: {
          type: 'object', additionalProperties: false, required: ['type', 'name'],
          properties: {
            type: { type: 'string', enum: ['item', 'fluid'] },
            name: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
        max_depth: { type: 'integer', minimum: 0, maximum: 6, default: 3 },
        max_materials: { type: 'integer', minimum: 1, maximum: 32, default: 16 },
      },
    },
  },
}

const solveProductionDefinition = {
  type: 'function',
  function: {
    name: 'solveProduction',
    description: 'Deterministically solve a bounded production target from live Factorio recipes. Recipe flow and machine sizing only; sustainable transport still requires explicit capacity validation.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['calculation_id', 'target'],
      properties: {
        calculation_id: { type: 'string', minLength: 1, maxLength: 200 },
        target: {
          type: 'object', additionalProperties: false, required: ['type', 'name', 'rate_per_second'],
          properties: {
            type: { type: 'string', enum: ['item', 'fluid'] }, name: { type: 'string', minLength: 1, maxLength: 200 },
            rate_per_second: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000 },
          },
        },
        included_recipe_names: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 200 } },
        machine_selections: {
          type: 'array', maxItems: 64,
          items: {
            type: 'object', additionalProperties: false, required: ['recipe_name', 'machine_name'],
            properties: { recipe_name: { type: 'string', minLength: 1, maxLength: 200 }, machine_name: { type: 'string', minLength: 1, maxLength: 200 } },
          },
        },
      },
    },
  },
}

const transportCapacityDefinition = {
  type: 'function',
  function: {
    name: 'getTransportCapacity',
    description: 'Read live deterministic transport facts. Belt lane/whole-belt limits include researched stacking but stacked capacity is only a transport ceiling. Inserter prototype facts do not imply throughput. For an already observed placed inserter, kind inserter_instance plus exact unit_number returns its current pickup count, override, lane permissions and actual pickup/drop targets. Inserter transfer_rate remains unvalidated; never infer fixed items-per-second.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['belt', 'inserter', 'inserter_instance'] },
        prototype_name: { type: 'string', minLength: 1, maxLength: 200 },
        scope: { type: 'string', enum: ['lane', 'belt'] },
        required_rate_per_second: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000 },
        item_name: { type: 'string', minLength: 1, maxLength: 200 },
        unit_number: { type: 'integer', minimum: 1 },
      },
    },
  },
}

const positionSchema = {
  type: 'object', additionalProperties: false, required: ['x', 'y'],
  properties: { x: { type: 'number', minimum: -1000000, maximum: 1000000 }, y: { type: 'number', minimum: -1000000, maximum: 1000000 } },
}

const placementCandidatesDefinition = {
  type: 'function',
  function: {
    name: 'getPlacementCandidates',
    description: 'Ask the local Factorio harness for a bounded set of live legal placement candidates derived from the current prototype and surface. For resource-bound mining placement, provide target_resource so non-covering placements are rejected; candidates may include live resource coverage, direct item output position, and current-prototype fluid port geometry. Use returned candidate ids with place_candidate rather than retyping coordinates.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['entity_name'],
      properties: {
        entity_name: { type: 'string', minLength: 1, maxLength: 200 },
        center: positionSchema,
        radius: { type: 'integer', minimum: 1, maximum: 24, default: 8 },
        target_resource: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 8, default: 5 },
      },
    },
  },
}

const localSpatialObservationDefinition = {
  type: 'function',
  function: {
    name: 'getLocalSpatialObservation',
    description: 'Read a bounded live local occupancy/spatial snapshot (max 32x32) for construction or navigation diagnosis: blocking water/out-of-map tiles, structures, cliffs, belts, inserters, machines, storage and the NPC footprint. Prefer this to repeated same-name entity probes when geometry matters.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        anchor_unit_number: { type: 'integer', minimum: 1 }, position: positionSchema,
        half_size: { type: 'integer', minimum: 4, maximum: 16, default: 12 },
        requested_entity_name: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
  },
}

const placementPlannerDefinition = {
  type: 'function',
  function: {
    name: 'planPlacement',
    description: 'Deterministically select collision-free, locally reachable placement candidates from the live spatial map when geometry actually matters or after simple nearby place_entity failed with a meaningful placement blocker. Do not require this tool for ordinary unconstrained nearby placement: place_entity may omit coordinates and let the runtime choose a local non-colliding position. Returns explicit rejection causes plus reserved input/output/power/future-extension corridor intent. For resource-bound, shoreline-bound, or fluid-port-sensitive entities prefer getPlacementCandidates because it uses current prototype/runtime semantic constraints and candidate-id execution.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['entity_name'],
      properties: {
        entity_name: { type: 'string', minLength: 1, maxLength: 200 }, anchor_unit_number: { type: 'integer', minimum: 1 }, position: positionSchema,
        side: { type: 'string', enum: ['north', 'south', 'east', 'west', 'any'] }, direction: { type: 'integer', minimum: 0, maximum: 15 },
        search_radius: { type: 'integer', minimum: 1, maximum: 12, default: 8 }, max_candidates: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
        reserve_input: { type: 'boolean' }, reserve_output: { type: 'boolean' }, reserve_power: { type: 'boolean' },
        extension_direction: { type: 'string', enum: ['north', 'south', 'east', 'west', 'any'] },
      },
    },
  },
}

const constructionSiteDefinition = {
  type: 'function',
  function: {
    name: 'findConstructionSites',
    description: 'Find a small bounded set of clear rectangular construction envelopes on AIRI\'s current surface. The model chooses width/height and anchor; the tool only reports deterministic free-site candidates and aggregate rejection counts. A site is not a machine layout or construction approval: choose exact placements separately and validateConstructionPlan before execution.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['width', 'height'],
      properties: {
        width: { type: 'integer', minimum: 2, maximum: 32 },
        height: { type: 'integer', minimum: 2, maximum: 32 },
        anchor_unit_number: { type: 'integer', minimum: 1 },
        position: positionSchema,
        search_radius: { type: 'integer', minimum: 2, maximum: 64 },
        max_candidates: { type: 'integer', minimum: 1, maximum: 8 },
      },
    },
  },
}

const constructionPlanValidationDefinition = {
  type: 'function',
  function: {
    name: 'validateConstructionPlan',
    description: 'Validate one exact local construction batch against the live world and AIRI inventory before any placement occurs. Checks 1..16 exact placements for current placeability, pairwise planned collision, local reach, required items, actor/surface/force identity, and returns validation_id plus placement_count. After validation, execute exactly that validation_id and placement_count with execute_construction_plan; do not edit coordinates between validation and execution.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['plan_id', 'placements'],
      properties: {
        plan_id: { type: 'string', minLength: 1, maxLength: 200 },
        placements: {
          type: 'array', minItems: 1, maxItems: 16,
          items: {
            type: 'object', additionalProperties: false, required: ['entity_name', 'x', 'y'],
            properties: {
              entity_name: { type: 'string', minLength: 1, maxLength: 200 },
              x: { type: 'number', minimum: -1000000, maximum: 1000000 },
              y: { type: 'number', minimum: -1000000, maximum: 1000000 },
              direction: { type: 'integer', minimum: 0, maximum: 15 },
            },
          },
        },
      },
    },
  },
}

const constructionIntentDefinition = {
  type: 'function',
  function: {
    name: 'inspectConstructionIntent',
    description: 'Compact deterministic ghost check for fixed or personal-roboport fulfillment. prepare_execution only reserves a validation token; use returned execute_construction_plan if you choose to stage it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'entity_name'],
      properties: {
        surface_index: { type: 'integer', minimum: 1, maximum: 4294967295 },
        x: { type: 'number', minimum: -1000000, maximum: 1000000 },
        y: { type: 'number', minimum: -1000000, maximum: 1000000 },
        entity_name: { type: 'string', minLength: 1, maxLength: 200 },
        direction: { type: 'integer', minimum: 0, maximum: 15 },
        prepare_execution: { type: 'boolean', default: false },
      },
    },
  },
}


export const PLANNER_CONTROL_TOOL_NAME = 'submitPlan'

export const plannerControlToolDefinitions = [{
  type: 'function',
  function: {
    name: PLANNER_CONTROL_TOOL_NAME,
    description: 'Submit the planner/control-plane decision to the AIRI harness. Prefer this tool over serializing the whole response as JSON content. Normal assistant content may remain natural-language text for the user. The deterministic harness/runtime validates structured plan state, completion contracts, and world mutations before persistence or execution; Jev is not a correctness gate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['plan', 'currentStep', 'operations'],
      properties: {
        chatMessage: { type: 'string', maxLength: 2000, description: 'Optional fallback user-facing message when assistant content is empty.' },
        plan: {
          type: 'array',
          maxItems: 30,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
        currentStep: { type: 'integer', minimum: 0, maximum: 30 },
        operations: {
          type: 'array',
          maxItems: 16,
          description: 'Approved Autorio operation proposals. The runtime re-validates every name/args pair before admission.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'args'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              args: { type: 'object' },
            },
          },
        },
        checkpoint: {
          type: 'object',
          description: 'Optional deterministic completion contract authored by the Main LLM for the active step. It states what world state proves the step complete; the harness validates and evaluates it. Quantities are always lower bounds named "minimum".',
          required: ['mode', 'requirements'],
          properties: {
            mode: { type: 'string', enum: ['all', 'any'] },
            requirements: {
              type: 'array',
              minItems: 1,
              maxItems: 4,
              items: {
                type: 'object',
                required: ['kind'],
                properties: {
                  id: { type: 'string', maxLength: 80 },
                  kind: {
                    type: 'string',
                    enum: ['inventory_count', 'entity_inventory_count', 'entity_exists', 'entity_state', 'authoritative_operation_receipt', 'runtime_controller_state'],
                    description: 'inventory_count {item_name, minimum}; entity_inventory_count {unit_number, item_name, minimum}; entity_exists {unit_number}; entity_state {unit_number, expected: working|not_working|exists}; authoritative_operation_receipt {operation_name}; runtime_controller_state {controller: follow, expected: active|idle|healthy}.',
                  },
                  item_name: { type: 'string', maxLength: 160 },
                  minimum: { type: 'integer', minimum: 1, description: 'Inclusive lower bound: the step is complete when the count is at least this.' },
                  unit_number: { type: 'integer', minimum: 1 },
                  expected: { type: 'string', maxLength: 80 },
                  operation_name: { type: 'string', maxLength: 100 },
                  controller: { type: 'string', maxLength: 80 },
                },
              },
            },
          },
        },
        semanticCompletion: {
          type: 'object',
          additionalProperties: false,
          required: ['stepId'],
          description: 'Explicit Main-LLM semantic completion claim for the current prose-only step when no deterministic completion contract represents its meaning. The harness accepts it only for the exact active step and only when recent authoritative runtime evidence grounds the claim.',
          properties: {
            stepId: { type: 'string', minLength: 1, maxLength: 200 },
            rationale: { type: 'string', maxLength: 600 },
          },
        },
        roadmapNodeIds: {
          type: 'array',
          maxItems: 16,
          description: 'Optional stable Roadmap Shelf node ids this draft intentionally refines. Choose them from [PLANNING_STATE] refinement candidates/current shelf; the harness discards ids that are not present on the admitted shelf.',
          items: { type: 'string', minLength: 1, maxLength: 120 },
        },
        developmentMode: {
          type: 'string',
          enum: ['vertical', 'horizontal', 'maintain', 'recover'],
          description: 'Dominant development direction of this authored slice relative to the current critical path. This describes the draft and does not override runtime truth or user priorities.',
        },
        // LOD 1 guidance (roadmap 2 / 3). Deliberately NOT an object with steps
        // or operations: a shelf node says what should eventually be true and
        // why, and the runtime re-derives realization status from verified
        // evidence. `status`, `steps` and `operations` are absent from this
        // schema on purpose -- a node that could assert its own progress would
        // let the planner grade its own homework.
        roadmap: {
          type: 'array',
          maxItems: 24,
          description: 'Optional coarse Roadmap Shelf guidance for the long-horizon goal. Each entry is intent only -- what should eventually be true and why it matters -- never steps, operations or progress claims. The shelf guides which slice to plan next; it never executes. Restate the nodes that still apply: omitting a node marks it invalidated with its lineage preserved.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['intent'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 120, description: 'Stable id. Reuse the previous id when restating a node so its lineage and verified results survive.' },
              intent: { type: 'string', minLength: 1, maxLength: 400 },
              why_it_matters: { type: 'string', maxLength: 400 },
              depends_on: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 120 } },
              assumptions: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 300 } },
              derived_from_node_id: { type: 'string', minLength: 1, maxLength: 120, description: 'The coarser node this one refines, when it is a refinement.' },
              development_hint: { type: 'string', maxLength: 60, description: 'Non-binding steering hint about the KIND of work (roadmap 4.8), not an instruction.' },
            },
          },
        },
      },
    },
  },
}]

export function isPlannerControlToolName(name) {
  return name === PLANNER_CONTROL_TOOL_NAME
}

export function plannerControlPayloadFromMessage(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  const controls = calls.filter(call => call?.type === 'function' && isPlannerControlToolName(call?.function?.name))
  if (controls.length === 0) return undefined
  check(calls.length === 1 && controls.length === 1, 'submitPlan must be the only tool call in its assistant message')
  const rawArgs = controls[0]?.function?.arguments
  check(typeof rawArgs === 'string', 'submitPlan arguments must be JSON')
  let args
  try { args = JSON.parse(rawArgs) }
  catch { throw new base.PolicyError('submitPlan arguments must be valid JSON') }
  exactKeys(args, ['chatMessage', 'plan', 'currentStep', 'operations', 'checkpoint', 'semanticCompletion', 'roadmapNodeIds', 'developmentMode', 'roadmap'])
  check(Array.isArray(args.plan), 'submitPlan.plan must be an array')
  check(Number.isSafeInteger(args.currentStep), 'submitPlan.currentStep must be an integer')
  check(Array.isArray(args.operations), 'submitPlan.operations must be an array')
  check(args.semanticCompletion === undefined
    || (args.semanticCompletion && typeof args.semanticCompletion === 'object' && !Array.isArray(args.semanticCompletion)
      && typeof args.semanticCompletion.stepId === 'string' && args.semanticCompletion.stepId.trim()),
  'submitPlan.semanticCompletion must contain the active stepId')
  check(args.roadmapNodeIds === undefined || Array.isArray(args.roadmapNodeIds), 'submitPlan.roadmapNodeIds must be an array of shelf node ids')
  check(args.developmentMode === undefined || ['vertical', 'horizontal', 'maintain', 'recover'].includes(args.developmentMode), 'submitPlan.developmentMode must be vertical, horizontal, maintain, or recover')
  check(args.roadmap === undefined || Array.isArray(args.roadmap), 'submitPlan.roadmap must be an array of coarse shelf nodes')
  const natural = typeof message?.content === 'string' ? message.content.trim() : ''
  const fallback = typeof args.chatMessage === 'string' ? args.chatMessage : ''
  return {
    chatMessage: natural || fallback,
    plan: args.plan,
    currentStep: args.currentStep,
    operations: args.operations,
    ...(args.checkpoint !== undefined ? { checkpoint: args.checkpoint } : {}),
    ...(args.semanticCompletion !== undefined ? { semanticCompletion: args.semanticCompletion } : {}),
    ...(args.roadmapNodeIds !== undefined ? { roadmapNodeIds: args.roadmapNodeIds } : {}),
    ...(args.developmentMode !== undefined ? { developmentMode: args.developmentMode } : {}),
    ...(args.roadmap !== undefined ? { roadmap: args.roadmap } : {}),
  }
}

const researchPathDefinition = {
  type: 'function',
  function: {
    name: 'getResearchPath',
    description: 'Return a deterministic dependency-first path to one technology from the live force technology graph. Distinguishes already researched, exact gameplay-trigger requirements, science research, disabled/research-disabled blockers, and the next currently actionable technology. Never infer prerequisite order or trigger details from model memory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        max_nodes: { type: 'integer', minimum: 1, maximum: 64, default: 32 },
      },
    },
  },
}

export const toolDefinitions = [
  ...base.toolDefinitions,
  placementCandidatesDefinition,
  productionScopeDefinition,
  solveProductionDefinition,
  transportCapacityDefinition,
  localSpatialObservationDefinition,
  placementPlannerDefinition,
  constructionSiteDefinition,
  constructionPlanValidationDefinition,
  constructionIntentDefinition,
  researchPathDefinition,
]

export const providerToolDefinitions = [
  ...toolDefinitions,
  ...plannerControlToolDefinitions,
]

const OBSERVATION_TOOL_FAMILY = Object.freeze({
  getActorStatus: 'runtime_status',
  getTaskStatus: 'runtime_status',
  getNavigationStatus: 'runtime_status',
  getFollowStatus: 'runtime_status',
  getDefenseStatus: 'runtime_status',
  getCraftingStatus: 'runtime_status',
  getCombatStatus: 'runtime_status',

  getInventoryItems: 'inventory_equipment',
  getEquipmentStatus: 'inventory_equipment',

  getRecipe: 'recipe_production',
  getRecipeDetails: 'recipe_production',
  getProductionScope: 'recipe_production',
  solveProduction: 'recipe_production',

  discoverPrototypes: 'prototype_knowledge',
  getPrototypeDetails: 'prototype_knowledge',
  findSkills: 'prototype_knowledge',
  getSkillDetails: 'prototype_knowledge',

  getPlayerStatus: 'player_state',

  getNearbyEntities: 'nearby_world',
  findLongRangeEntities: 'nearby_world',
  findNearestEnemy: 'nearby_world',

  getEntityStatus: 'entity_status',
  getEntityGeometry: 'entity_status',
  getLocalSpatialObservation: 'entity_status',

  getLogisticsTopology: 'logistics_transport',
  measureTransportThroughput: 'logistics_transport',
  getTransportCapacity: 'logistics_transport',

  getResearchStatus: 'research_state',
  getResearchRequest: 'research_state',
  getTechnology: 'research_state',
  getResearchPath: 'research_state',

  getPlacementCandidates: 'placement_candidates',
  planPlacement: 'placement_candidates',

  findConstructionSites: 'construction_state',
  validateConstructionPlan: 'construction_state',
  inspectConstructionIntent: 'construction_state',
})

const OBSERVATION_TOOL_FAMILIES = Object.freeze([
  'runtime_status',
  'inventory_equipment',
  'recipe_production',
  'prototype_knowledge',
  'player_state',
  'nearby_world',
  'entity_status',
  'logistics_transport',
  'research_state',
  'placement_candidates',
  'construction_state',
])

const observationToolNames = toolDefinitions.map(tool => tool?.function?.name).filter(Boolean)
for (const name of observationToolNames) {
  check(Object.hasOwn(OBSERVATION_TOOL_FAMILY, name), `Observation tool ${name} has no relevance family`)
}
for (const name of Object.keys(OBSERVATION_TOOL_FAMILY)) {
  check(observationToolNames.includes(name), `Observation relevance metadata references unknown tool ${name}`)
}
for (const family of Object.values(OBSERVATION_TOOL_FAMILY)) {
  check(OBSERVATION_TOOL_FAMILIES.includes(family), `Unknown observation relevance family ${family}`)
}

export function observationToolFamilies() {
  return [...OBSERVATION_TOOL_FAMILIES]
}

export function observationToolFamily(name) {
  return typeof name === 'string' && Object.hasOwn(OBSERVATION_TOOL_FAMILY, name)
    ? OBSERVATION_TOOL_FAMILY[name]
    : undefined
}

export function observationToolFamilyCatalog() {
  return { ...OBSERVATION_TOOL_FAMILY }
}

export function isObservationToolName(name) {
  return typeof name === 'string'
    && toolDefinitions.some(tool => tool?.type === 'function' && tool.function?.name === name)
}

export function toolCommand(name, args) {
  if (name === 'getPlacementCandidates') return renderPlacementCandidates(args)
  if (name === 'getProductionScope') return renderProductionScope(args)
  if (name === 'solveProduction') return renderSolveProduction(args)
  if (name === 'getTransportCapacity') return renderTransportCapacity(args)
  if (name === 'getLocalSpatialObservation') return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","spatial_observation",${luaTable(parseSpatialObservation(args))})))`
  if (name === 'planPlacement') return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","plan_placement",${luaTable(parsePlacement(args))})))`
  if (name === 'findConstructionSites') return renderConstructionSites(args)
  if (name === 'validateConstructionPlan') return renderConstructionPlan(args)
  if (name === 'inspectConstructionIntent') return renderConstructionIntent(args)
  if (name === 'getResearchPath') return renderResearchPath(args)
  return base.toolCommand(name, args)
}