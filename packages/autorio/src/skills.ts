import type { LuaForce, LuaGuiElement, LuaPlayer } from 'factorio:runtime'
import { BASIC_SKILL_DEFINITIONS } from './basic_skill_library'
import { get_controlled_actor, peek_controlled_actor } from './actors/actor_controller'
import {
  analyze_factory_area,
  latest_factory_area_analysis,
  list_analyzed_blocks,
  skill_candidate_definition_from_block,
} from './factory_area_learning'
import { crafting_categories_support_recipe } from './recipe_categories'
import {
  canonicalize_skill_constraint_predicate,
  skill_constraint_predicate_signature,
} from './skill_constraint_predicates'
import type { SkillConstraintPredicate } from './skill_constraint_predicates'

export type { SkillConstraintPredicate } from './skill_constraint_predicates'

export const SKILL_SCHEMA_VERSION = 1
export const MAX_DYNAMIC_SKILL_DEFINITIONS = 256

export type SkillKind = 'production' | 'logistics' | 'construction' | 'utility' | 'custom'
export type SkillStatus = 'observed' | 'candidate' | 'verified' | 'deprecated'
export type SkillStage = 'example' | 'pattern' | 'executable_candidate' | 'verified_skill'
export type SkillVerificationState = 'passed' | 'failed' | 'not_tested' | 'unvalidated'

export interface SkillFlow {
  item: string
  amount?: number
  role?: string
}

export interface SkillPrecondition {
  kind: 'item_available' | 'technology_researched' | 'entity_available' | 'bootstrap' | 'custom'
  subject: string
  description: string
  minimum?: number
}

export interface SkillTopologyNode {
  id: string
  role: string
  entity_name?: string
  recipe?: string
}

export interface SkillTopologyRelation {
  kind: 'item_transfer' | 'belt_input' | 'belt_output' | 'direct_item_output' | 'fluid_connection' | 'adjacent' | 'custom'
  from?: string
  to?: string
  via?: string
  description?: string
}

export interface SkillConstraint {
  kind: 'placement' | 'capacity' | 'resource' | 'safety' | 'custom'
  description: string
  validation: 'validated' | 'unvalidated' | 'not_applicable'
  evidence_refs: string[]
  predicate?: SkillConstraintPredicate
}

export interface SkillParameter {
  name: string
  description: string
  required: boolean
  default_value?: string | number | boolean
}

export interface SkillAcceptanceCondition {
  id: string
  description: string
  status: SkillVerificationState
  evidence_refs: string[]
}

export interface SkillVerification {
  structural: SkillVerificationState
  recipe_flow: SkillVerificationState
  placement_rebuild: SkillVerificationState
  production_output: SkillVerificationState
  belt_capacity: SkillVerificationState
  inserter_sustained_throughput: SkillVerificationState
  acceptance_conditions: SkillAcceptanceCondition[]
}

export interface SkillArea {
  surface_index: number
  left_top: { x: number, y: number }
  right_bottom: { x: number, y: number }
}

export interface SkillSource {
  kind: 'observed_factory' | 'completed_goal' | 'experiment' | 'manual'
  goal_id?: string
  observed_tick?: number
  area?: SkillArea
  entity_unit_numbers: number[]
  recipe_ids: string[]
  evidence_refs: string[]
}

export interface SkillExample {
  summary: string
  notes?: string
}

export interface SkillDefinition {
  schema_version: 1
  revision: number
  id: string
  name: string
  kind: SkillKind
  stage: SkillStage
  status: SkillStatus
  summary: string
  source: SkillSource
  preconditions: SkillPrecondition[]
  inputs: SkillFlow[]
  outputs: SkillFlow[]
  topology: {
    nodes: SkillTopologyNode[]
    relations: SkillTopologyRelation[]
  }
  constraints: SkillConstraint[]
  parameters: SkillParameter[]
  verification: SkillVerification
  known_failure_modes: string[]
  confidence: {
    level: 'low' | 'medium' | 'high'
    basis: string[]
  }
  examples: SkillExample[]
  // Hand-set search tags for goals that the derived tags (outputs, topology
  // entities and recipes, technology preconditions) cannot reach, e.g. power,
  // smelting, science. Kept short; omitted when empty so older records keep
  // their canonical JSON.
  goal_tags?: string[]
}

export interface SkillUiSummary {
  id: string
  name: string
  revision: number
  status: SkillStatus
  stage: SkillStage
  source: SkillSource['kind']
  inputs: string[]
  outputs: string[]
  verification: string
  warnings: string[]
}

interface SkillExportRecord {
  schema_version: 1
  id: string
  revision: number
  canonical_json: string
  relative_path: string
  exported_tick: number
}

declare const storage: {
  sgluna_skill_definitions?: Record<string, SkillDefinition>
  sgluna_skill_exports?: Record<string, SkillExportRecord>
}

const MAX_TEXT = 1000
const MAX_LIST = 64
const MAX_TOPOLOGY_NODES = 128
const MAX_TOPOLOGY_RELATIONS = 256
const SAFE_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'
const SKILL_EXPORT_BUTTON_PREFIX = 'sgluna_skill_export__'
const FACTORY_ANALYZE_BUTTON_NAME = 'sgluna_skill_learn_area'
const FACTORY_SAVE_BUTTON_PREFIX = 'sgluna_skill_save_block__'
const FACTORY_DEFAULT_RADIUS = 12
const SKILL_SECTION_PADDING = 10
const MAX_UI_SKILLS = 6
const MAX_UI_BLOCKS = 4

function plain_object(value: any) {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clean_text(value: unknown, label: string, max = MAX_TEXT, required = true) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return ''
    throw new Error(`${label} must be a string`)
  }
  let result = value.split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (result.includes('  ')) result = result.split('  ').join(' ')
  if (required && result.length === 0) throw new Error(`${label} must not be empty`)
  if (result.length > max) throw new Error(`${label} exceeds ${max} characters`)
  return result
}

function optional_text(value: unknown, label: string, max = MAX_TEXT) {
  const result = clean_text(value, label, max, false)
  return result.length > 0 ? result : undefined
}

function positive_integer(value: unknown, label: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || value < 1 || value % 1 !== 0) throw new Error(`${label} must be a positive integer`)
  return value
}

function non_negative_integer(value: unknown, label: string) {
  if (typeof value !== 'number' || value < 0 || value % 1 !== 0) throw new Error(`${label} must be a non-negative integer`)
  return value
}

function finite_number(value: unknown, label: string) {
  if (typeof value !== 'number' || value !== value || value === Infinity || value === -Infinity) throw new Error(`${label} must be a finite number`)
  return value
}

export function assert_safe_skill_id(value: unknown): string {
  const id = clean_text(value, 'skill id', 80)
  if (id[0] === '-' || id[id.length - 1] === '-') throw new Error('skill id must not start or end with a hyphen')
  for (const character of id.split('')) {
    if (!SAFE_ID_CHARS.includes(character)) throw new Error('skill id must use lowercase a-z, 0-9, and hyphen only')
  }
  return id
}

function enum_value<T extends string>(value: unknown, allowed: readonly T[], label: string, fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback
  for (const candidate of allowed) if (value === candidate) return candidate
  throw new Error(`${label} is invalid`)
}

function string_list(value: unknown, label: string, max = MAX_LIST) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > max) throw new Error(`${label} exceeds ${max} entries`)
  const result: string[] = []
  for (let index = 0; index < value.length; index++) result.push(clean_text(value[index], `${label}[${index}]`, 300))
  return result
}

function unit_number_list(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error('source.entity_unit_numbers must be a bounded array')
  const result: number[] = []
  for (let index = 0; index < value.length; index++) result.push(positive_integer(value[index], `source.entity_unit_numbers[${index}]`))
  return result
}

function source_area(value: any): SkillArea | undefined {
  if (value === undefined) return undefined
  if (!plain_object(value) || !plain_object(value.left_top) || !plain_object(value.right_bottom)) throw new Error('source.area is invalid')
  return {
    surface_index: positive_integer(value.surface_index, 'source.area.surface_index'),
    left_top: {
      x: finite_number(value.left_top.x, 'source.area.left_top.x'),
      y: finite_number(value.left_top.y, 'source.area.left_top.y'),
    },
    right_bottom: {
      x: finite_number(value.right_bottom.x, 'source.area.right_bottom.x'),
      y: finite_number(value.right_bottom.y, 'source.area.right_bottom.y'),
    },
  }
}

function canonical_source(value: any): SkillSource {
  const raw = plain_object(value) ? value : {}
  const source: SkillSource = {
    kind: enum_value(raw.kind, ['observed_factory', 'completed_goal', 'experiment', 'manual'] as const, 'source.kind', 'manual'),
    entity_unit_numbers: unit_number_list(raw.entity_unit_numbers),
    recipe_ids: string_list(raw.recipe_ids, 'source.recipe_ids'),
    evidence_refs: string_list(raw.evidence_refs, 'source.evidence_refs'),
  }
  const goal_id = optional_text(raw.goal_id, 'source.goal_id', 120)
  const area = source_area(raw.area)
  if (goal_id !== undefined) source.goal_id = goal_id
  if (raw.observed_tick !== undefined) source.observed_tick = non_negative_integer(raw.observed_tick, 'source.observed_tick')
  if (area !== undefined) source.area = area
  return source
}

function canonical_flows(value: unknown, label: string): SkillFlow[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error(`${label} must be a bounded array`)
  const result: SkillFlow[] = []
  for (let index = 0; index < value.length; index++) {
    const raw: any = value[index]
    const flow: SkillFlow = typeof raw === 'string'
      ? { item: clean_text(raw, `${label}[${index}]`, 200) }
      : { item: clean_text(raw?.item ?? raw?.name, `${label}[${index}].item`, 200) }
    if (typeof raw !== 'string') {
      if (raw?.amount !== undefined) flow.amount = finite_number(raw.amount, `${label}[${index}].amount`)
      const role = optional_text(raw?.role, `${label}[${index}].role`, 200)
      if (role !== undefined) flow.role = role
    }
    result.push(flow)
  }
  return result
}

function canonical_preconditions(value: unknown): SkillPrecondition[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error('preconditions must be a bounded array')
  const result: SkillPrecondition[] = []
  for (let index = 0; index < value.length; index++) {
    const raw: any = value[index]
    if (!plain_object(raw)) throw new Error(`preconditions[${index}] must be an object`)
    const condition: SkillPrecondition = {
      kind: enum_value(raw.kind, ['item_available', 'technology_researched', 'entity_available', 'bootstrap', 'custom'] as const, `preconditions[${index}].kind`, 'custom'),
      subject: clean_text(raw.subject, `preconditions[${index}].subject`, 200),
      description: clean_text(raw.description ?? raw.subject, `preconditions[${index}].description`, 500),
    }
    if (raw.minimum !== undefined) condition.minimum = finite_number(raw.minimum, `preconditions[${index}].minimum`)
    result.push(condition)
  }
  return result
}

function canonical_topology(value: any): SkillDefinition['topology'] {
  const raw = plain_object(value) ? value : {}
  const raw_nodes = raw.nodes === undefined ? [] : raw.nodes
  const raw_relations = raw.relations === undefined ? [] : raw.relations
  if (!Array.isArray(raw_nodes) || raw_nodes.length > MAX_TOPOLOGY_NODES) throw new Error('topology.nodes must be a bounded array')
  if (!Array.isArray(raw_relations) || raw_relations.length > MAX_TOPOLOGY_RELATIONS) throw new Error('topology.relations must be a bounded array')
  const nodes: SkillTopologyNode[] = []
  for (let index = 0; index < raw_nodes.length; index++) {
    const node = raw_nodes[index]
    if (!plain_object(node)) throw new Error(`topology.nodes[${index}] must be an object`)
    const next: SkillTopologyNode = {
      id: clean_text(node.id, `topology.nodes[${index}].id`, 120),
      role: clean_text(node.role ?? node.id, `topology.nodes[${index}].role`, 300),
    }
    const entity_name = optional_text(node.entity_name, `topology.nodes[${index}].entity_name`, 200)
    const recipe = optional_text(node.recipe, `topology.nodes[${index}].recipe`, 200)
    if (entity_name !== undefined) next.entity_name = entity_name
    if (recipe !== undefined) next.recipe = recipe
    nodes.push(next)
  }
  const relations: SkillTopologyRelation[] = []
  for (let index = 0; index < raw_relations.length; index++) {
    const relation = raw_relations[index]
    if (!plain_object(relation)) throw new Error(`topology.relations[${index}] must be an object`)
    const next: SkillTopologyRelation = {
      kind: enum_value(relation.kind, ['item_transfer', 'belt_input', 'belt_output', 'direct_item_output', 'fluid_connection', 'adjacent', 'custom'] as const, `topology.relations[${index}].kind`, 'custom'),
    }
    const from = optional_text(relation.from, `topology.relations[${index}].from`, 120)
    const to = optional_text(relation.to, `topology.relations[${index}].to`, 120)
    const via = optional_text(relation.via, `topology.relations[${index}].via`, 120)
    const description = optional_text(relation.description, `topology.relations[${index}].description`, 500)
    if (from !== undefined) next.from = from
    if (to !== undefined) next.to = to
    if (via !== undefined) next.via = via
    if (description !== undefined) next.description = description
    relations.push(next)
  }
  return { nodes, relations }
}

function canonical_constraints(value: unknown): SkillConstraint[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error('constraints must be a bounded array')
  const result: SkillConstraint[] = []
  for (let index = 0; index < value.length; index++) {
    const raw: any = value[index]
    if (!plain_object(raw)) throw new Error(`constraints[${index}] must be an object`)
    const constraint: SkillConstraint = {
      kind: enum_value(raw.kind, ['placement', 'capacity', 'resource', 'safety', 'custom'] as const, `constraints[${index}].kind`, 'custom'),
      description: clean_text(raw.description, `constraints[${index}].description`, 500),
      validation: enum_value(raw.validation, ['validated', 'unvalidated', 'not_applicable'] as const, `constraints[${index}].validation`, 'unvalidated'),
      evidence_refs: string_list(raw.evidence_refs, `constraints[${index}].evidence_refs`),
    }
    if (raw.predicate !== undefined) constraint.predicate = canonicalize_skill_constraint_predicate(raw.predicate, `constraints[${index}].predicate`)
    result.push(constraint)
  }
  return result
}

function canonical_parameters(value: unknown): SkillParameter[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error('parameters must be a bounded array')
  const result: SkillParameter[] = []
  for (let index = 0; index < value.length; index++) {
    const raw: any = value[index]
    if (!plain_object(raw)) throw new Error(`parameters[${index}] must be an object`)
    const parameter: SkillParameter = {
      name: clean_text(raw.name, `parameters[${index}].name`, 120),
      description: clean_text(raw.description ?? raw.name, `parameters[${index}].description`, 500),
      required: raw.required !== false,
    }
    if (raw.default_value !== undefined) {
      if (typeof raw.default_value !== 'string' && typeof raw.default_value !== 'number' && typeof raw.default_value !== 'boolean') throw new Error(`parameters[${index}].default_value is invalid`)
      parameter.default_value = raw.default_value
    }
    result.push(parameter)
  }
  return result
}

function verification_state(value: unknown, label: string, fallback: SkillVerificationState): SkillVerificationState {
  return enum_value(value, ['passed', 'failed', 'not_tested', 'unvalidated'] as const, label, fallback)
}

function canonical_verification(value: any): SkillVerification {
  const raw = plain_object(value) ? value : {}
  const raw_acceptance = raw.acceptance_conditions === undefined ? [] : raw.acceptance_conditions
  if (!Array.isArray(raw_acceptance) || raw_acceptance.length > MAX_LIST) throw new Error('verification.acceptance_conditions must be a bounded array')
  const acceptance_conditions: SkillAcceptanceCondition[] = []
  for (let index = 0; index < raw_acceptance.length; index++) {
    const condition = raw_acceptance[index]
    if (!plain_object(condition)) throw new Error(`verification.acceptance_conditions[${index}] must be an object`)
    acceptance_conditions.push({
      id: clean_text(condition.id, `verification.acceptance_conditions[${index}].id`, 120),
      description: clean_text(condition.description, `verification.acceptance_conditions[${index}].description`, 500),
      status: verification_state(condition.status, `verification.acceptance_conditions[${index}].status`, 'not_tested'),
      evidence_refs: string_list(condition.evidence_refs, `verification.acceptance_conditions[${index}].evidence_refs`),
    })
  }
  return {
    structural: verification_state(raw.structural, 'verification.structural', 'not_tested'),
    recipe_flow: verification_state(raw.recipe_flow, 'verification.recipe_flow', 'not_tested'),
    placement_rebuild: verification_state(raw.placement_rebuild, 'verification.placement_rebuild', 'not_tested'),
    production_output: verification_state(raw.production_output, 'verification.production_output', 'not_tested'),
    belt_capacity: verification_state(raw.belt_capacity, 'verification.belt_capacity', 'not_tested'),
    inserter_sustained_throughput: verification_state(raw.inserter_sustained_throughput, 'verification.inserter_sustained_throughput', 'unvalidated'),
    acceptance_conditions,
  }
}

function canonical_examples(value: unknown): SkillExample[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error('examples must be a bounded array')
  const result: SkillExample[] = []
  for (let index = 0; index < value.length; index++) {
    const raw: any = value[index]
    if (!plain_object(raw)) throw new Error(`examples[${index}] must be an object`)
    const example: SkillExample = { summary: clean_text(raw.summary, `examples[${index}].summary`, 500) }
    const notes = optional_text(raw.notes, `examples[${index}].notes`, 1000)
    if (notes !== undefined) example.notes = notes
    result.push(example)
  }
  return result
}

export const MAX_GOAL_TAGS = 16

// Tags are lowercase words joined by hyphens ("steam-power"); spaces and
// underscores become hyphens. Non-ASCII tags (player shorthand such as 煤蛇)
// are kept as written.
export function normalize_skill_tag(value: string) {
  let tag = value.toLowerCase().trim()
  for (const separator of [' ', '_', '\t']) tag = tag.split(separator).join('-')
  while (tag.includes('--')) tag = tag.split('--').join('-')
  if (tag.startsWith('-')) tag = tag.slice(1)
  if (tag.endsWith('-')) tag = tag.slice(0, tag.length - 1)
  return tag
}

function canonical_goal_tags(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('goal_tags must be an array')
  if (value.length > MAX_GOAL_TAGS) throw new Error(`goal_tags exceeds ${MAX_GOAL_TAGS} entries`)
  const result: string[] = []
  for (let index = 0; index < value.length; index++) {
    const tag = normalize_skill_tag(clean_text(value[index], `goal_tags[${index}]`, 40))
    if (tag.length === 0) throw new Error(`goal_tags[${index}] must not be empty`)
    if (!result.includes(tag)) result.push(tag)
  }
  return result
}

function assert_verified_evidence(skill: SkillDefinition) {
  if (skill.status !== 'verified') return
  if (skill.stage !== 'verified_skill') throw new Error('verified status requires stage=verified_skill')
  if (skill.verification.acceptance_conditions.length === 0) throw new Error('verified skills require explicit acceptance conditions')
  for (const condition of skill.verification.acceptance_conditions) {
    if (condition.status !== 'passed') throw new Error(`verified skill acceptance condition ${condition.id} has not passed`)
    if (condition.evidence_refs.length === 0) throw new Error(`verified skill acceptance condition ${condition.id} lacks evidence`)
  }
}

export function canonicalize_skill_definition(value: any): SkillDefinition {
  if (!plain_object(value)) throw new Error('skill definition must be an object')
  if (value.schema_version !== undefined && value.schema_version !== SKILL_SCHEMA_VERSION) throw new Error(`unsupported skill schema_version: ${value.schema_version}`)
  const skill_status = enum_value(value.status, ['observed', 'candidate', 'verified', 'deprecated'] as const, 'status', 'candidate')
  const default_stage: SkillStage = skill_status === 'observed'
    ? 'example'
    : skill_status === 'verified'
      ? 'verified_skill'
      : 'executable_candidate'
  const stage = enum_value(value.stage, ['example', 'pattern', 'executable_candidate', 'verified_skill'] as const, 'stage', default_stage)
  if (stage === 'verified_skill' && skill_status !== 'verified' && skill_status !== 'deprecated') throw new Error('stage=verified_skill requires verified or deprecated status')

  const confidence_raw = plain_object(value.confidence) ? value.confidence : {}
  const skill: SkillDefinition = {
    schema_version: SKILL_SCHEMA_VERSION,
    revision: positive_integer(value.revision, 'revision', 1),
    id: assert_safe_skill_id(value.id),
    name: clean_text(value.name, 'name', 200),
    kind: enum_value(value.kind, ['production', 'logistics', 'construction', 'utility', 'custom'] as const, 'kind', 'custom'),
    stage,
    status: skill_status,
    summary: clean_text(value.summary, 'summary', 1000),
    source: canonical_source(value.source),
    preconditions: canonical_preconditions(value.preconditions),
    inputs: canonical_flows(value.inputs, 'inputs'),
    outputs: canonical_flows(value.outputs, 'outputs'),
    topology: canonical_topology(value.topology),
    constraints: canonical_constraints(value.constraints),
    parameters: canonical_parameters(value.parameters),
    verification: canonical_verification(value.verification),
    known_failure_modes: string_list(value.known_failure_modes, 'known_failure_modes'),
    confidence: {
      level: enum_value(confidence_raw.level, ['low', 'medium', 'high'] as const, 'confidence.level', 'low'),
      basis: string_list(confidence_raw.basis, 'confidence.basis'),
    },
    examples: canonical_examples(value.examples),
  }
  const goal_tags = canonical_goal_tags(value.goal_tags)
  if (goal_tags.length > 0) skill.goal_tags = goal_tags
  assert_verified_evidence(skill)
  return skill
}

// Read-only view. The console renders saved skills on every multiplayer peer,
// and lazily creating this table there would write synchronized game state on
// one peer only, which desyncs the game.
function definitions(): Record<string, SkillDefinition> {
  return storage.sgluna_skill_definitions ?? {}
}

function ensure_definitions() {
  if (storage.sgluna_skill_definitions === undefined) storage.sgluna_skill_definitions = {}
  return storage.sgluna_skill_definitions
}

function is_basic_skill_id(id: string) {
  for (const raw of BASIC_SKILL_DEFINITIONS) if (raw.id === id) return true
  return false
}

function dynamic_skill_definition_count(registry: Record<string, SkillDefinition>) {
  let count = 0
  for (const id in registry) if (!is_basic_skill_id(id)) count++
  return count
}

function store_dynamic_skill_definition(skill: SkillDefinition) {
  const registry = ensure_definitions()
  if (
    registry[skill.id] === undefined
    && !is_basic_skill_id(skill.id)
    && dynamic_skill_definition_count(registry) >= MAX_DYNAMIC_SKILL_DEFINITIONS
  ) {
    throw new Error(`skill registry dynamic capacity reached (${MAX_DYNAMIC_SKILL_DEFINITIONS}); archive or reuse an existing skill id before creating another definition`)
  }
  registry[skill.id] = skill
  return skill
}

// A stored copy of a curated skill that nobody edited: every evidence ref is
// still a curated ref. Player edits add a `player-edit:` ref and learned or
// player-authored skills carry their own refs, so those are never replaced.
function is_unedited_curated_copy(stored: SkillDefinition) {
  if (stored.source.kind !== 'manual' || stored.source.evidence_refs.length === 0) return false
  for (const ref of stored.source.evidence_refs) if (!ref.startsWith('curated:')) return false
  return true
}

export function ensure_basic_skill_definitions() {
  const registry = ensure_definitions()
  let added = 0
  let upgraded = 0
  for (const raw of BASIC_SKILL_DEFINITIONS) {
    const skill = canonicalize_skill_definition(raw)
    const stored = registry[skill.id]
    if (stored === undefined) {
      registry[skill.id] = skill
      added++
    }
    else if (stored.revision < skill.revision && is_unedited_curated_copy(stored)) {
      registry[skill.id] = skill
      upgraded++
    }
  }
  return { added, upgraded, total: BASIC_SKILL_DEFINITIONS.length }
}

function skill_search_text(skill: SkillDefinition) {
  const values: string[] = [
    skill.id,
    skill.name,
    skill.kind,
    skill.stage,
    skill.status,
    skill.summary,
    ...skill.preconditions.map(value => `${value.subject} ${value.description}`),
    ...skill.inputs.map(value => `${value.item} ${value.role ?? ''}`),
    ...skill.outputs.map(value => `${value.item} ${value.role ?? ''}`),
    ...skill.topology.nodes.map(value => `${value.id} ${value.role} ${value.entity_name ?? ''} ${value.recipe ?? ''}`),
    ...skill.topology.relations.map(value => `${value.kind} ${value.description ?? ''}`),
    ...skill.constraints.map(value => value.description),
    ...skill.parameters.map(value => `${value.name} ${value.description}`),
    ...skill.known_failure_modes,
    ...skill.examples.map(value => `${value.summary} ${value.notes ?? ''}`),
    ...(skill.goal_tags ?? []),
  ]
  return values.join(' ').toLowerCase()
}

// ---------------------------------------------------------------------------
// Skill lookup (plan item 2.8): tags, goal scoring, preconditions, cards.
//
// Tags come mostly from fields a skill already has: output items, topology
// entities and recipes, and technologies named by preconditions. `goal_tags`
// covers only what derivation cannot (power, smelting, science). A goal is
// matched against tags first; the old full-text match stays as a weak signal
// so learned skills without tags are still found. Preconditions are checked
// against live world state (research, items held) and reported, never used as
// a gate. The same bounded card goes to the Main LLM's planning context and to
// Jev's candidate choice.
//
// Seam for plan item 2.8 (e): a meaning-based scorer (local embedding model)
// would add a relevance term in `score_skill_for_goal`; keyword scoring below
// always stays the fallback, since a Pterodactyl deployment has no LM Studio.
// ---------------------------------------------------------------------------

export type SkillTagSource = 'goal' | 'output' | 'entity' | 'recipe' | 'technology'
export interface SkillTag { tag: string, source: SkillTagSource }

const TAG_WEIGHTS: Record<SkillTagSource, number> = { goal: 4, output: 4, entity: 3, recipe: 3, technology: 3 }
const TEXT_TERM_WEIGHT = 1
const MAX_TEXT_TERM_HITS = 3
const WHOLE_QUERY_TEXT_WEIGHT = 2
const VERIFIED_BONUS = 3
const OBSERVED_PENALTY = 1
const LOCKED_NEED_PENALTY = 0.25
const MAX_LOCKED_PENALTY = 1
export const MAX_SKILL_CARDS = 5
const CARD_SUMMARY_MAX = 160
const CARD_LIST_MAX = 5

const GOAL_SEPARATORS = [',', '.', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '/', '\\', '"', '\'', '_', '\t', '\n', '\r', '+', '&', '*', '=', '<', '>', '|', '`']
const GOAL_STOPWORDS = [
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'build', 'but', 'by', 'can', 'do', 'for', 'from', 'get', 'go', 'have', 'i', 'in', 'into', 'is', 'it', 'let', 'lets',
  'make', 'me', 'my', 'need', 'of', 'on', 'or', 'our', 'please', 'set', 'so', 'some', 'that', 'the', 'then', 'this', 'to', 'up', 'us', 'want', 'we', 'with', 'you', 'your',
]
const TAG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'

function is_ascii_tag(tag: string) {
  for (const character of tag.split('')) if (!TAG_CHARS.includes(character)) return false
  return true
}

export function derive_skill_tags(skill: SkillDefinition): SkillTag[] {
  const result: SkillTag[] = []
  const seen: Record<string, boolean> = {}
  const add = (value: string | undefined, source: SkillTagSource) => {
    if (value === undefined) return
    const tag = normalize_skill_tag(value)
    if (tag.length < 2 || seen[tag] === true) return
    seen[tag] = true
    result.push({ tag, source })
  }
  for (const tag of skill.goal_tags ?? []) add(tag, 'goal')
  for (const flow of skill.outputs) add(flow.item, 'output')
  for (const node of skill.topology.nodes) {
    add(node.entity_name, 'entity')
    add(node.recipe, 'recipe')
  }
  for (const condition of skill.preconditions) if (condition.kind === 'technology_researched') add(condition.subject, 'technology')
  return result
}

function singular(word: string) {
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, word.length - 1)
  return word
}

export interface GoalTerms {
  normalized: string
  terms: string[]
  words: string[]
}

// Words, singulars, hyphen parts, and two- and three-word phrases joined by
// hyphens ("red science packs" -> red-science, science-pack, red-science-pack).
export function goal_search_terms(text: string): GoalTerms {
  let normalized = text.toLowerCase()
  for (const separator of GOAL_SEPARATORS) normalized = normalized.split(separator).join(' ')
  while (normalized.includes('  ')) normalized = normalized.split('  ').join(' ')
  normalized = normalized.trim()
  const terms: string[] = []
  const add = (term: string) => {
    if (term.length >= 2 && !terms.includes(term)) terms.push(term)
  }
  const words: string[] = []
  for (const raw of normalized.split(' ')) {
    if (raw.length === 0 || GOAL_STOPWORDS.includes(raw)) continue
    add(raw)
    add(singular(raw))
    words.push(singular(raw))
    if (raw.includes('-')) for (const part of raw.split('-')) if (!GOAL_STOPWORDS.includes(part)) add(singular(part))
  }
  for (let index = 0; index < words.length; index++) {
    if (index + 1 < words.length) add(`${words[index]}-${words[index + 1]}`)
    if (index + 2 < words.length) add(`${words[index]}-${words[index + 1]}-${words[index + 2]}`)
  }
  return { normalized, terms, words }
}

// A tag matches when the goal names it exactly. A tag of three or more parts
// also matches (one point weaker) when the goal names two adjacent parts of it
// ("science packs" -> automation-science-pack). Non-ASCII tags match as
// substrings, since such player shorthand is not space-separated.
function tag_match_weight(tag: SkillTag, goal: GoalTerms) {
  const weight = TAG_WEIGHTS[tag.source]
  if (goal.terms.includes(tag.tag)) return weight
  if (!is_ascii_tag(tag.tag)) return goal.normalized.includes(tag.tag) ? weight : 0
  const parts = tag.tag.split('-')
  if (parts.length >= 3) {
    for (let index = 0; index + 1 < parts.length; index++) {
      if (goal.terms.includes(`${parts[index]}-${parts[index + 1]}`)) return weight - 1
    }
  }
  return 0
}

// Owner decision 2026-09-28: a need is one of
//   have      - in the actor's main inventory, or already placed by the force;
//   can_craft - its recipe is enabled for the force and the actor can hand-craft it;
//   locked    - its recipe (or the technology itself) is not researched yet; the
//               card names the technology that unlocks it;
//   unknown   - not something the game can check (e.g. "coal-resource"), or an
//               enabled recipe the actor cannot hand-craft (plates). Staged
//               building handles those, so they carry no extra state.
// Only locked lowers the score.
export type SkillNeedState = 'have' | 'can_craft' | 'locked' | 'unknown'
export interface SkillNeedCheck {
  state: SkillNeedState
  technology?: string
  via?: string
}

// Read-only world facts for need checks. Each answers undefined when the
// subject is not something the game knows, which reports the need as unknown.
export interface SkillWorldView {
  check_technology: (this: void, technology: string) => SkillNeedCheck | undefined
  check_item: (this: void, item: string, minimum: number) => SkillNeedCheck | undefined
  check_entity: (this: void, entity_or_type: string) => SkillNeedCheck | undefined
}

const UNKNOWN_NEED: SkillNeedCheck = { state: 'unknown' }

export function skill_precondition_check(condition: SkillPrecondition, world: SkillWorldView | undefined): SkillNeedCheck {
  if (world === undefined) return UNKNOWN_NEED
  let check: SkillNeedCheck | undefined
  if (condition.kind === 'technology_researched') check = world.check_technology(condition.subject)
  else if (condition.kind === 'item_available') check = world.check_item(condition.subject, condition.minimum ?? 1)
  else if (condition.kind === 'entity_available') check = world.check_entity(condition.subject)
  return check ?? UNKNOWN_NEED
}

export interface SkillCardNeed {
  subject: string
  state: SkillNeedState
  technology?: string
  via?: string
}

export interface SkillGoalMatch {
  skill: SkillDefinition
  score: number
  relevance: number
  tag_hits: number
  matched: string[]
  needs: SkillCardNeed[]
}

// A skill is offered only with at least one tag match, or a relevance of 2 or
// more from text (a single text word hit is not enough).
const MIN_TEXT_ONLY_RELEVANCE = 2

export function score_skill_for_goal(skill: SkillDefinition, goal: GoalTerms, world?: SkillWorldView): SkillGoalMatch {
  const matched: string[] = []
  let relevance = 0
  let tag_hits = 0
  for (const tag of derive_skill_tags(skill)) {
    const weight = tag_match_weight(tag, goal)
    if (weight <= 0) continue
    relevance += weight
    tag_hits++
    matched.push(tag.tag)
  }
  // Weak full-text signal for words no tag covered, so a learned skill with no
  // tags can still be found.
  const haystack = skill_search_text(skill)
  // Word-start matching, so "red" does not hit "required".
  let words_text = haystack
  for (const separator of GOAL_SEPARATORS) words_text = words_text.split(separator).join(' ')
  words_text = ` ${words_text.split('-').join(' ')}`
  let text_hits = 0
  for (const word of goal.words) {
    if (text_hits >= MAX_TEXT_TERM_HITS) break
    if (word.length < 3 || word.includes('-')) continue
    let covered = false
    for (const tag of matched) if (tag === word || tag.split('-').includes(word)) covered = true
    if (covered || !words_text.includes(` ${word}`)) continue
    text_hits++
    matched.push(`text:${word}`)
  }
  relevance += text_hits * TEXT_TERM_WEIGHT
  // Whole-query bonus for a phrase or non-ASCII shorthand; a single ASCII word
  // is already counted as a text hit above.
  const phrase = goal.normalized.includes(' ') || !is_ascii_tag(goal.normalized)
  if (phrase && goal.normalized.length >= 2 && haystack.includes(goal.normalized)) relevance += WHOLE_QUERY_TEXT_WEIGHT

  const needs: SkillCardNeed[] = []
  let locked = 0
  for (const condition of skill.preconditions) {
    let seen = false
    for (const need of needs) if (need.subject === condition.subject) seen = true
    if (seen) continue
    const check = skill_precondition_check(condition, world)
    const need: SkillCardNeed = { subject: condition.subject, state: check.state }
    if (check.technology !== undefined) need.technology = check.technology
    if (check.via !== undefined && check.via !== condition.subject) need.via = check.via
    if (check.state === 'locked') locked++
    needs.push(need)
  }
  let score = relevance
  if (relevance > 0) {
    if (skill.status === 'verified') score += VERIFIED_BONUS
    else if (skill.status === 'observed') score -= OBSERVED_PENALTY
    score -= Math.min(MAX_LOCKED_PENALTY, locked * LOCKED_NEED_PENALTY)
  }
  return { skill, score: Math.floor(score * 100 + 0.5) / 100, relevance, tag_hits, matched, needs }
}

function status_rank(status: SkillStatus) {
  return status === 'verified' ? 0 : status === 'candidate' ? 1 : status === 'observed' ? 2 : 3
}

export function rank_skills_for_goal(goal_text: string, world?: SkillWorldView, include_deprecated = false) {
  const goal = goal_search_terms(goal_text)
  const ranked: SkillGoalMatch[] = []
  for (const skill of list_skill_definitions()) {
    if (!include_deprecated && skill.status === 'deprecated') continue
    const match = score_skill_for_goal(skill, goal, world)
    if (match.tag_hits > 0 || match.relevance >= MIN_TEXT_ONLY_RELEVANCE) ranked.push(match)
  }
  ranked.sort((left, right) => right.score - left.score
    || status_rank(left.skill.status) - status_rank(right.skill.status)
    || (left.skill.name < right.skill.name ? -1 : left.skill.name > right.skill.name ? 1 : 0))
  return ranked
}

// In Lua a string's length and indexes count bytes, so a plain slice can cut a
// multi-byte UTF-8 character (Chinese goals) in half. Step back off UTF-8
// continuation bytes (0b10xxxxxx) before cutting. In JavaScript (unit tests)
// lengths count UTF-16 units and CJK units are never in that range, so the
// same code is a plain prefix there.
export function utf8_safe_prefix(value: string, max_bytes: number) {
  if (value.length <= max_bytes) return value
  let end = max_bytes
  while (end > 0) {
    const code = value.charCodeAt(end)
    if (code < 0x80 || code >= 0xC0) break
    end--
  }
  return value.slice(0, end)
}

function one_line_summary(summary: string) {
  const end = summary.indexOf('. ')
  const sentence = end >= 0 ? summary.slice(0, end + 1) : summary
  return sentence.length <= CARD_SUMMARY_MAX ? sentence : `${utf8_safe_prefix(sentence, CARD_SUMMARY_MAX - 3)}...`
}

// One compact card per skill. The runtime renders it the same way for the
// Main LLM's planning context and for Jev's candidate choice.
export interface SkillCard {
  id: string
  name: string
  status: SkillStatus
  summary: string
  produces: string[]
  needs: SkillCardNeed[]
  matched: string[]
  score: number
}

export function skill_card(match: SkillGoalMatch): SkillCard {
  return {
    id: match.skill.id,
    name: match.skill.name,
    status: match.skill.status,
    summary: one_line_summary(match.skill.summary),
    produces: match.skill.outputs.map(flow => flow.item).slice(0, CARD_LIST_MAX),
    needs: match.needs.slice(0, CARD_LIST_MAX),
    matched: match.matched.slice(0, CARD_LIST_MAX),
    score: match.score,
  }
}

const MAX_OFFER_GOAL_BYTES = 500
const MAX_FIND_QUERY_BYTES = 240
// Input bound before truncation; anything under it is cut to size, not refused.
const MAX_RAW_QUERY_CHARS = 8000

export function skill_cards_for_goal(goal_text: unknown, limit: unknown = MAX_SKILL_CARDS, world?: SkillWorldView) {
  const text = utf8_safe_prefix(clean_text(goal_text, 'skill offer goal', MAX_RAW_QUERY_CHARS), MAX_OFFER_GOAL_BYTES)
  const bounded_limit = positive_integer(limit, 'skill offer limit')
  if (bounded_limit > MAX_SKILL_CARDS) throw new Error(`skill offer limit must be at most ${MAX_SKILL_CARDS}`)
  return rank_skills_for_goal(text, world).slice(0, bounded_limit).map(skill_card)
}

export function find_skill_definitions(query: unknown, limit: unknown = 3, world?: SkillWorldView) {
  const normalized = utf8_safe_prefix(clean_text(query, 'skill search query', MAX_RAW_QUERY_CHARS), MAX_FIND_QUERY_BYTES)
  const bounded_limit = positive_integer(limit, 'skill search limit')
  if (bounded_limit > 5) throw new Error('skill search limit must be at most 5')
  return rank_skills_for_goal(normalized, world, true).slice(0, bounded_limit).map(match => ({
    score: match.score,
    id: match.skill.id,
    name: match.skill.name,
    kind: match.skill.kind,
    stage: match.skill.stage,
    status: match.skill.status,
    summary: match.skill.summary,
    inputs: match.skill.inputs.map(value => value.item),
    outputs: match.skill.outputs.map(value => value.item),
    matched: match.matched.slice(0, CARD_LIST_MAX),
    needs: match.needs.slice(0, CARD_LIST_MAX),
    warnings: skill_ui_summary(match.skill).warnings,
  }))
}

function sorted_names(names: string[]) {
  names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return names
}

// Entity names for a subject that is an entity name or an entity type
// ("generator"). Empty when the game knows neither.
function entities_for_subject(subject: string) {
  if (prototypes.entity[subject] !== undefined) return [subject]
  const names: string[] = []
  try {
    const matches = prototypes.get_entity_filtered([{ filter: 'type', type: subject as any }])
    for (const [name] of matches) names.push(name)
  }
  catch {
    return []
  }
  return sorted_names(names)
}

// Recipe name -> the technology that unlocks it. When several do, the one with
// the fewest unresearched prerequisites wins (then the name), so a card names
// the nearest unlock.
function recipe_unlock_technologies(force: LuaForce) {
  const best: Record<string, { technology: string, distance: number }> = {}
  for (const [name, technology] of force.technologies) {
    let distance = 0
    for (const [, prerequisite] of pairs(technology.prerequisites)) if (!prerequisite.researched) distance++
    for (const effect of technology.prototype.effects) {
      if (effect.type !== 'unlock-recipe') continue
      const recipe = (effect as any).recipe
      if (typeof recipe !== 'string') continue
      const current = best[recipe]
      if (current === undefined || distance < current.distance || (distance === current.distance && name < current.technology)) {
        best[recipe] = { technology: name, distance }
      }
    }
  }
  const result: Record<string, string> = {}
  for (const recipe in best) result[recipe] = best[recipe].technology
  return result
}

const NEED_RANK: Record<SkillNeedState, number> = { have: 0, can_craft: 1, locked: 2, unknown: 3 }

// The controlled actor's force and main inventory, read-only. Uses the peek
// lookup: a skill lookup must never create or reconcile the NPC body.
export function live_skill_world_view(): SkillWorldView | undefined {
  const actor = peek_controlled_actor()
  if (!actor || !actor.is_valid) return undefined
  const force = actor.force
  const inventory = actor.get_main_inventory()
  const hand_categories = actor.character?.prototype.crafting_categories
  let unlocks: Record<string, string> | undefined
  const unlocking_technology = (recipe: string) => {
    if (unlocks === undefined) unlocks = recipe_unlock_technologies(force)
    return unlocks[recipe]
  }
  const check_item = function (this: void, item: string, minimum: number): SkillNeedCheck | undefined {
    if (prototypes.item[item] === undefined) return undefined
    if (inventory !== undefined && inventory.get_item_count(item) >= minimum) return { state: 'have', via: item }
    const recipe = force.recipes[item]
    if (recipe === undefined) return undefined
    if (!recipe.enabled) {
      const technology = unlocking_technology(item)
      return technology !== undefined ? { state: 'locked', via: item, technology } : { state: 'locked', via: item }
    }
    return crafting_categories_support_recipe(hand_categories, recipe) ? { state: 'can_craft', via: item } : undefined
  }
  return {
    check_technology: (name: string) => {
      const technology = force.technologies[name]
      if (technology === undefined) return undefined
      return technology.researched ? { state: 'have', via: name } : { state: 'locked', via: name, technology: name }
    },
    check_item,
    check_entity: (entity_or_type: string) => {
      let best: SkillNeedCheck | undefined
      for (const name of entities_for_subject(entity_or_type)) {
        if (force.get_entity_count(name) > 0) return { state: 'have', via: name }
        const place = prototypes.entity[name]?.items_to_place_this
        if (place === undefined || place.length === 0) continue
        const check = check_item(place[0].name, 1)
        if (check === undefined) continue
        const candidate: SkillNeedCheck = { ...check, via: name }
        if (best === undefined || NEED_RANK[candidate.state] < NEED_RANK[best.state]) best = candidate
        if (best.state === 'have') return best
      }
      return best
    },
  }
}

export function offer_skill_cards(request: unknown) {
  const raw: any = plain_object(request) ? request : {}
  const cards = skill_cards_for_goal(raw.goal, raw.limit ?? MAX_SKILL_CARDS, live_skill_world_view())
  return { ok: true, cards }
}

function exports_state() {
  if (storage.sgluna_skill_exports === undefined) storage.sgluna_skill_exports = {}
  return storage.sgluna_skill_exports
}

export function put_skill_definition(value: any) {
  const skill = canonicalize_skill_definition(value)
  return store_dynamic_skill_definition(skill)
}

export function put_untrusted_skill_definition(value: any) {
  const skill = canonicalize_skill_definition(value)
  if (skill.status === 'verified') throw new Error('verified skill promotion requires the live runtime verifier; caller-supplied verified definitions are not trusted')
  return store_dynamic_skill_definition(skill)
}

export function create_skill_candidate(value: any) {
  if (!plain_object(value)) throw new Error('skill candidate must be an object')
  return put_skill_definition({
    ...value,
    schema_version: SKILL_SCHEMA_VERSION,
    stage: 'executable_candidate',
    status: 'candidate',
  })
}

export function get_skill_definition(id: string) {
  const safe_id = assert_safe_skill_id(id)
  return definitions()[safe_id]
}

export function list_skill_definitions() {
  const result: SkillDefinition[] = []
  const registry = definitions()
  for (const id in registry) result.push(registry[id])
  result.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  return result
}

function verification_pairs(skill: SkillDefinition): Array<[string, SkillVerificationState]> {
  return [
    ['structural', skill.verification.structural],
    ['recipe flow', skill.verification.recipe_flow],
    ['placement rebuild', skill.verification.placement_rebuild],
    ['production output', skill.verification.production_output],
    ['belt capacity', skill.verification.belt_capacity],
    ['inserter sustained throughput', skill.verification.inserter_sustained_throughput],
  ]
}

function flow_label(flow: SkillFlow) {
  const amount = flow.amount !== undefined ? ` x${flow.amount}` : ''
  const role = flow.role !== undefined ? ` (${flow.role})` : ''
  return `${flow.item}${amount}${role}`
}

export function skill_ui_summary(skill: SkillDefinition): SkillUiSummary {
  const warnings: string[] = []
  const verification_parts: string[] = []
  for (const [label, state] of verification_pairs(skill)) {
    verification_parts.push(`${label}=${state}`)
    if (state === 'unvalidated') warnings.push(`${label} unvalidated`)
    else if (state === 'not_tested') warnings.push(`${label} not tested`)
    else if (state === 'failed') warnings.push(`${label} failed`)
  }
  for (const constraint of skill.constraints) if (constraint.validation === 'unvalidated') warnings.push(`constraint unvalidated: ${constraint.description}`)
  for (const failure of skill.known_failure_modes) warnings.push(`known failure: ${failure}`)
  return {
    id: skill.id,
    name: skill.name,
    revision: skill.revision,
    status: skill.status,
    stage: skill.stage,
    source: skill.source.kind,
    inputs: skill.inputs.map(flow_label),
    outputs: skill.outputs.map(flow_label),
    verification: verification_parts.join('; '),
    warnings: warnings.slice(0, 12),
  }
}

export function list_skill_ui_summaries() {
  return list_skill_definitions().map(skill_ui_summary)
}

function md_inline(value: string) {
  return value.split('`').join("'")
}

function md_list(lines: string[], values: string[], empty: string) {
  if (values.length === 0) lines.push(`- ${empty}`)
  else for (const value of values) lines.push(`- ${value}`)
}

function topology_relation_text(relation: SkillTopologyRelation) {
  const endpoints = relation.from !== undefined || relation.to !== undefined
    ? `${relation.from ?? '?'} -> ${relation.to ?? '?'}`
    : 'relationship'
  const via = relation.via !== undefined ? ` via ${relation.via}` : ''
  const description = relation.description !== undefined ? ` — ${relation.description}` : ''
  return `\`${md_inline(relation.kind)}\`: ${md_inline(endpoints + via + description)}`
}

function constraint_text(constraint: SkillConstraint) {
  const predicate = constraint.predicate !== undefined
    ? `; predicate=${md_inline(skill_constraint_predicate_signature(constraint.predicate))}`
    : ''
  const evidence = constraint.evidence_refs.length > 0 ? `; evidence=${constraint.evidence_refs.join(', ')}` : ''
  return `${constraint.kind}: ${constraint.description} [${constraint.validation}]${predicate}${evidence}`
}

export function generate_skill_markdown(skill: SkillDefinition) {
  const lines: string[] = []
  lines.push(`# ${md_inline(skill.name)}`, '')
  lines.push('## Purpose', '', skill.summary, '')
  lines.push('## Status', '')
  lines.push(`- Schema version: ${skill.schema_version}`)
  lines.push(`- Skill revision: ${skill.revision}`)
  lines.push(`- Lifecycle status: ${skill.status}`)
  lines.push(`- Artifact stage: ${skill.stage}`)
  lines.push(`- Kind: ${skill.kind}`, '')

  lines.push('## Preconditions', '')
  md_list(lines, skill.preconditions.map(condition => `${condition.kind}: ${condition.subject} — ${condition.description}${condition.minimum !== undefined ? ` (minimum ${condition.minimum})` : ''}`), 'None recorded.')
  lines.push('', '## Inputs', '')
  md_list(lines, skill.inputs.map(flow_label), 'None recorded.')
  lines.push('', '## Outputs', '')
  md_list(lines, skill.outputs.map(flow_label), 'None recorded.')

  lines.push('', '## Procedure / Topology', '', '### Nodes', '')
  md_list(lines, skill.topology.nodes.map(node => `\`${md_inline(node.id)}\`: ${md_inline(node.role)}${node.entity_name !== undefined ? `; entity=${md_inline(node.entity_name)}` : ''}${node.recipe !== undefined ? `; recipe=${md_inline(node.recipe)}` : ''}`), 'No reusable topology nodes recorded.')
  lines.push('', '### Relationships', '')
  md_list(lines, skill.topology.relations.map(topology_relation_text), 'No reusable relationships recorded.')

  lines.push('', '## Constraints', '')
  md_list(lines, skill.constraints.map(constraint_text), 'None recorded.')
  lines.push('', '## Parameters', '')
  md_list(lines, skill.parameters.map(parameter => `\`${md_inline(parameter.name)}\`: ${parameter.description}; ${parameter.required ? 'required' : 'optional'}${parameter.default_value !== undefined ? `; default=${parameter.default_value}` : ''}`), 'None recorded.')

  lines.push('', '## Verification', '')
  for (const [label, state] of verification_pairs(skill)) lines.push(`- ${label}: ${state}`)
  lines.push('', '### Acceptance Conditions', '')
  md_list(lines, skill.verification.acceptance_conditions.map(condition => `${condition.id}: ${condition.description} [${condition.status}]${condition.evidence_refs.length > 0 ? `; evidence=${condition.evidence_refs.join(', ')}` : ''}`), 'None defined; this artifact must not be treated as verified.')

  lines.push('', '## Known Failure Modes', '')
  md_list(lines, skill.known_failure_modes, 'None recorded.')
  lines.push('', '## Confidence', '')
  lines.push(`- Level: ${skill.confidence.level}`)
  md_list(lines, skill.confidence.basis, 'No confidence basis recorded.')

  lines.push('', '## Provenance', '')
  lines.push(`- Learned from: ${skill.source.kind}`)
  if (skill.source.goal_id !== undefined) lines.push(`- Goal ID: ${skill.source.goal_id}`)
  if (skill.source.observed_tick !== undefined) lines.push(`- Observed tick: ${skill.source.observed_tick}`)
  if (skill.source.recipe_ids.length > 0) lines.push(`- Recipe IDs: ${skill.source.recipe_ids.join(', ')}`)
  if (skill.source.entity_unit_numbers.length > 0) lines.push(`- Source entity unit numbers: ${skill.source.entity_unit_numbers.join(', ')}`)
  if (skill.source.area !== undefined) lines.push(`- Source area: surface ${skill.source.area.surface_index}, (${skill.source.area.left_top.x}, ${skill.source.area.left_top.y}) to (${skill.source.area.right_bottom.x}, ${skill.source.area.right_bottom.y})`)
  if (skill.source.evidence_refs.length > 0) lines.push(`- Evidence refs: ${skill.source.evidence_refs.join(', ')}`)
  lines.push('- Source coordinates and entity IDs are provenance only; reusable application depends on the topology and preconditions above.')

  lines.push('', '## Examples', '')
  md_list(lines, skill.examples.map(example => `${example.summary}${example.notes !== undefined ? ` — ${example.notes}` : ''}`), 'None recorded.')
  lines.push('')
  return lines.join('\n')
}

export function serialize_skill_json(skill: SkillDefinition) {
  return `${helpers.table_to_json(skill)}\n`
}

export function skill_export_relative_directory(skill: Pick<SkillDefinition, 'id' | 'revision'>) {
  return `sgluna-skills/${assert_safe_skill_id(skill.id)}/r${positive_integer(skill.revision, 'revision')}`
}

export interface SkillExportResult {
  id: string
  revision: number
  duplicate: boolean
  relative_path: string
}

export function export_skill(id: string): SkillExportResult {
  const skill = get_skill_definition(id)
  if (skill === undefined) throw new Error(`unknown skill: ${id}`)
  const canonical_json = serialize_skill_json(skill)
  const directory = skill_export_relative_directory(skill)
  const relative_path = `script-output/${directory}`
  const key = `${skill.id}@${skill.revision}`
  const previous = exports_state()[key]
  if (previous !== undefined) {
    if (previous.canonical_json !== canonical_json) throw new Error(`skill ${skill.id} revision ${skill.revision} was already exported with different content; increment revision before exporting again`)
    return { id: skill.id, revision: skill.revision, duplicate: true, relative_path: previous.relative_path }
  }

  helpers.write_file(`${directory}/skill.json`, canonical_json, false)
  helpers.write_file(`${directory}/SKILL.md`, generate_skill_markdown(skill), false)
  exports_state()[key] = {
    schema_version: SKILL_SCHEMA_VERSION,
    id: skill.id,
    revision: skill.revision,
    canonical_json,
    relative_path,
    exported_tick: game.tick,
  }
  return { id: skill.id, revision: skill.revision, duplicate: false, relative_path }
}

function error_message(error: unknown) {
  if (error instanceof Error) return error.message
  return 'invalid skill definition'
}

export function create_skill_candidate_from_factory_block(analysis_id: string, block_id: string) {
  let candidate = skill_candidate_definition_from_block(analysis_id, block_id, 1)
  const previous = get_skill_definition(candidate.id)
  if (previous !== undefined) candidate = skill_candidate_definition_from_block(analysis_id, block_id, previous.revision + 1)
  return create_skill_candidate(candidate)
}

export function create_skill_remote_interface() {
  remote.add_interface('autorio_skills', {
    put_definition: (value: unknown) => {
      try {
        const skill = put_untrusted_skill_definition(value)
        return [true, skill.id, skill.revision]
      }
      catch (error) {
        return [false, error_message(error)]
      }
    },
    create_candidate: (value: unknown) => {
      try {
        const skill = create_skill_candidate(value)
        return [true, skill.id, skill.revision]
      }
      catch (error) {
        return [false, error_message(error)]
      }
    },
    get: (id: string) => {
      try { return get_skill_definition(id) }
      catch { return undefined }
    },
    find: (query: unknown, limit: unknown = 3) => {
      try { return { ok: true, results: find_skill_definitions(query, limit, live_skill_world_view()) } }
      catch (error) { return { ok: false, error: error_message(error), results: [] } }
    },
    // Bounded skill cards for a goal, offered by the harness in plan-authoring
    // context without the model asking (plan item 2.8a). Read-only.
    offer: (request: unknown) => {
      try { return offer_skill_cards(request) }
      catch (error) { return { ok: false, error: error_message(error), cards: [] } }
    },
    list: () => list_skill_definitions(),
    analyze_area: (request: unknown = {}) => {
      const actor = get_controlled_actor()
      if (!actor || !actor.is_valid) return { ok: false, error: 'controlled actor is unavailable' }
      return analyze_factory_area(actor, plain_object(request) ? request as any : {})
    },
    list_analyzed_blocks: (analysis_id?: string) => list_analyzed_blocks(analysis_id),
    create_candidate_from_block: (analysis_id: string, block_id: string) => {
      try {
        const skill = create_skill_candidate_from_factory_block(analysis_id, block_id)
        return [true, skill.id, skill.revision]
      }
      catch (error) {
        return [false, error_message(error)]
      }
    },
    export: (id: string) => {
      try {
        const result = export_skill(id)
        return [true, result.relative_path, result.duplicate]
      }
      catch (error) {
        return [false, error_message(error)]
      }
    },
  })
}

// Sized by the console column that hosts it. A fixed size here would widen the
// whole window and clip its own content once the skill list grows.
function add_skill_section(parent: LuaGuiElement) {
  const section = parent.add({ type: 'frame', direction: 'vertical', style: 'inside_shallow_frame' })
  section.style.horizontally_stretchable = true
  section.style.vertically_stretchable = true
  const header = section.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.style.vertical_align = 'center'
  header.add({ type: 'label', caption: 'Learned / Candidate Skills', style: 'subheader_caption_label' })
  const body = section.add({ type: 'flow', direction: 'vertical' })
  body.style.horizontally_stretchable = true
  body.style.vertically_stretchable = true
  body.style.padding = SKILL_SECTION_PADDING
  body.style.vertical_spacing = 6
  return body
}

// The action button lives in the console Controls panel; its results render in
// the skills section below.
export function render_learn_area_button(parent: LuaGuiElement) {
  const analyze = parent.add({
    type: 'button',
    name: FACTORY_ANALYZE_BUTTON_NAME,
    caption: 'LEARN AREA',
    style: 'dialog_button',
    tooltip: `Deterministically inspect a ${FACTORY_DEFAULT_RADIUS * 2}x${FACTORY_DEFAULT_RADIUS * 2} factory area around your current position. No provider call is used. Engine scan → factory graph → choose block → SkillCandidate; observation is not verification.`,
  })
  analyze.style.minimal_width = 0
  analyze.style.horizontally_stretchable = true
  return analyze
}

/** What render_factory_learning shows, so a window can skip redrawing it when nothing changed. */
export function factory_learning_signature() {
  const analysis = latest_factory_area_analysis()
  if (!analysis) return ''
  const blocks = list_analyzed_blocks(analysis.id).slice(0, MAX_UI_BLOCKS)
  return `${analysis.id}#${analysis.entities.length}#${analysis.relations.length}#${blocks.map(block => block.block_id).join(',')}`
}

export function skill_export_button_name(id: string) { return `${SKILL_EXPORT_BUTTON_PREFIX}${id}` }

export function render_factory_learning(body: LuaGuiElement) {
  const analysis = latest_factory_area_analysis()
  if (!analysis) {
    body.add({ type: 'label', caption: 'No factory area has been analyzed yet.' })
    return
  }
  body.add({ type: 'label', caption: `Latest analysis ${analysis.id}: ${analysis.entities.length} entities, ${analysis.relations.length} proven relations, ${analysis.blocks.length} production block(s).` })
  const blocks = list_analyzed_blocks(analysis.id).slice(0, MAX_UI_BLOCKS)
  if (blocks.length === 0) {
    body.add({ type: 'label', caption: 'No connected production block with a recipe or mining source was found in the selected area.' })
    return
  }
  const scroll = body.add({ type: 'scroll-pane', style: 'scroll_pane_in_shallow_frame' })
  scroll.style.maximal_height = 135
  scroll.style.horizontally_stretchable = true
  for (const block of blocks) {
    const row = scroll.add({ type: 'flow', direction: 'horizontal' })
    row.style.horizontally_stretchable = true
    const title = row.add({ type: 'label', caption: `Detected Block: ${block.title}`, style: 'semibold_label' })
    title.style.width = 430
    const save = row.add({
      type: 'button',
      name: `${FACTORY_SAVE_BUTTON_PREFIX}${analysis.id}__${block.block_id}`,
      caption: 'SAVE SKILL CANDIDATE',
      style: 'confirm_button',
      tooltip: 'Convert this deterministic observed block through the existing create_skill_candidate path. It remains candidate, not verified.',
    })
    save.style.minimal_width = 190
    scroll.add({ type: 'label', caption: `Inputs: ${block.inputs.join(', ') || 'unknown'} · Intermediates: ${block.intermediates.join(', ') || 'none'} · Outputs: ${block.outputs.join(', ') || 'unknown'}` })
    scroll.add({ type: 'label', caption: `Machines: ${block.machines.join(', ') || 'none'} · Relationships: ${block.relation_count}` })
    scroll.add({ type: 'label', caption: 'Validation: structural=passed · recipe graph=passed when recipes exist · rebuild=not tested · sustained throughput=unvalidated', style: 'grey_label' })
    if (block.ambiguities.length > 0) scroll.add({ type: 'label', caption: `Ambiguous: ${block.ambiguities.slice(0, 2).join('; ')}`, style: 'grey_label' })
  }
}

// Area learning lives in the console Controls panel; this section lists what
// was already saved from it.
export function render_skill_export_section(parent: LuaGuiElement) {
  const body = add_skill_section(parent)
  render_factory_learning(body)
  const skills = list_skill_ui_summaries()
  if (skills.length === 0) {
    body.add({ type: 'label', caption: 'No saved skill candidates yet. Analyze an area, choose a detected block, then save it as a candidate.' })
    return
  }
  const scroll = body.add({ type: 'scroll-pane', style: 'scroll_pane_in_shallow_frame' })
  scroll.style.maximal_height = 95
  scroll.style.horizontally_stretchable = true
  for (const skill of skills.slice(0, MAX_UI_SKILLS)) {
    const row = scroll.add({ type: 'flow', direction: 'horizontal' })
    row.style.horizontally_stretchable = true
    const title = row.add({ type: 'label', caption: `${skill.name} r${skill.revision} — ${skill.status.toUpperCase()}`, style: 'semibold_label' })
    title.style.width = 330
    const export_button = row.add({
      type: 'button',
      name: `${SKILL_EXPORT_BUTTON_PREFIX}${skill.id}`,
      caption: 'EXPORT SKILL',
      style: 'confirm_button',
      tooltip: 'Export the structured skill.json and generated SKILL.md companion into the managed script-output/sgluna-skills directory.',
    })
    export_button.style.minimal_width = 130
    scroll.add({ type: 'label', caption: `Source: ${skill.source} · Stage: ${skill.stage} · Inputs: ${skill.inputs.join(', ') || 'none'} · Outputs: ${skill.outputs.join(', ') || 'none'}` })
    scroll.add({ type: 'label', caption: `Verification: ${skill.verification}`, style: 'grey_label' })
    scroll.add({ type: 'label', caption: `Warnings: ${skill.warnings.length > 0 ? skill.warnings.slice(0, 5).join('; ') : 'none recorded'}`, style: 'grey_label' })
  }
  if (skills.length > MAX_UI_SKILLS) body.add({ type: 'label', caption: `${skills.length - MAX_UI_SKILLS} more skill records are available through autorio_skills.list.` })
}

export function handle_skill_export_click(player: LuaPlayer, element_name: string) {
  if (element_name === FACTORY_ANALYZE_BUTTON_NAME) {
    const actor = get_controlled_actor()
    if (!actor || !actor.is_valid) {
      player.print('[SGLuna] Factory learning failed: controlled actor is unavailable.')
      return true
    }
    if (actor.surface.index !== player.surface.index) {
      player.print('[SGLuna] Factory learning failed: player and SGLuna actor are on different surfaces.')
      return true
    }
    const result = analyze_factory_area(actor, {
      surface_index: player.surface.index,
      position: player.position,
      radius: FACTORY_DEFAULT_RADIUS,
    })
    if (!result.ok) player.print(`[SGLuna] Factory learning failed: ${result.error}`)
    else player.print(`[SGLuna] Analyzed ${result.analysis_id}: ${result.entity_count} relevant entities, ${result.blocks.length} candidate production block(s). Choose a block to save as a SkillCandidate.`)
    return true
  }

  if (element_name.startsWith(FACTORY_SAVE_BUTTON_PREFIX)) {
    const raw = element_name.slice(FACTORY_SAVE_BUTTON_PREFIX.length)
    const parts = raw.split('__')
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
      player.print('[SGLuna] Factory learning failed: malformed block selection.')
      return true
    }
    try {
      const skill = create_skill_candidate_from_factory_block(parts[0], parts[1])
      player.print(`[SGLuna] Saved ${skill.name} r${skill.revision} as a candidate. Review validation warnings, then use EXPORT SKILL if desired.`)
    }
    catch (error) {
      player.print(`[SGLuna] Factory learning failed: ${error_message(error)}`)
    }
    return true
  }

  if (!element_name.startsWith(SKILL_EXPORT_BUTTON_PREFIX)) return false
  const skill_id = element_name.slice(SKILL_EXPORT_BUTTON_PREFIX.length)
  try {
    const skill = get_skill_definition(skill_id)
    if (skill === undefined) throw new Error(`unknown skill: ${skill_id}`)
    const result = export_skill(skill_id)
    const verb = result.duplicate ? 'Already exported' : 'Exported'
    player.print(`[SGLuna] ${verb} ${skill.name} r${skill.revision}: ${result.relative_path}`)
  }
  catch (error) {
    player.print(`[SGLuna] Skill export failed: ${error_message(error)}`)
  }
  return true
}
