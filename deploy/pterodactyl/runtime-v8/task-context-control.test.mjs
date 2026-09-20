import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { executeUiControl, finalizeCompletedTaskBoundary, parseUiControlLine, Session } from './supervisor.mjs'

function activePlan(goalId, objective) {
  return {
    goal_id: goalId,
    owner: 'TTLouis',
    objective,
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['Do the current step'],
    current_step: 0,
    revision: 1,
    last_chat_message: 'Working.',
    last_operations: [],
    updated_at: Date.now(),
    history: [],
  }
}

function seedContext(memory, key, goalId, objective) {
  memory.remember(key, 1, {
    sender: 'TTLouis',
    user: `remember ${objective}`,
    assistant: 'I remember this task.',
    operations: [],
  })
  memory.planByNpc.set(key, activePlan(goalId, objective))
}

function persistentAgent(stateFile, memory = new CanonicalTaskBoardMemory()) {
  return new NpcAgentLoop({
    rcon: { command: async () => '' },
    provider: async () => { throw new Error('provider should not run in context reset test') },
    systemPrompt: 'NPC task context control test',
    stateFile,
    traceFile: null,
    memory,
    npcId: 'airi',
  })
}

function controlSession(agent, order = []) {
  const commands = []
  const chats = []
  const originalCancel = agent.cancel.bind(agent)
  agent.cancel = reason => {
    order.push(`abort:${reason}`)
    return originalCancel(reason)
  }
  const originalPersist = agent.persistState.bind(agent)
  agent.persistState = async () => {
    order.push('persist')
    return originalPersist()
  }
  const syncs = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    npcId: 'airi',
    npcName: 'AIRI',
    activityEpoch: 'test',
    conversationGeneration: 2,
    conversationSequence: 2,
    agent,
    commands,
    chats,
    syncs,
    agentLive: {
      phase: 'thinking',
      detail: 'waiting on provider',
      objective: 'old task',
      at: Date.now(),
      activity: [{ kind: 'note', text: 'old live state' }],
      conversation_id: 'task_test_2',
      conversation: [
        { id: 'message_test_2_1', role: 'user', sender: 'TTLouis', text: 'old task' },
        { id: 'message_test_2_2', role: 'assistant', sender: 'AIRI', text: 'Working.' },
      ],
      debug: {},
    },
    ensureAuthorization: async () => ({ allowed: true }),
    currentPlanState: () => agent.memory?.currentPlan?.('npc:airi'),
    rcon: {
      command: async command => {
        commands.push(command)
        if (command.includes('stop_follow_player')) order.push('world:stop_follow')
        if (command.includes('airi_deployment')) order.push('world:cancel')
        return ''
      },
    },
    syncTaskBoardUi: async next => { order.push('ui:sync'); syncs.push(next); return true },
    clearTaskBoardUi: async () => { order.push('ui:clear'); commands.push('CLEAR_UI'); return true },
    printChat: async text => { chats.push(text) },
  })
  return session
}

test('verified completion archives the completed stages before resetting the live prompt pipeline', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-ui-completion-boundary-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'npc-state.json')
  const memory = new CanonicalTaskBoardMemory()
  seedContext(memory, 'npc:airi', 'goal_complete', 'completed task')
  const agent = persistentAgent(stateFile, memory)
  agent.active = true
  agent.requestInfo = { memoryKey: 'npc:airi', sender: 'TTLouis', text: 'completed task', turnId: 1 }
  agent.messages = [{ role: 'user', content: 'old provider context' }]
  agent.baseMessages = [{ role: 'system', content: 'old system context' }]
  await agent.persistState()

  const order = []
  const session = controlSession(agent, order)
  session.agentLive.objective = 'completed task'
  const completedBoard = {
    kind: 'task_board_lite',
    goal_id: 'goal_complete',
    status: 'completed',
    blocker: '',
    pause_reason: '',
    revision: 4,
    completed_count: 2,
    total_steps: 2,
    active_index: 1,
    active_step_id: undefined,
    steps: [
      { id: 'step_1', description: 'Do work', status: 'completed' },
      { id: 'step_2', description: 'Verify work', status: 'completed' },
    ],
    evidence: [],
    events: [],
  }

  const finalized = await finalizeCompletedTaskBoundary(session, {
    goalId: 'goal_complete',
    goalStatus: 'completed',
    chatMessage: 'Done and verified.',
    taskBoard: completedBoard,
  })

  assert.equal(finalized, true)
  assert.deepEqual(order, ['ui:sync', 'persist', 'ui:clear'])
  assert.equal(session.syncs.length, 1)
  assert.equal(session.syncs[0].task_board.status, 'completed')
  assert.deepEqual(session.syncs[0].task_board.steps.map(step => step.status), ['completed', 'completed'])
  const resetContext = memory.context('npc:airi')
  assert.match(resetContext, /\[RUNTIME_COMPAT_STATE\] No active compatibility task/)
  assert.doesNotMatch(resetContext, /\[PLANNING_STATE\]/)
  assert.doesNotMatch(resetContext, /completed task|I remember this task/i)
  assert.equal(memory.currentPlan('npc:airi'), undefined)
  assert.equal(agent.active, false)
  assert.deepEqual(agent.messages, [])
  assert.deepEqual(agent.baseMessages, [])
  assert.equal(session.agentLive.conversation_id, 'task_test_3')
  assert.deepEqual(session.agentLive.conversation, [])
  assert.equal(session.commands.includes('CLEAR_UI'), true)
})

test('UI control parser accepts server-authoritative new_task and still rejects arbitrary actions', () => {
  const event = parseUiControlLine('[AIRI_UI_CONTROL] {"version":1,"action":"new_task","player_index":7,"player_name":"TTLouis","tick":900}')
  assert.deepEqual(event, { version: 1, action: 'new_task', player_index: 7, player_name: 'TTLouis', tick: 900 })
  assert.equal(parseUiControlLine('[AIRI_UI_CONTROL] {"version":1,"action":"clear_memory","player_index":7,"player_name":"TTLouis","tick":900}'), undefined)
})

test('terminate aborts world work and durable goal while clearing the Current Task Conversation', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-ui-terminate-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'npc-state.json')
  const memory = new CanonicalTaskBoardMemory()
  seedContext(memory, 'npc:airi', 'goal_terminate', 'old terminate task')
  const agent = persistentAgent(stateFile, memory)
  await agent.persistState()

  const order = []
  const originalTerminate = memory.terminatePlan.bind(memory)
  memory.terminatePlan = key => {
    order.push(`memory:terminate:${key}`)
    return originalTerminate(key)
  }
  const session = controlSession(agent, order)

  await executeUiControl(session, { action: 'terminate', player_name: 'TTLouis' })

  assert.deepEqual(order, [
    'abort:ui_terminate',
    'world:stop_follow',
    'world:cancel',
    'memory:terminate:npc:airi',
    'persist',
    'ui:clear',
  ])
  assert.equal(memory.currentPlan('npc:airi'), undefined)
  assert.match(memory.context('npc:airi'), /remember old terminate task/)
  assert.equal(session.agentLive.phase, 'idle')
  assert.equal(session.agentLive.objective, '')
  assert.deepEqual(session.agentLive.activity, [])
  assert.equal(session.agentLive.conversation_id, 'task_test_3')
  assert.deepEqual(session.agentLive.conversation, [])
  assert.equal(session.commands.includes('CLEAR_UI'), true)
  assert.deepEqual(session.syncs, [])

  const restarted = persistentAgent(stateFile)
  await restarted.loadPersistentState()
  assert.equal(restarted.memory.currentPlan('npc:airi'), undefined, 'terminated goal must not recover after server restart')
  assert.match(restarted.memory.context('npc:airi'), /remember old terminate task/, 'terminate preserves bounded dialogue memory')
})

test('new task clears only the target NPC dialogue and durable plan after cancelling active work', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-ui-new-task-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'npc-state.json')
  const memory = new CanonicalTaskBoardMemory()
  seedContext(memory, 'npc:airi', 'goal_airi', 'AIRI old context')
  seedContext(memory, 'npc:other', 'goal_other', 'other NPC context')
  const agent = persistentAgent(stateFile, memory)
  await agent.persistState()

  const order = []
  const originalClear = memory.clearTaskContext.bind(memory)
  memory.clearTaskContext = key => {
    order.push(`memory:clear:${key}`)
    return originalClear(key)
  }
  const session = controlSession(agent, order)

  await executeUiControl(session, { action: 'new_task', player_name: 'TTLouis' })

  assert.deepEqual(order, [
    'abort:ui_new_task',
    'world:stop_follow',
    'world:cancel',
    'memory:clear:npc:airi',
    'persist',
    'ui:clear',
  ])
  assert.equal(memory.currentPlan('npc:airi'), undefined)
  assert.equal(memory.byNpc.has('npc:airi'), false)
  assert.doesNotMatch(memory.context('npc:airi'), /remember AIRI old context/)
  assert.equal(memory.currentPlan('npc:other')?.goal_id, 'goal_other')
  assert.match(memory.context('npc:other'), /remember other NPC context/)
  assert.equal(session.agentLive.conversation_id, 'task_test_3')
  assert.deepEqual(session.agentLive.conversation, [])

  const restarted = persistentAgent(stateFile)
  await restarted.loadPersistentState()
  assert.equal(restarted.memory.currentPlan('npc:airi'), undefined)
  assert.equal(restarted.memory.byNpc.has('npc:airi'), false)
  assert.doesNotMatch(restarted.memory.context('npc:airi'), /remember AIRI old context/)
  assert.equal(restarted.memory.currentPlan('npc:other')?.goal_id, 'goal_other')
  assert.match(restarted.memory.context('npc:other'), /remember other NPC context/)
})
