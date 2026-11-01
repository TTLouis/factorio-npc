import assert from 'node:assert/strict'
import test from 'node:test'

import { compactCompletionMessages } from './provider.mjs'

test('compact continuation prompt batches deterministic work at observation boundaries', () => {
  const messages = compactCompletionMessages([
    { role: 'system', content: 'full prompt' },
    { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {}' },
  ])
  const prompt = messages[0].content

  assert.match(prompt, /observation\/decision boundary, not as an operation boundary/)
  assert.match(prompt, /2-4 consecutive operations/)
  assert.match(prompt, /Prefer local completion over ping-pong movement/)
  assert.match(prompt, /known targets in the current area/)
  assert.match(prompt, /Do not invent targets or reorder user constraints, prerequisites, or observation-dependent work/)
  assert.match(prompt, /Do not insert wait between finite Autorio operations/)
  assert.match(prompt, /do not walk SGLuna onto an exact future build coordinate/i)
  assert.match(prompt, /placing:not_placeable/)
  assert.match(prompt, /walk_to_entity_exact/)
  assert.match(prompt, /walk_to_position/)
  assert.match(prompt, /mine_entity_exact/)
  assert.match(prompt, /mine_resource_at/)
  assert.match(prompt, /rotate_entity/)
})
