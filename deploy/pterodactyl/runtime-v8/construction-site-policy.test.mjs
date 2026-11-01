import test from 'node:test'
import assert from 'node:assert/strict'
import { toolCommand, toolDefinitions } from './structured-policy.mjs'

test('Pterodactyl runtime-v8 exposes bounded findConstructionSites schema', () => {
  const tool = toolDefinitions.find(tool => tool.function.name === 'findConstructionSites')
  assert.ok(tool)
  assert.equal(tool.function.parameters.additionalProperties, false)
  assert.deepEqual(tool.function.parameters.required, ['width', 'height'])
  assert.equal(tool.function.parameters.properties.width.minimum, 2)
  assert.equal(tool.function.parameters.properties.width.maximum, 32)
  assert.equal(tool.function.parameters.properties.height.minimum, 2)
  assert.equal(tool.function.parameters.properties.height.maximum, 32)
  assert.equal(tool.function.parameters.properties.search_radius.minimum, 2)
  assert.equal(tool.function.parameters.properties.search_radius.maximum, 64)
  assert.equal(tool.function.parameters.properties.max_candidates.maximum, 8)
  assert.equal(tool.function.parameters.properties.position.additionalProperties, false)
  assert.match(tool.function.description, /not a machine layout or construction approval/i)
})

test('Pterodactyl runtime-v8 renders findConstructionSites with an exact anchor', () => {
  assert.equal(toolCommand('findConstructionSites', {
    width: 12,
    height: 8,
    anchor_unit_number: 4242,
    search_radius: 32,
    max_candidates: 4,
  }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","find_construction_sites",{width=12,height=8,anchor_unit_number=4242,search_radius=32,max_candidates=4})))')
})

test('Pterodactyl runtime-v8 renders findConstructionSites with a position anchor', () => {
  assert.equal(toolCommand('findConstructionSites', {
    width: 6,
    height: 10,
    position: { x: 12.5, y: -4 },
  }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","find_construction_sites",{width=6,height=10,position={x=12.5,y=-4}})))')
})

test('Pterodactyl runtime-v8 rejects unsafe or out-of-bound site requests', () => {
  for (const request of [
    { width: 1, height: 8 },
    { width: 33, height: 8 },
    { width: 8.5, height: 8 },
    { width: 8, height: 1 },
    { width: 8, height: 33 },
    { width: 8, height: 8, anchor_unit_number: 0 },
    { width: 8, height: 8, anchor_unit_number: 42, position: { x: 0, y: 0 } },
    { width: 8, height: 8, position: { x: 0, y: 0, z: 0 } },
    { width: 8, height: 8, position: { x: 1000001, y: 0 } },
    { width: 8, height: 8, search_radius: 1 },
    { width: 8, height: 8, search_radius: 65 },
    { width: 8, height: 8, max_candidates: 0 },
    { width: 8, height: 8, max_candidates: 9 },
    { width: 8, height: 8, lua: 'game.clear()' },
  ]) assert.throws(() => toolCommand('findConstructionSites', request))
})

test('Pterodactyl runtime-v8 site exposure preserves the base allowlist boundary', () => {
  assert.equal(toolCommand('getActorStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor","status")))')
  assert.throws(() => toolCommand('findConstructionSites', { width: 8 }))
  assert.throws(() => toolCommand('shell', {}))
})
