import * as base from '../staging/structured-policy.mjs'
import { normalizeObservationRequest, TARGETED_OBSERVATION_GUIDANCE } from './targeted-observation.mjs'
import { COMPLETION_CONTRACT_SCHEMA } from './step-completion.mjs'

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
  reserve_construction_area: Object.freeze({
    name: 'reserve_construction_area', scopes: Object.freeze(['construction']), preflight: true, risk: 'high',
    arguments: Object.freeze(Object.fromEntries(['reservation_id', 'revision'].map(key => [key, Object.freeze({ kind: 'runtime_candidate', required: true, defaulted: false, provenance: 'native_reservation_validation' })]))),
  }),
  prepare_pump_site: Object.freeze({
    name: 'prepare_pump_site', scopes: Object.freeze(['construction']), preflight: true, risk: 'high',
    arguments: Object.freeze({ preparation_id: Object.freeze({ kind: 'runtime_candidate', required: true, defaulted: false, provenance: 'pump_site_preparation_registry' }) }),
  }),
  place_candidate: Object.freeze({
    name: 'place_candidate',
    scopes: Object.freeze(['construction']),
    preflight: true,
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

// Nested argument shapes the flat metadata cannot express; keyed "name.arg".
const OPERATION_ARGUMENT_SHAPES = Object.freeze({
  'supply_entity.items': 'items:[{item_name,count}]',
})

// One line naming every approved operation with its argument keys ("?" marks
// an optional key), rendered from the catalog so the full and compact model
// prompts cannot drift from the runtime. Deterministic for a given catalog,
// which keeps the prompt prefix byte-stable.
export function approvedOperationListText() {
  return operationTypeCatalog().map((entry) => {
    const args = Object.entries(entry.arguments).map(([key, meta]) => `${OPERATION_ARGUMENT_SHAPES[`${entry.name}.${key}`] ?? key}${meta.required === false ? '?' : ''}`)
    return `${entry.name} {${args.join(',')}}`
  }).join('; ')
}

export function parseOperation(value) {
  if (value?.name === 'reserve_construction_area') {
    exactKeys(value, ['name', 'args']); exactKeys(value.args, ['reservation_id', 'revision'])
    return { name: value.name, args: { reservation_id: positiveInteger(value.args.reservation_id, 'reservation_id'), revision: positiveInteger(value.args.revision, 'revision') } }
  }
  if (value?.name === 'prepare_pump_site') {
    exactKeys(value, ['name', 'args']); exactKeys(value.args, ['preparation_id'])
    return { name: 'prepare_pump_site', args: { preparation_id: candidateReference(value.args.preparation_id, 'preparation_id', 'pump-preparation') } }
  }
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
  if (operation.name === 'reserve_construction_area') return `remote.call('autorio_operations','reserve_construction_area',${operation.args.reservation_id},${operation.args.revision})`
  if (operation.name === 'prepare_pump_site') return `remote.call('autorio_operations','prepare_pump_site',${base.luaString(operation.args.preparation_id)})`
  if (operation.name === 'place_candidate') {
    return `remote.call('autorio_operations','place_candidate',${base.luaString(operation.args.candidate_set_id)},${base.luaString(operation.args.candidate_id)})`
  }
  return base.renderOperation(operation)
}

export function renderOperationPreflight(value) {
  const operation = parseOperation(value)
  if (operation.name === 'reserve_construction_area') return `/silent-command rcon.print(helpers.table_to_json(remote.call('autorio_preflight','operation','reserve_construction_area',{reservation_id=${operation.args.reservation_id},revision=${operation.args.revision}})))`
  if (operation.name === 'prepare_pump_site') return `/silent-command rcon.print(helpers.table_to_json(remote.call('autorio_preflight','operation','prepare_pump_site',{preparation_id=${base.luaString(operation.args.preparation_id)}})))`
  if (operation.name === 'place_candidate') {
    return `/silent-command rcon.print(helpers.table_to_json(remote.call('autorio_preflight','operation','place_candidate',{candidate_set_id=${base.luaString(operation.args.candidate_set_id)},candidate_id=${base.luaString(operation.args.candidate_id)}})))`
  }
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
    operations: value.operations.map((operation, index) => {
      try { return parseOperation(operation) }
      catch (cause) {
        // Run L's exact-reference validator is deterministic. Keep this narrow:
        // unknown operation/argument keys and other format refusals retain
        // their existing fail-closed recovery contracts.
        if (!(cause instanceof base.PolicyError) || !Object.hasOwn(RUNTIME_OPERATION_METADATA, operation?.name ?? '')
          || !/^unit_number must be an integer from 1 to 9007199254740991$/.test(cause.message)) throw cause
        const error = new base.PolicyError(`${cause.message}. No operation from this batch ran. Correct this operation within the same semantic step; use fresh nearby discovery for exact entity references. A newly placed entity needs a placement receipt and observation before dependent supply. Never invent its unit_number.`)
        error.failureClass = 'plan_category'
        error.code = 'invalid_operation_arguments'
        error.details = {
          operation_index: index, operation: operation.name,
          arguments: operationArgumentFacts(operation),
          batch_operations: value.operations.map(op => Object.hasOwn(RUNTIME_OPERATION_METADATA, op?.name ?? '') ? op.name : 'unapproved'),
        }
        throw error
      }
    }),
  }
}

// Diagnostic values are schema-bounded; arbitrary strings/unknown keys are
// represented by type/length, never copied into traces or corrective prompts.
function operationArgumentFacts(operation) {
  const summarize = (value, depth = 0) => {
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : { type: 'number' }
    if (typeof value === 'string') return /^-?\d{1,16}$/.test(value) ? value : { type: 'string', length: value.length }
    if (depth >= 2) return { type: Array.isArray(value) ? 'array' : typeof value }
    if (Array.isArray(value)) return value.slice(0, 8).map(entry => summarize(entry, depth + 1))
    if (value && typeof value === 'object') return Object.fromEntries(['unit_number', 'item_name', 'count', 'x', 'y', 'storage_index', 'connection_index']
      .filter(key => Object.hasOwn(value, key)).map(key => [key, summarize(value[key], depth + 1)]))
    return { type: typeof value }
  }
  return Object.fromEntries(operationArgumentKeys(operation.name).slice(0, 16)
    .filter(key => Object.hasOwn(operation.args ?? {}, key)).map(key => [key, summarize(operation.args[key])]))
}

function parsePlacementCandidates(args) {
  exactKeys(args, ['entity_name', 'center', 'radius', 'target_resource', 'covers_position', 'connects_to', 'anchor', 'limit'])
  const parsed = { entity_name: base.factorioName(args.entity_name) }
  if (args.center !== undefined) parsed.center = position(args.center)
  if (args.radius !== undefined) parsed.radius = optionalInteger(args.radius, 'radius', 1, 24)
  if (args.target_resource !== undefined) parsed.target_resource = base.factorioName(args.target_resource)
  if (args.covers_position !== undefined) parsed.covers_position = position(args.covers_position)
  if (args.connects_to !== undefined) parsed.connects_to = parseConnectsTo(args.connects_to)
  if (args.anchor !== undefined) parsed.anchor = parseAnchor(args.anchor)
  if (args.limit !== undefined) parsed.limit = optionalInteger(args.limit, 'limit', 1, 8)
  return parsed
}

// The live entity a placement serves: candidates rank nearest it and a build never clears it.
function parseAnchor(value) {
  exactKeys(value, ['unit_number'])
  return { unit_number: positiveInteger(value.unit_number, 'anchor.unit_number') }
}

// A live entity fluid port the new entity must join: unit_number plus the storage and connection indices
// getEntityStatus lists under spatial.fluid.storages (storage `index`, connection `connection_index`).
function parseConnectsTo(value) {
  exactKeys(value, ['unit_number', 'storage_index', 'connection_index'])
  const parsed = { unit_number: positiveInteger(value.unit_number, 'connects_to.unit_number') }
  if (value.storage_index !== undefined) parsed.storage_index = optionalInteger(value.storage_index, 'connects_to.storage_index', 1, 8)
  if (value.connection_index !== undefined) parsed.connection_index = optionalInteger(value.connection_index, 'connects_to.connection_index', 1, 8)
  return parsed
}

function renderPlacementCandidates(args) {
  const parsed = parsePlacementCandidates(args)
  const fields = [`entity_name=${base.luaString(parsed.entity_name)}`]
  if (parsed.center !== undefined) fields.push(`center={x=${parsed.center.x},y=${parsed.center.y}}`)
  if (parsed.radius !== undefined) fields.push(`radius=${parsed.radius}`)
  if (parsed.target_resource !== undefined) fields.push(`target_resource=${base.luaString(parsed.target_resource)}`)
  if (parsed.covers_position !== undefined) fields.push(`covers_position={x=${parsed.covers_position.x},y=${parsed.covers_position.y}}`)
  if (parsed.connects_to !== undefined) {
    const join = [`unit_number=${parsed.connects_to.unit_number}`]
    if (parsed.connects_to.storage_index !== undefined) join.push(`storage_index=${parsed.connects_to.storage_index}`)
    if (parsed.connects_to.connection_index !== undefined) join.push(`connection_index=${parsed.connects_to.connection_index}`)
    fields.push(`connects_to={${join.join(',')}}`)
  }
  if (parsed.anchor !== undefined) fields.push(`anchor={unit_number=${parsed.anchor.unit_number}}`)
  if (parsed.limit !== undefined) fields.push(`limit=${parsed.limit}`)
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_placement_candidates",{${fields.join(',')}})))`
}

function renderFluidSourceTiles(args) {
  exactKeys(args, ['fluid_name', 'search_radius', 'limit'])
  const fields = [`fluid_name=${base.luaString(base.factorioName(args.fluid_name))}`]
  if (args.search_radius !== undefined) fields.push(`search_radius=${optionalInteger(args.search_radius, 'search_radius', 1, 256)}`)
  if (args.limit !== undefined) fields.push(`limit=${optionalInteger(args.limit, 'limit', 1, 8)}`)
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_fluid_source_tiles",{${fields.join(',')}})))`
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

function parseMiningDetails(args) {
  exactKeys(args, ['resource_or_item', 'fuel_name'])
  const parsed = { resource_or_item: base.factorioName(args.resource_or_item) }
  if (args.fuel_name !== undefined) parsed.fuel_name = base.factorioName(args.fuel_name)
  return parsed
}

function renderMiningDetails(args) {
  const parsed = parseMiningDetails(args)
  const fuel = parsed.fuel_name !== undefined ? `,${base.luaString(parsed.fuel_name)}` : ''
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","mining_details",${base.luaString(parsed.resource_or_item)}${fuel})))`
}

const ESTIMATE_STEP_NAMES = ['recipe', 'resource', 'machine', 'fuel']

function parseProductionEstimate(args) {
  exactKeys(args, ['target', 'count', 'steps'])
  check(Array.isArray(args.steps) && args.steps.length >= 1 && args.steps.length <= 16, 'steps must be an array with 1 to 16 entries')
  return {
    target: base.factorioName(args.target),
    count: positiveInteger(args.count, 'count', 1_000_000),
    steps: args.steps.map((step) => {
      exactKeys(step, ['item', ...ESTIMATE_STEP_NAMES, 'machine_count'])
      const parsed = { item: base.factorioName(step.item) }
      for (const key of ESTIMATE_STEP_NAMES) {
        if (step[key] !== undefined) parsed[key] = base.factorioName(step[key])
      }
      if (step.machine_count !== undefined) parsed.machine_count = positiveInteger(step.machine_count, 'machine_count', 1000)
      return parsed
    }),
  }
}

function renderProductionEstimate(args) {
  const parsed = parseProductionEstimate(args)
  const steps = parsed.steps.map((step) => {
    const fields = [`item=${base.luaString(step.item)}`]
    for (const key of ESTIMATE_STEP_NAMES) {
      if (step[key] !== undefined) fields.push(`${key}=${base.luaString(step[key])}`)
    }
    if (step.machine_count !== undefined) fields.push(`machine_count=${step.machine_count}`)
    return `{${fields.join(',')}}`
  })
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","production_estimate",{target=${base.luaString(parsed.target)},count=${parsed.count},steps={${steps.join(',')}}})))`
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
    description: 'Ask the local Factorio harness for a bounded set of live legal placement candidates derived from the current prototype and surface. For resource-bound mining placement, provide target_resource so non-covering placements are rejected; candidates may include live resource coverage, direct item output position, and current-prototype fluid port geometry. For an entity that must receive another entity\'s output (a furnace or chest fed by a drill), pass that candidate\'s item_output_position as covers_position so only placements whose footprint covers it are returned. Use returned candidate ids with place_candidate rather than retyping coordinates. With an anchor, candidates are ordered by distance to it and, at equal distance, the one that clears less comes first; without one, candidates that clear nothing are listed first. A footprint refused only for things a build may clear is still a candidate: its ground_items lists items lying there and its clears lists entities there (natural obstructions such as trees and rocks, and the NPC\'s own idle entities), and placing it with place_candidate picks the items up and mines those entities into the NPC inventory first, which takes hand-mining time and needs inventory room. Only place_candidate clears the NPC\'s own idle entities, and only the ones its clears listed; place_entity clears ground items and natural obstructions only and refuses a footprint held by anything else, reporting the blockers. A player\'s building, a cliff, and an entity that is part of a running machine chain are never cleared, so a footprint holding one is not a candidate. anchor {unit_number} names the live entity the new one must serve (the furnace a drill should feed): candidates are ranked nearest it first (ordering says so), each reports distance_from_anchor, the search centres on it when no center is given, and it is never cleared. The answer lists candidates first; obstructions, labelled rejected_footprint_samples_not_candidates, samples footprints that were rejected and are not candidates. connects_to {unit_number, storage_index?, connection_index?} (the indices getEntityStatus lists under spatial.fluid.storages) restricts results to footprints whose pipe connection joins that live entity\'s port: the footprints are solved from the prototype pipe connections, so radius does not limit them, each candidate\'s connects_to names the port it joins, and every open port of the entity is a target when connection_index is omitted. For offshore pumps, FIRST call getFluidSourceTiles for water and inspect covered_fluid_hints (native removable cover over hidden water); do not search pump placements before this read. Covered water requires getPumpSitePreparation and prepare_pump_site, then fresh native water/candidate validation, never immediate placement. With exposed water, use its shoreline as center or omit center to search near the nearest observed water sample. A missing water observation refuses the search without scanning. Offshore pumps MUST use place_candidate; generic place_entity is refused even with coordinates. An entity whose legality is decided by tile rules (a shoreline) is ordered nearest the actor first (result ordering says which). Electric-pole candidates report electric.poles_in_wire_reach (existing poles it could wire to, by distance) and electric.covers_entities (powered or consuming entities its supply area covers), from live positions and the pole prototype reach.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['entity_name'],
      properties: {
        entity_name: { type: 'string', minLength: 1, maxLength: 200 },
        center: positionSchema,
        radius: { type: 'integer', minimum: 1, maximum: 24, default: 8 },
        target_resource: { type: 'string', minLength: 1, maxLength: 200 },
        covers_position: positionSchema,
        connects_to: {
          type: 'object', additionalProperties: false, required: ['unit_number'],
          properties: {
            unit_number: { type: 'integer', minimum: 1 },
            storage_index: { type: 'integer', minimum: 1, maximum: 8 },
            connection_index: { type: 'integer', minimum: 1, maximum: 8 },
          },
        },
        anchor: {
          type: 'object', additionalProperties: false, required: ['unit_number'],
          properties: { unit_number: { type: 'integer', minimum: 1 } },
        },
        limit: { type: 'integer', minimum: 1, maximum: 8, default: 5 },
      },
    },
  },
}

function renderPumpSitePreparation(args) {
  exactKeys(args, ['x', 'y', 'direction'])
  const x = finiteCoordinate(args.x, 'x'); const y = finiteCoordinate(args.y, 'y')
  const direction = args.direction ?? 0
  check([0, 4, 8, 12].includes(direction), 'direction must be a cardinal Factorio direction')
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_pump_site_preparation",{x=${x},y=${y},direction=${direction}})))`
}
const pumpSitePreparationDefinition = {
  type: 'function', function: {
    name: 'getPumpSitePreparation',
    description: 'Read a bounded preparation proposal for an offshore pump at exact x,y and cardinal direction. First read getFluidSourceTiles and inspect covered_fluid_hints. This tool is read-only: it derives required water tiles from native prototype rules, freezes a single native landfill layer directly over water and rejects structures, unsafe footing, other covers and unsupported geometry. A preparation_id is not a legal pump candidate or permission to alter arbitrary terrain. Use prepare_pump_site {preparation_id} to run the bounded local removal job, then read fresh water and getPlacementCandidates before place_candidate. Reclaimed materials and real exposed water must be verified; a queued removal job or a deconstruction mark is not completion.',
    parameters: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: {
      x: { type: 'number', minimum: -1000000, maximum: 1000000 }, y: { type: 'number', minimum: -1000000, maximum: 1000000 },
      direction: { type: 'integer', enum: [0, 4, 8, 12], default: 0 },
    } },
  },
}

const fluidSourceTilesDefinition = {
  type: 'function', function: {
    name: 'getFluidSourceTiles',
    description: 'Read native fluid-bearing terrain tiles (for example water, as used by an offshore pump) around the current actor on its current surface. Tile names are derived from native fluid prototypes. Default radius 128, maximum 256; at most 8 samples, nearest the actor first among the tiles scanned (ordering says whether the scan was truncated), plus an explicit truncated flag. A sample is a tile of the fluid, which the character cannot walk onto: its approach (absent when none was found) is the nearest position within approach_search_radius tiles where the actor character can stand, a standing place and not a route or a build reach. Read this before looking up offshore-pump candidates. Separate covered_fluid_hints report minable landfill or other cover over native hidden/double-hidden fluid, with exact positions, removal layers and independent truncation/coverage flags. Check those preparation hints before choosing a site; getPumpSitePreparation can plan bounded native cover removal, followed by prepare_pump_site and fresh water/candidate reads. Super-force building can stage a pump ghost and terrain deconstruction; these hints neither remove tiles nor prove a legal pump placement. Samples are not reachable or legal pump placements. Ungenerated chunks in the search square are reported (generated_chunk_count, ungenerated_chunk_count, nearest ungenerated_chunks, coverage_complete) and the samples from generated terrain are still returned; an empty answer is conclusive only when empty_result_is_conclusive is true. Refuses with fluid_source_search_unexplored only when no chunk of the search square is generated. Does not generate terrain. Fluids are not entity prototypes: getNearbyEntities refuses a fluid name with code unknown_entity_prototype.',
    parameters: { type: 'object', additionalProperties: false, required: ['fluid_name'], properties: {
      fluid_name: { type: 'string', minLength: 1, maxLength: 200 },
      search_radius: { type: 'integer', minimum: 1, maximum: 256, default: 128 },
      limit: { type: 'integer', minimum: 1, maximum: 8, default: 8 },
    } },
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
    description: 'Deterministically select collision-free, locally reachable placement candidates from the live spatial map when geometry actually matters or after simple nearby place_entity failed with a meaningful placement blocker. Candidate centers, side checks, extension spacing, blockers, and returned footprints are derived from entity size and orientation. Do not require this tool for ordinary unconstrained nearby placement: place_entity may omit coordinates and let the runtime choose a local non-colliding position. For output/drop-point relationships, use getPlacementCandidates with covers_position instead of treating that point as a center. For offshore pumps first read getFluidSourceTiles for water (including covered_fluid_hints) and then use getPlacementCandidates plus place_candidate; generic placement is refused. For other resource-bound, shoreline-bound, or fluid-port-sensitive entities prefer getPlacementCandidates because it uses current prototype/runtime semantic constraints and candidate-id execution.',
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
    description: 'Find a small bounded set of clear rectangular construction envelopes on SGLuna\'s current surface. The model chooses width/height and anchor; the tool only reports deterministic free-site candidates and aggregate rejection counts. A site is not a machine layout or construction approval: choose exact placements separately and validateConstructionPlan before execution.',
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

const reservationDefinitions = [{
  type: 'function', function: { name: 'validateConstructionReservation',
    description: 'Validate a 2..32 tile local site for a reversible NPC reservation. Supply the exact active goal_id and plan_id. Does not cut or mark the world. Returns native reservation_id/revision, trusted mode and supported-entity checks. Execute reserve_construction_area with those exact IDs under the committed step. Review mode then waits for actual player approval before designer_input is available. A reservation does not prove a working layout.',
    parameters: { type: 'object', additionalProperties: false, required: ['goal_id', 'plan_id', 'x', 'y', 'width', 'height'], properties: {
      goal_id: { type: 'string', minLength: 1, maxLength: 200 }, plan_id: { type: 'string', minLength: 1, maxLength: 200 },
      x: { type: 'integer', minimum: -1000000, maximum: 1000000 }, y: { type: 'integer', minimum: -1000000, maximum: 1000000 },
      width: { type: 'integer', minimum: 2, maximum: 32 }, height: { type: 'integer', minimum: 2, maximum: 32 },
    } } },
}, {
  type: 'function', function: { name: 'getConstructionReservations', description: 'Read native reservation state and mode. awaiting_review requires real player review in /npc-spaces; the model cannot approve it. reserved permits the future designer handoff, restored releases the site. Never reuse original entity IDs after a cut/restore; read fresh identities.',
    parameters: { type: 'object', additionalProperties: false, properties: { reservation_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } } },
}, {
    type: 'function', function: { name: 'getReservationDesignInput', description: 'Read a bounded page of the immutable original site snapshot for an exact reserved native reservation/revision. Start at offset 0 and follow next_offset until absent; one page is not the whole site. It is unavailable before real player approval in review mode. This read does not invoke a designer or grant layout execution authority.',
      parameters: { type: 'object', additionalProperties: false, required: ['reservation_id', 'revision'], properties: { reservation_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, offset: { type: 'integer', minimum: 0, maximum: 1088 } } } },
}]

const constructionPlanValidationDefinition = {
  type: 'function',
  function: {
    name: 'validateConstructionPlan',
    description: 'Validate one exact local construction batch against the live world and SGLuna inventory before any placement occurs. Checks 1..16 exact placements for current placeability, pairwise planned collision, local reach, required items, actor/surface/force identity, and returns validation_id plus placement_count. After validation, execute exactly that validation_id and placement_count with execute_construction_plan; do not edit coordinates between validation and execution.',
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
    description: 'Submit the planner/control-plane decision to the SGLuna harness. Prefer this tool over serializing the whole response as JSON content. Normal assistant content may remain natural-language text for the user. The deterministic harness/runtime validates structured plan state, completion contracts, and world mutations before persistence or execution; Jev is not a correctness gate.',
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
        stepId: { type: 'string', minLength: 1, maxLength: 200, description: 'Executor only: the active committed step id from [CONTROL_DECISION_STATE]. Binds the operations to that step; plan and currentStep do not decide which step they belong to.' },
        assessmentOnly: { type: 'boolean', description: 'Set true only for an intentionally observation-only slice: all stepCompletions are semantic and operations is empty. Omit or set false for execution drafts, which declare deterministic steps: the current step\'s world-result checkpoint now, each later one when it is about to start. This does not change an existing committed plan.' },
        observationRequest: {
          type: 'object', additionalProperties: false, required: ['tool', 'args', 'rationale'],
          anyOf: [{ required: ['stepId'] }, { required: ['scope', 'goalId', 'planId', 'planVersion', 'draftRevision'] }],
          description: TARGETED_OBSERVATION_GUIDANCE,
          properties: {
            scope: { type: 'string', enum: ['step', 'draft'] },
            goalId: { type: 'string', minLength: 1, maxLength: 240 },
            planId: { type: 'string', minLength: 1, maxLength: 240 },
            planVersion: { type: 'integer', minimum: 1 },
            draftRevision: { type: 'integer', minimum: 0 },
            stepId: { type: 'string', minLength: 1, maxLength: 240 },
            tool: { type: 'string', enum: ['getEntityStatus', 'getInventoryItems', 'getResearchStatus', 'getFluidSourceTiles'] },
            args: { type: 'object' }, rationale: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
        operations: {
          type: 'array',
          maxItems: 16,
          description: 'Approved Autorio operation proposals. The runtime re-validates every name/args pair before admission.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'args'],
            properties: {
              name: { type: 'string', enum: approvedOperationNames() },
              args: { type: 'object' },
            },
          },
        },
        checkpoint: COMPLETION_CONTRACT_SCHEMA,
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
        timeReview: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          description: 'Only in answer to a harness time review: whether this resubmitted draft keeps the long serial work or was changed to run work in parallel, and why. It is traced; it never changes what runs.',
          properties: {
            decision: { type: 'string', enum: ['keep_serial', 'parallelize'] },
            reason: { type: 'string', maxLength: 400 },
          },
        },
        goal: {
          type: 'object',
          additionalProperties: false,
          required: ['scope', 'summary', 'doneWhen'],
          description: 'Required on the FIRST plan of every goal: your structured understanding of what the player asked for. The harness shows it to the player in game and owns the completion check -- the goal is complete only when the game reports every doneWhen condition true, never because plan steps ran out. Omit it on later plans of the same goal.',
          properties: {
            scope: {
              type: 'string',
              enum: ['finite', 'long_horizon'],
              description: 'finite: one plan of at most 30 steps completes the goal. long_horizon: needs several plan slices; you MUST also send roadmap (the Roadmap Shelf) on this same first plan.',
            },
            summary: { type: 'string', minLength: 1, maxLength: 400, description: 'One sentence restating the goal as you understood it, in the player\'s language.' },
            doneWhen: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              description: 'Game-checkable conditions that together prove the goal is complete. Use exact Factorio internal names. Quantities are lower bounds.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind'],
                properties: {
                  id: { type: 'string', maxLength: 60 },
                  kind: {
                    type: 'string',
                    enum: ['research_completed', 'rockets_launched', 'items_produced', 'inventory_count', 'space_location_unlocked', 'entity_working', 'electric_network_satisfied', 'production_rate'],
                    description: 'research_completed {technology}; rockets_launched {minimum}; items_produced {item_name, minimum} (force-wide total across all surfaces); inventory_count {item_name, minimum} (SGLuna\'s own inventory); space_location_unlocked {name} (Space Age planets/locations); entity_working {entity_name, minimum} (that many entities of the prototype working now); electric_network_satisfied {entity_name, minimum} (that many powered by a running producer, not short of power); production_rate {item_name, per_minute, window_minutes} (machine output per minute over the last 1 or 10 minutes, hand work excluded: any non-fuel hand insert, even into a chest, delays it by a window, and a hand-fed machine keeps it void until its hand-fed input is used up). Prove build/power/run goals with the running kinds or production_rate, never with items_produced.',
                  },
                  technology: { type: 'string', maxLength: 100 },
                  item_name: { type: 'string', maxLength: 100 },
                  name: { type: 'string', maxLength: 100 },
                  minimum: { type: 'integer', minimum: 1 },
                  entity_name: { type: 'string', maxLength: 100 },
                  per_minute: { type: 'number', exclusiveMinimum: 0, description: 'production_rate only: items per minute.' },
                  window_minutes: { type: 'integer', enum: [1, 10], description: 'production_rate only: the measured window, default 1.' },
                  countFrom: {
                    type: 'string',
                    enum: ['goal_start', 'save_start'],
                    description: 'rockets_launched and items_produced only. goal_start (default): minimum counts only what happens after the goal starts, so "launch a rocket" needs a new launch even if this save already launched one. save_start: the save\'s lifetime total, only when the player explicitly means a total.',
                  },
                },
              },
            },
          },
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

plannerControlToolDefinitions[0].function.parameters.properties.stepCompletions = {
  type: 'array', maxItems: 30,
  description: 'Required on newly authored plans: one declaration per plan description at the same index. In an execution plan the entry at currentStep carries its deterministic checkpoint; later entries are {kind:"deterministic"} and their checkpoints are requested when each step is about to start. Semantic declarations are accepted only with assessmentOnly:true.',
  items: { oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind'], properties: {
      kind: { type: 'string', enum: ['deterministic'] },
      checkpoint: plannerControlToolDefinitions[0].function.parameters.properties.checkpoint,
    } },
    { type: 'object', additionalProperties: false, required: ['kind', 'rationale'], properties: {
      kind: { type: 'string', enum: ['semantic'] }, rationale: { type: 'string', minLength: 1, maxLength: 600 },
    } },
  ] },
}

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
  exactKeys(args, ['chatMessage', 'plan', 'currentStep', 'operations', 'observationRequest', 'assessmentOnly', 'checkpoint', 'stepCompletions', 'semanticCompletion', 'roadmapNodeIds', 'developmentMode', 'roadmap', 'goal', 'timeReview', 'stepId', 'executionGuidance', 'plannerReview'])
  // An executor binds its operations to the committed active step by id; plan and currentStep are then not needed.
  const stepIdGiven = typeof args.stepId === 'string' && args.stepId.trim().length > 0
  check(args.stepId === undefined || stepIdGiven, 'submitPlan.stepId must be the active step id')
  const plan = args.plan === undefined && stepIdGiven ? [] : args.plan
  const currentStep = args.currentStep === undefined && stepIdGiven ? 0 : args.currentStep
  check(Array.isArray(plan), 'submitPlan.plan must be an array')
  check(Number.isSafeInteger(currentStep), 'submitPlan.currentStep must be an integer')
  check(Array.isArray(args.operations), 'submitPlan.operations must be an array')
  check(args.assessmentOnly === undefined || typeof args.assessmentOnly === 'boolean', 'submitPlan.assessmentOnly must be boolean')
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
    plan,
    currentStep,
    operations: args.operations,
    ...(args.executionGuidance !== undefined ? { executionGuidance: args.executionGuidance } : {}),
    ...(args.plannerReview !== undefined ? { plannerReview: args.plannerReview } : {}),
    ...(stepIdGiven ? { stepId: args.stepId.trim() } : {}),
    // Parsing the transport cannot decide whether reads are open. The loop
    // applies the closed grammar or ordinary tool policy using that round's state.
    ...(args.observationRequest !== undefined ? { observationRequest: normalizeObservationRequest(args.observationRequest, { normalTools: true }) } : {}),
    ...(args.assessmentOnly !== undefined ? { assessmentOnly: args.assessmentOnly } : {}),
    ...(args.checkpoint !== undefined ? { checkpoint: args.checkpoint } : {}),
    ...(args.stepCompletions !== undefined ? { stepCompletions: args.stepCompletions } : {}),
    ...(args.semanticCompletion !== undefined ? { semanticCompletion: args.semanticCompletion } : {}),
    ...(args.roadmapNodeIds !== undefined ? { roadmapNodeIds: args.roadmapNodeIds } : {}),
    ...(args.developmentMode !== undefined ? { developmentMode: args.developmentMode } : {}),
    ...(args.roadmap !== undefined ? { roadmap: args.roadmap } : {}),
    ...(args.goal !== undefined ? { goal: args.goal } : {}),
    ...(args.timeReview !== undefined ? { timeReview: args.timeReview } : {}),
  }
}

const miningDetailsDefinition = {
  type: 'function',
  function: {
    name: 'getMiningDetails',
    description: 'Read deterministic mining facts for a resource, or for the resources that yield an item: mining time, and per compatible drill its mining speed, output per minute (force mining productivity included) and energy source, plus hand mining for the NPC. Name fuel_name to also get that fuel\'s burn per minute on burner drills. Facts only; how many drills to build is your decision.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['resource_or_item'],
      properties: {
        resource_or_item: { type: 'string', minLength: 1, maxLength: 200 },
        fuel_name: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
  },
}

const productionEstimateDefinition = {
  type: 'function',
  function: {
    name: 'estimateProductionTime',
    description: 'Estimate how long making `count` of `target` takes with the steps you choose. One step per item you will produce: the machine and machine_count, or no machine for the NPC\'s own hands (hand crafting or hand mining); recipe/resource only when several fit; fuel to also get fuel burned. Returns total seconds, each step\'s rate and busy time, the limiting step, and the total with one more machine on it. Ingredients without a step are assumed on hand; transfer, walking and placement time are not included. Arithmetic over live recipe and prototype rates only: you choose the machine counts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target', 'count', 'steps'],
      properties: {
        target: { type: 'string', minLength: 1, maxLength: 200 },
        count: { type: 'integer', minimum: 1, maximum: 1000000 },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['item'],
            properties: {
              item: { type: 'string', minLength: 1, maxLength: 200 },
              recipe: { type: 'string', minLength: 1, maxLength: 200 },
              resource: { type: 'string', minLength: 1, maxLength: 200 },
              machine: { type: 'string', minLength: 1, maxLength: 200 },
              machine_count: { type: 'integer', minimum: 1, maximum: 1000 },
              fuel: { type: 'string', minLength: 1, maxLength: 200 },
            },
          },
        },
      },
    },
  },
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
  ...reservationDefinitions,
  placementCandidatesDefinition,
  fluidSourceTilesDefinition,
  pumpSitePreparationDefinition,
  productionScopeDefinition,
  solveProductionDefinition,
  miningDetailsDefinition,
  productionEstimateDefinition,
  transportCapacityDefinition,
  localSpatialObservationDefinition,
  placementPlannerDefinition,
  constructionSiteDefinition,
  constructionPlanValidationDefinition,
  constructionIntentDefinition,
  researchPathDefinition,
]

// Open typed requests may name any ordinary observation. This schema is shared
// across phases; the runtime still restricts closed requests to targeted facts.
plannerControlToolDefinitions[0].function.parameters.properties.observationRequest.properties.tool.enum = toolDefinitions.map(tool => tool.function.name)

export const providerToolDefinitions = [
  ...toolDefinitions,
  ...plannerControlToolDefinitions,
]

// The executor's own submitPlan (same tool name). The executor binds its operations to the committed active step by
// id, so the schema requires stepId and operations and carries only the fields the executor contract uses: the planner
// authors the plan, the goal, the roadmap, the development mode and the step completions, and the harness ignores them
// from an executor (enforceExecutorContract). The planner's definition above is unchanged. The parser stays tolerant:
// a reply that still carries plan and currentStep (closed-control JSON content, recorded fixtures) is read as before.
export const EXECUTOR_CONTROL_FIELDS = Object.freeze(['chatMessage', 'stepId', 'observationRequest', 'operations', 'checkpoint', 'semanticCompletion', 'timeReview'])
export const EXECUTOR_CONTROL_REQUIRED = Object.freeze(['stepId', 'operations'])

function executorControlToolDefinition(planner) {
  const source = planner.function.parameters
  const properties = {}
  for (const field of Object.keys(source.properties)) {
    if (EXECUTOR_CONTROL_FIELDS.includes(field)) properties[field] = structuredClone(source.properties[field])
  }
  return {
    type: 'function',
    function: {
      name: planner.function.name,
      description: planner.function.description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [...EXECUTOR_CONTROL_REQUIRED],
        properties,
      },
    },
  }
}

export const executorControlToolDefinitions = [executorControlToolDefinition(plannerControlToolDefinitions[0])]

export const executorProviderToolDefinitions = [
  ...toolDefinitions,
  ...executorControlToolDefinitions,
]

// Production protocol 3: keep the legacy tool definitions byte-stable for
// older callers. Empty operations is transport compatibility, never an action.
export const planningOnlyControlToolDefinitions = structuredClone(plannerControlToolDefinitions)
const planningOnly = planningOnlyControlToolDefinitions[0].function
planningOnly.description = 'Choose and explain a bounded plan slice. Gameplay operations belong to the executor; operations must be empty.'
delete planningOnly.parameters.properties.stepId
planningOnly.parameters.properties.operations = { type: 'array', maxItems: 0, items: { type: 'object' }, description: 'Always empty. The executor chooses operations after commit.' }
planningOnly.parameters.properties.executionGuidance = {
  type: 'array', maxItems: 30,
  description: 'One brief per execution step, aligned with plan. Explain approach and optional time-saving investments. skillIds must name loaded details.',
  items: { type: 'object', additionalProperties: false, required: ['approach', 'rationale', 'constraints', 'skillIds', 'materialSupply'], properties: {
    approach: { type: 'string', minLength: 1, maxLength: 200 },
    rationale: { type: 'string', minLength: 1, maxLength: 240 },
    constraints: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 100 } },
    skillIds: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 120 } },
    materialSupply: { description: 'Explicit method for the step resource, or null for other work. A skill alone does not mandate a layout. Explain setup/time savings in rationale.', anyOf: [
      { type: 'null' },
      { type: 'object', additionalProperties: false, required: ['mode', 'resource'], properties: {
        mode: { type: 'string', enum: ['direct_feed', 'manual_bootstrap'] },
        resource: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z0-9][a-z0-9_-]{0,79}$' },
      } },
    ] },
  } },
}
export const planningOnlyProviderToolDefinitions = [...toolDefinitions, ...planningOnlyControlToolDefinitions]

export const executionOnlyControlToolDefinitions = structuredClone(executorControlToolDefinitions)
executionOnlyControlToolDefinitions[0].function.parameters.properties.plannerReview = {
  type: 'object', additionalProperties: false, required: ['reason', 'rationale'],
  description: 'Request strategic review with empty operations. This is not world evidence or permission to replace a plan.',
  properties: {
    reason: { type: 'string', enum: ['approach_infeasible', 'scope_change', 'local_recovery_exhausted'] },
    rationale: { type: 'string', minLength: 1, maxLength: 400 },
  },
}
export const executionOnlyProviderToolDefinitions = [...toolDefinitions, ...executionOnlyControlToolDefinitions]

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
  getMiningDetails: 'recipe_production',
  estimateProductionTime: 'recipe_production',

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
  getPumpSitePreparation: 'placement_candidates',
  getFluidSourceTiles: 'nearby_world',
  planPlacement: 'placement_candidates',

  findConstructionSites: 'construction_state',
  validateConstructionReservation: 'construction_state',
  getConstructionReservations: 'construction_state',
  getReservationDesignInput: 'construction_state',
  validateConstructionPlan: 'construction_state',
  inspectConstructionIntent: 'construction_state',
})

// Who may limit each read. Reads cost no API money; extra planner rounds and
// large results do. Jev's budget therefore bounds rounds, not which facts the
// planner may see:
//   fact       current state or deterministic game data; never gated by Jev,
//              only by harness caps (per-batch cap, cache, duplicates)
//   discovery  searches and spatial/placement/logistics queries whose results
//              can be large; Jev ranks them, but one is always admitted per
//              batch when the planner asks
//   optional   Jev relevance gates them as before
// Every read still counts against Jev's budget, so an exhausted budget still
// forces the next decision without tools.
export const OBSERVATION_TOOL_TIER = Object.freeze({
  getActorStatus: 'fact',
  getTaskStatus: 'fact',
  getNavigationStatus: 'fact',
  getFollowStatus: 'fact',
  getDefenseStatus: 'fact',
  getCraftingStatus: 'fact',
  getCombatStatus: 'fact',
  getInventoryItems: 'fact',
  getEquipmentStatus: 'fact',
  getRecipe: 'fact',
  getRecipeDetails: 'fact',
  getProductionScope: 'fact',
  solveProduction: 'fact',
  getMiningDetails: 'fact',
  estimateProductionTime: 'fact',
  getPrototypeDetails: 'fact',
  getEntityStatus: 'fact',
  getEntityGeometry: 'fact',
  getResearchStatus: 'fact',
  getResearchRequest: 'fact',
  getTechnology: 'fact',
  getResearchPath: 'fact',

  discoverPrototypes: 'discovery',
  getNearbyEntities: 'discovery',
  findLongRangeEntities: 'discovery',
  findNearestEnemy: 'discovery',
  getLocalSpatialObservation: 'discovery',
  getLogisticsTopology: 'discovery',
  measureTransportThroughput: 'discovery',
  getTransportCapacity: 'discovery',
  // Deterministic harness-computed placement choices with bounded output.
  getPlacementCandidates: 'fact',
  getPumpSitePreparation: 'fact',
  getFluidSourceTiles: 'discovery',
  planPlacement: 'fact',
  findConstructionSites: 'discovery',
  validateConstructionReservation: 'discovery',
  getConstructionReservations: 'fact',
  getReservationDesignInput: 'fact',
  validateConstructionPlan: 'discovery',
  inspectConstructionIntent: 'discovery',

  getPlayerStatus: 'optional',
  findSkills: 'optional',
  getSkillDetails: 'optional',
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

export function observationToolTier(name) {
  return typeof name === 'string' && Object.hasOwn(OBSERVATION_TOOL_TIER, name)
    ? OBSERVATION_TOOL_TIER[name]
    : 'optional'
}

export function isObservationToolName(name) {
  return typeof name === 'string'
    && toolDefinitions.some(tool => tool?.type === 'function' && tool.function?.name === name)
}

export function toolCommand(name, args) {
  if (name === 'validateConstructionReservation') {
    exactKeys(args, ['goal_id', 'plan_id', 'x', 'y', 'width', 'height'])
    check(['x', 'y', 'width', 'height'].every(key => Number.isInteger(args[key])), 'Area coordinates and dimensions are required integers')
    for (const key of ['goal_id', 'plan_id']) check(typeof args[key] === 'string' && args[key].trim() && args[key].length <= 200, `Invalid ${key}`)
    for (const key of ['x', 'y']) optionalInteger(args[key], key, -1000000, 1000000)
    for (const key of ['width', 'height']) optionalInteger(args[key], key, 2, 32)
    return `/silent-command rcon.print(helpers.table_to_json(remote.call('autorio_reservations','validate',{goal_id=${base.luaString(args.goal_id)},plan_id=${base.luaString(args.plan_id)},x=${args.x},y=${args.y},width=${args.width},height=${args.height}})))`
  }
  if (name === 'getConstructionReservations') {
    exactKeys(args, ['reservation_id'])
    if (args.reservation_id !== undefined) positiveInteger(args.reservation_id, 'reservation_id')
    return `/silent-command rcon.print(helpers.table_to_json(remote.call('autorio_reservations','status'${args.reservation_id === undefined ? '' : `,${args.reservation_id}`})))`
  }
  if (name === 'getReservationDesignInput') {
    exactKeys(args, ['reservation_id', 'revision', 'offset'])
    positiveInteger(args.reservation_id, 'reservation_id'); positiveInteger(args.revision, 'revision')
    optionalInteger(args.offset ?? 0, 'offset', 0, 1088)
    return `/silent-command rcon.print(helpers.table_to_json(remote.call('autorio_reservations','designer_input',${args.reservation_id},${args.revision},${args.offset ?? 0})))`
  }
  if (name === 'getPumpSitePreparation') return renderPumpSitePreparation(args)
  if (name === 'getFluidSourceTiles') return renderFluidSourceTiles(args)
  if (name === 'getPlacementCandidates') return renderPlacementCandidates(args)
  if (name === 'getProductionScope') return renderProductionScope(args)
  if (name === 'solveProduction') return renderSolveProduction(args)
  if (name === 'getTransportCapacity') return renderTransportCapacity(args)
  if (name === 'getMiningDetails') return renderMiningDetails(args)
  if (name === 'estimateProductionTime') return renderProductionEstimate(args)
  if (name === 'getLocalSpatialObservation') return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","spatial_observation",${luaTable(parseSpatialObservation(args))})))`
  if (name === 'planPlacement') return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","plan_placement",${luaTable(parsePlacement(args))})))`
  if (name === 'findConstructionSites') return renderConstructionSites(args)
  if (name === 'validateConstructionPlan') return renderConstructionPlan(args)
  if (name === 'inspectConstructionIntent') return renderConstructionIntent(args)
  if (name === 'getResearchPath') return renderResearchPath(args)
  return base.toolCommand(name, args)
}
