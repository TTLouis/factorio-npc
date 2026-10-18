// Same-batch placement footprints (Run Z batch 21: a boiler and then a steam engine whose footprint covered it).
//
// Each placement is preflighted on its own against the world as it is now, so two placements of one batch that
// overlap each other both pass, and the second one fails at execution with the first one's effect already in the
// world. The mod returns the tiles every coordinate placement will occupy (`planned_footprint`, computed with the
// same grid snap and collision box execution uses) and the collision layers that decide what it may share them
// with. This compares them in batch order, before anything is sent. Pure: no I/O.

import { effectClassOf } from './operation-reconciliation.mjs'
import { REFUSAL_CLASS } from './refusal-class.mjs'

export const BATCH_FOOTPRINT_OVERLAP_CODE = 'batch_footprint_overlap'

// Collision boxes are inset from tile edges, so adjacent entities do not overlap; this only absorbs float noise.
const OVERLAP_EPSILON = 1e-6

function box(value) {
  const lt = value?.left_top
  const rb = value?.right_bottom
  if (![lt?.x, lt?.y, rb?.x, rb?.y].every(Number.isFinite) || rb.x <= lt.x || rb.y <= lt.y) return undefined
  return { left_top: { x: lt.x, y: lt.y }, right_bottom: { x: rb.x, y: rb.y } }
}

function footprintOf(result) {
  const planned = result?.planned_footprint
  const world = box(planned?.world_box)
  if (!world || planned.collision_unknown === true || planned.colliding_with_tiles_only === true) return undefined
  if (!Array.isArray(planned.collision_layers) || !planned.collision_layers.every(layer => typeof layer === 'string')) return undefined
  return { ...planned, world_box: world }
}

function overlapArea(a, b) {
  const width = Math.min(a.right_bottom.x, b.right_bottom.x) - Math.max(a.left_top.x, b.left_top.x)
  const height = Math.min(a.right_bottom.y, b.right_bottom.y) - Math.max(a.left_top.y, b.left_top.y)
  return width > OVERLAP_EPSILON && height > OVERLAP_EPSILON ? width * height : 0
}

function collides(a, b) {
  if (a.entity_name === b.entity_name && a.not_colliding_with_itself === true) return false
  return a.collision_layers.some(layer => b.collision_layers.includes(layer))
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function boxFacts(value) {
  return { left_top: { x: round(value.left_top.x), y: round(value.left_top.y) }, right_bottom: { x: round(value.right_bottom.x), y: round(value.right_bottom.y) } }
}

/**
 * The first placement of the batch whose footprint collides with an earlier placement of the same batch, as an
 * argument-class preflight refusal, or null. A pair is not compared when an operation between them can remove or
 * turn an entity (any 'world' effect: mining, clearing, rotating), because the earlier footprint may be gone by then.
 *   operations  the parsed batch, in order
 *   preflight   the per-operation preflight results, same order (each placement carries the mod's planned_footprint)
 */
export function batchFootprintOverlap(operations, preflight) {
  const list = Array.isArray(operations) ? operations : []
  const placed = []
  for (let index = 0; index < list.length; index++) {
    if (effectClassOf(list[index]?.name) === 'world') {
      placed.length = 0
      continue
    }
    const footprint = footprintOf(preflight?.[index])
    if (!footprint) continue
    for (const earlier of placed) {
      if (!collides(earlier.footprint, footprint)) continue
      const area = overlapArea(earlier.footprint.world_box, footprint.world_box)
      if (area === 0) continue
      const facts = {
        operation_index: index,
        operation: list[index].name,
        entity_name: footprint.entity_name,
        position: footprint.position,
        direction: footprint.direction,
        world_box: boxFacts(footprint.world_box),
        overlaps: {
          operation_index: earlier.index,
          operation: list[earlier.index].name,
          entity_name: earlier.footprint.entity_name,
          position: earlier.footprint.position,
          direction: earlier.footprint.direction,
          world_box: boxFacts(earlier.footprint.world_box),
        },
        overlap_area: round(area),
      }
      return {
        ok: false,
        code: BATCH_FOOTPRINT_OVERLAP_CODE,
        refusal_class: REFUSAL_CLASS.ARGUMENT,
        operation: list[index].name,
        operation_index: index,
        identity: footprint.entity_name,
        detail: `operation ${index + 1} (${footprint.entity_name}) overlaps operation ${earlier.index + 1} (${earlier.footprint.entity_name}) of the same batch`,
        batch_footprint: facts,
        correction_message: `[HARNESS] Refused before admission: no operation from this batch ran. Operation ${index + 1} would place ${footprint.entity_name} on tiles that operation ${earlier.index + 1} of the same batch places ${earlier.footprint.entity_name} on (collision boxes from the game's prototypes, overlapping by ${round(area)} tiles). Each placement was accepted on its own against the current world; together they cannot both be built. The plan, the step and the requested result are unchanged. Facts: ${JSON.stringify(facts)}`,
      }
    }
    placed.push({ index, footprint })
  }
  return null
}
