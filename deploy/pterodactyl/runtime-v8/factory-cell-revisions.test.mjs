import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { commitFactoryCellMetadata } from './factory-cell-tools.mjs'
import { appendFactoryCellMetadata, factoryCellMetadataHead, factoryMetadataDigest, restoreFactoryRegistry } from './factory-registry.mjs'
import { factoryDependencySummary } from './factory-dependencies.mjs'
import { FakeFactorio } from './task-loop-fixtures.mjs'
import { recoverySession, settle } from './recovery-loop-fixtures.mjs'

const WORLD = '1f207b33-f2b7-4104-b04d-21bb089a304e'; const KEY = 'npc:cell-revisions'
const clone = value => structuredClone(value)
const throws = (fn, code) => assert.throws(fn, error => error.code === code)
function fixture() {
  const memory = new CanonicalTaskBoardMemory(); memory.initializeFactoryRegistry(WORLD)
  const checkpoint = { mode: 'all', confidence: 0.9, requirements: [{ id: 'held', kind: 'inventory_count', item_name: 'copper-plate', minimum: 1 }] }
  memory.recordPlan(KEY, { sender: 'owner', text: 'Retain dedicated production assignments' }, {
    chatMessage: '', plan: ['Observe current assigned cells'], currentStep: 0, operations: [], stepCompletions: [{ kind: 'deterministic', checkpoint }],
  }, { validatedPlannerAdmission: true })
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const context = { world_id: WORLD, surface_index: 1, force_index: 1, actor_id: 24, actor_epoch: 2, request_id: 'revision-request', session_id: 'revision-session', native_idle: true, pending: false, uncertain: false }
  const receipts = new Map(); const events = []
  memory.traceSink = (event, data) => events.push({ event, data })
  const runtime = memory.createFactoryRegistryRuntime(KEY, () => clone(context), id => clone(receipts.get(id)))
  for (const unit of [27, 28]) {
    const scope = runtime.scope(); const name = 'stone-furnace'
    memory.recordNpcPlacement(KEY, { unit_number: unit, entity_name: name, actor_id: context.actor_id, actor_epoch: context.actor_epoch })
    const raw = { unit_number: unit, name, position: { x: unit, y: 0 }, surface_index: 1, force_index: 1, provenance: { receipt_id: `fixture-${unit}` } }
    receipts.set(raw.provenance.receipt_id, { ...scope, receipt_id: raw.provenance.receipt_id, unit_number: unit, name, position: raw.position })
    const member = runtime.recordPlacement(raw, scope)
    runtime.registerCell({ surface_index: 1, force_index: 1, assignment: { products: ['copper-plate'], purpose: `Retain supplier ${unit}`, method: 'native production' },
      members: [member], ports: [{ port_id: 'out', direction: 'output', kind: 'item', resource: 'copper-plate' }], origin: runtime.origin() }, scope)
  }
  const game = { deployment: { revision: 'sgluna-deploy-v8-npc-staging', mode: 'npc', session: context.session_id, actor_id: 24, actor_kind: 'standalone_character', epoch: 2,
    allowed: true, idle: true, actor_interface: true, operations: true, tools: true, surface_index: 1, force_index: 1, connected_players: 0 },
  status: { task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1, admission_journal: [], receipt_journal: [] } }
  const rcon = { command: async text => {
    await game.onCommand?.(text)
    if (text.includes('sgluna_deployment')) return JSON.stringify(game.deployment)
    if (text.includes('autorio_actor')) return JSON.stringify({ mode: 'npc', actor: { kind: 'standalone_character', actor_id: 24, valid: true }, surface_index: 1, force_index: 1 })
    if (text.includes('autorio_operations')) return JSON.stringify(game.status)
    if (text.includes('world_identity')) return JSON.stringify({ schema_version: 1, ok: true, world_id: WORLD })
    throw new Error('Unexpected native call; metadata must not query or mutate endpoint gameplay')
  } }
  const agent = new NpcAgentLoop({ memory, rcon, stateFile: '/fixture/npc-state.json', traceFile: null, decisionTraceFile: null,
    npcId: 'cell-revisions', completionProtocolVersion: 3, jevCheckpoints: false, provider: () => assert.fail('No inference') })
  agent.active = true; agent.epoch = { ...game.deployment }; agent.requestInfo = { memoryKey: KEY }; agent.traceRequest = { id: context.request_id, seq: 0 }
  agent.turnConversation = agent.agentContext.beginRequest(0)
  agent.behaviorTrace = { emit: async record => events.push(record) }
  return { memory, runtime, context, events, agent, game }
}
function change(w, { target = 'cell-1', id = 'metadata-1', supplier, output = false, kind = 'item' } = {}) {
  const registry = w.memory.getFactoryRegistry(); const cell = registry.cells.find(c => c.cell_id === target)
  const portId = output ? 'out' : `input-${id}`
  const { provenance, ...member } = cell.members[0]
  const endpoint = kind === 'fluid' ? { kind: 'fluidbox', fluidbox_index: 1 } : kind === 'power' ? { kind: 'electric_network', electric_network_id: 31 } : { kind: 'inventory', inventory_index: 1 }
  const involved = [target, ...(supplier ? [supplier] : [])]
  return { transaction_id: id, cell_id: target, expected_registry_revision: registry.revision,
    expected_cells: [...new Set(involved)].map(cell_id => { const c = registry.cells.find(c => c.cell_id === cell_id); return { cell_id, revision: c.revision, digest: factoryCellMetadataHead(c) } }),
    input_ports: output ? [] : [{ port_id: portId, direction: 'input', kind, ...(kind === 'power' ? {} : { resource: kind === 'fluid' ? 'observed-fluid' : 'copper-plate' }) }],
    port_bindings: [{ port_id: portId, member, endpoint, state: 'unverified', evidence_refs: ['host-declaration-not-native-verification'] }],
    dependencies: output ? [] : [{ consumer: { cell_id: target, port_id: portId }, supplier: supplier ? { kind: 'cell', cell_id: supplier, port_id: 'out' } : { kind: 'unresolved' }, delivery: { kind: 'unknown' } }] }
}
// Run the actual NpcAgentLoop persistence queue with controlled filesystem I/O.
// This proves ordering/fences and retained payloads, not OS disk durability.
async function filesystem(body, hooks = {}) {
  const original = { mkdir: fsp.mkdir, writeFile: fsp.writeFile, rename: fsp.rename }
  const files = new Map(); const writes = []; let renames = 0
  fsp.mkdir = async () => { await hooks.mkdir?.() }
  fsp.writeFile = async (name, text) => { files.set(name, text); writes.push(JSON.parse(text)); await hooks.write?.(writes.length) }
  fsp.rename = async (from, to) => { renames++; await hooks.beforeRename?.(renames); files.set(to, files.get(from)); await hooks.afterRename?.(renames) }
  try { return await body({ files, writes, renames: () => renames }) }
  finally { Object.assign(fsp, original) }
}

test('real guarded bridge and persistence queue: WAL precedes atomic metadata; old view, immutable goal and members survive', async () => {
  const w = fixture(); const before = w.memory.snapshot(); const request = change(w)
  await filesystem(async io => {
    const result = await commitFactoryCellMetadata(w.agent, request)
    assert.equal(result.cell.revision, 2); assert.equal(result.cell.state, 'unverified')
    assert.equal(io.writes.length, 2); assert.ok(io.writes[0].factory_metadata_pending)
    assert.equal(io.writes[0].factory_registry.cells[0].revision, 1)
    assert.ok(io.writes[1].factory_metadata_pending); assert.equal(io.writes[1].factory_registry.cells[0].revision, 2)
    assert.deepEqual(w.memory.snapshot().planning_states, before.planning_states)
    assert.deepEqual(result.cell.members, before.factory_registry.cells[0].members)
    assert.deepEqual(result.cell.assignment, before.factory_registry.cells[0].assignment)
    await w.agent.persistState({ strict: true })
    const saved = JSON.parse(io.files.get(w.agent.stateFile)); const restored = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); restored.restore(saved)
    assert.deepEqual(restored.getFactoryRegistry(), w.memory.getFactoryRegistry())
    const summary = factoryDependencySummary(saved.factory_registry.cells, saved.factory_registry.dependencies, 'cell-1')
    assert.equal(summary.inbound[0].state, 'unverified'); assert.ok(summary.inbound[0].endpoint_bindings.consumer.binding_digest)
    assert.equal((await commitFactoryCellMetadata(w.agent, request)).duplicate, true)
    assert.equal(io.writes.length, 3, 'acknowledged duplicate does not rewrite disk or renew a revision')
    assert.ok(w.events.some(e => e.event === 'factory_metadata.published'))
  }, { write: () => {
    if (w.memory.factoryMetadataPending()) {
      assert.equal(w.memory.getFactoryRegistry().cells[0].revision, 1, 'candidate never leaks through query while persistence is pending')
      assert.equal(w.memory.checkOperationAdmission(KEY, { operations: [{ name: 'wait', args: { ticks: 1 } }] }).code, 'factory_metadata_publication_pending')
    }
  } })
})

test('supplier endpoint must be revision-bound; both participant CAS heads and global graph are checked', async () => {
  const w = fixture()
  await filesystem(async () => {
    const unbound = change(w, { supplier: 'cell-2' })
    throws(() => w.runtime.prepareMetadata(unbound, w.runtime.scope()), 'factory_metadata_endpoint_unbound')
    await commitFactoryCellMetadata(w.agent, change(w, { target: 'cell-2', output: true, id: 'supplier-output' }))
    const request = change(w, { supplier: 'cell-2' }); const corrupt = clone(request); corrupt.expected_cells[1].revision = 1
    throws(() => w.runtime.prepareMetadata(corrupt, w.runtime.scope()), 'factory_cell_revision_stale')
    const result = await commitFactoryCellMetadata(w.agent, request)
    assert.equal(result.cell.revision, 2)
    const registry = w.memory.getFactoryRegistry(); assert.equal(registry.dependencies[0].endpoint_bindings.supplier.cell_revision, 2)
    assert.deepEqual(factoryDependencySummary(registry.cells, registry.dependencies, 'cell-2').impact.direct_consumer_ids, ['cell-1'])
  })
})

test('one atomic revision can publish multiple bound inputs and dependencies, with no counter reuse', async () => {
  const w = fixture(); const request = change(w); const fluid = change(w, { id: 'fluid-input', kind: 'fluid' })
  for (const field of ['input_ports', 'port_bindings', 'dependencies']) request[field].push(...fluid[field])
  await filesystem(async io => {
    await commitFactoryCellMetadata(w.agent, request)
    const saved = JSON.parse(io.files.get(w.agent.stateFile)); const registry = saved.factory_registry
    assert.equal(registry.revision, 3); assert.equal(registry.next_dependency_id, 3)
    assert.equal(registry.cells[0].revision, 2); assert.equal(registry.dependencies.length, 2)
    assert.deepEqual(registry.cells[0].metadata_history[1].dependencies, registry.dependencies)
    assert.deepEqual(restoreFactoryRegistry(registry), registry)
    const incomplete = clone(registry); incomplete.cells[0].metadata_history[1].dependencies.pop()
    assert.throws(() => restoreFactoryRegistry(incomplete))
  })
})

test('ordinary persistence remains intact and cancellation before rename cannot replace canonical state', async () => {
  const w = fixture()
  await filesystem(async io => {
    await w.agent.persistState({ strict: true })
    assert.deepEqual(JSON.parse(io.files.get(w.agent.stateFile)), JSON.parse(JSON.stringify(w.memory.snapshot())))
  })
  let cancelled = false
  w.agent.assertRequestAdmission = () => { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'request_cancelled' }) }
  await filesystem(async io => {
    await assert.rejects(w.agent.persistState({ strict: true }), { code: 'request_cancelled' })
    assert.equal(io.renames(), 0)
  }, { write: () => { cancelled = true } })
})

test('lost commit acknowledgement never publishes live; cold restore reconciles the exact committed unverified file', async () => {
  const w = fixture(); const request = change(w)
  await filesystem(async io => {
    await assert.rejects(commitFactoryCellMetadata(w.agent, request))
    throws(() => w.memory.getFactoryRegistry(), 'factory_registry_fault')
    assert.equal(w.memory.snapshot().factory_registry.cells[0].revision, 2, 'uncertain candidate remains behind fault; never roll back disk history')
    const disk = JSON.parse(io.files.get(w.agent.stateFile))
    assert.equal(disk.factory_registry.cells[0].revision, 2, 'atomic rename may land before acknowledgement is lost')
    const restart = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); restart.restore(disk)
    assert.deepEqual(restart.getFactoryRegistry(), disk.factory_registry)
    assert.equal(restart.factoryMetadataPending(), false)
    assert.equal(restart.getFactoryRegistry().cells[0].state, 'unverified')
    assert.ok(disk.factory_metadata_pending)
  }, { afterRename: n => { if (n === 2) throw new Error('lost acknowledgement after atomic replacement') },
    write: n => { if (n >= 3) throw new Error('storage unavailable for fault write') } })
})

test('cancelled owner after candidate rename cannot clear evidence; cold restore cannot regain its capability', async () => {
  const w = fixture(); let revoked = false
  w.agent.assertRequestAdmission = () => { if (revoked) throw Object.assign(new Error('cancelled'), { code: 'request_cancelled' }) }
  await filesystem(async io => {
    await assert.rejects(commitFactoryCellMetadata(w.agent, change(w)))
    assert.equal(io.renames(), 2)
    const disk = JSON.parse(io.files.get(w.agent.stateFile)); assert.ok(disk.factory_metadata_pending)
    const restart = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); restart.restore(disk)
    assert.deepEqual(restart.getFactoryRegistry(), disk.factory_registry)
    assert.equal(restart.factoryMetadataPending(), false)
  }, { afterRename: n => { if (n === 2) { w.agent.epoch.session = 'superseded'; revoked = true } } })
})

test('ordinary snapshot queued before prepare captures latest marker and canonical goal', async () => {
  const w = fixture(); let release
  w.agent.persistQueue = new Promise(resolve => { release = resolve })
  await filesystem(async io => {
    const oldWrite = w.agent.persistState({ strict: true })
    const prepared = w.runtime.prepareMetadata(change(w), w.runtime.scope())
    release()
    await oldWrite
    assert.equal(io.renames(), 1); assert.ok(io.writes[0].factory_metadata_pending)
    w.memory.abortFactoryMetadata(prepared.ticket)
    assert.equal(w.memory.getFactoryRegistry().cells[0].revision, 1)
  })
})

for (const replaceGoal of [false, true]) test(`actual operator pause during WAL preserves canonical stop/new-goal state (${replaceGoal})`, async () => {
  const w = fixture(); w.agent.stateLoaded = true
  let stopAfterWal = false; let expectedPlanning
  w.game.onCommand = async () => {
    if (!stopAfterWal) return
    stopAfterWal = false
    await w.agent.pausePersistentPlan('owner_stop', { pause_class: 'operator' })
    assert.equal(w.memory.planningState(KEY).run.paused, true)
    if (replaceGoal) {
      const replacement = new NpcAgentLoop({ memory: w.memory, rcon: new FakeFactorio(), npcId: 'cell-revisions',
        stateFile: w.agent.stateFile, traceFile: null, decisionTraceFile: null, completionProtocolVersion: 3,
        interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
        provider: async () => { throw new Error('OFFLINE_NEW_GOAL_SENTINEL') } })
      replacement.stateLoaded = true
      await assert.rejects(replacement.request('Replacement owner goal', { sender: 'owner' }), /OFFLINE_NEW_GOAL_SENTINEL/)
      await replacement.persistQueue
    }
    expectedPlanning = JSON.parse(JSON.stringify(w.memory.snapshot().planning_states))
  }
  await filesystem(async io => {
    await assert.rejects(commitFactoryCellMetadata(w.agent, change(w)))
    const disk = JSON.parse(io.files.get(w.agent.stateFile))
    assert.deepEqual(disk.planning_states, expectedPlanning)
    assert.ok(disk.factory_metadata_pending || disk.factory_registry_fault)
    const restart = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); restart.restore(disk)
    assert.deepEqual(JSON.parse(JSON.stringify(restart.snapshot().planning_states)), expectedPlanning)
    throws(() => restart.getFactoryRegistry(), 'factory_registry_fault')
    if (replaceGoal) assert.equal(restart.planningState(KEY).goal.objective, 'Replacement owner goal')
    else assert.equal(restart.planningState(KEY).run.paused, true)
  }, { afterRename: n => { if (n === 1) stopAfterWal = true } })
})

test('canonical changes during temporary write use a fresh bounded snapshot before replacing disk', async () => {
  const w = fixture(); let changed = false
  await filesystem(async io => {
    await w.agent.persistState({ strict: true })
    assert.equal(io.writes.length, 2)
    assert.equal(io.renames(), 1)
    const disk = JSON.parse(io.files.get(w.agent.stateFile))
    assert.deepEqual(disk.planning_states, JSON.parse(JSON.stringify(w.memory.snapshot().planning_states)))
  }, { write: () => {
    if (!changed) { changed = true; w.memory.pausePlan(KEY, 'concurrent_operator_stop', { pause_class: 'operator' }) }
  } })
})

test('required skill handoff exact record is checked inside queue and again before rename', async () => {
  for (const when of ['queued', 'writing']) {
    const w = fixture(); const handoff = { scope: { memory_key: KEY }, selected: ['exact-held-record'] }
    w.memory.plannerSkillHandoffs.set(KEY, handoff)
    let release
    if (when === 'queued') w.agent.persistQueue = new Promise(resolve => { release = resolve })
    await filesystem(async io => {
      const write = w.agent.persistState({ strict: true, requiredSkillHandoff: handoff })
      if (when === 'queued') { w.memory.plannerSkillHandoffs.delete(KEY); release() }
      await assert.rejects(write, /snapshot_missing_pinned_skills/)
      assert.equal(io.renames(), 0)
    }, { write: () => { if (when === 'writing') w.memory.plannerSkillHandoffs.delete(KEY) } })
  }
})

test('warmed restore rejects a self-consistent rewritten metadata prefix, independent of hash validity', async () => {
  const w = fixture()
  await filesystem(async () => { await commitFactoryCellMetadata(w.agent, change(w)) })
  const original = w.memory.snapshot()
  const nextChange = change(w, { id: 'next-input', kind: 'fluid' })
  const later = appendFactoryCellMetadata(original.factory_registry, nextChange, w.runtime.origin()).registry
  const rewritten = clone(later); const rows = rewritten.cells[0].metadata_history
  rows[1].origin.request_id = 'forged-prior-owner'
  for (let i = 1; i < rows.length; i++) {
    rows[i].previous_digest = rows[i - 1].digest
    const { digest, ...payload } = rows[i]; rows[i].digest = factoryMetadataDigest(payload)
  }
  assert.deepEqual(restoreFactoryRegistry(rewritten), rewritten, 'cold self-consistent hash alone cannot establish external history')
  w.memory.restore({ ...original, factory_registry: rewritten })
  throws(() => w.memory.getFactoryRegistry(), 'factory_registry_fault')
})

for (const phase of ['initial-write', 'commit-write', 'commit-rename']) test(`persistence failure ${phase}: no live candidate; durable WAL/fault only after prepare succeeds`, async () => {
  const w = fixture(); const before = w.memory.getFactoryRegistry()
  await filesystem(async io => {
    await assert.rejects(commitFactoryCellMetadata(w.agent, change(w)))
    const saved = JSON.parse(io.files.get(w.agent.stateFile) ?? '{}')
    if (phase === 'initial-write') {
      assert.deepEqual(w.memory.getFactoryRegistry(), before)
    } else {
      throws(() => w.memory.getFactoryRegistry(), 'factory_registry_fault')
      assert.ok(saved.factory_metadata_pending || saved.factory_registry_fault)
      const restart = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); restart.restore(saved)
      assert.deepEqual(restart.getFactoryRegistry(), before, 'the complete WAL predecessor is safely retained without replaying its intent')
    }
    assert.equal(w.memory.snapshot().factory_registry.cells[0].revision, phase === 'initial-write' ? 1 : 2)
  }, { write: n => { if ((phase === 'initial-write' && n === 1) || (phase === 'commit-write' && n >= 2) || n >= 3) throw new Error('injected storage failure') },
    beforeRename: n => { if (phase === 'commit-rename' && n >= 2) throw new Error('injected rename failure') } })
})

for (const changed of ['session', 'actor_id', 'epoch', 'request']) test(`actual persistence callback refuses ${changed} changes after WAL, retains fault, and never commits candidate`, async () => {
  const w = fixture()
  await filesystem(async io => {
    await assert.rejects(commitFactoryCellMetadata(w.agent, change(w)))
    assert.ok(io.renames() >= 1)
    assert.ok(io.writes.every(snapshot => snapshot.factory_registry.cells[0].revision === 1), 'no candidate write after owner changed')
    const persisted = JSON.parse(io.files.get(w.agent.stateFile))
    assert.ok(persisted.factory_metadata_pending || persisted.factory_registry_fault)
    assert.equal(w.memory.snapshot().factory_registry.cells[0].revision, 1)
  }, { afterRename: n => {
    if (n === 1) {
      if (changed === 'request') w.agent.traceRequest = { id: 'replacement-request' }
      else w.agent.epoch[changed] = changed === 'session' ? 'superseded' : 99
    }
  } })
})

test('stale actor/world/session/request/revision, busy/pending/uncertain and restore invalidate real facade tickets', () => {
  for (const [field, value] of [['actor_id', 99], ['actor_epoch', 99], ['world_id', 'foreign'], ['session_id', 'other'], ['request_id', 'other'], ['native_idle', false], ['pending', true], ['uncertain', true]]) {
    const w = fixture(); const scope = w.runtime.scope(); const request = change(w); w.context[field] = value
    assert.throws(() => w.runtime.prepareMetadata(request, scope), undefined, field)
    assert.equal(w.memory.getFactoryRegistry().cells[0].revision, 1)
  }
  const w = fixture(); const prepared = w.runtime.prepareMetadata(change(w), w.runtime.scope()); const pending = w.memory.snapshot()
  w.memory.restore(pending); throws(() => w.memory.assertFactoryMetadataOwner(prepared.ticket), 'factory_metadata_ticket_stale')
  throws(() => w.memory.getFactoryRegistry(), 'factory_registry_fault')
})

test('legacy restore and complete revision prefix accepted; corruption, rollback and half publication fault durably', async () => {
  const w = fixture(); const legacy = w.memory.snapshot()
  await filesystem(async () => { await commitFactoryCellMetadata(w.agent, change(w)); await commitFactoryCellMetadata(w.agent, change(w, { id: 'metadata-2', kind: 'fluid' })) })
  const saved = w.memory.snapshot(); const restored = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); restored.restore(legacy); restored.restore(saved)
  assert.equal(restored.getFactoryRegistry().cells[0].revision, 3)
  const attacks = [
    s => { s.factory_registry.cells[0].metadata_history[1].ports[0].resource = 'iron-plate' },
    s => { s.factory_registry.cells[0].metadata_history.splice(1, 1) },
    s => { s.factory_registry.cells[0].port_bindings.pop() },
    s => { s.factory_registry.dependencies.pop() },
    s => { s.factory_registry.cells[0].members[0].position.x++ },
    s => { s.factory_registry.cells[0].assignment.purpose = 'different job' },
    s => { s.factory_registry.cells[0].metadata_history[2].previous_digest = '0'.repeat(64) },
  ]
  for (const attack of attacks) {
    const bad = clone(saved); attack(bad); const store = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); store.restore(bad)
    throws(() => store.getFactoryRegistry(), 'factory_registry_fault'); assert.ok(store.snapshot().factory_registry_fault)
  }
  restored.restore(legacy); throws(() => restored.getFactoryRegistry(), 'factory_registry_fault')
})

test('conflicting duplicate transaction faults store instead of renewing identity', async () => {
  const w = fixture(); const request = change(w)
  await filesystem(async () => {
    await commitFactoryCellMetadata(w.agent, request)
    const conflict = clone(request); conflict.dependencies[0].delivery.kind = 'manual'
    throws(() => w.runtime.prepareMetadata(conflict, w.runtime.scope()), 'factory_metadata_transaction_conflict')
    throws(() => w.memory.getFactoryRegistry(), 'factory_registry_fault'); assert.ok(w.memory.snapshot().factory_registry_fault)
  })
})

test('metadata rejects unbound/incorrect endpoints, missing atomic input edges, physical and verified claims', () => {
  const edits = [
    c => { c.port_bindings[0].member.unit_number = 999 },
    c => { c.port_bindings[0].member.force_index = 2 },
    c => { c.port_bindings[0].endpoint = { kind: 'fluidbox', fluidbox_index: 1 } },
    c => { c.port_bindings[0].endpoint.inventory_index = 0 },
    c => { c.port_bindings[0].state = 'verified' },
    c => { c.dependencies = [] },
    c => { c.input_ports[0].direction = 'output' },
    c => { c.members = [] },
    c => { c.assignment = { products: ['iron-plate'] } },
  ]
  for (const edit of edits) { const w = fixture(); const c = change(w); edit(c); assert.throws(() => w.runtime.prepareMetadata(c, w.runtime.scope())); assert.equal(w.memory.getFactoryRegistry().cells[0].revision, 1) }
  let reads = 0; const w = fixture(); const c = change(w)
  Object.defineProperty(c.port_bindings[0].endpoint, 'inventory_index', { enumerable: true, get() { reads++; return 1 } })
  assert.throws(() => appendFactoryCellMetadata(w.memory.getFactoryRegistry(), c, w.runtime.origin())); assert.equal(reads, 0)
})

test('history capacity is durable and no old transaction can be evicted to restart an allowance', () => {
  const w = fixture(); let registry = w.memory.getFactoryRegistry()
  // Each transaction adds an independently declared electrical endpoint/input.
  for (let i = 1; i < 64; i++) {
    const temp = { memory: { getFactoryRegistry: () => registry } }; const request = change(temp, { id: `bounded-${i}`, kind: 'power' })
    registry = appendFactoryCellMetadata(registry, request, w.runtime.origin()).registry
  }
  assert.equal(registry.cells[0].metadata_history.length, 64)
  const final = change({ memory: { getFactoryRegistry: () => registry } }, { id: 'overflow', kind: 'power' })
  throws(() => appendFactoryCellMetadata(registry, final, w.runtime.origin()), 'factory_metadata_capacity')
  assert.deepEqual(restoreFactoryRegistry(registry), registry)
  assert.equal(factoryMetadataDigest(registry), factoryMetadataDigest(clone(registry)))
})

const placementDuringWrite = (w, n) => w.memory.recordNpcPlacement(KEY,
  { unit_number: 1000 + n, entity_name: 'stone-furnace', actor_id: 24, actor_epoch: 2 })

test('actual pause retries second-write placement churn and acknowledges only the canonical paused file', async () => {
  const w = fixture(); w.agent.stateLoaded = true
  await filesystem(async io => {
    await w.agent.persistState({ strict: true })
    assert.equal(JSON.parse(io.files.get(w.agent.stateFile)).planning_states[0].state.run.paused, false)
    await w.agent.pausePersistentPlan('owner_stop', { pause_class: 'operator' })
    assert.equal(io.writes.length, 3); assert.equal(io.renames(), 2)
    const disk = JSON.parse(io.files.get(w.agent.stateFile))
    assert.equal(disk.planning_states[0].state.run.paused, true)
    assert.deepEqual(disk, JSON.parse(JSON.stringify(w.memory.snapshot())))
    assert.equal(w.agent.active, false)
  }, { write: n => { if (n === 2) placementDuringWrite(w, n) } })
})

for (const failure of ['churn', 'io']) test(`actual pause ${failure} exhaustion is visible, stops its owner and retains the last valid disk file`, async () => {
  const w = fixture(); w.agent.stateLoaded = true
  await filesystem(async io => {
    await w.agent.persistState({ strict: true })
    const before = io.files.get(w.agent.stateFile)
    await assert.rejects(w.agent.pausePersistentPlan('owner_stop', { pause_class: 'operator' }),
      failure === 'churn' ? { code: 'canonical_persistence_churn_exhausted', attempts: 3 } : /injected disk failure/)
    assert.equal(io.writes.length, failure === 'churn' ? 4 : 2)
    assert.equal(io.files.get(w.agent.stateFile), before)
    assert.equal(w.memory.planningState(KEY).run.paused, true)
    assert.equal(w.agent.active, false)
    assert.equal(io.renames(), 1)
    const trace = w.events.find(e => e.event === 'goal.pause_save_failed')
    assert.equal(trace.request_id, 'revision-request')
    assert.equal(trace.data.durability, 'unconfirmed')
  }, { write: n => { if (n >= 2) { if (failure === 'io') throw new Error('injected disk failure'); placementDuringWrite(w, n) } } })
})

test('ordinary non-strict persistence cannot hide bounded churn exhaustion', async () => {
  const w = fixture()
  await filesystem(async io => {
    await assert.rejects(w.agent.persistState(), { code: 'canonical_persistence_churn_exhausted', attempts: 3 })
    await w.agent.persistQueue
    assert.equal(io.writes.length, 3); assert.equal(io.renames(), 0)
  }, { write: n => placementDuringWrite(w, n) })
})

function stopFixture() {
  const w = fixture(); w.agent.stateLoaded = true; w.agent.lastMemoryKey = KEY
  const native = new FakeFactorio(); const commands = []
  const command = native.command.bind(native)
  native.command = async text => { commands.push(text); return command(text) }
  const ctx = recoverySession({ agent: w.agent, game: native }, { actorId: 24, epoch: 2, sessionId: 'revision-session' })
  return { ...w, ...ctx, commands }
}

test('actual Session stop still cancels native work when canonical pause save exhausts; reports failure instead of success', async () => {
  const w = stopFixture()
  await filesystem(async io => {
    await w.agent.persistState({ strict: true })
    assert.equal(w.session.queuePlayerRequest('owner', 'stop'), true)
    await settle(w.session)
    assert.equal(io.writes.length, 4)
    assert.equal(w.commands.filter(text => text.includes('"sgluna_deployment","cancel"')).length, 1)
    assert.equal(w.agent.active, false)
    assert.ok(w.logs.some(text => text.includes('canonical_state_changed_during_persistence')))
    assert.ok(!w.chat.some(text => text.includes('cancelled work')))
  }, { write: n => { if (n >= 2) placementDuringWrite(w, n) } })
})

for (const boundary of ['save', 'save_io', 'authorization']) for (const changed of ['cancelGeneration', 'actor', 'epoch', 'session', 'agent', 'goal']) {
  test(`actual Session stop fences replacement ${changed} across ${boundary}`, async () => {
    const w = stopFixture(); let replacement
    const takeover = () => {
      if (changed === 'cancelGeneration') w.session.cancelGeneration++
      if (changed === 'actor') w.session.lastStatus.actor_id++
      if (changed === 'epoch') w.session.lastStatus.epoch++
      if (changed === 'session') w.session.lastStatus.session = 'replacement-session'
      if (changed === 'agent') w.session.agent = { ...w.agent }
      if (changed === 'goal') {
        const state = w.memory.planningState(KEY)
        const snapshot = w.memory.snapshot()
        snapshot.planning_states.find(({ key }) => key === KEY).state.goal.goal_id = `${state.goal.goal_id}-replacement`
        w.memory.restore(snapshot)
        w.agent.active = true
        replacement = JSON.stringify(w.memory.planningState(KEY))
      }
    }
    if (boundary === 'authorization') w.session.ensureAuthorization = async () => { takeover() }
    await filesystem(async () => {
      w.session.queuePlayerRequest('owner', 'stop')
      await settle(w.session)
      assert.equal(w.commands.filter(text => text.includes('"sgluna_deployment","cancel"')).length, 0)
      if (replacement) {
        assert.equal(JSON.stringify(w.memory.planningState(KEY)), replacement)
        assert.equal(w.agent.active, true, 'old pause must not reset a replacement goal')
      }
    }, { write: n => {
      if (boundary.startsWith('save') && n === 1) {
        takeover()
        if (boundary === 'save_io') throw new Error('injected superseded pause save failure')
      }
    } })
  })
}

test('cold reconciliation is bounded, durable after normal save, preserves goal history and cannot reuse candidate transaction identity', async () => {
  const w = fixture(); const request = change(w); let disk
  await filesystem(async io => { await commitFactoryCellMetadata(w.agent, request); disk = JSON.parse(io.files.get(w.agent.stateFile)) })
  for (const outcome of ['candidate', 'previous']) {
    const raw = clone(disk)
    if (outcome === 'previous') raw.factory_registry = raw.factory_metadata_pending.previous_registry
    const restart = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); const events = []
    restart.traceSink = (event, data) => events.push({ event, data })
    restart.restore(raw)
    assert.equal(restart.getFactoryRegistry().cells[0].revision, outcome === 'candidate' ? 2 : 1)
    assert.deepEqual(restart.snapshot().planning_states, raw.planning_states)
    assert.equal(events.filter(e => e.event === 'factory_metadata.reconciled').length, 1)
    assert.equal(events[0].data.outcome, outcome === 'candidate' ? 'committed_unverified' : 'not_committed')
    assert.equal(restart.snapshot().factory_metadata_pending, undefined)
    if (outcome === 'candidate') {
      assert.equal(appendFactoryCellMetadata(restart.getFactoryRegistry(), request, w.runtime.origin()).duplicate, true)
      const conflict = clone(request); conflict.dependencies[0].delivery.kind = 'manual'
      throws(() => appendFactoryCellMetadata(restart.getFactoryRegistry(), conflict, w.runtime.origin()), 'factory_metadata_transaction_conflict')
    }
    const resumed = new NpcAgentLoop({ memory: restart, rcon: w.agent.rcon, stateFile: w.agent.stateFile, npcId: 'cell-revisions', traceFile: null, decisionTraceFile: null, provider: () => assert.fail('No inference') })
    await filesystem(async io => {
      await resumed.persistState({ strict: true })
      const again = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); again.restore(JSON.parse(io.files.get(resumed.stateFile)))
      assert.deepEqual(again.getFactoryRegistry(), restart.getFactoryRegistry())
      assert.equal(again.factoryMetadataPending(), false)
    })
  }
  for (const corrupt of [
    s => { delete s.factory_metadata_pending.schema_version },
    s => { s.factory_metadata_pending.candidate_digest = '0'.repeat(64) },
    s => { s.factory_metadata_pending.owner.world_id = 'foreign' },
    s => { s.factory_metadata_pending.change.transaction_id = 'different' },
    s => { s.factory_metadata_pending.owner.request_id = 'different' },
    s => { s.factory_registry.revision++ },
    s => { s.factory_registry_fault = { code: 'explicit_safety_fault' } },
  ]) {
    const raw = clone(disk); corrupt(raw)
    const restart = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: WORLD }); restart.restore(raw)
    throws(() => restart.getFactoryRegistry(), 'factory_registry_fault')
  }
})

test('revision transactions retain cycles and reverse consumer impact without asserting independence', async () => {
  const w = fixture()
  await filesystem(async () => {
    for (const target of ['cell-1', 'cell-2']) await commitFactoryCellMetadata(w.agent, change(w, { target, output: true, id: `${target}-output` }))
    await commitFactoryCellMetadata(w.agent, change(w, { target: 'cell-1', supplier: 'cell-2', id: 'first-edge' }))
    await commitFactoryCellMetadata(w.agent, change(w, { target: 'cell-2', supplier: 'cell-1', id: 'back-edge' }))
    const registry = w.memory.getFactoryRegistry()
    const summary = factoryDependencySummary(registry.cells, registry.dependencies, 'cell-1')
    assert.deepEqual(summary.impact.direct_consumer_ids, ['cell-2'])
    assert.equal(registry.dependencies.length, 2)
    assert.ok(registry.dependencies.every(edge => edge.state === 'unverified'))
    assert.deepEqual(restoreFactoryRegistry(registry), registry)
  })
})

test('one revision can retain multiple suppliers for one bound input without treating manual support as automated', async () => {
  const w = fixture()
  await filesystem(async () => {
    await commitFactoryCellMetadata(w.agent, change(w, { target: 'cell-2', output: true, id: 'supplier-output' }))
    const request = change(w, { supplier: 'cell-2' })
    request.dependencies.push({ consumer: clone(request.dependencies[0].consumer), supplier: { kind: 'manual', reference: 'explicit startup support' }, delivery: { kind: 'manual' } })
    await commitFactoryCellMetadata(w.agent, request)
    const registry = w.memory.getFactoryRegistry()
    assert.equal(registry.dependencies.length, 2)
    assert.equal(registry.cells[0].revision, 2)
    assert.deepEqual(registry.dependencies.map(d => d.supplier.kind), ['cell', 'manual'])
    assert.ok(registry.dependencies.every(d => d.state === 'unverified'))
    assert.deepEqual(restoreFactoryRegistry(registry), registry)
  })
})

for (const boundary of ['authorization', 'native_cancel', 'ui_sync']) for (const takeover of [false, true]) {
  test(`actual Session stop rejected ${boundary} retains ${takeover ? 'replacement' : 'current'} owner error semantics`, async () => {
    const w = stopFixture()
    let entered, rejectBoundary
    const started = new Promise(resolve => { entered = resolve })
    const held = new Promise((_resolve, reject) => { rejectBoundary = reject })
    const blocked = async () => { entered(); return held }
    if (boundary === 'authorization') w.session.ensureAuthorization = blocked
    if (boundary === 'native_cancel') {
      const command = w.session.rcon.command.bind(w.session.rcon)
      w.session.rcon.command = async text => text.includes('"sgluna_deployment","cancel"') ? blocked() : command(text)
    }
    if (boundary === 'ui_sync') w.session.syncTaskBoardUi = blocked
    await filesystem(async () => {
      w.session.queuePlayerRequest('owner', 'stop')
      await started
      let replacement
      if (takeover) {
        const snapshot = w.memory.snapshot()
        const state = snapshot.planning_states.find(({ key }) => key === KEY).state
        state.goal.goal_id += '-replacement'
        state.run.paused = false
        w.memory.restore(snapshot)
        w.agent.active = true
        replacement = JSON.stringify(w.memory.planningState(KEY))
      }
      rejectBoundary(new Error(`injected rejected ${boundary}`))
      await settle(w.session)
      if (takeover) {
        assert.equal(JSON.stringify(w.memory.planningState(KEY)), replacement)
        assert.equal(w.agent.active, true)
        assert.ok(w.logs.includes('Superseded stop failed; replacement owner retained'))
        assert.equal(w.chat.length, 0, 'old error must not report failure or pause against replacement')
      } else {
        assert.ok(w.logs.some(line => line.includes(`injected rejected ${boundary}`)))
        assert.ok(w.chat.some(line => line.includes(`Request failed: injected rejected ${boundary}`)))
      }
    })
  })
}
