import { skill_constraint_predicate_signature } from './skill_constraint_predicates'
import type { SkillAcceptanceCondition, SkillConstraint, SkillDefinition, SkillPrecondition } from './skills'

export type SkillEvidenceKind = 'success' | 'semantic_failure' | 'execution_failure' | 'mechanic_correction'
export type SkillRuntimeTrustState = 'active' | 'quarantined'

export interface SkillEvidenceEvent {
  id: string
  skill_id: string
  revision: number
  kind: SkillEvidenceKind
  tick: number
  summary: string
  evidence_refs: string[]
}

export interface SkillRevisionTrust {
  skill_id: string
  revision: number
  state: SkillRuntimeTrustState
  updated_tick: number
  reason?: string
  evidence_refs: string[]
}

declare const storage: {
  sgluna_skill_evidence_events?: SkillEvidenceEvent[]
  sgluna_skill_revision_trust?: Record<string, SkillRevisionTrust>
  sgluna_skill_evidence_next_id?: number
}

const MAX_EVIDENCE_EVENTS = 128
const MAX_EVIDENCE_REFS = 16
const MAX_SUMMARY = 600

function clean_text(value: unknown, max = MAX_SUMMARY) {
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

function next_event_id() {
  const next = storage.sgluna_skill_evidence_next_id ?? 1
  storage.sgluna_skill_evidence_next_id = next + 1
  return `skill-evidence-${next}`
}

function events() {
  storage.sgluna_skill_evidence_events ??= []
  return storage.sgluna_skill_evidence_events
}

function trust_records() {
  storage.sgluna_skill_revision_trust ??= {}
  return storage.sgluna_skill_revision_trust
}

function trust_key(skill_id: string, revision: number) {
  return `${skill_id}@${revision}`
}

/**
 * Semantic identity for one constraint. Predicate identity comes from the
 * finite canonical schema instead of accepting arbitrary JSON-like fields.
 */
export function skill_constraint_semantic_signature(constraint: SkillConstraint) {
  return [
    constraint.kind,
    constraint.validation,
    clean_text(constraint.description, 500),
    skill_constraint_predicate_signature(constraint.predicate),
  ].join('|')
}

export function skill_precondition_semantic_signature(condition: SkillPrecondition) {
  return [
    condition.kind,
    condition.subject,
    condition.minimum ?? '',
    clean_text(condition.description, 500),
  ].join('|')
}

export function skill_acceptance_semantic_signature(condition: SkillAcceptanceCondition) {
  return [condition.id, clean_text(condition.description, 500)].join('|')
}

export function skill_semantic_signature(skill: SkillDefinition) {
  const constraints = skill.constraints.map(skill_constraint_semantic_signature).sort()
  const preconditions = skill.preconditions.map(skill_precondition_semantic_signature).sort()
  const acceptance = skill.verification.acceptance_conditions.map(skill_acceptance_semantic_signature).sort()
  return [
    `preconditions=${preconditions.join(',')}`,
    `constraints=${constraints.join(',')}`,
    `acceptance=${acceptance.join(',')}`,
  ].join(';')
}

function set_trust(skill_id: string, revision: number, state: SkillRuntimeTrustState, reason: string | undefined, evidence_refs: string[]) {
  const next: SkillRevisionTrust = {
    skill_id,
    revision,
    state,
    updated_tick: game.tick,
    evidence_refs: unique_strings(evidence_refs),
  }
  const cleaned = clean_text(reason)
  if (cleaned.length > 0) next.reason = cleaned
  trust_records()[trust_key(skill_id, revision)] = next
  return next
}

/**
 * Semantic failures/corrections quarantine only the affected skill revision.
 * Transient execution failures are retained as evidence but intentionally do
 * not poison the semantic skill model.
 */
export function record_skill_evidence(
  skill_id: string,
  revision: number,
  kind: SkillEvidenceKind,
  summary: string,
  evidence_refs: string[] = [],
) {
  const event: SkillEvidenceEvent = {
    id: next_event_id(),
    skill_id: clean_text(skill_id, 120),
    revision,
    kind,
    tick: game.tick,
    summary: clean_text(summary),
    evidence_refs: unique_strings(evidence_refs),
  }
  const list = events()
  list.push(event)
  while (list.length > MAX_EVIDENCE_EVENTS) list.shift()

  if (kind === 'semantic_failure' || kind === 'mechanic_correction') {
    set_trust(event.skill_id, revision, 'quarantined', event.summary, event.evidence_refs)
  }
  else if (trust_records()[trust_key(event.skill_id, revision)] === undefined) {
    set_trust(event.skill_id, revision, 'active', undefined, event.evidence_refs)
  }
  return event
}

export function skill_revision_trust(skill_id: string, revision: number): SkillRevisionTrust {
  return storage.sgluna_skill_revision_trust?.[trust_key(skill_id, revision)] ?? {
    skill_id,
    revision,
    state: 'active',
    updated_tick: 0,
    evidence_refs: [],
  }
}

export function mark_skill_revision_reverified(skill_id: string, revision: number, evidence_refs: string[] = []) {
  return set_trust(skill_id, revision, 'active', 'Revision re-verified after semantic review.', evidence_refs)
}

export function list_skill_evidence(skill_id?: string, revision?: number) {
  const result: SkillEvidenceEvent[] = []
  for (const event of storage.sgluna_skill_evidence_events ?? []) {
    if (skill_id !== undefined && event.skill_id !== skill_id) continue
    if (revision !== undefined && event.revision !== revision) continue
    result.push(event)
  }
  return result
}
