import assert from 'node:assert/strict'
import test from 'node:test'

import { describeRejectedReply, NpcAgentLoop } from './npc-agent-loop.mjs'
import { NpcAgentLoop as RuntimeNpcAgentLoop } from '../runtime-v8/npc-agent-loop.mjs'

// "What the model is told", findings 3 and 5. A rejected reply used to be
// answered with a fixed line that described the wrong mistake (a plan sent in
// content with an empty tool_calls array was told to "retry using only an
// approved observation tool name"), and the closed observation phase never
// said that the gather operations find their own target.

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

class FakeRcon {
  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_actor","status")')) {
      return JSON.stringify({
        mode: 'npc',
        connected_players: 0,
        actor: { actor_id: 18, kind: 'standalone_character', valid: true, has_character: true },
        load_reconciliation: { pending: false, last_actor_id: 18 },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return 'tool-output'
  }
}

function planContent(operations, extra = {}) {
  return JSON.stringify({
    chatMessage: 'Working.',
    plan: ['Perform bounded step'],
    currentStep: 0,
    operations,
    ...extra,
  })
}

const waitPlan = () => planContent([{ name: 'wait', args: { ticks: 1 } }])
const toolCall = (id, name, args = {}) => ({
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})
const lastUser = messages => String(messages.filter(message => message.role === 'user').at(-1)?.content ?? '')

test('a plan in content with an empty tool_calls array is answered with what was received, the real reason and the valid reply shape', async () => {
  const seen = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async (messages) => {
      calls++
      seen.push(lastUser(messages))
      if (calls === 1) return { role: 'assistant', content: waitPlan(), tool_calls: [] }
      return { content: waitPlan() }
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('do a thing')
  assert.equal(result.operations[0].name, 'wait')
  assert.equal(calls, 2)

  const correction = seen[1]
  assert.match(correction, /Tool-validation failure \(1\/\d+; invalid_tool_batch\)/)
  assert.match(correction, /tool_calls is empty/)
  assert.match(correction, /Received: plan in content \(1 operation\); tool_calls=\[\]\./)
  assert.match(correction, /Valid next reply: approved observation tool call\(s\) with strict JSON arguments, or the strict-JSON plan as content with no tool_calls field\./)
  // The old line described a different mistake: the model had sent a plan.
  assert.doesNotMatch(correction, /Retry using only an approved observation tool name/)
})

test('a tool reply after the observation phase closed says what arrived, that tools are off, the valid shape, and that gather operations find their own target', async () => {
  const seen = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async (messages, context) => {
      calls++
      seen.push({ text: lastUser(messages), allowTools: context.allowTools })
      if (calls <= 4) return toolCall(`tool-${calls}`, 'getRecipe', { item: `item-${calls}` })
      // The phase is closed now; the model still answers in the tool_calls shape.
      if (calls === 5) return { role: 'assistant', content: waitPlan(), tool_calls: [] }
      return { content: waitPlan() }
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('observe until the budget closes')
  assert.equal(result.operations[0].name, 'wait')
  assert.equal(calls, 6)

  // The closing message itself carries the cold-start point (finding 5).
  assert.equal(seen[4].allowTools, false)
  assert.match(seen[4].text, /observation phase for this decision is now closed/i)
  assert.match(seen[4].text, /gather_resource, harvest_product and walk_to_entity find their own target/)

  const rejection = seen[5].text
  assert.match(rejection, /Observation phase is closed for this decision \(1\/\d+; observation_phase_closed\)/)
  assert.match(rejection, /Received: plan in content \(1 operation\); tool_calls=\[\]\./)
  assert.match(rejection, /Tools are disabled, so no tool call is valid now\./)
  assert.match(rejection, /Valid next reply: the strict-JSON plan \(or a truthful blocker\) as content, with no tool_calls field\./)
  assert.match(rejection, /gather_resource, harvest_product and walk_to_entity find their own target/)
})

test('an observation tool placed in operations after the phase closed is not told to call it as a tool', async () => {
  const seen = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async (messages) => {
      calls++
      seen.push(lastUser(messages))
      if (calls <= 4) return toolCall(`tool-${calls}`, 'getRecipe', { item: `item-${calls}` })
      if (calls === 5) return { content: planContent([{ name: 'getRecipe', args: { item: 'x' } }]) }
      return { content: waitPlan() }
    },
    systemPrompt: 'NPC test prompt',
  })

  await agent.request('observe until the budget closes')
  const correction = seen[5]
  assert.match(correction, /getRecipe is an observation\/planning tool, not an approved world-mutation operation/)
  assert.match(correction, /Tools remain disabled because the observation phase for this decision is closed/)
  assert.doesNotMatch(correction, /Call it as a tool/)
})

test('describeRejectedReply is short and names what the harness received', () => {
  assert.equal(describeRejectedReply({ content: '', tool_calls: [] }), 'Received: empty content; tool_calls=[].')
  assert.equal(describeRejectedReply({ content: 'I will look around.' }), 'Received: text content (19 chars).')
  assert.equal(describeRejectedReply({ content: '{"plan":[]}' }), 'Received: JSON object in content.')
  const many = Array.from({ length: 9 }, (_, index) => ({ function: { name: `getTool${index}` } }))
  const text = describeRejectedReply({ content: null, tool_calls: many })
  assert.match(text, /tool_calls=\[getTool0, getTool1, getTool2, getTool3, getTool4, getTool5, …\]/)
  assert.ok(describeRejectedReply({ content: 'x'.repeat(5000), tool_calls: many }).length <= 300)
})

test('the runtime loop names submitPlan as the valid planner reply while tools are open', () => {
  const agent = Object.create(RuntimeNpcAgentLoop.prototype)
  assert.match(agent.validReplyShape({ toolsEnabled: true }), /one submitPlan call/)
  // With tools off there is no tool to call, so the content fallback stands.
  assert.match(agent.validReplyShape({ toolsEnabled: false }), /strict-JSON plan/)
  assert.equal(agent.planReplyName(), 'one submitPlan call')
})
