import type { LuaForce, LuaSurface } from 'factorio:runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { craft_trigger_statistics_count, credit_craft_trigger_statistics, credit_finished_crafts } from './crafted_items'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).log = vi.fn()
  ;(globalThis as any).prototypes = { recipe: { lab: { products: [{ type: 'item', name: 'lab', amount: 1 }] } } }
})
function fixture() {
  const flow = vi.fn()
  const technology = { researched: false, enabled: true, prerequisites: { electronics: { researched: true } }, prototype: { research_trigger: { type: 'craft-item', item: { name: 'lab' }, count: 1 } } }
  const force = { index: 1, technologies: { red: technology }, get_item_production_statistics: () => ({ on_flow: flow }) } as unknown as LuaForce
  return { force, technology, flow, surface: {} as LuaSurface }
}
describe('standalone completed-craft research trigger flow', () => {
  it('credits only a queue completion and traces its exact native request', () => {
    const { force, surface, flow } = fixture()
    const sink = (item: string, count: number) => credit_craft_trigger_statistics(force, surface, item, count, 'native_craft/10/123')
    credit_finished_crafts(1, { lab: 1 }, { lab: 1 }, sink)
    expect(flow).not.toHaveBeenCalled()
    credit_finished_crafts(1, { lab: 1 }, {}, sink)
    expect(flow).toHaveBeenCalledExactlyOnceWith('lab', 1)
    expect(craft_trigger_statistics_count(1, 'lab')).toBe(1)
    expect((globalThis as any).log).toHaveBeenCalledWith('[AUTORIO] crafting.trigger_flow request_id=native_craft/10/123 reason=completed_native_craft item_name=lab count=1')
    credit_finished_crafts(1, {}, {}, sink)
    expect(flow).toHaveBeenCalledTimes(1)
  })
  it('ignores locked prerequisites, already researched triggers, and other products', () => {
    const { force, surface, flow, technology } = fixture()
    technology.prerequisites.electronics.researched = false
    credit_craft_trigger_statistics(force, surface, 'lab', 1, 'r')
    technology.prerequisites.electronics.researched = true
    technology.researched = true
    credit_craft_trigger_statistics(force, surface, 'lab', 1, 'r')
    technology.researched = false
    credit_craft_trigger_statistics(force, surface, 'stone-furnace', 1, 'r')
    credit_craft_trigger_statistics(force, surface, 'lab', 0, 'r')
    expect(flow).not.toHaveBeenCalled()
    expect(craft_trigger_statistics_count(1, 'lab')).toBe(0)
  })
})