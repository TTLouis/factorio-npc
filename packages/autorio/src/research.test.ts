import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_research_controller } from './research'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'
import { new_operation_admission } from './operation_admission'
// @ts-expect-error runtime reconciliation is shipped JavaScript
import { reconcilePendingOperation, unresolvedNativeAdmissions } from '../../../deploy/pterodactyl/runtime-v8/operation-reconciliation.mjs'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.print = vi.fn()
  ;(globalThis as any).log = vi.fn()
  ;(globalThis as any).pairs = (value: object) => Object.entries(value)
})

function world() {
  const tech: Record<string, any> = {
    name: 'automation', enabled: true, researched: false, level: 1,
    prerequisites: {} as Record<string, any>, prototype: {} as Record<string, any>,
    research_unit_count: 10, research_unit_energy: 600,
    research_unit_ingredients: [{ name: 'automation-science-pack', amount: 1 }],
    saved_progress: 0,
  }
  const force: Record<string, any> = {
    name: 'player', index: 1, valid: true, research_enabled: true,
    technologies: { automation: tech } as Record<string, typeof tech>,
    current_research: undefined as typeof tech | undefined,
    research_queue: [] as typeof tech[], research_progress: 0,
    add_research: vi.fn((value: typeof tech) => {
      force.current_research = value
      force.research_queue = [value]
      return true
    }),
  }
  tech.force = force
  const identity = { kind: 'standalone_character', actor_id: 42 }
  const actor = {
    is_valid: true, character: {}, force,
    status_snapshot: () => identity,
  } as unknown as ControlledActor
  const get_actor = vi.fn<() => ControlledActor | undefined>(() => actor)
  const manager = new_task_manager(get_actor)
  const controller = new_research_controller(get_actor, manager)
  return { actor, force, tech, identity, manager, controller, get_actor }
}

function expectRejected(result: [boolean, string, number], code: string) {
  expect(result[0]).toBe(false)
  expect(result[1]).toBe(code)
  expect(result[2]).toBeGreaterThan(0)
  return result[2]
}

describe('serialized asynchronous research requests', () => {
  it('defers force mutation until the request reaches the head of the NPC queue', () => {
    const { actor, force, manager, controller } = world()
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    expect(controller.submit('automation')[0]).toBe(true)
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(manager.get_status_snapshot().queue_length).toBe(1)
    manager.reset_task_state()
    manager.next_task()
    controller.tick(actor)
    expect(force.add_research).toHaveBeenCalledTimes(1)
    expect(manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('allocates monotonic request ids and exposes exact rejected results', () => {
    const { controller } = world()
    const missing = controller.submit('unknown')
    const malformed = controller.submit('automation\n[ERROR] injected')
    expect(missing[2]).toBeGreaterThan(0)
    expect(malformed[2]).toBe(missing[2] + 1)
    expect(controller.request_result(missing[2])).toMatchObject({
      found: true,
      request_id: missing[2],
      result: { accepted: false, completed: false, code: 'unknown_technology' },
    })
    expect(controller.request_result(malformed[2])).toMatchObject({
      found: true,
      request_id: malformed[2],
      result: { accepted: false, code: 'invalid_name' },
    })
    expect(controller.request_result(99999)).toEqual({ found: false, error: 'unknown_request_id', request_id: 99999 })
    expect(controller.request_result(0)).toEqual({ found: false, error: 'invalid_request_id' })
  })

  it('allows queued physical work while native research is still incomplete', () => {
    const { actor, tech, manager, controller } = world()
    const request = controller.submit('automation')
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 120 })
    controller.tick(actor)
    expect(tech.researched).toBe(false)
    expect(manager.player_state.task_state).toBe(TaskStates.WAITING)
    expect(controller.status()).toMatchObject({
      current: { name: 'automation' },
      last_request_result: { request_id: request[2], accepted: true, completed: false, code: 'started' },
    })
    expect(controller.request_result(request[2])).toMatchObject({
      found: true,
      follow_through: { state: 'running', requested_level: 1 },
    })
    expect(controller.technology('automation')).toMatchObject({ researched: false })
  })

  it('cancels a pending request without starting native research', () => {
    const { actor, force, manager, controller } = world()
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })
    controller.submit('automation')
    manager.cancel_all_tasks()
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(force.current_research).toBeUndefined()
  })

  it('does not cancel shared force research after submission', () => {
    const { actor, force, manager, controller } = world()
    controller.submit('automation')
    controller.tick(actor)
    manager.cancel_all_tasks()
    expect(force.current_research?.name).toBe('automation')
  })

  it('records engine rejection and cancels dependent work without success notification', () => {
    const { actor, force, manager, controller } = world()
    force.add_research.mockReturnValue(false)
    controller.submit('automation')
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 120 })
    controller.tick(actor)
    expect(controller.status()).toMatchObject({ last_request_result: { accepted: false, completed: false, code: 'engine_rejected' } })
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: 'idle', queue_length: 0 })
    expect((globalThis as any).game.print).not.toHaveBeenCalledWith(expect.stringContaining('All operations completed'))
    expect((globalThis as any).log).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'))
  })

  it('rechecks disabled research at execution rather than trusting admission', () => {
    const { actor, tech, force, controller } = world()
    controller.submit('automation')
    tech.enabled = false
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'technology_disabled', accepted: false } })
  })

  it.each(['actor', 'kind', 'force'] as const)('rejects a changed %s instead of executing for another owner', (change) => {
    const { actor, force, identity, controller } = world()
    controller.submit('automation')
    if (change === 'actor') identity.actor_id = 99
    if (change === 'kind') identity.kind = 'connected_player'
    if (change === 'force') force.index = 2
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'actor_changed', accepted: false } })
  })

  it('does not duplicate active or already-researched technology', () => {
    const { actor, tech, force, controller } = world()
    force.current_research = tech
    force.research_queue = [tech]
    controller.submit('automation')
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'already_queued' } })
    tech.researched = true
    force.current_research = undefined
    force.research_queue = []
    controller.submit('automation')
    controller.tick(actor)
    expect(force.add_research).not.toHaveBeenCalled()
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'already_researched', completed: true } })
  })

  function appendingQueue(force: Record<string, any>) {
    force.add_research = vi.fn((value: any) => {
      force.research_queue = [...force.research_queue, value]
      return true
    })
  }

  it('appends behind existing force research without replacing or reordering it, then follows it to the front', () => {
    const { actor, force, tech, controller } = world()
    const other = { ...tech, name: 'logistics' }
    force.current_research = other
    force.research_queue = [other]
    appendingQueue(force)
    const [accepted, , request_id] = controller.submit('automation')
    expect(accepted).toBe(true)
    controller.tick(actor)
    expect(force.add_research).toHaveBeenCalledTimes(1)
    expect(force.current_research.name).toBe('logistics')
    expect(force.research_queue.map((item: any) => item.name)).toEqual(['logistics', 'automation'])
    expect(controller.request_result(request_id)).toMatchObject({
      result: { accepted: true, completed: false, code: 'queued_behind' },
      follow_through: { state: 'queued' },
    })

    // Waiting in the queue longer than the stall window is not a stall.
    ;(globalThis as any).game.tick += 60 * 60 * 2
    controller.status()
    expect(controller.request_result(request_id)).toMatchObject({ result: { code: 'queued_behind' }, follow_through: { state: 'queued' } })

    // The earlier research finishes and the labs move on to this request.
    force.current_research = tech
    force.research_queue = [tech]
    force.research_progress = 0
    controller.status()
    expect(controller.request_result(request_id)).toMatchObject({ result: { code: 'started' }, follow_through: { state: 'running' } })
  })

  it('accepts a prerequisite that is already queued ahead, and still refuses one that is not', () => {
    const { actor, force, tech, controller } = world()
    const electronics = { ...tech, name: 'electronics', researched: false }
    tech.prerequisites = { electronics }
    force.technologies.electronics = electronics
    expectRejected(controller.submit('automation'), 'missing_prerequisites')
    force.current_research = electronics
    force.research_queue = [electronics]
    appendingQueue(force)
    expect(controller.submit('automation')[0]).toBe(true)
    controller.tick(actor)
    expect(force.research_queue.map((item: any) => item.name)).toEqual(['electronics', 'automation'])
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'queued_behind', accepted: true } })
  })

  it('reports force_busy when the native queue refuses an append, leaving it unchanged', () => {
    const { actor, force, tech, controller } = world()
    const other = { ...tech, name: 'logistics' }
    force.current_research = other
    force.research_queue = [other]
    force.add_research = vi.fn(() => false)
    controller.submit('automation')
    controller.tick(actor)
    expect(force.research_queue).toEqual([other])
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'force_busy', accepted: false } })
  })

  it('rechecks queue identity after add_research instead of trusting its boolean', () => {
    const { actor, force, tech, controller } = world()
    const other = { ...tech, name: 'logistics' }
    force.current_research = other
    force.research_queue = [other]
    force.add_research = vi.fn(() => true)
    controller.submit('automation')
    controller.tick(actor)
    expect(force.current_research.name).toBe('logistics')
    expect(controller.status()).toMatchObject({ last_request_result: { code: 'force_busy', accepted: false } })
  })

  it('rejects missing prerequisites, gameplay-trigger research, and disabled force research with distinct ids', () => {
    const { force, tech, controller } = world()
    tech.prerequisites = { electronics: { researched: false } }
    const first = expectRejected(controller.submit('automation'), 'missing_prerequisites')
    tech.prerequisites = {}
    tech.prototype.research_trigger = { type: 'craft-item' }
    const second = expectRejected(controller.submit('automation'), 'trigger_research')
    tech.prototype = {}
    force.research_enabled = false
    const third = expectRejected(controller.submit('automation'), 'research_disabled')
    expect([second, third]).toEqual([first + 1, first + 2])
    expect(force.add_research).not.toHaveBeenCalled()
  })

  it('rejects unknown, malformed, oversized, and unowned requests', () => {
    const { controller, get_actor } = world()
    expectRejected(controller.submit('unknown'), 'unknown_technology')
    expectRejected(controller.submit('automation\n[ERROR] injected'), 'invalid_name')
    expectRejected(controller.submit('x'.repeat(201)), 'invalid_name')
    get_actor.mockReturnValue(undefined)
    expectRejected(controller.submit('automation'), 'no_actor')
    expect(controller.status()).toEqual({ error: 'no_actor' })
  })

  it('marks a running request stalled after a bounded no-progress interval and recovers when progress resumes', () => {
    const { actor, force, controller } = world()
    const request = controller.submit('automation')
    controller.tick(actor)
    expect(controller.request_result(request[2])).toMatchObject({ follow_through: { state: 'running' } })

    ;(globalThis as any).game.tick = 100 + 3600
    force.research_progress = 0
    controller.status()
    expect(controller.request_result(request[2])).toMatchObject({
      result: { code: 'stalled', completed: false },
      follow_through: { state: 'stalled' },
    })

    ;(globalThis as any).game.tick += 1
    force.research_progress = 0.25
    controller.status()
    expect(controller.request_result(request[2])).toMatchObject({
      result: { code: 'started', completed: false, progress: 0.25 },
      follow_through: { state: 'running', last_progress: 0.25 },
    })
  })

  it('marks a request interrupted if the force drops it before completion', () => {
    const { actor, force, controller } = world()
    const request = controller.submit('automation')
    controller.tick(actor)
    force.current_research = undefined
    force.research_queue = []
    ;(globalThis as any).game.tick += 1
    controller.status()
    expect(controller.request_result(request[2])).toMatchObject({
      result: { code: 'interrupted', completed: false },
      follow_through: { state: 'interrupted' },
    })
  })

  it('completes repeatable research by level advance even when researched remains false', () => {
    const { actor, force, tech, controller } = world()
    tech.name = 'mining-productivity-4'
    tech.level = 4
    tech.researched = false
    tech.prototype.max_level = 'infinite'
    force.technologies = { [tech.name]: tech }

    const request = controller.submit(tech.name)
    controller.tick(actor)
    expect(controller.request_result(request[2])).toMatchObject({
      result: { code: 'started', requested_level: 4, completed: false },
      follow_through: { state: 'running', requested_level: 4 },
    })

    tech.level = 5
    force.current_research = tech
    force.research_queue = [tech]
    ;(globalThis as any).game.tick = 250
    controller.on_research_finished({ research: tech, tick: 250, by_script: false } as any)

    expect(controller.request_result(request[2])).toMatchObject({
      result: {
        accepted: true,
        completed: true,
        code: 'completed',
        requested_level: 4,
        observed_level: 5,
        by_script: false,
      },
      follow_through: { state: 'completed', requested_level: 4, observed_level: 5, completed_tick: 250 },
    })
  })

  it('retains original request owner when completion is observed after actor replacement', () => {
    const { actor, tech, controller, get_actor, identity } = world()
    const request = controller.submit('automation')
    controller.tick(actor)
    identity.actor_id = 99
    get_actor.mockReturnValue(actor)
    tech.researched = true
    ;(globalThis as any).game.tick = 300
    controller.on_research_finished({ research: tech, tick: 300, by_script: false } as any)

    expect(controller.request_result(request[2])).toMatchObject({
      result: { completed: true, actor_id: 42, actor_kind: 'standalone_character', force_index: 1 },
      follow_through: { actor_id: 42, actor_kind: 'standalone_character', force_index: 1 },
    })
  })

  it('bounds observations and does not mutate research while reading', () => {
    const { force, tech, controller } = world()
    force.research_queue = Array.from({ length: 15 }, (_, i) => ({ ...tech, name: `tech-${i}` }))
    tech.prerequisites = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`prereq-${i}`, { researched: false }]))
    tech.research_unit_ingredients = Array.from({ length: 25 }, (_, i) => ({ name: `pack-${i}`, amount: 1 }))
    const status = controller.status()
    expect(status).toMatchObject({ queue_length: 15, queue_truncated: true })
    expect('queue' in status && status.queue).toHaveLength(10)
    const info = controller.technology('automation')
    expect(info).toMatchObject({ prerequisites_truncated: true, ingredients_truncated: true })
    expect('prerequisites' in info && info.prerequisites).toHaveLength(20)
    expect('ingredients' in info && info.ingredients).toHaveLength(20)
    expect(force.add_research).not.toHaveBeenCalled()
  })
})

describe('technology progress', () => {
  it('reads the current research progress from the force and any other technology from saved_progress', () => {
    const { force, tech, controller } = world()
    const other = { ...tech, name: 'logistics', saved_progress: 0.25, prerequisites: {}, prototype: {} }
    force.technologies.logistics = other
    // The technology is the current research at 60%: saved_progress belongs to a technology that is not current and reads 0.
    force.current_research = tech
    force.research_progress = 0.6
    tech.saved_progress = 0
    expect(controller.technology('automation')).toMatchObject({ found: true, is_current_research: true, progress: 0.6, saved_progress: 0 })
    expect(controller.technology('logistics')).toMatchObject({ is_current_research: false, progress: 0.25, saved_progress: 0.25 })
    force.current_research = undefined
    expect(controller.technology('automation')).toMatchObject({ is_current_research: false, progress: 0 })
  })
})
describe('research unlock facts', () => {
  it('lists the technologies researchable now with the recipes each unlocks, and the unlocks of one technology', () => {
    const { force, tech, controller } = world()
    tech.prototype.effects = [{ type: 'unlock-recipe', recipe: 'assembling-machine-1' }, { type: 'nothing' }, { type: 'unlock-recipe', recipe: 'long-handed-inserter' }]
    const logistics = { name: 'logistics', enabled: true, researched: false, level: 1, prerequisites: {}, research_unit_count: 75,
      research_unit_ingredients: [{ name: 'automation-science-pack', amount: 1 }], saved_progress: 0,
      prototype: { effects: [{ type: 'unlock-recipe', recipe: 'underground-belt' }, { type: 'unlock-recipe', recipe: 'splitter' }] } }
    const locked = { ...logistics, name: 'logistics-2', prerequisites: { logistics }, prototype: { effects: [] } }
    const done = { ...logistics, name: 'steam-power', researched: true }
    const disabled = { ...logistics, name: 'hidden-tech', enabled: false }
    const trigger = { ...logistics, name: 'electronics', prototype: { research_trigger: { type: 'craft-item' }, effects: [] } }
    const hidden = { ...logistics, name: 'debug-tech', prototype: { hidden: true, effects: [] } }
    force.technologies = { logistics, automation: tech, 'logistics-2': locked, 'steam-power': done, 'hidden-tech': disabled, electronics: trigger, 'debug-tech': hidden }
    const status: any = controller.status()
    // Cheapest first: the trigger technology, then 10 units before 75 units.
    expect(status.available.map((row: any) => row.name)).toEqual(['electronics', 'automation', 'logistics'])
    expect(status.available[2]).toEqual({ name: 'logistics', unlocks: ['underground-belt', 'splitter'], unlocks_truncated: false,
      trigger_type: undefined, research_unit_count: 75, ingredients: ['automation-science-pack'] })
    expect(status.available[0]).toMatchObject({ name: 'electronics', trigger_type: 'craft-item', ingredients: undefined, research_unit_count: undefined })
    expect(status).toMatchObject({ available_count: 3, available_truncated: false })
    expect(controller.technology('automation')).toMatchObject({ unlocks: ['assembling-machine-1', 'long-handed-inserter'], unlocks_truncated: false })
    expect(controller.technology('logistics-2')).toMatchObject({ unlocks: [], unlocks_truncated: false })
  })

  it('bounds the available list and each unlock list', () => {
    const { force, tech, controller } = world()
    tech.prototype.effects = Array.from({ length: 15 }, (_, index) => ({ type: 'unlock-recipe', recipe: `recipe-${index}` }))
    const many: Record<string, any> = { automation: tech }
    for (let index = 0; index < 30; index++) many[`tech-${index}`] = { ...tech, name: `tech-${index}`, prototype: { effects: [] } }
    // A cheap technology listed last by the engine is still kept under the cap.
    many.logistics = { ...tech, name: 'logistics', research_unit_count: 5, prototype: { effects: [] } }
    force.technologies = many
    const status: any = controller.status()
    expect(status.available).toHaveLength(24)
    expect(status).toMatchObject({ available_count: 32, available_truncated: true })
    expect(status.available[0]).toMatchObject({ name: 'logistics' })
    expect(status.available[1]).toMatchObject({ name: 'automation', unlocks_truncated: true })
    expect(status.available[1].unlocks).toHaveLength(12)
  })
})


describe('Trial 7 exact research refusal settlement', () => {
  function admitted(mode = 'exact') {
    const f = world()
    ;(f.actor.character as any).valid = true
    ;(globalThis as any).remote = { interfaces: { sgluna_deployment: { authorize: true } }, call: vi.fn(() => true) }
    const admission = new_operation_admission(() => f.actor, () => f.manager.get_status_snapshot())
    const pending = { protocol_version: 2, operation_key: 'ext-158/1', attempt_id: 'attempt-1', signature: 'sig-1', ordinal: 1,
      actor: { actor_id: 42, epoch: 1 }, operations: [{ name: 'research_technology', args: { technology_name: 'automation' } }] }
    if (mode === 'mixed') pending.operations.push({ name: 'wait', args: { ticks: 1 } } as any)
    const correlation = { ...pending, actor_id: 42, epoch: 1, operation_count: pending.operations.length }
    expect(admission.begin(correlation).ok).toBe(true)
    const other = { ...f.tech, name: 'logistics' }
    f.force.current_research = other
    f.force.research_queue = [other]
    f.force.add_research = vi.fn(() => {
      if (mode === 'partial') f.force.research_queue.push(f.tech)
      if (mode === 'changed') f.force.research_progress = 0.5
      return mode === 'true_without_append'
    })
    expect(f.controller.submit('automation')[0]).toBe(true)
    const active = f.manager.get_status_snapshot().active_batch!
    admission.slot(pending.operation_key, 1, { ok: true, operation: 'research_technology', batch_refs: [active] })
    if (mode === 'mixed') {
      f.manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 1 })
      admission.slot(pending.operation_key, 2, { ok: true, operation: 'wait', batch_refs: [active] })
    }
    expect(admission.finish(pending.operation_key, { ok: true }).ok).toBe(true)
    const task = f.manager.player_state.parameters_research_technology!
    if (mode === 'legacy') delete task.admission_binding
    if (mode === 'wrong_request') task.request_id!++
    if (mode === 'wrong_attempt') task.admission_binding!.attempt_id = 'other'
    if (mode === 'stale_epoch') (globalThis as any).remote.call.mockReturnValue(false)
    f.controller.tick(f.actor)
    const status = { ...f.manager.get_status_snapshot(), admission_journal: admission.status().records }
    return { ...f, admission, pending, status, verdict: reconcilePendingOperation(pending, { status, actor: pending.actor }) }
  }
  it('settles the real callback once, persists terminal admission, continues and permits an idle stop', () => {
    const f = admitted()
    expect(f.controller.status()).toMatchObject({ last_request_result: { accepted: false, code: 'force_busy', no_effect: true } })
    expect(f.verdict).toMatchObject({ verdict: 'refused_before_mutation', effect: 'not_happened' })
    expect((globalThis as any).storage.sgluna_operation_admissions[0]).toMatchObject({ state: 'failed', proven_refusal: true })
    expect(unresolvedNativeAdmissions(f.status, [f.pending], f.pending.actor)).toEqual([])
    f.controller.tick(f.actor)
    expect(f.force.add_research).toHaveBeenCalledTimes(1)
    expect(f.admission.begin({ ...f.pending, actor_id: 42, epoch: 1, operation_count: 1 }).duplicate).toBe(true)
    ;(globalThis as any).storage = JSON.parse(JSON.stringify((globalThis as any).storage))
    expect(f.admission.status().records[0].state).toBe('failed')
    expect(f.admission.begin({ ...f.pending, operation_key: 'next/1', attempt_id: 'next', actor_id: 42, epoch: 1, operation_count: 1, ordinal: 2 }).ok).toBe(true)
    f.manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 1 })
    expect(f.manager.player_state.task_state).toBe(TaskStates.WAITING)
    expect((globalThis as any).log).toHaveBeenCalledWith(expect.stringContaining('research.rejection_settled request_id=ext-158'))
  })
  it.each(['partial', 'changed', 'true_without_append', 'mixed', 'legacy', 'wrong_request', 'wrong_attempt', 'stale_epoch'])('keeps %s fenced without repeating research', mode => {
    const f = admitted(mode)
    expect(f.status.admission_journal[0].state).toBe('uncertain')
    expect(f.verdict).toMatchObject({ verdict: 'admitted_cancelled', reason: 'exact_batch_cancelled', effect: 'partial_unknown' })
    ;(globalThis as any).storage = JSON.parse(JSON.stringify((globalThis as any).storage))
    const restored = { ...f.manager.get_status_snapshot(), admission_journal: f.admission.status().records }
    expect(restored.admission_journal[0].state).toBe('uncertain')
    expect(reconcilePendingOperation(f.pending, { status: restored, actor: f.pending.actor })).toMatchObject({
      verdict: 'admitted_cancelled', reason: 'exact_batch_cancelled', effect: 'partial_unknown',
    })
    expect(unresolvedNativeAdmissions(f.status, [f.pending], f.pending.actor)).toHaveLength(1)
    f.controller.tick(f.actor)
    expect(f.force.add_research).toHaveBeenCalledTimes(['wrong_request', 'wrong_attempt', 'stale_epoch'].includes(mode) ? 0 : 1)
  })
  it('requires readable exact idle receipts on the host and preserves actor/epoch fences', () => {
    const f = admitted()
    for (const change of [
      (s: any) => { s.queue_length = 1 },
      (s: any) => { s.receipt_journal[0].research_request_id++ },
      (s: any) => { s.receipt_journal.push({ ...s.receipt_journal[0] }) },
      (s: any) => { s.receipt_journal = []; delete s.admission_journal[0].research_receipt },
    ]) {
      const status = JSON.parse(JSON.stringify(f.status)); change(status)
      expect(reconcilePendingOperation(f.pending, { status, actor: f.pending.actor }).effect).not.toBe('not_happened')
    }
    expect(reconcilePendingOperation(f.pending, { status: f.status, actor: { actor_id: 42, epoch: 2 } }).reason).toBe('actor_epoch_changed')
    const restored = JSON.parse(JSON.stringify(f.status)); restored.batch_generation++; restored.receipt_journal = []
    expect(reconcilePendingOperation(f.pending, { status: restored, actor: { actor_id: 42, epoch: 2 } }).effect).toBe('not_happened')
    delete restored.admission_journal[0].research_receipt
    expect(reconcilePendingOperation(f.pending, { status: restored, actor: { actor_id: 42, epoch: 2 } }).effect).not.toBe('not_happened')
  })
  it('prevents a known disabled technology before admission, retaining duplicate no-ops', () => {
    const f = world()
    f.tech.enabled = false
    f.force.current_research = { ...f.tech, name: 'logistics' }
    f.force.research_queue = [f.force.current_research]
    expect(f.controller.submit('automation')[0]).toBe(false)
    expect(f.force.add_research).not.toHaveBeenCalled()
    f.tech.enabled = true
    f.force.current_research = f.tech
    f.force.research_queue = [f.tech]
    expect(f.controller.submit('automation')[0]).toBe(true)
  })
})
