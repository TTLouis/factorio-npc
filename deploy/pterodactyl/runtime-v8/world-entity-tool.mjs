import { luaString, PolicyError } from '../staging/structured-policy.mjs'
const JSON_PREFIX = '/silent-command rcon.print(helpers.table_to_json('
function positive(value) { return Number.isSafeInteger(value) && value > 0 }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export const worldEntityFactsDefinition = { type: 'function', function: {
  name: 'getWorldEntityFacts', description: 'Read bounded exact current-world machine inputs, inventories, routes, progress, power, fluids and removal readiness. Native identity must already be bound by operator setup. Unknown/truncated facts never grant authority.',
  parameters: { type: 'object', additionalProperties: false, required: ['request_id', 'members'], properties: {
    request_id: { type: 'string', minLength: 1, maxLength: 160 },
    members: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false,
      required: ['unit_number', 'name', 'position', 'surface_index', 'force_index'], properties: {
        unit_number: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1, maxLength: 200 },
        position: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
        surface_index: { type: 'integer', minimum: 1 }, force_index: { type: 'integer', minimum: 1 },
      } } },
  } },
} }
export function renderWorldEntityFacts(args) {
  const valid = object(args) && Object.keys(args).every(key => ['request_id', 'members'].includes(key))
    && typeof args.request_id === 'string' && args.request_id.length > 0 && args.request_id.length <= 160
    && Array.isArray(args.members) && args.members.length > 0 && args.members.length <= 32
    && args.members.every(member => object(member) && Object.keys(member).every(key => ['unit_number', 'name', 'position', 'surface_index', 'force_index'].includes(key))
      && positive(member.unit_number) && positive(member.surface_index) && positive(member.force_index)
      && typeof member.name === 'string' && member.name.length > 0 && member.name.length <= 200
      && object(member.position) && Object.keys(member.position).every(key => ['x', 'y'].includes(key))
      && Number.isFinite(member.position.x) && Number.isFinite(member.position.y)
      && Math.abs(member.position.x) <= 1000000 && Math.abs(member.position.y) <= 1000000)
    && new Set(args.members.map(member => member.unit_number)).size === args.members.length
  if (!valid) throw new PolicyError('Invalid exact world entity request')
  return `${JSON_PREFIX}(function() if not remote.interfaces.sgluna_factory then return {ok=false,code="world_observation_unavailable"} end; local w=remote.call("sgluna_factory","world_identity"); if w.ok~=true then return w end; local g=remote.call("sgluna_deployment","status"); local q=helpers.json_to_table(${luaString(JSON.stringify(args))}); q.schema_version=1; q.world_id=w.world_id; q.actor_id=g.actor_id; q.surface_index=g.surface_index; q.force_index=g.force_index; return remote.call("sgluna_factory","observe",q) end)()))`
}
