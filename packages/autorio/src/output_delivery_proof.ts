import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { resolve_exact_entity } from './entity_reference'

// This is a conservative candidate witness, not yet promoted engine evidence.
// Factorio exposes no native inserter-delivery event. Every sampled depletion
// must balance the exact chest and the exact producer's newly finished output.
const MAX_PROOFS = 4
const MAX_LINES = 8
const MINUTE_TICKS = 3600
const REQUIRED_PER_MINUTE = 10
const REQUIRED_MINUTES = 5

export interface OutputProofSpec {
  proof_id: string
  request_id: string
  label: string
  chest_unit_number: number
  item_name: string
  force_index: number
  surface_index: number
  lines: Array<{ producer_unit_number: number, inserter_unit_number: number }>
  supply_unit_numbers?: number[]
}

export interface DeliverySample {
  tick: number
  chest_count: number
  producers: Record<number, { finished: number, amount: number, output_count: number }>
  hands: Record<number, { count: number, producer_unit_number: number }>
}

interface ProofState {
  batch_generation: number
  spec: OutputProofSpec
  chest: LuaEntity
  lines: Array<{ producer: LuaEntity, inserter: LuaEntity, recipe_name: string }>
  last?: DeliverySample
  credits: Record<number, number>
  window_start_tick?: number
  bucket_start_tick?: number
  bucket_count: number
  successful_minutes: number
  buckets: number[]
  candidate_met: boolean
  reason: string
}

declare const storage: { sgluna_output_delivery_proofs?: ProofState[], sgluna_task_batch_generation?: number }

function proofs() {
  storage.sgluna_output_delivery_proofs ??= []
  return storage.sgluna_output_delivery_proofs
}

function reset(proof: ProofState, reason: string) {
  proof.last = undefined
  proof.credits = {}
  proof.window_start_tick = undefined
  proof.bucket_start_tick = undefined
  proof.bucket_count = 0
  proof.successful_minutes = 0
  proof.buckets = []
  proof.candidate_met = false
  if (proof.reason !== reason) log(`[AUTORIO] output.proof_reset request_id=${proof.spec.request_id} reason=${reason}`)
  proof.reason = reason
}

/** Pure deterministic accounting; only the native tick adapter calls this in game. */
export function apply_delivery_sample(proof: ProofState, sample: DeliverySample) {
  const previous = proof.last
  if (!previous) {
    if (Object.values(sample.hands).some(hand => hand.count !== 0)
      || Object.values(sample.producers).some(producer => producer.output_count !== 0)) {
      proof.reason = 'waiting_for_empty_native_output'
      return
    }
    proof.last = sample
    proof.window_start_tick = sample.tick
    proof.bucket_start_tick = sample.tick
    proof.reason = 'measuring_engine_unvalidated'
    return
  }
  if (sample.tick !== previous.tick + 1) return reset(proof, 'sampling_gap_or_clock_changed')
  for (const key of Object.keys(sample.producers)) {
    const id = Number(key)
    const producer = sample.producers[id]
    const old = previous.producers[id]
    if (!old || producer.finished < old.finished || producer.amount !== old.amount) return reset(proof, 'producer_identity_or_counter_changed')
    proof.credits[id] = (proof.credits[id] ?? 0) + (producer.finished - old.finished) * producer.amount
  }
  let delivered = 0
  for (const key of Object.keys(sample.hands)) {
    const id = Number(key)
    const hand = sample.hands[id]
    const old = previous.hands[id]
    if (!old || old.producer_unit_number !== hand.producer_unit_number) return reset(proof, 'supplying_line_changed')
    const dropped = math.max(0, old.count - hand.count)
    const producer_id = hand.producer_unit_number
    if (dropped > (proof.credits[producer_id] ?? 0)) return reset(proof, 'unproven_source_output')
    proof.credits[producer_id] = (proof.credits[producer_id] ?? 0) - dropped
    delivered += dropped
  }
  if (sample.chest_count - previous.chest_count !== delivered) return reset(proof, 'unexplained_chest_mutation')
  proof.bucket_count += delivered
  proof.last = sample
  if (sample.tick - proof.bucket_start_tick! === MINUTE_TICKS) {
    const count = proof.bucket_count
    proof.buckets.push(count)
    proof.buckets = proof.buckets.slice(-REQUIRED_MINUTES)
    proof.bucket_count = 0
    proof.bucket_start_tick = sample.tick
    if (count < REQUIRED_PER_MINUTE) {
      // A deficient minute starts a fresh five-minute witness, including empty
      // output baselines. Prior stocked machine output cannot fund another proof.
      return reset(proof, 'deficient_minute')
    }
    proof.successful_minutes++
    proof.candidate_met = proof.successful_minutes >= REQUIRED_MINUTES
    log(`[AUTORIO] output.minute_verified request_id=${proof.spec.request_id} reason=native_candidate deliveries=${count}`)
  }
}

export function note_output_proof_manual_mutation(entity: LuaEntity | undefined, _into_fuel: boolean) {
  if (!entity?.valid) return
  for (const proof of proofs()) {
    if (entity.unit_number === proof.spec.chest_unit_number
      || proof.spec.lines.some(line => line.producer_unit_number === entity.unit_number || line.inserter_unit_number === entity.unit_number)
      || proof.spec.supply_unit_numbers?.includes(entity.unit_number!) === true) reset(proof, 'manual_supply_or_output_mutation')
  }
}

export function note_output_proof_hand_craft(force_index: number, item_name: string) {
  for (const proof of proofs()) {
    if (proof.spec.force_index === force_index && proof.spec.item_name === item_name) reset(proof, 'manual_output_craft')
  }
}

function identity_matches(entity: LuaEntity, id: number, spec: OutputProofSpec) {
  return entity.valid && entity.unit_number === id && entity.force.index === spec.force_index && entity.surface.index === spec.surface_index
}

function valid_unit(value: unknown): value is number {
  return typeof value === 'number' && value === math.floor(value) && value >= 1 && value <= 9007199254740991
}

function collect(proof: ProofState): DeliverySample | string {
  if (game.connected_players.length !== 0) return 'connected_humans_unsupported'
  const spec = proof.spec
  if (!identity_matches(proof.chest, spec.chest_unit_number, spec)) return 'output_identity_changed'
  const inventory = proof.chest.get_inventory(defines.inventory.chest)
  if (!inventory) return 'output_inventory_unavailable'
  const sample: DeliverySample = { tick: game.tick, chest_count: inventory.get_item_count(spec.item_name), producers: {}, hands: {} }
  for (let i = 0; i < proof.lines.length; i++) {
    const { producer, inserter, recipe_name } = proof.lines[i]
    const line = spec.lines[i]
    if (!identity_matches(producer, line.producer_unit_number, spec) || !identity_matches(inserter, line.inserter_unit_number, spec)
      || inserter.pickup_target !== producer || inserter.drop_target !== proof.chest) return 'supplying_line_changed'
    const [recipe, quality] = producer.get_recipe()
    const product = recipe?.products[0]
    if (!recipe || recipe.name !== recipe_name || quality?.name !== 'normal' || recipe.products.length !== 1
      || product?.type !== 'item' || product.name !== spec.item_name || product.amount === undefined
      || (product.probability ?? 1) !== 1) return 'unsupported_or_changed_recipe'
    const output = producer.get_output_inventory()
    if (!output) return 'producer_output_unavailable'
    sample.producers[line.producer_unit_number] = { finished: producer.products_finished, amount: product.amount, output_count: output.get_item_count(spec.item_name) }
    const held = inserter.held_stack
    if (held.valid_for_read && (held.name !== spec.item_name || held.quality.name !== 'normal')) return 'unsupported_held_item'
    sample.hands[line.inserter_unit_number] = { count: held.valid_for_read ? held.count : 0, producer_unit_number: line.producer_unit_number }
  }
  return sample
}

export function tick_output_delivery_proofs(batch_generation: number = storage.sgluna_task_batch_generation ?? 0) {
  for (const proof of proofs()) {
    if (proof.batch_generation !== batch_generation) {
      reset(proof, 'save_generation_changed')
      proof.batch_generation = batch_generation
      continue
    }
    const sample = collect(proof)
    if (typeof sample === 'string') reset(proof, sample)
    else apply_delivery_sample(proof, sample)
  }
}

export function new_output_delivery_proof_controller(get_actor: () => ControlledActor | undefined, get_generation: () => number = () => storage.sgluna_task_batch_generation ?? 0) {
  function register(spec: OutputProofSpec) {
    const actor = get_actor()
    if (!actor?.is_valid || !spec || typeof spec.proof_id !== 'string' || spec.proof_id.length < 1 || spec.proof_id.length > 160
      || typeof spec.request_id !== 'string' || spec.request_id.length < 1 || spec.request_id.length > 160
      || typeof spec.label !== 'string' || spec.label.length < 1 || spec.label.length > 120
      || typeof spec.item_name !== 'string' || !prototypes.item[spec.item_name]
      || !valid_unit(spec.chest_unit_number)
      || !Array.isArray(spec.lines) || spec.lines.length < 1 || spec.lines.length > MAX_LINES
      || (spec.supply_unit_numbers !== undefined && (!Array.isArray(spec.supply_unit_numbers)
        || spec.supply_unit_numbers.length > 64 || spec.supply_unit_numbers.some(id => !valid_unit(id))))
      || spec.force_index !== actor.force.index || spec.surface_index !== actor.surface.index) return { ok: false, reason: 'invalid_proof_spec' }
    if (get_generation() < 1) return { ok: false, reason: 'save_generation_unavailable' }
    if (proofs().some(proof => proof.spec.proof_id === spec.proof_id)) return { ok: false, reason: 'proof_already_registered' }
    if (proofs().length >= MAX_PROOFS) return { ok: false, reason: 'proof_capacity' }
    const chest = resolve_exact_entity(actor, spec.chest_unit_number)
    if (!chest || chest.type !== 'container' || !identity_matches(chest, spec.chest_unit_number, spec)) return { ok: false, reason: 'invalid_output_chest' }
    const lines: ProofState['lines'] = []
    for (const line of spec.lines) {
      if (!line || !valid_unit(line.producer_unit_number) || !valid_unit(line.inserter_unit_number)) return { ok: false, reason: 'invalid_supplying_line' }
      if (lines.some(old => old.inserter.unit_number === line.inserter_unit_number)) return { ok: false, reason: 'duplicate_inserter' }
      const producer = resolve_exact_entity(actor, line.producer_unit_number)
      const inserter = resolve_exact_entity(actor, line.inserter_unit_number)
      if (!producer || producer.type !== 'assembling-machine' || !inserter || inserter.type !== 'inserter') return { ok: false, reason: 'invalid_supplying_line' }
      const [recipe] = producer.get_recipe()
      if (!recipe) return { ok: false, reason: 'missing_recipe' }
      lines.push({ producer, inserter, recipe_name: recipe.name })
    }
    const owned_spec = { ...spec, lines: spec.lines.map(line => ({ ...line })), supply_unit_numbers: spec.supply_unit_numbers ? [...spec.supply_unit_numbers] : undefined }
    const proof: ProofState = { batch_generation: get_generation(), spec: owned_spec, chest, lines, credits: {}, bucket_count: 0, successful_minutes: 0, buckets: [], candidate_met: false, reason: 'registered_engine_unvalidated' }
    const initial = collect(proof)
    if (typeof initial === 'string') return { ok: false, reason: initial }
    proofs().push(proof)
    apply_delivery_sample(proof, initial)
    log(`[AUTORIO] output.proof_registered request_id=${spec.request_id} reason=direct_native_line`)
    return { ok: true, engine_validated: false }
  }

  function status(proof_id: string) {
    const proof = proofs().find(entry => entry.spec.proof_id === proof_id)
    if (!proof) return { ok: false, reason: 'unknown_proof' }
    const current_generation = get_generation()
    if (proof.batch_generation !== current_generation) {
      reset(proof, 'save_generation_changed')
      proof.batch_generation = current_generation
    }
    return {
      ok: true, proof_id, label: proof.spec.label, item_name: proof.spec.item_name,
      chest_unit_number: proof.spec.chest_unit_number, force_index: proof.spec.force_index, surface_index: proof.spec.surface_index,
      per_minute: REQUIRED_PER_MINUTE, consecutive_minutes: REQUIRED_MINUTES,
      window_start_tick: proof.window_start_tick, bucket_start_tick: proof.bucket_start_tick,
      batch_generation: proof.batch_generation,
      bucket_deliveries: proof.bucket_count, successful_minutes: proof.successful_minutes, buckets: [...proof.buckets],
      candidate_met: proof.candidate_met, satisfied: false, engine_validated: false,
      reason: proof.reason, upstream_automation_verified: false,
    }
  }
  return { register, status }
}
