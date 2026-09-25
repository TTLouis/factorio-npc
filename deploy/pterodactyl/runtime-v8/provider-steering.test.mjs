import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applySteeringMessages,
  buildSteeringContext,
  classifyUserSteering,
  providerRequest,
  selectReasoningPolicy,
} from './provider.mjs'

function planState(overrides = {}) {
  return `[PLAN_STATE] Harness-owned durable goal/plan state.\n${JSON.stringify({
    goal_id: 'goal_1',
    owner: 'TTLouis',
    objective: 'rebuild the burner miner and furnace layout',
    status: 'active',
    plan: ['place miner', 'place furnace', 'fuel and verify'],
    current_step: 1,
    current_step_text: 'place furnace',
    last_operations: ['place_entity {"entity_name":"burner-mining-drill","x":51,"y":49,"direction":8}'],
    ...overrides,
  })}`
}

test('latest human message steers pending intent without discarding completed evidence', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: planState() },
    { role: 'user', content: '[CHAT] TTLouis: 炉子放远一点，别再贴着矿机碰撞' },
  ]

  assert.deepEqual(classifyUserSteering(messages), {
    mode: 'steer_existing_goal',
    sender: 'TTLouis',
    text: '炉子放远一点，别再贴着矿机碰撞',
    goal_id: 'goal_1',
    goal_status: 'active',
    active_step: 'place furnace',
  })

  const steering = buildSteeringContext(messages)
  assert.match(steering, /^\[STEERING\]/)
  assert.match(steering, /user_mode=steer_existing_goal/)
  assert.match(steering, /latest human instruction is authoritative for pending intent/)
  assert.match(steering, /preserve verified completed evidence/)
  assert.match(steering, /domain=construction/)
  assert.match(steering, /physical collision footprint != mining\/working area/)
})

test('the original durable objective is not misclassified as a fresh mid-plan steering event', () => {
  const messages = [
    { role: 'user', content: planState() },
    { role: 'user', content: '[CHAT] TTLouis: rebuild the burner miner and furnace layout' },
    { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {}' },
  ]
  const steering = classifyUserSteering(messages)
  assert.equal(steering.mode, 'current_goal')
  const context = buildSteeringContext(messages)
  assert.match(context, /user_mode=current_goal/)
  assert.match(context, /not a new mid-plan steering event/)
})

test('bare continue resumes the durable goal instead of becoming a replacement goal', () => {
  const steering = classifyUserSteering([
    { role: 'user', content: planState({ status: 'paused' }) },
    { role: 'user', content: '[CHAT] TTLouis: 继续吧' },
  ])
  assert.equal(steering.mode, 'resume_existing_goal')
})

test('placement failures produce a compact geometry-aware recovery hint', () => {
  const context = buildSteeringContext([
    { role: 'user', content: planState() },
    { role: 'user', content: '[CHAT] TTLouis: 继续重建' },
    { role: 'user', content: '[MOD] Autorio operation error: placing:not_placeable. Detailed task receipt: {}' },
  ])
  assert.match(context, /placement_failure/)
  assert.match(context, /do not retry the same coordinate blindly/)
  assert.match(context, /footprint\/blocker geometry/)
})

test('too_far failures steer away from walk-action-model ping-pong', () => {
  const context = buildSteeringContext([
    { role: 'user', content: planState({ last_operations: ['move_items_exact {"unit_number":582}'] }) },
    { role: 'user', content: '[CHAT] TTLouis: 给炉子加煤' },
    { role: 'user', content: '[MOD] Autorio operation error: moving_items:too_far. Detailed task receipt: {}' },
  ])
  assert.match(context, /range_failure/)
  assert.match(context, /do not create a walk\/action\/model loop/)
})

test('terrain goals steer the model toward live tile observations instead of entity guesses', () => {
  const context = buildSteeringContext([
    { role: 'user', content: '[CHAT] TTLouis: 你到水边了，沿着岸边看看' },
  ])
  assert.match(context, /domain=terrain/)
  assert.match(context, /getLocalSpatialObservation/)
  assert.match(context, /tile runs/)
  assert.match(context, /water is a tile, not an entity/)
})

test('dynamic steering prefers local completion without becoming a route solver', () => {
  const context = buildSteeringContext([
    { role: 'user', content: planState({
      current_step_text: 'fuel and configure the local furnace before returning to the miner patch',
      last_operations: [
        'move_items_exact {"unit_number":582,"item_name":"coal","max_count":10,"to_entity":true}',
        'set_machine_recipe {"unit_number":583,"recipe_name":"iron-gear-wheel"}',
      ],
    }) },
    { role: 'user', content: '[CHAT] TTLouis: 继续' },
  ])
  assert.match(context, /locality=before intentionally crossing to another area/)
  assert.match(context, /known current-area targets/)
  assert.match(context, /do not invent targets or reorder user constraints, prerequisites, or observation-dependent work/)
})

test('steering is inserted before a MOD receipt so completion remains the final observation', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: planState() },
    { role: 'user', content: '[CHAT] TTLouis: rebuild it' },
    { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {}' },
  ]
  const output = applySteeringMessages(messages)
  assert.match(output.at(-2).content, /^\[STEERING\]/)
  assert.match(output.at(-1).content, /^\[MOD\]/)
})

test('steering is inserted before a HARNESS recovery instruction so strict recovery remains final', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '[CHAT] TTLouis: 你到水边了' },
    { role: 'user', content: '[HARNESS] Tool call rejected (1/2): Unapproved tool: getMapTiles. Retry using only an approved tool name and strict JSON arguments matching its schema. Do not repeat the rejected payload.' },
  ]
  const output = applySteeringMessages(messages)
  assert.match(output.at(-2).content, /^\[STEERING\]/)
  assert.match(output.at(-1).content, /^\[HARNESS\]/)
})

test('provider request injects steering while preserving compact completion behavior', async () => {
  let body
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body)
    return new Response(JSON.stringify({
      id: 'resp-steering',
      model: 'test-model',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  await providerRequest({
    base: 'https://provider.example/v1',
    key: 'test-key',
    model: 'test-model',
    timeoutMs: 5000,
  }, [
    { role: 'system', content: 'FULL SYSTEM PROMPT '.repeat(50) },
    { role: 'user', content: planState() },
    { role: 'user', content: '[CHAT] TTLouis: rebuild it' },
    { role: 'assistant', content: '{"chatMessage":"","plan":["place miner","place furnace"],"currentStep":0,"operations":[{"name":"place_entity","args":{"entity_name":"burner-mining-drill","x":51,"y":49}}]}' },
    { role: 'user', content: `[MOD] Autorio operation batch completed. Detailed task receipt: ${JSON.stringify({
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
      last_completed_batch: { batch_id: 9, task_count: 1, task_types: ['placing'], tick: 500 },
    })}` },
  ], { fetchImpl, allowTools: true, recoveryAttempt: 0 })

  assert.equal(body.max_tokens, 8000)
  assert.match(body.messages.at(-2).content, /^\[STEERING\]/)
  assert.match(body.messages.at(-2).content, /last_receipt=completed batch=9 tasks=placing/)
  assert.match(body.messages.at(-1).content, /Compact task receipt/)
})


test('action omission repair stays low reasoning even though it is a bounded recovery call', () => {
  const policy = selectReasoningPolicy({
    model: 'deepseek-chat',
    profile: 'deepseek',
  }, [
    { role: 'user', content: '[CHAT] TTLouis: continue' },
  ], {
    recoveryAttempt: 1,
    actionOmissionRepair: true,
  })
  assert.deepEqual(policy, { effort: 'low', reason: 'action_omission_repair' })
})
