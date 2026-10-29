import { createFactoryRegistry, restoreFactoryRegistry, registerFactoryCell, registerFactoryDependency, findFactoryCellByMember, FactoryRegistryError } from './factory-registry.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { pendingOperations } from './operation-ledger.mjs'
import { restoreFactoryObservationSummaries } from './factory-cell-observation.mjs'

const clone = value => structuredClone(value)
const fail = (code, message = code) => { throw new FactoryRegistryError(code, message) }
const positive = value => Number.isSafeInteger(value) && value > 0
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const SCOPE = ['world_id', 'surface_index', 'force_index', 'actor_id', 'actor_epoch', 'request_id', 'goal_id', 'plan_id', 'plan_version', 'step_id', 'semantic_step_id']
// Native area_clearing.clearable_construction_blocker independently excludes
// placed buildings. Ordinary natural clearance does not reassign cell members.
const MUTATIONS = new Set(['mine_entity_exact', 'mine_entity', 'rotate_entity', 'set_machine_recipe'])

// A world-owned store. It is deliberately not a planning reducer field and is
// never exposed by reference. There is no registration tool or model JSON route.
export class FactoryRegistryStore {
  #registry
  #worldId
  #fault
  #generation = 0
  #observations = []

  constructor(expectedWorldId) {
    if (expectedWorldId !== undefined) {
      // Validate the explicit host binding without creating/adopting a registry.
      createFactoryRegistry(expectedWorldId)
      this.#worldId = expectedWorldId
    }
  }

  initialize(worldId) {
    if (this.#fault) fail('factory_registry_fault')
    if (this.#worldId !== undefined && worldId !== this.#worldId) fail('factory_world_mismatch')
    const fresh = createFactoryRegistry(worldId)
    this.#worldId = worldId
    this.#registry ??= fresh
    return this.read()
  }

  read() {
    if (this.#fault) fail('factory_registry_fault')
    if (!this.#registry) fail('factory_registry_uninitialized')
    return clone(this.#registry)
  }

  status() { return { status: this.#fault ? 'fault' : this.#registry ? 'initialized' : 'uninitialized' } }

  worldBinding() { return { world_id: this.#worldId, generation: this.#generation } }
  observations() { return clone(this.#observations) }

  snapshot() {
    return {
      ...(this.#worldId !== undefined ? { factory_registry_world_id: this.#worldId } : {}),
      ...(this.#registry ? { factory_registry: clone(this.#registry) } : {}),
      ...(this.#fault ? { factory_registry_fault: clone(this.#fault) } : {}),
      ...(this.#observations.length ? { factory_cell_observations: clone(this.#observations) } : {}),
    }
  }

  restore(snapshot) {
    // Every restore invalidates ephemeral registration capabilities/receipts.
    this.#generation++
    if (this.#fault) return
    const has = key => Object.hasOwn(snapshot ?? {}, key)
    if (!has('factory_registry') && !has('factory_registry_fault') && !has('factory_registry_world_id') && !has('factory_cell_observations')) return
    try {
      if (has('factory_registry_fault')) fail('persisted_factory_registry_fault')
      const storedWorld = snapshot.factory_registry_world_id
      if (storedWorld !== undefined) {
        createFactoryRegistry(storedWorld)
        if (this.#worldId !== undefined && this.#worldId !== storedWorld) fail('factory_world_mismatch')
        this.#worldId = storedWorld
      }
      if (!has('factory_registry')) {
        if (has('factory_cell_observations')) fail('factory_observation_registry_missing')
        return
      }
      // Never infer the world identity from the payload being restored.
      if (this.#worldId === undefined) fail('factory_world_unbound')
      const restored = restoreFactoryRegistry(snapshot.factory_registry, { worldId: this.#worldId })
      if (this.#registry && (restored.revision < this.#registry.revision
        || (restored.revision === this.#registry.revision && JSON.stringify(restored) !== JSON.stringify(this.#registry)))) fail('factory_registry_rollback')
      if (this.#registry) {
        if (restored.next_cell_id < this.#registry.next_cell_id || restored.next_dependency_id < this.#registry.next_dependency_id) fail('factory_registry_rollback')
        for (const [field, id] of [['cells', 'cell_id'], ['dependencies', 'dependency_id']]) {
          for (const previous of this.#registry[field]) {
            const next = restored[field].find(row => row[id] === previous[id])
            if (!next) fail('factory_registry_history_rewritten')
            // Observations may evolve; declared jobs, membership, origins and
            // dependencies have no change/removal authority in stage 1.
            const immutable = row => field === 'cells' ? Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'observation')) : row
            if (JSON.stringify(immutable(previous)) !== JSON.stringify(immutable(next))) fail('factory_registry_history_rewritten')
          }
        }
      }
      this.#registry = restored
      this.#observations = restoreFactoryObservationSummaries(snapshot.factory_cell_observations, restored)
    }
    catch (error) {
      // A bounded durable fault is sufficient to preserve rejection. Never save
      // a malformed body as a valid empty registry or silently clear the fault.
      this.#fault = { code: 'factory_registry_restore_failed', reason: error?.code ?? 'invalid_schema' }
    }
  }

  member(identity) {
    const registry = this.read()
    return findFactoryCellByMember(registry, identity)
  }

  placementAvailability(placement) {
    if (this.#fault) return { status: 'unknown', reason: 'factory_registry_fault' }
    if (!this.#registry) return { status: 'uninitialized' }
    if (!positive(placement?.unit_number) || !token(placement?.entity_name)) return { status: 'unknown', reason: 'placement_identity_missing' }
    // This is a conservative exclusion, not a positive world lookup: any cell
    // claiming this unit prevents reuse, even if the caller lacks surface facts.
    const cell = this.#registry.cells.find(row => row.members.some(member => member.unit_number === placement.unit_number))
    return cell ? { status: 'assigned', cell_id: cell.cell_id } : { status: 'unassigned' }
  }

  admission(operations) {
    for (const [index, operation] of (operations ?? []).entries()) {
      if (!MUTATIONS.has(operation?.name)) continue
      const base = { ok: false, refusal_class: 'world', stage: 'admission', operation: operation.name, operation_index: index }
      if (this.#fault) return { ...base, code: 'factory_registry_unavailable', reason: 'factory_registry_fault' }
      if (!this.#registry?.cells.length) continue
      const args = operation.args ?? {}
      let cell
      if (operation.name === 'mine_entity') {
        cell = this.#registry.cells.find(row => row.members.some(member => member.name === args.entity_name))
        if (!token(args.entity_name)) return { ...base, code: 'factory_cell_change_forbidden', reason: 'mutation_target_unproven' }
      }
      else {
        if (!positive(args.unit_number)) return { ...base, code: 'factory_cell_change_forbidden', reason: 'mutation_target_unproven' }
        cell = this.#registry.cells.find(row => row.members.some(member => member.unit_number === args.unit_number))
      }
      if (cell) return { ...base, code: 'factory_cell_change_forbidden', reason: 'registered_member_assignment', cell_id: cell.cell_id,
        ...(positive(args.unit_number) ? { unit_number: args.unit_number } : {}) }
    }
    return { ok: true }
  }

  // Host-only capability: readContext must read the host's current request and
  // authoritative idle/native state, never fields supplied by a model. Creating
  // a new capability does not adopt placements or establish native correctness.
  runtime(memory, key, readContext, readPlacementReceipt, trace) {
    if (typeof readContext !== 'function' || typeof readPlacementReceipt !== 'function' || !token(key)) fail('factory_runtime_context_required')
    const generation = this.#generation
    const placements = new Map()
    // Read-only inspection can inform a planner before a plan is committed.
    // This scope never grants enrollment, dependency or historical-cache writes.
    const readScope = () => {
      this.read()
      if (generation !== this.#generation) fail('factory_runtime_stale')
      const raw = readContext()
      const planning = memory.planningState(key)
      const plan = getActivePlan(planning)
      const step = plan?.steps?.[plan.active_step_index]
      if (!raw || raw.world_id !== this.#worldId || !positive(raw.surface_index) || !positive(raw.force_index)
        || !positive(raw.actor_id) || !Number.isSafeInteger(raw.actor_epoch) || raw.actor_epoch < 0 || !token(raw.request_id)) fail('factory_runtime_scope_invalid')
      if (raw.native_idle !== true || raw.pending !== false || raw.uncertain !== false || pendingOperations(planning).length > 0) fail('factory_runtime_not_idle')
      return { world_id: this.#worldId, surface_index: raw.surface_index, force_index: raw.force_index,
        actor_id: raw.actor_id, actor_epoch: raw.actor_epoch, request_id: raw.request_id,
        goal_id: planning?.goal?.goal_id, goal_status: planning?.goal?.status,
        plan_id: plan?.plan_id, plan_version: plan?.plan_version, plan_status: plan?.status,
        step_id: step?.step_id, semantic_step_id: step?.semantic_step_id ?? step?.step_id,
        paused: planning?.run?.paused === true, expected_revision: this.#registry.revision }
    }
    const checkedRead = scope => {
      const current = readScope()
      if (scope?.expected_revision !== current.expected_revision) fail('factory_registry_revision_stale')
      if (!scope || Object.keys(current).some(field => current[field] !== scope[field])) fail('factory_runtime_scope_stale')
      return current
    }
    const context = () => {
      this.read()
      if (generation !== this.#generation) fail('factory_runtime_stale')
      const raw = readContext()
      const planning = memory.planningState(key)
      const plan = getActivePlan(planning)
      const step = plan?.steps?.[plan.active_step_index]
      if (planning?.goal?.status !== 'active' || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan?.status) || !step
        || planning?.run?.paused === true) fail('factory_plan_authority_missing')
      if (!raw || raw.world_id !== this.#worldId || !positive(raw.surface_index) || !positive(raw.force_index)
        || !positive(raw.actor_id) || !Number.isSafeInteger(raw.actor_epoch) || raw.actor_epoch < 0 || !token(raw.request_id)) fail('factory_runtime_scope_invalid')
      if (raw.native_idle !== true || raw.pending !== false || raw.uncertain !== false || pendingOperations(planning).length > 0) fail('factory_runtime_not_idle')
      return { world_id: this.#worldId, surface_index: raw.surface_index, force_index: raw.force_index,
        actor_id: raw.actor_id, actor_epoch: raw.actor_epoch, request_id: raw.request_id,
        goal_id: planning.goal.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version,
        step_id: step.step_id, semantic_step_id: step.semantic_step_id ?? step.step_id, expected_revision: this.#registry.revision }
    }
    const checked = scope => {
      const current = context()
      if (!scope || SCOPE.some(field => scope[field] !== current[field])) fail('factory_runtime_scope_stale')
      if (scope.expected_revision !== current.expected_revision) fail('factory_registry_revision_stale')
      return current
    }
    const origin = (scope, source = 'runtime_registration') => ({ source, goal_id: scope.goal_id, plan_id: scope.plan_id,
      plan_version: scope.plan_version, semantic_step_id: scope.semantic_step_id, request_id: scope.request_id,
      actor_id: scope.actor_id, actor_epoch: scope.actor_epoch })
    const run = (action, scope, mutate) => {
      try {
        const current = checked(scope)
        const result = mutate(current)
        trace('factory_registry.updated', { action, world_id: this.#worldId, registry_revision: this.#registry.revision,
          goal_id: current.goal_id, plan_id: current.plan_id, step_id: current.semantic_step_id, request_id: current.request_id })
        return result
      }
      catch (error) {
        trace('factory_registry.refused', { action, code: error?.code ?? 'invalid_schema', request_id: scope?.request_id })
        throw error
      }
    }
    return Object.freeze({
      scope: () => clone(context()),
      assertScope: scope => clone(checked(scope)),
      readScope: () => clone(readScope()),
      assertReadScope: scope => clone(checkedRead(scope)),
      recordObservation: (observation, scope) => run('record_observation', scope, current => {
        if (observation.world_id !== current.world_id || observation.registry_revision !== current.expected_revision
          || observation.request_id !== current.request_id || observation.actor_id !== current.actor_id
          || observation.actor_epoch !== current.actor_epoch) fail('factory_observation_scope_mismatch')
        const rows = this.#observations.filter(row => row.cell_id !== observation.cell_id)
        this.#observations = restoreFactoryObservationSummaries([...rows, observation], this.#registry)
        return clone(this.#observations.find(row => row.cell_id === observation.cell_id))
      }),
      origin: () => clone(origin(context())),
      recordPlacement: (member, scope) => run('record_placement', scope, current => {
        const recorded = memory.authorizationState(key)?.world?.npc_placements?.find(row => row.unit_number === member?.unit_number)
        if (!recorded || recorded.entity_name !== member.name || recorded.placed_last_user !== null
          || member.surface_index !== current.surface_index || member.force_index !== current.force_index) fail('factory_placement_unproven')
        if (!token(member.provenance?.receipt_id)) fail('factory_placement_receipt_required')
        // The host callback supplies a retained exact native placement fact.
        // A declaration/old NPC list cannot manufacture location or lineage.
        const native = readPlacementReceipt(member.provenance.receipt_id)
        const historical = memory.planningState(key)?.plans?.find(row => row.plan_id === native?.plan_id && row.plan_version === native?.plan_version)
        const historicalStep = historical?.steps?.find(row => row.step_id === native?.step_id
          && (row.semantic_step_id ?? row.step_id) === native?.semantic_step_id)
        if (!native || native.receipt_id !== member.provenance.receipt_id
          || ['world_id', 'surface_index', 'force_index', 'goal_id'].some(field => native[field] !== current[field])
          || !historicalStep || !token(native.request_id) || !positive(native.actor_id)
          || !Number.isSafeInteger(native.actor_epoch) || native.actor_epoch < 0
          || recorded.actor_id !== native.actor_id || recorded.actor_epoch !== native.actor_epoch
          || native.unit_number !== member.unit_number || native.name !== member.name
          || native.position?.x !== member.position?.x || native.position?.y !== member.position?.y) fail('factory_native_placement_mismatch')
        // A cell may be built over multiple requests/steps or an actor restart.
        // Preserve the actual retained provenance; current authority is checked
        // independently. Cross-goal adoption is deliberately not in stage 1.
        const proof = { ...origin(native, 'npc_placement_receipt'), receipt_id: member.provenance.receipt_id }
        // Core validates the full member identity and bounded provenance. This
        // temporary declaration never enters the durable world registry.
        const candidate = registerFactoryCell(createFactoryRegistry(this.#worldId), {
          surface_index: current.surface_index, force_index: current.force_index,
          assignment: { products: ['placement-proof'], purpose: 'Validate recorded placement identity', method: 'runtime receipt' },
          members: [{ ...member, provenance: proof }], ports: [], origin: proof,
        }).cells[0].members[0]
        placements.set(candidate.unit_number, { member: candidate, scope: clone(current) })
        return clone(candidate)
      }),
      registerCell: (declaration, scope) => run('register_cell', scope, current => {
        if (declaration?.surface_index !== current.surface_index || declaration?.force_index !== current.force_index) fail('factory_cell_scope_mismatch')
        if (!declaration?.origin || Object.entries(origin(current)).some(([field, value]) => declaration.origin[field] !== value)) fail('factory_origin_stale')
        for (const member of declaration.members ?? []) {
          const receipt = placements.get(member.unit_number)
          if (!receipt || ['world_id', 'surface_index', 'force_index', 'goal_id'].some(field => receipt.scope[field] !== current[field])
            || JSON.stringify(receipt.member) !== JSON.stringify(member)) fail('factory_placement_unproven')
        }
        this.#registry = registerFactoryCell(this.#registry, declaration)
        return clone(this.#registry.cells.at(-1))
      }),
      registerDependency: (declaration, scope) => run('register_dependency', scope, current => {
        const ids = [declaration?.consumer?.cell_id, ...(declaration?.supplier?.kind === 'cell' ? [declaration.supplier.cell_id] : [])]
        if (ids.some(id => !this.#registry.cells.some(cell => cell.cell_id === id && cell.surface_index === current.surface_index
          && cell.force_index === current.force_index))) fail('factory_dependency_scope_mismatch')
        this.#registry = registerFactoryDependency(this.#registry, declaration)
        return clone(this.#registry.dependencies.at(-1))
      }),
    })
  }
}
