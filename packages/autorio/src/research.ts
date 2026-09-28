import type { LuaForce, OnResearchFinishedEvent } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersResearchTechnology } from './types'
import { TaskStates } from './types'

const MAX_RESEARCH_QUEUE = 10
const MAX_TECHNOLOGY_RECORDS = 20
const MAX_REQUEST_RECORDS = 20
const STALL_TICKS = 60 * 60
const PROGRESS_EPSILON = 0.000001

type ResearchCode = 'queued' | 'started' | 'already_queued' | 'already_researched'
  | 'completed' | 'stalled' | 'interrupted'
  | 'invalid_name' | 'no_actor' | 'unknown_technology' | 'technology_disabled'
  | 'research_disabled' | 'missing_prerequisites' | 'trigger_research'
  | 'force_busy' | 'engine_rejected' | 'actor_changed'

type FollowState = 'queued' | 'running' | 'stalled' | 'completed' | 'interrupted'

interface ResearchResult {
  request_id: number
  accepted: boolean
  completed: boolean
  code: ResearchCode
  technology: string
  tick: number
  force_index?: number
  actor_id?: number
  actor_kind?: string
  requested_level?: number
  observed_level?: number
  progress?: number
  by_script?: boolean
}

interface ResearchFollowThrough {
  request_id: number
  technology: string
  force_index: number
  actor_id: number
  actor_kind: string
  requested_level: number
  state: FollowState
  submitted_tick: number
  started_tick?: number
  last_progress: number
  last_progress_tick: number
  completed_tick?: number
  observed_level?: number
  by_script?: boolean
}

declare const storage: {
  airi_next_research_request_id?: number
  airi_last_research_result?: ResearchResult
  airi_research_results?: ResearchResult[]
  airi_research_follow_through?: ResearchFollowThrough[]
}

function valid_name(name: string) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 32 || code === 127) return false
  }
  return true
}

function next_request_id() {
  const next = (storage.airi_next_research_request_id ?? 0) + 1
  storage.airi_next_research_request_id = next
  return next
}

function results() {
  if (!storage.airi_research_results) storage.airi_research_results = []
  return storage.airi_research_results
}

function follow_records() {
  if (!storage.airi_research_follow_through) storage.airi_research_follow_through = []
  return storage.airi_research_follow_through
}

function trim<T>(records: T[]) {
  while (records.length > MAX_REQUEST_RECORDS) records.shift()
}

function result_by_id(request_id: number) {
  for (const result of results()) {
    if (result.request_id === request_id) return result
  }
  return undefined
}

function follow_by_id(request_id: number) {
  for (const follow of follow_records()) {
    if (follow.request_id === request_id) return follow
  }
  return undefined
}

function queued(force: LuaForce, name: string) {
  return force.current_research?.name === name
    || (force.research_queue ?? []).some(tech => tech.name === name)
}

function queued_but_not_current(force: LuaForce, name: string) {
  if (force.current_research?.name === name) return false
  return (force.research_queue ?? []).some(tech => tech.name === name)
}

/** Admission is checked again when the serialized NPC task actually executes. */
export function research_error(actor: ControlledActor | undefined, name: string): ResearchCode | undefined {
  if (!valid_name(name)) return 'invalid_name'
  if (!actor || !actor.is_valid || !actor.character || !actor.force.valid) return 'no_actor'
  const force = actor.force
  const tech = force.technologies[name]
  if (!tech) return 'unknown_technology'
  if (tech.researched) return undefined
  if (!force.research_enabled) return 'research_disabled'
  if (!tech.enabled) return 'technology_disabled'
  if (tech.prototype.research_trigger) return 'trigger_research'
  if (queued(force, name)) return undefined
  for (const [, prerequisite] of pairs(tech.prerequisites)) {
    if (!prerequisite.researched) return 'missing_prerequisites'
  }
  if (force.current_research || (force.research_queue ?? []).length > 0) return 'force_busy'
  return undefined
}

function push_result(result: ResearchResult) {
  // Follow-through for an older asynchronous request may finish after a newer
  // request was submitted. Keep last_request_result pinned to the greatest
  // request id while still updating the older request in correlated history.
  const last = storage.airi_last_research_result
  if (!last || result.request_id >= last.request_id) {
    storage.airi_last_research_result = result
  }
  const history = results()
  let replaced = false
  for (let i = 0; i < history.length; i++) {
    if (history[i]?.request_id === result.request_id) {
      history[i] = result
      replaced = true
      break
    }
  }
  if (!replaced) {
    history.push(result)
    trim(history)
  }
  return result
}

function record_result(
  request_id: number,
  actor: ControlledActor | undefined,
  name: string,
  accepted: boolean,
  completed: boolean,
  code: ResearchCode,
  details: Partial<ResearchResult> = {},
): ResearchResult {
  const identity = actor?.is_valid ? actor.status_snapshot() : undefined
  return push_result({
    request_id,
    accepted,
    completed,
    code,
    technology: valid_name(name) ? name : '<invalid>',
    tick: game.tick,
    force_index: details.force_index ?? (actor?.is_valid ? actor.force.index : undefined),
    actor_id: details.actor_id ?? identity?.actor_id,
    actor_kind: details.actor_kind ?? identity?.kind,
    ...details,
  })
}

function start_follow(task: PlayerParametersResearchTechnology, actor: ControlledActor, state: FollowState) {
  if (task.request_id === undefined || task.requested_level === undefined || task.owner_actor_id === undefined
    || task.owner_actor_kind === undefined || task.owner_force_index === undefined) return
  const force = actor.force
  const progress = force.current_research?.name === task.technology_name ? force.research_progress : 0
  const record: ResearchFollowThrough = {
    request_id: task.request_id,
    technology: task.technology_name,
    force_index: task.owner_force_index,
    actor_id: task.owner_actor_id,
    actor_kind: task.owner_actor_kind,
    requested_level: task.requested_level,
    state,
    submitted_tick: game.tick,
    started_tick: state === 'running' ? game.tick : undefined,
    last_progress: progress,
    last_progress_tick: game.tick,
    observed_level: force.technologies[task.technology_name]?.level,
  }
  const records = follow_records()
  let replaced = false
  for (let i = 0; i < records.length; i++) {
    if (records[i]?.request_id === record.request_id) {
      records[i] = record
      replaced = true
      break
    }
  }
  if (!replaced) {
    records.push(record)
    trim(records)
  }
}

function update_follow_result(actor: ControlledActor | undefined, follow: ResearchFollowThrough, code: ResearchCode, completed: boolean, details: Partial<ResearchResult> = {}) {
  return record_result(follow.request_id, actor, follow.technology, true, completed, code, {
    force_index: follow.force_index,
    actor_id: follow.actor_id,
    actor_kind: follow.actor_kind,
    requested_level: follow.requested_level,
    observed_level: follow.observed_level,
    progress: follow.last_progress,
    by_script: follow.by_script,
    ...details,
  })
}

export function execute_research_request(actor: ControlledActor, task: PlayerParametersResearchTechnology): ResearchResult {
  const request_id = task.request_id ?? next_request_id()
  task.request_id = request_id
  const identity = actor.status_snapshot()
  if (task.owner_actor_id === undefined || task.owner_force_index === undefined
    || identity.actor_id !== task.owner_actor_id || identity.kind !== task.owner_actor_kind
    || actor.force.index !== task.owner_force_index) {
    return record_result(request_id, actor, task.technology_name, false, false, 'actor_changed', {
      actor_id: task.owner_actor_id,
      actor_kind: task.owner_actor_kind,
      force_index: task.owner_force_index,
      requested_level: task.requested_level,
    })
  }
  const error = research_error(actor, task.technology_name)
  if (error) return record_result(request_id, actor, task.technology_name, false, false, error)

  const force = actor.force
  const tech = force.technologies[task.technology_name]
  if (task.requested_level === undefined) task.requested_level = tech.level

  if (tech.researched) {
    start_follow(task, actor, 'completed')
    const follow = follow_by_id(request_id)
    if (follow) {
      follow.completed_tick = game.tick
      follow.observed_level = tech.level
    }
    return record_result(request_id, actor, task.technology_name, true, true, 'already_researched', {
      requested_level: task.requested_level,
      observed_level: tech.level,
    })
  }

  if (queued(force, tech.name)) {
    const state: FollowState = queued_but_not_current(force, tech.name) ? 'queued' : 'running'
    start_follow(task, actor, state)
    return record_result(request_id, actor, task.technology_name, true, false, 'already_queued', {
      requested_level: task.requested_level,
      observed_level: tech.level,
      progress: force.current_research?.name === tech.name ? force.research_progress : 0,
    })
  }

  const accepted = force.add_research(tech)
  if (!accepted) {
    return record_result(request_id, actor, task.technology_name, false, false, 'engine_rejected', {
      requested_level: task.requested_level,
      observed_level: tech.level,
    })
  }
  start_follow(task, actor, 'running')
  return record_result(request_id, actor, task.technology_name, true, false, 'started', {
    requested_level: task.requested_level,
    observed_level: tech.level,
    progress: force.research_progress,
  })
}

export function new_research_controller(get_actor: () => ControlledActor | undefined, manager: ReturnType<typeof new_task_manager>) {
  function submit(name: string): [boolean, string, number] {
    const request_id = next_request_id()
    const actor = get_actor()
    const error = research_error(actor, name)
    if (error || !actor) {
      const result = record_result(request_id, actor, name, false, false, error ?? 'no_actor')
      log(`[AUTORIO] [ERROR] Research request ${request_id} rejected: ${result.technology}: ${result.code}`)
      return [false, result.code, request_id]
    }
    const identity = actor.status_snapshot()
    if (identity.actor_id === undefined) {
      record_result(request_id, actor, name, false, false, 'no_actor')
      return [false, 'no_actor', request_id]
    }
    const tech = actor.force.technologies[name]
    manager.add_task({
      type: TaskStates.RESEARCHING,
      request_id,
      technology_name: name,
      requested_level: tech.level,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
    })
    record_result(request_id, actor, name, true, false, 'queued', {
      requested_level: tech.level,
      observed_level: tech.level,
    })
    return [true, 'Research request queued; verify technology completion separately', request_id]
  }

  function tick(actor: ControlledActor) {
    const task = manager.player_state().parameters_research_technology
    if (!task || manager.player_state().task_state !== TaskStates.RESEARCHING) return
    const result = execute_research_request(actor, task)
    if (!result.accepted) {
      manager.cancel_all_tasks()
      log(`[AUTORIO] [ERROR] Research request ${result.request_id} rejected: ${result.technology}: ${result.code}; queued operations cancelled`)
      return
    }
    log(`[AUTORIO] Research request ${result.request_id} accepted: ${result.technology}: ${result.code}; verify completion separately`)
    manager.reset_task_state()
    manager.next_task()
  }

  function follow(actor: ControlledActor) {
    const force = actor.force
    for (const record of follow_records()) {
      if (record.force_index !== force.index || record.state === 'completed' || record.state === 'interrupted') continue
      const tech = force.technologies[record.technology]
      if (!tech) {
        record.state = 'interrupted'
        update_follow_result(actor, record, 'interrupted', false)
        continue
      }
      record.observed_level = tech.level

      if (tech.researched || tech.level > record.requested_level) {
        record.state = 'completed'
        record.completed_tick = game.tick
        update_follow_result(actor, record, 'completed', true, { observed_level: tech.level })
        continue
      }

      if (force.current_research?.name === record.technology) {
        const progress = force.research_progress
        if (progress > record.last_progress + PROGRESS_EPSILON) {
          record.last_progress = progress
          record.last_progress_tick = game.tick
          record.state = 'running'
          const current = result_by_id(record.request_id)
          if (current?.code === 'stalled') {
            update_follow_result(actor, record, 'started', false, { progress })
          }
        }
        else if (game.tick - record.last_progress_tick >= STALL_TICKS && record.state !== 'stalled') {
          record.state = 'stalled'
          update_follow_result(actor, record, 'stalled', false, { progress })
        }
        continue
      }

      if (queued_but_not_current(force, record.technology)) {
        record.state = 'queued'
        continue
      }

      record.state = 'interrupted'
      update_follow_result(actor, record, 'interrupted', false, { observed_level: tech.level })
    }
  }

  function on_research_finished(event: OnResearchFinishedEvent) {
    const tech = event.research
    const force = tech.force
    for (const record of follow_records()) {
      if (record.force_index !== force.index || record.technology !== tech.name
        || record.state === 'completed' || record.state === 'interrupted') continue
      if (!tech.researched && tech.level <= record.requested_level) continue
      record.state = 'completed'
      record.completed_tick = event.tick
      record.observed_level = tech.level
      record.by_script = event.by_script
      update_follow_result(get_actor(), record, 'completed', true, {
        observed_level: tech.level,
        by_script: event.by_script,
      })
    }
  }

  function request_result(request_id: number) {
    if (typeof request_id !== 'number' || request_id !== math.floor(request_id) || request_id < 1) {
      return { found: false, error: 'invalid_request_id' }
    }
    const result = result_by_id(request_id)
    const follow = follow_by_id(request_id)
    if (!result && !follow) return { found: false, error: 'unknown_request_id', request_id }
    return { found: true, request_id, result, follow_through: follow }
  }

  function status() {
    const actor = get_actor()
    if (!actor || !actor.is_valid) return { error: 'no_actor' }
    follow(actor)
    const force = actor.force
    const queue = force.research_queue ?? []
    const current = force.current_research
    const result = storage.airi_last_research_result
    const recent = results()
    const follows = follow_records()
    return {
      force: force.name,
      force_index: force.index,
      research_enabled: force.research_enabled,
      current: current ? { name: current.name, level: current.level } : undefined,
      progress: current ? force.research_progress : undefined,
      queue: queue.slice(0, MAX_RESEARCH_QUEUE).map(tech => ({ name: tech.name, level: tech.level })),
      queue_length: queue.length,
      queue_truncated: queue.length > MAX_RESEARCH_QUEUE,
      next_request_id: storage.airi_next_research_request_id ?? 0,
      last_request_result: result,
      recent_requests: recent.slice(math.max(0, recent.length - MAX_RESEARCH_QUEUE)),
      follow_through: follows.slice(math.max(0, follows.length - MAX_RESEARCH_QUEUE)),
    }
  }

  function technology(name: string) {
    const actor = get_actor()
    if (!actor || !actor.is_valid) return { found: false, error: 'no_actor' }
    if (!valid_name(name)) return { found: false, error: 'invalid_name' }
    const tech = actor.force.technologies[name]
    if (!tech) return { found: false, error: 'unknown_technology' }
    const prerequisites: Array<{ name: string, researched: boolean }> = []
    let prerequisite_count = 0
    for (const [prerequisite_name, prerequisite] of pairs(tech.prerequisites)) {
      prerequisite_count += 1
      if (prerequisites.length < MAX_TECHNOLOGY_RECORDS) {
        prerequisites.push({ name: prerequisite_name, researched: prerequisite.researched })
      }
    }
    const trigger = tech.prototype.research_trigger
    const ingredients = trigger ? [] : tech.research_unit_ingredients
    return {
      found: true,
      name: tech.name,
      level: tech.level,
      max_level: tech.prototype.max_level,
      researched: tech.researched,
      enabled: tech.enabled,
      request_error: research_error(actor, name),
      trigger_type: trigger?.type,
      research_unit_count: trigger ? undefined : tech.research_unit_count,
      research_unit_energy: trigger ? undefined : tech.research_unit_energy,
      saved_progress: tech.saved_progress,
      ingredients: ingredients.slice(0, MAX_TECHNOLOGY_RECORDS).map(item => ({ name: item.name, amount: item.amount })),
      ingredients_truncated: ingredients.length > MAX_TECHNOLOGY_RECORDS,
      prerequisites,
      prerequisites_truncated: prerequisite_count > MAX_TECHNOLOGY_RECORDS,
    }
  }

  script.on_event(defines.events.on_research_finished, (event: OnResearchFinishedEvent) => on_research_finished(event))

  return { submit, tick, follow, on_research_finished, status, technology, request_result }
}
