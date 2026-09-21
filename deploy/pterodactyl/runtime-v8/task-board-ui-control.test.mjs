import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcAgentLoop } from './npc-agent-loop.mjs'
import {
  deriveActivity,
  deriveWantedItems,
  evidenceText,
  executeUiControl,
  formatTaskCondition,
  liveAgentEvent,
  parseUiControlLine,
  parseUiInputBatch,
  parseUiPromptLine,
  pauseStrandedPlanAfterRequestError,
  Session,
  taskBoardUiJson,
  taskBoardUiSnapshot,
} from './supervisor.mjs'

test('agent trace events map onto live console phases', () => {
  assert.equal(liveAgentEvent('request.received', { sender: 'TTLouis', text: 'build power' }).phase, 'thinking')
  assert.equal(liveAgentEvent('request.received', { sender: 'TTLouis', text: 'build power' }).objective, 'build power')
  assert.equal(liveAgentEvent('provider.request', { round: 1 }).detail, 'Thinking (model round 2)')
  assert.deepEqual(liveAgentEvent('tool.call', { name: 'getInventory', cached: false }).activity, { kind: 'observation', text: 'Tool getInventory' })
  assert.equal(liveAgentEvent('request.waiting', { operation_count: 3 }).phase, 'waiting')
  assert.equal(liveAgentEvent('request.completed').phase, 'idle')
  assert.equal(liveAgentEvent('provider.error', { message: 'Provider request cancelled', cancelled: true }).phase, 'idle')
  assert.equal(liveAgentEvent('provider.error', { message: 'HTTP 500' }).phase, 'error')
  assert.equal(liveAgentEvent('request.failed', { message: 'Model turn was cancelled or superseded' }).phase, 'idle')
  assert.deepEqual(liveAgentEvent('factorio.status', {}), { refresh: true })
  assert.equal(liveAgentEvent('budget.reserved', {}), undefined)
})

test('agent loop forwards trace events to the activity listener even without a trace file', async () => {
  const seen = []
  const loop = Object.create(NpcAgentLoop.prototype)
  Object.assign(loop, { behaviorTrace: null, onActivity: (event, data) => seen.push([event, data]), log: () => {} })
  await loop.traceEvent('tool.call', { name: 'getInventory' })
  assert.deepEqual(seen, [['tool.call', { name: 'getInventory' }]])
})

test('every non-empty public AIRI reply is retained across continuation trigger sources', () => {
  for (const trigger_source of ['request', 'failure', 'completion', 'resume']) {
    assert.deepEqual(
      liveAgentEvent('plan.accepted', { chat_message: 'Continuing with the next verified step.', trigger_source }).activity,
      { kind: 'decision', text: 'Continuing with the next verified step.' },
    )
  }
  assert.equal(liveAgentEvent('plan.accepted', { chat_message: '', trigger_source: 'completion' }).activity, undefined)
})

test('task receipts render as readable activity lines', () => {
  assert.equal(
    evidenceText({ kind: 'operation_receipt', summary: JSON.stringify({ outcome: 'completed', batch_id: 12, task_count: 2, task_types: ['walking_to_entity', 'mining'] }) }),
    'Autorio batch 12 completed: 2 task(s) [walking_to_entity, mining]',
  )
  assert.equal(
    evidenceText({ kind: 'deterministic_verification', summary: JSON.stringify({ batch_id: 12, operations: ['gather_resource'] }) }),
    'Verified batch 12 complete (gather_resource)',
  )
  assert.equal(evidenceText({ kind: 'operation_receipt', summary: '{not json' }), '{not json')
})

test('task board projection still reports live agent work before a durable plan exists', () => {
  assert.equal(taskBoardUiSnapshot(undefined), undefined)
  assert.equal(taskBoardUiSnapshot(undefined, { phase: 'idle', detail: '', activity: [] }), undefined)
  const snapshot = taskBoardUiSnapshot(undefined, {
    phase: 'observing',
    detail: 'Checking getInventory',
    objective: 'build power',
    activity: [{ kind: 'observation', text: 'Tool getInventory' }],
  })
  assert.equal(snapshot.status, 'idle')
  assert.deepEqual(snapshot.steps, [])
  assert.equal(snapshot.objective, 'build power')
  assert.deepEqual(snapshot.agent, { phase: 'observing', detail: 'Checking getInventory' })
  assert.deepEqual(snapshot.activity, [{ kind: 'observation', text: 'Tool getInventory' }])
})

test('live agent activity is pushed to the console as coalesced ordered syncs', async () => {
  const synced = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    rcon: {},
    stopping: false,
    agent: { active: true },
    agentLive: { phase: 'idle', detail: '', objective: '', at: 0, activity: [] },
    uiSyncDirty: false,
    uiSyncRunning: null,
    syncTaskBoardUi: async () => { synced.push(session.liveAgentStatus()) },
  })
  session.onAgentActivity('request.received', { sender: 'TTLouis', text: 'build power' })
  session.onAgentActivity('provider.request', { round: 0 })
  session.onAgentActivity('tool.call', { name: 'getInventory' })
  await session.uiSyncRunning
  assert.equal(synced.length, 1)
  assert.equal(synced[0].phase, 'observing')
  assert.equal(synced[0].objective, 'build power')
  assert.equal(synced[0].activity.length, 2)

  session.agent.active = false
  session.onAgentActivity('request.waiting', { operation_count: 2 })
  await session.uiSyncRunning
  assert.equal(synced.at(-1).phase, 'idle')
})

test('UI control parser accepts fixed mod events and rejects chat spoofing or arbitrary actions', () => {
  const event = parseUiControlLine('12.3 Script @__autorio__: [AIRI_UI_CONTROL] {"version":1,"action":"follow","player_index":7,"player_name":"TTLouis","tick":900}')
  assert.deepEqual(event, { version: 1, action: 'follow', player_index: 7, player_name: 'TTLouis', tick: 900 })
  assert.equal(parseUiControlLine('2026-09-15 [CHAT] Eve: [AIRI_UI_CONTROL] {"version":1,"action":"terminate","player_index":7,"player_name":"TTLouis","tick":900}'), undefined)
  assert.equal(parseUiControlLine('[AIRI_UI_CONTROL] {"version":1,"action":"rcon","player_index":7,"player_name":"TTLouis","tick":900}'), undefined)
  assert.equal(parseUiControlLine('[AIRI_UI_CONTROL] {"version":1,"action":"pause","player_index":7,"player_name":"TTLouis","tick":900,"command":"/quit"}'), undefined)
})

test('UI prompt parser accepts bounded structured prompts and rejects chat spoofing or extra command fields', () => {
  const event = parseUiPromptLine('12.3 Script @__autorio__: [AIRI_UI_PROMPT] {"version":1,"player_index":7,"player_name":"TTLouis","text":"build a steam power block","tick":901}')
  assert.deepEqual(event, { version: 1, player_index: 7, player_name: 'TTLouis', text: 'build a steam power block', tick: 901 })
  assert.equal(parseUiPromptLine('2026-09-15 [CHAT] Eve: [AIRI_UI_PROMPT] {"version":1,"player_index":7,"player_name":"TTLouis","text":"/quit","tick":901}'), undefined)
  assert.equal(parseUiPromptLine('[AIRI_UI_PROMPT] {"version":1,"player_index":7,"player_name":"TTLouis","text":"mine stone","tick":901,"command":"/quit"}'), undefined)
  assert.equal(parseUiPromptLine('[AIRI_UI_PROMPT] {"version":1,"player_index":7,"player_name":"TTLouis","text":"","tick":901}'), undefined)
  assert.equal(parseUiPromptLine(`[AIRI_UI_PROMPT] ${JSON.stringify({ version: 1, player_index: 7, player_name: 'TTLouis', text: 'x'.repeat(4001), tick: 901 })}`), undefined)
})

test('UI controls reuse the AIRI chat allowlist before queueing runtime work', () => {
  const queued = []
  const logs = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    ready: true,
    stopping: false,
    agent: { active: false, cancel: () => {} },
    config: { chatPlayers: { mode: 'allowlist', names: ['TTLouis'] } },
    queueEvent: fn => { queued.push(fn) },
    log: message => logs.push(message),
  })
  session.onGameLine('[AIRI_UI_CONTROL] {"version":1,"action":"pause","player_index":2,"player_name":"Eve","tick":20}')
  assert.equal(queued.length, 0)
  assert.match(logs[0], /unauthorized/i)
  session.onGameLine('[AIRI_UI_CONTROL] {"version":1,"action":"pause","player_index":1,"player_name":"TTLouis","tick":21}')
  assert.equal(queued.length, 1)
})

test('UI prompts reuse the AIRI chat allowlist before entering the request queue', () => {
  const requests = []
  const logs = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    ready: true,
    stopping: false,
    agent: { active: false, cancel: () => {} },
    npcName: 'Nova-1',
    config: { chatPlayers: { mode: 'allowlist', names: ['TTLouis'] } },
    queuePlayerRequest: (sender, text) => { requests.push({ sender, text }); return true },
    log: message => logs.push(message),
  })
  session.onGameLine('[AIRI_UI_PROMPT] {"version":1,"player_index":2,"player_name":"Eve","text":"build power","tick":30}')
  assert.equal(requests.length, 0)
  assert.match(logs[0], /unauthorized/i)
  session.onGameLine('[AIRI_UI_PROMPT] {"version":1,"player_index":1,"player_name":"TTLouis","text":"build power","tick":31}')
  assert.deepEqual(requests, [{ sender: 'TTLouis', text: 'build power' }])
})

test('wanted items are derived only from concrete approved operations', () => {
  assert.deepEqual(deriveWantedItems({
    last_operations: [
      'place_entity {"entity_name":"assembling-machine-1","x":10,"y":20}',
      'craft_item {"item_name":"boiler","count":2}',
      'move_items {"item_name":"iron-plate","entity_name":"iron-chest","max_count":50,"to_entity":false}',
      'move_items_with_player {"item_name":"copper-plate","player_name":"TTLouis","max_count":20,"to_player":false}',
      'mine_entity {"entity_name":"iron-ore","count":100}',
      'research_technology {"technology_name":"automation"}',
    ],
  }), [
    { name: 'assembling-machine-1', count: 1, reason: 'planned placement' },
    { name: 'boiler', count: 2, reason: 'planned craft' },
    { name: 'iron-plate', count: 50, reason: 'planned pickup' },
    { name: 'copper-plate', count: 20, reason: 'requested from player' },
  ])
})

test('activity is an auditable summary rather than hidden model reasoning', () => {
  assert.deepEqual(deriveActivity({
    last_chat_message: 'I will build the power block next.',
    last_operations: ['place_entity {"entity_name":"boiler"}'],
    blocker: '', pause_reason: '',
    task_board: { evidence: [{ kind: 'operation_receipt', summary: 'Previous mining batch completed.' }] },
  }), [
    { kind: 'result', text: 'Previous mining batch completed.' },
    { kind: 'decision', text: 'I will build the power block next.' },
    { kind: 'action', text: 'place_entity {"entity_name":"boiler"}' },
  ])
})

test('task blocker presentation is human-readable without changing authoritative blocker codes', () => {
  const raw = 'no_autorio_operation_for_remaining_plan'
  const summary = 'AIRI has more work planned, but did not start the next action.'
  assert.deepEqual(formatTaskCondition(raw), { raw, summary })
  assert.deepEqual(formatTaskCondition('future_internal_blocker'), {
    raw: 'future_internal_blocker',
    summary: 'AIRI is blocked by an internal task condition.',
  })
  assert.deepEqual(formatTaskCondition('future_internal_pause', 'pause'), {
    raw: 'future_internal_pause',
    summary: 'AIRI is paused by an internal task condition.',
  })
  assert.deepEqual(formatTaskCondition('provider_output_budget_exhausted: finish=length', 'pause'), {
    raw: 'provider_output_budget_exhausted: finish=length',
    summary: 'AIRI paused because the model exhausted its response budget while no Autorio work was running. Continue to retry from the verified task state.',
  })
  assert.deepEqual(formatTaskCondition('request_failed: Provider HTTP 500', 'pause'), {
    raw: 'request_failed: Provider HTTP 500',
    summary: 'AIRI paused because the model request failed while no Autorio work was running. Continue to retry from the verified task state.',
  })

  const state = {
    goal_id: 'goal_blocked',
    objective: 'Build power',
    blocker: raw,
    pause_reason: '',
    last_chat_message: '',
    last_operations: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_blocked',
      status: 'blocked',
      blocker: raw,
      pause_reason: '',
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      steps: [
        { id: 'step_1', description: 'Build power', status: 'blocked' },
        { id: 'step_2', description: 'Start research', status: 'pending' },
      ],
      evidence: [],
    },
  }
  const snapshot = taskBoardUiSnapshot(state)
  assert.equal(snapshot.blocker, raw)
  assert.equal(snapshot.blocker_summary, summary)
  assert.deepEqual(snapshot.activity, [{ kind: 'blocker', text: summary }])
  assert.equal(snapshot.activity.some(entry => entry.text === raw), false)
  assert.equal(state.blocker, raw)
  assert.equal(state.task_board.blocker, raw)
})

test('one finished batch is one result line, not a receipt plus a restated verification', () => {
  const receipt = { kind: 'operation_receipt', summary: JSON.stringify({ batch_id: 1, outcome: 'completed', task_count: 1, task_types: ['placing'] }) }
  const verification = { kind: 'deterministic_verification', summary: JSON.stringify({ batch_id: 1, operations: ['place_entity'] }) }
  const unreceipted = { kind: 'deterministic_verification', summary: JSON.stringify({ batch_id: 2, operations: ['craft_item'] }) }
  // The receipt sits outside the displayed tail and still suppresses the
  // restatement, so the verification cannot surface later as a new row.
  const evidence = [receipt, { kind: 'note', summary: 'a' }, { kind: 'note', summary: 'b' }, { kind: 'note', summary: 'c' }, verification, unreceipted]
  assert.deepEqual(deriveActivity({ last_chat_message: '', last_operations: [], blocker: '', pause_reason: '', task_board: { evidence } }).map(entry => entry.text), [
    'b',
    'c',
    'Verified batch 2 complete (craft_item)',
  ])
})

test('an exhausted provider recovery is reported once, by the failed request', () => {
  const state = { last_chat_message: '', last_operations: [], blocker: '', task_board: { evidence: [] } }
  assert.deepEqual(deriveActivity({ ...state, pause_reason: 'provider_recovery_exhausted: Provider response recovery exhausted after 3 attempts: Invalid provider content JSON' }), [])
  assert.deepEqual(deriveActivity({ ...state, pause_reason: 'player_requested' }), [{ kind: 'system', text: 'AIRI was paused by the player.' }])
})

test('the live batch-completed line gives way to the receipt only when a plan carries receipts', () => {
  const completed = { ...liveAgentEvent('factorio.completed_signal').activity, id: 'live_x_1' }
  const tool = { kind: 'observation', text: 'Tool getActorStatus', id: 'live_x_2' }
  const live = { phase: 'thinking', detail: '', activity: [completed, tool] }
  const planned = taskBoardUiSnapshot({
    goal_id: 'goal_1', objective: 'Build power', blocker: '', pause_reason: '', last_chat_message: '', last_operations: [],
    task_board: {
      kind: 'task_board_lite', goal_id: 'goal_1', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 1, active_index: 0, steps: [{ id: 'step_1', description: 'Build boiler', status: 'active' }], evidence: [],
    },
  }, live)
  assert.deepEqual(planned.activity, [tool])
  const planless = taskBoardUiSnapshot(undefined, live)
  assert.deepEqual(planless.activity, [{ kind: 'result', text: 'Autorio batch completed', id: 'live_x_1' }, tool])
})

test('task board projection carries canonical steps plus activity and wanted items', () => {
  const snapshot = taskBoardUiSnapshot({
    goal_id: 'goal_1', objective: 'Build power', blocker: '', pause_reason: '',
    last_chat_message: 'Building a boiler.', last_operations: ['craft_item {"item_name":"boiler","count":1}'],
    task_board: {
      kind: 'task_board_lite', goal_id: 'goal_1', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 1, active_index: 0,
      steps: [{ id: 'step_1', description: 'Build boiler', status: 'active' }], evidence: [],
    },
  })
  assert.equal(snapshot.activity.at(-1).kind, 'action')
  assert.deepEqual(snapshot.wanted_items, [{ name: 'boiler', count: 1, reason: 'planned craft' }])
})

test('the activity feed keeps more history than the console used to be able to show', () => {
  const live = Array.from({ length: 30 }, (_, index) => ({ kind: 'note', text: `live ${index}` }))
  const snapshot = taskBoardUiSnapshot({
    goal_id: 'goal_1', objective: 'Build power', blocker: '', pause_reason: '',
    last_chat_message: '', last_operations: [],
    task_board: {
      kind: 'task_board_lite', goal_id: 'goal_1', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 1, active_index: 0,
      steps: [{ id: 'step_1', description: 'Build boiler', status: 'active' }], evidence: [],
    },
  }, { phase: 'idle', detail: '', activity: live })
  // The console now sizes its activity pane from the player's display and hands
  // it whatever the plan tracker does not need, so the feed is no longer capped
  // at the twelve entries the old fixed pane could fit.
  assert.equal(snapshot.activity.length, 18)
  assert.equal(snapshot.activity.at(-1).text, 'live 29')
})

function sessionFixture({ state = { status: 'active' } } = {}) {
  const commands = []
  const chats = []
  const syncs = []
  const agent = {
    active: true,
    memory: { terminatePlan: () => state },
    activePlanKey: () => 'npc:airi',
    loadPersistentState: async () => {},
    persistState: async () => {},
    cancel: reason => { agent.cancelReason = reason },
    pausePersistentPlan: async reason => ({ ...state, status: 'paused', pause_reason: reason }),
  }
  return {
    npcId: 'airi', agent, commands, chats, syncs,
    rcon: { command: async command => { commands.push(command); return '' } },
    ensureAuthorization: async () => ({ allowed: true }),
    currentPlanState: () => state,
    syncTaskBoardUi: async next => { syncs.push(next); return true },
    clearTaskBoardUi: async () => { commands.push('CLEAR_UI'); return true },
    printChat: async text => { chats.push(text) },
  }
}

test('failed request pauses an otherwise-active task only when Autorio is authoritatively idle', async () => {
  const idleState = { status: 'active', goal_id: 'goal_idle' }
  const idle = sessionFixture({ state: idleState })
  const pausedReasons = []
  idle.agent.readInteractionTaskStatus = async () => ({ task_state: 'idle', queue_length: 0 })
  idle.agent.pausePersistentPlan = async reason => {
    pausedReasons.push(reason)
    return { ...idleState, status: 'paused', pause_reason: reason }
  }

  const paused = await pauseStrandedPlanAfterRequestError(idle, 'provider_output_budget_exhausted · finish=length')
  assert.equal(paused.status, 'paused')
  assert.match(pausedReasons[0], /^provider_output_budget_exhausted:/)
  assert.equal(idle.syncs.length, 1)
  assert.equal(idle.syncs[0].status, 'paused')

  const busyState = { status: 'active', goal_id: 'goal_busy' }
  const busy = sessionFixture({ state: busyState })
  let busyPaused = false
  busy.agent.readInteractionTaskStatus = async () => ({ task_state: 'placing', queue_length: 2 })
  busy.agent.pausePersistentPlan = async () => { busyPaused = true; return { ...busyState, status: 'paused' } }

  const untouched = await pauseStrandedPlanAfterRequestError(busy, 'Provider HTTP 500')
  assert.equal(untouched, undefined)
  assert.equal(busyPaused, false)
  assert.equal(busy.syncs.length, 0)
})

test('pause preserves plan and stops autorio work plus follow mode', async () => {
  const session = sessionFixture()
  await executeUiControl(session, { action: 'pause', player_name: 'TTLouis' })
  assert.equal(session.syncs[0].status, 'paused')
  assert.ok(session.commands.some(command => command.includes('airi_deployment')))
  assert.ok(session.commands.some(command => command.includes('stop_follow_player')))
})

test('blocked-plan controls preserve the frozen plan and require a later explicit revision or termination', async () => {
  const state = { status: 'blocked', goal_id: 'goal_blocked', task_board: { status: 'blocked' } }
  const session = sessionFixture({ state })
  let paused = false
  session.agent.pausePersistentPlan = async () => { paused = true; return { ...state, status: 'paused' } }

  assert.equal(await executeUiControl(session, { action: 'keep_paused', player_name: 'TTLouis' }), true)
  assert.equal(session.syncs.at(-1), state)
  assert.equal(paused, false)
  assert.match(session.chats.at(-1), /No replanning or world work/i)

  assert.equal(await executeUiControl(session, { action: 'revise', player_name: 'TTLouis' }), true)
  assert.equal(session.syncs.at(-1), state)
  assert.match(session.chats.at(-1), /revised goal or constraints/i)

  assert.equal(await executeUiControl(session, { action: 'cancel', player_name: 'TTLouis' }), true)
  assert.equal(session.syncs.at(-1), state)
  assert.match(session.chats.at(-1), /confirm TERMINATE/i)
  assert.equal(paused, false)
})

test('blocked-plan controls reject a state that is no longer blocked', async () => {
  const session = sessionFixture({ state: { status: 'active', goal_id: 'goal_active' } })
  assert.equal(await executeUiControl(session, { action: 'keep_paused', player_name: 'TTLouis' }), false)
  assert.equal(await executeUiControl(session, { action: 'revise', player_name: 'TTLouis' }), false)
  assert.equal(await executeUiControl(session, { action: 'cancel', player_name: 'TTLouis' }), false)
  assert.equal(session.syncs.length, 0)
})

test('terminate discards durable state, stops work, and clears the Current Task Conversation UI', async () => {
  const session = sessionFixture()
  let terminated = false
  session.agent.memory.terminatePlan = () => { terminated = true; return { status: 'active' } }
  await executeUiControl(session, { action: 'terminate', player_name: 'TTLouis' })
  assert.equal(terminated, true)
  assert.equal(session.agent.cancelReason, 'ui_terminate')
  assert.equal(session.commands.includes('CLEAR_UI'), true)
  assert.deepEqual(session.syncs, [])
})

test('follow pauses the active plan, cancels old work, and directly enables follow', async () => {
  const session = sessionFixture()
  await executeUiControl(session, { action: 'follow', player_name: 'TTLouis' })
  assert.equal(session.syncs[0].status, 'paused')
  const followIndex = session.commands.findIndex(command => command.includes('"follow_player",'))
  const cancelIndex = session.commands.findIndex(command => command.includes('airi_deployment'))
  assert.ok(cancelIndex >= 0 && followIndex > cancelIndex)
  assert.ok(session.commands[followIndex].includes('TTLouis'))
})

test('stop follow leaves the durable plan paused', async () => {
  const session = sessionFixture({ state: { status: 'paused' } })
  let paused = false
  session.agent.pausePersistentPlan = async () => { paused = true }
  await executeUiControl(session, { action: 'stop_follow', player_name: 'TTLouis' })
  assert.equal(paused, false)
  assert.equal(session.syncs.length, 0)
})

test('post-load NPC reconciliation is issued as a single replicated RCON command', async () => {
  const commands = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    rcon: { command: async (text) => { commands.push(text); return '' } },
    log: () => {},
  })

  assert.equal(await session.reconcileNpcAfterLoad(), true)
  // Factorio replicates this to every peer as one input action, unlike the
  // per-peer script.on_load path that desynced joining clients.
  assert.deepEqual(commands, ['/silent-command remote.call("autorio_actor","reconcile_after_load")'])
})

test('a failed post-load reconciliation is reported instead of breaking the NPC bind', async () => {
  const logs = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    rcon: { command: async () => { throw new Error('rcon closed') } },
    log: line => logs.push(line),
  })

  assert.equal(await session.reconcileNpcAfterLoad(), false)
  assert.match(logs.join('\n'), /post-load reconciliation failed/)
})

test('a console poll is accepted as an unattributed refresh request and nothing else', () => {
  const batch = parseUiInputBatch(JSON.stringify([
    { kind: 'poll', version: 1, tick: 4210 },
    { kind: 'control', version: 1, action: 'pause', player_index: 1, player_name: 'TTLouis', tick: 4211 },
  ]))
  assert.deepEqual(batch[0], { kind: 'poll', tick: 4210 })
  assert.equal(batch[1].kind, 'control')

  // A poll only causes a read plus a push, so it carries no player identity and
  // must not be able to smuggle fields the authorized handlers would trust.
  assert.deepEqual(parseUiInputBatch(JSON.stringify([{ kind: 'poll', version: 1, tick: 1, action: 'terminate' }])), [])
  assert.deepEqual(parseUiInputBatch(JSON.stringify([{ kind: 'poll', version: 1, tick: 1, player_name: 'Eve' }])), [])
  assert.deepEqual(parseUiInputBatch(JSON.stringify([{ kind: 'poll', version: 2, tick: 1 }])), [])
  assert.deepEqual(parseUiInputBatch(JSON.stringify([{ kind: 'poll', version: 1, tick: -1 }])), [])
})

test('a drained poll pushes a snapshot so SYNC keeps advancing while AIRI is idle', async () => {
  const commands = []
  const session = Object.create(Session.prototype)
  session.ready = true
  session.stopping = false
  session.uiInputPollRunning = false
  session.agent = { active: false }
  session.config = { chatPlayers: [] }
  session.rcon = {
    command: async (command) => {
      commands.push(command)
      return command.includes('drain_inputs') ? JSON.stringify([{ kind: 'poll', version: 1, tick: 600 }]) : 'true'
    },
  }
  session.agentLive = { phase: 'idle', detail: '', objective: '', at: Date.now(), activity: [] }
  session.uiSyncDirty = false
  session.uiSyncRunning = null
  session.log = () => {}
  session.currentPlanState = () => undefined

  await session.drainTaskBoardUiInputs()
  await session.uiSyncRunning

  // An unauthenticated poll must never be dropped by the player authorization
  // check that guards controls and prompts.
  const written = commands.filter(command => !command.includes('drain_inputs'))
  assert.equal(written.length, 1)
  assert.match(written[0], /autorio_task_board","clear"/)
  // The answer has to be verified: an unanswered poll is the console's only
  // evidence that the runtime died.
  assert.match(written[0], /^\/silent-command rcon\.print\(tostring\(/)
})

test('an unaccepted console write is reported instead of counted as a success', async () => {
  const logs = []
  const session = Object.create(Session.prototype)
  session.log = message => logs.push(message)

  session.rcon = { command: async () => 'Unknown interface: autorio_task_board' }
  assert.equal(await session.clearTaskBoardUi(), false)
  assert.match(logs.at(-1), /not accepted by Autorio: Unknown interface/)

  // The mod answers a rejected snapshot with `false`; that is a failure too.
  session.rcon = { command: async () => 'false' }
  assert.equal(await session.clearTaskBoardUi(), false)
  assert.match(logs.at(-1), /not accepted by Autorio: false/)

  session.rcon = { command: async () => { throw new Error('RCON socket closed') } }
  assert.equal(await session.clearTaskBoardUi(), false)
  assert.match(logs.at(-1), /failed: RCON socket closed/)

  session.rcon = { command: async () => 'true' }
  assert.equal(await session.clearTaskBoardUi(), true)

  // The console is drained four times a second, so an unchanged persistent fault
  // must be reported once rather than on every retry.
  session.rcon = { command: async () => 'false' }
  assert.equal(await session.clearTaskBoardUi(), false)
  const afterFirst = logs.length
  assert.equal(await session.clearTaskBoardUi(), false)
  assert.equal(await session.clearTaskBoardUi(), false)
  assert.equal(logs.length, afterFirst, 'a repeated identical fault stays quiet')

  // A recovery followed by a relapse is news again, not a repeat.
  session.rcon = { command: async () => 'true' }
  assert.equal(await session.clearTaskBoardUi(), true)
  session.rcon = { command: async () => 'false' }
  assert.equal(await session.clearTaskBoardUi(), false)
  assert.equal(logs.length, afterFirst + 1)
})

test('an oversized board is trimmed to fit the command path instead of being dropped', () => {
  const snapshot = {
    goal_id: 'goal_1',
    objective: 'o'.repeat(500),
    status: 'active',
    blocker: '',
    pause_reason: '',
    completed_count: 0,
    total_steps: 30,
    active_index: 0,
    steps: Array.from({ length: 30 }, (_, index) => ({ id: `step_${index + 1}`, description: 'd'.repeat(500), status: 'pending' })),
    activity: Array.from({ length: 12 }, (_, index) => ({ kind: 'note', text: `a${index} ${'x'.repeat(300)}` })),
    wanted_items: [],
  }
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 16384, 'fixture must exceed the raw command limit')

  const json = taskBoardUiJson(snapshot)
  assert.ok(json !== undefined, 'a long plan must still reach the console')
  assert.ok(Buffer.byteLength(json) <= 15360)
  const trimmed = JSON.parse(json)
  // Progress is what the console exists to show, so every step survives; only
  // scrolled-away activity and text the console truncates anyway is shortened.
  assert.equal(trimmed.steps.length, 30)
  assert.equal(trimmed.total_steps, 30)
  assert.ok(trimmed.steps[0].description.length <= 240)

  const small = { ...snapshot, steps: [], activity: [], objective: 'build power' }
  assert.equal(taskBoardUiJson(small), JSON.stringify(small), 'a small board is sent unchanged')
})

test('current UI conversation retains more than four user/assistant messages independently of activity limits', () => {
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    npcName: 'AIRI',
    activityEpoch: 'epoch',
    conversationGeneration: 0,
    conversationSequence: 0,
    agentLive: { phase: 'idle', detail: '', objective: '', at: 0, activity: [], conversation_id: 'task_epoch_0', conversation: [], debug: {} },
    requestTaskBoardUiSync: () => {},
  })
  for (let index = 1; index <= 6; index++) {
    session.onAgentActivity('request.received', { sender: 'TTLouis', text: `request ${index}` })
    session.onAgentActivity('plan.accepted', { chat_message: `answer ${index}` })
  }
  const snapshot = taskBoardUiSnapshot(undefined, session.liveAgentStatus())
  assert.equal(snapshot.conversation.length, 12)
  assert.deepEqual(snapshot.conversation.slice(0, 4).map(entry => entry.text), ['request 1', 'answer 1', 'request 2', 'answer 2'])
  assert.equal(snapshot.activity.length <= 18, true)
})

test('New Task starts a fresh UI conversation generation and old messages do not return on later syncs', async () => {
  const session = Object.assign(Object.create(Session.prototype), sessionFixture())
  Object.assign(session, {
    activityEpoch: 'epoch',
    conversationGeneration: 0,
    conversationSequence: 2,
    agentLive: {
      phase: 'idle', detail: '', objective: 'old task', at: 0, activity: [],
      conversation_id: 'task_epoch_0',
      conversation: [
        { id: 'old-1', role: 'user', sender: 'TTLouis', text: 'old request' },
        { id: 'old-2', role: 'assistant', sender: 'AIRI', text: 'old answer' },
      ],
      debug: {},
    },
    clearTaskBoardUi: async () => true,
  })
  session.agent.memory.clearTaskContext = () => ({ status: 'cleared' })
  await executeUiControl(session, { action: 'new_task', player_name: 'TTLouis' })
  assert.equal(session.agentLive.conversation.length, 0)
  assert.equal(session.agentLive.conversation_id, 'task_epoch_1')

  session.appendUiConversation('user', 'TTLouis', 'fresh request')
  session.appendUiConversation('assistant', 'AIRI', 'fresh answer')
  const first = taskBoardUiSnapshot(undefined, session.liveAgentStatus())
  const refreshed = taskBoardUiSnapshot(undefined, session.liveAgentStatus())
  assert.deepEqual(first.conversation.map(entry => entry.text), ['fresh request', 'fresh answer'])
  assert.deepEqual(refreshed.conversation.map(entry => entry.text), ['fresh request', 'fresh answer'])
  assert.equal(refreshed.conversation.some(entry => entry.text.startsWith('old ')), false)
})

test('terminate aborts provider thinking before queued cleanup starts', async () => {
  const session = Object.assign(Object.create(Session.prototype), sessionFixture())
  const queued = []
  const events = []
  session.agent.cancel = reason => { events.push(`cancel:${reason}`) }
  session.queueEvent = fn => { queued.push(fn); events.push('queued'); return true }
  session.ackTaskBoardUiLifecycle = async () => true

  session.queueUiControl({ action: 'terminate', player_index: 7, player_name: 'TTLouis' })

  assert.deepEqual(events, ['cancel:ui_terminate_immediate', 'queued'])
  assert.equal(queued.length, 1)

  await queued.shift()()
  assert.ok(events.includes('cancel:ui_terminate'))
})

test('NpcAgentLoop cancel aborts the active provider controller immediately', () => {
  const loop = Object.create(NpcAgentLoop.prototype)
  const controller = new AbortController()
  Object.assign(loop, {
    providerAbort: controller,
    traceEvent: async () => {},
    traceRequest: null,
    generation: 3,
    active: true,
    messages: [],
    baseMessages: [],
    epoch: { actor_id: 7, epoch: 3 },
    continuations: 0,
    toolCache: new Map(),
    staticPrototypeCache: new Map(),
    prototypeRefsThisRequest: [],
    duplicateToolRounds: 0,
    observationRecoveryRounds: 0,
    toolValidationRetries: 0,
    requestInfo: { sender: 'TTLouis', text: 'keep thinking' },
  })

  loop.cancel('ui_terminate_immediate')

  assert.equal(controller.signal.aborted, true)
  assert.equal(loop.active, false)
})

test('pause/terminate and resume acknowledge only after their queued runtime work settles', async () => {
  const session = Object.assign(Object.create(Session.prototype), sessionFixture())
  const queued = []
  const acknowledgements = []
  session.queueEvent = fn => { queued.push(fn); return true }
  session.ackTaskBoardUiLifecycle = async (playerIndex, action) => { acknowledgements.push([playerIndex, action]); return true }

  session.queueUiControl({ action: 'pause', player_index: 7, player_name: 'TTLouis' })
  assert.deepEqual(acknowledgements, [])
  await queued.shift()()
  assert.deepEqual(acknowledgements, [[7, 'pause']])

  session.queueUiControl({ action: 'terminate', player_index: 7, player_name: 'TTLouis' })
  assert.deepEqual(acknowledgements, [[7, 'pause']])
  await queued.shift()()
  assert.deepEqual(acknowledgements, [[7, 'pause'], [7, 'terminate']])

  let resumeOptions
  session.queuePlayerRequest = (_sender, _text, options) => { resumeOptions = options; return true }
  session.queueUiPrompt({ player_index: 7, player_name: 'TTLouis', text: 'continue' })
  assert.deepEqual(acknowledgements, [[7, 'pause'], [7, 'terminate']])
  await resumeOptions.onSettled()
  assert.deepEqual(acknowledgements, [[7, 'pause'], [7, 'terminate'], [7, 'resume']])
})

test('chat-only request boundaries retain one user/reply pair without duplicate assistant messages', async () => {
  const session = Object.create(Session.prototype)
  const queued = []
  Object.assign(session, {
    npcName: 'AIRI',
    activityEpoch: 'epoch',
    conversationGeneration: 0,
    conversationSequence: 0,
    agentLive: { phase: 'idle', detail: '', objective: '', at: 0, activity: [], conversation_id: 'task_epoch_0', conversation: [], debug: {} },
    agent: { active: true, request: async () => ({ chatMessage: 'visible answer' }) },
    rcon: {},
    stopping: false,
    queueEvent: fn => { queued.push(fn); return true },
    ensureAuthorization: async () => true,
    applyNavigationObstaclePolicy: async () => {},
    syncTaskBoardUi: async () => true,
    printChat: async () => {},
  })

  assert.equal(session.queuePlayerRequest('TTLouis', 'hello'), true)
  await queued.shift()()
  assert.deepEqual(session.agentLive.conversation.map(entry => entry.text), ['hello', 'visible answer'])
})


test('active multi-step task restores its current conversation before completion', async () => {
  const state = {
    goal_id: 'goal_active_2_of_6',
    owner: 'TTLouis',
    objective: 'Build a six-step starter factory',
    status: 'active',
    blocker: '',
    pause_reason: '',
    last_chat_message: 'I am executing step 3 while Autorio builds the power block.',
    last_operations: ['place_entity {"entity_name":"boiler"}'],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_active_2_of_6',
      status: 'active',
      blocker: '',
      pause_reason: '',
      completed_count: 2,
      total_steps: 6,
      active_index: 2,
      steps: [
        { id: 'step_1', description: 'Gather stone', status: 'completed' },
        { id: 'step_2', description: 'Craft boiler parts', status: 'completed' },
        { id: 'step_3', description: 'Build steam power', status: 'active' },
        { id: 'step_4', description: 'Build miners', status: 'pending' },
        { id: 'step_5', description: 'Build smelting', status: 'pending' },
        { id: 'step_6', description: 'Start research', status: 'pending' },
      ],
      evidence: [],
    },
  }
  const persisted = {
    goal_id: state.goal_id,
    conversation_id: 'task_previous_runtime_4',
    conversation: [
      { id: 'old_1', role: 'user', sender: 'TTLouis', text: state.objective },
      { id: 'old_2', role: 'assistant', sender: 'AIRI', text: state.last_chat_message },
    ],
  }
  const writes = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    npcName: 'AIRI',
    activityEpoch: 'restart',
    conversationGeneration: 0,
    conversationSequence: 0,
    agent: { active: true },
    agentLive: {
      phase: 'waiting',
      detail: 'Autorio is running 1 operation(s)',
      objective: state.objective,
      at: Date.now(),
      activity: [],
      conversation_id: 'task_restart_0',
      conversation: [],
      debug: { request_id: 'req_active', turn: 1, provider_model: 'test-provider' },
    },
    rcon: {
      command: async (command) => {
        assert.match(command, /autorio_task_board","status"/)
        return JSON.stringify(persisted)
      },
    },
    currentPlanState: () => state,
    writeTaskBoardUi: async (command, label) => { writes.push({ command, label }); return true },
    log: () => {},
  })

  await session.syncTaskBoardUi(state)

  assert.equal(session.agentLive.phase, 'waiting')
  assert.equal(session.agentLive.conversation_id, 'task_previous_runtime_4')
  assert.deepEqual(
    session.agentLive.conversation.map(entry => [entry.role, entry.text]),
    [
      ['user', 'Build a six-step starter factory'],
      ['assistant', 'I am executing step 3 while Autorio builds the power block.'],
    ],
  )
  assert.equal(writes.length, 1)
  assert.equal(writes[0].label, 'sync')
  assert.match(writes[0].command, /"status":"active"/)
  assert.match(writes[0].command, /"completed_count":2/)
  assert.match(writes[0].command, /"total_steps":6/)
  assert.match(writes[0].command, /"conversation_id":"task_previous_runtime_4"/)
  assert.match(writes[0].command, /"role":"user".*"text":"Build a six-step starter factory"/)
  assert.match(writes[0].command, /"role":"assistant".*"text":"I am executing step 3 while Autorio builds the power block\."/)
})

test('active task conversation falls back to canonical task state when no saved transcript is available', async () => {
  const state = {
    goal_id: 'goal_active',
    owner: 'TTLouis',
    objective: 'Keep building the starter factory',
    status: 'active',
    blocker: '',
    pause_reason: '',
    last_chat_message: 'Continuing the current build step.',
    last_operations: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_active',
      status: 'active',
      blocker: '',
      pause_reason: '',
      completed_count: 2,
      total_steps: 6,
      active_index: 2,
      steps: Array.from({ length: 6 }, (_, index) => ({
        id: `step_${index + 1}`,
        description: `Step ${index + 1}`,
        status: index < 2 ? 'completed' : index === 2 ? 'active' : 'pending',
      })),
      evidence: [],
    },
  }
  const writes = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    npcName: 'AIRI',
    activityEpoch: 'epoch',
    conversationGeneration: 0,
    conversationSequence: 0,
    agent: { active: true },
    agentLive: {
      phase: 'executing', detail: 'Executing current step', objective: state.objective, at: Date.now(),
      activity: [], conversation_id: 'task_epoch_0', conversation: [], debug: {},
    },
    rcon: { command: async () => 'null' },
    writeTaskBoardUi: async (command, label) => { writes.push({ command, label }); return true },
    log: () => {},
  })

  await session.syncTaskBoardUi(state)

  assert.deepEqual(
    session.agentLive.conversation.map(entry => [entry.role, entry.text]),
    [
      ['user', 'Keep building the starter factory'],
      ['assistant', 'Continuing the current build step.'],
    ],
  )
  assert.match(writes[0].command, /"conversation_id":"task_epoch_0"/)
  assert.match(writes[0].command, /"role":"user".*"role":"assistant"/)
})

test('real provider lifecycle events reach the supervisor sync as the current request/reply conversation', async () => {
  const session = Object.create(Session.prototype)
  const queued = []
  const writes = []
  Object.assign(session, {
    npcName: 'AIRI',
    activityEpoch: 'epoch',
    conversationGeneration: 0,
    conversationSequence: 0,
    agentLive: { phase: 'idle', detail: '', objective: '', at: 0, activity: [], conversation_id: 'task_epoch_0', conversation: [], debug: {} },
    rcon: {},
    stopping: false,
    queueEvent: fn => { queued.push(fn); return true },
    ensureAuthorization: async () => true,
    applyNavigationObstaclePolicy: async () => {},
    requestTaskBoardUiSync: () => {},
    currentPlanState: () => undefined,
    writeTaskBoardUi: async (command, label) => { writes.push({ command, label }); return true },
    printChat: async () => {},
  })

  const loop = Object.create(NpcAgentLoop.prototype)
  Object.assign(loop, {
    behaviorTrace: null,
    onActivity: (event, data) => session.onAgentActivity(event, data),
    log: () => {},
    traceRequest: { id: 'req-provider-conversation', seq: 0, usage: {} },
    continuations: 0,
    epoch: { actor_id: 7, epoch: 3 },
    active: true,
  })
  loop.request = async (text, { sender }) => {
    await NpcAgentLoop.prototype.traceEvent.call(loop, 'request.received', { sender, text })
    for (let round = 0; round < 3; round++) {
      await NpcAgentLoop.prototype.traceEvent.call(loop, 'provider.request', { round, recovery_attempt: 0 })
      await NpcAgentLoop.prototype.traceEvent.call(loop, 'provider.response', {
        round,
        recovery_attempt: 0,
        latency_ms: 10 + round,
        provider: { model: 'test-provider', finish_reason: round === 2 ? 'stop' : 'tool_calls' },
      })
    }
    await NpcAgentLoop.prototype.traceEvent.call(loop, 'request.completed', {
      chat_message: 'The read-only inspection is complete.',
      outcome: 'no_operations',
    })
    loop.active = false
    return null
  }
  session.agent = loop

  assert.equal(session.queuePlayerRequest('TTLouis', 'inspect the factory without changing anything'), true)
  await queued.shift()()

  assert.deepEqual(
    session.agentLive.conversation.map(entry => [entry.role, entry.text]),
    [
      ['user', 'inspect the factory without changing anything'],
      ['assistant', 'The read-only inspection is complete.'],
    ],
  )
  assert.equal(writes.length, 1)
  assert.equal(writes[0].label, 'sync')
  assert.match(writes[0].command, /"conversation_id":"task_epoch_0"/)
  assert.match(writes[0].command, /"role":"user".*"text":"inspect the factory without changing anything"/)
  assert.match(writes[0].command, /"role":"assistant".*"text":"The read-only inspection is complete\."/)
})

test('pause summaries keep the agent failure class instead of a generic request failure', () => {
  const omission = formatTaskCondition('provider_action_omission_repair_failed: bounded act-or-block repair returned no executable operation', 'pause')
  assert.match(omission.summary, /without starting the next action/)
  const drift = formatTaskCondition('provider_semantic_alignment_failed: relation=unrelated', 'pause')
  assert.match(drift.summary, /did not match the current step/)
})
