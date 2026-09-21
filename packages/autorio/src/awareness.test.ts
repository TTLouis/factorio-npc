import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_awareness_controller } from './awareness'

function make_actor(kind = 'standalone_character') {
  const radar: any = {
    valid: true,
    surface: { index: 1 },
    teleport: vi.fn(),
    destroy: vi.fn(),
  }
  const surface: any = {
    index: 1,
    request_to_generate_chunks: vi.fn(),
    force_generate_chunk_requests: vi.fn(),
    create_entity: vi.fn(() => radar),
  }
  radar.surface = surface
  const actor = {
    position: { x: 40, y: -1 },
    surface,
    force: { index: 1 },
    status_snapshot: vi.fn(() => ({
      kind,
      valid: true,
      name: 'AIRI',
      position: actor.position,
      has_character: true,
      actor_id: 9,
    })),
  } as unknown as ControlledActor
  return { actor, surface, radar }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('standalone NPC awareness radar', () => {
  it('creates a hidden companion and queues the 3x3 terrain window without a synchronous generation drain', () => {
    const { actor, surface, radar } = make_actor()
    const controller = new_awareness_controller()

    expect(controller.tick(actor)).toBe(true)
    expect(surface.create_entity).toHaveBeenCalledWith({
      name: 'airi-npc-awareness-radar',
      position: actor.position,
      force: actor.force,
    })
    expect(radar.destructible).toBe(false)
    expect(radar.minable_flag).toBe(false)
    expect(radar.operable).toBe(false)
    expect(surface.request_to_generate_chunks).toHaveBeenCalledWith(actor.position, 1)
    expect(surface.force_generate_chunk_requests).not.toHaveBeenCalled()
  })

  it('does not teleport or regenerate while AIRI remains in the same chunk', () => {
    const { actor, surface, radar } = make_actor()
    const controller = new_awareness_controller()

    controller.tick(actor)
    ;(actor.position as any).x = 47
    ;(actor.position as any).y = -16
    expect(controller.tick(actor)).toBe(false)

    expect(radar.teleport).not.toHaveBeenCalled()
    expect(surface.request_to_generate_chunks).toHaveBeenCalledTimes(1)
    expect(surface.force_generate_chunk_requests).not.toHaveBeenCalled()
  })

  it('moves the companion exactly once after crossing a chunk boundary', () => {
    const { actor, surface, radar } = make_actor()
    const controller = new_awareness_controller()

    controller.tick(actor)
    ;(actor.position as any).x = 64
    expect(controller.tick(actor)).toBe(true)

    expect(radar.teleport).toHaveBeenCalledTimes(1)
    expect(radar.teleport).toHaveBeenLastCalledWith(actor.position)
    expect(surface.request_to_generate_chunks).toHaveBeenCalledTimes(2)
    expect(surface.force_generate_chunk_requests).not.toHaveBeenCalled()
  })

  it('destroys the companion instead of giving radar awareness to a connected human actor', () => {
    const { actor, surface, radar } = make_actor()
    const controller = new_awareness_controller()
    controller.tick(actor)
    ;(actor.status_snapshot as any).mockReturnValue({
      kind: 'connected_player',
      valid: true,
      name: 'TTLouis',
      position: actor.position,
      has_character: true,
      actor_id: 1,
    })

    expect(controller.tick(actor)).toBe(false)
    expect(radar.destroy).toHaveBeenCalledTimes(1)
    expect(surface.request_to_generate_chunks).toHaveBeenCalledTimes(1)
  })
})
