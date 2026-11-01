import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { aggregate, analyzeRun, extractFacts, parseJsonl, readJsonlFile, renderMarkdown, swapEvents } from './restage-loss-report.mjs'

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const assistant = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls })
const tool = (id, content) => ({ role: 'tool', tool_call_id: id, content })
const system = { role: 'system', content: '[SYSTEM_PROMPT] you are a synthetic npc' }
const INVENTORY = '{"observation_mode":"full","items":[{"name":"iron-plate","count":8},{"name":"coal","count":12}]}'
const RECIPE = '{"found":true,"query":"lab","recipes":[{"name":"lab","ingredients":[{"name":"electronic-circuit","amount":10},{"name":"iron-gear-wheel","amount":10},{"name":"transport-belt","amount":4}]}]}'

function prompt(ts, messages, extra = {}) {
  return { event: 'provider.request', ts, request_id: 'req_1', round: 0, actor_id: 7, payload: { messages }, ...extra }
}

function swapRow(event, ts, data = {}) {
  return { event, ts, request_id: 'req_1', actor_id: 7, data }
}

test('extractFacts pairs tool results with their calls under a canonical key', () => {
  const facts = extractFacts([
    system,
    assistant(call('c1', 'getInventoryItems', {}), call('c2', 'getNearbyEntities', { radius: 8, name: 'furnace' })),
    tool('c1', INVENTORY),
    tool('c2', '{"entities":[]}'),
    tool('orphan', 'unpaired result'),
  ])
  const inventory = facts.get('tool:getInventoryItems:{}')
  assert.equal(inventory.name, 'getInventoryItems')
  assert.equal(inventory.chars, INVENTORY.length)
  assert.equal(inventory.index, 2)
  assert.equal(inventory.observation_mode, 'full')
  assert.equal(inventory.family, 'inventory_equipment')
  assert.ok(facts.has('tool:getNearbyEntities:{"name":"furnace","radius":8}'))
  assert.equal(facts.size, 2)
})

test('extractFacts collects harness blocks and MOD receipts and skips the system prompt', () => {
  const facts = extractFacts([
    { role: 'system', content: '[LEADING_PROMPT] ignored' },
    { role: 'user', content: '[HANDOFF] packet line\nmore packet\n[STEERING] guidance' },
    { role: 'user', content: '[HARNESS] first' },
    { role: 'user', content: '[HARNESS] second' },
    { role: 'user', content: 'fresh_topology: {"state":"fresh"}' },
    { role: 'user', content: '[MOD] batch done {"last_completed_batch":{"batch_id":4}}' },
    { role: 'user', content: '[MOD] batch done without id' },
    { role: 'user', content: 'plain text without a marker' },
    { role: 'user', content: [{ type: 'text', text: '[CHAT] hello' }] },
  ])
  assert.equal(facts.has('block:LEADING_PROMPT'), false)
  assert.equal(facts.get('block:HANDOFF').chars, '[HANDOFF] packet line\nmore packet'.length)
  assert.ok(facts.has('block:STEERING'))
  assert.equal(facts.get('block:HARNESS').count, 2)
  assert.ok(facts.has('block:fresh_topology'))
  assert.ok(facts.has('receipt:4'))
  assert.ok(facts.has('receipt:0'))
  assert.ok(facts.has('block:CHAT'))
})

test('swapEvents keeps swap rows in order and tolerates missing fields', () => {
  const events = swapEvents([
    swapRow('context.planner_resumed', '2026-01-01T00:00:20.000Z', { role: 'planner', handoff_id: 'h2' }),
    swapRow('context.restaged', '2026-01-01T00:00:10.000Z', { role: 'executor', checkpoint: 'C3', handoff_id: 'h1', reason: 'recovery:x y z' }),
    { event: 'context.planner_parked', ts: '2026-01-01T00:00:11.000Z' },
    { event: 'planning.reasoning_epoch_reset', ts: '2026-01-01T00:00:30.000Z' },
    { event: 'context.restaged' },
  ])
  assert.deepEqual(events.map(e => e.kind), ['restaged', 'planner_resumed', 'reasoning_epoch_reset'])
  assert.equal(events[0].checkpoint, 'C3')
  assert.equal(events[0].reason, 'recovery:x')
  assert.equal(events[0].request_id, 'req_1')
  assert.equal(events[2].role, undefined)
})

test('a lost tool read that the model reads again is counted as re-read', () => {
  const before = prompt('2026-01-01T00:00:09.000Z', [
    system,
    assistant(call('a', 'getInventoryItems', {}), call('b', 'getRecipeDetails', { item_or_recipe: 'lab' })),
    tool('a', INVENTORY),
    tool('b', RECIPE),
  ])
  const after = prompt('2026-01-01T00:00:10.500Z', [system, { role: 'user', content: '[HANDOFF] fresh executor start' }])
  const later = prompt('2026-01-01T00:00:12.000Z', [
    system,
    { role: 'user', content: '[HANDOFF] fresh executor start' },
    assistant(call('n1', 'getInventoryItems', {})),
    tool('n1', INVENTORY),
    { role: 'assistant', content: '{"plannerReview":{"reason":"x"},"note":"BLOCKED by missing ore"}' },
  ])
  const results = analyzeRun({
    run: 'synthetic',
    prompts: [before, after, later],
    behavior: [swapRow('context.restaged', '2026-01-01T00:00:10.000Z', { role: 'executor', checkpoint: 'C3', handoff_id: 'h1' })],
  })
  assert.equal(results.length, 1)
  const [swap] = results
  assert.deepEqual(swap.lost.map(f => f.key).sort(), ['tool:getInventoryItems:{}', 'tool:getRecipeDetails:{"item_or_recipe":"lab"}'])
  assert.equal(swap.re_read.length, 1)
  assert.equal(swap.re_read[0].key, 'tool:getInventoryItems:{}')
  assert.equal(swap.re_read[0].rounds, 1)
  assert.equal(swap.blocker_after_swap, 1)
  assert.ok(swap.added.some(f => f.key === 'block:HANDOFF'))
  assert.equal(JSON.stringify(swap).includes('electronic-circuit'), false)
  const agg = aggregate([results])
  assert.equal(agg.tools.getInventoryItems.lost, 1)
  assert.equal(agg.tools.getInventoryItems.re_read, 1)
  assert.equal(agg.tools.getInventoryItems.re_read_rate, 1)
  assert.equal(agg.tools.getRecipeDetails.re_read, 0)
  assert.equal(agg.by_group['restaged/executor'].re_read, 1)
  assert.equal(agg.top[0].re_read, 1)
  assert.match(renderMarkdown(agg), /getInventoryItems/)
})

test('a fact carried inside the packet text is not counted as lost', () => {
  const before = prompt('2026-01-01T00:00:09.000Z', [system, assistant(call('b', 'getRecipeDetails', { item_or_recipe: 'lab' })), tool('b', RECIPE)])
  const packet = `[HANDOFF] Rebuilt from durable state.\nrecipe facts: ${RECIPE.replace(/,/g, ',  ')}`
  const after = prompt('2026-01-01T00:00:10.500Z', [system, { role: 'user', content: packet }])
  const [swap] = analyzeRun({
    prompts: [before, after],
    behavior: [swapRow('context.restaged', '2026-01-01T00:00:10.000Z', { role: 'executor' })],
  })
  assert.equal(swap.lost.length, 0)
  assert.deepEqual(swap.carried.map(f => [f.key, f.via]), [['tool:getRecipeDetails:{"item_or_recipe":"lab"}', 'text']])
  assert.equal(aggregate([[swap]]).tools.getRecipeDetails.carried_text, 1)
})

test('a swap with no prompt after it is reported but not analyzed', () => {
  const before = prompt('2026-01-01T00:00:09.000Z', [system, assistant(call('a', 'getInventoryItems')), tool('a', INVENTORY)])
  const results = analyzeRun({
    prompts: [before],
    behavior: [swapRow('context.restaged', '2026-01-01T00:00:10.000Z', { role: 'executor' })],
  })
  assert.equal(results[0].no_after, true)
  assert.equal(results[0].no_before, false)
  assert.deepEqual(results[0].lost, [])
  const agg = aggregate([results])
  assert.equal(agg.swaps_total, 1)
  assert.equal(agg.swaps_analyzed, 0)
  assert.equal(agg.no_after, 1)
})

test('prompts after the next swap, or from another actor, are not used for a swap', () => {
  const before = prompt('2026-01-01T00:00:09.000Z', [system, assistant(call('a', 'getInventoryItems')), tool('a', INVENTORY)])
  const otherActor = prompt('2026-01-01T00:00:10.500Z', [system, { role: 'user', content: '[HANDOFF] other' }], { actor_id: 99 })
  const afterNextSwap = prompt('2026-01-01T00:00:21.000Z', [system, { role: 'user', content: '[HANDOFF] later' }])
  const results = analyzeRun({
    prompts: [before, otherActor, afterNextSwap],
    behavior: [
      swapRow('context.restaged', '2026-01-01T00:00:10.000Z', { role: 'executor' }),
      swapRow('context.planner_resumed', '2026-01-01T00:00:20.000Z', { role: 'planner' }),
    ],
  })
  assert.equal(results[0].no_after, true)
  assert.equal(results[1].no_after, false)
  assert.equal(results[1].kind, 'planner_resumed')
})

test('malformed JSON lines are skipped', async () => {
  const good = JSON.stringify({ event: 'context.restaged', ts: '2026-01-01T00:00:10.000Z' })
  const text = `${good}\n{not json\n\n${good}\n{"truncated":`
  const parsed = parseJsonl(text)
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.malformed, 2)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restage-loss-'))
  try {
    const file = path.join(dir, 'rows.jsonl')
    fs.writeFileSync(file, text)
    const read = await readJsonlFile(file)
    assert.equal(read.rows.length, 2)
    assert.equal(read.malformed, 2)
    assert.equal((await readJsonlFile(path.join(dir, 'missing.jsonl'))).missing, true)
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('swapEvents reports a folded review handback as its own kind, with the checkpoint it folded into', () => {
  const events = swapEvents([
    swapRow('context.restaged', '2026-01-01T00:00:10.000Z', { role: 'executor', checkpoint: 'C8', handoff_id: 'h1', reason: 'context_over_hard_limit_at_step_close' }),
    swapRow('context.planner_resumed', '2026-01-01T00:00:20.000Z', { role: 'planner', handoff_id: 'h0', executor_kept: true }),
    swapRow('context.restage_folded', '2026-01-01T00:00:30.000Z', { role: 'executor', checkpoint: 'C8', handoff_id: 'h1', reason: 'review_handback_at_step_close' }),
  ])
  assert.deepEqual(events.map(e => e.kind), ['restaged', 'planner_resumed', 'restage_folded'])
  assert.deepEqual([events[2].role, events[2].checkpoint, events[2].handoff_id], ['executor', 'C8', 'h1'], 'the folded entry is the C8 conversation, resumed')
})
