import { compileQuantities, itemName, normalizeCounts, normalizeTargets, quantity } from './quantity-compiler.mjs'
import { checkpointMaterialOwner, claimMaterials, materialAvailability, materialOwnerKey, releaseMaterials, restoreMaterialLedger } from './material-ledger.mjs'

export const PRODUCTION_LIMITS = Object.freeze({ transitions: 256, recoveries: 3, duration_ms: 30 * 60000, stalled_ms: 60000, recipe_reads: 32, batch_items: 100 })
const nameSchema = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$', minLength: 1, maxLength: 200 }
const countSchema = { type: 'integer', minimum: 1, maximum: 10000 }
const unitSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const rows = (maxItems, properties, required = Object.keys(properties)) => ({ type: 'array', maxItems, items: { type: 'object', additionalProperties: false, required, properties } })
export const PRODUCTION_TASK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['targets'],
  description: 'Finite held-item targets matching the active inventory checkpoint. Counts are desired items, not craft executions. The harness compiles quantities and owns bounded acquire/craft/fuel/wait/collect batches; no placement, research or continuous-output authority is granted.',
  properties: {
    targets: { ...rows(16, { item_name: nameSchema, count: countSchema }), minItems: 1 },
    producers: rows(8, { recipe_name: nameSchema, unit_number: unitSchema }),
    resources: rows(16, { item_name: nameSchema, method: { type: 'string', enum: ['gather_resource', 'harvest_product'] } }),
    feeders: rows(8, { unit_number: unitSchema, output_unit_number: unitSchema }),
    fuel: { type: 'object', additionalProperties: false, required: ['item_name', 'count'], properties: { item_name: nameSchema, count: countSchema } },
  },
}
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('invalid_production_intent')
}
const unit = value => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid_production_unit')
  return value
}
export function normalizeProductionIntent(raw) {
  exact(raw, ['targets', 'producers', 'resources', 'fuel', 'feeders'])
  const targets = normalizeTargets(raw.targets)
  const producers = raw.producers ?? []; const resources = raw.resources ?? []; const feeders = raw.feeders ?? []
  if (!Array.isArray(producers) || producers.length > 8 || !Array.isArray(resources) || resources.length > 16 || !Array.isArray(feeders) || feeders.length > 8) throw new Error('production_binding_limit')
  const recipes = new Set(); const leaves = new Set(); const units = new Set()
  return { targets,
    producers: producers.map(row => {
      exact(row, ['recipe_name', 'unit_number'])
      const name = itemName(row.recipe_name)
      if (recipes.has(name)) throw new Error('duplicate_production_recipe')
      recipes.add(name)
      return { recipe_name: name, unit_number: unit(row.unit_number) }
    }),
    resources: resources.map(row => {
      exact(row, ['item_name', 'method'])
      const name = itemName(row.item_name)
      if (leaves.has(name) || !['gather_resource', 'harvest_product'].includes(row.method)) throw new Error('invalid_production_resource')
      leaves.add(name)
      return { item_name: name, method: row.method }
    }),
    feeders: feeders.map(row => {
      exact(row, ['unit_number', 'output_unit_number'])
      if (units.has(row.unit_number)) throw new Error('duplicate_production_feeder')
      units.add(row.unit_number)
      return { unit_number: unit(row.unit_number), output_unit_number: unit(row.output_unit_number) }
    }),
    ...(raw.fuel !== undefined ? (() => { exact(raw.fuel, ['item_name', 'count']); return { fuel: { item_name: itemName(raw.fuel.item_name), count: quantity(raw.fuel.count) } } })() : {}),
  }
}
export function productionScopeMatches(intent, contract) {
  // This first version produces finite held stock only. It cannot convert an
  // automated-rate goal, semantic step or arbitrary model request into authority.
  return contract?.mode === 'all' && intent.targets.every(target => Math.max(0, ...(contract.requirements ?? [])
    .filter(row => row.kind === 'inventory_count' && row.item_name === target.item_name).map(row => row.minimum)) === target.count)
}
// The refusal states the committed finite targets the executor may name, so a
// correction does not depend on rereading the contract.
export function productionScopeMismatch(intent, contract) {
  const required = new Map()
  for (const row of contract?.mode === 'all' ? contract.requirements ?? [] : []) {
    if (row.kind === 'inventory_count') required.set(row.item_name, Math.max(required.get(row.item_name) ?? 0, row.minimum))
  }
  const list = rows => rows.map(([name, count]) => `${name} ${count}`).join(', ')
  if (!required.size) return 'Targets must exactly match finite inventory requirements of this committed step, and it has none in an all-mode contract'
  const unmatched = intent.targets.filter(target => required.get(target.item_name) !== target.count).map(row => [row.item_name, row.count])
  return `Targets must exactly match finite inventory requirements of this committed step (required: ${list([...required].sort(([a], [b]) => a.localeCompare(b)))}; unmatched: ${list(unmatched)}). The harness compiles ingredients and intermediates from native recipes`
}
export function createProductionTask({ intent, owner, actor_id, epoch, ledger, protected_stock = {}, collectionOnly = false, now = Date.now() }) {
  intent = normalizeProductionIntent(intent)
  materialOwnerKey(owner)
  protected_stock = normalizeCounts(protected_stock)
  const protectedItems = Object.entries(protected_stock).filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b)).map(([item_name, count]) => ({ item_name, count }))
  const materialLedger = ledger === undefined && protectedItems.length
    ? claimMaterials(undefined, { owner: checkpointMaterialOwner(owner), items: protectedItems }) : restoreMaterialLedger(ledger)
  if (protectedItems.length) {
    const protection = materialLedger.claims.find(row => materialOwnerKey(row.owner) === materialOwnerKey(checkpointMaterialOwner(owner)))
    if (protection?.kind !== 'reservation' || JSON.stringify(protection.items) !== JSON.stringify(protectedItems)) throw new Error('production_checkpoint_reservation_unreadable')
  }
  return { version: 1, owner: { ...owner }, actor_id: unit(actor_id), epoch: unit(epoch), intent,
    ...(collectionOnly ? { collection_only: true } : {}),
    status: 'active', transitions: 0, recoveries: 0, fuel_used: 0, created_at: now, deadline_at: now + PRODUCTION_LIMITS.duration_ms,
    last_progress_at: now, last_fingerprint: null, ledger: materialLedger, protected_stock }
}
export function restoreProductionTask(raw) {
  if (!raw || raw.version !== 1 || !['active', 'complete', 'paused'].includes(raw.status)) throw new Error('invalid_production_task')
  if (raw.collection_only !== undefined && raw.collection_only !== true) throw new Error('invalid_production_collection_mode')
  const task = createProductionTask({ intent: raw.intent, owner: raw.owner, actor_id: raw.actor_id, epoch: raw.epoch, ledger: raw.ledger, protected_stock: raw.protected_stock, collectionOnly: raw.collection_only === true, now: raw.created_at })
  for (const key of ['created_at', 'deadline_at', 'last_progress_at']) if (!Number.isSafeInteger(raw[key]) || raw[key] < 0) throw new Error('invalid_production_clock')
  if (raw.deadline_at !== raw.created_at + PRODUCTION_LIMITS.duration_ms) throw new Error('invalid_production_deadline')
  if (raw.last_progress_at < raw.created_at || raw.last_progress_at > raw.deadline_at) throw new Error('invalid_production_progress_clock')
  for (const key of ['transitions', 'recoveries', 'fuel_used']) task[key] = quantity(raw[key], { zero: true })
  if (task.transitions > PRODUCTION_LIMITS.transitions || task.recoveries > PRODUCTION_LIMITS.recoveries || task.fuel_used > (task.intent.fuel?.count ?? 0)) throw new Error('invalid_production_allowance')
  return { ...task, status: raw.status, deadline_at: raw.deadline_at, last_progress_at: raw.last_progress_at,
    last_fingerprint: typeof raw.last_fingerprint === 'string' && raw.last_fingerprint.length <= 20000 ? raw.last_fingerprint : null,
    ...(typeof raw.pause_reason === 'string' ? { pause_reason: raw.pause_reason.slice(0, 200) } : {}) }
}
function halt(task, reason) { return { action: 'pause', reason, task: { ...task, status: 'paused', pause_reason: reason } } }
export function recoverProductionTask(raw, reason) {
  const task = restoreProductionTask(raw)
  if (task.recoveries >= PRODUCTION_LIMITS.recoveries) return halt(task, 'production_recovery_exhausted')
  // The repair is a fresh reconciliation, not a replay of the refused batch.
  return { action: 'reconcile', reason, task: { ...task, recoveries: task.recoveries + 1 } }
}
export function machineFacts(entity) {
  if (!entity || !Number.isSafeInteger(entity.unit_number) || !Array.isArray(entity.inventories)
    || entity.inventories_truncated === true || entity.inventory_items_truncated === true) throw new Error('production_machine_unreadable')
  const counts = index => {
    const result = Object.create(null)
    const raw = entity.inventories.find(row => row.index === index)
    for (const row of Array.isArray(raw?.items) ? raw.items : []) result[row.name] = (result[row.name] ?? 0) + row.count
    return normalizeCounts(result)
  }
  return { unit_number: entity.unit_number, name: entity.name, type: entity.type, recipe: entity.recipe,
    working: entity.working === true, status_name: entity.status_name, energy_source: entity.energy_source,
    input: counts(2), output: counts(3), fuel: counts(1),
    progress: Number.isFinite(entity.crafting_progress) ? entity.crafting_progress : null,
    crafting_speed: entity.crafting_speed,
    drop_target: entity.spatial?.item_io?.drop_target?.unit_number }
}
export function advanceProductionTask(raw, facts, now = Date.now()) {
  const task = restoreProductionTask(raw)
  if (task.status !== 'active') return { action: task.status === 'complete' ? 'complete' : 'pause', reason: task.pause_reason, task }
  if (facts.actor_id !== task.actor_id || facts.epoch !== task.epoch || materialOwnerKey(facts.owner) !== materialOwnerKey(task.owner)) return { action: 'stale', reason: 'production_owner_changed', task }
  if (facts.native_idle !== true || facts.pending === true) return { action: 'defer', reason: 'native_or_uncertain_work_pending', task }
  if (now >= task.deadline_at || task.transitions >= PRODUCTION_LIMITS.transitions) return halt(task, 'production_task_exhausted')
  let availability, bill
  try {
    availability = materialAvailability(task.ledger, { owner: task.owner, inventory: facts.inventory, fresh: facts.fresh })
    bill = compileQuantities({ targets: task.intent.targets, recipes: facts.recipes, inventory: availability.available })
  } catch (error) { return halt(task, error.message) }
  if (bill.fulfilled) return { action: 'complete', task: { ...task, status: 'complete', ledger: releaseMaterials(task.ledger, task.owner) }, bill }
  const machines = facts.machines ?? []
  const fingerprint = JSON.stringify({ held: availability.available, machines: machines.map(m => ({ unit: m.unit_number, input: m.input, output: m.output, fuel: m.fuel, progress: m.progress })) })
  if (fingerprint !== task.last_fingerprint) task.last_progress_at = now
  task.last_fingerprint = fingerprint
  if (now - task.last_progress_at >= PRODUCTION_LIMITS.stalled_ms) return halt(task, 'production_no_progress')
  const retained = Object.fromEntries(bill.retained.map(row => [row.item_name, row.count]))
  const spendable = name => Math.max(0, (availability.available[name] ?? 0) - (retained[name] ?? 0))
  const emit = (operation, fuel = 0) => {
    task.transitions++
    task.fuel_used += fuel
    task.ledger = claimMaterials(task.ledger, { owner: task.owner, items: task.intent.targets })
    return { action: 'execute', task, operation, bill }
  }
  const acquire = (name, count) => {
    const binding = task.intent.resources.find(row => row.item_name === name)
    if (!binding) return halt(task, `production_resource_unbound:${name}`)
    const n = Math.min(count, PRODUCTION_LIMITS.batch_items)
    return emit(binding.method === 'harvest_product'
      ? { name: 'harvest_product', args: { product_name: name, count: n, search_radius: 256 } }
      : { name: 'gather_resource', args: { resource_name: name, count: n, search_radius: 256 } })
  }
  const refuel = machine => {
    const fuel = task.intent.fuel
    // Admission refuses a burner binding without an allowance; a record that
    // predates that rule names the missing grant instead of a spent one.
    if (!fuel) return halt(task, 'production_fuel_allowance_missing')
    if (task.fuel_used >= fuel.count) return halt(task, 'production_fuel_allowance_exhausted')
    if (spendable(fuel.item_name) < 1) return acquire(fuel.item_name, 1)
    return emit({ name: 'supply_entity', args: { unit_number: machine.unit_number, items: [{ item_name: fuel.item_name, count: 1 }] } }, 1)
  }
  if (task.collection_only) {
    // Harness identity recovery may collect the committed result, but cannot
    // widen its authority into feeding/crafting if the previously seen output
    // disappears. Reconcile the complete target set before moving anything.
    const remaining = task.intent.targets.map(target => {
      const binding = task.intent.producers.find(row => row.recipe_name === target.item_name)
      return { target, machine: machines.find(row => row.unit_number === binding?.unit_number),
        missing: Math.max(0, target.count - (availability.available[target.item_name] ?? 0)) }
    })
    if (remaining.some(row => row.missing > (row.machine?.output[row.target.item_name] ?? 0))) return halt(task, 'production_collection_stock_unproven')
    const next = remaining.find(row => row.missing > 0)
    return next ? emit({ name: 'move_items_exact', args: { unit_number: next.machine.unit_number,
      item_name: next.target.item_name, max_count: Math.min(next.missing, PRODUCTION_LIMITS.batch_items), to_entity: false } })
      : halt(task, 'production_collection_checkpoint_unproven')
  }
  // Existing exact output is collected before acquiring or producing its deficit.
  for (const node of bill.nodes) {
    const binding = task.intent.producers.find(row => row.recipe_name === node.name)
    const machine = binding && machines.find(row => row.unit_number === binding.unit_number)
    if (binding && !machine) return halt(task, 'production_machine_identity_missing')
    if ((machine?.output[node.item_name] ?? 0) > 0) return emit({ name: 'move_items_exact', args: { unit_number: machine.unit_number, item_name: node.item_name, max_count: Math.min(node.desired_items, machine.output[node.item_name]), to_entity: false } })
  }
  for (const feeder of task.intent.feeders) {
    const machine = machines.find(row => row.unit_number === feeder.unit_number)
    if (!machine || machine.type !== 'mining-drill' || machine.drop_target !== feeder.output_unit_number
      || !task.intent.producers.some(row => row.unit_number === feeder.output_unit_number)) return halt(task, 'production_feeder_link_unproven')
    if (machine.energy_source === 'burner' && machine.status_name === 'no_fuel') return refuel(machine)
  }
  for (const node of bill.nodes) {
    const binding = task.intent.producers.find(row => row.recipe_name === node.name)
    const machine = binding && machines.find(row => row.unit_number === binding.unit_number)
    if (machine) {
      const recipe = facts.recipes.find(row => row.name === node.name)
      if (!(recipe?.crafting_machines ?? []).some(row => row.name === machine.name)) return halt(task, 'production_machine_incompatible')
      if (machine.type === 'assembling-machine' && machine.recipe !== node.name) return halt(task, 'production_machine_unconfigured')
      if (machine.recipe && machine.recipe !== node.name) return halt(task, 'production_recipe_changed')
      if (machine.energy_source === 'burner' && machine.status_name === 'no_fuel') return refuel(machine)
      const finiteInput = node.ingredients.length > 0 && node.ingredients.every(input => (machine.input[input.item_name] ?? 0) >= input.count)
      const feeder = task.intent.feeders.some(row => row.output_unit_number === machine.unit_number)
      const inProgress = machine.recipe === node.name && Number.isFinite(machine.progress) && machine.progress > 0 && machine.progress < 1
      if ((machine.working && (finiteInput || inProgress)) || (feeder && machines.some(row => row.drop_target === machine.unit_number && row.working))) {
        // Native recipe-backed wait; each wake rechecks real output and ownership.
        const seconds = Number.isFinite(node.energy) && node.energy > 0 ? node.energy / (machine.crafting_speed || 1) : 2
        return emit({ name: 'wait', args: { ticks: Math.max(120, Math.min(1200, Math.ceil(seconds * 60))) } })
      }
      if (machine.status_name === 'no_power' || machine.status_name === 'low_power') return halt(task, 'production_power_unavailable')
      if (finiteInput) return halt(task, 'production_loaded_machine_not_working')
      let crafts = Math.min(node.crafts, 32)
      for (const input of node.ingredients) crafts = Math.min(crafts, Math.floor((spendable(input.item_name) + (machine.input[input.item_name] ?? 0)) / input.count), Math.floor(PRODUCTION_LIMITS.batch_items / input.count))
      if (crafts > 0) {
        const items = node.ingredients.map(input => ({ item_name: input.item_name, count: Math.max(0, input.count * crafts - (machine.input[input.item_name] ?? 0)) })).filter(row => row.count > 0)
        if (items.length) return emit({ name: 'supply_entity', args: { unit_number: machine.unit_number, items } })
      }
    }
    else if (node.hand_craftable) {
      let crafts = Math.min(node.crafts, PRODUCTION_LIMITS.batch_items)
      for (const input of node.ingredients) crafts = Math.min(crafts, Math.floor(spendable(input.item_name) / input.count))
      if (crafts > 0) return emit({ name: 'craft_item', args: { item_name: node.name, count: crafts } })
    }
    else return halt(task, `production_producer_unbound:${node.name}`)
  }
  const leaf = bill.acquisition.find(row => row.count > 0)
  if (leaf) return acquire(leaf.item_name, leaf.count)
  return halt(task, 'production_dependency_unresolved')
}
