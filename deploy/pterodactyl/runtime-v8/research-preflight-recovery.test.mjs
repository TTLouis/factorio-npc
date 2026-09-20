import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'

function deployment(epoch = 3, actorId = 18) {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: actorId,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

function planMessage(operations, plan = ['Research automation'], chatMessage = 'continue research') {
  return {
    content: JSON.stringify({
      chatMessage,
      plan,
      currentStep: 0,
      operations,
    }),
  }
}

class ResearchRcon {
  constructor(preflight) {
    this.preflight = preflight
    this.commands = []
    this.preflightCalls = []
    this.mutations = []
    this.epoch = 3
    this.actorId = 18
    this.changeEpochOnPreflight = false
  }

  researchName(text) {
    const match = text.match(/\['technology_name'\]='([^']+)'/)
    return match?.[1]
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("airi_deployment","status")')) {
      return JSON.stringify(deployment(this.epoch, this.actorId))
    }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'idle', queue_empty: true, queue_length: 0 })
    }
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      const technology = this.researchName(text)
      this.preflightCalls.push({ technology, text })
      const result = this.preflight(technology, this.preflightCalls.length)
      if (this.changeEpochOnPreflight) this.epoch++
      return JSON.stringify(result)
    }
    if (text.includes('AIRI_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      const count = (text.match(/remote\.call\('autorio_operations'/g) ?? []).length
      return marker + JSON.stringify({
        ok: true,
        result: Array.from({ length: count }, () => [true, 'Task started']),
      })
    }
    return '{}'
  }
}

function missingPrerequisite() {
  return {
    ok: false,
    code: 'missing_prerequisites',
    operation: 'research_technology',
    technology: 'automation',
    requested: {
      name: 'automation',
      mode: 'science',
      status: 'blocked_by_prerequisites',
      unresolved_prerequisites: ['steam-power'],
    },
    next_actionable: {
      name: 'steam-power',
      mode: 'science',
      status: 'ready',
      required_action: 'research_technology_then_verify',
    },
    research_path: {
      ok: true,
      target: 'automation',
      node_count: 2,
      pending_count: 2,
      blocked: false,
      pending_path: [
        { name: 'steam-power', mode: 'science', status: 'ready' },
        { name: 'automation', mode: 'science', status: 'blocked_by_prerequisites' },
      ],
      pending_path_truncated: false,
      blockers: [],
      blockers_truncated: false,
    },
  }
}

test('missing prerequisite recovery preserves goal and active semantic step and admits only the corrected decision', async () => {
  const rcon = new ResearchRcon(technology => technology === 'automation'
    ? missingPrerequisite()
    : { ok: true, operation: 'research_technology', technology, state: 'ready' })
  let calls = 0
  let rejectedState
  let restoredState
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'research dependency recovery regression',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return planMessage([
          { name: 'wait', args: { ticks: 60 } },
          { name: 'research_technology', args: { technology_name: 'automation' } },
        ])
      }

      assert.equal(rcon.mutations.length, 0)
      const text = messages.map(message => String(message.content ?? '')).join('\n')
      assert.match(text, /before any Autorio batch admission/)
      assert.match(text, /same user goal and active canonical semantic step/i)
      assert.match(text, /"name":"steam-power"/)
      assert.match(text, /"mode":"science"/)
      assert.match(text, /Tools remain enabled/)
      rejectedState = agent.memory.currentPlan('npc:airi')
      const restored = new NpcDialogueMemory()
      restored.restore(agent.memory.snapshot())
      restoredState = restored.currentPlan('npc:airi')
      return planMessage([
        { name: 'research_technology', args: { technology_name: 'steam-power' } },
      ])
    },
  })

  const result = await agent.request('research automation', { sender: 'tester' })
  const finalState = agent.memory.currentPlan('npc:airi')
  const evidence = finalState.task_board.evidence.find(item => item.kind === 'operation_preflight_recoverable')

  assert.equal(calls, 2)
  assert.equal(result.operations[0].args.technology_name, 'steam-power')
  assert.equal(rcon.mutations.length, 1)
  assert.doesNotMatch(rcon.mutations[0], /'wait',60/)
  assert.doesNotMatch(rcon.mutations[0], /'research_technology','automation'/)
  assert.match(rcon.mutations[0], /'research_technology','steam-power'/)
  assert.equal(rejectedState.goal_id, finalState.goal_id)
  assert.equal(rejectedState.task_board.active_step_id, finalState.task_board.active_step_id)
  assert.equal(rejectedState.task_board.steps[0].description, finalState.task_board.steps[0].description)
  assert.equal(restoredState.goal_id, rejectedState.goal_id)
  assert.equal(restoredState.task_board.active_step_id, rejectedState.task_board.active_step_id)
  assert.equal(evidence.step_id, finalState.task_board.active_step_id)
  assert.equal(finalState.status, 'active')
  assert.notEqual(finalState.task_board.status, 'blocked')
})

test('trigger research recovery returns the exact deterministic trigger with tools still available', async () => {
  const exactTrigger = { type: 'craft-item', item: 'iron-plate', count: 50 }
  const rcon = new ResearchRcon(technology => technology === 'steam-power'
    ? {
        ok: false,
        code: 'trigger_research',
        operation: 'research_technology',
        technology: 'steam-power',
        requested: {
          name: 'steam-power',
          mode: 'trigger',
          status: 'ready',
          research_trigger: exactTrigger,
        },
        next_actionable: {
          name: 'steam-power',
          mode: 'trigger',
          status: 'ready',
          research_trigger: exactTrigger,
        },
        research_trigger: exactTrigger,
        research_path: {
          ok: true,
          target: 'steam-power',
          pending_count: 1,
          pending_path: [{ name: 'steam-power', mode: 'trigger', status: 'ready', research_trigger: exactTrigger }],
        },
      }
    : { ok: true })
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'trigger research recovery regression',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return planMessage([{ name: 'research_technology', args: { technology_name: 'steam-power' } }], ['Unlock steam power'])
      }
      const text = messages.map(message => String(message.content ?? '')).join('\n')
      assert.match(text, /"type":"craft-item","item":"iron-plate","count":50/)
      assert.match(text, /perform the exact research_trigger/i)
      return planMessage([{ name: 'craft_item', args: { item_name: 'iron-plate', count: 50 } }], ['Unlock steam power'])
    },
  })

  const result = await agent.request('unlock steam power', { sender: 'tester' })
  assert.equal(calls, 2)
  assert.equal(result.operations[0].name, 'craft_item')
  assert.equal(rcon.mutations.length, 1)
  assert.doesNotMatch(rcon.mutations[0], /research_technology/)
  assert.match(rcon.mutations[0], /craft_item/)
})

test('force_busy remains recoverable and preserves the existing research identity', async () => {
  const rcon = new ResearchRcon(technology => technology === 'automation'
    ? {
        ok: false,
        code: 'force_busy',
        operation: 'research_technology',
        technology: 'automation',
        current_research: { name: 'logistics', level: 1, progress: 0.4 },
        queue: [{ name: 'logistics', level: 1 }, { name: 'optics', level: 1 }],
        queue_length: 2,
        queue_truncated: false,
      }
    : { ok: true })
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'force busy research recovery regression',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return planMessage([{ name: 'research_technology', args: { technology_name: 'automation' } }])
      }
      const text = messages.map(message => String(message.content ?? '')).join('\n')
      assert.match(text, /"name":"logistics"/)
      assert.match(text, /"name":"optics"/)
      assert.match(text, /Preserve the existing force research\/queue/)
      return planMessage([{ name: 'wait', args: { ticks: 60 } }])
    },
  })

  const result = await agent.request('research automation after current force research', { sender: 'tester' })
  const state = agent.memory.currentPlan('npc:airi')
  assert.equal(calls, 2)
  assert.equal(result.operations[0].name, 'wait')
  assert.equal(rcon.mutations.length, 1)
  assert.doesNotMatch(rcon.mutations[0], /research_technology/)
  assert.notEqual(state.status, 'blocked')
})

test('permanent deterministic research errors remain real blockers without mutation admission', async () => {
  const rcon = new ResearchRcon(technology => ({
    ok: false,
    code: 'unknown_technology',
    operation: 'research_technology',
    technology,
  }))
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'permanent research blocker regression',
    provider: async () => planMessage([
      { name: 'research_technology', args: { technology_name: '__missing__' } },
    ]),
  })

  const result = await agent.request('research an unavailable technology', { sender: 'tester' })
  const state = agent.memory.currentPlan('npc:airi')
  assert.equal(rcon.mutations.length, 0)
  assert.equal(result.goalStatus, 'blocked')
  assert.equal(state.status, 'blocked')
  assert.match(state.blocker, /operation_preflight_failed:unknown_technology/)
  assert.equal(state.task_board.evidence.some(item => item.kind === 'operation_preflight_blocker'), true)
})

test('repeated refusal to follow deterministic next_actionable is bounded and pauses as provider/control failure', async () => {
  const rcon = new ResearchRcon(() => missingPrerequisite())
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'bounded research correction regression',
    provider: async (_messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      return planMessage([{ name: 'research_technology', args: { technology_name: 'automation' } }])
    },
  })

  const result = await agent.request('research automation', { sender: 'tester' })
  const state = agent.memory.currentPlan('npc:airi')
  const recoverable = state.task_board.evidence.filter(item => item.kind === 'operation_preflight_recoverable')

  assert.equal(calls, 3)
  assert.equal(rcon.preflightCalls.length, 3)
  assert.equal(rcon.mutations.length, 0)
  assert.equal(result.operations.length, 0)
  assert.equal(result.recoverableFailure.class, 'provider_control_plane')
  assert.equal(result.recoverableFailure.reason, 'research_preflight_retry_exhausted')
  assert.equal(state.status, 'paused')
  assert.equal(state.blocker, '')
  assert.equal(state.task_board.status, 'paused')
  assert.equal(recoverable.length, 3)
  assert.equal(recoverable.every(item => item.step_id === state.task_board.active_step_id), true)
  assert.equal(state.task_board.evidence.some(item => item.kind === 'operation_preflight_blocker'), false)
})

test('actor epoch replacement during preflight cancels the stale turn without manufacturing WORLD_BLOCKED', async () => {
  const rcon = new ResearchRcon(technology => ({
    ok: true,
    operation: 'research_technology',
    technology,
    state: 'ready',
  }))
  rcon.changeEpochOnPreflight = true
  const memory = new NpcDialogueMemory()
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    systemPrompt: 'research preflight actor epoch regression',
    provider: async () => planMessage([
      { name: 'research_technology', args: { technology_name: 'automation' } },
    ]),
  })

  await assert.rejects(
    agent.request('research automation', { sender: 'tester' }),
    /NPC actor epoch changed; stale model turn cancelled/,
  )
  const state = memory.currentPlan('npc:airi')
  assert.equal(rcon.mutations.length, 0)
  assert.equal(state.status, 'active')
  assert.equal(state.admission_status, 'preflight_rejected')
  assert.equal(state.blocker, '')
  assert.notEqual(state.task_board.status, 'blocked')
})
