import { completionContractSupported, sanitizeStepCompletionContract } from './step-completion.mjs'

export function normalizeStepCompletions(descriptions, values) {
  if (!Array.isArray(values) || values.length !== descriptions.length) {
    throw new Error('stepCompletions must contain exactly one completion declaration per plan step')
  }
  return values.map((value, index) => {
    if (value?.kind === 'deterministic') {
      const checkpoint = sanitizeStepCompletionContract(value.checkpoint)
      if (!completionContractSupported(checkpoint)) throw new Error(`stepCompletions[${index}] requires a supported checkpoint`)
      if (Object.keys(value).some(key => !['kind', 'checkpoint'].includes(key))) throw new Error(`stepCompletions[${index}] has unexpected fields`)
      return { kind: 'deterministic', checkpoint }
    }
    if (value?.kind === 'semantic' && typeof value.rationale === 'string' && value.rationale.trim()) {
      if (Object.keys(value).some(key => !['kind', 'rationale'].includes(key))) throw new Error(`stepCompletions[${index}] has unexpected fields`)
      return { kind: 'semantic', rationale: value.rationale.trim().slice(0, 600) }
    }
    throw new Error(`stepCompletions[${index}] must declare deterministic completion or a semantic assessment rationale`)
  })
}

export function completionContractSignature(contract) {
  const value = sanitizeStepCompletionContract(contract)
  return JSON.stringify({ mode: value.mode, requirements: value.requirements })
}
