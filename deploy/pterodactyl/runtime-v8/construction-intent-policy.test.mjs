import test from 'node:test'
import assert from 'node:assert/strict'
import { toolCommand, toolDefinitions } from './structured-policy.mjs'

test('Pterodactyl exposes one compact construction intent tool', () => {
  const tool = toolDefinitions.find(entry => entry.function.name === 'inspectConstructionIntent')
  assert.ok(tool)
  assert.deepEqual(tool.function.parameters.required, ['x', 'y', 'entity_name'])
  assert.equal(tool.function.parameters.properties.direction.maximum, 15)
})

test('construction intent defaults to actor surface and observation-only preparation false', () => {
  assert.equal(
    toolCommand('inspectConstructionIntent', { x: 64, y: 32, entity_name: 'assembling-machine-1' }),
    "/silent-command rcon.print(helpers.table_to_json(remote.call(\"autorio_map_construction\",\"intent\",nil,64,32,'assembling-machine-1',nil,false)))",
  )
})

test('construction intent validates explicit remote target and preparation token request', () => {
  const command = toolCommand('inspectConstructionIntent', {
    surface_index: 2,
    x: -10.5,
    y: 20.5,
    entity_name: 'assembling-machine-2',
    direction: 4,
    prepare_execution: true,
  })
  assert.match(command, /"autorio_map_construction","intent",2,-10\.5,20\.5,'assembling-machine-2',4,true/)
  assert.throws(() => toolCommand('inspectConstructionIntent', { x: 0, y: 0, entity_name: 'x\n/c game.clear()' }))
  assert.throws(() => toolCommand('inspectConstructionIntent', { surface_index: 0, x: 0, y: 0, entity_name: 'stone-furnace' }))
  assert.throws(() => toolCommand('inspectConstructionIntent', { x: 0, y: 0, entity_name: 'stone-furnace', direction: 16 }))
  assert.throws(() => toolCommand('inspectConstructionIntent', { x: 0, y: 0, entity_name: 'stone-furnace', extra: true }))
})
