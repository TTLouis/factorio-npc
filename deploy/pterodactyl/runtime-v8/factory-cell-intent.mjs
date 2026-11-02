// A committed cell intent is a semantic obligation, never world-operation authority.
// Names are claims; the enrollment boundary must validate them against live facts.
import { createHash } from 'node:crypto'

const NAME_PATTERN = '^[a-z0-9][a-z0-9_-]{0,79}$'
const PURPOSE_PATTERN = '^(?!\\s)(?![\\s\\S]+\\s$)[^\\u0000-\\u001f\\u007f]+$'
const name = value => typeof value === 'string' && new RegExp(NAME_PATTERN).test(value)
const FIELDS = ['kind', 'product', 'sourceEntity', 'targetEntity', 'purpose']

function invalid() {
  const error = new Error('Invalid committed factory cell intent; preserve the original obligation and refuse execution')
  error.code = 'factory_cell_intent_invalid'
  throw error
}

export const FACTORY_CELL_INTENT_SCHEMA = {
  description: 'Immutable assignment obligation for a new production block, with exact role-to-placement receipt enrollment. Direct-feed pairs retain their materialSupply requirement; production_block supports miner, machine and power roles, including repeated prototypes. Native facts validate every assigned output. This grants no operation permission. Null or absence never exempts typed production/materialSupply/checkpoint operations from runtime cell-use resolution.',
  anyOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false, required: FIELDS,
    properties: {
      kind: { type: 'string', enum: ['direct_feed'] },
      product: { type: 'string', minLength: 1, maxLength: 80, pattern: NAME_PATTERN },
      sourceEntity: { type: 'string', minLength: 1, maxLength: 80, pattern: NAME_PATTERN },
      targetEntity: { type: 'string', minLength: 1, maxLength: 80, pattern: NAME_PATTERN },
      purpose: { type: 'string', minLength: 1, maxLength: 240, pattern: PURPOSE_PATTERN },
    },
  }, {
    type: 'object', additionalProperties: false, required: ['kind', 'purpose', 'members', 'outputs'],
    properties: {
      kind: { type: 'string', enum: ['production_block'] },
      purpose: { type: 'string', minLength: 1, maxLength: 240, pattern: PURPOSE_PATTERN },
      members: { type: 'array', minItems: 1, maxItems: 32, items: {
        type: 'object', additionalProperties: false, required: ['role', 'entity'], properties: {
          role: { type: 'string', minLength: 1, maxLength: 80, pattern: NAME_PATTERN },
          entity: { type: 'string', minLength: 1, maxLength: 80, pattern: NAME_PATTERN },
        },
      } },
      outputs: { type: 'array', minItems: 1, maxItems: 32, items: {
        type: 'object', additionalProperties: false, required: ['role', 'kind', 'resource'], properties: {
          role: { type: 'string', minLength: 1, maxLength: 80, pattern: NAME_PATTERN },
          kind: { type: 'string', enum: ['item', 'fluid', 'power'] },
          resource: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 80, pattern: NAME_PATTERN }] },
        },
      } },
    },
  }],
}

export function normalizeFactoryCellIntent(value, materialSupply) {
  if (value === undefined || value === null) return null
  if (value?.kind === 'production_block') {
    if (Object.keys(value).length !== 4 || Object.keys(value).some(key => !['kind', 'purpose', 'members', 'outputs'].includes(key))
      || typeof value.purpose !== 'string' || value.purpose.length > 240 || !new RegExp(PURPOSE_PATTERN).test(value.purpose)
      || !Array.isArray(value.members) || value.members.length < 1 || value.members.length > 32
      || !Array.isArray(value.outputs) || value.outputs.length < 1 || value.outputs.length > 32) invalid()
    const roles = new Set()
    const members = value.members.map(row => {
      if (!row || Object.keys(row).length !== 2 || !Object.hasOwn(row, 'role') || !Object.hasOwn(row, 'entity')
        || !name(row.role) || !name(row.entity) || roles.has(row.role)) invalid()
      roles.add(row.role)
      return { role: row.role, entity: row.entity }
    })
    const outputs = value.outputs.map(row => {
      if (!row || Object.keys(row).length !== 3 || !Object.hasOwn(row, 'role') || !Object.hasOwn(row, 'kind') || !Object.hasOwn(row, 'resource')
        || !roles.has(row.role) || !['item', 'fluid', 'power'].includes(row.kind)
        || (row.kind === 'power' ? row.resource !== null : !name(row.resource))) invalid()
      return { role: row.role, kind: row.kind, resource: row.resource }
    })
    if (new Set(outputs.map(row => JSON.stringify(row))).size !== outputs.length) invalid()
    return { kind: 'production_block', purpose: value.purpose, members, outputs }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== FIELDS.length || Object.keys(value).some(key => !FIELDS.includes(key))
    || value.kind !== 'direct_feed' || !name(value.product) || !name(value.sourceEntity) || !name(value.targetEntity)
    || value.sourceEntity === value.targetEntity
    || typeof value.purpose !== 'string' || !value.purpose.trim() || value.purpose.trim() !== value.purpose || value.purpose.length > 240
    || /[\u0000-\u001f\u007f]/.test(value.purpose)
    || !materialSupply || typeof materialSupply !== 'object' || Array.isArray(materialSupply)
    || Object.keys(materialSupply).length !== 2 || Object.keys(materialSupply).some(key => !['mode', 'resource'].includes(key))
    || materialSupply.mode !== 'direct_feed' || !name(materialSupply.resource)) invalid()
  return { kind: value.kind, product: value.product, sourceEntity: value.sourceEntity, targetEntity: value.targetEntity, purpose: value.purpose }
}

export function readFactoryCellIntent(guidance) {
  if (guidance && Object.hasOwn(guidance, 'cellIntentFault')) invalid()
  return normalizeFactoryCellIntent(guidance?.cellIntent, guidance?.materialSupply)
}

export function committedFactoryCellIntent(step) {
  const intent = readFactoryCellIntent(step?.execution_guidance)
  if (intent && step?.completion_mode !== 'deterministic') invalid()
  return intent
}

export function factoryCellIntentSignature(guidance) {
  const intent = readFactoryCellIntent(guidance)
  if (!intent) return null
  const supply = guidance.materialSupply ? { mode: guidance.materialSupply.mode, resource: guidance.materialSupply.resource } : null
  return createHash('sha256').update(JSON.stringify([intent, supply])).digest('hex')
}

export function factoryIntentMembers(intent) {
  return intent.kind === 'production_block' ? intent.members
    : [{ role: 'source', entity: intent.sourceEntity }, { role: 'target', entity: intent.targetEntity }]
}
export function factoryIntentOutputs(intent) {
  return intent.kind === 'production_block' ? intent.outputs : [{ role: 'target', kind: 'item', resource: intent.product }]
}
export function factoryIntentAssignment(intent) {
  return { products: [...new Set(factoryIntentOutputs(intent).filter(row => row.kind !== 'power').map(row => row.resource))],
    purpose: intent.purpose, method: intent.kind }
}
export function factoryIntentPorts(intent) {
  return factoryIntentOutputs(intent).map((row, index) => ({ port_id: intent.kind === 'direct_feed' ? 'output' : `output-${index + 1}`,
    direction: 'output', kind: row.kind, ...(row.kind === 'power' ? {} : { resource: row.resource }) }))
}

export function validFactoryCellIntentStep(step) {
  try { committedFactoryCellIntent(step); return true }
  catch { return false }
}

// A preserved semantic step cannot change its assignment or selected resource.
export function factoryCellIntentPreserved(original, successor) {
  if (!validFactoryCellIntentStep(original) || !validFactoryCellIntentStep(successor)) return false
  const before = original?.execution_guidance
  const after = successor?.execution_guidance
  if (!before?.cellIntent && !after?.cellIntent) return true
  return JSON.stringify(before?.cellIntent) === JSON.stringify(after?.cellIntent)
    && JSON.stringify(before?.materialSupply) === JSON.stringify(after?.materialSupply)
}
