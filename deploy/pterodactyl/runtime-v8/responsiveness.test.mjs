import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  ACK_INTENTS,
  acknowledgementLine,
  ChatAcknowledger,
  ResponsivenessTracker,
  responsivenessByRequest,
} from './responsiveness.mjs'
import { STEAM_REQUEST_TEXT, steamReplayHarness } from './steam-run-fixtures.mjs'
import { liveAgentDebugEvent, recoverInterruptedAgentPlan, Session } from './supervisor.mjs'
import { buildRunRecord, formatRunRecord } from './think-time-report.mjs'

const SLOW_PLANNER_MS = 250

// The steam replay with a planner that takes SLOW_PLANNER_MS to answer, and
// the loop's activity stream (what the supervisor prints from) time-stamped.
function slowPlannerHarness(options = {}) {
  const world = steamReplayHarness(options)
  const inner = world.agent.provider
  world.agent.provider = async (...args) => {
    await delay(SLOW_PLANNER_MS)
    return inner(...args)
  }
  const activity = []
  world.agent.onActivity = (event, data) => { activity.push({ event, data, at: Date.now() }) }
  return { ...world, activity }
}

test('acknowledgementLine: from the goal text and route only, no world or completion claim', () => {
  assert.deepEqual(ACK_INTENTS, ['new_goal', 'amend_current', 'continue_current'])
  const line = acknowledgementLine({ text: STEAM_REQUEST_TEXT, intent: 'new_goal' })
  assert.match(line, /^Heard you\. I will start on: "Can you get steam power going/)
  assert.doesNotMatch(line, /\b(done|complete[d]?|finished|built|placed|crafted|verified)\b/i)
  assert.match(acknowledgementLine({ text: 'make it faster', intent: 'amend_current' }), /^Heard you\. I will adjust the current goal: "make it faster"/)
  assert.match(acknowledgementLine({ text: 'continue', intent: 'continue_current' }), /pick the current goal back up/)
  // Routes that answer at once get no acknowledgement of their own.
  for (const intent of ['status_query', 'chat_only', 'cancel_current', undefined]) {
    assert.equal(acknowledgementLine({ text: 'hello', intent }), '')
  }
  // Rich text and quotes in the player's words are echoed as plain text,
  // long goals are cut.
  const rich = acknowledgementLine({ text: '[color=red]build[/color] "a" [item=iron-plate] ' + 'x'.repeat(300), intent: 'new_goal' })
  assert.doesNotMatch(rich, /\[|"a"/)
  assert.ok(rich.length < 240, `bounded line, got ${rich.length}`)
  assert.match(rich, /\.\.\."\. I will share/)
})

test('ChatAcknowledger: at most one per request, player origin only, no planner-less route', () => {
  let clock = 1000
  const acknowledger = new ChatAcknowledger({ now: () => clock })
  clock = 1180
  const first = acknowledger.acknowledge({ requestId: 'req_1', text: 'build steam power', intent: 'new_goal', startedAt: 1000 })
  assert.equal(first.latency_ms, 180)
  assert.equal(first.world_claim, false)
  assert.equal(first.source, 'goal_text_and_route')
  assert.equal(acknowledger.acknowledge({ requestId: 'req_1', text: 'build steam power', intent: 'new_goal', startedAt: 1000 }), undefined, 'a second call for the same request says nothing')
  assert.equal(acknowledger.acknowledge({ requestId: 'req_2', text: 'x', intent: 'new_goal', origin: 'recovery' }), undefined, 'not a player request')
  assert.equal(acknowledger.acknowledge({ requestId: 'req_3', text: 'x', intent: 'status_query' }), undefined)
  assert.equal(acknowledger.acknowledge({ text: 'x', intent: 'new_goal' }), undefined, 'no request id, nothing to key it on')
  assert.ok(acknowledger.acknowledge({ requestId: 'req_4', text: 'go', intent: 'new_goal' }), 'the next request is acknowledged')
})

for (const routed of [true, false]) {
  test(`a slow planner still gets the acknowledgement before its first reply (${routed ? 'Jev interaction route' : 'no Jev, deterministic route'})`, async () => {
    const world = slowPlannerHarness({ transport: 'message', ...(routed ? { routedIntent: () => 'new_goal' } : {}) })
    await world.request()

    const acks = world.events('chat.acknowledged')
    assert.equal(acks.length, 1)
    const [ack] = acks
    assert.match(ack.request_id, /^req_/)
    assert.equal(ack.request_id, world.events('request.received')[0].request_id)
    assert.equal(ack.data.interaction_intent, 'new_goal')
    assert.match(ack.data.chat_message, /^Heard you\. I will start on: "Can you get steam power going/)
    assert.equal(ack.data.world_claim, false)
    assert.ok(Number.isFinite(ack.data.latency_ms))
    assert.ok(ack.data.latency_ms < SLOW_PLANNER_MS, `acknowledged in ${ack.data.latency_ms} ms, before the ${SLOW_PLANNER_MS} ms planner round answered`)

    // Ordered: received, acknowledged, then the planner's rounds.
    const names = world.trace.map(record => record.event)
    assert.ok(names.indexOf('chat.acknowledged') === names.indexOf('request.received') + 1)
    assert.ok(names.indexOf('chat.acknowledged') < names.indexOf('provider.response'))
    // The supervisor prints from the activity stream, and that stream carries
    // the line before the first provider round even starts.
    const activityNames = world.activity.map(item => item.event)
    assert.ok(activityNames.indexOf('chat.acknowledged') < activityNames.indexOf('provider.response'))
    const ackAt = world.activity.find(item => item.event === 'chat.acknowledged').at
    const firstPlannerAt = world.activity.find(item => item.event === 'provider.response').at
    assert.ok(firstPlannerAt - ackAt >= SLOW_PLANNER_MS - 20, 'the acknowledgement did not wait for the planner')
  })
}

test('no acknowledgement for continuations, later rounds, recovery runs or routes that answer at once', async () => {
  const world = slowPlannerHarness({ transport: 'message' })
  await world.request()
  await world.closeStep1()
  await world.failSupplyBatch().catch(() => undefined)
  assert.equal(world.events('chat.acknowledged').length, 1, 'completion and failure continuations of the same request stay quiet')
  assert.ok(world.events('provider.response').length > 2)

  // Routes that reply immediately never reach the planner: no ack.
  const status = slowPlannerHarness({ transport: 'message', routedIntent: () => 'status_query' })
  const result = await status.request()
  assert.equal(result.routedOnly, true)
  assert.equal(status.events('chat.acknowledged').length, 0)
})

test('the supervisor prints the acknowledgement once and keeps it in the console conversation', async () => {
  const printed = []
  const conversation = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    npcName: 'SGLuna',
    printChat: async line => { printed.push(line) },
    appendUiConversation: (role, sender, text) => { conversation.push([role, sender, text]) },
    log: () => {},
    responsiveness: new ResponsivenessTracker(),
    agent: { traceRequest: { id: 'req_1' } },
    agentLive: { debug: {}, activity: [], conversation: [] },
    activityEpoch: 'e',
    activitySequence: 0,
    requestTaskBoardUiSync: () => {},
    agentSpendDebugFields: () => undefined,
    agentTimeDebugFields: () => undefined,
    config: {},
  })
  session.onAgentActivity('request.received', { sender: 'TTLouis', text: 'go', intake_ms: 40 })
  session.onAgentActivity('chat.acknowledged', { chat_message: 'Heard you. I will start on: "go". I will share the plan once it is worked out.', latency_ms: 60 })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(printed, ['Heard you. I will start on: "go". I will share the plan once it is worked out.'])
  assert.ok(conversation.some(([role, , text]) => role === 'assistant' && text.startsWith('Heard you.')))
  assert.match(session.agentLive.debug.responsiveness, /^first chat \d+\.\d s \(acknowledged\) · first action none yet$/)
})

test('metrics: first chat line and first admitted action per request, from a fixture trace', () => {
  const at = seconds => new Date(Date.parse('2026-09-28T10:00:00Z') + seconds * 1000).toISOString()
  const row = (seconds, id, event, data = {}) => ({ ts: at(seconds), request_id: id, event, data })
  const rows = [
    // Request A: acknowledged 2.4 s after the player spoke (0.4 s of it was
    // the Jev route call), planner answers at 99 s, first action at 101 s.
    row(0.4, 'req_a', 'request.received', { interaction_intent: 'new_goal', intake_ms: 400 }),
    row(0.5, 'req_a', 'chat.acknowledged', { chat_message: 'Heard you.', latency_ms: 500 }),
    row(99, 'req_a', 'provider.response', { latency_ms: 98000 }),
    row(99.4, 'req_a', 'plan.accepted', { chat_message: 'Plan is ready.' }),
    row(101, 'req_a', 'operations.ack', {}),
    row(150, 'req_a', 'operations.ack', {}),
    row(160, 'req_a', 'request.completed', { outcome: 'done', chat_message: 'Done.' }),
    // Request B: an old-style request with no acknowledgement; the planner's
    // own line is the first chat the player sees.
    row(200, 'req_b', 'request.received', { interaction_intent: 'continue_current' }),
    row(230, 'req_b', 'plan.accepted', { chat_message: 'Continuing.' }),
    row(232, 'req_b', 'operations.ack', {}),
    // Request C: never chatted, never acted.
    row(300, 'req_c', 'request.received', { interaction_intent: 'new_goal' }),
    row(310, 'req_c', 'request.failed', { message: 'provider down' }),
  ]
  const byRequest = responsivenessByRequest(rows)
  assert.deepEqual(byRequest.get('req_a'), {
    request_id: 'req_a',
    first_chat_ms: 500, // 0.1 s after request.received plus the 0.4 s the route took before it
    first_chat_source: 'acknowledgement',
    acknowledged_ms: 500,
    first_planner_chat_ms: 99_400,
    first_action_ms: 101_000,
  })
  assert.equal(byRequest.get('req_b').first_chat_ms, 30_000)
  assert.equal(byRequest.get('req_b').first_chat_source, 'plan.accepted')
  assert.equal(byRequest.get('req_b').first_action_ms, 32_000)
  assert.equal(byRequest.get('req_b').acknowledged_ms, undefined)
  assert.equal(byRequest.get('req_c').first_chat_ms, undefined)
  assert.equal(byRequest.get('req_c').first_action_ms, undefined)

  const record = buildRunRecord(rows)
  assert.deepEqual(record.responsiveness, {
    requests: 3,
    acknowledged: 1,
    p50_first_chat_ms: 500,
    max_first_chat_ms: 30_000,
    p50_first_action_ms: 32_000,
    max_first_action_ms: 101_000,
  })
  assert.equal(record.by_request.find(item => item.request_id === 'req_a').responsiveness.first_action_ms, 101_000)
  const text = formatRunRecord(record)
  assert.match(text, /Player-felt responsiveness \(2\.10\)/)
  assert.match(text, /requests: 3 · acknowledged: 1 · first chat p50 0\.5s max 30s · first action p50 32s max 101s/)
  assert.match(text, /req_a: first chat 0\.5s \(acknowledgement\) · first planner chat 99\.4s · first action 101s/)
})

test('metrics: the slow-planner replay puts the acknowledgement long before the first action, in the run record', async () => {
  const world = slowPlannerHarness({ transport: 'message' })
  await world.request()
  await world.closeStep1()
  const record = buildRunRecord(world.trace)
  const [request] = record.by_request
  assert.equal(request.responsiveness.first_chat_source, 'acknowledgement')
  assert.ok(request.responsiveness.first_chat_ms < SLOW_PLANNER_MS)
  assert.ok(request.responsiveness.first_planner_chat_ms >= SLOW_PLANNER_MS, 'the planner line waited for the slow round')
  assert.ok(request.responsiveness.first_action_ms >= SLOW_PLANNER_MS)
  assert.ok(request.responsiveness.first_action_ms > request.responsiveness.first_chat_ms)
})

test('the Debug window text shows both timings live', () => {
  const tracker = new ResponsivenessTracker()
  tracker.observe('request.received', { intake_ms: 1500 }, { requestId: 'req_1', ts: 10_000 })
  assert.equal(tracker.debugText('req_1'), 'first chat none yet · first action none yet')
  tracker.observe('chat.acknowledged', { latency_ms: 1600 }, { requestId: 'req_1', ts: 10_100 })
  assert.equal(tracker.debugText('req_1'), 'first chat 1.6 s (acknowledged) · first action none yet')
  tracker.observe('operations.ack', {}, { requestId: 'req_1', ts: 106_500 })
  assert.equal(tracker.debugText('req_1'), 'first chat 1.6 s (acknowledged) · first action 1.6 min')
  const debug = liveAgentDebugEvent('provider.response', { latency_ms: 10 }, {}, { responsiveness: 'first chat 1.6 s (acknowledged) · first action 1.6 min' })
  assert.equal(debug.responsiveness, 'first chat 1.6 s (acknowledged) · first action 1.6 min')
  assert.equal(liveAgentDebugEvent('provider.response', { latency_ms: 10 }, {}, {}).responsiveness, '')
})

test('a supervisor recovery run (runtime restart) never gets an acknowledgement', async () => {
  const world = slowPlannerHarness({ transport: 'message' })
  await world.request()
  assert.equal(world.events('chat.acknowledged').length, 1)
  const recovery = await recoverInterruptedAgentPlan(world.agent, 'runtime_restart', { restart: 1 }).catch(error => ({ error }))
  const started = world.events('runtime.recovery_started')
  assert.equal(started.length, 1, `the recovery run started (${recovery.error?.message ?? 'ok'})`)
  assert.match(started[0].request_id, /^recovery_/)
  assert.equal(world.events('chat.acknowledged').length, 1, 'only the player request was acknowledged')
})
