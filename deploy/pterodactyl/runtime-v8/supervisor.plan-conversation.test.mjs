import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { liveAgentEvent, Session } from './supervisor.mjs'

test('plan.accepted retains each non-empty public decision in the current task conversation', () => {
  const initial = liveAgentEvent('plan.accepted', { chat_message: 'I will bootstrap coal first.', trigger_source: 'request' })
  assert.deepEqual(initial.activity, { kind: 'decision', text: 'I will bootstrap coal first.' })
  const replan = liveAgentEvent('plan.accepted', { chat_message: 'I will use the east patch.', trigger_source: 'failure' })
  assert.deepEqual(replan.activity, { kind: 'decision', text: 'I will use the east patch.' })
  assert.deepEqual(
    liveAgentEvent('plan.accepted', { chat_message: 'Continuing.', trigger_source: 'continuation' }).activity,
    { kind: 'decision', text: 'Continuing.' },
  )
  assert.deepEqual(
    liveAgentEvent('plan.accepted', { chat_message: 'Checking.', trigger_source: 'completion' }).activity,
    { kind: 'decision', text: 'Checking.' },
  )
})

test('NpcAgentLoop carries the trigger source on plan.accepted', () => {
  const source = readFileSync(new URL('./npc-agent-loop.mjs', import.meta.url), 'utf8')
  const accepted = source.split("await this.traceEvent('plan.accepted'")[1]?.split('})')[0] ?? ''
  assert.match(source, /const triggerSource = this\.reasoningTriggerSource \?\? this\.planUpdateReason/)
  assert.match(accepted, /trigger_source: triggerSource/)
  assert.match(accepted, /chat_message: plan\.chatMessage/)
})


test('same-goal routed follow-ups stay in one Current Task Conversation while true new_goal starts another', () => {
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    activityEpoch: 'router',
    activitySequence: 0,
    conversationGeneration: 3,
    conversationSequence: 1,
    npcName: 'SGLuna',
    config: { model: 'test' },
    lastStatus: {},
    agent: { traceRequest: null, epoch: null, continuations: 0 },
    agentLive: {
      phase: 'executing',
      detail: 'placing',
      objective: 'build iron',
      at: Date.now(),
      activity: [],
      conversation_id: 'task_router_3',
      conversation: [{ id: 'old', role: 'user', sender: 'tester', text: 'build iron' }],
      debug: {},
    },
    requestTaskBoardUiSync: () => {},
  })

  session.onAgentActivity('interaction.routed', {
    intent: 'status_query',
    sender: 'tester',
    text: '给我汇报一下',
  })
  session.onAgentActivity('interaction.routed', {
    intent: 'amend_current',
    sender: 'tester',
    text: '继续，但不要管周围了',
  })

  assert.equal(session.agentLive.conversation_id, 'task_router_3')
  assert.deepEqual(session.agentLive.conversation.map(entry => entry.text), [
    'build iron',
    '给我汇报一下',
    '继续，但不要管周围了',
  ])

  session.onAgentActivity('interaction.routed', {
    intent: 'new_goal',
    sender: 'tester',
    text: '改做铜板生产线',
  })

  assert.equal(session.agentLive.conversation_id, 'task_router_4')
  assert.deepEqual(session.agentLive.conversation.map(entry => entry.text), ['改做铜板生产线'])
})
