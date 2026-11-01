import test from 'node:test'
import assert from 'node:assert/strict'
import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'

function deployment(actorId = 18, epoch = 3) {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
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

class FakeRcon {
  constructor() {
    this.status = deployment()
    this.commands = []
    this.mutations = []
    this.onCommand = null
  }

  async command(text) {
    this.commands.push(text)
    if (this.onCommand) await this.onCommand(text, this)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_actor","status")')) {
      return JSON.stringify({
        mode: 'npc',
        connected_players: this.status.connected_players,
        actor: { actor_id: this.status.actor_id, kind: 'standalone_character', valid: true, has_character: true },
        load_reconciliation: { pending: false, last_actor_id: this.status.actor_id },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      const result = Array.from({ length: admissions }, () => [true, 'Task started'])
      return `${marker}${JSON.stringify({ ok: true, result })}`
    }
    return 'tool-output'
  }
}

function toolMessage(id, name, args = {}) {
  return {
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  }
}

function toolBatchMessage(prefix, count, name = 'getActorStatus') {
  return {
    content: null,
    tool_calls: Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index + 1}`,
      type: 'function',
      function: { name, arguments: '{}' },
    })),
  }
}

function planMessage(operations, chatMessage = 'Working.') {
  return {
    content: JSON.stringify({
      chatMessage,
      plan: operations.length ? ['Perform bounded step'] : ['Done'],
      currentStep: 0,
      operations,
    }),
  }
}

test('scripted provider can observe actor then submit an epoch-authorized structured operation', async () => {
  const rcon = new FakeRcon()
  const providerMessages = [
    toolMessage('tool-1', 'getActorStatus'),
    planMessage([{ name: 'wait', args: { ticks: 60 } }]),
  ]
  const provider = async () => providerMessages.shift()
  const reservations = []
  const agent = new NpcAgentLoop({
    rcon,
    provider,
    systemPrompt: 'NPC test prompt',
    reserve: async value => reservations.push(value),
  })

  const result = await agent.request('wait briefly', { sender: 'TTLouis' })

  assert.equal(result.actorId, 18)
  assert.equal(result.epoch, 3)
  assert.equal(result.operations[0].name, 'wait')
  assert.equal(rcon.mutations.length, 1)
  assert.match(rcon.mutations[0], /sgluna_deployment","authorize",3/)
  assert.match(rcon.mutations[0], /autorio_operations','wait',60/)
  assert.equal(reservations.length, 2)
  assert.ok(agent.messages.some(message => message.role === 'tool'))
  assert.ok(agent.messages.some(message => message.role === 'user' && message.content === '[CHAT] TTLouis: wait briefly'))
})

test('distinct read-only tools receive decision pressure before exhausting the observation budget', async () => {
  const rcon = new FakeRcon()
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    provider: async (messages) => {
      calls++
      if (calls <= 3) return toolMessage(`tool-${calls}`, 'getRecipe', { item: `test-item-${calls}` })
      assert.match(messages.map(message => String(message.content ?? '')).join('\n'), /Decision pressure after 3 consecutive observation-only rounds/)
      return planMessage([{ name: 'wait', args: { ticks: 1 } }])
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('observe before acting')

  assert.equal(calls, 4)
  assert.equal(result.operations[0].name, 'wait')
  assert.equal(rcon.mutations.length, 1)
})

test('tool-budget exhaustion gets up to three no-tool recovery attempts', async () => {
  const rcon = new FakeRcon()
  const contexts = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    maxToolRounds: 2,
    maxRecoveryAttempts: 3,
    provider: async (_messages, context) => {
      contexts.push(context)
      calls++
      if (calls <= 2) return toolMessage(`tool-${calls}`, 'getRecipe', { item: `test-item-${calls}` })
      return planMessage([], 'I have enough information now.')
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('inspect then answer')

  assert.equal(result.chatMessage, 'I have enough information now.')
  assert.equal(contexts.length, 3)
  assert.equal(contexts[2].allowTools, false)
  assert.equal(contexts[2].recoveryAttempt, 1)
})

test('duplicate observation exhaustion gets one bounded no-tool decision without forcing mutation', async () => {
  const rcon = new FakeRcon()
  const contexts = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    maxToolRounds: 12,
    provider: async (_messages, context) => {
      contexts.push(context)
      calls++
      if (context.allowTools === false) return planMessage([], 'No safe mutation is grounded from the current evidence.')
      return toolMessage(`tool-${calls}`, 'getActorStatus')
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('keep looking')
  const actorReads = rcon.commands.filter(command => command.includes('remote.call("autorio_actor","status")'))
  assert.equal(result.chatMessage, 'No safe mutation is grounded from the current evidence.')
  assert.equal(result.operations.length, 0)
  assert.equal(rcon.mutations.length, 0)
  assert.equal(actorReads.length, 1)
  assert.equal(calls, 4)
  assert.equal(contexts.slice(0, 3).every(context => context.allowTools === true), true)
  assert.equal(contexts[3].allowTools, false)
  assert.ok(agent.messages.some(message => message.role === 'tool' && /"actor_id":18/.test(message.content)))
  assert.ok(agent.messages.some(message => message.role === 'user' && /duplicate result was suppressed/i.test(message.content)))
  assert.ok(agent.messages.some(message => message.role === 'user' && /Observation retries are exhausted/i.test(message.content)))
})

test('two consecutive five-tool observation batches get bounded tools-on validation recovery', async () => {
  const rcon = new FakeRcon()
  const contexts = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    provider: async (_messages, context) => {
      contexts.push(context)
      calls++
      if (calls <= 2) return toolBatchMessage(`oversized-${calls}`, 5)
      if (calls === 3) return toolBatchMessage('valid', 2)
      return planMessage([], 'Observed enough; no mutation required.')
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('observe safely')
  assert.equal(result.chatMessage, 'Observed enough; no mutation required.')
  assert.equal(rcon.mutations.length, 0)
  assert.equal(calls, 4)
  assert.ok(contexts.every(context => context.allowTools === true))
  assert.equal(rcon.commands.filter(command => command.includes('remote.call("autorio_actor","status")')).length, 1)
  assert.ok(agent.messages.some(message => message.role === 'user' && /at most 4 observation tool calls/.test(message.content)))
})

test('dialogue memory belongs to the logical NPC and survives body replacement', async () => {
  const rcon = new FakeRcon()
  const observed = []
  const agent = new NpcAgentLoop({
    rcon,
    npcId: 'sgluna-primary',
    provider: async messages => {
      observed.push(messages)
      return planMessage([], 'Acknowledged.')
    },
    systemPrompt: 'NPC test prompt',
  })

  await agent.request('remember the copper patch', { sender: 'TTLouis' })
  rcon.status = deployment(42, 4)
  await agent.request('what did I mention?', { sender: 'TTLouis' })
  const second = observed[1].map(message => message.content ?? '').join('\n')
  assert.match(second, /\[MEMORY\]/)
  assert.match(second, /TTLouis: remember the copper patch/)
  assert.match(second, /\[CHAT\] TTLouis: what did I mention\?/)
})

test('shared dialogue memory remains isolated by logical NPC id', async () => {
  const memory = new NpcDialogueMemory()
  const firstObserved = []
  const secondObserved = []
  const first = new NpcAgentLoop({
    rcon: new FakeRcon(),
    memory,
    npcId: 'sgluna-one',
    provider: async messages => {
      firstObserved.push(messages)
      return planMessage([], 'First NPC.')
    },
    systemPrompt: 'NPC test prompt',
  })
  const second = new NpcAgentLoop({
    rcon: new FakeRcon(),
    memory,
    npcId: 'sgluna-two',
    provider: async messages => {
      secondObserved.push(messages)
      return planMessage([], 'Second NPC.')
    },
    systemPrompt: 'NPC test prompt',
  })

  await first.request('private fact for NPC one', { sender: 'TTLouis' })
  await second.request('hello NPC two', { sender: 'Alice' })
  const secondContext = secondObserved[0].map(message => message.content ?? '').join('\n')
  assert.doesNotMatch(secondContext, /private fact for NPC one/)
  assert.match(secondContext, /\[CHAT\] Alice: hello NPC two/)
})

test('dialogue memory compacts old turns within a bounded context', () => {
  const memory = new NpcDialogueMemory({
    maxRecentTurns: 2,
    maxSummaryChars: 240,
    maxContextChars: 700,
    maxFieldChars: 80,
  })
  for (let i = 1; i <= 6; i++) {
    memory.remember('npc:one', i, {
      sender: 'TTLouis',
      user: `request-${i} ${'x'.repeat(50)}`,
      assistant: `answer-${i} ${'y'.repeat(50)}`,
      operations: [],
    })
  }

  const context = memory.context('npc:one')
  assert.ok(context.length <= 700)
  assert.match(context, /Compacted earlier dialogue/)
  assert.match(context, /request-6/)
})

test('actor replacement during tool observation cancels the stale model turn before mutation', async () => {
  const rcon = new FakeRcon()
  rcon.onCommand = async (text, transport) => {
    if (text.includes('remote.call("autorio_actor","status")')) {
      transport.status = deployment(42, 4)
    }
  }
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => toolMessage('tool-1', 'getActorStatus'),
    systemPrompt: 'NPC test prompt',
  })

  await assert.rejects(() => agent.request('inspect actor'), /epoch changed/)
  assert.equal(rcon.mutations.length, 0)
  assert.equal(agent.active, false)
})

test('entire structured operation batch is validated before the first world mutation', async () => {
  const rcon = new FakeRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => planMessage([
      { name: 'wait', args: { ticks: 60 } },
      { name: 'game.clear', args: {} },
    ]),
    systemPrompt: 'NPC test prompt',
  })

  await assert.rejects(() => agent.request('bad batch'), /recovery exhausted/)
  assert.equal(rcon.mutations.length, 0)
})

test('dependent operations are admitted in one mutation with no inter-operation simulation window', async () => {
  const rcon = new FakeRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => planMessage([
      { name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 } },
      { name: 'wait', args: { ticks: 300 } },
    ]),
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('mine then wait')
  assert.equal(result.operations.length, 2)
  assert.equal(rcon.mutations.length, 1)
  const command = rcon.mutations[0]
  assert.equal((command.match(/sgluna_deployment","authorize",3/g) ?? []).length, 1)
  const first = command.indexOf("autorio_operations','mine_entity'")
  const second = command.indexOf("autorio_operations','wait'")
  assert.ok(first >= 0 && second > first)
})

test('actor replacement after atomic batch admission cancels continuation without replaying the batch', async () => {
  const rcon = new FakeRcon()
  rcon.onCommand = async (text, transport) => {
    if (text.includes('local ok,result=pcall')) {
      queueMicrotask(() => { transport.status = deployment(42, 4) })
    }
  }
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => planMessage([
      { name: 'wait', args: { ticks: 60 } },
      { name: 'wait', args: { ticks: 60 } },
    ]),
    systemPrompt: 'NPC test prompt',
  })

  await assert.rejects(() => agent.request('two steps'), /epoch changed/)
  assert.equal(rcon.mutations.length, 1)
  assert.equal((rcon.mutations[0].match(/return remote\.call\('autorio_operations'/g) ?? []).length, 2)
})

test('completion continuation stays on the captured actor and is bounded', async () => {
  const rcon = new FakeRcon()
  const messages = [
    planMessage([{ name: 'wait', args: { ticks: 1 } }]),
    planMessage([], 'Verified complete.'),
  ]
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => messages.shift(),
    systemPrompt: 'NPC test prompt',
  })

  await agent.request('do a tiny task')
  assert.equal(agent.active, true)
  const final = await agent.completed()
  assert.equal(final.chatMessage, 'Verified complete.')
  assert.equal(agent.active, false)
  assert.ok(agent.messages.some(message => message.role === 'user' && message.content === '[MOD] All operations completed'))
})

test('malformed tool arguments and arbitrary tool names fail before RCON tool execution', async () => {
  for (const message of [
    toolMessage('tool-1', 'shell', {}),
    { content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'getRecipe', arguments: '{bad' } }] },
  ]) {
    const rcon = new FakeRcon()
    const baseline = rcon.commands.length
    const contexts = []
    const agent = new NpcAgentLoop({
      rcon,
      provider: async (_messages, context) => {
        contexts.push(context)
        return message
      },
      systemPrompt: 'NPC test prompt',
    })
    const result = await agent.request('bad tool')
    assert.equal(result.blocked, true)
    assert.equal(result.blocker.class, 'tool_validation')
    assert.equal(rcon.mutations.length, 0)
    assert.ok(rcon.commands.length > baseline)
    assert.equal(rcon.commands.some(command => command.includes('autorio_tools')), false)
    assert.ok(contexts.every(context => context.allowTools === true))
  }
})


test('observation decision pressure can allow a bounded multi-observation window', async () => {
  const rcon = new FakeRcon()
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    provider: async (messages) => {
      calls++
      if (calls <= 3) return toolMessage(`tool-${calls}`, 'getRecipe', { item: `test-item-${calls}` })
      if (calls === 4) {
        assert.match(messages.map(message => String(message.content ?? '')).join('\n'), /up to 2 additional targeted observation call/)
        return toolMessage('tool-4', 'getRecipe', { item: 'needed-four' })
      }
      if (calls === 5) {
        assert.match(messages.map(message => String(message.content ?? '')).join('\n'), /1 targeted observation call\(s\) remain/)
        return planMessage([{ name: 'wait', args: { ticks: 1 } }])
      }
      throw new Error('unexpected provider call')
    },
    systemPrompt: 'NPC test prompt',
  })
  agent.observationDecisionPressureBudget = () => 2
  const result = await agent.request('observe two more facts before acting')
  assert.equal(calls, 5)
  assert.equal(result.operations[0].name, 'wait')
})


test('observation budget exhaustion becomes a normal no-tools decision round', async () => {
  const rcon = new FakeRcon()
  let calls = 0
  const contexts = []
  const agent = new NpcAgentLoop({
    rcon,
    provider: async (messages, context) => {
      calls++
      contexts.push({ ...context })
      if (calls <= 4) return toolMessage(`tool-${calls}`, 'getRecipe', { item: `decision-item-${calls}` })
      assert.equal(context.allowTools, false)
      assert.equal(context.recoveryAttempt, 0)
      assert.match(messages.map(message => String(message.content ?? '')).join('\n'), /observation phase for this decision is now closed/i)
      return planMessage([{ name: 'wait', args: { ticks: 1 } }])
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('observe until the bounded decision budget closes')
  assert.equal(calls, 5)
  assert.equal(contexts[4].allowTools, false)
  assert.equal(result.operations[0].name, 'wait')
})

test('oversized final observation batch closes the observation phase without entering recovery', async () => {
  const rcon = new FakeRcon()
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    provider: async (_messages, context) => {
      calls++
      if (calls <= 3) return toolMessage(`tool-${calls}`, 'getRecipe', { item: `pressure-item-${calls}` })
      if (calls === 4) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'too-many-1', type: 'function', function: { name: 'getRecipe', arguments: JSON.stringify({ item: 'a' }) } },
            { id: 'too-many-2', type: 'function', function: { name: 'getRecipe', arguments: JSON.stringify({ item: 'b' }) } },
          ],
        }
      }
      assert.equal(context.allowTools, false)
      assert.equal(context.recoveryAttempt, 0)
      return planMessage([{ name: 'wait', args: { ticks: 1 } }])
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('do not convert observation pressure into recovery')
  assert.equal(calls, 5)
  assert.equal(result.operations[0].name, 'wait')
})
