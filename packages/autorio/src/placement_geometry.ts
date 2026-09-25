export interface PlacementPoint {
  x: number
  y: number
}

export interface PlacementWorldBox {
  left_top: PlacementPoint
  right_bottom: PlacementPoint
}

export interface PlacementGridRule {
  x_offset: number
  y_offset: number
}

export interface PlacementFootprint {
  tile_width: number
  tile_height: number
  grid: PlacementGridRule
  tile_box: PlacementWorldBox
  world_box: PlacementWorldBox
}

const GRID_EPSILON = 0.000001

function finite(value: number) {
  return value === value && value !== math.huge && value !== -math.huge
}

function dimension(value: unknown) {
  return typeof value === 'number' && finite(value) && value > 0 ? value : 1
}

function vector_xy(raw: any): PlacementPoint | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const values = raw as number[]
  const x = typeof raw.x === 'number' ? raw.x : values[0]
  const y = typeof raw.y === 'number' ? raw.y : values[1]
  if (typeof x !== 'number' || typeof y !== 'number' || !finite(x) || !finite(y)) return undefined
  return { x, y }
}

function rotated_cardinal(vector: PlacementPoint, direction: number) {
  if (direction === 4) return { x: -vector.y, y: vector.x }
  if (direction === 8) return { x: -vector.x, y: -vector.y }
  if (direction === 12) return { x: vector.y, y: -vector.x }
  return { x: vector.x, y: vector.y }
}

function swaps_axes(direction: number | undefined) {
  return direction === 4 || direction === 12
}

function grid_offset(size: number) {
  return math.floor(size) % 2 === 0 ? 0 : 0.5
}

function snapped(value: number, offset: number) {
  return math.floor(value - offset + 0.5) + offset
}

export function placement_tile_size(prototype: any, direction: number | undefined = 0) {
  const base_width = dimension(prototype?.tile_width)
  const base_height = dimension(prototype?.tile_height)
  return swaps_axes(direction)
    ? { tile_width: base_height, tile_height: base_width }
    : { tile_width: base_width, tile_height: base_height }
}

export function placement_grid_rule(prototype: any, direction: number | undefined = 0): PlacementGridRule {
  const size = placement_tile_size(prototype, direction)
  return {
    x_offset: grid_offset(size.tile_width),
    y_offset: grid_offset(size.tile_height),
  }
}

export function snap_placement_center(
  prototype: any,
  position: PlacementPoint,
  direction: number | undefined = 0,
) {
  const grid = placement_grid_rule(prototype, direction)
  return {
    x: snapped(position.x, grid.x_offset),
    y: snapped(position.y, grid.y_offset),
  }
}

export function placement_grid_check(
  prototype: any,
  position: PlacementPoint,
  direction: number | undefined = 0,
) {
  const grid = placement_grid_rule(prototype, direction)
  const snapped_position = snap_placement_center(prototype, position, direction)
  return {
    valid: math.abs(position.x - snapped_position.x) <= GRID_EPSILON
      && math.abs(position.y - snapped_position.y) <= GRID_EPSILON,
    grid,
    snapped_position,
  }
}

function fallback_local_box(prototype: any, direction: number | undefined): PlacementWorldBox {
  const size = placement_tile_size(prototype, direction)
  return {
    left_top: { x: -size.tile_width / 2, y: -size.tile_height / 2 },
    right_bottom: { x: size.tile_width / 2, y: size.tile_height / 2 },
  }
}

function local_collision_box(prototype: any, direction: number | undefined): PlacementWorldBox {
  const collision = prototype?.collision_box
  const left_top = vector_xy(collision?.left_top)
  const right_bottom = vector_xy(collision?.right_bottom)
  if (!left_top || !right_bottom) return fallback_local_box(prototype, direction)

  const corners = [
    left_top,
    { x: right_bottom.x, y: left_top.y },
    right_bottom,
    { x: left_top.x, y: right_bottom.y },
  ]
  let min_x = math.huge
  let min_y = math.huge
  let max_x = -math.huge
  let max_y = -math.huge
  for (const corner of corners) {
    const rotated = rotated_cardinal(corner, direction ?? 0)
    min_x = math.min(min_x, rotated.x)
    min_y = math.min(min_y, rotated.y)
    max_x = math.max(max_x, rotated.x)
    max_y = math.max(max_y, rotated.y)
  }
  return {
    left_top: { x: min_x, y: min_y },
    right_bottom: { x: max_x, y: max_y },
  }
}

function translated_box(box: PlacementWorldBox, position: PlacementPoint): PlacementWorldBox {
  return {
    left_top: {
      x: position.x + box.left_top.x,
      y: position.y + box.left_top.y,
    },
    right_bottom: {
      x: position.x + box.right_bottom.x,
      y: position.y + box.right_bottom.y,
    },
  }
}

export function placement_footprint(
  prototype: any,
  position: PlacementPoint,
  direction: number | undefined = 0,
): PlacementFootprint {
  const size = placement_tile_size(prototype, direction)
  const grid = placement_grid_rule(prototype, direction)
  const tile_box = translated_box(fallback_local_box(prototype, direction), position)
  const world_box = translated_box(local_collision_box(prototype, direction), position)
  return {
    tile_width: size.tile_width,
    tile_height: size.tile_height,
    grid,
    tile_box,
    world_box,
  }
}

export function placement_footprint_covers_point(
  prototype: any,
  position: PlacementPoint,
  direction: number | undefined,
  point: PlacementPoint,
) {
  const box = placement_footprint(prototype, position, direction).tile_box
  return point.x > box.left_top.x
    && point.x < box.right_bottom.x
    && point.y > box.left_top.y
    && point.y < box.right_bottom.y
}
