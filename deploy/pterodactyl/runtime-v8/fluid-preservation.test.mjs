import assert from 'node:assert/strict'
import test from 'node:test'
import { compileObligations, normalizeObligations, preservationGeometry, normalizeObligationProof,
  obligationSignature, preservedProofMatches, normalizeFluidAdmission, fluidAdditionProof,
  normalizeFluidCertificate, effectivePreservationProof, preservationFailure } from './contract-obligations.mjs'
import { operationSignature } from './operation-reconciliation.mjs'

import { fluidGeometry, fluidFixture } from './fluid-preservation-fixtures.mjs'

test('complete empty/open native fluid facts produce an explicit v2 proof; production counters are not topology', () => {
  const f = fluidFixture()
  assert.deepEqual(normalizeObligationProof(f.proof, f.step.obligations), f.proof)
  const changed = fluidGeometry()
  changed.fluid_storages[0].current_fluid = { name: 'water', amount: 87, temperature: 20 }
  assert.deepEqual(preservationGeometry(changed, 1), f.proof.preserved[0])
  assert.equal(f.proof.preserved[0].fluid.storages[0].ports[0].connected, false)
})

for (const missing of ['fluid_geometry_version', 'fluid_storages_truncated', 'non_fluidbox_storage_count']) {
  test(`fluid proof refuses missing native completeness ${missing}`, () => {
    const raw = fluidGeometry(); delete raw[missing]
    assert.throws(() => preservationGeometry(raw, 1), error => preservationFailure(error)?.pause_class === 'guard')
  })
}
for (const bad of ['truncated', 'non_normal', 'missing_target', 'wrong_scope', 'wrong_index']) {
  test(`fluid proof refuses ${bad}`, () => {
    const raw = fluidGeometry(1, true); const storage = raw.fluid_storages[0]; const port = storage.pipe_connections[0]
    if (bad === 'truncated') storage.pipe_connections_truncated = true
    if (bad === 'non_normal') port.connection_type = 'underground'
    if (bad === 'missing_target') delete port.target
    if (bad === 'wrong_scope') port.target_force_index = 2
    if (bad === 'wrong_index') port.connection_index = 2
    assert.throws(() => preservationGeometry(raw, 1))
  })
}
test('an explicit admitted candidate and exact receipt prove only one reciprocal additive edge', () => {
  const f = fluidFixture()
  assert.ok(normalizeFluidAdmission(f.admission, f.plan, f.step))
  assert.equal(preservedProofMatches(f.proof, f.fresh), false, 'no blanket topology relaxation')
  assert.ok(fluidAdditionProof(f.admission, f.receipt, f.built, f.fresh, f.plan, f.step))
  const certificate = { admission_key: f.admission.operation_key, step_id: f.step.step_id, ref: 'batch-g1-5',
    receipt: f.receipt, built: f.built, proof: f.fresh, certified_at: 1003 }
  assert.ok(normalizeFluidCertificate(certificate, f.plan, f.step))
  f.plan.execution.preservation_certificates = [certificate]
  f.plan.execution.preservation_proofs = { fluid_step: f.fresh }
  assert.deepEqual(effectivePreservationProof(f.plan, f.step), f.fresh)
  const lost = structuredClone(f.fresh); lost.preserved = f.proof.preserved
  assert.equal(preservedProofMatches(effectivePreservationProof(f.plan, f.step), lost), false)
})
for (const bad of ['no_envelope', 'wrong_signature', 'wrong_step', 'wrong_candidate', 'wrong_force', 'unrelated_receipt', 'rotated', 'no_reciprocal', 'old_edge_changed']) {
  test(`additive certification refuses ${bad}`, () => {
    const f = fluidFixture()
    if (bad === 'no_envelope') f.admission = undefined
    if (bad === 'wrong_signature') f.admission.signature = 'different'
    if (bad === 'wrong_step') f.admission.owner.step_id = 'other'
    if (bad === 'wrong_candidate') f.admission.candidate.candidate_id = 'other'
    if (bad === 'wrong_force') f.built.force_index = 2
    if (bad === 'unrelated_receipt') f.receipt.admitted_batch.operation_key = 'other'
    if (bad === 'rotated') f.built.entity.direction = 4
    if (bad === 'no_reciprocal') f.built.fluid.storages[0].ports[0].target.connection_index = 2
    if (bad === 'old_edge_changed') f.fresh.preserved[0].fluid.storages[0].capacity++
    assert.equal(fluidAdditionProof(f.admission, f.receipt, f.built, f.fresh, f.plan, f.step), undefined)
  })
}
