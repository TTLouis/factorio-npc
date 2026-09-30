import {
  create_skill_candidate,
  get_skill_definition,
  type SkillDefinition,
} from './skills'
import {
  skill_constraint_predicate_signature,
  type SkillConstraintPredicate,
} from './skill_constraint_predicates'
import {
  mark_skill_revision_reverified,
  record_skill_evidence,
  skill_semantic_signature,
} from './skill_semantic_evidence'

export type LearningOpportunitySource = 'completed_goal' | 'observed_factory' | 'experiment' | 'manual'
export type LearningOpportunityState = 'detected' | 'analyzing' | 'candidate_created' | 'duplicate' | 'awaiting_verification' | 'verified' | 'rejected' | 'failed'
export type LearningPolicy = 'manual' | 'assisted' | 'autonomous_bounded'
export type LearningCost = 'cheap' | 'moderate' | 'expensive'
export type LearningRisk = 'safe' | 'moderate' | 'dangerous'
export type LearningVerificationQueueState = 'queued' | 'running' | 'blocked'

export interface LearningSourceArea {
  surface_index: number
  left_top: { x: number, y: number }
  right_bottom: { x: number, y: number }
}

export interface LearningOpportunity {
  id: string
  source: LearningOpportunitySource
  state: LearningOpportunityState
  created_tick: number
  goal_id?: string
  analysis_id?: string
  verification_run_id?: string
  source_area?: LearningSourceArea
  evidence_refs: string[]
  novelty_key: string
  estimated_cost: LearningCost
  risk: LearningRisk
  reason: string
  skill_id?: string
  duplicate_skill_id?: string
}

export interface LearningVerificationQueueItem {
  opportunity_id: string
  skill_id: string
  state: LearningVerificationQueueState
  created_tick: number
  estimated_cost: LearningCost
  risk: LearningRisk
  reason: string
}

interface VerificationEvidenceSnapshot {
  id: string
  skill_id: string
  skill_revision: number
  state?: string
  failure_kind?: 'execution' | 'semantic'
  reason?: string
  evidence_refs?: string[]
}

export interface SkillSemanticCounterexample {
  run_id: string
  skill_id: string
  skill_revision: number
  predicates: SkillConstraintPredicate[]
  evidence_refs: string[]
  summary: string
}

interface StoredSkillRevision {
  id: string
  revision: number
  status?: string
}

declare const storage: {
  sgluna_learning_opportunities?: Record<string, LearningOpportunity>
  sgluna_learning_opportunity_order?: string[]
  sgluna_learning_next_id?: number
  sgluna_learning_verification_queue?: LearningVerificationQueueItem[]
  sgluna_learning_policy?: LearningPolicy
  sgluna_skill_verification_runs?: Record<string, VerificationEvidenceSnapshot>
  sgluna_skill_definitions?: Record<string, StoredSkillRevision>
  sgluna_learning_terminal_evidence_processed?: Record<string, string>
}

export const MAX_LEARNING_OPPORTUNITIES = 32
export const MAX_LEARNING_VERIFICATION_QUEUE = 16
const MAX_EVIDENCE_REFS = 32
const MAX_TEXT = 800

function clean_text(value: unknown, max = MAX_TEXT) {
  let result = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (result.includes('  ')) result = result.split('  ').join(' ')
  return result.length <= max ? result : result.slice(0, max)
}

function unique_strings(values: string[], limit = MAX_EVIDENCE_REFS) {
  const result: string[] = []
  for (const value of values) {
    const next = clean_text(value, 300)
    if (next.length === 0 || result.includes(next)) continue
    result.push(next)
    if (result.length >= limit) break
  }
  return result
}

function unique_predicates(values: SkillConstraintPredicate[]) {
  const result: SkillConstraintPredicate[] = []
  const signatures: string[] = []
  for (const predicate of values) {
    const signature = skill_constraint_predicate_signature(predicate)
    if (signatures.includes(signature)) continue
    signatures.push(signature)
    result.push(predicate)
  }
  return result
}

function records_readonly(): Record<string, LearningOpportunity> {
  return storage.sgluna_learning_opportunities ?? {}
}

function order_readonly() {
  return storage.sgluna_learning_opportunity_order ?? []
}

function ensure_records() {
  if (storage.sgluna_learning_opportunities === undefined) storage.sgluna_learning_opportunities = {}
  if (storage.sgluna_learning_opportunity_order === undefined) storage.sgluna_learning_opportunity_order = []
  return storage.sgluna_learning_opportunities
}

function ensure_queue() {
  if (storage.sgluna_learning_verification_queue === undefined) storage.sgluna_learning_verification_queue = []
  return storage.sgluna_learning_verification_queue
}

function terminal_evidence_processed() {
  storage.sgluna_learning_terminal_evidence_processed ??= {}
  return storage.sgluna_learning_terminal_evidence_processed
}

export function semantic_counterexample_from_failure(skill: SkillDefinition, run: VerificationEvidenceSnapshot, evidence_refs: string[] = []): SkillSemanticCounterexample | undefined {
  if (run.state !== 'failed' || run.failure_kind !== 'semantic') return undefined
  if (run.skill_id !== skill.id || run.skill_revision !== skill.revision) return undefined

  const predicates: SkillConstraintPredicate[] = []
  for (const relation of skill.topology.relations) {
    if (relation.kind === 'adjacent' || relation.kind === 'custom') continue
    if (relation.from === undefined && relation.to === undefined && relation.via === undefined) continue
    predicates.push({
      type: 'required_topology_relation',
      relation_kind: relation.kind,
      from: relation.from,
      to: relation.to,
      via: relation.via,
    })
  }
  for (const output of skill.outputs) {
    predicates.push({ type: 'output_delta', item: output.item, minimum_delta: 1 })
  }

  const deduplicated = unique_predicates(predicates)
  if (deduplicated.length === 0) return undefined
  return {
    run_id: run.id,
    skill_id: run.skill_id,
    skill_revision: run.skill_revision,
    predicates: deduplicated,
    evidence_refs: unique_strings([...(run.evidence_refs ?? []), ...evidence_refs]),
    summary: clean_text(run.reason ?? 'Semantic verification counterexample.'),
  }
}

function counterexample_constraint_description(predicate: SkillConstraintPredicate) {
  if (predicate.type === 'required_topology_relation') {
    const endpoints = `${predicate.from ?? '?'} -> ${predicate.to ?? '?'}`
    const via = predicate.via !== undefined ? ` via ${predicate.via}` : ''
    return `Semantic counterexample requires ${predicate.relation_kind} ${endpoints}${via} to hold on a rebuilt instance.`
  }
  if (predicate.type === 'output_delta') return `Semantic counterexample requires ${predicate.item} to increase by at least ${predicate.minimum_delta} during bounded verification.`
  if (predicate.type === 'resource_coverage') return `Semantic counterexample requires coverage of ${predicate.resource} by at least ${predicate.minimum_entities} resource entities.`
  return 'Semantic counterexample requires a translated rebuild before reuse.'
}

export function revise_skill_from_semantic_counterexample(skill: SkillDefinition, counterexample: SkillSemanticCounterexample) {
  if (counterexample.skill_id !== skill.id || counterexample.skill_revision !== skill.revision) return undefined
  const existing = skill.constraints
    .map(constraint => skill_constraint_predicate_signature(constraint.predicate))
    .filter(value => value.length > 0)
  const additions = counterexample.predicates.filter(predicate => !existing.includes(skill_constraint_predicate_signature(predicate)))
  if (additions.length === 0) return undefined

  const evidence_refs = unique_strings([...skill.source.evidence_refs, ...counterexample.evidence_refs], 64)
  const known_failure_modes = unique_strings([...skill.known_failure_modes, counterexample.summary], 64)
  const confidence_basis = unique_strings([
    ...skill.confidence.basis,
    `Revision ${skill.revision + 1} encodes deterministic semantic predicates from counterexample ${counterexample.run_id}.`,
  ], 64)
  const confidence_level = skill.confidence.level === 'high' ? 'medium' : skill.confidence.level

  return create_skill_candidate({
    ...skill,
    revision: skill.revision + 1,
    source: { ...skill.source, evidence_refs },
    constraints: [
      ...skill.constraints,
      ...additions.map(predicate => ({
        kind: predicate.type === 'resource_coverage' ? 'resource' as const : predicate.type === 'output_delta' ? 'custom' as const : 'placement' as const,
        description: counterexample_constraint_description(predicate),
        validation: 'unvalidated' as const,
        evidence_refs: counterexample.evidence_refs,
        predicate,
      })),
    ],
    verification: {
      ...skill.verification,
      placement_rebuild: 'not_tested',
      production_output: 'not_tested',
      acceptance_conditions: [],
    },
    known_failure_modes,
    confidence: { level: confidence_level, basis: confidence_basis },
    examples: [
      ...skill.examples,
      {
        summary: `Revised after semantic counterexample ${counterexample.run_id}.`,
        notes: 'The revision adds only machine-readable predicates derived from structured topology/output semantics; free-form failure text is retained as evidence, not parsed as authority.',
      },
    ].slice(0, 64),
  })
}

/**
 * Verification owns the execution state machine, while learning owns the
 * semantic evidence/trust overlay. Verification writes its terminal run before
 * updating the linked learning opportunity, so this bridge can classify the
 * completed run without introducing another polling loop or coupling the
 * verifier to trust storage.
 */
function bridge_terminal_verification_evidence(opportunity: LearningOpportunity) {
  if ((opportunity.state !== 'failed' && opportunity.state !== 'verified') || opportunity.verification_run_id === undefined) return
  const run = storage.sgluna_skill_verification_runs?.[opportunity.verification_run_id]
  if (!run || (run.state !== 'failed' && run.state !== 'verified')) return

  const terminal_key = `${run.id}:${run.state}`
  const processed = terminal_evidence_processed()
  if (processed[run.id] === terminal_key) return

  const refs = unique_strings([...(run.evidence_refs ?? []), ...opportunity.evidence_refs])
  if (run.state === 'failed') {
    const semantic = run.failure_kind === 'semantic'
    record_skill_evidence(
      run.skill_id,
      run.skill_revision,
      semantic ? 'semantic_failure' : 'execution_failure',
      run.reason ?? opportunity.reason,
      refs,
    )
    processed[run.id] = terminal_key

    if (semantic) {
      const skill = get_skill_definition(run.skill_id)
      if (skill !== undefined && skill.revision === run.skill_revision && skill.status === 'candidate') {
        const counterexample = semantic_counterexample_from_failure(skill, run, refs)
        const revised = counterexample !== undefined ? revise_skill_from_semantic_counterexample(skill, counterexample) : undefined
        if (revised !== undefined) {
          const classification = classify_verification_cost_risk(revised)
          queue_learning_verification(
            opportunity.id,
            revised.id,
            classification.estimated_cost,
            classification.risk,
            `Re-verify revision ${revised.revision} after semantic counterexample ${run.id}.`,
          )
        }
      }
    }
    return
  }

  const promoted = storage.sgluna_skill_definitions?.[run.skill_id]
  if (!promoted || promoted.status !== 'verified' || promoted.revision <= run.skill_revision) return
  record_skill_evidence(
    promoted.id,
    promoted.revision,
    'success',
    `Verification ${run.id} promoted revision ${promoted.revision} after live semantic checks.`,
    refs,
  )
  mark_skill_revision_reverified(promoted.id, promoted.revision, refs)
  processed[run.id] = terminal_key
}

export function get_learning_policy(): LearningPolicy {
  return storage.sgluna_learning_policy ?? 'assisted'
}

export function set_learning_policy(value: unknown): LearningPolicy {
  if (value !== 'manual' && value !== 'assisted' && value !== 'autonomous_bounded') throw new Error('learning policy must be manual, assisted, or autonomous_bounded')
  storage.sgluna_learning_policy = value
  return value
}

function next_opportunity_id() {
  const next = storage.sgluna_learning_next_id ?? 1
  storage.sgluna_learning_next_id = next + 1
  return `learning-${next}`
}

export function create_learning_opportunity(value: Omit<LearningOpportunity, 'id' | 'created_tick' | 'state'> & { state?: LearningOpportunityState }) {
  const records = ensure_records()
  const order = storage.sgluna_learning_opportunity_order as string[]
  const id = next_opportunity_id()
  const opportunity: LearningOpportunity = {
    id,
    source: value.source,
    state: value.state ?? 'detected',
    created_tick: game.tick,
    evidence_refs: unique_strings(value.evidence_refs),
    novelty_key: clean_text(value.novelty_key, 24000),
    estimated_cost: value.estimated_cost,
    risk: value.risk,
    reason: clean_text(value.reason),
  }
  if (value.goal_id !== undefined) opportunity.goal_id = clean_text(value.goal_id, 120)
  if (value.analysis_id !== undefined) opportunity.analysis_id = clean_text(value.analysis_id, 120)
  if (value.verification_run_id !== undefined) opportunity.verification_run_id = clean_text(value.verification_run_id, 120)
  if (value.source_area !== undefined) opportunity.source_area = value.source_area
  if (value.skill_id !== undefined) opportunity.skill_id = clean_text(value.skill_id, 120)
  if (value.duplicate_skill_id !== undefined) opportunity.duplicate_skill_id = clean_text(value.duplicate_skill_id, 120)
  records[id] = opportunity
  order.push(id)
  while (order.length > MAX_LEARNING_OPPORTUNITIES) {
    const removed = order.shift()
    if (removed !== undefined) delete records[removed]
  }
  bridge_terminal_verification_evidence(opportunity)
  return opportunity
}

export function update_learning_opportunity(id: string, patch: Partial<LearningOpportunity>) {
  const records = ensure_records()
  const current = records[id]
  if (current === undefined) throw new Error(`unknown learning opportunity: ${id}`)
  const next: LearningOpportunity = { ...current, ...patch, id: current.id, created_tick: current.created_tick }
  if (patch.reason !== undefined) next.reason = clean_text(patch.reason)
  if (patch.evidence_refs !== undefined) next.evidence_refs = unique_strings(patch.evidence_refs)
  records[id] = next
  bridge_terminal_verification_evidence(next)
  return next
}

export function list_learning_opportunities(limit = MAX_LEARNING_OPPORTUNITIES) {
  const records = records_readonly()
  const order = order_readonly()
  const result: LearningOpportunity[] = []
  for (let index = order.length - 1; index >= 0 && result.length < limit; index--) {
    const opportunity = records[order[index]]
    if (opportunity !== undefined) result.push(opportunity)
  }
  return result
}

export function list_learning_verification_queue() {
  return (storage.sgluna_learning_verification_queue ?? []).slice()
}

export function queue_learning_verification(opportunity_id: string, skill_id: string, estimated_cost: LearningCost, risk: LearningRisk, reason: string) {
  const queue = ensure_queue()
  for (const existing of queue) {
    if (existing.skill_id === skill_id && existing.state === 'queued') {
      update_learning_opportunity(opportunity_id, { state: 'awaiting_verification', skill_id })
      return existing
    }
  }
  const item: LearningVerificationQueueItem = {
    opportunity_id,
    skill_id,
    state: 'queued',
    created_tick: game.tick,
    estimated_cost,
    risk,
    reason: clean_text(reason),
  }
  queue.push(item)
  while (queue.length > MAX_LEARNING_VERIFICATION_QUEUE) queue.shift()
  update_learning_opportunity(opportunity_id, { state: 'awaiting_verification', skill_id })
  return item
}

function flow_signature(values: SkillDefinition['inputs']) {
  const result = values.map(value => `${value.item}|${value.amount ?? ''}|${value.role ?? ''}`)
  result.sort()
  return result
}

function node_signature(node: SkillDefinition['topology']['nodes'][number]) {
  return `${node.entity_name ?? ''}|${node.recipe ?? ''}|${node.role}`
}

export function skill_novelty_key(skill: SkillDefinition) {
  const node_by_id: Record<string, string> = {}
  const nodes: string[] = []
  for (const node of skill.topology.nodes) {
    const signature = node_signature(node)
    node_by_id[node.id] = signature
    nodes.push(signature)
  }
  nodes.sort()
  const relations = skill.topology.relations.map(relation => {
    const from = relation.from !== undefined ? node_by_id[relation.from] ?? relation.from : ''
    const to = relation.to !== undefined ? node_by_id[relation.to] ?? relation.to : ''
    const via = relation.via !== undefined ? node_by_id[relation.via] ?? relation.via : ''
    return `${relation.kind}|${from}|${to}|${via}|${relation.description ?? ''}`
  })
  relations.sort()
  const recipes = skill.source.recipe_ids.slice()
  recipes.sort()
  const parameters = skill.parameters.map(value => `${value.name}|${value.required ? 'required' : 'optional'}|${value.description}|${value.default_value ?? ''}`)
  parameters.sort()
  return [
    'learning-novelty-v2',
    `kind=${skill.kind}`,
    `inputs=${flow_signature(skill.inputs).join(',')}`,
    `outputs=${flow_signature(skill.outputs).join(',')}`,
    `recipes=${recipes.join(',')}`,
    `nodes=${nodes.join(',')}`,
    `relations=${relations.join(',')}`,
    `semantic=${skill_semantic_signature(skill)}`,
    `parameters=${parameters.join(',')}`,
  ].join(';')
}

export function assess_skill_reusability(skill: SkillDefinition) {
  if (skill.outputs.length === 0) return { reusable: false, reason: 'No reusable output/result was identified.' }
  if (skill.topology.nodes.length < 2) return { reusable: false, reason: 'Single-entity observations are too trivial for automatic skill creation.' }
  if (skill.topology.relations.length === 0) return { reusable: false, reason: 'No reusable topology or procedure relationship was identified.' }
  const reusable_relation = skill.topology.relations.some(relation => relation.kind !== 'adjacent' && relation.kind !== 'custom')
  if (!reusable_relation) return { reusable: false, reason: 'Only weak adjacency/custom relationships were observed.' }
  if (skill.source.evidence_refs.length === 0) return { reusable: false, reason: 'No deterministic evidence reference supports the candidate.' }
  if (skill.topology.nodes.length > 32 || skill.topology.relations.length > 64) return { reusable: false, reason: 'The observed block exceeds the bounded V1 learning scope.' }
  return { reusable: true, reason: 'Multi-entity reusable topology with a clear output and deterministic evidence.' }
}

function contains_any(value: string, needles: string[]) {
  const lowered = value.toLowerCase()
  for (const needle of needles) if (lowered.includes(needle)) return true
  return false
}

export function classify_verification_cost_risk(skill: SkillDefinition): { estimated_cost: LearningCost, risk: LearningRisk } {
  const expensive = skill.topology.nodes.length > 4
    || skill.preconditions.some(condition => condition.kind === 'technology_researched')
    || skill.inputs.length > 6
  let risk: LearningRisk = 'safe'
  for (const constraint of skill.constraints) {
    if (constraint.kind !== 'safety') continue
    if (contains_any(constraint.description, ['destroy', 'demolish', 'combat', 'replace existing', '拆除', '战斗'])) risk = 'dangerous'
    else risk = 'moderate'
  }
  return { estimated_cost: expensive ? 'expensive' : 'moderate', risk }
}

function merge_numbers(left: number[], right: number[], limit = 64) {
  const result = left.slice(0, limit)
  for (const value of right) {
    if (!result.includes(value)) result.push(value)
    if (result.length >= limit) break
  }
  return result
}

export function merge_duplicate_skill(existing: SkillDefinition, incoming: SkillDefinition): SkillDefinition {
  if (skill_novelty_key(existing) !== skill_novelty_key(incoming)) {
    throw new Error('cannot merge skills with different semantic novelty keys')
  }
  const evidence_refs = unique_strings([...existing.source.evidence_refs, ...incoming.source.evidence_refs])
  const recipe_ids = unique_strings([...existing.source.recipe_ids, ...incoming.source.recipe_ids], 64)
  const basis = unique_strings([...existing.confidence.basis, 'Observed an additional equivalent reusable instance.'], 64)
  const examples = existing.examples.slice(0, 63)
  for (const example of incoming.examples) {
    if (examples.length >= 64) break
    const duplicate = examples.some(value => value.summary === example.summary && value.notes === example.notes)
    if (!duplicate) examples.push(example)
  }
  return {
    ...existing,
    revision: existing.revision + 1,
    source: {
      ...existing.source,
      entity_unit_numbers: merge_numbers(existing.source.entity_unit_numbers, incoming.source.entity_unit_numbers),
      recipe_ids,
      evidence_refs,
    },
    confidence: { ...existing.confidence, basis },
    examples,
  }
}
