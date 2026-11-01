import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ raw: vi.fn() }))
vi.mock('factorio-rcon-api-client', () => ({
  v2FactorioConsoleCommandRawPost: mocks.raw,
}))

import { constructionSiteSchema, findConstructionSitesTool, renderConstructionSiteRequest } from './construction-site-tool'
import { agentTools } from './tool-set'

beforeEach(() => {
  mocks.raw.mockReset()
  mocks.raw.mockResolvedValue({ data: { output: '{"ok":true}' } })
})

describe('findConstructionSites ordinary-agent tool', () => {
  it('is part of the ordinary agent tool surface', () => {
    expect(agentTools.some(tool => tool.name === 'findConstructionSites')).toBe(true)
  })

  it('renders one bounded site request and calls the planning remote', async () => {
    const parameters = {
      width: 12,
      height: 8,
      position: { x: 10.5, y: -4.5 },
      search_radius: 32,
      max_candidates: 4,
    }
    expect(renderConstructionSiteRequest(parameters)).toBe('{width=12,height=8,position={x=10.5,y=-4.5},search_radius=32,max_candidates=4}')
    await findConstructionSitesTool.fn({ parameters })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning", "find_construction_sites", {width=12,height=8,position={x=10.5,y=-4.5},search_radius=32,max_candidates=4})))',
    } })
    expect(findConstructionSitesTool.description).toContain('not a machine layout')
  })

  it('rejects unsafe bounds, conflicting anchors, and extra fields before RCON', () => {
    expect(() => constructionSiteSchema.parse({ width: 33, height: 8 })).toThrow()
    expect(() => constructionSiteSchema.parse({ width: 8, height: 8, anchor_unit_number: 1, position: { x: 0, y: 0 } })).toThrow()
    expect(() => constructionSiteSchema.parse({ width: 8, height: 8, search_radius: 65 })).toThrow()
    expect(() => constructionSiteSchema.parse({ width: 8, height: 8, max_candidates: 9 })).toThrow()
    expect(() => constructionSiteSchema.parse({ width: 8, height: 8, unexpected: true })).toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })
})
