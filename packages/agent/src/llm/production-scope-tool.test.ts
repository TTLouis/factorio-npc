import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ raw: vi.fn() }))
vi.mock('factorio-rcon-api-client', () => ({
  v2FactorioConsoleCommandRawPost: mocks.raw,
}))

import { getProductionScopeTool, productionScopeSchema, renderProductionScopeRequest } from './production-scope-tool'
import { agentTools } from './tool-set'

beforeEach(() => {
  mocks.raw.mockReset()
  mocks.raw.mockResolvedValue({ data: { output: '{"ok":true}' } })
})

describe('getProductionScope ordinary-agent tool', () => {
  it('is part of the ordinary agent tool surface', () => {
    expect(agentTools.some(tool => tool.name === 'getProductionScope')).toBe(true)
  })

  it('renders a bounded facts-only scope request without a target rate', async () => {
    const parameters = {
      calculation_id: 'green-scope',
      target: { type: 'item' as const, name: 'electronic-circuit' },
      max_depth: 3,
      max_materials: 16,
    }
    expect(renderProductionScopeRequest(parameters)).toBe("{calculation_id='green-scope',target={type='item',name='electronic-circuit'},max_depth=3,max_materials=16}")
    await getProductionScopeTool.fn({ parameters })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: "/silent-command rcon.print(helpers.table_to_json(remote.call(\"autorio_planning\", \"scope_context\", {calculation_id='green-scope',target={type='item',name='electronic-circuit'},max_depth=3,max_materials=16})))",
    } })
    expect(getProductionScopeTool.description).toContain('never recommends or selects target_rate')
  })

  it('rejects a model-provided rate or unsafe bounds before RCON', () => {
    expect(() => productionScopeSchema.parse({ calculation_id: 'x', target: { type: 'item', name: 'iron-plate', rate_per_second: 5 } })).toThrow()
    expect(() => productionScopeSchema.parse({ calculation_id: 'x', target: { type: 'item', name: 'iron-plate' }, max_depth: 7 })).toThrow()
    expect(() => productionScopeSchema.parse({ calculation_id: 'x', target: { type: 'item', name: 'iron-plate' }, max_materials: 33 })).toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })
})
