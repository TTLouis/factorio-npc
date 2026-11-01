import type { ControlledActor } from './actors/types'
import { research_trigger_summary } from './research_trigger'

const DEFAULT_MAX_NODES = 32
const MAX_NODES = 64
const MAX_INGREDIENTS = 16

type ResearchPathStatus = 'already_researched' | 'ready' | 'blocked_by_prerequisites' | 'disabled' | 'research_disabled'
type ResearchPathMode = 'trigger' | 'science'

function array_length<T>(values: T[] | undefined): number {
  return values ? values.length : 0
}

function bounded_array<T>(values: T[] | undefined, limit: number): T[] {
  const result: T[] = []
  if (!values) return result
  for (let index = 0; index < array_length(values) && index < limit; index++) {
    result.push(values[index])
  }
  return result
}

function valid_name(name: string) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 200) return false
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 32 || code === 127) return false
  }
  return true
}

function valid_node_limit(value: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= 1 && value <= MAX_NODES
}

function prerequisite_names(technology: any) {
  const names: string[] = []
  for (const name in technology.prerequisites) names.push(name)
  names.sort()
  return names
}

function node_status(actor: ControlledActor, technology: any, prerequisites: string[]): ResearchPathStatus {
  if (technology.researched) return 'already_researched'
  if (!technology.enabled) return 'disabled'
  if (!actor.force.research_enabled) return 'research_disabled'
  for (const name of prerequisites) {
    const prerequisite = actor.force.technologies[name]
    if (!prerequisite?.researched) return 'blocked_by_prerequisites'
  }
  return 'ready'
}

function node_summary(actor: ControlledActor, technology: any) {
  const prerequisites = prerequisite_names(technology)
  const unresolved_prerequisites = prerequisites.filter(name => !actor.force.technologies[name]?.researched)
  const trigger = research_trigger_summary(technology.name)
  const mode: ResearchPathMode = trigger ? 'trigger' : 'science'
  const ingredients: any[] = trigger ? [] : (technology.research_unit_ingredients ?? [])
  return {
    name: technology.name,
    level: technology.level,
    max_level: technology.prototype.max_level,
    researched: technology.researched,
    enabled: technology.enabled,
    mode,
    status: node_status(actor, technology, prerequisites),
    prerequisites,
    unresolved_prerequisites,
    research_trigger: trigger,
    science: trigger
      ? undefined
      : {
          count: technology.research_unit_count,
          energy: technology.research_unit_energy,
          ingredients: bounded_array(ingredients, MAX_INGREDIENTS).map((item: any) => ({ name: item.name, amount: item.amount })),
          ingredients_truncated: array_length(ingredients) > MAX_INGREDIENTS,
        },
    required_action: technology.researched
      ? 'none'
      : trigger
        ? 'perform_research_trigger_then_verify'
        : 'research_technology_then_verify',
  }
}

export function plan_research_path(actor: ControlledActor, target_name: string, max_nodes: number = DEFAULT_MAX_NODES) {
  if (!valid_name(target_name)) {
    return { ok: false, error: { code: 'INVALID_NAME', message: 'technology name is invalid' } }
  }
  if (!valid_node_limit(max_nodes)) {
    return { ok: false, error: { code: 'INVALID_LIMIT', message: `max_nodes must be an integer from 1 to ${MAX_NODES}` } }
  }

  const target = actor.force.technologies[target_name]
  if (!target) {
    return { ok: false, error: { code: 'UNKNOWN_TECHNOLOGY', message: `unknown technology ${target_name}` } }
  }

  const visited: Record<string, boolean> = {}
  const visiting: Record<string, boolean> = {}
  const ordered_names: string[] = []
  let too_large = false
  let cycle_name: string | undefined

  function visit(name: string) {
    if (too_large || cycle_name || visited[name]) return
    if (visiting[name]) {
      cycle_name = name
      return
    }
    if (ordered_names.length >= max_nodes) {
      too_large = true
      return
    }

    const technology = actor.force.technologies[name]
    if (!technology) return
    visiting[name] = true
    const prerequisites = prerequisite_names(technology)
    for (const prerequisite of prerequisites) {
      visit(prerequisite)
      if (too_large || cycle_name) break
    }
    visiting[name] = false
    if (too_large || cycle_name || visited[name]) return
    if (ordered_names.length >= max_nodes) {
      too_large = true
      return
    }
    visited[name] = true
    ordered_names.push(name)
  }

  visit(target_name)

  if (cycle_name) {
    return {
      ok: false,
      target: target_name,
      error: { code: 'DEPENDENCY_CYCLE', message: `technology dependency cycle detected at ${cycle_name}` },
    }
  }
  if (too_large) {
    return {
      ok: false,
      target: target_name,
      error: {
        code: 'PATH_TOO_LARGE',
        message: `technology dependency path exceeds max_nodes=${max_nodes}; request a narrower prerequisite target instead of using an incomplete path`,
      },
    }
  }

  const nodes = ordered_names.map(name => node_summary(actor, actor.force.technologies[name]))
  const pending = nodes.filter(node => !node.researched)
  const blocked = pending.filter(node => node.status === 'disabled' || node.status === 'research_disabled')
  const next = pending.find(node => node.status === 'ready')
  return {
    ok: true,
    target: target_name,
    target_researched: target.researched,
    node_count: nodes.length,
    pending_count: pending.length,
    nodes,
    pending_path: pending,
    next_actionable: next,
    blocked: blocked.length > 0,
    blockers: blocked,
    semantics: 'pending_path is dependency-first and contains only technologies not currently researched. trigger nodes require the exact returned research_trigger; science nodes use research_technology and must still be verified after submission.',
  }
}
