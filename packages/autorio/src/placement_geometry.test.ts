import { describe, expect, it } from 'vitest'
import {
  placement_footprint,
  placement_footprint_covers_point,
  placement_grid_check,
  placement_grid_rule,
  snap_placement_center,
} from './placement_geometry'

describe('shared placement geometry', () => {
  it('uses whole-coordinate centers for even-sized entities', () => {
    const prototype = {
      tile_width: 2,
      tile_height: 2,
      collision_box: {
        left_top: { x: -0.9, y: -0.9 },
        right_bottom: { x: 0.9, y: 0.9 },
      },
    }

    expect(placement_grid_rule(prototype, 0)).toEqual({ x_offset: 0, y_offset: 0 })
    expect(snap_placement_center(prototype, { x: -70.5, y: -10.5 }, 0)).toEqual({ x: -70, y: -10 })
    expect(placement_grid_check(prototype, { x: -70.5, y: -10.5 }, 0)).toMatchObject({
      valid: false,
      snapped_position: { x: -70, y: -10 },
    })
    expect(placement_grid_check(prototype, { x: -70, y: -10 }, 0).valid).toBe(true)
  })

  it('swaps non-square footprint grid rules when rotated east or west', () => {
    const prototype = {
      tile_width: 1,
      tile_height: 2,
      collision_box: {
        left_top: { x: -0.4, y: -0.9 },
        right_bottom: { x: 0.4, y: 0.9 },
      },
    }

    expect(placement_grid_rule(prototype, 0)).toEqual({ x_offset: 0.5, y_offset: 0 })
    expect(placement_grid_rule(prototype, 4)).toEqual({ x_offset: 0, y_offset: 0.5 })

    const north = placement_footprint(prototype, { x: 0.5, y: 0 }, 0)
    expect(north).toMatchObject({
      tile_width: 1,
      tile_height: 2,
      tile_box: {
        left_top: { x: 0, y: -1 },
        right_bottom: { x: 1, y: 1 },
      },
    })

    const east = placement_footprint(prototype, { x: 0, y: 0.5 }, 4)
    expect(east).toMatchObject({
      tile_width: 2,
      tile_height: 1,
      tile_box: {
        left_top: { x: -1, y: 0 },
        right_bottom: { x: 1, y: 1 },
      },
      world_box: {
        left_top: { x: -0.9, y: 0.1 },
        right_bottom: { x: 0.9, y: 0.9 },
      },
    })
  })

  it('answers footprint coverage from the rotated tile footprint', () => {
    const prototype = { tile_width: 1, tile_height: 2 }
    expect(placement_footprint_covers_point(prototype, { x: 0.5, y: 0 }, 0, { x: 0.5, y: 0.9 })).toBe(true)
    expect(placement_footprint_covers_point(prototype, { x: 0.5, y: 0 }, 0, { x: 1.1, y: 0 })).toBe(false)
    expect(placement_footprint_covers_point(prototype, { x: 0, y: 0.5 }, 4, { x: 0.9, y: 0.5 })).toBe(true)
  })
})
