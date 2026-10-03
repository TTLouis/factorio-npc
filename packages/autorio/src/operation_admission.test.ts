import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_operation_admission, pinned_operation_batch_refs } from './operation_admission'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

const identity = { operation_key: 'request/operation', attempt_id: 'attempt-1', actor_id: 7, epoch: 3, signature: 'hash-1' }
const ref = { batch_id: 1, batch_generation: 1, batch_ref: 'batch-g1-1' }
function actor() {
  return { is_valid: true, character: { valid: true }, status_snapshot: () => ({ actor_id: 7 }) } as unknown as ControlledActor
}
beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).log = vi.fn()
  ;(globalThis as any).remote = { interfaces: { sgluna_deployment: { authorize: true } }, call: vi.fn((_name, _method, epoch) => epoch === 3) }
})
describe('durable operation admission', () => {
  it('rejects stale actor and epoch, and returns exact duplicates without readmission', () => {
    const manager = new_task_manager(() => undefined)
    const admission = new_operation_admission(actor, manager.get_status_snapshot)
    expect(admission.begin({ ...identity, actor_id: 8 })).toMatchObject({ ok: false, error: 'stale_actor_epoch' })
    expect(admission.begin({ ...identity, epoch: 4 })).toMatchObject({ ok: false, error: 'stale_actor_epoch' })
    expect(admission.begin(identity)).toMatchObject({ ok: true, record: { state: 'admitting' } })
    expect(admission.begin(identity)).toMatchObject({ ok: true, duplicate: true })
    expect(admission.begin({ ...identity, signature: 'changed' })).toMatchObject({ ok: false, error: 'operation_key_conflict' })
    expect(admission.status().records).toHaveLength(1)
    expect((globalThis as any).log).toHaveBeenCalledWith('[AUTORIO] operation.admission.recorded request_id=request operation_key=request/operation reason=admitting')
  })
  it('retains a successful prefix and failure as uncertain across generation loss', () => {
    let manager = new_task_manager(() => undefined)
    const admission = new_operation_admission(actor, () => manager.get_status_snapshot())
    admission.begin(identity)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    expect(admission.slot(identity.operation_key, 1, { ok: true, batch_refs: [ref], result: true })).toMatchObject({ ok: true })
    expect(admission.slot(identity.operation_key, 2, { ok: false, batch_refs: [], error: 'not reachable' })).toMatchObject({ ok: true })
    admission.finish(identity.operation_key, { ok: false, error: 'slot2 failed' })
    manager = new_task_manager(() => undefined)
    expect(admission.status().records[0]).toMatchObject({ state: 'uncertain', slots: [{ index: 1, ok: true }, { index: 2, ok: false }] })
    expect(manager.get_status_snapshot().receipt_journal).toMatchObject([{ ...ref, state: 'uncertain', reason: 'save_load_unfinished' }])
    expect(pinned_operation_batch_refs()).toEqual([ref.batch_ref])
  })
  it('completes only on exact retained receipts and preserves cancelled work as uncertain', () => {
    const manager = new_task_manager(() => undefined)
    const admission = new_operation_admission(actor, manager.get_status_snapshot)
    admission.begin(identity)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    admission.slot(identity.operation_key, 1, { ok: true, batch_refs: [ref] })
    admission.finish(identity.operation_key, { ok: true })
    expect(admission.status().records[0].state).toBe('admitted')
    manager.cancel_all_tasks()
    expect(admission.status().records[0].state).toBe('uncertain')
    admission.resolve(identity.operation_key, { ...identity, outcome: 'completed' })
    expect(pinned_operation_batch_refs()).toEqual([])
  })
  it('keeps old pinned receipts while trimming unrelated terminal history', () => {
    const manager = new_task_manager(() => undefined)
    const admission = new_operation_admission(actor, manager.get_status_snapshot)
    admission.begin(identity)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    admission.slot(identity.operation_key, 1, { ok: true, batch_refs: [ref] })
    admission.finish(identity.operation_key, { ok: true })
    manager.cancel_all_tasks()
    for (let index = 0; index < 140; index++) {
      manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
      manager.cancel_all_tasks()
    }
    expect(manager.get_status_snapshot().receipt_journal).toHaveLength(129)
    expect(manager.get_status_snapshot().receipt_journal[0]).toMatchObject(ref)
    expect(admission.status().records[0].state).toBe('uncertain')
  })
  it('retains exact completion through reload but does not continue unfinished admission', () => {
    let manager = new_task_manager(() => undefined)
    const admission = new_operation_admission(actor, () => manager.get_status_snapshot())
    admission.begin(identity)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    admission.slot(identity.operation_key, 1, { ok: true, batch_refs: [ref] })
    admission.finish(identity.operation_key, { ok: true })
    manager.reset_task_state()
    manager.next_task()
    manager = new_task_manager(() => undefined)
    expect(admission.status().records[0].state).toBe('completed')
    expect(manager.get_status_snapshot().receipt_journal[0]).toMatchObject({ ...ref, state: 'completed' })
    const next = { ...identity, operation_key: 'next' }
    admission.begin(next)
    manager = new_task_manager(() => undefined)
    expect(admission.slot('next', 1, { ok: true, batch_refs: [] })).toMatchObject({ ok: false, error: 'invalid_slot' })
    expect(admission.status().records[1].state).toBe('uncertain')
  })
  it('rejects the 65th unresolved admission without evicting any accepted work', () => {
    const manager = new_task_manager(() => undefined)
    const admission = new_operation_admission(actor, manager.get_status_snapshot)
    for (let index = 0; index < 64; index++) expect(admission.begin({ ...identity, operation_key: `op-${index}` }).ok).toBe(true)
    expect(admission.begin({ ...identity, operation_key: 'overflow' })).toMatchObject({ ok: false, error: 'admission_journal_full' })
    expect(admission.status().records).toHaveLength(64)
  })
})
