import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { getActivePlan } from '../pterodactyl/runtime-v8/planning-state.mjs'
import { buildPendingOperation, reconcilePendingOperation } from '../pterodactyl/runtime-v8/operation-reconciliation.mjs'
import { renderOperation } from '../pterodactyl/runtime-v8/structured-policy.mjs'

const baseline = process.argv.includes('--baseline')
const resultFile = baseline ? '/proof/native-baseline.json' : '/proof/native-candidate.json'
const ar = JSON.parse(await fs.readFile('/test/pterodactyl/runtime-v8/fixtures/run-ar-mining.json', 'utf8'))
const transcript = []; const cases = []; const events = []
let connection; let inference = 0; let agent
globalThis.fetch = async () => { inference++; throw new Error('External inference forbidden in AR native proof') }
for (let i = 0; i < 100; i++) {
  connection = new Rcon(27015, 'sgluna-test', 3000, { host: '127.0.0.1' })
  try { await connection.connect(); break } catch { connection.close(); await delay(100) }
}
const command = async text => { const answer = await connection.command(text); transcript.push({ text, answer }); return answer }
const rcon = { command }
const lua = async body => JSON.parse(await command(`/silent-command ${body}`))
const status = () => lua('rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))')
const facts = () => lua(`local a=game.get_entity_by_unit_number(25);local t=a.surface.find_entities_filtered{name='tree-08-red',position={x=-90.9375,y=-29.625},radius=0.1}[1];rcon.print(helpers.table_to_json({tick=game.tick,base=script.active_mods.base,humans=#game.connected_players,coal=a.get_item_count('coal'),copper=a.get_item_count('copper-ore'),wood=a.get_item_count('wood'),tree_alive=t~=nil,position=a.position,surface_index=a.surface.index}))`)
const waitIdle = async () => {
  const deadline = Date.now() + 90000
  for (;;) {
    const s = await status()
    if (s.task_state === 'idle' && s.queue_length === 0 && !s.active_batch) return s
    assert.ok(Date.now() < deadline, 'native hand mining did not terminate within its wall cap')
    await delay(150)
  }
}
function createAgent(memory, identity, requestId) {
  const a = new NpcAgentLoop({ rcon, memory, npcId: 'npc-1', completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async () => { throw new Error('Native fixture stops at the next unbound planner checkpoint') } })
  Object.assign(a, { active: true, epoch: identity, lastMemoryKey: ar.key,
    requestInfo: { memoryKey: ar.key, turnId: 1, sender: '<server>', text: ar.memory.plans[0].state.objective },
    traceRequest: { id: requestId, usage: {} }, messages: [], baseMessages: [] })
  a.agentContext.beginLineage('executor')
  a.behaviorTrace = { emit: async row => events.push(row) }
  return a
}

try {
  await lua('game.tick_paused=false;game.speed=1;rcon.print("{}")')
  const before = await facts()
  await delay(700)
  const clock = await facts()
  assert.ok(clock.tick - before.tick >= 30, 'native clock must advance quietly with zero humans')
  assert.equal(before.base, '2.0.77'); assert.equal(before.humans, 0)
  assert.equal(before.coal, 0); assert.equal(before.copper, 10); assert.equal(before.tree_alive, true)
  const identity = await deploymentStatus(rcon, { requireAllowed: true })
  const original = await status()
  assert.equal(original.last_cancelled_batch.reason, 'mining:mining_rejected')
  assert.equal(original.last_cancelled_batch.tasks_started, 4)
  if (baseline) {
    const operation = ar.operations[1]
    const pending = buildPendingOperation({ requestId: 'native-ar-negative', operationKey: 'native-ar-negative/batch_2', ordinal: 2,
      protocolVersion: 2, actor: identity, operations: [operation] })
    await executeAuthorizedBatch(rcon, identity.epoch, [renderOperation(operation)], undefined, pending)
    const terminal = await waitIdle(); const after = await facts()
    assert.equal(terminal.last_cancelled_batch.reason, 'mining:mining_rejected')
    assert.equal(after.coal, 0); assert.equal(after.copper, 10); assert.equal(after.tree_alive, true)
    cases.push({ name: 'unchanged_AR_native_negative', expected_failure: 'mining:mining_rejected', after, terminal })
  } else {
    assert.equal(original.admission_journal[0].state, 'partial', 'native producer accounts for the retained gather-only cancellation')
    const memory = new CanonicalTaskBoardMemory(); memory.restore(structuredClone(ar.memory))
    const historical = reconcilePendingOperation(memory.pendingOperations(ar.key)[0], { status: original, actor: identity })
    assert.equal(historical.verdict, 'stale_actor', 'saved work from the previous deployment epoch cannot be replayed')
    cases.push({ name: 'historical_epoch_hold', verdict: historical })
    // A new current-epoch copy of the exact AR acquisition is the residual
    // fixture. Its native effects start from empty copper/coal, not fabricated
    // completion. Deliberately bypass exact selection only for this coal task.
    memory.clearPendingOperation(ar.key, { operationKey: ar.native.admission_journal[0].operation_key })
    await lua('local a=game.get_entity_by_unit_number(25);assert(a.remove_item{name="copper-ore",count=10}==10);assert(remote.call("sgluna_ar_test","reject_coal",true));rcon.print("{}")')
    agent = createAgent(memory, identity, 'native-ar-residual')
    const step = getActivePlan(memory.planningState(ar.key)).steps[0].step_id
    await agent.commitPlan({ chatMessage: '', stepId: step, plan: [], currentStep: 0, operations: ar.operations })
    const injected = await waitIdle()
    const failedFacts = await facts()
    assert.equal(injected.last_cancelled_batch.reason, 'mining:mining_rejected')
    assert.equal(failedFacts.coal, 0); assert.equal(failedFacts.copper, 10)
    await lua('assert(remote.call("sgluna_ar_test","reject_coal",false));rcon.print("{}")')
    const admitted = await agent.failed('mining:mining_rejected')
    assert.ok(admitted?.operations?.length, JSON.stringify(events.slice(-8)))
    assert.deepEqual(admitted.operations.map(op => ({ name: op.name, args: op.args })), [ar.operations[1]])
    assert.equal((await facts()).copper, 10)
    const terminal = await waitIdle(); const after = await facts()
    assert.equal(after.coal, 10); assert.equal(after.copper, 10); assert.equal(after.wood, 0); assert.equal(after.tree_alive, true)
    assert.ok(events.some(row => row.event === 'gather.recovery_continued'))
    assert.ok(terminal.last_completed_batch)
    cases.push({ name: 'exact_AR_residual_native_continuation', injected_failure: injected, failedFacts, after, terminal })
    await agent.completed()
    assert.equal(getActivePlan(memory.planningState(ar.key)).active_step_index, 1)
    await agent.cancel('native-boundary-complete')

    // Separate deterministic fixture setup for a new precise-location boundary.
    // Remove only the coal just mined; every resulting coal must be native yield.
    await lua('local a=game.get_entity_by_unit_number(25);assert(a.remove_item{name="coal",count=10}==10);rcon.print("{}")')
    const fresh = structuredClone(ar.memory)
    const native = await status()
    fresh.planning_states[0].state.operation_ledger.sequence = Math.max(...native.admission_journal.map(row => row.ordinal))
    const locationMemory = new CanonicalTaskBoardMemory(); locationMemory.restore(fresh)
    locationMemory.clearPendingOperation(ar.key, { operationKey: ar.native.admission_journal[0].operation_key })
    agent = createAgent(locationMemory, await deploymentStatus(rcon, { requireAllowed: true }), 'native-ar-location')
    const stepId = getActivePlan(locationMemory.planningState(ar.key)).steps[0].step_id
    const location = await agent.commitPlan({ chatMessage: '', stepId, plan: [], currentStep: 0,
      operations: [{ name: 'mine_resource_at', args: { resource_name: 'coal', x: -89, y: -30, count: 10 } }] })
    assert.ok(location.operations.length)
    await waitIdle()
    const located = await facts()
    assert.equal(located.coal, 10); assert.equal(located.copper, 10); assert.equal(located.tree_alive, true)
    assert.ok(events.some(row => row.event === 'mining.location_corrected'))
    assert.ok(agent.messages.some(row => row.content?.includes('position reminder')))
    cases.push({ name: 'nearby_resource_location_corrected_without_executor_retry', after: located })
    await agent.cancel('native-proof-complete')

    // Native admission binds the surface atomically, independent of host polls.
    const refusal = await lua(`local a=game.get_entity_by_unit_number(25);local s=game.create_surface('ar-surface-fence',{width=32,height=32});local original=a.surface;assert(a.teleport({0,0},s));local b=remote.call('autorio_operation_admission','begin',{operation_key='native-surface-negative',attempt_id='native-surface-negative',actor_id=25,epoch=${identity.epoch},signature='surface-negative',ordinal=1000,operation_count=1,surface_index=${identity.surface_index}});assert(a.teleport({-90.07421875,-30.41015625},original));rcon.print(helpers.table_to_json(b))`)
    assert.equal(refusal.ok, false); assert.equal(refusal.error, 'stale_actor_surface')
    cases.push({ name: 'native_atomic_surface_refusal', refusal })
  }
  assert.equal(inference, 0)
  await fs.writeFile(resultFile, JSON.stringify({ status: 'pass', base: '2.0.77', baseline, external_inference_calls: inference, cases, events, transcript }, null, 2))
  console.log(JSON.stringify({ status: 'pass', baseline, cases: cases.map(row => row.name), inference }))
} catch (error) {
  await fs.writeFile(resultFile, JSON.stringify({ status: 'fail', error: error.stack, cases, events, transcript }, null, 2))
  throw error
} finally { agent?.cancel('native-proof-closeout'); connection.close() }
