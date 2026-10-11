import { requirementTargets } from './goal-requirements.mjs'

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/
const list = value => Array.isArray(value) ? value : []
const parse = raw => { try { return JSON.parse(String(raw)) } catch { return null } }

const MACHINE_TYPES = new Set(['furnace', 'lab', 'assembling-machine', 'boiler', 'generator', 'electric-pole',
  'offshore-pump', 'mining-drill', 'solar-panel', 'accumulator', 'pump', 'pipe', 'pipe-to-ground', 'storage-tank'])
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const name = value => typeof value === 'string' && NAME.test(value)

// Historical search hints only. Empty local reads do not erase distant sources.
// Restart/new-goal callers discard these because native surface indices can recur.
export function rememberFluidSources(previous, read, raw, observedAt) {
  if (read.name !== 'getFluidSourceTiles') return previous
  const result = String(raw).length <= 4096 ? parse(raw) : null
  const radius = read.args.search_radius ?? 128
  const limit = read.args.limit ?? 8
  const samples = Array.isArray(result?.samples) ? result.samples
    : object(result?.samples) && Object.keys(result.samples).length === 0 ? [] : null
  if (!object(result) || result.ok !== true || result.fluid_name !== read.args.fluid_name
    || !name(result.fluid_name) || result.coverage !== 'generated_bounding_square'
    || !Number.isSafeInteger(result.surface_index) || result.surface_index < 1
    || !Number.isSafeInteger(result.observed_tick) || result.observed_tick < 0
    || !Number.isSafeInteger(radius) || radius < 1 || radius > 256 || result.search_radius !== radius
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 8
    || typeof result.truncated !== 'boolean' || !samples
    || result.returned_count !== samples.length || samples.length > limit
    || samples.length > 8 || !Number.isSafeInteger(observedAt) || observedAt < 0) return previous
  if (!samples.length) return previous
  const validPosition = p => Number.isInteger(p?.x) && Number.isInteger(p?.y)
    && Math.abs(p.x) <= 10000256 && Math.abs(p.y) <= 10000256
  if (samples.some(row => !object(row) || !name(row.name) || row.fluid_name !== result.fluid_name
    || row.surface_index !== result.surface_index || !validPosition(row.position))) return previous
  const rows = [...previous]
  for (const sample of samples) {
    const anchor = { name: sample.name, fluid_name: sample.fluid_name, surface_index: sample.surface_index,
      position: { x: sample.position.x, y: sample.position.y },
      observed_at_ms: observedAt, historical: true }
    const index = rows.findIndex(old => old.surface_index === anchor.surface_index
      && old.position.x === anchor.position.x && old.position.y === anchor.position.y)
    if (index >= 0) rows.splice(index, 1)
    rows.push(anchor)
    while (rows.length > 16 || JSON.stringify(rows).length > 4000) rows.shift()
  }
  return rows
}
// Ephemeral native facts, never an action, ownership grant or inventory total.
// Keep valid JSON with explicit unreadability instead of clipping JSON text.
export async function planningEntityObservation(anchors, read) {
  const selected = [...new Map(list(anchors).filter(row => MACHINE_TYPES.has(row.type))
    .map(row => [row.unit_number, row])).values()].slice(-4).reverse()
  const rows = []
  for (const anchor of selected) {
    const query = { name: 'getEntityStatus', args: { unit_number: anchor.unit_number } }
    const { raw, observed_at_ms } = await read(query)
    const base = { query, observed_at_ms, scope: 'current_actor_surface_and_force' }
    const unreadable = reason => ({ ...base, read: false, reason })
    const result = String(raw).length <= 200000 ? parse(raw) : null
    if (!object(result) || typeof result.found !== 'boolean'
      || (result.unit_number !== undefined && result.unit_number !== anchor.unit_number)) { rows.push(unreadable('native_status_unreadable')); continue }
    if (!result.found) {
      rows.push(result.error === 'exact_entity_not_found' && result.unit_number === anchor.unit_number
        ? { ...base, read: true, found: false } : unreadable('native_status_unreadable'))
      continue
    }
    if (result.error !== undefined) { rows.push(unreadable('native_status_unreadable')); continue }
    const entity = result.entity
    const nativeInventories = Array.isArray(entity?.inventories) ? entity.inventories
      : object(entity?.inventories) && Object.keys(entity.inventories).length === 0 ? [] : null
    if (!object(entity) || entity.unit_number !== anchor.unit_number || !name(entity.name) || !name(entity.type)
      || !Number.isFinite(entity.position?.x) || !Number.isFinite(entity.position?.y)
      || !nativeInventories || nativeInventories.length > 8
      || typeof entity.inventories_truncated !== 'boolean' || typeof entity.inventory_items_truncated !== 'boolean') {
      rows.push(unreadable('native_status_unreadable')); continue
    }
    const inventories = []
    let invalid = false
    for (const inventory of nativeInventories) {
      if (!object(inventory)) { invalid = true; break }
      const items = Array.isArray(inventory.items) ? inventory.items
        : object(inventory.items) && Object.keys(inventory.items).length === 0 ? [] : null
      if (!Number.isSafeInteger(inventory.index) || inventory.index < 1 || !items || items.length > 20
        || items.some(item => !name(item?.name) || !name(item?.quality) || !Number.isSafeInteger(item?.count) || item.count < 1)) {
        invalid = true; break
      }
      inventories.push({ index: inventory.index, items: items.map(({ name, quality, count }) => ({ name, quality, count })) })
    }
    if (invalid) { rows.push(unreadable('native_inventory_unreadable')); continue }
    const summary = { ...base, read: true, found: true, entity: { unit_number: entity.unit_number,
      name: entity.name, type: entity.type, position: { x: entity.position.x, y: entity.position.y }, inventories,
      inventories_truncated: entity.inventories_truncated, inventory_items_truncated: entity.inventory_items_truncated } }
    if (Number.isSafeInteger(entity.status) && entity.status >= 0) summary.entity.status = entity.status
    if (typeof entity.status_name === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(entity.status_name)) summary.entity.status_name = entity.status_name
    if (typeof entity.working === 'boolean') summary.entity.working = entity.working
    if (['electric', 'burner', 'heat', 'fluid', 'void', 'none'].includes(entity.energy_source)) summary.entity.energy_source = entity.energy_source
    if (entity.energy_source === 'electric') {
      if (Number.isFinite(entity.energy) && entity.energy >= 0) summary.entity.energy = entity.energy
      if (Number.isSafeInteger(entity.electric_network_id) && entity.electric_network_id > 0) summary.entity.electric_network_id = entity.electric_network_id
    }
    for (const key of ['recipe', 'previous_recipe_name']) if (name(entity[key])) summary.entity[key] = entity[key]
    rows.push(JSON.stringify(summary).length <= 3500 ? summary : unreadable('native_summary_truncated'))
  }
  return rows
}

// Read prototype dependencies, never choose an executable plan. The only roots
// are trusted acceptance targets and names returned by bounded native reads.
export async function seedPursuitKnowledge(predicate, read) {
  const targets = requirementTargets(predicate)
  let truncated = targets.technologies.length > 2
  const take = (value, maximum) => {
    const rows = list(value)
    truncated ||= rows.length > maximum
    return rows.slice(0, maximum)
  }
  const queue = [], seen = new Set()
  const add = name => {
    if (typeof name !== 'string' || !NAME.test(name) || seen.has(name)) return
    if (queue.length >= 128) { truncated = true; return }
    seen.add(name); queue.push(name)
  }
  for (const item of targets.items) add(item.name)
  for (const entity of targets.entities) add(entity)
  let researchReads = 0, recipeReads = 0, unreadable = 0
  for (const technology of targets.technologies.slice(0, 2)) {
    const path = parse(await read({ name: 'getResearchPath', args: { name: technology, max_nodes: 32 } }))
    researchReads++
    if (!path || path.ok !== true) { unreadable++; continue }
    truncated ||= path.truncated === true
    for (const node of take(path.nodes, 32)) {
      if (node.research_trigger?.type === 'craft-item') add(node.research_trigger.item)
      truncated ||= node.science?.ingredients_truncated === true
      for (const ingredient of take(node.science?.ingredients, 6)) add(ingredient.name)
    }
  }
  while (queue.length && recipeReads < 12) {
    const name = queue.shift()
    const details = parse(await read({ name: 'getRecipeDetails', args: { item_or_recipe: name, requested_count: 1 } }))
    recipeReads++
    if (!details || typeof details.found !== 'boolean') { unreadable++; continue }
    if (!details.found) continue // A mined input is not an invented recipe.
    truncated ||= details.truncated === true
    for (const recipe of take(details.recipes, 8)) {
      truncated ||= recipe.ingredients_truncated === true
      for (const ingredient of take(recipe.ingredients, 16)) add(ingredient.name)
    }
  }
  return { research_reads: researchReads, recipe_reads: recipeReads, unreadable,
    truncated: truncated || queue.length > 0 }
}
