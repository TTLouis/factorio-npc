import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'
import { batchWatermark, operationSignature } from './operation-reconciliation.mjs'
import { luaString, renderOperationPreflight } from './structured-policy.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { PreservationProofError, obligationProofOrigin, effectivePreservationProof, preservedProofMatches,
  normalizeFluidAdmission } from './contract-obligations.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ax-b-candidate-boundary.json', import.meta.url)))
test('sealed AX B PRESTOP exact anchor-only query, selected output/output candidate and immutable p9 are preserved', () => {
  assert.equal(fixture.baseline_source, '2959fd309f529b7af5bd69953ca8b4012d99006f')
  assert.ok(Date.parse(fixture.pre_stop_timestamp) < Date.parse(fixture.first_cancel))
  assert.equal(fixture.plan.status, 'COMMITTED'); assert.equal(fixture.plan.active_step_index, 0)
  assert.equal(fixture.plan.execution.batches_attempted, 0)
  const query = JSON.parse(fixture.issued_wire.find(row => row.tap_request_id === 'tap_84').messages[0].tool_calls[0].function.arguments)
  assert.equal(query.anchor.unit_number, 30); assert.equal(query.connects_to, undefined)
  const proposal = JSON.parse(fixture.issued_wire.find(row => row.tap_request_id === 'tap_85').messages[0].tool_calls[0].function.arguments)
  assert.equal(proposal.stepId, fixture.plan.steps[0].step_id)
  assert.deepEqual(proposal.operations, [{ name: 'place_candidate', args: { candidate_set_id: 'placement-10', candidate_id: 'candidate-1' } }])
  const native = JSON.parse(fixture.candidate_tool_result.value.data.output)
  assert.equal(native.candidate_set_id, 'placement-10'); assert.equal(native.candidates.length, 8)
  assert.ok(native.candidates.every(row => row.connects_to === undefined))
  const chosen = native.candidates[0]
  const pump = fixture.plan.steps[0].obligation_proof.preserved[0].fluid.storages[0].ports[0]
  const facing = chosen.fluid_ports.find(port => port.position.x === pump.target_position.x && port.position.y === pump.target_position.y)
  assert.equal(facing.filter, 'steam'); assert.equal(facing.flow_direction, 'output'); assert.equal(pump.flow_direction, 'output')
  assert.equal(fixture.closed_unsent.effect, 'not_happened')
  assert.match(fixture.substitution_notice, /unavailable/)
})

test('unchanged2959 actual helper reproduces join-unproven for exact operation, with unknown implicit native reply explicitly substituted', async () => {
  assert.equal(createHash('sha256').update(fixture.baseline_functions).digest('hex'), fixture.baseline_functions_sha256)
  const plan = structuredClone(fixture.plan); const pending = structuredClone(fixture.closed_unsent)
  const step = plan.steps[0]; const proof = step.obligation_proof
  const operations = JSON.parse(fixture.issued_wire.find(row => row.tap_request_id === 'tap_85').messages[0].tool_calls[0].function.arguments).operations
  const planning = { goal: fixture.goal, plans: [plan], active_plan_id: plan.plan_id }
  let freezeReads = 0
  // These raw implicit replies were not retained. Substitute ONLY this helper's
  // prerequisites: known idle/absent journal, actual committed preserved facts,
  // and native refusal of a registry candidate lacking connects_to. The exact
  // historical implicit refusal code remains UNKNOWN, not reconstructed here.
  const agent = { activePlanKey: () => 'fixture', captureCheckpointOwner: () => ({}),
    assertCheckpointOwnerCurrent: async () => {}, currentPendingAmendment: () => null, batchInFlight: false,
    assertCurrent: async () => ({ actor_id: 13, epoch: 1, session: 'baseline-substitution-session' }),
    traceRequest: { id: pending.request_id },
    memory: { planningState: () => planning, pendingOperations: () => [pending], currentPlan: () => ({ task_board: { active_step_id: 'step_1' } }) },
    readTaskStatusRaw: async () => ({ task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1,
      last_completed_batch: { batch_id: 21 }, admission_journal: [] }),
    rcon: { command: async text => {
      if (text.includes('fluid_preservation_candidate')) { freezeReads++; return JSON.stringify({ ok: false, code: 'preservation_guard_candidate_unavailable' }) }
      return JSON.stringify({ ok: true, operation: 'place_candidate', preservation_clears_count: 0 })
    } } }
  const original = vm.runInNewContext(`${fixture.baseline_functions.replaceAll('export ', '')}; prepareFluidPreservationAdmission`, {
    getActivePlan, PLAN_STATUS, PreservationProofError, obligationProofOrigin, effectivePreservationProof, preservedProofMatches,
    normalizeFluidAdmission, operationSignature, nativeAdmissionJournal, batchWatermark, luaString, renderOperationPreflight,
    nativeIdle: async () => true, captureObligationProof: async () => structuredClone(proof),
  })
  await assert.rejects(original(agent, { operations, pending }), error => error.code === 'preservation_candidate_join_unproven')
  assert.equal(freezeReads, 1)
  assert.deepEqual(plan, fixture.plan, 'original committed proof/contract/history are immutable')
})
