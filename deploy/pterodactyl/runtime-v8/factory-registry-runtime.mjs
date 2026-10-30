import { createFactoryRegistry, restoreFactoryRegistry, registerFactoryCell, registerFactoryDependency, FactoryRegistryError, appendFactoryCellMetadata, factoryCellIdentity, factoryCellMetadataHead, factoryMetadataDigest, reconcileFactoryMetadataPublication } from './factory-registry.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { pendingOperations } from './operation-ledger.mjs'
import { restoreFactoryObservationSummaries } from './factory-cell-observation.mjs'
import { FactoryPlacementStore } from './factory-placement-provenance.mjs'
import { FactoryCellLifecycleStore } from './factory-cell-lifecycle.mjs'
import { operationSignature } from './operation-reconciliation.mjs'
import { committedFactoryCellIntent, factoryCellIntentSignature, factoryIntentAssignment, factoryIntentMembers, factoryIntentOutputs, factoryIntentPorts } from './factory-cell-intent.mjs'

const clone = value => structuredClone(value)
const fail = (code, message = code) => { throw new FactoryRegistryError(code, message) }
const positive = value => Number.isSafeInteger(value) && value > 0
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const SCOPE = ['world_id', 'surface_index', 'force_index', 'actor_id', 'actor_epoch', 'request_id', 'session_id', 'goal_id', 'plan_id', 'plan_version', 'step_id', 'semantic_step_id']
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
  #placementReceipts = new FactoryPlacementStore()
  #metadata
  #lifecycle = new FactoryCellLifecycleStore({ readPlacementReceipt: id => this.#placementReceipts.read(id), readPlacementReceipts: scope => this.#placementReceipts.scoped(scope) })

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

  operational() { const registry = this.read(); return { ...registry, cells: registry.cells.map(cell => this.#lifecycle.project(cell)) } }
  lifecycleRevision() { return this.#lifecycle.revision() }
  lifecycleTransactions() { return this.#lifecycle.transactions() }
  lifecycleTemporaryIntents() { return this.#lifecycle.pendingTemporaryIntents() }
  lifecycleTemporaryAssets() { return this.#lifecycle.temporaryAssets() }
  lifecycleResidualRetryKeys(operations, context) {
    this.#lifecycle.assertDurable()
    const tx = this.#lifecycle.transactions().find(row => row.state === 'degraded'
      && ['goal_id', 'plan_id', 'plan_version', 'semantic_step_id', 'request_id'].every(field => row.owner[field] === context[field])
      && row.operations[row.next_operation] && operationSignature(operations) === operationSignature([row.operations[row.next_operation].operation]))
    return tx?.claims.filter(claim => claim.state === 'residual_reconciled' && claim.binding.signature === operationSignature(operations)).map(claim => claim.binding.operation_key) ?? []
  }
  assertTemporaryCell(cell) {
    if (!cell.support) return
    const asset = this.#lifecycle.temporaryAssets().find(row => row.intent_id === cell.support.intent_id && row.receipt_id === cell.support.receipt_id)
    const receipt = asset && this.#placementReceipts.read(asset.receipt_id)
    const member = cell.members?.[0]
    if (!asset || !receipt || factoryMetadataDigest(receipt) !== factoryMetadataDigest(asset.placement_receipt)
      || cell.assignment.purpose !== asset.purpose || cell.assignment.method !== 'receipt_backed_temporary_support'
      || ['unit_number', 'name', 'surface_index', 'force_index'].some(field => member?.[field] !== receipt[field])
      || factoryMetadataDigest(member?.position) !== factoryMetadataDigest(receipt.position)) fail('factory_temporary_provenance_mismatch')
  }
  markLifecyclePersisted(snapshot) { return this.#lifecycle.revision() === 0 || this.#lifecycle.markPersisted(snapshot) }
  lifecycleRuntime(memory, key, readContext) {
    if (typeof readContext !== 'function' || !token(key)) fail('factory_runtime_context_required')
    const generation = this.#generation
    const context = () => {
      if (generation !== this.#generation) fail('factory_runtime_stale')
      if (this.#metadata) fail('factory_metadata_publication_pending')
      const state = memory.planningState(key); const plan = getActivePlan(state); const step = plan?.steps?.[plan.active_step_index]
      const raw = readContext()
      if (raw?.world_id !== this.#worldId || !step || state?.goal?.status !== 'active'
        || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) fail('factory_lifecycle_plan_authority_missing')
      return { ...raw, goal_id: state.goal.goal_id, goal_status: state.goal.status, plan_id: plan.plan_id, plan_version: plan.plan_version,
        step_id: step.step_id, semantic_step_id: step.semantic_step_id ?? step.step_id, paused: state.run?.paused === true,
        authority_fingerprint: factoryMetadataDigest({ goal_id: state.goal.goal_id, objective: state.goal.objective ?? null, constraints: state.goal.constraints ?? [],
          goal_definition: state.goal.definition ?? state.goal.requested_result ?? null,
          plan_id: plan.plan_id, plan_version: plan.plan_version, steps: plan.steps, control_revision: memory.factoryControlRevision() }),
        control_revision: memory.factoryControlRevision() }
    }
    return Object.freeze({
      begin: (change, evidence) => this.#lifecycle.begin(change, this.operational(), context(), evidence),
      rebind: (id, evidence) => this.#lifecycle.rebind(id, this.operational(), context(), evidence),
      claim: (id, pending) => this.#lifecycle.claim(id, pending, this.operational(), context()),
      settle: (status, pending, receipt) => this.#lifecycle.settle(status, pending, context(), receipt),
      notSent: (pending, witness) => this.#lifecycle.notSent(pending, context(), witness),
      finish: (id, evidence) => this.#lifecycle.finish(id, this.operational(), context(), evidence),
      reconcileResidual: (id, evidence) => this.#lifecycle.reconcileResidual(id, this.operational(), context(), evidence),
      admission: (operations, pending) => this.#lifecycle.admission(operations, pending, context()),
      declareTemporary: intent => this.#lifecycle.declareTemporary(intent, context()),
      bindTemporaryPlacement: (id, pending) => this.#lifecycle.bindTemporaryPlacement(id, pending, context()),
      temporary: (intent, receipt) => this.#lifecycle.temporary(intent, receipt, context()),
      scheduleCleanup: completions => this.#lifecycle.scheduleCleanup(completions, context()),
    })
  }

  status() { return { status: this.#fault ? 'fault' : this.#registry ? 'initialized' : 'uninitialized' } }

  worldBinding() { return { world_id: this.#worldId, generation: this.#generation } }
  observations() { return clone(this.#observations) }
  placementReceipt(id) { return this.#placementReceipts.read(id) }
  placementReceipts(scope) { return this.#placementReceipts.scoped(scope) }
  placementCapacity() { return this.#placementReceipts.capacity() }
  invalidateEnrollmentPersistence() { this.#fault ??= { code: 'factory_enrollment_persistence_failed' } }
  invalidatePlacementPersistence() { this.#placementReceipts.invalidatePersistence() }
  recordPlacementReceipt(receipt, generation) {
    if (generation !== this.#generation) fail('factory_runtime_stale')
    this.read()
    return this.#placementReceipts.record(receipt, this.#worldId)
  }

  snapshot() {
    return {
      ...this.#placementReceipts.snapshot(),
      ...this.#lifecycle.snapshot(),
      ...(this.#worldId !== undefined ? { factory_registry_world_id: this.#worldId } : {}),
      ...(this.#registry ? { factory_registry: clone(this.#metadata?.candidateStaged ? this.#metadata.candidate : this.#registry) } : {}),
      ...(this.#fault ? { factory_registry_fault: clone(this.#fault) } : {}),
      ...(this.#metadata ? { factory_metadata_pending: this.#metadataMarker() } : {}),
      ...(this.#observations.length ? { factory_cell_observations: clone(this.#observations) } : {}),
    }
  }

  #metadataMarker() {
    return { schema_version: 1, transaction_id: this.#metadata.change.transaction_id, candidate_digest: factoryMetadataDigest(this.#metadata.candidate),
      previous_digest: factoryMetadataDigest(this.#registry), request_digest: factoryMetadataDigest(this.#metadata.change),
      owner: clone(this.#metadata.owner), previous_revision: this.#registry.revision, state: 'publication_unconfirmed',
      previous_registry: clone(this.#registry), change: clone(this.#metadata.change) }
  }

  #metadataTicket(ticket) {
    if (!this.#metadata || this.#metadata.ticket !== ticket) fail('factory_metadata_ticket_stale')
    if (this.#fault) fail('factory_registry_fault')
    this.#metadata.assert()
    return this.#metadata
  }

  assertMetadataPersistence(ticket, phase) {
    const pending = this.#metadataTicket(ticket)
    if (!['prepare', 'commit'].includes(phase) || (phase === 'commit' && !pending.walDurable)) fail('factory_metadata_wal_required')
    if (pending.commitDurable) fail('factory_metadata_ticket_stale')
    return true
  }
  assertMetadataOwner(ticket) { this.#metadataTicket(ticket); return true }

  metadataPersistenceSnapshot(ticket, phase) {
    this.assertMetadataPersistence(ticket, phase)
    const snapshot = this.snapshot()
    if (phase === 'commit') {
      this.#metadata.candidateStaged = true
      snapshot.factory_registry = clone(this.#metadata.candidate)
      // Retain unresolved publication evidence through the rename/ownership
      // acknowledgement window. Only a later ordinary save of the successfully
      // finished live store may clear it. Cold restore reconciles only exact
      // complete old/candidate files and never restores this live capability.
      // Existing observation summaries remain historical but may refer to old
      // revisions; never carry a validation cache into the new metadata head.
      delete snapshot.factory_cell_observations
    }
    return snapshot
  }

  markMetadataPersisted(ticket, phase) {
    // Called immediately after successful atomic rename, before the post-await
    // ownership fence. This is acknowledgement, not live publication authority.
    if (!this.#metadata || this.#metadata.ticket !== ticket) fail('factory_metadata_ticket_stale')
    if (phase === 'prepare') this.#metadata.walDurable = true
    else if (phase === 'commit') this.#metadata.commitDurable = true
  }

  finishMetadata(ticket) {
    const pending = this.#metadataTicket(ticket)
    if (!pending.commitDurable) fail('factory_metadata_persistence_required')
    this.#registry = pending.candidate; this.#observations = []; this.#metadata = undefined
    return clone(this.#registry.cells.find(c => c.cell_id === pending.change.cell_id))
  }

  abortMetadata(ticket) {
    if (!this.#metadata || this.#metadata.ticket !== ticket) return
    const pending = this.#metadata
    // Before the WAL succeeds no candidate can have been written. Once it has
    // succeeded, keep the old assignment plus a durable fault on every snapshot.
    if (pending.walDurable) this.#fault ??= { code: 'factory_metadata_publication_failed', transaction_id: pending.change.transaction_id,
      commit_acknowledged: pending.commitDurable }
    if (pending.candidateStaged) this.#registry = pending.candidate
    this.#metadata = undefined
    this.#generation++
  }

  metadataPending() { return Boolean(this.#metadata) }

  restore(snapshot, trace = () => {}) {
    // Every restore invalidates ephemeral registration capabilities/receipts.
    this.#generation++
    if (this.#metadata) {
      this.#fault ??= { code: 'factory_metadata_restore_during_publication' }
      this.#metadata = undefined
    }
    // Restore evidence even when the assignment store is faulted; its durable
    // fault remains independent and cannot remove existing assignment guards.
    this.#placementReceipts.restore(snapshot ?? {}, this.#worldId ?? snapshot?.factory_registry_world_id)
    this.#lifecycle.restore(snapshot ?? {}, this.#worldId ?? snapshot?.factory_registry_world_id)
    if (this.#fault) return
    const has = key => Object.hasOwn(snapshot ?? {}, key)
    if (!has('factory_registry') && !has('factory_registry_fault') && !has('factory_registry_world_id') && !has('factory_cell_observations') && !has('factory_metadata_pending')) return
    try {
      if (has('factory_registry_fault')) fail('persisted_factory_registry_fault')
      const storedWorld = snapshot.factory_registry_world_id
      if (storedWorld !== undefined) {
        createFactoryRegistry(storedWorld)
        if (this.#worldId !== undefined && this.#worldId !== storedWorld) fail('factory_world_mismatch')
        this.#worldId = storedWorld
      }
      if (!has('factory_registry')) {
        if (has('factory_metadata_pending')) fail('factory_metadata_publication_unconfirmed')
        if (has('factory_cell_observations')) fail('factory_observation_registry_missing')
        return
      }
      // Never infer the world identity from the payload being restored.
      if (this.#worldId === undefined) fail('factory_world_unbound')
      const restored = restoreFactoryRegistry(snapshot.factory_registry, { worldId: this.#worldId })
      const reconciled = has('factory_metadata_pending')
        ? reconcileFactoryMetadataPublication(restored, snapshot.factory_metadata_pending, this.#worldId) : undefined
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
            if (field === 'cells') {
              if (factoryMetadataDigest(factoryCellIdentity(previous)) !== factoryMetadataDigest(factoryCellIdentity(next)) || next.revision < previous.revision) fail('factory_registry_history_rewritten')
              if (previous.revision === 1) {
                if (factoryCellMetadataHead(previous) !== (next.metadata_history?.[0]?.digest ?? factoryCellMetadataHead(next))) fail('factory_registry_history_rewritten')
              } else if (factoryMetadataDigest(previous.metadata_history) !== factoryMetadataDigest(next.metadata_history?.slice(0, previous.revision))) fail('factory_registry_history_rewritten')
            } else if (JSON.stringify(previous) !== JSON.stringify(next)) fail('factory_registry_history_rewritten')
          }
        }
      }
      this.#registry = restored
      for (const cell of restored.cells) this.assertTemporaryCell(cell)
      const lifecycle = this.#lifecycle.snapshot().factory_lifecycle
      for (const cell of restored.cells) for (const metadata of cell.metadata_history ?? []) {
        if (!metadata.installed_members) continue
        if (!lifecycle || metadata.lifecycle_revision > lifecycle.events.length) fail('factory_metadata_physical_history_missing')
        const historical = new FactoryCellLifecycleStore()
        historical.restore({ factory_lifecycle: { ...lifecycle, events: lifecycle.events.slice(0, metadata.lifecycle_revision) } }, this.#worldId)
        const installed = historical.project(cell)
        if (installed.lifecycle_state !== 'installed' || installed.physical_revision !== metadata.physical_revision
          || factoryMetadataDigest(installed.members) !== factoryMetadataDigest(metadata.installed_members)) fail('factory_metadata_physical_history_mismatch')
      }
      this.#observations = reconciled ? [] : restoreFactoryObservationSummaries(snapshot.factory_cell_observations, restored)
      if (reconciled) trace('factory_metadata.reconciled', reconciled)
    }
    catch (error) {
      // A bounded durable fault is sufficient to preserve rejection. Never save
      // a malformed body as a valid empty registry or silently clear the fault.
      this.#fault = { code: 'factory_registry_restore_failed', reason: error?.code ?? 'invalid_schema' }
    }
  }

  member(identity) {
    const registry = this.operational()
    if (identity?.world_id !== registry.world_id || !positive(identity.surface_index) || !positive(identity.force_index) || !positive(identity.unit_number)) return null
    return registry.cells.find(cell => cell.members.some(member => member.surface_index === identity.surface_index && member.force_index === identity.force_index
      && member.unit_number === identity.unit_number && (identity.name === undefined || identity.name === member.name)
      && (identity.position === undefined || identity.position?.x === member.position.x && identity.position?.y === member.position.y))) ?? null
  }

  placementAvailability(placement) {
    if (this.#fault) return { status: 'unknown', reason: 'factory_registry_fault' }
    if (!this.#registry) return { status: 'uninitialized' }
    if (!positive(placement?.unit_number) || !token(placement?.entity_name)) return { status: 'unknown', reason: 'placement_identity_missing' }
    // This is a conservative exclusion, not a positive world lookup: any cell
    // claiming this unit prevents reuse, even if the caller lacks surface facts.
    const cell = [...this.#registry.cells, ...this.operational().cells].find(row => row.members.some(member => member.unit_number === placement.unit_number))
    return cell ? { status: 'assigned', cell_id: cell.cell_id } : { status: 'unassigned' }
  }

  admission(operations, owner) {
    if (this.#metadata && operations?.length) return { ok: false, refusal_class: 'world', stage: 'admission', code: 'factory_metadata_publication_pending', operation_index: 0, operation: operations[0]?.name }
    try { this.#lifecycle.assertDurable() }
    catch (error) { return { ok: false, refusal_class: 'world', stage: 'admission', code: error.code } }
    if (this.#lifecycle.pending()) {
      // This is only the planning admission preview. The pre-send boundary
      // additionally persists an exact protocol-2 claim and checks admission.
      const tx = this.#lifecycle.transactions().find(row => row.state === 'degraded'
        && ['goal_id', 'plan_id', 'request_id', 'actor_id', 'actor_epoch'].every(field => owner?.[field] === row.owner[field])
        && operationSignature(operations) === operationSignature([row.operations[row.next_operation]?.operation]))
      if (tx) return { ok: true, lifecycle_transaction_id: tx.transaction_id }
      return { ok: false, refusal_class: 'world', stage: 'admission', code: 'factory_lifecycle_reconciliation_required' }
    }
    const installed = this.#registry ? this.operational() : undefined
    for (const [index, operation] of (operations ?? []).entries()) {
      if (!MUTATIONS.has(operation?.name)) continue
      const base = { ok: false, refusal_class: 'world', stage: 'admission', operation: operation.name, operation_index: index }
      if (this.#fault) return { ...base, code: 'factory_registry_unavailable', reason: 'factory_registry_fault' }
      if (!this.#registry?.cells.length) continue
      const args = operation.args ?? {}
      let cell
      if (operation.name === 'mine_entity') {
        cell = installed.cells.find(row => row.members.some(member => member.name === args.entity_name))
        if (!token(args.entity_name)) return { ...base, code: 'factory_cell_change_forbidden', reason: 'mutation_target_unproven' }
      }
      else {
        if (!positive(args.unit_number)) return { ...base, code: 'factory_cell_change_forbidden', reason: 'mutation_target_unproven' }
        cell = installed.cells.find(row => row.members.some(member => member.unit_number === args.unit_number))
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
      if (this.#metadata) fail('factory_metadata_publication_pending')
      if (generation !== this.#generation) fail('factory_runtime_stale')
      const raw = readContext()
      const planning = memory.planningState(key)
      const plan = getActivePlan(planning)
      const step = plan?.steps?.[plan.active_step_index]
      if (!raw || raw.world_id !== this.#worldId || !positive(raw.surface_index) || !positive(raw.force_index)
        || !positive(raw.actor_id) || !Number.isSafeInteger(raw.actor_epoch) || raw.actor_epoch < 0 || !token(raw.request_id)) fail('factory_runtime_scope_invalid')
      if (raw.native_idle !== true || raw.pending !== false || raw.uncertain !== false || pendingOperations(planning).length > 0) fail('factory_runtime_not_idle')
      return { world_id: this.#worldId, surface_index: raw.surface_index, force_index: raw.force_index,
        actor_id: raw.actor_id, actor_epoch: raw.actor_epoch, request_id: raw.request_id, session_id: raw.session_id,
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
    const context = (allowPending = false) => {
      this.read()
      if (this.#metadata && !allowPending) fail('factory_metadata_publication_pending')
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
        actor_id: raw.actor_id, actor_epoch: raw.actor_epoch, request_id: raw.request_id, session_id: raw.session_id,
        goal_id: planning.goal.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version,
        step_id: step.step_id, semantic_step_id: step.semantic_step_id ?? step.step_id, expected_revision: this.#registry.revision }
    }
    const checked = (scope, allowPending = false) => {
      const current = context(allowPending)
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
        trace(action === 'prepare_metadata' ? 'factory_metadata.prepared' : 'factory_registry.updated', { action, world_id: this.#worldId, registry_revision: this.#registry.revision,
          goal_id: current.goal_id, plan_id: current.plan_id, step_id: current.semantic_step_id, request_id: current.request_id })
        return result
      }
      catch (error) {
        trace('factory_registry.refused', { action, code: error?.code ?? 'invalid_schema', request_id: scope?.request_id })
        throw error
      }
    }
    return Object.freeze({
      prepareMetadata: (change, scope) => run('prepare_metadata', scope, current => {
        if (!token(current.session_id)) fail('factory_metadata_session_required')
        this.#lifecycle.assertDurable()
        if (this.#lifecycle.pending()) fail('factory_lifecycle_reconciliation_required')
        const operational = this.operational()
        const physical = operational.cells.find(c => c.cell_id === change?.cell_id)
        if (change?.physical_context !== undefined) fail('factory_metadata_physical_context_host_owned')
        if (this.#lifecycle.revision() > 0) {
          if (change.expected_lifecycle_revision !== this.#lifecycle.revision()) fail('factory_lifecycle_revision_stale')
          for (const expected of change.expected_cells ?? []) {
            const installed = operational.cells.find(c => c.cell_id === expected.cell_id)
            if (!installed || (installed.physical_revision ?? 0) !== expected.physical_revision || ['retired', 'degraded'].includes(installed.state)) fail('factory_cell_physical_revision_stale')
          }
          if (physical?.physical_revision) change = { ...clone(change), physical_context: { physical_revision: physical.physical_revision, members: physical.members } }
        }
        const target = this.#registry.cells.find(c => c.cell_id === change?.cell_id)
        if (!target || target.surface_index !== current.surface_index || target.force_index !== current.force_index) fail('factory_metadata_scope_mismatch')
        let result
        try { result = appendFactoryCellMetadata(this.#registry, change, origin(current, 'runtime_metadata_declaration')) }
        catch (error) {
          if (error.code === 'factory_metadata_transaction_conflict') this.#fault ??= { code: error.code }
          throw error
        }
        if (result.duplicate) return { duplicate: true, cell: clone(this.#registry.cells.find(c => c.cell_id === result.cell_id)) }
        const ticket = Object.freeze({ transaction_id: change.transaction_id })
        this.#metadata = { ticket, change: clone(change), candidate: result.registry, walDurable: false, commitDurable: false,
          owner: clone(current), assert: () => checked(scope, true) }
        // Refuse capacity/schema issues before writing a WAL that cold restore
        // cannot reconcile. This uses the same bounded rule as restoration.
        try { reconcileFactoryMetadataPublication(this.#registry, this.#metadataMarker(), this.#worldId) }
        catch (error) { this.#metadata = undefined; throw error }
        return { duplicate: false, ticket }
      }),
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
        if (declaration.support) {
          this.assertTemporaryCell(declaration)
          const existing = this.#registry.cells.find(cell => cell.support?.receipt_id === declaration.support.receipt_id)
          if (existing) return clone(existing)
        }
        if (declaration.enrollment) {
          const plan = getActivePlan(memory.planningState(key)); const step = plan?.steps?.[plan.active_step_index]
          const intent = committedFactoryCellIntent(step)
          const enrolled = declaration.enrollment
          if (!intent || enrolled.goal_id !== current.goal_id || enrolled.semantic_step_id !== current.semantic_step_id
            || enrolled.intent_signature !== factoryCellIntentSignature(step.execution_guidance)
            || JSON.stringify(declaration.assignment) !== JSON.stringify(factoryIntentAssignment(intent))
            || declaration.members?.length !== factoryIntentMembers(intent).length
            || declaration.members.some((member, i) => member.name !== factoryIntentMembers(intent)[i].entity)
            || (intent.kind === 'production_block' && (JSON.stringify(enrolled.member_roles) !== JSON.stringify(factoryIntentMembers(intent).map((member, i) => ({ role: member.role, receipt_id: enrolled.receipt_ids[i] })))
              || JSON.stringify(enrolled.output_roles) !== JSON.stringify(factoryIntentOutputs(intent).map((output, i) => ({ port_id: factoryIntentPorts(intent)[i].port_id, role: output.role })))))
            || declaration.members.some((member, i) => member.provenance?.receipt_id !== enrolled.receipt_ids?.[i]
              || member.provenance.goal_id !== current.goal_id || member.provenance.semantic_step_id !== current.semantic_step_id)) fail('factory_enrollment_intent_mismatch')
          const existing = this.#registry.cells.find(cell => cell.enrollment?.goal_id === current.goal_id && cell.enrollment.semantic_step_id === current.semantic_step_id)
          if (existing) {
            if (['surface_index', 'force_index', 'assignment', 'members', 'ports', 'enrollment'].some(field => JSON.stringify(field === 'ports' ? existing.metadata_history?.[0]?.ports ?? existing.ports : existing[field]) !== JSON.stringify(declaration[field]))) fail('factory_enrollment_conflict')
            return clone(existing)
          }
        }
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
