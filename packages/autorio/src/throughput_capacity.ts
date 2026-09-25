import type { ControlledActor } from './actors/types'
import type { LuaEntityPrototype } from 'factorio:runtime'
import { resolve_exact_entity } from './entity_reference'

export type ThroughputCapacityRequest
  = | {
    kind: 'belt'
    prototype_name: string
    scope?: 'lane' | 'belt'
    required_rate_per_second?: number
  }
  | {
    kind: 'inserter'
    prototype_name: string
    item_name?: string
  }
  | {
    kind: 'inserter_instance'
    unit_number: number
  }

const MAX_NAME_LENGTH = 200
const MAX_RATE = 1_000_000_000

function valid_name(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_NAME_LENGTH
}

function valid_positive_number(value: unknown): value is number {
  return typeof value === 'number' && value === value && value > 0 && value < math.huge && value <= MAX_RATE
}

function valid_unit_number(value: unknown): value is number {
  return typeof value === 'number' && value >= 1 && math.floor(value) === value
}

function fail(message: string) {
  return { ok: false as const, error: { code: 'INVALID_REQUEST' as const, message } }
}

function entity_summary(entity: any) {
  if (!entity || !entity.valid) return undefined
  return {
    name: entity.name,
    type: entity.type,
    unit_number: entity.unit_number,
    position: entity.position,
    direction: entity.direction,
  }
}

function inserter_transfer_rate_unvalidated() {
  return {
    validated: false as const,
    reason: 'inserter items-per-second depends on pickup/drop topology and belt state; no fixed throughput is asserted without scenario validation',
  }
}

export function throughput_capacity(actor: ControlledActor, request: ThroughputCapacityRequest) {
  if (!actor || !actor.is_valid) return fail('controlled actor is unavailable')
  if (!request) return fail('request is required')

  if (request.kind === 'inserter_instance') {
    if (!valid_unit_number(request.unit_number)) return fail('unit_number must be a positive integer')
    const entity = resolve_exact_entity(actor, request.unit_number)
    if (!entity || !entity.valid) return fail(`entity not found: ${request.unit_number}`)
    if (entity.surface.index !== actor.surface.index) return fail('entity is on another surface')
    if (entity.type !== 'inserter') return fail(`entity is not an inserter: ${request.unit_number}`)

    const held = entity.held_stack
    return {
      ok: true as const,
      kind: 'inserter_instance' as const,
      unit_number: request.unit_number,
      prototype_name: entity.name,
      active: entity.active,
      target_pickup_count: entity.inserter_target_pickup_count,
      stack_size_override: entity.inserter_stack_size_override,
      pickup_from_left_lane: entity.pickup_from_left_lane,
      pickup_from_right_lane: entity.pickup_from_right_lane,
      pickup_position: entity.pickup_position,
      drop_position: entity.drop_position,
      pickup_target: entity_summary(entity.pickup_target),
      drop_target: entity_summary(entity.drop_target),
      held_stack: held?.valid_for_read
        ? { name: held.name, count: held.count }
        : undefined,
      transfer_rate: inserter_transfer_rate_unvalidated(),
      evidence_ids: [
        `engine:entity:${request.unit_number}:inserter_target_pickup_count`,
        `engine:entity:${request.unit_number}:inserter_stack_size_override`,
        `engine:entity:${request.unit_number}:pickup_drop_topology`,
      ],
    }
  }

  if (!valid_name(request.prototype_name)) return fail('prototype_name must be a bounded non-empty string')
  const prototype: LuaEntityPrototype | undefined = prototypes.entity[request.prototype_name]
  if (!prototype) return fail(`entity prototype not found: ${request.prototype_name}`)

  if (request.kind === 'belt') {
    if (typeof prototype.belt_speed !== 'number' || prototype.belt_speed <= 0) {
      return fail(`prototype is not a belt-connectable entity with positive belt speed: ${request.prototype_name}`)
    }
    const scope = request.scope ?? 'belt'
    if (scope !== 'lane' && scope !== 'belt') return fail('belt scope must be lane or belt')
    if (request.required_rate_per_second !== undefined && !valid_positive_number(request.required_rate_per_second)) {
      return fail('required_rate_per_second must be positive and bounded when provided')
    }

    const base_belt_rate = prototype.belt_speed * 480
    const base_lane_rate = prototype.belt_speed * 240
    const stack_size = 1 + (actor.force.belt_stack_size_bonus ?? 0)
    const stacked_belt_rate = base_belt_rate * stack_size
    const stacked_lane_rate = base_lane_rate * stack_size
    const unstacked_scope_rate = scope === 'lane' ? base_lane_rate : base_belt_rate
    const stacked_scope_rate = scope === 'lane' ? stacked_lane_rate : stacked_belt_rate
    const required = request.required_rate_per_second

    return {
      ok: true as const,
      kind: 'belt' as const,
      prototype_name: request.prototype_name,
      scope,
      belt_speed: prototype.belt_speed,
      force_belt_stack_size_bonus: actor.force.belt_stack_size_bonus ?? 0,
      effective_belt_stack_size: stack_size,
      capacity: {
        unstacked_lane_items_per_second: base_lane_rate,
        unstacked_belt_items_per_second: base_belt_rate,
        stacked_lane_items_per_second: stacked_lane_rate,
        stacked_belt_items_per_second: stacked_belt_rate,
      },
      validation: required === undefined
        ? undefined
        : {
            scope,
            required_rate_per_second: required,
            unstacked_capacity_items_per_second: unstacked_scope_rate,
            stacked_capacity_items_per_second: stacked_scope_rate,
            fits_unstacked: required <= unstacked_scope_rate,
            fits_stacked: required <= stacked_scope_rate,
          },
      semantics: {
        transport_capacity_only: true,
        stacked_capacity_requires_matching_item_stacks: stack_size > 1,
        note: 'stacked capacity is a belt transport ceiling; it does not prove upstream inserters/loaders can create or sustain the required stacks',
      },
      evidence_ids: [
        `engine:prototype:${request.prototype_name}:belt_speed`,
        'engine:force:belt_stack_size_bonus',
        'factorio-contract:belt_speed_x_480',
      ],
    }
  }

  if (request.kind === 'inserter') {
    if (prototype.type !== 'inserter') return fail(`prototype is not an inserter: ${request.prototype_name}`)
    if (request.item_name !== undefined && !valid_name(request.item_name)) return fail('item_name must be bounded when provided')

    const built_in_bonus = prototype.inserter_stack_size_bonus ?? 0
    const uses_bonus = prototype.uses_inserter_stack_size_bonus !== false
    const research_bonus = uses_bonus
      ? (prototype.bulk === true ? (actor.force.bulk_inserter_capacity_bonus ?? 0) : (actor.force.inserter_stack_size_bonus ?? 0))
      : 0
    const raw_hand_capacity = 1 + built_in_bonus + research_bonus
    const item = request.item_name ? (prototypes.item as any)[request.item_name] : undefined
    if (request.item_name && !item) return fail(`item prototype not found: ${request.item_name}`)
    const hand_capacity = item ? math.min(raw_hand_capacity, item.stack_size) : raw_hand_capacity
    const force_belt_stack_size = 1 + (actor.force.belt_stack_size_bonus ?? 0)
    // Read live in Factorio 2.0.77; missing from the typed-factorio 2.0.72 declarations.
    const prototype_belt_stack_limit = (prototype as LuaEntityPrototype & { readonly inserter_max_belt_stack_size?: number }).inserter_max_belt_stack_size ?? 1

    return {
      ok: true as const,
      kind: 'inserter' as const,
      prototype_name: request.prototype_name,
      item_name: request.item_name,
      bulk: prototype.bulk === true,
      uses_inserter_stack_size_bonus: uses_bonus,
      built_in_stack_size_bonus: built_in_bonus,
      force_capacity_bonus: research_bonus,
      hand_capacity_items: hand_capacity,
      item_stack_size: item?.stack_size,
      belt_drop_stack_limit: math.min(force_belt_stack_size, prototype_belt_stack_limit),
      movement: {
        // Typed calls: on an untyped prototype `?.()` passes the prototype as the quality argument.
        rotation_speed: prototype.get_inserter_rotation_speed(),
        extension_speed: prototype.get_inserter_extension_speed(),
        pickup_position: prototype.inserter_pickup_position,
        drop_position: prototype.inserter_drop_position,
      },
      transfer_rate: inserter_transfer_rate_unvalidated(),
      evidence_ids: [
        `engine:prototype:${request.prototype_name}:inserter`,
        prototype.bulk === true ? 'engine:force:bulk_inserter_capacity_bonus' : 'engine:force:inserter_stack_size_bonus',
        'engine:force:belt_stack_size_bonus',
      ],
    }
  }

  return fail('kind must be belt, inserter, or inserter_instance')
}
