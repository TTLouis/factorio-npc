// A committed cell intent is a semantic obligation, never world-operation authority.
// Names are claims; the enrollment boundary must validate them against live facts.
import { createHash } from 'node:crypto'

const NAME_PATTERN = '^[a-z0-9][a-z0-9_-]{0,79}$'
const PURPOSE_PATTERN = '^(?!\\s)(?![\\s\\S]*\\s$)[^\\u0000-\\u001f\\u007f]+$'
const name = value => typeof value === 'string' && new RegExp(NAME_PATTERN).test(value)
const FIELDS = ['kind', 'product', 'sourceEntity', 'targetEntity', 'purpose']

function invalid() {
  const error = new Error('Invalid committed factory cell intent; preserve the original obligation and refuse execution')
  error.code = 'factory_cell_intent_invalid'
  throw error
}

export const FACTORY_CELL_INTENT_SCHEMA = {
  description: 'Optional immutable assignment obligation for one newly placed direct-feed pair. Requires direct_feed materialSupply and deterministic completion; claims are checked against live native facts. This grants no operation permission. Null or absence declares no cell.',
  anyOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false, required: FIELDS,
    properties: {
      kind: { type: 'string', enum: ['direct_feed'] },
      product: { type: 'string', minLength: 1, maxLength: 80, pattern: NAME_PATTERN },
      sourceEntity: { type: 'string', minLength: 1, maxLength: 80, pattern: NAME_PATTERN },
      targetEntity: { type: 'string', minLength: 1, maxLength: 80, pattern: NAME_PATTERN },
      purpose: { type: 'string', minLength: 1, maxLength: 240, pattern: PURPOSE_PATTERN },
    },
  }],
}

export function normalizeFactoryCellIntent(value, materialSupply) {
  if (value === undefined || value === null) return null
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
  const supply = { mode: guidance.materialSupply.mode, resource: guidance.materialSupply.resource }
  return createHash('sha256').update(JSON.stringify([intent, supply])).digest('hex')
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
