import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_corpse_recovery_controller, note_npc_corpse, note_npc_death } from './corpse_recovery'
import { selected_weapon_readiness } from './equipment'

const trace = vi.fn()

function stack(name?: string, count = 0, metadata: any = {}) {
  return {
    valid: true, valid_for_read: !!name, name, count, ...metadata,
    transfer_stack: vi.fn(function (this: any, source: any, amount: number) {
      if (this.valid_for_read || !source.valid_for_read) return false
      const moved = Math.min(amount, source.count)
      Object.assign(this, { ...source, transfer_stack: this.transfer_stack, count: moved })
      source.count -= moved
      source.valid_for_read = source.count > 0
      return source.count === 0
    }),
  }
}

function inventory(stacks: any[]) {
  const value: any = stacks
  value.valid = true
  value.is_empty = () => !stacks.some(item => item.valid_for_read)
  value.get_contents = () => stacks.filter(item => item.valid_for_read).map(item => ({ name: item.name, count: item.count, quality: item.quality }))
  return value
}

function world(death_actor_id = 42) {
  ;(globalThis as any).storage.standalone_character_unit_number = death_actor_id
  const original: any = {
    valid: true, type: 'character', unit_number: death_actor_id, force: { index: 1 },
    surface: { index: 1 }, position: { x: 0, y: 0 },
  }
  const recoveredArmor = stack('modular-armor', 1, { quality: { name: 'rare' }, grid: { equipment: [{ name: 'battery-equipment' }] }, durability: 17 })
  const corpseInventory = inventory([recoveredArmor, stack('iron-plate', 23)])
  const corpse: any = {
    valid: true, type: 'character-corpse', unit_number: 77,
    surface: { index: 1 }, force: { index: 1 },
    position: { x: 0, y: 0 }, get_inventory: () => corpseInventory,
  }
  const main = inventory([stack(), stack()])
  const guns: any = [stack('pistol', 1, { prototype: { attack_parameters: { ammo_categories: ['bullet'] } } })]
  const ammo: any = [stack('firearm-magazine', 7, { prototype: { ammo_category: { name: 'bullet' } } })]
  const character: any = {
    selected_gun_index: 1, reach_distance: 8,
    get_inventory: (kind: unknown) => kind === (globalThis as any).defines.inventory.character_guns ? guns : ammo,
  }
  const actor: any = {
    is_valid: true, character, surface: { index: 1 }, force: { index: 1 }, position: { x: 0, y: 0 },
    status_snapshot: () => ({ actor_id: 43, kind: 'standalone_character', npc_id: 'npc-1' }),
    get_main_inventory: () => main,
  }
  const controller = new_corpse_recovery_controller(() => actor)
  const death: any = { entity: original, tick: 100 }
  const post: any = { unit_number: death_actor_id, tick: 100, surface_index: 1, corpses: [corpse] }
  note_npc_death(death)
  note_npc_corpse(post)
  return { actor, character, guns, ammo, main, corpse, corpseInventory, recoveredArmor, controller, death, post }
}

beforeEach(() => {
  trace.mockClear()
  ;(globalThis as any).log = trace
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).storage = { sgluna_actor_mode: 'npc', standalone_character_unit_number: 42, standalone_npc_identity: { id: 'npc-1' } }
})

describe('durable native NPC corpse recovery', () => {
  it('binds native corpses to the exact owned dying actor, rejecting nearby foreign evidence', () => {
    const w = world()
    note_npc_death({ ...w.death, entity: { ...w.death.entity, unit_number: 99 } })
    expect(w.controller.status().corpses).toHaveLength(1)
    expect(trace).toHaveBeenCalledWith('[AUTORIO] corpse.recorded request_id=native_death/42 reason=npc_death')
    expect(w.controller.recover('npc-corpse/99/100', 1, 1, 43, 'foreign', 1)).toMatchObject({ accepted: false, reason: 'corpse_not_owned' })
    expect(w.corpseInventory[0].count).toBe(1)
  })

  it('requires compatible equipped ammo, exact actor binding and physical reach before mutation', () => {
    const w = world()
    w.ammo[0].prototype.ammo_category.name = 'rocket'
    expect(selected_weapon_readiness(w.character)).toMatchObject({ ready: false, reason: 'incompatible_equipped_ammo' })
    expect(w.controller.recover('npc-corpse/42/100', 2, 100, 43, 'unarmed', 2).reason).toBe('compatible_weapon_and_ammo_required')
    w.ammo[0].prototype.ammo_category.name = 'bullet'
    expect(w.controller.recover('npc-corpse/42/100', 2, 100, 42, 'stale', 3).reason).toBe('actor_changed')
    w.actor.position = { x: 30, y: 0 }
    expect(w.controller.recover('npc-corpse/42/100', 2, 100, 43, 'distant', 4).reason).toBe('too_far')
    expect(w.corpseInventory[1].count).toBe(23)
  })

  it('moves native stacks with metadata intact, retaining partial recovery for another trip', () => {
    const w = world()
    const partial = w.controller.recover('npc-corpse/42/100', 1, 1, 43, 'trip-1', 5)
    expect(partial).toMatchObject({ accepted: true, reason: 'partial', moved_count: 1, moved_slots: 1 })
    expect(trace).toHaveBeenCalledWith('[AUTORIO] corpse.recovery request_id=trip-1 reason=partial moved_count=1')
    expect(w.main[0]).toMatchObject({ name: 'modular-armor', quality: { name: 'rare' }, durability: 17, grid: { equipment: [{ name: 'battery-equipment' }] } })
    expect(w.controller.status().corpses[0].state).toBe('partial')
    expect(w.controller.recover('npc-corpse/42/100', 1, 1, 43, 'trip-1', 5)).toEqual(partial)
    expect(w.corpseInventory[1].count).toBe(23)
    expect(w.controller.recover('npc-corpse/42/100', 1, 23, 43, 'trip-2', 6)).toMatchObject({ reason: 'recovered', moved_count: 23 })
    expect(w.corpse.valid).toBe(true)
  })

  it('preserves a full corpse when inventory is full and native expiry becomes lost', () => {
    const w = world()
    w.main[0].valid_for_read = true
    w.main[1].valid_for_read = true
    expect(w.controller.recover('npc-corpse/42/100', 2, 100, 43, 'full', 7)).toMatchObject({ reason: 'inventory_full', moved_count: 0 })
    expect(w.corpseInventory[1].count).toBe(23)
    w.corpse.valid = false
    expect(w.controller.status().corpses[0]).toMatchObject({ state: 'lost', reason: 'native_corpse_unavailable' })
  })

  it('retains partial evidence and duplicate guards when the controller is reconstructed', () => {
    const w = world()
    const first = w.controller.recover('npc-corpse/42/100', 1, 1, 43, 'restart', 8)
    const restarted = new_corpse_recovery_controller(() => w.actor)
    expect(restarted.status().corpses[0].state).toBe('partial')
    expect(restarted.recover('npc-corpse/42/100', 1, 1, 43, 'restart', 8)).toEqual(first)
    expect(w.corpseInventory[1].count).toBe(23)
  })

  it('rejects invalid bounds and unrelated NPC identity without moving items', () => {
    const w = world()
    expect(w.controller.recover('npc-corpse/42/100', 17, 1, 43, 'bounds', 9).reason).toBe('invalid_request')
    w.actor.status_snapshot = () => ({ actor_id: 43, kind: 'standalone_character', npc_id: 'other-npc' })
    expect(w.controller.recover('npc-corpse/42/100', 1, 1, 43, 'identity', 10).reason).toBe('corpse_not_owned')
    expect(w.corpseInventory[0].count).toBe(1)
  })

  it('rejects conflicting reuse of a recovery request without returning old success', () => {
    const w = world()
    const receipt = w.controller.recover('npc-corpse/42/100', 1, 1, 43, 'original', 1)
    expect(receipt.reason).toBe('partial')
    for (const args of [
      ['npc-corpse/99/100', 1, 1, 43, 'original', 1],
      ['npc-corpse/42/100', 2, 1, 43, 'original', 1],
      ['npc-corpse/42/100', 1, 2, 43, 'original', 1],
      ['npc-corpse/42/100', 1, 1, 44, 'original', 1],
      ['npc-corpse/42/100', 1, 1, 43, 'original', 2],
    ] as const) {
      expect(w.controller.recover(...args)).toMatchObject({ accepted: false, reason: 'duplicate_conflict', moved_count: 0 })
    }
    expect(w.controller.recover('npc-corpse/42/100', 1, 1, 43, 'original', 1)).toEqual(receipt)
    expect(w.corpseInventory[1].count).toBe(23)
  })

  it('fences an expired and pruned request ordinal even against a new available corpse', () => {
    const w = world()
    w.controller.recover('npc-corpse/42/100', 1, 1, 43, 'expired', 1)
    w.corpse.valid = false
    w.controller.status()
    const persisted = (globalThis as any).storage
    const closed = persisted.sgluna_corpses[0]
    for (let i = 0; i < 32; i++) persisted.sgluna_corpses.push({ ...closed, previous_actor_id: 100 + i, corpse_ref: `older-${i}` })
    w.controller.status()
    expect(persisted.sgluna_corpse_results).toEqual([])
    const next = world(44)
    expect(next.controller.recover('npc-corpse/44/100', 1, 1, 43, 'expired', 1)).toMatchObject({ accepted: false, reason: 'stale_operation_ordinal', moved_count: 0 })
    expect(next.corpseInventory[0].count).toBe(1)
    expect(next.controller.recover('npc-corpse/44/100', 1, 1, 43, 'new-attempt', 2).moved_count).toBe(1)
  })

  it('rejects a corpse moved to another surface at identical coordinates or changed force', () => {
    const w = world()
    w.corpse.surface.index = 2
    expect(w.controller.recover('npc-corpse/42/100', 1, 1, 43, 'surface', 1).reason).toBe('corpse_surface_or_force_changed')
    w.corpse.surface.index = 1
    w.corpse.force.index = 2
    expect(w.controller.recover('npc-corpse/42/100', 1, 1, 43, 'force', 2).reason).toBe('corpse_surface_or_force_changed')
    expect(w.corpseInventory[0].count).toBe(1)
  })
})
