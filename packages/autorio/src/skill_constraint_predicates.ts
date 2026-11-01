export type SkillTopologyRelationKind
  = | 'item_transfer'
    | 'belt_input'
    | 'belt_output'
    | 'direct_item_output'
    | 'fluid_connection'
    | 'adjacent'
    | 'custom'

export type SkillConstraintPredicate
  = | { type: 'translated_rebuild' }
    | {
      type: 'required_topology_relation'
      relation_kind: SkillTopologyRelationKind
      from?: string
      to?: string
      via?: string
    }
    | {
      type: 'output_delta'
      item: string
      minimum_delta: number
    }
    | {
      type: 'resource_coverage'
      resource: string
      minimum_entities: number
      minimum_amount?: number
    }

const RELATION_KINDS: readonly SkillTopologyRelationKind[] = [
  'item_transfer',
  'belt_input',
  'belt_output',
  'direct_item_output',
  'fluid_connection',
  'adjacent',
  'custom',
]

function plain_object(value: unknown): value is Record<string, unknown> {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clean_text(value: unknown, label: string, max: number) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  let result = value.split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (result.includes('  ')) result = result.split('  ').join(' ')
  if (result.length === 0) throw new Error(`${label} must not be empty`)
  if (result.length > max) throw new Error(`${label} exceeds ${max} characters`)
  return result
}

function optional_text(value: unknown, label: string, max: number) {
  if (value === undefined || value === null) return undefined
  return clean_text(value, label, max)
}

function positive_integer(value: unknown, label: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || value < 1 || value % 1 !== 0) throw new Error(`${label} must be a positive integer`)
  return value
}

function assert_keys(raw: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is not supported`)
  }
}

function relation_kind(value: unknown, label: string): SkillTopologyRelationKind {
  for (const candidate of RELATION_KINDS) if (value === candidate) return candidate
  throw new Error(`${label} is invalid`)
}

export function canonicalize_skill_constraint_predicate(value: unknown, label = 'constraint predicate'): SkillConstraintPredicate {
  if (!plain_object(value)) throw new Error(`${label} must be an object`)
  const type = clean_text(value.type, `${label}.type`, 80)

  if (type === 'translated_rebuild') {
    assert_keys(value, ['type'], label)
    return { type }
  }

  if (type === 'required_topology_relation') {
    assert_keys(value, ['type', 'relation_kind', 'from', 'to', 'via'], label)
    const predicate: Extract<SkillConstraintPredicate, { type: 'required_topology_relation' }> = {
      type,
      relation_kind: relation_kind(value.relation_kind, `${label}.relation_kind`),
    }
    const from = optional_text(value.from, `${label}.from`, 120)
    const to = optional_text(value.to, `${label}.to`, 120)
    const via = optional_text(value.via, `${label}.via`, 120)
    if (from !== undefined) predicate.from = from
    if (to !== undefined) predicate.to = to
    if (via !== undefined) predicate.via = via
    if (from === undefined && to === undefined && via === undefined) throw new Error(`${label} requires at least one topology endpoint`)
    return predicate
  }

  if (type === 'output_delta') {
    assert_keys(value, ['type', 'item', 'minimum_delta'], label)
    return {
      type,
      item: clean_text(value.item, `${label}.item`, 200),
      minimum_delta: positive_integer(value.minimum_delta, `${label}.minimum_delta`, 1),
    }
  }

  if (type === 'resource_coverage') {
    assert_keys(value, ['type', 'resource', 'minimum_entities', 'minimum_amount'], label)
    const predicate: Extract<SkillConstraintPredicate, { type: 'resource_coverage' }> = {
      type,
      resource: clean_text(value.resource, `${label}.resource`, 200),
      minimum_entities: positive_integer(value.minimum_entities, `${label}.minimum_entities`, 1),
    }
    if (value.minimum_amount !== undefined) predicate.minimum_amount = positive_integer(value.minimum_amount, `${label}.minimum_amount`)
    return predicate
  }

  throw new Error(`${label}.type is invalid`)
}

export function skill_constraint_predicate_signature(predicate: SkillConstraintPredicate | undefined) {
  if (predicate === undefined) return ''
  if (predicate.type === 'translated_rebuild') return 'translated_rebuild'
  if (predicate.type === 'required_topology_relation') {
    return [
      'required_topology_relation',
      predicate.relation_kind,
      predicate.from ?? '',
      predicate.to ?? '',
      predicate.via ?? '',
    ].join('|')
  }
  if (predicate.type === 'output_delta') return ['output_delta', predicate.item, predicate.minimum_delta].join('|')
  return ['resource_coverage', predicate.resource, predicate.minimum_entities, predicate.minimum_amount ?? ''].join('|')
}
