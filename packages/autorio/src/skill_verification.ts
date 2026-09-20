import type { ControlledActor } from './actors/types'
import { validate_construction_execution_plan, type ConstructionExecutionPlacement } from './construction_execution'
import {
  analyze_factory_area,
  get_factory_area_analysis,
  skill_candidate_definition_from_block,
  type FactoryAreaBounds,
  type FactoryAreaAnalysis,
} from './factory_area_learning'
import {
  get_learning_policy,
  list_learning_verification_queue,
  skill_novelty_key,
  update_learning_opportunity,
  type LearningVerificationQueueItem,
  type LearningVerificationQueueState,
} from './learning_opportunities'
import {
  get_skill_definition,
  put_skill_definition,
  type SkillDefinition,
} from './skills'

export type SkillVerificationRunState
  = | 'validating'
    | 'constructing'
    | 'configuring'
    | 'supplying'
    | 'reobserving'
    | 'observing_output'
    | 'verified'
    | 'failed'
    | 'blocked'

export type SkillVerificationFailureKind = 'execution' | 'semantic'

interface TemplateRecipePart {
  type: string
  name: string
  amount?: number
}

export interface SkillInstanceTemplateEntity {
  template_id: string
  entity_name: string
  entity_type: string
  category: string
  dx: number
  dy: number
  direction: number
  requires_power: boolean
  recipe?: {
    name: string
    ingredients: TemplateRecipePart[]
    products: TemplateRecipePart[]
  }
}

export interface SkillInstanceTemplate {
  schema_version: 1
  skill_id: string
  skill_revision: number
  source_analysis_id: string
  source_block_id: string
  source_surface_index: number
  source_origin: { x: number, y: number }
  source_bounds: FactoryAreaBounds
  entities: SkillInstanceTemplateEntity[]
}

interface VerificationInputRoute {
  template_id: string
  item_name: string
  count: number
}

interface VerificationBuiltEntity {
  template_id: string
  unit_number: number
}

export interface SkillVerificationRun {
  schema_version: 1
  id: string
  opportunity_id: string
  skill_id: string
  skill_revision: number
  state: SkillVerificationRunState
  started_tick: number
  updated_tick: number
  target_surface_index?: number
  target_origin?: { x: number, y: number }
  instance_bounds?: FactoryAreaBounds
  placements: ConstructionExecutionPlacement[]
  input_routes: VerificationInputRoute[]
  built_entities: VerificationBuiltEntity[]
  active_batch_id?: number
  active_batch_generation?: number
  active_batch_ref?: string
  baseline_output_counts: Record<string, number>
  observed_output_counts: Record<string, number>
  output_deadline_tick?: number
  live_analysis_id?: string
  topology_match?: boolean
  evidence_refs: string[]
  failure_kind?: SkillVerificationFailureKind
  reason: string
  completed_tick?: number
}

declare const storage: {
  airi_skill_instance_templates?: Record<string, SkillInstanceTemplate>
  airi_skill_verification_runs?: Record<string, SkillVerificationRun>
  airi_skill_verification_run_order?: string[]
  airi_skill_verification_next_id?: number
  airi_skill_verification_active_run_id?: string
  airi_learning_verification_queue?: LearningVerificationQueueItem[]
}

const MAX_TEMPLATE_ENTITIES = 16
const MAX_RUN_HISTORY = 16
const MAX_EVIDENCE_REFS = 48
const OUTPUT_BATCHES = 2
const MAX_RECIPE_DEPTH = 12
const OUTPUT_OBSERVATION_TICKS = 60 * 30
const INSTANCE_AREA_PADDING = 2
const RUNTIME_TICK_INTERVAL = 17
const POSITION_EPSILON = 0.2

let runtime_registered = false

function templates() {
  if (storage.airi_skill_instance_templates === undefined) storage.airi_skill_instance_templates = {}
  return storage.airi_skill_instance_templates
}

function runs() {
  if (storage.airi_skill_verification_runs === undefined) storage.airi_skill_verification_runs = {}
  if (storage.airi_skill_verification_run_order === undefined) storage.airi_skill_verification_run_order = []
  return storage.airi_skill_verification_runs
}

function queue_records() {
  if (storage.airi_learning_verification_queue === undefined) storage.airi_learning_verification_queue = []
  return storage.airi_learning_verification_queue
}

function unique_strings(values: string[], limit = MAX_EVIDENCE_REFS) {
  const result: string[] = []
  for (const value of values) {
    if (value.length === 0 || result.includes(value)) continue
    result.push(value)
    if (result.length >= limit) break
  }
  return result
}

function next_run_id() {
  const next = storage.airi_skill_verification_next_id ?? 1
  storage.airi_skill_verification_next_id = next + 1
  return `skill-verification-${next}`
}

function store_run(run: SkillVerificationRun) {
  const registry = runs()
  const order = storage.airi_skill_verification_run_order as string[]
  registry[run.id] = run
  if (!order.includes(run.id)) order.push(run.id)
  while (order.length > MAX_RUN_HISTORY) {
    const removed = order.shift()
    if (removed !== undefined && removed !== storage.airi_skill_verification_active_run_id) delete registry[removed]
  }
  return run
}

function update_run(run: SkillVerificationRun, patch: Partial<SkillVerificationRun>) {
  const next: SkillVerificationRun = {
    ...run,
    ...patch,
    id: run.id,
    opportunity_id: run.opportunity_id,
    skill_id: run.skill_id,
    skill_revision: run.skill_revision,
    started_tick: run.started_tick,
    updated_tick: game.tick,
  }
  store_run(next)
  return next
}

function active_run() {
  const id = storage.airi_skill_verification_active_run_id
  return id !== undefined ? (storage.airi_skill_verification_runs ?? {})[id] : undefined
}

function queue_item(opportunity_id: string) {
  for (const item of queue_records()) if (item.opportunity_id === opportunity_id) return item
  return undefined
}

function remove_queue_item(opportunity_id: string) {
  const queue = queue_records()
  for (let index = queue.length - 1; index >= 0; index--) if (queue[index].opportunity_id === opportunity_id) queue.splice(index, 1)
}

function set_queue_state(opportunity_id: string, state: LearningVerificationQueueState, reason: string) {
  const item = queue_item(opportunity_id)
  if (!item) return
  item.state = state
  item.reason = reason
}

function block_run(run: SkillVerificationRun, reason: string, evidence_refs: string[] = []) {
  const refs = unique_strings([...run.evidence_refs, ...evidence_refs])
  const next = update_run(run, { state: 'blocked', reason, evidence_refs: refs, completed_tick: game.tick })
  set_queue_state(run.opportunity_id, 'blocked', reason)
  update_learning_opportunity(run.opportunity_id, {
    state: 'awaiting_verification',
    verification_run_id: run.id,
    evidence_refs: refs,
    reason: `Verification blocked: ${reason}`,
  })
  storage.airi_skill_verification_active_run_id = undefined
  return next
}

export function fail_skill_verification_run(run: SkillVerificationRun, failure_kind: SkillVerificationFailureKind, reason: string, evidence_refs: string[] = []) {
  const refs = unique_strings([...run.evidence_refs, ...evidence_refs])
  const next = update_run(run, { state: 'failed', failure_kind, reason, evidence_refs: refs, completed_tick: game.tick })
  remove_queue_item(run.opportunity_id)
  update_learning_opportunity(run.opportunity_id, {
    state: 'failed',
    verification_run_id: run.id,
    evidence_refs: refs,
    reason: `Verification ${failure_kind} failure: ${reason}`,
  })
  storage.airi_skill_verification_active_run_id = undefined
  return next
}

function block_from_factory_analysis(analysis: FactoryAreaAnalysis, block_id: string) {
  for (const block of analysis.blocks) if (block.id === block_id) return block
  return undefined
}

export function capture_skill_instance_template_from_block(skill_id: string, skill_revision: number, analysis_id: string, block_id: string) {
  const analysis = get_factory_area_analysis(analysis_id)
  if (!analysis) return { ok: false as const, error: `source analysis is unavailable: ${analysis_id}` }
  const block = block_from_factory_analysis(analysis, block_id)
  if (!block) return { ok: false as const, error: `source block is unavailable: ${block_id}` }
  if (block.entity_ids.length < 1 || block.entity_ids.length > MAX_TEMPLATE_ENTITIES) {
    return { ok: false as const, error: `verification template requires 1-${MAX_TEMPLATE_ENTITIES} entities` }
  }

  const observations = [] as FactoryAreaAnalysis['entities']
  for (const id of block.entity_ids) {
    for (const entity of analysis.entities) {
      if (entity.id === id) {
        observations.push(entity)
        break
      }
    }
  }
  if (observations.length !== block.entity_ids.length) return { ok: false as const, error: 'source block observations are incomplete' }

  let min_x = observations[0].position.x
  let max_x = observations[0].position.x
  let min_y = observations[0].position.y
  let max_y = observations[0].position.y
  for (const entity of observations) {
    min_x = math.min(min_x, entity.position.x)
    max_x = math.max(max_x, entity.position.x)
    min_y = math.min(min_y, entity.position.y)
    max_y = math.max(max_y, entity.position.y)
  }
  const origin = { x: (min_x + max_x) / 2, y: (min_y + max_y) / 2 }
  const template_entities: SkillInstanceTemplateEntity[] = []
  for (let index = 0; index < observations.length; index++) {
    const entity = observations[index]
    template_entities.push({
      template_id: `template-${index + 1}`,
      entity_name: entity.name,
      entity_type: entity.type,
      category: entity.category,
      dx: entity.position.x - origin.x,
      dy: entity.position.y - origin.y,
      direction: entity.direction,
      requires_power: entity.power?.electric_network_id !== undefined,
      recipe: entity.recipe
        ? {
            name: entity.recipe.name,
            ingredients: entity.recipe.ingredients.map(value => ({ type: value.type, name: value.name, amount: value.amount })),
            products: entity.recipe.products.map(value => ({ type: value.type, name: value.name, amount: value.amount })),
          }
        : undefined,
    })
  }
  const template: SkillInstanceTemplate = {
    schema_version: 1,
    skill_id,
    skill_revision,
    source_analysis_id: analysis_id,
    source_block_id: block_id,
    source_surface_index: analysis.surface_index,
    source_origin: origin,
    source_bounds: {
      left_top: { x: min_x - 0.5, y: min_y - 0.5 },
      right_bottom: { x: max_x + 0.5, y: max_y + 0.5 },
    },
    entities: template_entities,
  }
  templates()[skill_id] = template
  return { ok: true as const, template }
}

export function get_skill_instance_template(skill_id: string) {
  return (storage.airi_skill_instance_templates ?? {})[skill_id]
}

function source_block_ref(skill: SkillDefinition) {
  for (const ref of skill.source.evidence_refs) {
    if (!ref.startsWith('factory-block:')) continue
    const raw = ref.slice('factory-block:'.length)
    const parts = raw.split(':')
    if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) return { analysis_id: parts[0], block_id: parts[1] }
  }
  return undefined
}

function template_for_skill(skill: SkillDefinition) {
  const existing = get_skill_instance_template(skill.id)
  if (existing && existing.skill_revision === skill.revision) return existing
  const ref = source_block_ref(skill)
  if (!ref) return undefined
  const captured = capture_skill_instance_template_from_block(skill.id, skill.revision, ref.analysis_id, ref.block_id)
  return captured.ok ? captured.template : undefined
}

function translated_bounds(template: SkillInstanceTemplate, target_origin: { x: number, y: number }) {
  const dx = target_origin.x - template.source_origin.x
  const dy = target_origin.y - template.source_origin.y
  return {
    left_top: { x: template.source_bounds.left_top.x + dx, y: template.source_bounds.left_top.y + dy },
    right_bottom: { x: template.source_bounds.right_bottom.x + dx, y: template.source_bounds.right_bottom.y + dy },
  }
}

function areas_overlap(left: FactoryAreaBounds, right: FactoryAreaBounds) {
  return left.left_top.x < right.right_bottom.x
    && left.right_bottom.x > right.left_top.x
    && left.left_top.y < right.right_bottom.y
    && left.right_bottom.y > right.left_top.y
}

export function instantiate_skill_template(template: SkillInstanceTemplate, target_origin: { x: number, y: number }) {
  const placements: ConstructionExecutionPlacement[] = []
  for (const entity of template.entities) {
    placements.push({
      entity_name: entity.entity_name,
      x: target_origin.x + entity.dx,
      y: target_origin.y + entity.dy,
      direction: entity.direction,
    })
  }
  return { placements, bounds: translated_bounds(template, target_origin) }
}

function rounded_translation_origin(template: SkillInstanceTemplate, desired: { x: number, y: number }) {
  const dx = math.floor((desired.x - template.source_origin.x) + 0.5)
  const dy = math.floor((desired.y - template.source_origin.y) + 0.5)
  return { x: template.source_origin.x + dx, y: template.source_origin.y + dy }
}

function candidate_origins(actor: ControlledActor, template: SkillInstanceTemplate, requested?: { x: number, y: number }) {
  if (requested !== undefined) return [rounded_translation_origin(template, requested)]
  const offsets = [
    { x: 0, y: 0 },
    { x: 6, y: 0 }, { x: -6, y: 0 }, { x: 0, y: 6 }, { x: 0, y: -6 },
    { x: 8, y: 0 }, { x: -8, y: 0 }, { x: 0, y: 8 }, { x: 0, y: -8 },
    { x: 6, y: 6 }, { x: 6, y: -6 }, { x: -6, y: 6 }, { x: -6, y: -6 },
  ]
  const result: Array<{ x: number, y: number }> = []
  for (const offset of offsets) result.push(rounded_translation_origin(template, { x: actor.position.x + offset.x, y: actor.position.y + offset.y }))
  return result
}

function finite_positive_amount(value: unknown): value is number {
  return typeof value === 'number' && value === value && value > 0 && value < math.huge
}

function add_route(routes: VerificationInputRoute[], template_id: string, item_name: string, count: number) {
  for (const route of routes) {
    if (route.template_id === template_id && route.item_name === item_name) {
      route.count += count
      return
    }
  }
  routes.push({ template_id, item_name, count })
}

function external_input(skill: SkillDefinition, item_name: string) {
  for (const input of skill.inputs) if (input.item === item_name) return true
  return false
}

function producer_for(template: SkillInstanceTemplate, item_name: string) {
  for (const entity of template.entities) {
    if (!entity.recipe) continue
    for (const product of entity.recipe.products) if (product.type === 'item' && product.name === item_name) return { entity, product }
  }
  return undefined
}

function build_input_plan(skill: SkillDefinition, template: SkillInstanceTemplate) {
  const routes: VerificationInputRoute[] = []
  const errors: string[] = []

  function require_item(item_name: string, amount: number, consumer_template_id: string | undefined, depth: number) {
    if (errors.length > 0) return
    if (depth > MAX_RECIPE_DEPTH) {
      errors.push(`recipe dependency depth exceeded while resolving ${item_name}`)
      return
    }
    if (external_input(skill, item_name)) {
      if (!consumer_template_id) {
        errors.push(`external input ${item_name} has no concrete consumer`)
        return
      }
      add_route(routes, consumer_template_id, item_name, math.ceil(amount))
      return
    }
    const producer = producer_for(template, item_name)
    if (!producer || !producer.entity.recipe) {
      errors.push(`no reusable recipe producer exists for intermediate ${item_name}`)
      return
    }
    if (!finite_positive_amount(producer.product.amount)) {
      errors.push(`product amount for ${item_name} is not deterministic in the source example`)
      return
    }
    const crafts = math.ceil(amount / producer.product.amount)
    for (const ingredient of producer.entity.recipe.ingredients) {
      if (ingredient.type !== 'item') {
        errors.push(`non-item ingredient ${ingredient.name} is outside verifier V1 input routing`)
        return
      }
      if (!finite_positive_amount(ingredient.amount)) {
        errors.push(`ingredient amount for ${ingredient.name} is not deterministic in the source example`)
        return
      }
      require_item(ingredient.name, ingredient.amount * crafts, producer.entity.template_id, depth + 1)
    }
  }

  for (const output of skill.outputs) require_item(output.item, OUTPUT_BATCHES, undefined, 0)
  if (errors.length > 0) return { ok: false as const, error: errors[0], routes: [] as VerificationInputRoute[] }
  if (skill.inputs.length > 0 && routes.length === 0) return { ok: false as const, error: 'candidate inputs could not be mapped onto the source recipe graph', routes }
  return { ok: true as const, routes }
}

function actor_inventory_counts(actor: ControlledActor) {
  const inventory = actor.get_main_inventory()
  if (!inventory) return undefined
  const result: Record<string, number> = {}
  for (const item of inventory.get_contents()) result[item.name] = (result[item.name] ?? 0) + item.count
  return result
}

function missing_input_reason(actor: ControlledActor, routes: VerificationInputRoute[]) {
  const counts = actor_inventory_counts(actor)
  if (!counts) return 'controlled actor inventory is unavailable'
  const required: Record<string, number> = {}
  for (const route of routes) required[route.item_name] = (required[route.item_name] ?? 0) + route.count
  for (const item_name in required) {
    if ((counts[item_name] ?? 0) < required[item_name]) return `requires ${required[item_name]} ${item_name} for bounded verification but actor has ${counts[item_name] ?? 0}`
  }
  return undefined
}

function operations_status() {
  return remote.call('autorio_operations', 'status') as any
}

function operation_result(method: string, ...args: any[]) {
  const result = remote.call('autorio_operations', method, ...args) as any
  if (Array.isArray(result)) return { ok: result[0] === true, message: String(result[1] ?? '') }
  return { ok: result === true, message: result === true ? 'accepted' : 'operation rejected' }
}

interface ActiveOperationBatchIdentity {
  batch_id: number
  batch_generation: number
  batch_ref: string
}

function active_batch_identity(): ActiveOperationBatchIdentity | undefined {
  const status = operations_status()
  const batch = status?.active_batch
  if (typeof batch?.batch_id !== 'number'
    || typeof batch?.batch_generation !== 'number'
    || typeof batch?.batch_ref !== 'string'
    || batch.batch_ref.length === 0) return undefined
  return {
    batch_id: batch.batch_id,
    batch_generation: batch.batch_generation,
    batch_ref: batch.batch_ref,
  }
}

function batch_receipt_matches(receipt: any, run: SkillVerificationRun) {
  return receipt
    && receipt.batch_id === run.active_batch_id
    && receipt.batch_generation === run.active_batch_generation
    && receipt.batch_ref === run.active_batch_ref
}

function batch_state(run: SkillVerificationRun) {
  if (run.active_batch_id === undefined) {
    return { state: 'missing' as const, reason: 'verification run has no submitted operation batch identity; explicit retry required' }
  }
  if (run.active_batch_generation === undefined || typeof run.active_batch_ref !== 'string' || run.active_batch_ref.length === 0) {
    return { state: 'legacy' as const, reason: `legacy pending batch ${run.active_batch_id} has no restart-safe identity; explicit retry required` }
  }

  const status = operations_status()
  if (typeof status?.batch_generation !== 'number') {
    return { state: 'missing' as const, reason: `runtime did not expose a batch generation for ${run.active_batch_ref}; explicit retry required` }
  }
  if (status.batch_generation !== run.active_batch_generation) {
    return {
      state: 'stale' as const,
      reason: `execution identity was interrupted by runtime reload: expected generation ${run.active_batch_generation}, current generation ${status.batch_generation}; explicit retry required`,
    }
  }
  if (batch_receipt_matches(status?.last_cancelled_batch, run)) return { state: 'cancelled' as const }
  if (batch_receipt_matches(status?.last_completed_batch, run)) return { state: 'completed' as const }
  if (batch_receipt_matches(status?.active_batch, run)) return { state: 'pending' as const }
  return {
    state: 'missing' as const,
    reason: `operation batch ${run.active_batch_ref} is no longer active and has no matching completion/cancellation receipt; explicit retry required`,
  }
}

function batch_identity_patch(batch: ActiveOperationBatchIdentity) {
  return {
    active_batch_id: batch.batch_id,
    active_batch_generation: batch.batch_generation,
    active_batch_ref: batch.batch_ref,
  }
}

function clear_batch_identity() {
  return {
    active_batch_id: undefined,
    active_batch_generation: undefined,
    active_batch_ref: undefined,
  }
}

function resolve_built_entities(actor: ControlledActor, run: SkillVerificationRun, template: SkillInstanceTemplate) {
  const result: VerificationBuiltEntity[] = []
  for (let index = 0; index < run.placements.length; index++) {
    const placement = run.placements[index]
    const template_entity = template.entities[index]
    const matches = actor.surface.find_entities_filtered({ position: { x: placement.x, y: placement.y }, radius: POSITION_EPSILON, name: placement.entity_name })
    let unit_number: number | undefined
    for (const entity of matches) {
      if (!entity.valid) continue
      if (entity.force?.index !== undefined && entity.force.index !== actor.force.index) continue
      if (entity.unit_number !== undefined) {
        unit_number = entity.unit_number as number
        break
      }
    }
    if (unit_number === undefined) return { ok: false as const, error: `rebuilt entity is missing at ${placement.entity_name}@${placement.x},${placement.y}`, entities: [] as VerificationBuiltEntity[] }
    result.push({ template_id: template_entity.template_id, unit_number })
  }
  return { ok: true as const, entities: result }
}

function unit_for(run: SkillVerificationRun, template_id: string) {
  for (const entity of run.built_entities) if (entity.template_id === template_id) return entity.unit_number
  return undefined
}

function power_block_reason(run: SkillVerificationRun, template: SkillInstanceTemplate) {
  for (const template_entity of template.entities) {
    if (!template_entity.requires_power) continue
    const unit_number = unit_for(run, template_entity.template_id)
    if (unit_number === undefined) return `rebuilt powered entity ${template_entity.entity_name} has no stable unit number`
    const entity: any = game.get_entity_by_unit_number(unit_number as any)
    if (!entity || !entity.valid) return `rebuilt powered entity ${template_entity.entity_name} disappeared`
    if (entity.electric_network_id === undefined) return `rebuilt ${template_entity.entity_name} is not connected to electric power in the verification area`
  }
  return undefined
}

function queue_configuration(run: SkillVerificationRun, template: SkillInstanceTemplate) {
  let queued = 0
  for (const template_entity of template.entities) {
    if (!template_entity.recipe) continue
    if (template_entity.entity_type !== 'assembling-machine' && template_entity.entity_type !== 'rocket-silo') continue
    const unit_number = unit_for(run, template_entity.template_id)
    if (unit_number === undefined) return { ok: false as const, error: `missing rebuilt unit for ${template_entity.template_id}` }
    const result = operation_result('set_machine_recipe', unit_number, template_entity.recipe.name)
    if (!result.ok) {
      if (queued > 0) operation_result('cancel_all_tasks')
      return { ok: false as const, error: `recipe configuration rejected for ${template_entity.entity_name}: ${result.message}` }
    }
    queued++
  }
  return { ok: true as const, queued, batch: queued > 0 ? active_batch_identity() : undefined }
}

function queue_inputs(run: SkillVerificationRun) {
  let queued = 0
  for (const route of run.input_routes) {
    const unit_number = unit_for(run, route.template_id)
    if (unit_number === undefined) return { ok: false as const, error: `input target disappeared for ${route.item_name}` }
    const result = operation_result('move_items_exact', route.item_name, unit_number, route.count, true)
    if (!result.ok) {
      if (queued > 0) operation_result('cancel_all_tasks')
      return { ok: false as const, error: `input provisioning rejected for ${route.item_name}: ${result.message}` }
    }
    queued++
  }
  return { ok: true as const, queued, batch: queued > 0 ? active_batch_identity() : undefined }
}

function add_contents(total: Record<string, number>, contents: any) {
  if (!contents) return
  for (const key in contents) {
    const value = contents[key]
    if (typeof value === 'number') total[key] = (total[key] ?? 0) + value
    else if (value && typeof value.name === 'string' && typeof value.count === 'number') total[value.name] = (total[value.name] ?? 0) + value.count
  }
}

function count_output_items(run: SkillVerificationRun, skill: SkillDefinition) {
  const wanted: Record<string, boolean> = {}
  for (const output of skill.outputs) wanted[output.item] = true
  const total: Record<string, number> = {}
  const inventory_defines: any = defines.inventory as any
  for (const rebuilt of run.built_entities) {
    const entity: any = game.get_entity_by_unit_number(rebuilt.unit_number as any)
    if (!entity || !entity.valid) continue
    if (typeof entity.get_inventory === 'function') {
      const ids = [inventory_defines.crafter_output, inventory_defines.furnace_result, inventory_defines.chest]
      for (const id of ids) {
        if (id === undefined) continue
        const inventory = entity.get_inventory(id)
        if (inventory?.valid !== false && inventory && typeof inventory.get_contents === 'function') add_contents(total, inventory.get_contents())
      }
    }
    if (typeof entity.get_max_transport_line_index === 'function' && typeof entity.get_transport_line === 'function') {
      const max_line = entity.get_max_transport_line_index()
      for (let line_index = 1; line_index <= max_line; line_index++) {
        const line = entity.get_transport_line(line_index)
        if (line?.valid && typeof line.get_contents === 'function') add_contents(total, line.get_contents())
      }
    }
    if (entity.held_stack?.valid_for_read && typeof entity.held_stack.name === 'string' && typeof entity.held_stack.count === 'number') {
      total[entity.held_stack.name] = (total[entity.held_stack.name] ?? 0) + entity.held_stack.count
    }
  }
  const result: Record<string, number> = {}
  for (const item_name in wanted) result[item_name] = total[item_name] ?? 0
  return result
}

export function output_delta_satisfied(skill: SkillDefinition, baseline: Record<string, number>, current: Record<string, number>) {
  if (skill.outputs.length === 0) return false
  for (const output of skill.outputs) if ((current[output.item] ?? 0) <= (baseline[output.item] ?? 0)) return false
  return true
}

function expanded_area(bounds: FactoryAreaBounds) {
  return {
    left_top: { x: bounds.left_top.x - INSTANCE_AREA_PADDING, y: bounds.left_top.y - INSTANCE_AREA_PADDING },
    right_bottom: { x: bounds.right_bottom.x + INSTANCE_AREA_PADDING, y: bounds.right_bottom.y + INSTANCE_AREA_PADDING },
  }
}

export function evaluate_live_topology(skill: SkillDefinition, analysis_id: string) {
  const analysis = get_factory_area_analysis(analysis_id)
  if (!analysis) return { match: false, reason: 'live analysis is unavailable' }
  const expected = skill_novelty_key(skill)
  for (const block of analysis.blocks) {
    try {
      const observed = skill_candidate_definition_from_block(analysis.id, block.id, 1)
      if (skill_novelty_key(observed) === expected) return { match: true, block_id: block.id }
    }
    catch {
      // Ignore blocks that cannot be reconstructed as reusable skill candidates.
    }
  }
  return { match: false, reason: `no live block matched reusable topology across ${analysis.blocks.length} observed block(s)` }
}

function placement_evidence(run: SkillVerificationRun) {
  return `verification-run:${run.id}:translated-rebuild`
}

function topology_evidence(run: SkillVerificationRun) {
  return run.live_analysis_id ? `factory-analysis:${run.live_analysis_id}` : `verification-run:${run.id}:topology`
}

function output_evidence(run: SkillVerificationRun, item_name: string) {
  return `verification-run:${run.id}:output-delta:${item_name}:${run.baseline_output_counts[item_name] ?? 0}->${run.observed_output_counts[item_name] ?? 0}`
}

export function promote_verified_skill(run: SkillVerificationRun) {
  const skill = get_skill_definition(run.skill_id)
  if (!skill) throw new Error(`skill disappeared during verification: ${run.skill_id}`)
  if (skill.status !== 'candidate') throw new Error(`skill is not a candidate: ${run.skill_id}`)
  if (skill.revision !== run.skill_revision) throw new Error(`skill revision changed during verification: ${run.skill_id}`)
  if (run.topology_match !== true) throw new Error('live topology has not matched the candidate')
  if (!output_delta_satisfied(skill, run.baseline_output_counts, run.observed_output_counts)) throw new Error('required output delta has not been observed')

  const placement_ref = placement_evidence(run)
  const topology_ref = topology_evidence(run)
  const output_refs: string[] = []
  for (const output of skill.outputs) output_refs.push(output_evidence(run, output.item))
  const evidence_refs = unique_strings([...skill.source.evidence_refs, placement_ref, topology_ref, ...output_refs], 64)
  const constraints = skill.constraints.map(constraint => constraint.kind === 'placement'
    ? { ...constraint, validation: 'validated' as const, evidence_refs: unique_strings([...constraint.evidence_refs, placement_ref, topology_ref], 64) }
    : constraint)
  const confidence_basis = unique_strings([
    ...skill.confidence.basis,
    'Rebuilt a translated instance through normal NPC construction and re-observed matching live topology.',
    'Observed a positive bounded real output delta after providing only external candidate inputs.',
  ], 64)

  return put_skill_definition({
    ...skill,
    revision: skill.revision + 1,
    stage: 'verified_skill',
    status: 'verified',
    source: { ...skill.source, evidence_refs },
    constraints,
    verification: {
      ...skill.verification,
      structural: 'passed',
      recipe_flow: 'passed',
      placement_rebuild: 'passed',
      production_output: 'passed',
      belt_capacity: skill.verification.belt_capacity,
      inserter_sustained_throughput: skill.verification.inserter_sustained_throughput,
      acceptance_conditions: [
        { id: 'translated-rebuild', description: 'A translated instance was validated and built through the normal NPC construction path.', status: 'passed', evidence_refs: [placement_ref] },
        { id: 'live-topology', description: 'Live re-observation matched the reusable candidate topology and recipe flow.', status: 'passed', evidence_refs: [topology_ref] },
        { id: 'production-output-delta', description: 'Every declared output increased during the bounded live observation window.', status: 'passed', evidence_refs: output_refs },
      ],
    },
    confidence: { ...skill.confidence, basis: confidence_basis },
    examples: [
      ...skill.examples,
      { summary: `Verified translated rebuild ${run.id}.`, notes: 'Relative source geometry was used only as an initial layout seed; promotion depended on live topology and output evidence.' },
    ].slice(0, 64),
  })
}

export function finish_verified(run: SkillVerificationRun) {
  const promoted = promote_verified_skill(run)
  const refs = unique_strings([...run.evidence_refs, placement_evidence(run), topology_evidence(run), ...promoted.verification.acceptance_conditions.flatMap(condition => condition.evidence_refs)])
  const next = update_run(run, { state: 'verified', reason: `Verified ${promoted.id} revision ${promoted.revision}.`, evidence_refs: refs, completed_tick: game.tick })
  remove_queue_item(run.opportunity_id)
  update_learning_opportunity(run.opportunity_id, {
    state: 'verified',
    verification_run_id: run.id,
    evidence_refs: refs,
    reason: `Verified by translated rebuild, live topology match, and bounded output delta in ${run.id}.`,
  })
  storage.airi_skill_verification_active_run_id = undefined
  return next
}

function begin_supply(run: SkillVerificationRun, skill: SkillDefinition) {
  const baseline = count_output_items(run, skill)
  const supplied = queue_inputs(run)
  if (!supplied.ok) return fail_skill_verification_run(run, 'execution', supplied.error)
  if (supplied.queued === 0) {
    return begin_reobservation(update_run(run, { state: 'supplying', baseline_output_counts: baseline, ...clear_batch_identity() }), skill)
  }
  if (!supplied.batch) return block_run(run, 'queued input provisioning did not expose restart-safe operation identity; explicit retry required')
  return update_run(run, { state: 'supplying', baseline_output_counts: baseline, ...batch_identity_patch(supplied.batch), reason: `External candidate inputs queued through normal NPC item-transfer batch ${supplied.batch.batch_ref}.` })
}

function begin_reobservation(run: SkillVerificationRun, skill: SkillDefinition) {
  if (!run.instance_bounds || run.target_surface_index === undefined) return fail_skill_verification_run(run, 'execution', 'verification instance bounds are unavailable')
  const actor = get_controlled_actor_for_run(run)
  if (!actor) return fail_skill_verification_run(run, 'execution', 'controlled actor changed or became unavailable before live re-observation')
  const observed = analyze_factory_area(actor, { surface_index: run.target_surface_index, area: expanded_area(run.instance_bounds) })
  if (!observed.ok) return fail_skill_verification_run(run, 'execution', `live topology re-observation failed: ${observed.error}`)
  const topology = evaluate_live_topology(skill, observed.analysis_id)
  const refs = unique_strings([...run.evidence_refs, `factory-analysis:${observed.analysis_id}`])
  return update_run(run, {
    state: 'observing_output',
    live_analysis_id: observed.analysis_id,
    topology_match: topology.match,
    output_deadline_tick: game.tick + OUTPUT_OBSERVATION_TICKS,
    ...clear_batch_identity(),
    evidence_refs: refs,
    reason: topology.match ? 'Live topology matched; observing bounded real output delta.' : `${topology.reason}; observing output window to classify semantic failure.`,
  })
}

let verification_actor_getter: (() => ControlledActor | undefined) | undefined

function get_controlled_actor_for_run(_run: SkillVerificationRun) {
  const status = remote.call('autorio_operations', 'status') as any
  const actor_id = status?.actor?.actor_id
  if (actor_id === undefined) return undefined
  return verification_actor_getter?.()
}

function process_run_tick(run: SkillVerificationRun) {
  const skill = get_skill_definition(run.skill_id)
  if (!skill) return fail_skill_verification_run(run, 'execution', 'candidate skill disappeared during verification')
  if (skill.status !== 'candidate' || skill.revision !== run.skill_revision) return fail_skill_verification_run(run, 'execution', 'candidate skill changed during verification')
  const template = template_for_skill(skill)
  if (!template) return block_run(run, 'source example is no longer available to seed a translated verification instance')

  if (run.state === 'constructing') {
    const batch = batch_state(run)
    if (batch.state === 'pending') return run
    if (batch.state === 'cancelled') return fail_skill_verification_run(run, 'execution', 'normal NPC construction batch did not complete')
    if (batch.state !== 'completed') return block_run(run, batch.reason)
    const actor = verification_actor_getter?.()
    if (!actor || !actor.is_valid || actor.surface.index !== run.target_surface_index) return fail_skill_verification_run(run, 'execution', 'controlled actor changed surface or became unavailable after construction')
    const resolved = resolve_built_entities(actor, run, template)
    if (!resolved.ok) return fail_skill_verification_run(run, 'execution', resolved.error)
    const next = update_run(run, { built_entities: resolved.entities, ...clear_batch_identity() })
    const power_reason = power_block_reason(next, template)
    if (power_reason) return block_run(next, power_reason)
    const configured = queue_configuration(next, template)
    if (!configured.ok) return fail_skill_verification_run(next, 'execution', configured.error)
    if (configured.queued === 0) return begin_supply(update_run(next, { state: 'configuring', ...clear_batch_identity() }), skill)
    if (!configured.batch) return block_run(next, 'queued recipe configuration did not expose restart-safe operation identity; explicit retry required')
    return update_run(next, { state: 'configuring', ...batch_identity_patch(configured.batch), reason: `Machine recipes queued through normal NPC batch ${configured.batch.batch_ref}.` })
  }

  if (run.state === 'configuring') {
    const batch = batch_state(run)
    if (batch.state === 'pending') return run
    if (batch.state === 'cancelled') return fail_skill_verification_run(run, 'execution', 'machine recipe configuration batch did not complete')
    if (batch.state !== 'completed') return block_run(run, batch.reason)
    return begin_supply(update_run(run, { ...clear_batch_identity() }), skill)
  }

  if (run.state === 'supplying') {
    if (run.active_batch_id !== undefined) {
      const batch = batch_state(run)
      if (batch.state === 'pending') return run
      if (batch.state === 'cancelled') return fail_skill_verification_run(run, 'execution', 'external input provisioning batch did not complete')
      if (batch.state !== 'completed') return block_run(run, batch.reason)
    }
    return begin_reobservation(update_run(run, { ...clear_batch_identity() }), skill)
  }

  if (run.state === 'observing_output') {
    const current = count_output_items(run, skill)
    const next = update_run(run, { observed_output_counts: current })
    if (output_delta_satisfied(skill, run.baseline_output_counts, current)) {
      if (run.topology_match !== true) return fail_skill_verification_run(next, 'semantic', 'production output appeared, but the live topology did not match the reusable candidate authority', [topology_evidence(next)])
      return finish_verified(next)
    }
    if (run.output_deadline_tick !== undefined && game.tick >= run.output_deadline_tick) {
      const refs = [topology_evidence(run)]
      for (const output of skill.outputs) refs.push(output_evidence(next, output.item))
      const topology_note = run.topology_match === true ? 'live topology matched' : 'required intermediate/live topology did not match'
      return fail_skill_verification_run(next, 'semantic', `${topology_note}, and required output never increased during the bounded observation window`, refs)
    }
    return next
  }

  return run
}

function verification_position(value: any) {
  if (!value || typeof value !== 'object') return undefined
  if (typeof value.x !== 'number' || value.x !== value.x || typeof value.y !== 'number' || value.y !== value.y) return undefined
  return { x: value.x, y: value.y }
}

function create_run(item: LearningVerificationQueueItem, skill: SkillDefinition) {
  const run: SkillVerificationRun = {
    schema_version: 1,
    id: next_run_id(),
    opportunity_id: item.opportunity_id,
    skill_id: skill.id,
    skill_revision: skill.revision,
    state: 'validating',
    started_tick: game.tick,
    updated_tick: game.tick,
    placements: [],
    input_routes: [],
    built_entities: [],
    baseline_output_counts: {},
    observed_output_counts: {},
    evidence_refs: [],
    reason: 'Validating a translated candidate instance against the live world.',
  }
  store_run(run)
  storage.airi_skill_verification_active_run_id = run.id
  set_queue_state(item.opportunity_id, 'running', 'Verification run is active.')
  update_learning_opportunity(item.opportunity_id, { verification_run_id: run.id, reason: `Verification running: ${run.id}` })
  return run
}

export function start_next_skill_verification(get_actor: () => ControlledActor | undefined, request: any = {}) {
  if (active_run() !== undefined) return { ok: false as const, error: 'another skill verification run is already active', run: active_run() }
  verification_actor_getter = get_actor
  const requested_opportunity = typeof request?.opportunity_id === 'string' ? request.opportunity_id : undefined
  let item: LearningVerificationQueueItem | undefined
  for (const candidate of queue_records()) {
    if (candidate.state !== 'queued') continue
    if (requested_opportunity !== undefined && candidate.opportunity_id !== requested_opportunity) continue
    item = candidate
    break
  }
  if (!item) return { ok: false as const, error: requested_opportunity ? 'requested verification is not queued' : 'verification queue has no runnable item' }
  const skill = get_skill_definition(item.skill_id)
  if (!skill || skill.status !== 'candidate') return { ok: false as const, error: `queued skill is not an executable candidate: ${item.skill_id}` }
  const run = create_run(item, skill)
  const actor = get_actor()
  if (!actor || !actor.is_valid || !actor.character) return { ok: false as const, run: block_run(run, 'controlled actor is unavailable') }
  const template = template_for_skill(skill)
  if (!template) return { ok: false as const, run: block_run(run, 'source example is unavailable; cannot seed a translated instance without guessing') }
  const input_plan = build_input_plan(skill, template)
  if (!input_plan.ok) return { ok: false as const, run: block_run(run, input_plan.error) }
  const missing_input = missing_input_reason(actor, input_plan.routes)
  if (missing_input) return { ok: false as const, run: block_run(run, missing_input) }

  const requested_position = verification_position(request?.position)
  let selected: { validation: any, origin: { x: number, y: number }, placements: ConstructionExecutionPlacement[], bounds: FactoryAreaBounds } | undefined
  let last_error = 'no translated placement candidate was evaluated'
  for (const origin of candidate_origins(actor, template, requested_position)) {
    const instance = instantiate_skill_template(template, origin)
    if (actor.surface.index === template.source_surface_index && areas_overlap(template.source_bounds, instance.bounds)) {
      last_error = 'candidate translation overlaps the source example; verification requires a different area'
      continue
    }
    const validation: any = validate_construction_execution_plan(actor, { plan_id: `${run.id}:${skill.id}`, placements: instance.placements })
    if (!validation.ok) {
      last_error = `${validation.error?.code ?? 'VALIDATION_FAILED'}: ${validation.error?.message ?? 'translated instance is not currently buildable'}`
      continue
    }
    selected = { validation, origin, placements: instance.placements, bounds: instance.bounds }
    break
  }
  if (!selected) return { ok: false as const, run: block_run(run, `no different-area translated instance passed live validation: ${last_error}`) }

  let next = update_run(run, {
    state: 'constructing',
    target_surface_index: actor.surface.index,
    target_origin: selected.origin,
    instance_bounds: selected.bounds,
    placements: selected.placements,
    input_routes: input_plan.routes,
    evidence_refs: unique_strings([`verification-run:${run.id}:validation:${selected.validation.validation_id}`]),
    reason: 'Translated instance validated; submitting normal NPC construction batch.',
  })
  const executed = operation_result('execute_construction_plan', selected.validation.validation_id, selected.validation.placement_count)
  if (!executed.ok) return { ok: false as const, run: fail_skill_verification_run(next, 'execution', `validated construction was rejected: ${executed.message}`) }
  const batch = active_batch_identity()
  if (!batch) {
    operation_result('cancel_all_tasks')
    return { ok: false as const, run: block_run(next, 'validated construction did not expose restart-safe operation identity; explicit retry required') }
  }
  next = update_run(next, { ...batch_identity_patch(batch), reason: `Normal NPC construction batch ${batch.batch_ref} is running.` })
  return { ok: true as const, run: next }
}

export function retry_blocked_skill_verification(opportunity_id: string) {
  const item = queue_item(opportunity_id)
  if (!item) return { ok: false as const, error: 'verification queue item is unavailable' }
  if (item.state !== 'blocked') return { ok: false as const, error: 'verification queue item is not blocked' }
  item.state = 'queued'
  item.reason = 'Blocked verification was explicitly re-queued.'
  update_learning_opportunity(opportunity_id, { state: 'awaiting_verification', reason: 'Verification re-queued after a blocked precondition/environment condition.' })
  return { ok: true as const }
}

export function list_skill_verification_runs(limit = MAX_RUN_HISTORY) {
  const registry = storage.airi_skill_verification_runs ?? {}
  const order = storage.airi_skill_verification_run_order ?? []
  const result: SkillVerificationRun[] = []
  for (let index = order.length - 1; index >= 0 && result.length < limit; index--) {
    const run = registry[order[index]]
    if (run !== undefined) result.push(run)
  }
  return result
}

export function tick_skill_verification() {
  const run = active_run()
  if (!run) return
  try {
    process_run_tick(run)
  }
  catch (error) {
    fail_skill_verification_run(run, 'execution', error instanceof Error ? error.message : 'unexpected verifier runtime error')
  }
}

export function register_skill_verification_runtime(get_actor: () => ControlledActor | undefined) {
  verification_actor_getter = get_actor
  if (runtime_registered) return
  runtime_registered = true
  script.on_nth_tick(RUNTIME_TICK_INTERVAL, () => tick_skill_verification())
}

export function maybe_start_autonomous_bounded_verification(get_actor: () => ControlledActor | undefined) {
  if (get_learning_policy() !== 'autonomous_bounded' || active_run() !== undefined) return undefined
  for (const item of list_learning_verification_queue()) {
    if (item.state !== 'queued') continue
    if (item.risk !== 'safe') continue
    return start_next_skill_verification(get_actor, { opportunity_id: item.opportunity_id })
  }
  return undefined
}
