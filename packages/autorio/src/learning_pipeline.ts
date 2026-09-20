import type { LuaGuiElement, LuaPlayer } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { get_controlled_actor } from './actors/actor_controller'
import {
  analyze_factory_area,
  list_analyzed_blocks,
  skill_candidate_definition_from_block,
} from './factory_area_learning'
import {
  assess_skill_reusability,
  classify_verification_cost_risk,
  create_learning_opportunity,
  get_learning_policy,
  list_learning_opportunities,
  list_learning_verification_queue,
  merge_duplicate_skill,
  queue_learning_verification,
  set_learning_policy,
  skill_novelty_key,
  update_learning_opportunity,
  type LearningOpportunitySource,
} from './learning_opportunities'
import {
  capture_skill_instance_template_from_block,
  list_skill_verification_runs,
  maybe_start_autonomous_bounded_verification,
  register_skill_verification_runtime,
  retry_blocked_skill_verification,
  start_next_skill_verification,
} from './skill_verification'
import {
  create_skill_candidate,
  list_skill_definitions,
  put_skill_definition,
  type SkillDefinition,
} from './skills'

const AUTO_ANALYSIS_RADIUS = 12
const MAX_BLOCKS_PER_EVENT = 4
const FACTORY_SAVE_BUTTON_PREFIX = 'airi_skill_save_block__'
const MAX_UI_OPPORTUNITIES = 4

export interface LearningGoalSnapshot {
  goal_id: string
  objective: string
  status: 'idle' | 'active' | 'blocked' | 'paused' | 'completed'
  completed_count: number
  total_steps: number
  steps: Array<{ id: string, description: string, status: string }>
  activity: Array<{ kind: string, text: string }>
}

interface LearningContext {
  goal_id?: string
  evidence_refs?: string[]
  reason?: string
}

function append_unique(values: string[], additions: string[], limit = 32) {
  const result = values.slice(0, limit)
  for (const value of additions) {
    if (!result.includes(value)) result.push(value)
    if (result.length >= limit) break
  }
  return result
}

function candidate_for_source(analysis_id: string, block_id: string, source: LearningOpportunitySource, context: LearningContext) {
  const candidate = skill_candidate_definition_from_block(analysis_id, block_id, 1)
  candidate.source.kind = source
  if (context.goal_id !== undefined) candidate.source.goal_id = context.goal_id
  candidate.source.evidence_refs = append_unique(candidate.source.evidence_refs, context.evidence_refs ?? [])
  if (context.reason !== undefined) {
    candidate.examples = [...candidate.examples, { summary: context.reason }].slice(0, 64)
  }
  return candidate
}

function duplicate_for_key(novelty_key: string) {
  for (const skill of list_skill_definitions()) {
    if (skill_novelty_key(skill) === novelty_key) return skill
  }
  return undefined
}

function unique_candidate_id(candidate: SkillDefinition, novelty_key: string) {
  const existing = list_skill_definitions()
  const id = candidate.id
  for (const skill of existing) {
    if (skill.id !== id) continue
    if (skill_novelty_key(skill) === novelty_key) return id
    for (let suffix = 2; suffix <= 32; suffix++) {
      const next = `${candidate.id}-${suffix}`
      if (!existing.some(value => value.id === next)) return next
    }
    throw new Error(`too many semantic variants for candidate id ${candidate.id}`)
  }
  return id
}

export function process_learning_candidate(candidate: SkillDefinition, source: LearningOpportunitySource, context: LearningContext = {}) {
  const novelty_key = skill_novelty_key(candidate)
  const qualification = assess_skill_reusability(candidate)
  const classification = classify_verification_cost_risk(candidate)
  const opportunity = create_learning_opportunity({
    source,
    goal_id: context.goal_id,
    analysis_id: candidate.source.evidence_refs.find(value => value.startsWith('factory-analysis:'))?.slice('factory-analysis:'.length),
    source_area: candidate.source.area,
    evidence_refs: candidate.source.evidence_refs,
    novelty_key,
    estimated_cost: classification.estimated_cost,
    risk: classification.risk,
    reason: context.reason ?? qualification.reason,
  })

  if (!qualification.reusable) {
    return { opportunity: update_learning_opportunity(opportunity.id, { state: 'rejected', reason: qualification.reason }), skill: undefined, novelty: 'rejected' as const }
  }

  if (get_learning_policy() === 'manual' && source !== 'manual') {
    return {
      opportunity: update_learning_opportunity(opportunity.id, {
        state: 'rejected',
        reason: 'Learning policy is manual; the reusable opportunity was recorded but automatic candidate creation is disabled.',
      }),
      skill: undefined,
      novelty: 'new' as const,
    }
  }

  const duplicate = duplicate_for_key(novelty_key)
  if (duplicate !== undefined) {
    const merged = put_skill_definition(merge_duplicate_skill(duplicate, candidate))
    return {
      opportunity: update_learning_opportunity(opportunity.id, {
        state: 'duplicate',
        skill_id: merged.id,
        duplicate_skill_id: merged.id,
        reason: 'Equivalent reusable topology is already known; attached new provenance/evidence instead of creating another skill.',
      }),
      skill: merged,
      novelty: 'known' as const,
    }
  }

  candidate.id = unique_candidate_id(candidate, novelty_key)
  const stored = create_skill_candidate(candidate)
  update_learning_opportunity(opportunity.id, {
    state: 'candidate_created',
    skill_id: stored.id,
    reason: qualification.reason,
  })
  queue_learning_verification(
    opportunity.id,
    stored.id,
    classification.estimated_cost,
    classification.risk,
    get_learning_policy() === 'autonomous_bounded'
      ? 'Bounded translated-rebuild verification is queued; live topology and output evidence are required before promotion.'
      : 'Assisted learning queues translated rebuild/output verification for an explicit verifier run.',
  )
  maybe_start_autonomous_bounded_verification(get_controlled_actor)
  return { opportunity: list_learning_opportunities(1)[0], skill: stored, novelty: 'new' as const }
}

export function process_factory_block_learning(source: LearningOpportunitySource, analysis_id: string, block_id: string, context: LearningContext = {}) {
  const candidate = candidate_for_source(analysis_id, block_id, source, context)
  const result = process_learning_candidate(candidate, source, context)
  if (result.skill !== undefined && result.skill.status === 'candidate') {
    capture_skill_instance_template_from_block(result.skill.id, result.skill.revision, analysis_id, block_id)
  }
  return result
}

export function process_factory_analysis_learning(source: LearningOpportunitySource, analysis_id: string, context: LearningContext = {}) {
  const results: ReturnType<typeof process_factory_block_learning>[] = []
  const blocks = list_analyzed_blocks(analysis_id).slice(0, MAX_BLOCKS_PER_EVENT)
  for (const block of blocks) results.push(process_factory_block_learning(source, analysis_id, block.block_id, context))
  return results
}

function analyze_and_learn(actor: ControlledActor, source: LearningOpportunitySource, request: any, context: LearningContext = {}) {
  const analysis = analyze_factory_area(actor, request)
  if (!analysis.ok) return { ok: false as const, error: analysis.error, results: [] }
  return { ok: true as const, analysis_id: analysis.analysis_id, results: process_factory_analysis_learning(source, analysis.analysis_id, context) }
}

function has_any(text: string, terms: string[]) {
  const normalized = string.lower(text)
  for (const term of terms) if (normalized.includes(term)) return true
  return false
}

export function meaningful_completed_goal(snapshot: LearningGoalSnapshot) {
  if (snapshot.status !== 'completed') return false
  if (snapshot.completed_count >= 2 && snapshot.total_steps >= 2) return true
  return has_any(snapshot.objective, [
    'automate', 'automated', 'automation', 'production', 'factory', 'line', 'cell', 'smelt', 'mining', 'loader', 'unloader',
    'direct insertion', 'build', 'construct', 'setup', 'experiment', 'test', 'discover', 'inspect', 'study', 'analyze', 'observe',
    '自动化', '生产线', '工厂', '建造', '搭建', '实验', '测试', '研究这个区域', '观察', '分析',
  ])
}

export function learning_source_for_completed_goal(snapshot: LearningGoalSnapshot): LearningOpportunitySource {
  if (has_any(snapshot.objective, ['experiment', 'test', 'discover', 'try a', '实验', '测试', '尝试'])) return 'experiment'
  if (has_any(snapshot.objective, ['inspect', 'study', 'analyze', 'observe', 'reverse engineer', '研究这个区域', '观察', '分析', '逆向'])) return 'observed_factory'
  return 'completed_goal'
}

function goal_evidence(snapshot: LearningGoalSnapshot) {
  const refs = [`goal:${snapshot.goal_id}`]
  for (const step of snapshot.steps) {
    if (step.status === 'completed') refs.push(`goal-step:${snapshot.goal_id}:${step.id}`)
    if (refs.length >= 16) break
  }
  return refs
}

export function handle_task_board_learning_transition(previous: LearningGoalSnapshot | undefined, next: LearningGoalSnapshot) {
  if (next.status !== 'completed' || previous?.status === 'completed') return { processed: false, reason: 'no completion transition' }
  if (!meaningful_completed_goal(next)) return { processed: false, reason: 'completed goal is too trivial for automatic learning' }
  const actor = get_controlled_actor()
  if (!actor || !actor.is_valid) return { processed: false, reason: 'controlled actor is unavailable' }
  const source = learning_source_for_completed_goal(next)
  const result = analyze_and_learn(actor, source, { surface_index: actor.surface.index, position: actor.position, radius: AUTO_ANALYSIS_RADIUS }, {
    goal_id: next.goal_id,
    evidence_refs: goal_evidence(next),
    reason: `Goal completed successfully: ${next.objective}`,
  })
  return { processed: result.ok, source, ...result }
}

export function record_observed_factory_learning(request: any = {}) {
  const actor = get_controlled_actor()
  if (!actor || !actor.is_valid) return { ok: false, error: 'controlled actor is unavailable' }
  return analyze_and_learn(actor, 'observed_factory', request, {
    evidence_refs: ['runtime:relevant-observation'],
    reason: 'A task-relevant factory observation contained reusable connected production structure.',
  })
}

export function record_experiment_learning(value: any = {}) {
  if (value?.success !== true) {
    const opportunity = create_learning_opportunity({
      source: 'experiment',
      state: 'failed',
      goal_id: typeof value?.goal_id === 'string' ? value.goal_id : undefined,
      evidence_refs: Array.isArray(value?.evidence_refs) ? value.evidence_refs.slice(0, 16) : [],
      novelty_key: '', estimated_cost: 'cheap', risk: 'safe',
      reason: typeof value?.reason === 'string' ? value.reason : 'Experiment did not succeed; no successful skill candidate was created.',
    })
    return { ok: true, opportunity, skill_created: false }
  }
  if (typeof value.analysis_id === 'string') {
    const context: LearningContext = {
      goal_id: typeof value.goal_id === 'string' ? value.goal_id : undefined,
      evidence_refs: Array.isArray(value.evidence_refs) ? value.evidence_refs.slice(0, 16) : [],
      reason: typeof value.reason === 'string' ? value.reason : 'A bounded experiment produced a working reusable structure.',
    }
    if (typeof value.block_id === 'string') return { ok: true, results: [process_factory_block_learning('experiment', value.analysis_id, value.block_id, context)] }
    return { ok: true, results: process_factory_analysis_learning('experiment', value.analysis_id, context) }
  }
  const actor = get_controlled_actor()
  if (!actor || !actor.is_valid) return { ok: false, error: 'controlled actor is unavailable' }
  return analyze_and_learn(actor, 'experiment', value.area_request ?? { surface_index: actor.surface.index, position: actor.position, radius: AUTO_ANALYSIS_RADIUS }, {
    goal_id: typeof value.goal_id === 'string' ? value.goal_id : undefined,
    evidence_refs: Array.isArray(value.evidence_refs) ? value.evidence_refs.slice(0, 16) : [],
    reason: typeof value.reason === 'string' ? value.reason : 'A bounded experiment produced a working reusable structure.',
  })
}

export function create_learning_remote_interface() {
  register_skill_verification_runtime(get_controlled_actor)
  remote.add_interface('autorio_learning', {
    status: () => ({
      policy: get_learning_policy(),
      opportunities: list_learning_opportunities(),
      verification_queue: list_learning_verification_queue(),
      verification_runs: list_skill_verification_runs(8),
    }),
    set_policy: (policy: unknown) => {
      try { return [true, set_learning_policy(policy)] }
      catch (error) { return [false, error instanceof Error ? error.message : 'invalid learning policy'] }
    },
    observe_area: (request: unknown = {}) => record_observed_factory_learning(request),
    record_experiment: (value: unknown = {}) => record_experiment_learning(value),
    verify_next: (request: unknown = {}) => start_next_skill_verification(get_controlled_actor, request),
    retry_verification: (opportunity_id: string) => retry_blocked_skill_verification(opportunity_id),
    learn_block: (analysis_id: string, block_id: string) => {
      try {
        const result = process_factory_block_learning('manual', analysis_id, block_id, { evidence_refs: ['manual:learn-area'], reason: 'Player explicitly requested study of this factory block.' })
        return [true, result.skill?.id, result.opportunity.id, result.novelty]
      }
      catch (error) { return [false, error instanceof Error ? error.message : 'learning failed'] }
    },
  })
}

export function render_learning_status(parent: LuaGuiElement) {
  const frame = parent.add({ type: 'frame', direction: 'vertical', style: 'inside_shallow_frame' })
  frame.style.horizontally_stretchable = true
  const header = frame.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.add({ type: 'label', caption: 'Learning', style: 'subheader_caption_label' })
  header.add({ type: 'label', caption: `Policy: ${get_learning_policy()} · Verification queue: ${list_learning_verification_queue().length}`, style: 'grey_label' })
  const body = frame.add({ type: 'flow', direction: 'vertical' })
  body.style.padding = 8
  body.style.horizontally_stretchable = true
  const opportunities = list_learning_opportunities(MAX_UI_OPPORTUNITIES)
  if (opportunities.length === 0) {
    body.add({ type: 'label', caption: 'SGLuna can learn from meaningful completed goals, task-relevant observations, experiments, or explicit Learn Area study. No opportunity recorded yet.' })
    return
  }
  for (const opportunity of opportunities) {
    const novelty = opportunity.state === 'duplicate' ? 'KNOWN' : opportunity.state === 'rejected' ? 'REJECTED' : 'NEW'
    const verification = opportunity.state === 'awaiting_verification' ? 'QUEUED' : opportunity.state === 'verified' ? 'VERIFIED' : '—'
    body.add({ type: 'label', caption: `${opportunity.source} · ${opportunity.state.toUpperCase()} · novelty ${novelty} · verification ${verification}`, style: 'semibold_label' })
    body.add({ type: 'label', caption: `${opportunity.reason} · verification cost ${opportunity.estimated_cost} · risk ${opportunity.risk}`, style: 'grey_label' })
  }
}

export function handle_learning_ui_click(player: LuaPlayer, element_name: string) {
  if (!element_name.startsWith(FACTORY_SAVE_BUTTON_PREFIX)) return false
  const raw = element_name.slice(FACTORY_SAVE_BUTTON_PREFIX.length)
  const parts = raw.split('__')
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    player.print('[SGLuna] Learning failed: malformed factory block selection.')
    return true
  }
  try {
    const result = process_factory_block_learning('manual', parts[0], parts[1], {
      evidence_refs: ['manual:learn-area'],
      reason: 'Player explicitly requested study of this factory block.',
    })
    if (result.novelty === 'known') player.print(`[SGLuna] Known reusable skill: ${result.skill?.name ?? result.skill?.id}. Added new evidence/example instead of duplicating it.`)
    else if (result.skill !== undefined) player.print(`[SGLuna] Learned candidate: ${result.skill.name}. Verification is queued; observation alone did not verify it.`)
    else player.print(`[SGLuna] Learning opportunity rejected: ${result.opportunity.reason}`)
  }
  catch (error) {
    player.print(`[SGLuna] Learning failed: ${error instanceof Error ? error.message : 'invalid learning opportunity'}`)
  }
  return true
}