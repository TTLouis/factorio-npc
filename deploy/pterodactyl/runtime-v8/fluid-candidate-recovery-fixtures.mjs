import fs from 'node:fs'
import { planReply } from './task-loop-fixtures.mjs'
import { fluidFixture } from './fluid-preservation-fixtures.mjs'

// Reuse the real-loop fixture without importing/running its test registrations.
const directory = new URL('./', import.meta.url)
const source = fs.readFileSync(new URL('./fluid-preservation-lifecycle.test.mjs', import.meta.url), 'utf8')
const prefix = source.slice(0, source.indexOf("test('real prepared ledger")).replaceAll("from './", `from '${directory.href}`)
const fixture = import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { world, KEY }`).toString('base64')}`)
export const KEY = 'npc:fluid-fixture'

export async function candidateWorld({ response, executor, repeated = false, ...options } = {}) {
  const { world, KEY: actualKey } = await fixture
  if (actualKey !== KEY) throw new Error('Shared fluid fixture identity changed')
  let round = 0; let originalSteps
  const nativeReads = []
  const w = world({ ...options,
    response: async context => {
      const { text } = context
      nativeReads.push(text)
      const changed = await response?.(context)
      if (changed !== undefined) return changed
      if (text.includes('get_placement_candidates')) return { ok: true, entity_name: 'boiler', candidate_set_id: 'placement-2',
        candidates: [{ id: 'candidate-2', position: { x: 0, y: 3 }, direction: 0, connects_to: fluidFixture().admission.candidate.connects_to }] }
      const bad = text.includes('placement-1') && text.includes('candidate-1')
      if (text.includes('autorio_preflight') && text.includes('place_candidate') && bad) return {
        ok: true, preservation_clears_count: 0, preservation_eligibility: { version: 1, kind: 'relation_required',
          actor_id: 10, surface_index: 1, force_index: 1, candidate_set_id: 'placement-1', candidate_id: 'candidate-1',
          entity_name: 'boiler', generated_tick: 80, observed_tick: 90, fluid_port_count: 3 } }
      if (text.includes('fluid_preservation_candidate') && bad) return { ok: false, code: 'preservation_guard_candidate_unavailable' }
    },
    executorReply: async context => {
      const { held, step } = context
      if (held.active_step_index !== 0) return undefined
      originalSteps ??= structuredClone(held.steps)
      const replacement = await executor?.({ ...context, round })
      if (replacement !== undefined) { round++; return replacement }
      if (round++ === 0 || repeated) return planReply({ stepId: step.step_id,
        operations: [{ name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }] })
      if (round === 2) return { content: '', tool_calls: [{ id: 'fresh-fluid-relation', index: 0, type: 'function',
        function: { name: 'getPlacementCandidates', arguments: JSON.stringify({ entity_name: 'boiler', connects_to: { unit_number: 1 }, radius: 4, limit: 1 }) } }] }
      return planReply({ stepId: step.step_id,
        operations: [{ name: 'place_candidate', args: { candidate_set_id: 'placement-2', candidate_id: 'candidate-2' } }] })
    } })
  return Object.assign(w, { originalSteps: () => originalSteps, rounds: () => round, nativeReads })
}
