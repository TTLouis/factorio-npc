import type { ControlledActor } from './actors/types'
import { research_error } from './research'
import { plan_research_path } from './research_path'

const MAX_PREFLIGHT_PENDING_NODES = 12
const MAX_PREFLIGHT_PREREQUISITES = 8
const MAX_PREFLIGHT_INGREDIENTS = 8
const MAX_PREFLIGHT_QUEUE = 8
const MAX_PREFLIGHT_BLOCKERS = 8
const RESEARCH_PATH_MAX_NODES = 64

function bounded_array<T>(values: T[] | undefined, limit: number): T[] {
  const result: T[] = []
  if (!values) return result
  for (let index = 0; index < values.length && index < limit; index++) {
    result.push(values[index])
  }
  return result
}

function bounded_node(node: any) {
  if (!node || typeof node !== 'object') return undefined
  const prerequisites = node.prerequisites ?? []
  const unresolved = node.unresolved_prerequisites ?? []
  const result: Record<string, unknown> = {
    name: node.name,
    level: node.level,
    status: node.status,
    mode: node.mode,
    required_action: node.required_action,
    prerequisites: bounded_array(prerequisites, MAX_PREFLIGHT_PREREQUISITES),
    prerequisites_truncated: prerequisites.length > MAX_PREFLIGHT_PREREQUISITES,
    unresolved_prerequisites: bounded_array(unresolved, MAX_PREFLIGHT_PREREQUISITES),
    unresolved_prerequisites_truncated: unresolved.length > MAX_PREFLIGHT_PREREQUISITES,
  }
  if (node.research_trigger) result.research_trigger = node.research_trigger
  if (node.science && typeof node.science === 'object') {
    const ingredients = node.science.ingredients ?? []
    result.science = {
      count: node.science.count,
      energy: node.science.energy,
      ingredients: bounded_array(ingredients, MAX_PREFLIGHT_INGREDIENTS),
      ingredients_truncated: ingredients.length > MAX_PREFLIGHT_INGREDIENTS,
    }
  }
  return result
}

function bounded_path(path: any) {
  if (!path || typeof path !== 'object') return undefined
  if (path.ok !== true) {
    return {
      ok: false,
      target: path.target,
      error: path.error,
    }
  }

  const pending = path.pending_path ?? []
  const blockers = path.blockers ?? []
  return {
    ok: true,
    target: path.target,
    target_researched: path.target_researched,
    node_count: path.node_count,
    pending_count: path.pending_count,
    blocked: path.blocked,
    requested: bounded_path_node(path, path.target),
    pending_path: bounded_array(pending, MAX_PREFLIGHT_PENDING_NODES).map(bounded_node),
    pending_path_truncated: pending.length > MAX_PREFLIGHT_PENDING_NODES,
    blockers: bounded_array(blockers, MAX_PREFLIGHT_BLOCKERS).map(bounded_node),
    blockers_truncated: blockers.length > MAX_PREFLIGHT_BLOCKERS,
  }
}

function bounded_path_node(path: any, name: string) {
  if (!path || path.ok !== true) return undefined
  const nodes = path.nodes ?? []
  for (const node of nodes) {
    if (node?.name === name) return bounded_node(node)
  }
  return undefined
}

function queue_summary(force: any) {
  const queue = force.research_queue ?? []
  return {
    queue: bounded_array(queue, MAX_PREFLIGHT_QUEUE).map((technology: any) => ({
      name: technology.name,
      level: technology.level,
    })),
    queue_length: queue.length,
    queue_truncated: queue.length > MAX_PREFLIGHT_QUEUE,
  }
}

function current_research_summary(force: any) {
  const current = force.current_research
  if (!current) return undefined
  return {
    name: current.name,
    level: current.level,
    progress: force.research_progress,
  }
}

function requested_is_queued(force: any, name: string) {
  if (force.current_research?.name === name) return true
  const queue = force.research_queue ?? []
  for (const technology of queue) {
    if (technology?.name === name) return true
  }
  return false
}

function reject(code: string, technology: string, details: Record<string, unknown> = {}) {
  return {
    ok: false,
    code,
    operation: 'research_technology',
    technology,
    ...details,
  }
}

export function research_operation_preflight(actor: ControlledActor | undefined, name: any) {
  const code = research_error(actor, name)
  const technology_name = code === 'invalid_name'
    ? '<invalid>'
    : typeof name === 'string'
      ? name
      : '<invalid>'

  if (code === 'invalid_name' || code === 'no_actor' || code === 'unknown_technology') {
    return reject(code, technology_name)
  }

  if (!actor || !actor.is_valid || !actor.character || !actor.force.valid) {
    return reject('no_actor', technology_name)
  }

  const force = actor.force
  const technology = force.technologies[technology_name]
  if (!technology) return reject('unknown_technology', technology_name)

  if (code === undefined) {
    const queued = requested_is_queued(force, technology_name)
    const state = technology.researched
      ? 'already_researched'
      : queued
        ? 'already_queued'
        : 'ready'
    return {
      ok: true,
      operation: 'research_technology',
      technology: technology_name,
      state,
      level: technology.level,
      ...(queued
        ? {
            current_research: current_research_summary(force),
            ...queue_summary(force),
          }
        : {}),
    }
  }

  if (code === 'missing_prerequisites' || code === 'trigger_research') {
    const path: any = plan_research_path(actor, technology_name, RESEARCH_PATH_MAX_NODES)
    const next_actionable = path?.ok === true ? bounded_node(path.next_actionable) : undefined
    const requested = path?.ok === true ? bounded_path_node(path, technology_name) : undefined
    return reject(code, technology_name, {
      requested,
      research_path: bounded_path(path),
      next_actionable,
      ...(code === 'trigger_research'
        ? { research_trigger: requested?.research_trigger }
        : {}),
    })
  }

  if (code === 'force_busy') {
    return reject(code, technology_name, {
      current_research: current_research_summary(force),
      ...queue_summary(force),
    })
  }

  return reject(code, technology_name, {
    state: code === 'technology_disabled'
      ? 'disabled'
      : code === 'research_disabled'
        ? 'research_disabled'
        : 'rejected',
  })
}
