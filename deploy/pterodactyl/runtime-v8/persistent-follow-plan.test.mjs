import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcAgentLoop } from './npc-agent-loop.mjs'

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 1,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

class FakeRcon {
  constructor({ healthyFollow = true } = {}) {
    this.status = deployment()
    this.healthyFollow = healthyFollow
    this.followEnabled = false
  }

  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'idle', queue_empty: true, queue_length: 0 })
    }
    if (text.includes('remote.call("autorio_follow","status")')) {
      return JSON.stringify({
        active: this.followEnabled,
        state: this.followEnabled && this.healthyFollow ? 'following' : this.followEnabled ? 'blocked' : 'stopped',
        code: this.followEnabled && this.healthyFollow ? 'following' : this.followEnabled ? 'navigation_blocked' : 'stopped',
        healthy: this.followEnabled && this.healthyFollow,
        controller_live: this.followEnabled && this.healthyFollow,
        target_player: 'TTLouis',
        current_distance: 8,
        desired_distance: 4,
        last_progress_tick: 120,
        stuck_for_ticks: this.healthyFollow ? 0 : 180,
        path_request_id: this.healthyFollow ? 44 : undefined,
        path_attempts: 1,
        waypoints_remaining: this.healthyFollow ? 3 : 0,
        last_repath_tick: 100,
        last_failure: this.healthyFollow ? undefined : 'unreachable',
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      if (text.includes("'follow_player'")) this.followEnabled = true
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return 'tool-output'
  }
}

function planMessage({ chatMessage = 'Working.', plan = [], currentStep = 0, operations = [] } = {}) {
  return { content: JSON.stringify({ chatMessage, plan, currentStep, operations }) }
}

test('healthy persistent follow keeps the durable goal active when a continuation submits no duplicate operation', async () => {
  const replies = [
    planMessage({
      chatMessage: '正在跟随 TTLouis（约4格）。',
      plan: ['启用持续跟随', '持续跟随直到停止'],
      currentStep: 0,
      operations: [{ name: 'follow_player', args: { player_name: 'TTLouis', follow_distance: 4 } }],
    }),
    planMessage({
      chatMessage: '正在跟随 TTLouis（约4格）。',
      plan: ['启用持续跟随', '持续跟随直到停止'],
      currentStep: 1,
      operations: [],
    }),
  ]
  const rcon = new FakeRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => replies.shift(),
    systemPrompt: 'NPC test prompt',
    stateFile: null,
    traceFile: null,
  })

  const started = await agent.request('跟着我吧', { sender: 'TTLouis' })
  assert.match(started.chatMessage, /^\[Plan 1\/2\]/)
  assert.equal(agent.active, true)

  const continuing = await agent.completed()
  assert.equal(continuing.chatMessage, '正在跟随 TTLouis（约4格）。')
  assert.equal(continuing.goalStatus, 'active')
  assert.equal(continuing.persistentRuntime?.kind, 'follow')
  assert.equal(continuing.persistentRuntime?.healthy, true)
  assert.equal(agent.active, false)

  const state = agent.memory.currentPlan('npc:sgluna')
  assert.equal(state.status, 'active')
  assert.equal(state.blocker, '')
  assert.equal(state.persistent_runtime.controller_live, true)
})

test('an unhealthy follow flag does not bypass the finite no-operation protection', async () => {
  const replies = [
    planMessage({
      chatMessage: 'Starting follow.',
      plan: ['Enable follow', 'Keep following'],
      currentStep: 0,
      operations: [{ name: 'follow_player', args: { player_name: 'TTLouis', follow_distance: 4 } }],
    }),
    planMessage({
      chatMessage: 'Still following.',
      plan: ['Enable follow', 'Keep following'],
      currentStep: 1,
      operations: [],
    }),
    planMessage({
      chatMessage: 'BLOCKED: follow controller reports navigation_blocked and is not healthy.',
      plan: ['Enable follow', 'Keep following'],
      currentStep: 1,
      operations: [],
    }),
  ]
  const rcon = new FakeRcon({ healthyFollow: false })
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => replies.shift(),
    systemPrompt: 'NPC test prompt',
    stateFile: null,
    traceFile: null,
  })

  await agent.request('follow me', { sender: 'TTLouis' })
  const result = await agent.completed()
  assert.match(result.chatMessage, /^\[Plan paused for recoverable provider failure\].*navigation_blocked/i)
  assert.equal(result.goalStatus, 'paused')
  assert.equal(agent.memory.currentPlan('npc:sgluna').blocker, '')
})
