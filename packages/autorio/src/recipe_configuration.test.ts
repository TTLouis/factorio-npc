import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import { new_recipe_configuration_runtime } from './recipe_configuration'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function machine(overrides: Record<string, unknown> = {}) {
  let currentRecipe: string | undefined
  let applySet = true
  const target = {
    valid: true,
    name: 'assembling-machine-1',
    type: 'assembling-machine',
    unit_number: 101,
    position: { x: 2, y: 0 },
    surface: { index: 1 },
    force: { index: 1 },
    prototype: { crafting_categories: { crafting: true } },
    get_recipe: vi.fn(() => [currentRecipe ? { name: currentRecipe } : undefined, undefined]),
    set_recipe: vi.fn((recipeName: string) => {
      if (applySet) currentRecipe = recipeName
    }),
    ...overrides,
  }
  return {
    target,
    setCurrentRecipe(name: string | undefined) { currentRecipe = name },
    setApplySet(value: boolean) { applySet = value },
  }
}

function context(recipeOverrides: Record<string, unknown> = {}) {
  const recipe = {
    name: 'iron-gear-wheel',
    enabled: true,
    // Match the real LuaRecipe shape: a single `category` plus
    // `additional_categories`. This previously mocked a `categories` array the
    // engine never provides, so the suite passed while every live
    // set_machine_recipe raised inside on_tick and killed the server.
    category: 'crafting',
    additional_categories: [],
    ...recipeOverrides,
  }
  const force = {
    index: 1,
    recipes: {
      'iron-gear-wheel': recipe,
    },
  }
  const actor = {
    is_valid: true,
    character: { valid: true },
    force,
    surface: { index: 1 },
    position: { x: 0, y: 0 },
    status_snapshot: vi.fn(() => ({
      actor_id: 18,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'Nova-1',
      position: { x: 0, y: 0 },
    })),
  } as unknown as ControlledActor
  const resolve = vi.fn(() => actor)
  const manager = new_task_manager(resolve)
  const controller = new_basic_operation_controller(resolve, manager)
  const runtime = new_recipe_configuration_runtime(manager, controller)
  return { actor, force, manager, controller, runtime }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
})

describe('exact machine recipe configuration', () => {
  it('sets and verifies the requested enabled compatible recipe on the exact machine', () => {
    const c = context()
    const m = machine()
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn((unit: number) => unit === 101 ? m.target : undefined)

    expect(c.controller.submit_set_recipe_exact(101, 'iron-gear-wheel')).toEqual([true, 'Task started'])
    c.runtime.state_setting_recipe(c.actor)

    expect(m.target.set_recipe).toHaveBeenCalledWith('iron-gear-wheel')
    expect(m.target.get_recipe).toHaveBeenCalledTimes(2)
    expect(c.controller.status().last_result).toMatchObject({
      code: 'completed',
      accepted: true,
      completed: true,
      target_unit_number: 101,
      recipe_name: 'iron-gear-wheel',
    })
    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('treats an already-matching recipe as idempotent success without resetting it', () => {
    const c = context()
    const m = machine()
    m.setCurrentRecipe('iron-gear-wheel')
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => m.target)

    expect(c.controller.submit_set_recipe_exact(101, 'iron-gear-wheel')[0]).toBe(true)
    c.runtime.state_setting_recipe(c.actor)

    expect(m.target.set_recipe).not.toHaveBeenCalled()
    expect(c.controller.status().last_result).toMatchObject({ code: 'completed', completed: true })
  })

  it.each([
    ['target_gone', undefined],
    ['different_surface', machine({ surface: { index: 2 } }).target],
    ['wrong_force', machine({ force: { index: 2 } }).target],
    ['too_far', machine({ position: { x: 9, y: 0 } }).target],
    ['not_recipe_machine', machine({ type: 'furnace' }).target],
    ['incompatible_recipe', machine({ prototype: { crafting_categories: { chemistry: true } } }).target],
  ])('fails closed with %s before mutating the machine', (expectedCode, target) => {
    const c = context()
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => target)

    expect(c.controller.submit_set_recipe_exact(101, 'iron-gear-wheel')[0]).toBe(true)
    c.runtime.state_setting_recipe(c.actor)

    if (target) expect((target as any).set_recipe).not.toHaveBeenCalled()
    expect(c.controller.status().last_result).toMatchObject({
      code: expectedCode,
      accepted: false,
      completed: false,
      target_unit_number: 101,
      recipe_name: 'iron-gear-wheel',
    })
    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('rejects missing and locked recipes without mutating the machine', () => {
    const m = machine()
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => m.target)

    const missing = context()
    ;(missing.force.recipes as any)['iron-gear-wheel'] = undefined
    expect(missing.controller.submit_set_recipe_exact(101, 'iron-gear-wheel')[0]).toBe(true)
    missing.runtime.state_setting_recipe(missing.actor)
    expect(missing.controller.status().last_result?.code).toBe('invalid_recipe')
    expect(m.target.set_recipe).not.toHaveBeenCalled()

    m.target.set_recipe.mockClear()
    const locked = context({ enabled: false })
    expect(locked.controller.submit_set_recipe_exact(101, 'iron-gear-wheel')[0]).toBe(true)
    locked.runtime.state_setting_recipe(locked.actor)
    expect(locked.controller.status().last_result?.code).toBe('recipe_disabled')
    expect(m.target.set_recipe).not.toHaveBeenCalled()
  })

  it('refuses to replace an existing different recipe implicitly', () => {
    const c = context()
    const m = machine()
    m.setCurrentRecipe('copper-cable')
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => m.target)

    expect(c.controller.submit_set_recipe_exact(101, 'iron-gear-wheel')[0]).toBe(true)
    c.runtime.state_setting_recipe(c.actor)

    expect(m.target.set_recipe).not.toHaveBeenCalled()
    expect(c.controller.status().last_result).toMatchObject({
      code: 'set_recipe_failed',
      accepted: false,
      completed: false,
    })
  })

  it('fails if Factorio does not report the requested recipe after set_recipe', () => {
    const c = context()
    const m = machine()
    m.setApplySet(false)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => m.target)

    expect(c.controller.submit_set_recipe_exact(101, 'iron-gear-wheel')[0]).toBe(true)
    c.runtime.state_setting_recipe(c.actor)

    expect(m.target.set_recipe).toHaveBeenCalledWith('iron-gear-wheel')
    expect(c.controller.status().last_result).toMatchObject({
      code: 'set_recipe_failed',
      accepted: false,
      completed: false,
    })
  })
})
