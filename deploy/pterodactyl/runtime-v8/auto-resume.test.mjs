import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import {
  autoResumeDelayMs,
  autoResumeMaxAttempts,
  pauseStrandedPlanAfterRequestError,
  recoverInterruptedAgentPlan,
  Session,
  shouldRecoverInterruptedPlan,
  transientProviderFailure,
} from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

test('only temporary provider conditions are classified as transient', () => {
  const cases = [
    ['Hourly provider request budget reached', 'budget'],
    ['Hourly provider request budget reached; recovery reserve preserved', 'budget'],
    ['Provider HTTP 429; request will not be retried automatically', 'rate_limited'],
    ['Provider HTTP 503; request will not be retried automatically', 'server_error'],
    ['Provider timed out after 120000 ms', 'timeout'],
    ['fetch failed', 'transport'],
    // Waiting does not fix model-behaviour or request-shape failures.
    ['provider_context_window_exceeded: Provider HTTP 400 reported context/input token limit exhaustion', undefined],
    ['Provider HTTP 400; request will not be retried automatically', undefined],
    ['provider_action_omission_repair_failed: planner returned no operation', undefined],
    ['provider_output_budget_exhausted: finish=length', undefined],
    ['Provider response recovery exhausted after 3 attempts', undefined],
  ]
  for (const [message, kind] of cases) assert.equal(transientProviderFailure(message), kind, message)
})

test('auto-resume backs off and is bounded', () => {
  assert.equal(autoResumeDelayMs('budget', 0), 5 * 60 * 1000)
  assert.equal(autoResumeDelayMs('budget', 9), 5 * 60 * 1000)
  assert.equal(autoResumeDelayMs('timeout', 0), 30_000)
  assert.equal(autoResumeDelayMs('timeout', 2), 120_000)
  assert.equal(autoResumeDelayMs('timeout', 10), 8 * 60 * 1000)
  // Budget waits must span a whole hourly window before giving up.
  assert.ok(autoResumeMaxAttempts('budget') * autoResumeDelayMs('budget', 0) > 60 * 60 * 1000)
  assert.equal(autoResumeMaxAttempts('server_error'), 6)
})

test('a transient pause is eligible for automatic recovery; a user stop is not', () => {
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'provider_transient: Hourly provider request budget reached' }), true)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'user_stop' }), false)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'request_failed: Provider HTTP 400' }), false)
})

test('a goal paused on the hourly budget resumes the committed plan once the provider is back', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  let budgetExhausted = false
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      if (budgetExhausted) throw new Error('Hourly provider request budget reached')
      const coalStep = (game.inventory['iron-ore'] ?? 0) >= 10
      return coalStep
        // Committed contracts are immutable: continuations only act.
        ? planReply({ plan: ['Gather 10 iron ore', 'Gather 10 coal'], currentStep: 1, operations: [gather('coal', 10)] })
        : planReply({ plan: ['Gather 10 iron ore', 'Gather 10 coal'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10) })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'auto resume',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })

  await agent.request('gather iron then coal', { sender: 'Louis' })
  assert.equal(game.mutations.length, 1)

  // Step 1 verifies, but the next planner call hits the hourly cap.
  game.inventory['iron-ore'] = 10
  budgetExhausted = true
  const failure = await agent.completed().then(() => undefined, error => error)
  assert.match(failure?.message ?? '', /Hourly provider request budget reached/)

  // What the supervisor's event queue does with that failure.
  const session = { agent, currentPlanState: () => memory.currentPlan('npc:airi') }
  const paused = await pauseStrandedPlanAfterRequestError(session, failure.message)
  assert.equal(paused?.status, 'paused')
  assert.match(paused.pause_reason, /^provider_transient: /)
  assert.equal(shouldRecoverInterruptedPlan(paused), true)

  // The budget window refills; the scheduled resume goes through the same
  // re-observe-and-continue recovery a server restart uses.
  budgetExhausted = false
  const recovery = await recoverInterruptedAgentPlan(agent, 'auto_resume_after_transient_provider_failure', { attempt: 1 })
  assert.equal(recovery.recovered, true)
  assert.equal(game.mutations.length, 2, 'the next committed step was admitted without a human')
  assert.match(game.mutations[1], /coal/)
  assert.notEqual(memory.currentPlan('npc:airi').status, 'paused')
})

function stubSession() {
  const chat = []
  const logs = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    stopping: false,
    autoResume: null,
    log: message => logs.push(message),
    printChat: async message => { chat.push(message) },
    queueEvent: () => {},
  })
  return { session, chat, logs }
}

test('the session schedules a bounded resume, reports it in game, and gives up after the cap', async () => {
  const { session, chat } = stubSession()

  assert.equal(await session.scheduleAutoResume('Provider timed out after 120000 ms'), true)
  assert.equal(session.autoResume.attempt, 1)
  assert.equal(session.autoResume.kind, 'timeout')
  assert.match(chat.at(-1), /Resuming automatically in 30 s \(attempt 1\/6\)/)

  // A second failure backs off further instead of hammering the provider.
  assert.equal(await session.scheduleAutoResume('Provider timed out after 120000 ms'), true)
  assert.equal(session.autoResume.attempt, 2)
  assert.match(chat.at(-1), /in 60 s \(attempt 2\/6\)/)

  session.autoResume.attempt = autoResumeMaxAttempts('timeout')
  assert.equal(await session.scheduleAutoResume('Provider timed out after 120000 ms'), false)
  assert.equal(session.autoResume, null)
  assert.match(chat.at(-1), /say continue to retry/)

  // Non-transient failures never schedule anything.
  assert.equal(await session.scheduleAutoResume('provider_action_omission_repair_failed'), false)
  assert.equal(session.autoResume, null)
  session.clearAutoResume()
})

test('real world progress resets the retry streak; a pending timer is kept', () => {
  const { session } = stubSession()
  session.agentLive = {}
  session.autoResume = { attempt: 3, kind: 'timeout', timer: null }
  try { session.onAgentActivity('operations.ack', {}) }
  catch { /* the stub has no UI wiring; only the reset matters here */ }
  assert.equal(session.autoResume, null)

  const timer = setTimeout(() => {}, 60_000)
  session.autoResume = { attempt: 2, kind: 'timeout', timer }
  try { session.onAgentActivity('operations.ack', {}) }
  catch { /* see above */ }
  assert.equal(session.autoResume?.attempt, 2)
  clearTimeout(timer)
})
