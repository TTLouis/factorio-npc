import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_operation_admission, pinned_operation_batch_refs } from './operation_admission'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

const identity = { operation_key: 'request/operation', attempt_id: 'attempt-1', actor_id: 7, epoch: 3, signature: 'hash-1', ordinal: 1, operation_count: 1 }
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
  it('derives receipt completion on status without writing admissions, counters or initialization', () => {
    const manager = new_task_manager(() => undefined)
    const admission = new_operation_admission(actor, manager.get_status_snapshot)
    admission.status()
    expect((globalThis as any).storage).toEqual({})
    admission.begin(identity)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    admission.slot(identity.operation_key, 1, { ok: true, batch_refs: [ref] })
    admission.finish(identity.operation_key, { ok: true })
    manager.reset_task_state()
    manager.next_task()
    const before = JSON.stringify((globalThis as any).storage)
    expect(admission.status().records[0].state).toBe('completed')
    expect(admission.status().records[0].state).toBe('completed')
    expect(JSON.stringify((globalThis as any).storage)).toBe(before)
    expect((globalThis as any).storage.sgluna_operation_admissions[0].state).toBe('admitted')
  })
  it('rejects expired duplicates after history pruning and manager restart', () => {
    const manager = new_task_manager(() => undefined)
    let admission = new_operation_admission(actor, manager.get_status_snapshot)
    admission.begin(identity)
    admission.slot(identity.operation_key, 1, { ok: true, batch_refs: [] })
    admission.finish(identity.operation_key, { ok: true })
    for (let index = 2; index <= 70; index++) {
      const next = { ...identity, operation_key: `next-${index}`, ordinal: index }
      admission.begin(next)
      admission.slot(next.operation_key, 1, { ok: true, batch_refs: [] })
      admission.finish(next.operation_key, { ok: true })
    }
    admission = new_operation_admission(actor, manager.get_status_snapshot)
    expect(admission.status().records).toHaveLength(64)
    expect(admission.begin(identity)).toMatchObject({ ok: false, error: 'expired_operation_ordinal' })
    expect(admission.begin({ ...identity, operation_key: 'changed-key' })).toMatchObject({ ok: false, error: 'expired_operation_ordinal' })
    expect(admission.status().high_water).toBe(70)
  })
  it('cannot mark an incomplete command prefix as complete', () => {
    const manager = new_task_manager(() => undefined)
    const admission = new_operation_admission(actor, manager.get_status_snapshot)
    admission.begin({ ...identity, operation_count: 2 })
    admission.slot(identity.operation_key, 1, { ok: true, batch_refs: [] })
    expect(admission.finish(identity.operation_key, { ok: true })).toMatchObject({ ok: false, error: 'incomplete_admission' })
    expect(admission.status().records[0].state).toBe('admitting')
  })
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
    admission.begin({ ...identity, operation_count: 2 })
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    expect(admission.slot(identity.operation_key, 1, { ok: true, batch_refs: [ref], result: true })).toMatchObject({ ok: true })
    expect(admission.slot(identity.operation_key, 2, { ok: false, batch_refs: [], error: 'not reachable' })).toMatchObject({ ok: true })
    admission.finish(identity.operation_key, { ok: false, error: 'slot2 failed' })
    manager = new_task_manager(() => undefined)
    manager.reconcile_startup('server-restarted')
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
    const next = { ...identity, operation_key: 'next', ordinal: 2 }
    admission.begin(next)
    manager = new_task_manager(() => undefined)
    manager.reconcile_startup('server-restarted')
    expect(admission.slot('next', 1, { ok: true, batch_refs: [] })).toMatchObject({ ok: false, error: 'invalid_slot' })
    expect(admission.status().records[1].state).toBe('uncertain')
  })
  describe('provable pre-mutation refusal', () => {
    function setup(operation_count = 1) {
      const manager = new_task_manager(() => undefined)
      const admission = new_operation_admission(actor, () => manager.get_status_snapshot())
      admission.begin({ ...identity, operation_count })
      return { manager, admission }
    }
    const refusal = { ok: false, refused: true, operation: 'craft_item', error: 'Not enough ingredients', batch_refs: [] }

    it('settles a returned refusal from a validate-then-queue operation as failed, not uncertain', () => {
      const { admission } = setup()
      expect(admission.slot(identity.operation_key, 1, refusal)).toMatchObject({ ok: true })
      admission.finish(identity.operation_key, { ok: false, error: 'autorio rejected operation 1' })
      const record = admission.status().records[0]
      expect(record).toMatchObject({ state: 'failed', proven_refusal: true })
      expect(record.slots[0]).toMatchObject({ ok: false, mutation_unknown: false, refused_before_mutation: true, refusal_code: 'Not enough ingredients' })
      expect(pinned_operation_batch_refs()).toEqual([])
      expect((globalThis as any).log).toHaveBeenCalledWith('[AUTORIO] operation.admission.refused request_id=request operation_key=request/operation reason=refused_before_mutation')
    })
    it('keeps a thrown error uncertain because it may have changed something before throwing', () => {
      const { admission } = setup()
      admission.slot(identity.operation_key, 1, { ok: false, operation: 'craft_item', error: 'boom', batch_refs: [] })
      admission.finish(identity.operation_key, { ok: false })
      const record = admission.status().records[0]
      expect(record.state).toBe('uncertain')
      expect(record.proven_refusal).toBeUndefined()
      expect(record.slots[0]).toMatchObject({ mutation_unknown: true })
    })
    it('keeps a refusal from an operation that is not validate-then-queue uncertain', () => {
      const { admission } = setup()
      admission.slot(identity.operation_key, 1, { ...refusal, operation: 'equip_weapon' })
      admission.finish(identity.operation_key, { ok: false })
      expect(admission.status().records[0]).toMatchObject({ state: 'uncertain', slots: [{ mutation_unknown: true }] })
    })
    it('keeps a refusal uncertain when the task queue grew across the call', () => {
      const { admission, manager } = setup()
      manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
      admission.slot(identity.operation_key, 1, refusal)
      admission.finish(identity.operation_key, { ok: false })
      expect(admission.status().records[0].state).toBe('uncertain')
    })
    it('drops an open unrelated batch from a proven refusal so it neither pins a receipt nor blocks settlement', () => {
      const { admission, manager } = setup()
      manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
      // Work queued before this admission began keeps its batch open; the refused operation added nothing to it.
      const open = manager.get_status_snapshot().active_batch!
      admission.begin({ ...identity, operation_key: 'second', ordinal: 2 })
      admission.slot('second', 1, { ...refusal, batch_refs: [{ batch_id: open.batch_id, batch_generation: open.batch_generation, batch_ref: open.batch_ref }] })
      admission.finish('second', { ok: false })
      const record = admission.status('second').records[0]
      expect(record).toMatchObject({ state: 'failed', proven_refusal: true })
      expect(record.slots[0].batch_refs).toEqual([])
    })
    it('treats synchronously completed ok slots plus a proven refusal as exact evidence', () => {
      const { admission } = setup(2)
      admission.slot(identity.operation_key, 1, { ok: true, operation: 'equip_weapon', batch_refs: [], result: true })
      admission.slot(identity.operation_key, 2, refusal)
      admission.finish(identity.operation_key, { ok: false })
      expect(admission.status().records[0]).toMatchObject({ state: 'failed', proven_refusal: true, slots: [{ ok: true }, { refused_before_mutation: true }] })
    })
    it('keeps a prefix with queued work in flight plus a refusal uncertain', () => {
      const { admission, manager } = setup(2)
      manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
      admission.slot(identity.operation_key, 1, { ok: true, operation: 'wait', batch_refs: [ref] })
      admission.slot(identity.operation_key, 2, refusal)
      admission.finish(identity.operation_key, { ok: false })
      const record = admission.status().records[0]
      expect(record.state).toBe('uncertain')
      expect(record.proven_refusal).toBeUndefined()
    })
    it('settles a batch whose first task the engine refused before any change as failed, with every dependent task unstarted', () => {
      const { admission, manager } = setup(2)
      manager.add_task({ type: TaskStates.PLACING, entity_name: 'burner-mining-drill', position: { x: 11, y: -7 } })
      manager.add_task({ type: TaskStates.MOVING_ITEMS, item_name: 'coal', entity_name: 'burner-mining-drill', max_count: 5, to_entity: true } as any)
      admission.slot(identity.operation_key, 1, { ok: true, operation: 'place_entity', batch_refs: [ref] })
      admission.slot(identity.operation_key, 2, { ok: true, operation: 'move_items', batch_refs: [ref] })
      admission.finish(identity.operation_key, { ok: true })
      expect(admission.status().records[0].state).toBe('admitted')
      manager.cancel_all_tasks('placing:not_placeable', { failed_before_mutation: true })
      expect(manager.get_status_snapshot().receipt_journal[0]).toMatchObject({ ...ref, state: 'cancelled', started_count: 1, failed_before_mutation: true })
      expect(admission.status().records[0]).toMatchObject({ state: 'failed', proven_refusal: true, error: 'refused_before_mutation' })
      expect(pinned_operation_batch_refs()).toEqual([])
    })
    it('keeps a cancelled batch uncertain when an earlier task started and may have changed the world', () => {
      const { admission, manager } = setup()
      manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
      manager.add_task({ type: TaskStates.PLACING, entity_name: 'burner-mining-drill', position: { x: 1, y: 1 } })
      admission.slot(identity.operation_key, 1, { ok: true, operation: 'place_entity', batch_refs: [ref] })
      admission.finish(identity.operation_key, { ok: true })
      manager.reset_task_state()
      manager.next_task()
      manager.cancel_all_tasks('placing:not_placeable', { failed_before_mutation: true })
      expect(manager.get_status_snapshot().receipt_journal[0]).toMatchObject({ started_count: 2 })
      expect(admission.status().records[0]).toMatchObject({ state: 'uncertain', error: 'batch_reconciliation_required' })
    })
    it('keeps an engine-refused batch uncertain when any slot is not a validate-then-queue operation', () => {
      for (const operation of ['equip_weapon', undefined]) {
        const { admission, manager } = setup(2)
        manager.add_task({ type: TaskStates.PLACING, entity_name: 'burner-mining-drill', position: { x: 1, y: 1 } })
        // A synchronously mutating operation can carry the open batch ref yet have changed the world before the placement was refused.
        admission.slot(identity.operation_key, 1, { ok: true, operation, batch_refs: [ref] })
        admission.slot(identity.operation_key, 2, { ok: true, operation: 'place_entity', batch_refs: [ref] })
        admission.finish(identity.operation_key, { ok: true })
        manager.cancel_all_tasks('placing:not_placeable', { failed_before_mutation: true })
        expect(admission.status().records[0]).toMatchObject({ state: 'uncertain', error: 'batch_reconciliation_required' })
        expect(admission.status().records[0].proven_refusal).toBeUndefined()
        ;(globalThis as any).storage = {}
      }
    })
    it('keeps a cancellation without the failed-before-mutation proof uncertain', () => {
      const { admission, manager } = setup()
      manager.add_task({ type: TaskStates.PLACING, entity_name: 'burner-mining-drill', position: { x: 1, y: 1 } })
      admission.slot(identity.operation_key, 1, { ok: true, operation: 'place_entity', batch_refs: [ref] })
      admission.finish(identity.operation_key, { ok: true })
      manager.cancel_all_tasks('operator_cancel')
      expect(admission.status().records[0].state).toBe('uncertain')
    })
  })
  it('rejects the 65th unresolved admission without evicting any accepted work', () => {
    const manager = new_task_manager(() => undefined)
    const admission = new_operation_admission(actor, manager.get_status_snapshot)
    for (let index = 0; index < 64; index++) expect(admission.begin({ ...identity, operation_key: `op-${index}`, ordinal: index + 1 }).ok).toBe(true)
    expect(admission.begin({ ...identity, operation_key: 'overflow', ordinal: 65 })).toMatchObject({ ok: false, error: 'admission_journal_full' })
    expect(admission.status().records).toHaveLength(64)
  })
})
