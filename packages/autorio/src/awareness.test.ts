import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_awareness_controller } from './awareness'
import { is_chunk_known_charted, is_chunk_known_visible, map_knowledge_summary } from './map_knowledge'

function make_actor(kind = 'standalone_character') {
  const surface: any = {
    index: 1,
    valid: true,
    request_to_generate_chunks: vi.fn(),
    force_generate_chunk_requests: vi.fn(),
    create_entity: vi.fn(),
    get_chunks: vi.fn(() => []),
  }
  // Zero connected players: the engine charts nothing for the force.
  const force: any = {
    index: 1,
    connected_players: [],
    chart: vi.fn(),
    is_chunk_charted: vi.fn(() => false),
    is_chunk_visible: vi.fn(() => false),
  }
  const actor = {
    position: { x: 40, y: -1 },
    surface,
    force,
    status_snapshot: vi.fn(() => ({
      kind,
      valid: true,
      name: 'AIRI',
      position: actor.position,
      has_character: true,
      actor_id: 9,
    })),
  } as unknown as ControlledActor
  return { actor, surface, force }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 1
  ;(globalThis as any).game.get_surface = vi.fn()
})

describe('standalone NPC map knowledge', () => {
  it('loads and charts the 5x5 window without a radar or a synchronous generation drain', () => {
    const { actor, surface, force } = make_actor()
    const controller = new_awareness_controller()

    expect(controller.tick(actor)).toBe(true)
    expect(surface.create_entity).not.toHaveBeenCalled()
    expect(surface.request_to_generate_chunks).toHaveBeenCalledWith(actor.position, 2)
    expect(surface.force_generate_chunk_requests).not.toHaveBeenCalled()
    // Chunk (1, -1): the window spans chunks -1..3 by -3..1.
    expect(force.chart).toHaveBeenCalledWith(surface, {
      left_top: { x: -32, y: -96 },
      right_bottom: { x: 127, y: 63 },
    })
  })

  it('treats the window as visible and explored even though the engine charted nothing', () => {
    const { actor, surface, force } = make_actor()
    new_awareness_controller().tick(actor)

    expect(is_chunk_known_visible(force, surface, { x: 3, y: 1 })).toBe(true)
    expect(is_chunk_known_visible(force, surface, { x: 4, y: 1 })).toBe(false)
    expect(is_chunk_known_charted(force, surface, { x: -1, y: -3 })).toBe(true)
    expect(is_chunk_known_charted(force, surface, { x: -2, y: -3 })).toBe(false)
    expect(map_knowledge_summary(force)).toMatchObject({ explored_chunks: 25, push_queue: 0 })
  })

  it('keeps explored chunks after the NPC moves on, but only the new window is visible', () => {
    const { actor, surface, force } = make_actor()
    const controller = new_awareness_controller()
    controller.tick(actor)
    ;(actor.position as any).x = 40 + 32 * 10
    expect(controller.tick(actor)).toBe(true)

    expect(is_chunk_known_charted(force, surface, { x: 1, y: -1 })).toBe(true)
    expect(is_chunk_known_visible(force, surface, { x: 1, y: -1 })).toBe(false)
    expect(is_chunk_known_visible(force, surface, { x: 11, y: -1 })).toBe(true)
    expect(map_knowledge_summary(force)).toMatchObject({ explored_chunks: 50 })
  })

  it('does not reload while the NPC stays in the same chunk', () => {
    const { actor, surface } = make_actor()
    const controller = new_awareness_controller()
    controller.tick(actor)
    ;(actor.position as any).x = 47
    ;(actor.position as any).y = -16
    expect(controller.tick(actor)).toBe(false)
    expect(surface.request_to_generate_chunks).toHaveBeenCalledTimes(1)
  })

  it('does not give map knowledge to a connected human actor', () => {
    const { actor, surface, force } = make_actor('connected_player')
    expect(new_awareness_controller().tick(actor)).toBe(false)
    expect(surface.request_to_generate_chunks).not.toHaveBeenCalled()
    expect(is_chunk_known_visible(force, surface, { x: 1, y: -1 })).toBe(false)
  })

  it('retires the companion radar a pre-change save still holds', () => {
    const { actor } = make_actor()
    const radar = { valid: true, destroy: vi.fn() }
    ;(globalThis as any).storage.airi_awareness_radar = radar
    new_awareness_controller().tick(actor)
    expect(radar.destroy).toHaveBeenCalledTimes(1)
    expect((globalThis as any).storage.airi_awareness_radar).toBeUndefined()
  })

  it('pushes the explored map when a player joins and pulls what players charted', () => {
    const { actor, surface, force } = make_actor()
    const controller = new_awareness_controller()
    controller.tick(actor)
    force.chart.mockClear()
    ;(globalThis as any).game.get_surface = vi.fn(() => surface)

    // A player joins; the engine has charted a chunk the NPC never saw.
    force.connected_players = [{}]
    force.is_chunk_charted.mockImplementation((_s: unknown, chunk: { x: number, y: number }) => chunk.x === 30 && chunk.y === 30)
    surface.get_chunks.mockReturnValue([{ x: 30, y: 30 }, { x: 1, y: -1 }])
    ;(globalThis as any).game.tick = 60
    controller.tick(actor)

    expect(is_chunk_known_charted(force, surface, { x: 30, y: 30 })).toBe(true)
    // 25 explored chunks are queued; each tick charts at most 8 of them.
    expect(force.chart).toHaveBeenCalledTimes(8)
    for (let tick = 61; tick < 64; tick++) {
      ;(globalThis as any).game.tick = tick
      controller.tick(actor)
    }
    expect(force.chart).toHaveBeenCalledTimes(25)
    expect(map_knowledge_summary(force)).toMatchObject({ push_queue: 0 })
  })
})
