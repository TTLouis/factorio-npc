import { beforeEach, describe, expect, it, vi } from 'vitest'

const actor_state: { actor: unknown } = { actor: undefined }

vi.mock('./actors/actor_controller', () => ({
  create_actor_remote_interface: () => {},
  get_controlled_actor: () => actor_state.actor,
}))

// Lua tables are both indexable and iterable with pairs(); the TS source
// iterates them with for..of, so the stand-in supports both.
function lua_table<T>(entries: Record<string, T>) {
  return Object.assign(Object.create({
    *[Symbol.iterator]() { yield* Object.entries(entries) },
  }), entries)
}

function force(rockets_launched: number) {
  return {
    index: 1,
    rockets_launched,
    technologies: lua_table({
      'automation': { enabled: true, researched: true },
      'rocket-silo': { enabled: true, researched: false },
    }),
    get_item_production_statistics: () => ({ get_input_count: () => 7 }),
  }
}

async function tools_interface() {
  const interfaces: Record<string, Record<string, (...args: any[]) => any>> = {}
  ;(globalThis as any).remote.add_interface = (name: string, functions: Record<string, (...args: any[]) => any>) => {
    interfaces[name] = functions
  }
  const { create_tools_remote_interface } = await import('./tools')
  create_tools_remote_interface()
  return interfaces.autorio_tools
}

beforeEach(() => {
  actor_state.actor = undefined
  ;(globalThis as any).script.active_mods = { base: '2.0.0' }
  ;(globalThis as any).prototypes = { item: { 'iron-gear-wheel': {} }, space_location: {} }
})

describe('goal conditions while the NPC body is dead', () => {
  it('reads force-level conditions from the player force when there is no live actor', async () => {
    ;(globalThis as any).game.forces = { player: force(2) }
    ;(globalThis as any).game.surfaces = new Map([[1, {}]])
    const tools = await tools_interface()

    expect(tools.evaluate_condition({ kind: 'rockets_launched', minimum: 1 })).toMatchObject({ ok: true, satisfied: true, current: 2 })
    expect(tools.evaluate_condition({ kind: 'research_completed', technology: 'automation' })).toMatchObject({ ok: true, satisfied: true })
    expect(tools.evaluate_condition({ kind: 'items_produced', item_name: 'iron-gear-wheel', minimum: 5 })).toMatchObject({ ok: true, current: 7 })
  })

  it('still needs a body for conditions about the NPC itself', async () => {
    ;(globalThis as any).game.forces = { player: force(0) }
    const tools = await tools_interface()

    expect(tools.evaluate_condition({ kind: 'inventory_count', item_name: 'iron-gear-wheel', minimum: 1 })).toEqual({ ok: false, error: 'no_actor' })
  })

  it('reports save progress facts without a body', async () => {
    ;(globalThis as any).game.forces = { player: force(1) }
    const tools = await tools_interface()

    expect(tools.goal_progress_facts({ technologies: ['automation', 'rocket-silo', 'not-a-tech'] })).toEqual({
      ok: true,
      rockets_launched: 1,
      researched_technologies: 1,
      enabled_technologies: 2,
      milestones: { 'automation': true, 'rocket-silo': false },
      space_age: false,
    })
  })

  it('prefers the live actor force when there is one', async () => {
    ;(globalThis as any).game.forces = { player: force(0) }
    actor_state.actor = { force: force(5) }
    const tools = await tools_interface()

    expect(tools.evaluate_condition({ kind: 'rockets_launched', minimum: 1 })).toMatchObject({ current: 5 })
  })
})
