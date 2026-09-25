import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { resolve_exact_entity } from './entity_reference'
import { throughput_capacity } from './throughput_capacity'

export type ThroughputMeasurementRequest
  = | {
    kind: 'inserter_instance'
    unit_number: number
    item_name?: string
    warmup_ticks?: number
    window_ticks?: number
    required_rate_per_second?: number
    utilization_limit?: number
  }
  | {
    kind: 'belt_lane'
    unit_number: number
    lane_index: 1 | 2
    item_name?: string
    warmup_ticks?: number
    window_ticks?: number
    required_rate_per_second?: number
    utilization_limit?: number
    required_stack_size?: number
  }

export type ThroughputMeasurementState = 'running' | 'complete' | 'failed' | 'cancelled'

const MAX_NAME_LENGTH = 200
const MIN_WINDOW_TICKS = 60
const MAX_WINDOW_TICKS = 60 * 60
const MAX_WARMUP_TICKS = 60 * 10
const DEFAULT_WINDOW_TICKS = 60 * 5
const DEFAULT_WARMUP_TICKS = 60
const DEFAULT_UTILIZATION_LIMIT = 0.8
const MAX_RATE = 1_000_000_000
const MAX_MEASUREMENTS = 16
const MAX_ACTIVE_MEASUREMENTS = 4
const MAX_DETAILED_ITEMS = 2000
const LOCAL_BELT_SAMPLE_DISTANCE = 2

interface HeldSample {
  name?: string
  count: number
}

interface BeltItemSample {
  projection: number
  name: string
  count: number
}

interface MeasurementRecord {
  id: number
  state: ThroughputMeasurementState
  request: ThroughputMeasurementRequest
  actor_id: number
  actor_kind: string
  force_index: number
  surface_index: number
  entity_name: string
  entity_direction: number
  force_inserter_stack_size_bonus: number
  force_bulk_inserter_capacity_bonus: number
  force_belt_stack_size_bonus: number
  inserter_stack_size_override?: number
  started_tick: number
  warmup_until_tick: number
  completes_at_tick: number
  completed_tick?: number
  error_code?: string
  error_message?: string
  previous_held?: HeldSample
  previous_belt_items?: Record<string, BeltItemSample>
  picked_up_items: number
  delivered_items: number
  pickup_events: number
  drop_events: number
  max_hand_observed: number
  active_ticks: number
  loaded_ticks: number
  crossing_items: number
  crossing_events: number
  stacked_crossing_items: number
  min_stack_observed?: number
  max_stack_observed: number
  stack_count_sum: number
  final_result?: unknown
}

declare const storage: {
  airi_next_throughput_measurement_id?: number
  airi_throughput_measurements?: Record<number, MeasurementRecord>
}

function measurements() {
  if (!storage.airi_throughput_measurements) storage.airi_throughput_measurements = {}
  return storage.airi_throughput_measurements
}

function valid_integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function valid_positive_number(value: unknown, max: number = MAX_RATE): value is number {
  return typeof value === 'number' && value === value && value > 0 && value < math.huge && value <= max
}

function valid_name(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_NAME_LENGTH
}

function fail(message: string, code = 'INVALID_REQUEST') {
  return { ok: false as const, error: { code, message } }
}

function copy_position(position: { x: number, y: number }) {
  return { x: position.x, y: position.y }
}

function entity_summary(entity: any) {
  if (!entity || !entity.valid) return undefined
  return {
    name: entity.name,
    type: entity.type,
    unit_number: entity.unit_number,
    position: copy_position(entity.position),
    direction: entity.direction,
  }
}

function active_count() {
  let count = 0
  for (const [, record] of pairs(measurements())) if (record.state === 'running') count++
  return count
}

function prune_measurements() {
  const table = measurements()
  const completed: MeasurementRecord[] = []
  let total = 0
  for (const [, record] of pairs(table)) {
    total++
    if (record.state !== 'running') completed.push(record)
  }
  if (total < MAX_MEASUREMENTS) return
  completed.sort((a, b) => (a.completed_tick ?? a.started_tick) - (b.completed_tick ?? b.started_tick))
  let remove = total - MAX_MEASUREMENTS + 1
  for (const record of completed) {
    if (remove <= 0) break
    table[record.id] = undefined as any
    remove--
  }
}

function request_window(request: ThroughputMeasurementRequest) {
  const warmup = request.warmup_ticks ?? DEFAULT_WARMUP_TICKS
  const window = request.window_ticks ?? DEFAULT_WINDOW_TICKS
  const utilization = request.utilization_limit ?? DEFAULT_UTILIZATION_LIMIT
  if (!valid_integer(warmup, 0, MAX_WARMUP_TICKS)) return fail(`warmup_ticks must be an integer from 0 to ${MAX_WARMUP_TICKS}`)
  if (!valid_integer(window, MIN_WINDOW_TICKS, MAX_WINDOW_TICKS)) return fail(`window_ticks must be an integer from ${MIN_WINDOW_TICKS} to ${MAX_WINDOW_TICKS}`)
  if (!valid_positive_number(utilization, 1)) return fail('utilization_limit must be > 0 and <= 1')
  if (request.required_rate_per_second !== undefined && !valid_positive_number(request.required_rate_per_second)) {
    return fail('required_rate_per_second must be positive and bounded when provided')
  }
  if (request.item_name !== undefined) {
    if (!valid_name(request.item_name)) return fail('item_name must be a bounded non-empty string')
    if (!(prototypes.item as any)[request.item_name]) return fail(`item prototype not found: ${request.item_name}`)
  }
  if (request.kind === 'belt_lane' && request.required_stack_size !== undefined && !valid_integer(request.required_stack_size, 1, 255)) {
    return fail('required_stack_size must be an integer from 1 to 255')
  }
  return { ok: true as const, warmup, window, utilization }
}

function resolve_entity(actor: ControlledActor, unit_number: number) {
  if (!valid_integer(unit_number, 1, 9007199254740991)) return fail('unit_number must be a positive safe integer')
  // Factorio only indexes prototypes flagged get-by-unit-number, which belts
  // and inserters are not; resolve through the observation hint instead.
  const entity = resolve_exact_entity(actor, unit_number)
  if (!entity || !entity.valid) return fail(`entity not found: ${unit_number}`)
  if (entity.surface.index !== actor.surface.index) return fail('entity is on another surface')
  if (entity.force?.index !== undefined && entity.force.index !== actor.force.index) return fail('entity belongs to another force')
  return { ok: true as const, entity }
}

function context_matches(actor: ControlledActor, entity: any, record: MeasurementRecord) {
  const identity = actor.status_snapshot()
  if (identity.actor_id !== record.actor_id || identity.kind !== record.actor_kind) return false
  if (actor.force.index !== record.force_index || actor.surface.index !== record.surface_index) return false
  if (entity.name !== record.entity_name || entity.direction !== record.entity_direction) return false
  if ((actor.force.inserter_stack_size_bonus ?? 0) !== record.force_inserter_stack_size_bonus) return false
  if ((actor.force.bulk_inserter_capacity_bonus ?? 0) !== record.force_bulk_inserter_capacity_bonus) return false
  if ((actor.force.belt_stack_size_bonus ?? 0) !== record.force_belt_stack_size_bonus) return false
  if (record.request.kind === 'inserter_instance' && (entity.inserter_stack_size_override ?? 0) !== (record.inserter_stack_size_override ?? 0)) return false
  return true
}

function held_sample(entity: any): HeldSample {
  const held = entity.held_stack
  if (!held?.valid_for_read) return { count: 0 }
  return { name: held.name, count: held.count }
}

function matches_item(filter: string | undefined, name: string | undefined) {
  return filter === undefined || filter === name
}

function sample_inserter(entity: any, record: MeasurementRecord, count_metrics: boolean) {
  const current = held_sample(entity)
  const previous = record.previous_held ?? { count: 0 }
  record.previous_held = current
  if (!count_metrics) return

  if (entity.active) record.active_ticks++
  if (current.count > 0) record.loaded_ticks++
  if (matches_item(record.request.item_name, current.name)) record.max_hand_observed = math.max(record.max_hand_observed, current.count)

  if (previous.name === current.name) {
    const delta = current.count - previous.count
    if (delta > 0 && matches_item(record.request.item_name, current.name)) {
      record.picked_up_items += delta
      record.pickup_events++
    }
    else if (delta < 0 && matches_item(record.request.item_name, previous.name)) {
      record.delivered_items += -delta
      record.drop_events++
    }
    return
  }

  if (previous.count > 0 && matches_item(record.request.item_name, previous.name)) {
    record.delivered_items += previous.count
    record.drop_events++
  }
  if (current.count > 0 && matches_item(record.request.item_name, current.name)) {
    record.picked_up_items += current.count
    record.pickup_events++
  }
}

function belt_direction_vector(direction: number) {
  if (direction === defines.direction.north) return { x: 0, y: -1 }
  if (direction === defines.direction.east) return { x: 1, y: 0 }
  if (direction === defines.direction.south) return { x: 0, y: 1 }
  if (direction === defines.direction.west) return { x: -1, y: 0 }
  return undefined
}

// Typed so TypeScriptToLua emits dot calls and `#`: Factorio rejects the
// self argument of a colon call, and an untyped `.length` is nil in Lua.
function belt_items(entity: LuaEntity, lane_index: 1 | 2) {
  if (entity.type !== 'transport-belt') return fail(`belt lane measurement currently supports transport-belt entities only, got ${entity.type}`, 'UNSUPPORTED_MEASUREMENT')
  const max_line = entity.get_max_transport_line_index()
  if (max_line < lane_index) return fail(`transport line ${lane_index} is unavailable`, 'UNSUPPORTED_MEASUREMENT')
  const direction = belt_direction_vector(entity.direction)
  if (!direction) return fail(`unsupported belt direction: ${entity.direction}`, 'UNSUPPORTED_MEASUREMENT')
  const line = entity.get_transport_line(lane_index)
  if (!line || !line.valid) return fail(`transport line ${lane_index} is unavailable`, 'UNSUPPORTED_MEASUREMENT')
  const detailed = line.get_detailed_contents()
  if (detailed.length > MAX_DETAILED_ITEMS) {
    return fail(`transport line sample contains ${detailed.length} stacks; maximum is ${MAX_DETAILED_ITEMS}`, 'MEASUREMENT_TOO_LARGE')
  }

  const result: Record<string, BeltItemSample> = {}
  for (const item of detailed) {
    const stack = item.stack
    if (!stack?.valid_for_read) continue
    const world = line.get_line_item_position(item.position)
    const projection = (world.x - entity.position.x) * direction.x + (world.y - entity.position.y) * direction.y
    if (projection < -LOCAL_BELT_SAMPLE_DISTANCE || projection > LOCAL_BELT_SAMPLE_DISTANCE) continue
    result[`${item.unique_id}`] = { projection, name: stack.name, count: stack.count }
  }
  return { ok: true as const, items: result }
}

function sample_belt(entity: any, record: MeasurementRecord, count_metrics: boolean) {
  if (record.request.kind !== 'belt_lane') return fail('measurement kind mismatch')
  const current_result = belt_items(entity, record.request.lane_index)
  if (current_result.ok === false) return current_result
  const current = current_result.items
  const previous = record.previous_belt_items ?? {}
  record.previous_belt_items = current
  if (!count_metrics) return { ok: true as const }

  for (const [key, item] of pairs(current)) {
    const before = previous[key]
    if (!before || before.projection >= 0 || item.projection < 0) continue
    if (!matches_item(record.request.item_name, item.name)) continue
    record.crossing_items += item.count
    record.crossing_events++
    record.stack_count_sum += item.count
    record.max_stack_observed = math.max(record.max_stack_observed, item.count)
    record.min_stack_observed = record.min_stack_observed === undefined ? item.count : math.min(record.min_stack_observed, item.count)
    if (item.count > 1) record.stacked_crossing_items += item.count
  }
  return { ok: true as const }
}

function conservative_validation(rate: number, request: ThroughputMeasurementRequest) {
  const utilization = request.utilization_limit ?? DEFAULT_UTILIZATION_LIMIT
  const required = request.required_rate_per_second
  const usable = rate * utilization
  const proven = required === undefined ? undefined : required <= usable
  return {
    semantics: 'observed achieved throughput is a conservative lower bound under the measured live conditions, not a theoretical maximum',
    utilization_limit: utilization,
    observed_achieved_rate_per_second: rate,
    conservative_usable_rate_per_second: usable,
    required_rate_per_second: required,
    fits_observed_lower_bound: proven,
    verdict: required === undefined ? 'measured' : proven ? 'proven_sufficient' : 'not_proven',
    note: required === undefined || proven
      ? undefined
      : 'observed flow did not prove the requested headroom; upstream supply, downstream acceptance, power, contention, or inserter timing may have limited the sample',
  }
}

function finalize(actor: ControlledActor, entity: any, record: MeasurementRecord) {
  if (record.final_result) return record.final_result
  record.state = 'complete'
  record.completed_tick = game.tick
  const sample_seconds = (record.completes_at_tick - record.warmup_until_tick) / 60
  const measured_items = record.request.kind === 'inserter_instance' ? record.delivered_items : record.crossing_items
  const rate = sample_seconds > 0 ? measured_items / sample_seconds : 0
  const base = {
    ok: true as const,
    measurement_id: record.id,
    state: record.state,
    kind: record.request.kind,
    unit_number: record.request.unit_number,
    item_name: record.request.item_name,
    started_tick: record.started_tick,
    warmup_until_tick: record.warmup_until_tick,
    completed_tick: record.completed_tick,
    window_ticks: record.completes_at_tick - record.warmup_until_tick,
    sample_seconds,
    measured_items,
    items_per_second: rate,
    validation: conservative_validation(rate, record.request),
    context: {
      actor_id: record.actor_id,
      actor_kind: record.actor_kind,
      force_index: record.force_index,
      surface_index: record.surface_index,
      entity_name: record.entity_name,
      entity_direction: record.entity_direction,
      inserter_stack_size_bonus: record.force_inserter_stack_size_bonus,
      bulk_inserter_capacity_bonus: record.force_bulk_inserter_capacity_bonus,
      belt_stack_size_bonus: record.force_belt_stack_size_bonus,
    },
    evidence_ids: [`measurement:throughput:${record.id}`],
  }

  if (record.request.kind === 'inserter_instance') {
    const result = {
      ...base,
      inserter: {
        picked_up_items: record.picked_up_items,
        delivered_items: record.delivered_items,
        pickup_events: record.pickup_events,
        drop_events: record.drop_events,
        max_hand_observed: record.max_hand_observed,
        active_fraction: record.active_ticks / math.max(1, record.completes_at_tick - record.warmup_until_tick),
        loaded_fraction: record.loaded_ticks / math.max(1, record.completes_at_tick - record.warmup_until_tick),
        stack_size_override: entity.inserter_stack_size_override,
        target_pickup_count: entity.inserter_target_pickup_count,
        pickup_position: entity.pickup_position,
        drop_position: entity.drop_position,
        pickup_target: entity_summary(entity.pickup_target),
        drop_target: entity_summary(entity.drop_target),
      },
      theoretical: throughput_capacity(actor, {
        kind: 'inserter',
        prototype_name: entity.name,
        item_name: record.request.item_name,
      }),
      evidence_ids: [...base.evidence_ids, `engine:entity:${record.request.unit_number}:held_stack`],
    }
    record.final_result = result
    return result
  }

  const mean_stack = record.crossing_events > 0 ? record.stack_count_sum / record.crossing_events : undefined
  const stacked_fraction = record.crossing_items > 0 ? record.stacked_crossing_items / record.crossing_items : undefined
  const required_stack_size = record.request.required_stack_size
  const stacking_requirement_met = required_stack_size === undefined
    ? undefined
    : record.crossing_events > 0 && (record.min_stack_observed ?? 0) >= required_stack_size
  const theoretical = throughput_capacity(actor, {
    kind: 'belt',
    prototype_name: entity.name,
    scope: 'lane',
    required_rate_per_second: record.request.required_rate_per_second,
  })
  const measured_validation = base.validation
  const theoretical_lane_ceiling = theoretical.ok && theoretical.kind === 'belt'
    ? theoretical.capacity.stacked_lane_items_per_second
    : undefined
  const researched_stack_limit = theoretical.ok && theoretical.kind === 'belt' ? theoretical.effective_belt_stack_size : undefined
  let verdict = measured_validation.verdict
  let validation_note = measured_validation.note
  if (required_stack_size !== undefined && researched_stack_limit !== undefined && required_stack_size > researched_stack_limit) {
    verdict = 'exceeds_researched_stack_limit'
    validation_note = `required stack size ${required_stack_size} exceeds current researched belt stack size ${researched_stack_limit}`
  }
  else if (record.request.required_rate_per_second !== undefined
    && theoretical_lane_ceiling !== undefined
    && record.request.required_rate_per_second > theoretical_lane_ceiling) {
    verdict = 'exceeds_theoretical_capacity'
    validation_note = 'required lane flow exceeds the deterministic stacked transport ceiling under current research'
  }
  else if (required_stack_size !== undefined && stacking_requirement_met !== true) {
    verdict = 'not_proven'
    validation_note = 'the measured lane did not establish the required stack height across observed crossings'
  }
  const result = {
    ...base,
    validation: {
      ...measured_validation,
      verdict,
      note: validation_note,
      required_stack_size,
      stacking_requirement_met,
      theoretical_stacked_lane_capacity_items_per_second: theoretical_lane_ceiling,
      researched_stack_limit,
    },
    lane_index: record.request.lane_index,
    belt_lane: {
      crossing_events: record.crossing_events,
      crossing_items: record.crossing_items,
      min_stack_observed: record.min_stack_observed,
      max_stack_observed: record.max_stack_observed,
      mean_stack_observed: mean_stack,
      stacked_item_fraction: stacked_fraction,
      required_stack_size,
      stacking_requirement_met,
      stacking_established: record.max_stack_observed > 1,
    },
    theoretical,
    evidence_ids: [...base.evidence_ids, `engine:transport-line:${record.request.unit_number}:${record.request.lane_index}:detailed_contents`],
  }
  record.final_result = result
  return result
}

function fail_record(record: MeasurementRecord, code: string, message: string) {
  record.state = 'failed'
  record.completed_tick = game.tick
  record.error_code = code
  record.error_message = message
}

function status_result(get_actor: () => ControlledActor | undefined, record: MeasurementRecord) {
  if (record.state === 'failed') {
    return {
      ok: false as const,
      measurement_id: record.id,
      state: record.state,
      error: { code: record.error_code ?? 'MEASUREMENT_FAILED', message: record.error_message ?? 'measurement failed' },
      started_tick: record.started_tick,
      completed_tick: record.completed_tick,
    }
  }
  if (record.state === 'cancelled') {
    return {
      ok: false as const,
      measurement_id: record.id,
      state: record.state,
      error: { code: 'MEASUREMENT_CANCELLED', message: 'measurement was cancelled' },
      started_tick: record.started_tick,
      completed_tick: record.completed_tick,
    }
  }
  if (record.state === 'running') {
    return {
      ok: true as const,
      measurement_id: record.id,
      state: record.state,
      kind: record.request.kind,
      unit_number: record.request.unit_number,
      item_name: record.request.item_name,
      started_tick: record.started_tick,
      warmup_until_tick: record.warmup_until_tick,
      completes_at_tick: record.completes_at_tick,
      current_tick: game.tick,
      progress: math.max(0, math.min(1, (game.tick - record.warmup_until_tick) / math.max(1, record.completes_at_tick - record.warmup_until_tick))),
    }
  }

  if (record.final_result) return record.final_result
  const actor = get_actor()
  if (!actor || !actor.is_valid) return fail('controlled actor is unavailable')
  const resolved = resolve_entity(actor, record.request.unit_number)
  if (resolved.ok === false) return resolved
  return finalize(actor, resolved.entity, record)
}

export function new_throughput_measurement_controller(get_actor: () => ControlledActor | undefined) {
  function start(request: ThroughputMeasurementRequest) {
    if (!request || (request.kind !== 'inserter_instance' && request.kind !== 'belt_lane')) return fail('kind must be inserter_instance or belt_lane')
    if (active_count() >= MAX_ACTIVE_MEASUREMENTS) return fail(`at most ${MAX_ACTIVE_MEASUREMENTS} throughput measurements may run at once`, 'MEASUREMENT_BUSY')
    const window = request_window(request)
    if (window.ok === false) return window
    const actor = get_actor()
    if (!actor || !actor.is_valid) return fail('controlled actor is unavailable')
    const identity = actor.status_snapshot()
    if (identity.actor_id === undefined) return fail('controlled actor identity is unavailable')
    const resolved = resolve_entity(actor, request.unit_number)
    if (resolved.ok === false) return resolved
    const entity = resolved.entity
    if (request.kind === 'inserter_instance' && entity.type !== 'inserter') return fail(`entity is not an inserter: ${request.unit_number}`)
    if (request.kind === 'belt_lane') {
      const probe = belt_items(entity, request.lane_index)
      if (probe.ok === false) return probe
    }

    prune_measurements()
    const id = (storage.airi_next_throughput_measurement_id ?? 0) + 1
    storage.airi_next_throughput_measurement_id = id
    const record: MeasurementRecord = {
      id,
      state: 'running',
      request: { ...request, warmup_ticks: window.warmup, window_ticks: window.window, utilization_limit: window.utilization } as ThroughputMeasurementRequest,
      actor_id: identity.actor_id,
      actor_kind: identity.kind,
      force_index: actor.force.index,
      surface_index: actor.surface.index,
      entity_name: entity.name,
      entity_direction: entity.direction,
      force_inserter_stack_size_bonus: actor.force.inserter_stack_size_bonus ?? 0,
      force_bulk_inserter_capacity_bonus: actor.force.bulk_inserter_capacity_bonus ?? 0,
      force_belt_stack_size_bonus: actor.force.belt_stack_size_bonus ?? 0,
      inserter_stack_size_override: request.kind === 'inserter_instance' ? (entity.inserter_stack_size_override ?? 0) : undefined,
      started_tick: game.tick,
      warmup_until_tick: game.tick + window.warmup,
      completes_at_tick: game.tick + window.warmup + window.window,
      picked_up_items: 0,
      delivered_items: 0,
      pickup_events: 0,
      drop_events: 0,
      max_hand_observed: 0,
      active_ticks: 0,
      loaded_ticks: 0,
      crossing_items: 0,
      crossing_events: 0,
      stacked_crossing_items: 0,
      max_stack_observed: 0,
      stack_count_sum: 0,
    }
    if (request.kind === 'inserter_instance') record.previous_held = held_sample(entity)
    else {
      const initial = belt_items(entity, request.lane_index)
      if (initial.ok) record.previous_belt_items = initial.items
    }
    measurements()[id] = record
    return {
      ok: true as const,
      measurement_id: id,
      state: record.state,
      kind: request.kind,
      unit_number: request.unit_number,
      started_tick: record.started_tick,
      warmup_until_tick: record.warmup_until_tick,
      completes_at_tick: record.completes_at_tick,
    }
  }

  function tick() {
    const actor = get_actor()
    for (const [, record] of pairs(measurements())) {
      if (record.state !== 'running') continue
      if (!actor || !actor.is_valid) {
        fail_record(record, 'ACTOR_UNAVAILABLE', 'controlled actor became unavailable during measurement')
        continue
      }
      const resolved = resolve_entity(actor, record.request.unit_number)
      if (resolved.ok === false) {
        fail_record(record, resolved.error.code, resolved.error.message)
        continue
      }
      const entity = resolved.entity
      if (!context_matches(actor, entity, record)) {
        fail_record(record, 'STALE_CONTEXT', 'actor, research, entity direction, or inserter override changed during measurement')
        continue
      }

      const count_metrics = game.tick > record.warmup_until_tick
      if (record.request.kind === 'inserter_instance') {
        sample_inserter(entity, record, count_metrics)
      }
      else {
        const sampled = sample_belt(entity, record, count_metrics)
        if (sampled.ok === false) {
          fail_record(record, sampled.error.code, sampled.error.message)
          continue
        }
      }

      if (game.tick >= record.completes_at_tick) finalize(actor, entity, record)
    }
  }

  function status(measurement_id: number) {
    if (!valid_integer(measurement_id, 1, 9007199254740991)) return fail('measurement_id must be a positive safe integer')
    const record = measurements()[measurement_id]
    if (!record) return fail(`measurement not found: ${measurement_id}`, 'MEASUREMENT_NOT_FOUND')
    return status_result(get_actor, record)
  }

  function cancel(measurement_id: number) {
    if (!valid_integer(measurement_id, 1, 9007199254740991)) return fail('measurement_id must be a positive safe integer')
    const record = measurements()[measurement_id]
    if (!record) return fail(`measurement not found: ${measurement_id}`, 'MEASUREMENT_NOT_FOUND')
    if (record.state === 'running') {
      record.state = 'cancelled'
      record.completed_tick = game.tick
    }
    return status_result(get_actor, record)
  }

  return { start, tick, status, cancel }
}
