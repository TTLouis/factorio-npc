import { compileObligations, normalizeObligations, preservationGeometry, obligationSignature } from './contract-obligations.mjs'
import { operationSignature } from './operation-reconciliation.mjs'

// Small deterministic native-response substitutions. These are deliberately not
// historical AW replies and do not replace the required exact-version engine proof.
export function fluidGeometry(id = 1, connected = false) {
  const boiler = id !== 1
  const other = { unit_number: boiler ? 1 : 2, name: boiler ? 'offshore-pump' : 'boiler',
    type: boiler ? 'offshore-pump' : 'boiler', position: { x: 0, y: boiler ? 0 : 3 }, direction: 0 }
  return { found: true, entity: { unit_number: id, name: boiler ? 'boiler' : 'offshore-pump',
    type: boiler ? 'boiler' : 'offshore-pump', position: { x: 0, y: boiler ? 3 : 0 }, direction: 0 },
  actor_id: 10, actor_surface_index: 1, actor_force_index: 1, surface_index: 1, force_index: 1,
  fluid_geometry_version: 2, fluid_storage_count: 1, fluid_box_count: 1, non_fluidbox_storage_count: 0,
  fluid_storages_truncated: false, fluid_storages: [{ index: 1, capacity: 100,
    prototypes: [{ index: 1, production_type: boiler ? 'input' : 'output', filter: 'water' }], prototypes_truncated: false,
    pipe_connections_truncated: false, pipe_connections: [{ connection_index: 1, connected, target_valid: true,
      flow_direction: boiler ? 'input' : 'output', connection_type: 'normal',
      position: { x: 0, y: boiler ? 2 : 1 }, target_position: { x: 0, y: boiler ? 1 : 2 },
      ...(connected ? { target: other, target_surface_index: 1, target_force_index: 1,
        target_fluidbox_index: 1, target_pipe_connection_index: 1 } : {}) }] }] }
}
export function fluidFixture() {
  const obligations = normalizeObligations({ outcome: { mode: 'all', requirements: [
    { kind: 'entity_count', prototype: 'boiler', minimum: 1, anchor: { x: 0, y: 3 }, radius: 4 },
  ] }, preserve: [1] })
  const binding = { goal_id: 'goal_fluid', plan_id: 'goal_fluid_p1', plan_version: 1,
    step_id: 'fluid_step', semantic_step_id: 'fluid_step' }
  const proof = { version: 2, intent_signature: obligationSignature(obligations), actor_id: 10, actor_epoch: 3,
    request_id: 'req', captured_at: 1000, preserved: [preservationGeometry(fluidGeometry(), 1)], binding }
  const step = { step_id: 'fluid_step', semantic_step_id: 'fluid_step', obligations, obligation_proof: proof,
    completion_contract: compileObligations(obligations) }
  const operation = { name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }
  const candidate = { version: 3, operation_key: 'req/batch_5', protected_geometry: [fluidGeometry()], complete: true, tick: 100, generated_tick: 90,
    actor_id: 10, surface_index: 1, force_index: 1, candidate_set_id: 'placement-1', candidate_id: 'candidate-1',
    entity_name: 'boiler', entity_type: 'boiler', position: { x: 0, y: 3 }, direction: 0, clears: [],
    connects_to: { unit_number: 1, entity_name: 'offshore-pump', target_port: { storage_index: 1, connection_index: 1 },
      candidate_port: { storage_index: 1, connection_index: 1 }, tile: { x: 0, y: 2 } },
    candidate_storages: [{ index: 1, production_type: 'input', filter: 'water' }],
    candidate_ports: [{ storage_index: 1, connection_index: 1, direction: 0, filter: 'water', production_type: 'input',
      connection_type: 'normal', flow_direction: 'input', position: { x: 0, y: 2 } }] }
  const plan = { goal_id: 'goal_fluid', plan_id: 'goal_fluid_p1', plan_version: 1, steps: [step], active_step_index: 0,
    execution: { receipts: { fluid_step: [{ source: 'runtime', kind: 'operation_receipt', ref: 'batch-g1-5' },
      { source: 'runtime', kind: 'deterministic_verification', ref: 'batch_5', verified_operation_names: ['place_candidate'] }] } } }
  const admission = { version: 1, operation_key: 'req/batch_5', signature: operationSignature([operation]), request_id: 'req',
    board_step_id: 'step_1', baseline: proof, operation, candidate, created_at: 1001, native_idle: true, native_generation: 1, native_max_batch_id: 4,
    owner: { goal_id: plan.goal_id, plan_id: plan.plan_id, plan_version: 1, step_id: step.step_id,
      semantic_step_id: step.step_id, actor_id: 10, actor_epoch: 3 } }
  plan.execution.preservation_admissions = { [admission.operation_key]: admission }
  const receipt = { outcome: 'completed', task_state: 'idle', queue_length: 0, batch_id: 5, batch_generation: 1,
    basic_operation: { type: 'placing', accepted: true, completed: true, code: 'completed', actor_id: 10,
      entity_name: 'boiler', placed_unit_number: 2, placed_entity_type: 'boiler', placed_surface_index: 1,
      placed_position: { x: 0, y: 3 }, placed_direction: 0, tick: 110 },
    admitted_batch: { operation_key: admission.operation_key, signature: admission.signature, goal_id: plan.goal_id,
      plan_id: plan.plan_id, step_id: step.step_id, actor_id: 10, actor_epoch: 3, batch_id: 5, batch_generation: 1 },
    correlation: { goal_id: plan.goal_id, step_id: 'step_1', actor_id: 10, actor_epoch: 3 } }
  const fresh = { ...structuredClone(proof), captured_at: 1002, preserved: [preservationGeometry(fluidGeometry(1, true), 1)] }
  const built = preservationGeometry(fluidGeometry(2, true), 2)
  return { proof, step, plan, admission, receipt, fresh, built }
}

