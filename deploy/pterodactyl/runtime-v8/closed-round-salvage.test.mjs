import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { providerRequest } from './provider.mjs'

// Live finding 3 (2026-09-29): on a closed round flash wrote its calls as
// DSML text (or structured tool_calls). The harness now keeps the tool list on
// deepseek closed rounds and salvages operation calls into a plan reply for
// the committed plan; observation calls get one bounded extra read.

const config = { base: 'https://api.example.test/v1', key: 'test-key-1234', model: 'test-model' }
const O = '<｜｜DSML｜｜ '
const C = '</｜｜DSML｜｜ '

function rawFetch(rawMessage) {
  return async () => new Response(JSON.stringify({
    id: 'resp-closed',
    model: 'test-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...rawMessage } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function deployment() {
  return {
    revision: 'airi-deploy-v8-npc-staging',
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
  constructor() {
    this.status = deployment()
    this.mutations = []
    this.batchId = 0
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) {
      return JSON.stringify({
        actor_position: { x: 0, y: 0 },
        entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 582, position: { x: 4, y: 0 } }],
      })
    }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'idle',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: { batch_id: this.batchId, task_count: 1, task_types: ['mining'], tick: 400 + this.batchId },
        basic_operation: { last_result: { operation_id: this.batchId, code: 'completed', completed: true } },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      this.batchId++
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return 'tool-output'
  }
}

function planMessage({ chatMessage = 'Working.', plan = [], currentStep = 0, operations = [] } = {}) {
  return { content: JSON.stringify({ chatMessage, plan, currentStep, operations }) }
}

async function runRepairScenario(closedRoundMessage) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-closed-salvage-'))
  const traceFile = path.join(dir, 'airi-behavior.jsonl')
  const plan = ['Mine fuel', 'Load the furnace']
  let call = 0
  const provider = async (loopMessages, context) => {
    call++
    if (context.allowTools === false) {
      return providerRequest({ ...config, profile: 'deepseek' }, loopMessages, { ...context, fetchImpl: rawFetch(closedRoundMessage) })
    }
    if (call === 1) {
      return planMessage({ chatMessage: 'Mining fuel first.', plan, currentStep: 0, operations: [{ name: 'mine_entity', args: { entity_name: 'coal', count: 5 } }] })
    }
    if (call === 2) return planMessage({ chatMessage: 'Loading the furnace next.', plan, currentStep: 1, operations: [] })
    if (call === 3) {
      return { content: null, tool_calls: [{ id: 'observe', type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 16, name: 'stone-furnace', limit: 4 }) } }] }
    }
    throw new Error(`unexpected extra provider call ${call}`)
  }
  const rcon = new FakeRcon()
  const agent = new NpcAgentLoop({ rcon, provider, systemPrompt: 'closed-round salvage test prompt', memory: new CanonicalTaskBoardMemory(), stateFile: null, traceFile })
  await agent.request('prepare the furnace', { sender: 'TTLouis' })
  const result = await agent.completed()
  const events = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { result, rcon, events, agent }
}

test('a DSML operation call on a closed round becomes plan operations for the committed plan and is admitted', async () => {
  const content = [
    `${O}calls>`,
    `${O}invoke name="mine_entity">`,
    `${O}parameter name="entity_name" string="true">coal${C}parameter>`,
    `${O}parameter name="count" string="false">5${C}parameter>`,
    `${C}invoke>`,
    `${C}calls>`,
  ].join('\n')
  const { rcon, events } = await runRepairScenario({ content })
  assert.equal(rcon.mutations.length, 2, 'the salvaged operation was admitted and executed')
  const salvage = events.find(event => event.event === 'closed_round.calls_salvaged')
  assert.ok(salvage)
  assert.equal(salvage.data.operation_count, 1)
  assert.deepEqual(salvage.data.operations, ['mine_entity'])
  assert.equal(JSON.stringify(salvage.data).includes('coal'), false, 'no argument dump in the trace')
})

test('structured tool_calls naming an operation on a closed round are salvaged the same way', async () => {
  const { rcon, events } = await runRepairScenario({
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mine_entity', arguments: JSON.stringify({ entity_name: 'coal', count: 5 }) } }],
  })
  assert.equal(rcon.mutations.length, 2)
  assert.ok(events.some(event => event.event === 'closed_round.calls_salvaged'))
})

test('an operation with unapproved arguments is refused by the normal admission path (correction recovery), not executed', async () => {
  await assert.rejects(runRepairScenario({
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mine_entity', arguments: JSON.stringify({ entity_name: 'coal', count: 5, shell: 'rm -rf /' }) } }],
  }), /Unexpected argument/)
})

function bareAgent() {
  return new NpcAgentLoop({ rcon: new FakeRcon(), provider: async () => ({}), systemPrompt: 's', memory: new CanonicalTaskBoardMemory(), stateFile: null, traceFile: null })
}
const ctx = { current: {}, generation: 0, round: 0, recoveryAttempt: 0 }

test('unknown tool names and unparseable arguments are not salvaged (format recovery as before)', async () => {
  const agent = bareAgent()
  agent.traceEvent = async () => {}
  assert.equal(await agent.salvageClosedRoundCalls({ content: '' }, [{ name: 'run_lua', arguments: '{}' }], ctx), undefined)
  assert.equal(await agent.salvageClosedRoundCalls({ content: '' }, [{ name: 'mine_entity', arguments: '{oops' }], ctx), undefined)
})

test('an observation-only closed-round call gets one bounded extra read, then the round closes again', async () => {
  const agent = bareAgent()
  const events = []
  agent.traceEvent = async (name, data) => { events.push([name, data]) }
  agent.observationBudgetRemaining = 2
  const executed = []
  agent.handleToolBatch = async (_message, prepared) => {
    executed.push(prepared.map(entry => entry.tool.function.name))
    agent.messages.push({ role: 'tool', content: 'result' })
  }
  const recalls = []
  agent.callProvider = async (_current, _generation, options) => { recalls.push(options); return { content: '{"plan":[]}' } }
  const call = { name: 'getInventoryItems', arguments: '{}' }
  const first = await agent.salvageClosedRoundCalls({ content: '' }, [call], ctx)
  assert.ok(first)
  assert.deepEqual(executed, [['getInventoryItems']])
  assert.equal(recalls[0].allowTools, false)
  assert.ok(events.some(([name]) => name === 'closed_round.observation_granted'))
  const second = await agent.salvageClosedRoundCalls({ content: '' }, [call], ctx)
  assert.equal(second, undefined)
  assert.equal(executed.length, 1)
  assert.ok(events.some(([name, data]) => name === 'closed_round.observation_dropped' && data.reason === 'extra_observation_already_used'))
  assert.match(agent.messages.at(-1).content, /Tools are closed[\s\S]*strict-JSON plan/)
})

test('with the observation budget spent the closed-round observation is dropped, not run', async () => {
  const agent = bareAgent()
  agent.traceEvent = async () => {}
  agent.observationBudgetRemaining = 0
  let ran = false
  agent.handleToolBatch = async () => { ran = true }
  const result = await agent.salvageClosedRoundCalls({ content: '' }, [{ name: 'getInventoryItems', arguments: '{}' }], ctx)
  assert.equal(result, undefined)
  assert.equal(ran, false)
})

// Decision-scope guard: the harness must not supply plan intent when the
// decision is meant to author a new or revised plan.
function agentWithPlan({ status = 'EXECUTING', currentStep = 0, trigger, pendingAmendment } = {}) {
  const agent = bareAgent()
  const events = []
  agent.traceEvent = async (name, data) => { events.push([name, data]) }
  agent.memory.currentPlan = () => ({ plan: ['Mine fuel', 'Load the furnace'], current_step: currentStep })
  agent.memory.planningState = () => ({ active_plan_id: 'p1', plans: [{ plan_id: 'p1', status }] })
  if (trigger) agent.reasoningTriggerSource = trigger
  if (pendingAmendment) agent.pendingInteractionAmendment = pendingAmendment
  return { agent, events }
}
const OP = [{ name: 'mine_entity', arguments: JSON.stringify({ entity_name: 'coal', count: 5 }) }]

test('salvage applies to an executing committed plan (control for the guard tests)', async () => {
  const { agent } = agentWithPlan()
  const salvaged = await agent.salvageClosedRoundCalls({ content: '' }, OP, ctx)
  assert.ok(salvaged)
  assert.deepEqual(JSON.parse(salvaged.content).plan, ['Mine fuel', 'Load the furnace'])
})

test('a blocked plan awaiting revision is never resubmitted with the model calls', async () => {
  const { agent, events } = agentWithPlan({ status: 'BLOCKED' })
  assert.equal(await agent.salvageClosedRoundCalls({ content: '' }, OP, ctx), undefined)
  assert.equal(events.find(([name]) => name === 'closed_round.salvage_skipped')[1].reason, 'plan_status_BLOCKED')
})

test('next-slice, replan and new-goal authoring decisions are not salvaged', async () => {
  for (const trigger of ['plan_slice_completed', 'post_step_replan', 'new_goal', 'amend_current']) {
    const { agent } = agentWithPlan({ trigger })
    assert.equal(await agent.salvageClosedRoundCalls({ content: '' }, OP, ctx), undefined, trigger)
  }
  const done = agentWithPlan({ status: 'COMPLETED' })
  assert.equal(await done.agent.salvageClosedRoundCalls({ content: '' }, OP, ctx), undefined)
})

test('a pending amendment and an out-of-range current step are not salvaged', async () => {
  const amended = agentWithPlan({ pendingAmendment: { text: 'change it' } })
  assert.equal(await amended.agent.salvageClosedRoundCalls({ content: '' }, OP, ctx), undefined)
  const past = agentWithPlan({ currentStep: 2 })
  assert.equal(await past.agent.salvageClosedRoundCalls({ content: '' }, OP, ctx), undefined)
})

test('a real plan in code fences or with prose around it beats a stray call', async () => {
  const plan = { chatMessage: '', plan: ['Mine fuel'], currentStep: 0, operations: [], checkpoint: { mode: 'all', requirements: [] } }
  for (const content of ['```json\n' + JSON.stringify(plan) + '\n```', 'Here is my plan: ' + JSON.stringify(plan) + ' done']) {
    const { agent } = agentWithPlan()
    assert.equal(await agent.salvageClosedRoundCalls({ content }, OP, ctx), undefined, content.slice(0, 20))
  }
})
