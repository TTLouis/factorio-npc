import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { AgentLoopError, NpcAgentLoop, REQUEST_CONTINUATION_BACKSTOP } from './npc-agent-loop.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

// Per-slice continuation accounting (live Haiku run 2026-10-08, commit a8610bb5). One request ran all four steps of its
// first bounded slice on 14 continuations; the slice closed on a deterministic checkpoint, and the slice-completion
// continuation was then refused: the completed slice's plan is no longer 'active', so the limit fell from 64 to
// maxContinuations (10) while the request-wide counter was already 14. The request failed recoverable:false and the
// next slice could never be planned.
//
// The request-wide counter (`continuations`, which also numbers trace turns) is unchanged. A slice baseline moves to the
// current count at the plan-slice-completed boundary, next to the output slice baseline, and only for a slice that
// verified at least one deterministic world-result checkpoint. A hard request-wide backstop bounds every request.
// Static scenarios: a fake Factorio and scripted model replies; nothing here calls a provider.

const KEY = 'npc:sgluna'
const GOAL = { scope: 'long_horizon', summary: 'Launch one rocket from this save.', doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }] }
const SHELF = [
  { id: 'node_power', intent: 'steam power running' },
  { id: 'node_drill', intent: 'an electric mining drill on iron ore', depends_on: ['node_power'] },
]
const deterministic = (item, minimum) => ({ kind: 'deterministic', checkpoint: inventoryCheckpoint(item, minimum) })

function harness({ provider, maxContinuations, delegated = false } = {}) {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const trace = []
  const world = { game, memory, trace, calls: 0, pauses: [] }
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    ...(maxContinuations === undefined ? {} : { maxContinuations }),
    provider: async (messages) => {
      world.calls++
      assert.ok(world.calls < 20, 'slice scenario did not terminate')
      return provider(world.calls, world)
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    ...(delegated
      ? {
          completionProtocolVersion: 2, // production: a zero-operation planner draft is handed to the executor
          interactionDecisionProvider: recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined)),
        }
      : {}),
    systemPrompt: 'slice continuation budget test',
    goalDefinitionPolicy: 'required',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  const pause = world.agent.pausePersistentPlan.bind(world.agent)
  world.agent.pausePersistentPlan = async (reason) => {
    world.pauses.push(reason)
    return pause(reason)
  }
  world.agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  world.events = name => trace.filter(record => record.event === name)
  return world
}

// Slice 1: one deterministic step (10 iron ore in hand). Slice 2: another one.
function deterministicSlices(call) {
  if (call === 1) {
    return planReply({
      plan: ['Gather 10 iron ore'],
      operations: [gather('iron-ore', 10)],
      stepCompletions: [deterministic('iron-ore', 10)],
      goal: GOAL,
      roadmap: SHELF,
    })
  }
  return planReply({
    chatMessage: 'Next slice.',
    plan: ['Gather 20 copper ore'],
    operations: [gather('copper-ore', 20)],
    stepCompletions: [deterministic('copper-ore', 20)],
  })
}

// Slice 1 closes by a grounded semantic claim only: no deterministic checkpoint was ever verified in it.
function semanticSlices(call, world) {
  if (call === 1) {
    return planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], goal: GOAL, roadmap: SHELF })
  }
  if (call === 2) {
    return planReply({
      chatMessage: 'Iron is mined.',
      plan: [],
      currentStep: 0,
      operations: [],
      semanticCompletion: { stepId: world.memory.currentPlan(KEY)?.task_board?.active_step_id, rationale: 'The completed gather batch grounds this prose-only step.' },
    })
  }
  return planReply({ chatMessage: 'Next slice.', plan: ['Gather 20 copper ore'], operations: [gather('copper-ore', 20)] })
}

test('live shape: 14 continuations inside a slice that verified a deterministic checkpoint do not block the slice-completion continuation', async () => {
  const world = harness({ provider: deterministicSlices })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  assert.equal(world.agent.sliceContinuationBaseline, 0)
  // The slice used 14 continuations (request-wide); its last step then closes on the game.
  world.agent.continuations = 14
  world.game.inventory['iron-ore'] = 10

  const result = await world.agent.completed()

  assert.notEqual(result?.failed, true)
  assert.deepEqual(world.pauses, [])
  assert.equal(world.events('request.failed').length, 0)
  assert.equal(world.events('goal.paused').length, 0)
  assert.equal(world.calls, 2, 'the next slice was planned in the same request')
  assert.equal(world.game.mutations.length, 2)
  assert.equal(world.events('planning.slice_completion_continuation').length, 1)

  const [reset] = world.events('budget.continuation_slice_reset')
  assert.ok(reset.request_id)
  assert.equal(reset.data.route, 'next_shelf_slice')
  assert.equal(reset.data.reason, 'slice_verified_deterministic_progress')
  assert.equal(reset.data.previous_slice_continuations, 14)
  assert.equal(reset.data.request_continuations, 14)
  assert.equal(reset.data.previous_slice_continuation_baseline, 0)
  assert.equal(reset.data.slice_continuation_baseline, 14)
  assert.equal(reset.data.deterministic_steps_verified, 1)
  assert.equal(world.events('budget.continuation_slice_reset_withheld').length, 0)
  // The reset precedes the planner wake and the continuation it protects.
  const order = world.trace.map(record => record.event)
  assert.ok(order.indexOf('budget.continuation_slice_reset') < order.indexOf('planner.wake'))
  assert.ok(order.indexOf('planner.wake') < order.indexOf('planning.slice_completion_continuation'))

  // The request-wide counter (turn numbering) is untouched; the slice count restarted.
  assert.ok(world.agent.continuations > 14)
  assert.equal(world.agent.sliceContinuationBaseline, 14)
  assert.ok(world.agent.continuations - world.agent.sliceContinuationBaseline <= 3, 'the new slice has used only its own continuations')
})

test('after the reset, a planner phase that exceeds 10 continuations without committing still pauses with continuation_limit_10', async () => {
  const world = harness({ provider: deterministicSlices })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  world.agent.continuations = 14
  world.game.inventory['iron-ore'] = 10
  await world.agent.completed()
  assert.equal(world.agent.sliceContinuationBaseline, 14)

  // The planner now sits in a non-active plan phase (nothing committed), consuming continuations against the new baseline.
  world.agent.memory.currentPlan = () => ({ status: 'completed' })
  world.agent.runGuarded = async () => 'ran'
  world.agent.active = true
  world.agent.continuations = 14 + 9
  assert.equal(await world.agent.continueFromModMessage('[MOD] keep going', 'test.continuation'), 'ran', 'slice continuation 10 is still allowed')
  assert.equal(world.agent.continuations, 24)

  await assert.rejects(
    world.agent.continueFromModMessage('[MOD] keep going', 'test.continuation'),
    error => error instanceof AgentLoopError && /Continuation limit reached \(10\)/.test(error.message),
  )
  assert.deepEqual(world.pauses, ['continuation_limit_10'])
  assert.equal(world.events('budget.request_continuation_backstop').length, 0)
})

test('a slice that closed on semantic claims only does not reset: withheld trace and the old limit holds', async () => {
  const world = harness({ provider: semanticSlices })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  world.agent.continuations = 14
  world.game.inventory['iron-ore'] = 10

  // The old behavior: the slice-completion continuation is refused, the plan is paused and the request fails.
  await assert.rejects(world.agent.completed(), error => /Continuation limit reached \(10\)/.test(error.message))

  const [withheld] = world.events('budget.continuation_slice_reset_withheld')
  assert.ok(withheld.request_id)
  assert.equal(withheld.data.route, 'next_shelf_slice')
  assert.equal(withheld.data.reason, 'no_deterministic_progress_in_slice')
  assert.equal(withheld.data.slice_continuations, 15)
  assert.equal(withheld.data.request_continuations, 15)
  assert.equal(withheld.data.slice_continuation_baseline, 0)
  assert.equal(world.events('budget.continuation_slice_reset').length, 0)
  assert.equal(world.agent.sliceContinuationBaseline, 0)
  assert.deepEqual(world.pauses, ['continuation_limit_10'])
  assert.equal(world.events('planning.slice_completion_continuation').length, 0)
})

test('a slice under the limit that closed on semantic claims only behaves as before and traces the withheld reset', async () => {
  const world = harness({ provider: semanticSlices })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  world.game.inventory['iron-ore'] = 10

  await world.agent.completed()

  assert.deepEqual(world.pauses, [])
  assert.equal(world.events('planning.slice_completion_continuation').length, 1)
  assert.equal(world.events('budget.continuation_slice_reset_withheld').length, 1)
  assert.equal(world.events('budget.continuation_slice_reset').length, 0)
  assert.equal(world.agent.sliceContinuationBaseline, 0)
})

test('an in-slice step close never moves the continuation baseline; only the slice close does', async () => {
  const world = harness({
    provider: (call) => {
      if (call === 1) {
        return planReply({
          plan: ['Gather 10 iron ore', 'Gather 20 copper ore'],
          operations: [gather('iron-ore', 10)],
          stepCompletions: [deterministic('iron-ore', 10), deterministic('copper-ore', 20)],
          goal: GOAL,
          roadmap: SHELF,
        })
      }
      if (call === 2) return planReply({ plan: ['Gather 10 iron ore', 'Gather 20 copper ore'], currentStep: 1, operations: [gather('copper-ore', 20)] })
      return planReply({
        chatMessage: 'Next slice.',
        plan: ['Gather 5 coal'],
        operations: [gather('coal', 5)],
        stepCompletions: [deterministic('coal', 5)],
      })
    },
  })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  world.agent.continuations = 7
  world.game.inventory['iron-ore'] = 10

  await world.agent.completed()

  // Step 1 closed (deterministically), step 2 is active, the slice is still open.
  assert.equal(world.events('step.verified').length, 1)
  assert.equal(world.agent.sliceDeterministicCloses, 1)
  assert.equal(world.events('plan.slice_completed').length + world.events('planning.slice_completion_continuation').length, 0)
  assert.equal(world.events('budget.continuation_slice_reset').length, 0)
  assert.equal(world.events('budget.continuation_slice_reset_withheld').length, 0)
  assert.equal(world.agent.sliceContinuationBaseline, 0)

  world.game.inventory['copper-ore'] = 20
  await world.agent.completed()

  assert.equal(world.events('budget.continuation_slice_reset').length, 1)
  assert.equal(world.events('budget.continuation_slice_reset')[0].data.deterministic_steps_verified, 2)
  assert.equal(world.agent.sliceContinuationBaseline, world.events('budget.continuation_slice_reset')[0].data.request_continuations)
  assert.equal(world.agent.sliceDeterministicCloses, 0, 'the next slice has to earn its own reset')
})

test('the request-wide backstop pauses a request regardless of the slice baseline', async () => {
  assert.equal(REQUEST_CONTINUATION_BACKSTOP, 256)
  const world = harness({ provider: deterministicSlices })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  world.agent.runGuarded = async () => 'ran'
  // A request that keeps closing verified slices: the slice count is tiny, the request-wide count is not.
  world.agent.sliceContinuationBaseline = 250
  world.agent.continuations = 255
  assert.equal(await world.agent.continueFromModMessage('[MOD] next', 'test.continuation'), 'ran', 'one below the backstop is allowed')
  assert.equal(world.agent.continuations, 256)

  await assert.rejects(
    world.agent.continueFromModMessage('[MOD] next', 'test.continuation'),
    error => error instanceof AgentLoopError && /Request continuation backstop reached \(256/.test(error.message),
  )
  assert.deepEqual(world.pauses, ['request_continuation_backstop_256'])
  const [backstop] = world.events('budget.request_continuation_backstop')
  assert.ok(backstop.request_id)
  assert.equal(backstop.data.reason, 'request_continuation_backstop_256')
  assert.equal(backstop.data.request_continuations, 256)
  assert.equal(backstop.data.slice_continuations, 6)
  assert.equal(backstop.data.limit, 256)
})

test('a new request starts with a zero slice baseline and no carried progress', async () => {
  const world = harness({ provider: deterministicSlices })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  world.agent.continuations = 14
  world.game.inventory['iron-ore'] = 10
  await world.agent.completed()
  assert.equal(world.agent.sliceContinuationBaseline, 14)

  world.agent.reset()

  assert.equal(world.agent.continuations, 0)
  assert.equal(world.agent.sliceContinuationBaseline, 0)
  assert.equal(world.agent.sliceDeterministicCloses, 0)
})

// --- review follow-ups: stale progress and real progress -------------------------------------------------------

test('a close that finishes after a reset is not credited to the new request: the credit is fenced by generation and traced as dropped', async () => {
  const world = harness({ provider: deterministicSlices })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  world.game.inventory['iron-ore'] = 10

  // The reducer accepts the step close synchronously; the loop is then reset (a new request or an actor replacement)
  // while the close awaits its persistence, before it would credit the slice.
  let armed = false
  const apply = world.memory.applyOutcomeAuthority.bind(world.memory)
  world.memory.applyOutcomeAuthority = (key, candidate, options) => {
    const result = apply(key, candidate, options)
    if (candidate?.reason_code === 'deterministic_checkpoint_satisfied') armed = true
    return result
  }
  const persist = world.agent.persistState.bind(world.agent)
  world.agent.persistState = async (...args) => {
    if (armed) { armed = false; world.agent.reset() }
    return persist(...args)
  }
  const staleRequestId = world.agent.traceRequest.id
  await world.agent.completed().catch(() => {})

  assert.equal(armed, false, 'the reset really landed inside the close')
  assert.equal(world.agent.sliceDeterministicCloses, 0, 'the new lineage starts with no earned progress')
  const [dropped] = world.events('budget.continuation_slice_progress_dropped')
  assert.equal(dropped.data.kind, 'deterministic_close')
  assert.equal(dropped.data.reason, 'stale_generation')
  assert.equal(dropped.data.stale_request_id, staleRequestId)
  // The new request's slice closing now earns no baseline reset.
  await world.agent.closeContinuationSlice('next_shelf_slice')
  assert.equal(world.events('budget.continuation_slice_reset').length, 0)
  assert.equal(world.agent.sliceContinuationBaseline, 0)
})

test('a slice whose checkpoint was already met when it was committed, with no operation batch admitted, is withheld: no_admitted_operations_in_slice', async () => {
  const world = harness({
    delegated: true,
    provider: (call) => {
      if (call === 1) {
        return planReply({
          plan: ['Hold 10 iron ore'],
          operations: [],
          stepCompletions: [deterministic('iron-ore', 10)],
          goal: GOAL,
          roadmap: SHELF,
        })
      }
      return planReply({ chatMessage: 'Next slice.', plan: ['Gather 20 copper ore'], operations: [gather('copper-ore', 20)], stepCompletions: [deterministic('copper-ore', 20)] })
    },
  })
  world.game.inventory['iron-ore'] = 10
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })

  const withheld = world.events('budget.continuation_slice_reset_withheld')
  assert.equal(withheld.length, 1)
  assert.ok(withheld[0].request_id)
  assert.equal(withheld[0].data.reason, 'no_admitted_operations_in_slice')
  assert.equal(withheld[0].data.deterministic_steps_verified, 1)
  assert.equal(withheld[0].data.admitted_operation_batches, 0)
  assert.equal(world.events('budget.continuation_slice_reset').length, 0)
  assert.equal(world.agent.sliceContinuationBaseline, 0)
})

test('the live shape still resets: an admitted operation batch and a deterministic close in the same slice', async () => {
  const world = harness({ provider: deterministicSlices })
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  assert.equal(world.agent.sliceAdmittedBatches, 1)
  world.agent.continuations = 14
  world.game.inventory['iron-ore'] = 10
  await world.agent.completed()
  const [reset] = world.events('budget.continuation_slice_reset')
  assert.equal(reset.data.admitted_operation_batches, 1)
  assert.equal(reset.data.deterministic_steps_verified, 1)
  // The next slice starts with neither counter.
  assert.equal(world.agent.sliceDeterministicCloses, 0)
  assert.equal(world.agent.sliceAdmittedBatches, 1, 'only the next slice own admitted batch')
})
