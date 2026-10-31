import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { parseInventoryCounts } from './inventory-facts.mjs'
import { compileQuantities } from './quantity-compiler.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/factory-bh-cell-use-baseline.json', import.meta.url)))

test('original BH callable bootstrap accepts typed iron reuse despite its original visible copper mining facts', async () => {
  const { baseline, sources, native_tool_replies: replies } = fixture
  assert.equal(baseline.source, '775043dca74f89ed37dccb2118e1d0d1ec033d16')
  const step = structuredClone(baseline.committed_plan.steps[0])
  assert.deepEqual(step.execution_guidance.materialSupply, { mode: 'direct_feed', resource: 'iron-ore' })
  const originalDrill = JSON.parse(baseline.records.find(row => row.original_tool_data?.name === 'getEntityStatus').original_tool_data.output)
  assert.deepEqual(originalDrill.entity.spatial.mining.resource_coverage.map(row => row.name), ['copper-ore'])
  for (const source of Object.values(sources)) assert.equal(createHash('sha256').update(source.text).digest('hex'), source.sha256)
  const stripImports = source => source.replace(/^import .*\r?\n/gm, '').replaceAll('export ', '')
  const original = vm.runInNewContext(`${stripImports(sources['direct-feed-bootstrap.mjs'].text)}\n${stripImports(sources['direct-feed-bootstrap-runtime.mjs'].text)}\ndirectFeedBootstrapRefusal`,
    { parseInventoryCounts, compileQuantities })
  const reads = []; const traces = []
  // Historical explicit tool replies are unchanged. The implicit bootstrap
  // replies and placement ledger were not captured: provide an explicitly
  // controlled placement prerequisite, empty stock, and unavailable missing
  // recipe reads. None of these supplies an iron source or changes copper.
  const agent = { activePlanKey: () => 'historical-bh', traceRequest: { id: 'baseline-bh-control' },
    memory: { authorizationState: () => ({ world: { npc_placements: [
      { unit_number: 38, entity_name: 'burner-mining-drill' }, { unit_number: 39, entity_name: 'stone-furnace' },
    ] } }) }, observationToolCommand: (tool, args) => JSON.stringify({ tool, args }),
    traceEvent: async (event, data) => traces.push({ event, data }),
    rcon: { command: async text => {
      const { tool, args } = JSON.parse(text); reads.push({ tool, args })
      if (tool === 'getInventoryItems') return '[]'
      if (tool === 'getEntityStatus' && args.unit_number === 38) return JSON.stringify(originalDrill)
      const key = `${tool}/${args.resource_or_item ?? args.item_or_recipe ?? args.unit_number}`
      return replies[key]?.output ?? '{}'
    } },
  }
  const result = await original(agent, { executionGuidance: [step.execution_guidance],
    stepCompletions: [{ kind: 'deterministic', checkpoint: step.completion_contract, obligations: step.obligations }] })
  assert.equal(result, undefined, 'old callable boundary accepts this request, rather than failing due to a missing new API')
  assert.equal(traces[0].data.verdict, 'feasible', JSON.stringify(traces))
  assert.ok(reads.some(row => row.tool === 'getEntityStatus' && row.args.unit_number === 38))
  assert.deepEqual(step, baseline.committed_plan.steps[0])
})
