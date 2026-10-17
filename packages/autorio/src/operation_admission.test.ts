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
  it('keeps missing first or trailing native receipts in flight until every exact reference completes', () => {
    const trailing = { batch_id: 2, batch_generation: 1, batch_ref: 'batch-g1-2' }
    let receipts: any[] = []
    const admission = new_operation_admission(actor, () => ({ batch_generation: 1, receipt_journal: receipts }))
    admission.begin(identity)
    admission.slot(identity.operation_key, 1, { ok: true, operation: 'harvest_product', batch_refs: [ref, trailing] })
    expect(admission.finish(identity.operation_key, { ok: true }).record?.state).toBe('admitted')
    receipts = [{ ...ref, state: 'completed' }]
    expect(admission.status().records[0].state).toBe('admitted')
    receipts = [{ ...trailing, state: 'completed' }]
    expect(admission.status().records[0].state).toBe('admitted')
    receipts = [{ ...ref, state: 'completed' }, { ...trailing, state: 'completed' }]
    expect(admission.status().records[0].state).toBe('completed')
  })
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
    it('settles a returned harvest_product refusal as failed: its submit validates, then queues', () => {
      const { admission } = setup()
      admission.slot(identity.operation_key, 1, { ...refusal, operation: 'harvest_product', error: 'no natural (tree or rock) prototypes currently yield stone-furnace' })
      admission.finish(identity.operation_key, { ok: false, error: 'autorio rejected operation 1' })
      expect(admission.status().records[0]).toMatchObject({ state: 'failed', proven_refusal: true, slots: [{ refused_before_mutation: true }] })
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
  describe('exact drained transfer refusal', () => {
    function setup() {
      const receipt = {
        ...ref, state: 'cancelled', outcome: 'refused', tick: 110,
        task_count: 4, started_count: 4, task_types: ['moving_items', 'moving_items', 'moving_items', 'moving_items'],
        completed_count: 3, refused_count: 1,
        refusals: [{ operation_id: 21, type: 'moving_items', code: 'nothing_moved', cause: 'target_rejects_item', target_unit_number: 49, held_count: 10, tick: 109 }],
      }
      const status: any = { batch_generation: 1, receipt_journal: [] }
      const admission = new_operation_admission(actor, () => status)
      // Run X admitted two withdrawals, then one supply wrapper that queued
      // coal and copper: three model operations, four native transfer tasks.
      admission.begin({ ...identity, operation_count: 3 })
      for (const [index, operation] of ['move_items_exact', 'move_items_exact', 'supply_entity'].entries()) {
        admission.slot(identity.operation_key, index + 1, { ok: true, operation, batch_refs: [ref] })
      }
      admission.finish(identity.operation_key, { ok: true })
      status.receipt_journal = [receipt]
      ;(globalThis as any).storage.sgluna_task_receipt_journal = status.receipt_journal
      ;(globalThis as any).storage.sgluna_task_batch_generation = 1
      const stored = (globalThis as any).storage.sgluna_operation_admissions[0]
      return { admission, status, receipt, stored }
    }
    it('closes fully accounted partial effects without claiming success, absence or a pre-mutation refusal', () => {
      const { admission, stored } = setup()
      expect(admission.status().records[0]).toMatchObject({ state: 'partial', ok: false, error: 'exact_terminal_transfer_refusal' })
      expect(admission.status().records[0].proven_refusal).toBeUndefined()
      expect(stored.state, 'status is a pure projection').toBe('admitted')
      expect(pinned_operation_batch_refs()).toEqual([])
      expect(admission.begin({ ...identity, operation_count: 3 })).toMatchObject({ ok: true, duplicate: true, record: { state: 'partial' } })
      expect(stored.state).toBe('partial')
      expect((globalThis as any).log).toHaveBeenCalledWith('[AUTORIO] operation.admission.partial request_id=request operation_key=request/operation reason=exact_terminal_transfer_refusal')
      admission.begin({ ...identity, operation_count: 3 })
      expect((globalThis as any).log.mock.calls.filter(([line]: [string]) => line.includes('operation.admission.partial'))).toHaveLength(1)
    })
    it('can close previously uncertain work and deduplicates a shared batch reference across slots', () => {
      const { admission, stored } = setup()
      stored.state = 'uncertain'
      expect(admission.status().records[0].state).toBe('partial')
    })
    it('does not reinterpret a failed supply wrapper as a pre-mutation refusal', () => {
      const admission = new_operation_admission(actor, () => ({ batch_generation: 1, receipt_journal: [] }))
      admission.begin(identity)
      admission.slot(identity.operation_key, 1, { ok: false, refused: true, operation: 'supply_entity', batch_refs: [], error: 'Unable to queue copper-ore supply' })
      admission.finish(identity.operation_key, { ok: false })
      expect(admission.status().records[0]).toMatchObject({ state: 'uncertain', slots: [{ mutation_unknown: true }] })
      expect(admission.status().records[0].proven_refusal).toBeUndefined()
    })
    it('requires every separate referenced batch to close and accepts exact completed companion receipts', () => {
      const { admission, status, stored } = setup()
      const second = { batch_id: 2, batch_generation: 1, batch_ref: 'batch-g1-2' }
      stored.slots[0].batch_refs.push(second)
      expect(admission.status().records[0].state).not.toBe('partial')
      status.receipt_journal.push({ ...second, state: 'completed', tick: 111, task_count: 1, started_count: 1, task_types: ['moving_items'] })
      expect(admission.status().records[0].state).toBe('partial')
    })
    const invalid: Array<[string, (world: ReturnType<typeof setup>) => void]> = [
      ['generation changed', w => { w.status.batch_generation = 2 }],
      ['missing receipt', w => { w.status.receipt_journal = [] }],
      ['wrong receipt identity', w => { w.receipt.batch_id = 9 }],
      ['cancelled tail', w => { w.receipt.started_count = 3 }],
      ['hard cancellation', w => { w.receipt.outcome = 'cancelled' }],
      ['missing completed count', w => { delete (w.receipt as any).completed_count }],
      ['mismatched totals', w => { w.receipt.completed_count = 2 }],
      ['fractional totals', w => { w.receipt.completed_count = 2.5 }],
      ['truncated task types', w => { w.receipt.task_types.pop() }],
      ['non-transfer task', w => { w.receipt.task_types[0] = 'placing' }],
      ['truncated refusal list', w => { w.receipt.refusals = [] }],
      ['unknown cause', w => { w.receipt.refusals[0].cause = 'unknown' }],
      ['other transfer failure', w => { w.receipt.refusals[0].code = 'item_missing' }],
      ['missing operation id', w => { delete (w.receipt.refusals[0] as any).operation_id }],
      ['missing target', w => { delete (w.receipt.refusals[0] as any).target_unit_number }],
      ['no held items', w => { w.receipt.refusals[0].held_count = 0 }],
      ['future refusal', w => { w.receipt.refusals[0].tick = 111 }],
      ['nonfinite receipt tick', w => { w.receipt.tick = Number.NaN }],
      ['synchronous mutation slot', w => { w.stored.slots[0].operation = 'equip_weapon' }],
      ['player transfer slot', w => { w.stored.slots[0].operation = 'move_items_with_player' }],
      ['unmapped slot', w => { w.stored.slots[0].batch_refs = [] }],
      ['incomplete slots', w => { w.stored.slots.pop() }],
      ['wrong slot index', w => { w.stored.slots[1].index = 1 }],
      ['slot failed', w => { w.stored.slots[0].ok = false }],
      ['invalid batch ref', w => { w.stored.slots[0].batch_refs = [{ ...ref, batch_ref: 'wrong' }] }],
    ]
    it.each(invalid)('keeps %s unresolved', (_label, mutate) => {
      const world = setup()
      mutate(world)
      expect(world.admission.status().records[0].state).not.toBe('partial')
      expect(world.stored.state).toBe('admitted')
    })
    it('rejects duplicate refusal operation identities even when the counts add up', () => {
      const { admission, receipt } = setup()
      receipt.refused_count = 2
      receipt.completed_count = 2
      receipt.refusals.push({ ...receipt.refusals[0] })
      expect(admission.status().records[0].state).toBe('uncertain')
    })
    it('retains the terminal partial audit after receipt eviction and counts it as bounded history', () => {
      const { admission, status } = setup()
      admission.begin({ ...identity, operation_count: 3 })
      status.receipt_journal = []
      expect(admission.status().records[0].state).toBe('partial')
      for (let ordinal = 2; ordinal <= 70; ordinal++) {
        const key = `later-${ordinal}`
        expect(admission.begin({ ...identity, operation_key: key, ordinal }).ok).toBe(true)
        admission.slot(key, 1, { ok: true, batch_refs: [] })
        admission.finish(key, { ok: true })
      }
      expect(admission.status().records).toHaveLength(64)
      expect(admission.begin({ ...identity, operation_count: 3 })).toMatchObject({ ok: false, error: 'expired_operation_ordinal' })
    })
  })
})
