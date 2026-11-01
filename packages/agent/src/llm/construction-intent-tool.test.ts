import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ raw: vi.fn() }))
vi.mock('factorio-rcon-api-client', () => ({ v2FactorioConsoleCommandRawPost: mocks.raw }))

import { constructionIntentTool } from './construction-intent-tool'

beforeEach(() => {
  mocks.raw.mockReset()
  mocks.raw.mockResolvedValue({ data: { output: '{"ok":true}' } })
})

describe('construction intent tool', () => {
  it('uses the actor surface by default and does not prepare mutation unless requested', async () => {
    await constructionIntentTool.fn({ parameters: { x: 64, y: 32, entity_name: 'assembling-machine-1' } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_map_construction", "intent", nil, 64, 32, \'assembling-machine-1\', nil, false)))',
    } })
  })

  it('renders bounded explicit surface/direction and prepare_execution', async () => {
    await constructionIntentTool.fn({ parameters: {
      surface_index: 2,
      x: -10.5,
      y: 20.5,
      entity_name: "mod's-machine",
      direction: 4,
      prepare_execution: true,
    } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_map_construction", "intent", 2, -10.5, 20.5, \'mod\\\'s-machine\', 4, true)))',
    } })
  })

  it('rejects unsafe or out-of-range parameters before RCON', async () => {
    await expect(constructionIntentTool.fn({ parameters: { x: 0, y: 0, entity_name: 'x\n/c game.clear()' } })).rejects.toThrow()
    await expect(constructionIntentTool.fn({ parameters: { surface_index: 0, x: 0, y: 0, entity_name: 'stone-furnace' } })).rejects.toThrow()
    await expect(constructionIntentTool.fn({ parameters: { x: 0, y: 0, entity_name: 'stone-furnace', direction: 16 } })).rejects.toThrow()
    await expect(constructionIntentTool.fn({ parameters: { x: 0, y: 0, entity_name: 'stone-furnace', extra: true } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })
})
