import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentContext } from './agent-context.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'

const packet = (id, checkpoint = 'C3', role = 'executor') => ({
  stableText: '[HANDOFF] stable', volatileText: '--- step block ---', handoff_id: id, hash: 'h', chars: 20, estimated_tokens: 5,
  event: { role, checkpoint, reason: 'r' },
})

// ---------------------------------------------------------------------------------------
// B1: conversation state lives and dies with its conversation
// ---------------------------------------------------------------------------------------

test('every new conversation starts with empty conversation state; a parked planner keeps its own and gets it back', () => {
  const context = new AgentContext({ config: { models: ['planner-model', 'executor-model'], base: 'https://p.test/v1', key: 'k' } })
  context.baseMessages = [{ role: 'system', content: 'SYSTEM' }]
  context.messages = [...context.baseMessages]
  const plannerState = context.conversationState
  plannerState.set('toolCache', new Map([['sig', 'planner saw this']]))

  context.restage({ checkpoint: 'C3', reason: 'r', packet: packet('ho_exec_one'), parkPlanner: true })
  assert.notStrictEqual(context.conversationState, plannerState)
  assert.equal(context.conversationState.size, 0, 'the executor conversation has seen nothing')
  context.conversationState.set('toolCache', new Map([['sig', 'executor saw this']]))
  const executorOne = context.conversationState

  context.restage({ checkpoint: 'C8', reason: 'r', packet: packet('ho_exec_two', 'C8'), parkPlanner: true })
  assert.notStrictEqual(context.conversationState, executorOne, 'an executor-to-executor restage is a new conversation too')
  assert.equal(context.parkedPlanner.conversationState, plannerState, 'and leaves the parked planner state alone')

  context.resumePlanner()
  assert.strictEqual(context.conversationState, plannerState, 'the resumed planner sees exactly what it had been shown')
  assert.equal(context.conversationState.get('toolCache').get('sig'), 'planner saw this')

  context.beginLineage()
  assert.equal(context.conversationState.size, 0, 'a new lineage starts empty')
})

test('the loop reads its conversation-scoped caches through the active conversation', () => {
  const agent = new NpcAgentLoop({ rcon: { command: async () => '' }, provider: async () => ({ content: '' }), systemPrompt: 'x', stateFile: null, traceFile: null, decisionTraceFile: null })
  agent.toolCache.set('sig', 'shown')
  agent.prototypeRefsThisRequest.push('prototype-sig')
  agent.taskStatusDiffBaseline = { task_state: 'idle' }
  agent.lastTaskStatusView = { task_state: 'idle' }
  agent.agentContext.baseMessages = [{ role: 'system', content: 'SYSTEM' }]
  agent.agentContext.restage({ checkpoint: 'C3', reason: 'r', packet: packet('ho_exec_one') })

  assert.equal(agent.toolCache.size, 0)
  assert.deepEqual(agent.prototypeRefsThisRequest, [])
  assert.equal(agent.unchangedFactReads, undefined)
  assert.equal(agent.taskStatusDiffBaseline, null, 'the next task receipt in the new conversation is full')
  assert.deepEqual(agent.lastTaskStatusView, { task_state: 'idle' }, 'the latest world receipt is not conversation state')
})
