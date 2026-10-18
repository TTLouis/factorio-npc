import { beforeEach, expect, it, vi } from 'vitest'
import { fluid_source_observation } from './fluid_source_observation'
import { create_placement_candidate_set, execute_placement_candidate, placement_candidate_matches, placement_candidate_preflight, placement_candidates_for_actor } from './placement_candidates'
import { plan_placement } from './construction_planning'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { new_task_manager } from './task_manager'

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).pairs = Object.entries
  ;(globalThis as any).prototypes = { fluid: { water: {} }, tile: { water: { fluid: { name: 'water' } } }, item: { 'test-pump': {} }, entity: {
    'test-pump': { name: 'test-pump', type: 'offshore-pump', tile_width: 1, tile_height: 1, flags: {},
      items_to_place_this: [{ name: 'test-pump', count: 1 }] },
  } }
})
function fixture() {
  let actorId = 18
  const surface = { index: 1, is_chunk_generated: () => true, find_entities_filtered: () => [],
    can_place_entity: vi.fn(() => true), create_entity: vi.fn(),
    find_tiles_filtered: vi.fn((args: any) => args.has_hidden_tile ? [] : [{ name: 'water', position: { x: 46, y: 23 },
      prototype: { fluid: { name: 'water' } }, surface: { index: 1 } }]),
  }
  const inventory = { get_item_count: () => 1, remove: vi.fn() }
  const actor = { is_valid: true, character: { valid: true }, force: { index: 1 }, position: { x: 15, y: -88 }, surface,
    status_snapshot: () => ({ actor_id: actorId, kind: 'standalone_character' }),
    set_walking_state: vi.fn(), set_mining_state: vi.fn(), set_shooting_state: vi.fn(),
    get_main_inventory: () => inventory,
  } as any
  const manager = new_task_manager(() => actor)
  const basic = new_basic_operation_controller(() => actor, manager)
  const read = () => fluid_source_observation(actor, { fluid_name: 'water', search_radius: 256 })
  const candidates = () => create_placement_candidate_set(actor, { entity_name: 'test-pump', radius: 2, limit: 2 }) as any
  return { actor, surface, basic, manager, inventory, read, candidates, replace: () => { actorId++ } }
}
it('refuses an offshore candidate scan until water is read, including modded pump names', () => {
  const f = fixture()
  expect(f.candidates()).toMatchObject({ ok: false, code: 'water_search_required' })
  expect(f.surface.can_place_entity).not.toHaveBeenCalled()
  expect(f.surface.find_tiles_filtered).not.toHaveBeenCalled()
})
it('water-first discovery searches the observed shoreline instead of the actor dry-land neighborhood', () => {
  const f = fixture(); f.read()
  const result = f.candidates()
  expect(result.ok).toBe(true)
  expect(result.center).toEqual({ x: 46, y: 23 })
  expect(f.surface.find_tiles_filtered.mock.invocationCallOrder[0]).toBeLessThan(f.surface.can_place_entity.mock.invocationCallOrder[0])
})
it('raw pump placement is refused with omitted or explicit coordinates, without queueing or spending inventory', () => {
  const f = fixture(); f.read(); f.candidates()
  expect(f.basic.submit_placement('test-pump')).toBe(false)
  expect(f.basic.submit_placement('test-pump', 46.5, 23.5, 0)).toBe(false)
  expect(f.manager.get_status_snapshot().queue_length).toBe(0)
  expect(f.basic.status().last_result).toMatchObject({ accepted: false, code: 'placement_candidate_required' })
})
it('only exact native registry identity and geometry can queue a pump', () => {
  const f = fixture(); f.read(); const set = f.candidates(); const c = set.candidates[0]
  const proof = { candidate_set_id: set.candidate_set_id, candidate_id: c.id }
  expect(f.basic.submit_placement('test-pump', c.position.x + 1, c.position.y, c.direction, proof)).toBe(false)
  expect(f.basic.submit_placement('test-pump', c.position.x, c.position.y, c.direction, { ...proof, candidate_id: 'invented' })).toBe(false)
  expect(execute_placement_candidate(f.actor, proof.candidate_set_id, proof.candidate_id, f.basic.submit_placement)[0]).toBe(true)
  expect(f.manager.player_state.parameters_place_entity?.placement_candidate).toEqual(proof)
})
it.each(['actor', 'surface', 'force', 'expired', 'clock-rewind', 'world'] as const)('rejects a %s-stale pump candidate', kind => {
  const f = fixture(); f.read(); const set = f.candidates(); const c = set.candidates[0]
  if (kind === 'actor') f.replace()
  if (kind === 'surface') f.actor.surface.index++
  if (kind === 'force') f.actor.force.index++
  if (kind === 'expired') (globalThis as any).game.tick = set.expires_tick + 1
  if (kind === 'clock-rewind') (globalThis as any).game.tick = 99
  if (kind === 'world') f.surface.can_place_entity.mockReturnValue(false)
  expect(placement_candidate_preflight(f.actor, set.candidate_set_id, c.id)).toMatchObject({ ok: false, code: 'placement_candidate_unavailable' })
  expect(placement_candidate_matches(f.actor, { candidate_set_id: set.candidate_set_id, candidate_id: c.id }, 'test-pump', c.position.x, c.position.y, c.direction)).toBe(false)
})
it('an expired water read cannot authorize a new scan', () => {
  const f = fixture(); f.read(); (globalThis as any).game.tick += 3601
  expect(placement_candidates_for_actor(f.actor, { entity_name: 'test-pump' })).toMatchObject({ code: 'water_search_required' })
  expect(f.surface.can_place_entity).not.toHaveBeenCalled()
})

it('queued legacy raw pump tasks cannot execute after loading or bypass native candidate proof', () => {
  const f = fixture(); f.actor.position = { x: 46, y: 23 }
  ;(globalThis as any).prototypes.entity['test-pump'].type = 'furnace'
  expect(f.basic.submit_placement('test-pump', 46.5, 23.5, 0)).toBe(true)
  ;(globalThis as any).prototypes.entity['test-pump'].type = 'offshore-pump'
  new_basic_operation_runtime(f.manager, f.basic).state_placing(f.actor)
  expect(f.basic.status().last_result).toMatchObject({ code: 'placement_candidate_unavailable' })
  expect(f.surface.create_entity).not.toHaveBeenCalled()
  expect(f.inventory.remove).not.toHaveBeenCalled()
})
it('a valid queued pump candidate is revalidated before native mutation', () => {
  const f = fixture(); f.actor.position = { x: 46, y: 23 }; f.read(); const set = f.candidates()
  expect(execute_placement_candidate(f.actor, set.candidate_set_id, set.candidates[0].id, f.basic.submit_placement)[0]).toBe(true)
  f.surface.can_place_entity.mockReturnValue(false)
  new_basic_operation_runtime(f.manager, f.basic).state_placing(f.actor)
  expect(f.basic.status().last_result).toMatchObject({ code: 'placement_candidate_unavailable' })
  expect(f.surface.create_entity).not.toHaveBeenCalled()
  expect(f.inventory.remove).not.toHaveBeenCalled()
})

it('generic placement planning cannot scan pump geometry without the water-first candidate pipeline', () => {
  const f = fixture()
  expect(plan_placement(f.actor, { entity_name: 'test-pump' })).toMatchObject({ ok: false, error: { code: 'PLACEMENT_CANDIDATE_REQUIRED' } })
  expect(f.surface.can_place_entity).not.toHaveBeenCalled()
})
it('reports bounded native super-force terrain rules as preparation hints without scanning or granting placement', () => {
  const f = fixture()
  ;(globalThis as any).prototypes.entity['test-pump'].tile_buildability_rules = Array.from({ length: 12 }, () => ({
    area: { left_top: { x: -1, y: -2 }, right_bottom: { x: 1, y: -1 } },
    required_tiles: { layers: { water_tile: true } }, colliding_tiles: { layers: {} }, remove_on_collision: false,
  }))
  const result = f.candidates()
  expect(result.terrain_preparation).toMatchObject({ source: 'native_prototype_tile_buildability_rules', orientation: 'north_unrotated', truncated: true, placement_authority: false })
  expect(result.terrain_preparation.rules).toHaveLength(8)
  expect(result.terrain_preparation.rules[0].required_tiles.layers).toEqual(['water_tile'])
  expect(f.surface.can_place_entity).not.toHaveBeenCalled()
})
