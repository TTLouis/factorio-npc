import type { ControlledActor } from './actors/types'
import { expect, it, vi } from 'vitest'
import { navigation_position_preflight } from './navigation_position_preflight'

function fixture() {
  const mask = { layers: { player: true } }
  const character = { valid: true, name: 'character', prototype: {
    collision_box: { left_top: { x: -0.2, y: -0.2 }, right_bottom: { x: 0.2, y: 0.2 } }, collision_mask: mask } }
  const furnace = { valid: true, name: 'modded-furnace', type: 'furnace', direction: 0, unit_number: 25,
    position: { x: 16, y: -96 }, prototype: { collision_mask: mask },
    bounding_box: { left_top: { x: 15.3, y: -96.7 }, right_bottom: { x: 16.7, y: -95.3 } } }
  const scan = vi.fn(() => [furnace])
  const actor = { is_valid: true, character, surface: { find_entities_filtered: scan } } as unknown as ControlledActor
  return { actor, character, furnace, scan }
}

it('refuses a goal circle entirely inside a furnace/character collision expansion', () => {
  const f = fixture()
  expect(navigation_position_preflight(f.actor, { x: 16, y: -96, reach_distance: 0.75 }))
    .toMatchObject({ ok: false, code: 'navigation_position_inside_furnace_collision', obstacle: { unit_number: 25 } })
  expect(f.scan).toHaveBeenCalledWith({ position: { x: 16, y: -96 }, radius: 16, type: 'furnace', limit: 64 })
  expect(navigation_position_preflight(f.actor, { x: 16, y: -96, reach_distance: 1 })).toMatchObject({ ok: true })
  expect(navigation_position_preflight(f.actor, { x: 17.25, y: -96, reach_distance: 0.75 })).toMatchObject({ ok: true })
})

it('does not invent obstruction proofs for noncolliding, invalid or diagonally rotated targets', () => {
  const f = fixture(); const args = { x: 16, y: -96 }
  f.furnace.prototype.collision_mask = { layers: { object: true } } as any
  expect(navigation_position_preflight(f.actor, args)).toMatchObject({ ok: true })
  f.furnace.prototype.collision_mask = f.character.prototype.collision_mask
  f.furnace.direction = 2
  expect(navigation_position_preflight(f.actor, args)).toMatchObject({ ok: true })
  f.furnace.direction = 0; f.furnace.valid = false
  expect(navigation_position_preflight(f.actor, args)).toMatchObject({ ok: true })
  f.furnace.valid = true; f.furnace.bounding_box.left_top.x = Number.NaN
  expect(navigation_position_preflight(f.actor, args)).toMatchObject({ ok: true })
})

it('validates actor, finite position and native reach bounds before scanning', () => {
  const f = fixture()
  for (const args of [{ x: Number.NaN, y: 0 }, { x: 0, y: Infinity }, { x: 0, y: 0, reach_distance: 0.1 }, { x: 0, y: 0, reach_distance: 65 }]) {
    expect(navigation_position_preflight(f.actor, args).ok).toBe(false)
  }
  expect(navigation_position_preflight(undefined, { x: 0, y: 0 }).ok).toBe(false)
  expect(f.scan).not.toHaveBeenCalled()
})

it('defers mask self-exemption even across differently named prototypes', () => {
  const f = fixture()
  Object.assign(f.character.prototype.collision_mask, { not_colliding_with_itself: true })
  expect(f.character.name).not.toBe(f.furnace.name)
  expect(navigation_position_preflight(f.actor, { x: 16, y: -96, reach_distance: 0.75 })).toMatchObject({ ok: true })
})

it('does not infer collision from empty character or furnace boxes', () => {
  const emptyCharacter = fixture()
  emptyCharacter.character.prototype.collision_box = { left_top: { x: 0, y: 0 }, right_bottom: { x: 0, y: 0 } }
  expect(navigation_position_preflight(emptyCharacter.actor, { x: 16, y: -96, reach_distance: 0.25 })).toMatchObject({ ok: true })
  const emptyFurnace = fixture()
  emptyFurnace.character.prototype.collision_box = { left_top: { x: -0.4, y: -0.4 }, right_bottom: { x: 0.4, y: 0.4 } }
  emptyFurnace.furnace.bounding_box = { left_top: { x: 16, y: -96 }, right_bottom: { x: 16, y: -96 } }
  expect(navigation_position_preflight(emptyFurnace.actor, { x: 16, y: -96, reach_distance: 0.25 })).toMatchObject({ ok: true })
})
