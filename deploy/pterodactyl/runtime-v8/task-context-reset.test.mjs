import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcDialogueMemory } from './npc-agent-loop.mjs'

function seed(memory, key = 'npc:sgluna') {
  memory.remember(key, 1, {
    sender: 'TTLouis',
    user: 'build a steam power block',
    assistant: 'Starting the build.',
    operations: [{ name: 'craft_item', args: { item_name: 'boiler', count: 1 } }],
  })
  memory.recordPlan(key, { sender: 'TTLouis', text: 'build a steam power block' }, {
    chatMessage: 'Starting the build.',
    plan: ['Craft a boiler', 'Place the boiler'],
    currentStep: 0,
    operations: [{ name: 'craft_item', args: { item_name: 'boiler', count: 1 } }],
  })
  return key
}

test('terminatePlan discards the durable goal but preserves conversational memory', () => {
  const memory = new NpcDialogueMemory()
  const key = seed(memory)

  const previous = memory.terminatePlan(key, 'ui_terminate')

  assert.equal(previous?.objective, 'build a steam power block')
  assert.equal(memory.currentPlan(key), undefined)
  assert.match(memory.context(key), /build a steam power block/)
  assert.equal(memory.snapshot().plans.length, 0)
})

test('clearTaskContext removes dialogue and durable plan for only the selected NPC', () => {
  const memory = new NpcDialogueMemory()
  const key = seed(memory)
  const other = seed(memory, 'npc:other')

  const result = memory.clearTaskContext(key)

  assert.deepEqual(result, { cleared_dialogue: true, cleared_plan: true })
  assert.equal(memory.context(key), '')
  assert.equal(memory.currentPlan(key), undefined)
  assert.match(memory.context(other), /build a steam power block/)
  assert.ok(memory.currentPlan(other))
  assert.equal(memory.snapshot().dialogue.length, 1)
  assert.equal(memory.snapshot().plans.length, 1)
})
