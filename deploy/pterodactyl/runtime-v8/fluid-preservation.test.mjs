import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { normalizeObligations, preservationGeometry, normalizeObligationProof,
  preservedProofMatches, normalizeFluidAdmission, fluidAdditionProof,
  normalizeFluidCertificate, effectivePreservationProof, preservationFailure, normalizeFluidReceiptBinding, isNativeEmptyPreservationSequence } from './contract-obligations.mjs'

import { fluidGeometry, fluidFixture } from './fluid-preservation-fixtures.mjs'
import { fluidPreservationMutationUnsafe } from './contract-obligation-runtime.mjs'

const aw = JSON.parse(fs.readFileSync(new URL('./fixtures/aw-fluid-preservation-baseline.json', import.meta.url)))
const nativeEmpty = JSON.parse(fs.readFileSync(new URL('./fixtures/native-fluid-empty-clears.json', import.meta.url)))
test('exact real2.0.77 freeze reply canonicalizes empty clears without changing original native evidence', () => {
  assert.equal(createHash('sha256').update(nativeEmpty.original_reply).digest('hex'), nativeEmpty.original_reply_sha256)
  assert.deepEqual(JSON.parse(nativeEmpty.original_reply).preservation_join, nativeEmpty.envelope.candidate)
  assert.deepEqual(nativeEmpty.envelope.candidate.clears, {})
  const before = JSON.stringify(nativeEmpty)
  const normalized = normalizeFluidAdmission(nativeEmpty.envelope, nativeEmpty.plan, nativeEmpty.step)
  assert.ok(normalized)
  assert.deepEqual(normalized.candidate.clears, [])
  assert.deepEqual(normalizeFluidAdmission(normalized, nativeEmpty.plan, nativeEmpty.step), normalized, 'canonical add/restore/cert input is stable')
  assert.equal(JSON.stringify(nativeEmpty), before, 'the original native reply and old committed proof stay immutable')
})
for (const [label, value] of [['missing', undefined], ['null', null], ['number', 0], ['boolean', false], ['string', ''],
  ['nonempty-object', { unit_number: 5 }], ['fake-length', { length: 0 }], ['nonempty-array', [5]],
  ['null-prototype', Object.create(null)], ['inherited', Object.create({ clear: 5 })], ['date', new Date(0)],
  ['symbol-field', { [Symbol('unknown')]: true }], ['array-extra-field', Object.assign([], { unknown: true })],
  ['array-prototype', Object.setPrototypeOf([], null)]]) {
  test(`allowed-empty native preservation sequences refuse ${label} rather than grant no-clearing/idle authority`, () => {
    assert.equal(isNativeEmptyPreservationSequence(value), false)
    const raw = structuredClone(nativeEmpty.envelope); raw.candidate.clears = value
    assert.equal(normalizeFluidAdmission(raw, nativeEmpty.plan, nativeEmpty.step), undefined)
  })
}
for (const value of [[], {}]) test(`allowed-empty native preservation shape ${JSON.stringify(value)} is known empty`, () => {
  assert.equal(isNativeEmptyPreservationSequence(value), true)
})
for (const field of ['candidate_ports', 'candidate_storages', 'protected_geometry']) for (const value of [[], {}, undefined]) {
  test(`required nonempty native ${field} refuses ${JSON.stringify(value)}`, () => {
    const raw = structuredClone(nativeEmpty.envelope); raw.candidate[field] = value
    assert.equal(normalizeFluidAdmission(raw, nativeEmpty.plan, nativeEmpty.step), undefined)
  })
}
for (const lane of aw.lanes) test(`AW ${lane.tap}: exact old nonfluid guard reproduces original refusal, future v2 captures pump without waiving it`, async () => {
  assert.equal(createHash('sha256').update(aw.baseline_functions).digest('hex'), aw.baseline_function_sha256)
  assert.equal(lane.pre_stop.plan_status, 'COMPLETED'); assert.match(lane.pre_stop.active_plan_id, /_p7$/)
  assert.equal(lane.pre_stop.goal_status, 'active'); assert.equal(lane.pre_stop.paused, false); assert.equal(lane.pre_stop.has_p8, false)
  const original = vm.runInNewContext(`${aw.baseline_functions.replace('export function preservationGeometry', 'function preservationGeometry')}; preservationGeometry`)
  const nativeSubstitution = fluidGeometry(); nativeSubstitution.entity.unit_number = lane.pump
  assert.throws(() => original(nativeSubstitution, lane.pump), /preservation_geometry_unproven/)
  assert.equal(preservationGeometry(nativeSubstitution, lane.pump).entity.unit_number, lane.obligations.preserve[0])
  assert.equal(normalizeObligations(lane.obligations).outcome.requirements[0].prototype, 'boiler')
})

for (const name of ['mine_entity_exact', 'rotate_entity', 'mine_entity', 'clear_construction_area', 'reserve_construction_area', 'prepare_pump_site', 'execute_construction_plan']) {
  test(`pre-admission protects frozen old neighbour from ${name}, even absent from preserve IDs`, () => {
    const f = fluidFixture()
    assert.deepEqual(f.step.obligations.preserve, [1])
    assert.equal(fluidPreservationMutationUnsafe(f.fresh, [{ name, args: { unit_number: 2, entity_name: 'boiler' } }]), true)
    assert.equal(fluidPreservationMutationUnsafe(f.fresh, [{ name: 'supply_entity', args: { unit_number: 2 } }]), false)
  })
}

test('complete empty/open native fluid facts produce an explicit v2 proof; production counters are not topology', () => {
  const f = fluidFixture()
  assert.deepEqual(normalizeObligationProof(f.proof, f.step.obligations), f.proof)
  const changed = fluidGeometry()
  changed.fluid_storages[0].current_fluid = { name: 'water', amount: 87, temperature: 20 }
  changed.fluid_storages[0].capacity = 300 // independently retained dynamic network capacity
  assert.deepEqual(preservationGeometry(changed, 1), f.proof.preserved[0])
  assert.equal(f.proof.preserved[0].fluid.storages[0].ports[0].connected, false)
})
test('missing or changed intrinsic native volume cannot borrow a dynamic network-capacity value', () => {
  const raw = fluidGeometry(); delete raw.fluid_storages[0].local_volume
  assert.throws(() => preservationGeometry(raw, 1), /preservation_fluid_storage_incomplete/)
  const changed = fluidGeometry(); changed.fluid_storages[0].local_volume = 101; changed.fluid_storages[0].prototypes[0].volume = 101
  const f = fluidFixture(); const altered = { ...f.proof, preserved: [preservationGeometry(changed, 1)] }
  assert.equal(preservedProofMatches(f.proof, altered), false)
})
test('native receipt binding normalizes exact ownership independent of JSON key order', () => {
  const f = fluidFixture(); const binding = f.receipt.basic_operation.preservation_binding
  binding.owner = Object.fromEntries(Object.entries(binding.owner).reverse())
  assert.ok(normalizeFluidReceiptBinding(binding))
  assert.ok(fluidAdditionProof(f.admission, f.receipt, f.built, f.fresh, f.plan, f.step))
})
for (const fault of ['missing', 'session', 'goal', 'semantic_step', 'operation', 'attempt', 'ordinal', 'batch', 'legacy_flag']) {
  test(`legacy/mismatched native receipt binding refuses ${fault}`, () => {
    const f = fluidFixture(); const binding = f.receipt.basic_operation.preservation_binding
    if (fault === 'missing') delete f.receipt.basic_operation.preservation_binding
    if (fault === 'session') binding.owner = { ...binding.owner, session: 'new-session' }
    if (fault === 'goal') binding.owner = { ...binding.owner, goal_id: 'other-goal' }
    if (fault === 'semantic_step') binding.owner = { ...binding.owner, semantic_step_id: 'other-step' }
    if (fault === 'operation') binding.operation_key = 'other-operation'
    if (fault === 'attempt') binding.attempt_id = 'other-attempt'
    if (fault === 'ordinal') binding.ordinal++
    if (fault === 'batch') binding.batch_generation++
    if (fault === 'legacy_flag') f.receipt.basic_operation.preservation_binding = { verified: true }
    assert.equal(fluidAdditionProof(f.admission, f.receipt, f.built, f.fresh, f.plan, f.step), undefined)
  })
}
test('native ordinary pipe production role none is distinct from its normal input-output port flow', () => {
  const raw = fluidGeometry(); raw.entity.name = 'pipe'; raw.entity.type = 'pipe'
  raw.fluid_storages[0].prototypes = [{ index: 1, production_type: 'none', volume: 100 }]
  raw.fluid_storages[0].pipe_connections[0].flow_direction = 'input-output'
  assert.equal(preservationGeometry(raw, 1).fluid.storages[0].prototypes[0].production_type, 'none')
  raw.entity.name = 'unknown-modded-pipe'
  assert.throws(() => preservationGeometry(raw, 1), /preservation_fluid_prototype_unsupported/)
})
for (const fault of ['actor', 'epoch', 'goal', 'plan_version', 'request_signature', 'stale_candidate', 'missing_native_guard', 'closure_geometry_changed', 'partial_receipt']) {
  test(`strict native envelope refuses ${fault}`, () => {
    const f = fluidFixture()
    if (fault === 'actor') f.admission.owner.actor_id++
    if (fault === 'epoch') f.admission.owner.actor_epoch++
    if (fault === 'goal') f.admission.owner.goal_id = 'other'
    if (fault === 'plan_version') f.admission.owner.plan_version++
    if (fault === 'request_signature') f.admission.signature = 'not_exact'
    if (fault === 'stale_candidate') f.admission.candidate.tick += 3601
    if (fault === 'missing_native_guard') f.admission.candidate.version = 2
    if (fault === 'closure_geometry_changed') f.admission.candidate.protected_geometry[0].fluid_storages[0].local_volume++
    if (fault === 'partial_receipt') f.receipt.basic_operation.completed = false
    assert.equal(fluidAdditionProof(f.admission, f.receipt, f.built, f.fresh, f.plan, f.step), undefined)
  })
}

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
  const certificate = normalizeFluidCertificate({ admission_key: f.admission.operation_key, step_id: f.step.step_id, ref: 'batch-g1-5',
    receipt: f.receipt, built: f.built, proof: f.fresh, certified_at: 1003 }, f.plan, f.step, { seal: true })
  assert.ok(normalizeFluidCertificate(certificate, f.plan, f.step))
  f.plan.execution.preservation_certificates = [certificate]
  f.plan.execution.preservation_proofs = { fluid_step: f.fresh }
  assert.deepEqual(effectivePreservationProof(f.plan, f.step), f.fresh)
  const lost = structuredClone(f.fresh); lost.preserved = f.proof.preserved
  assert.equal(preservedProofMatches(effectivePreservationProof(f.plan, f.step), lost), false)
})
test('sealed runtime authority survives normal receipt churn; absent/copied dependencies never gain authority on restore', () => {
  const f = fluidFixture()
  const raw = { admission_key: f.admission.operation_key, step_id: f.step.step_id, ref: 'batch-g1-5',
    receipt: f.receipt, built: f.built, proof: f.fresh, certified_at: 1003 }
  assert.equal(normalizeFluidCertificate(raw, f.plan, f.step), undefined, 'an unsealed legacy claim is not retrospectively blessed')
  const sealed = normalizeFluidCertificate(raw, f.plan, f.step, { seal: true })
  assert.ok(sealed)
  f.plan.execution.receipts[f.step.step_id] = Array.from({ length: 24 }, (_, i) => ({ source: 'runtime', kind: 'operation_receipt', ref: `later_${i}` }))
  assert.ok(normalizeFluidCertificate(sealed, f.plan, f.step))
  assert.equal(normalizeFluidCertificate(sealed, f.plan, f.step, { requireLive: true }), undefined, 'only original certification requires live authoritative ledger rows')
  f.plan.execution.preservation_certificates = [sealed]
  assert.deepEqual(effectivePreservationProof(JSON.parse(JSON.stringify(f.plan)), f.step), f.fresh)
  const bad = structuredClone(sealed); bad.authority_dependencies.owner.step_id = 'copied'
  assert.equal(normalizeFluidCertificate(bad, f.plan, f.step), undefined)
  delete sealed.authority_dependencies
  assert.equal(effectivePreservationProof(f.plan, f.step), undefined)
})
for (const bad of ['no_envelope', 'wrong_signature', 'wrong_step', 'wrong_candidate', 'wrong_force', 'unrelated_receipt', 'rotated', 'no_reciprocal', 'old_edge_changed',
  'wrong_filter', 'wrong_production', 'wrong_minimum_temperature', 'wrong_maximum_temperature', 'wrong_reciprocal_position', 'missing_candidate_storage']) {
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
    if (bad === 'old_edge_changed') f.fresh.preserved[0].fluid.storages[0].local_volume++
    if (bad === 'wrong_filter') f.built.fluid.storages[0].prototypes[0].filter = 'steam'
    if (bad === 'wrong_production') f.built.fluid.storages[0].prototypes[0].production_type = 'output'
    if (bad === 'wrong_minimum_temperature') f.built.fluid.storages[0].prototypes[0].minimum_temperature = 100
    if (bad === 'wrong_maximum_temperature') f.built.fluid.storages[0].prototypes[0].maximum_temperature = 20
    if (bad === 'wrong_reciprocal_position') f.built.fluid.storages[0].ports[0].target_position.x++
    if (bad === 'missing_candidate_storage') delete f.admission.candidate.candidate_storages
    assert.equal(fluidAdditionProof(f.admission, f.receipt, f.built, f.fresh, f.plan, f.step), undefined)
  })
}
