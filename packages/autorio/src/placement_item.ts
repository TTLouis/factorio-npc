const MAX_PLACEMENT_ITEM_COUNT = 1000000

export interface PlacementItemRequirement {
  entity_name: string
  item_name: string
  count: number
}

export type PlacementItemResolution =
  | { ok: true, requirement: PlacementItemRequirement }
  | {
      ok: false
      code: 'unknown_entity' | 'not_item_placeable' | 'ambiguous_placement_item' | 'invalid_placement_item'
      entity_name: string
      item_name?: string
    }

function valid_count(value: unknown): value is number {
  return typeof value === 'number'
    && value === value
    && value === math.floor(value)
    && value > 0
    && value <= MAX_PLACEMENT_ITEM_COUNT
}

export function resolve_entity_placement_item(entity_name: string): PlacementItemResolution {
  const prototype = prototypes.entity[entity_name]
  if (!prototype) return { ok: false, code: 'unknown_entity', entity_name }

  const items = prototype.items_to_place_this
  if (!items || items.length === 0) return { ok: false, code: 'not_item_placeable', entity_name }
  if (items.length !== 1) return { ok: false, code: 'ambiguous_placement_item', entity_name }

  const item = items[0]
  if (!item
    || typeof item.name !== 'string'
    || item.name.length === 0
    || !valid_count(item.count)
    || !prototypes.item[item.name]) {
    return {
      ok: false,
      code: 'invalid_placement_item',
      entity_name,
      item_name: typeof item?.name === 'string' ? item.name : undefined,
    }
  }

  return {
    ok: true,
    requirement: {
      entity_name,
      item_name: item.name,
      count: item.count,
    },
  }
}
