// The legacy Python geometry fixture uses the real journaled host admission path.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { luaString, parseOperation, renderOperation } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'

let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
const connection = new Rcon(request.port, request.password, 5000, { host: request.host })
const transcript = []
const rcon = { command: async command => {
  const response = await connection.command(command)
  transcript.push({ command, response })
  return response
} }
try {
  await connection.connect()
  await configureNpcSession(rcon, `exact-mining-${randomUUID()}`)
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  assert.equal(actor.actor_id, request.actor_id)
  const world = JSON.parse(await rcon.command(`/silent-command local id=storage.sgluna_factory_world_id or ${luaString(randomUUID())};rcon.print(helpers.table_to_json(remote.call("sgluna_factory","bind_world_id",id)))`))
  assert.equal(world.ok, true)
  const correlation = { protocol_version: 2, operation_key: `exact-mining/${randomUUID()}`, attempt_id: randomUUID(), signature: `mine-exact-${request.unit_number}`,
    actor: { actor_id: actor.actor_id, epoch: actor.epoch }, ordinal: 1, surface_index: request.surface_index }
  const operation = parseOperation({ name: 'mine_entity_exact', args: { unit_number: request.unit_number } })
  const acknowledgement = await executeAuthorizedBatch(rcon, actor.epoch, [renderOperation(operation)], undefined, correlation)
  console.log(JSON.stringify({ accepted: true, correlation, acknowledgement, transcript }))
}
finally { connection.close() }
