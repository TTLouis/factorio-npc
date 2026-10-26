// Harness repairs for a refused productionTask (owner 2026-10-26, after Run AZ).
// A repair runs only when the committed step and fresh game facts leave one
// admissible answer; otherwise the refusal stays a bounded executor correction.
// Nothing here knows production: targets come from the committed checkpoint,
// fuel from the game's burner and fuel prototypes plus the NPC's inventory, and
// a preference only from a default the model itself wrote.
import { finiteInventoryTargets, PRODUCTION_LIMITS } from './production-task.mjs'
import { itemName, QUANTITY_LIMITS } from './quantity-compiler.mjs'

// Default slots are fixed here; the model fills values, never new rules.
export const HARNESS_DEFAULT_SLOTS = Object.freeze(['burner_fuel'])
export const HARNESS_DEFAULTS_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Standing values the harness applies when your productionTask leaves them out. burner_fuel: the fuel item for bound burner machines that accept it. Kept for this NPC until you change it.',
  properties: { burner_fuel: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$', minLength: 1, maxLength: 200 } },
}
export function normalizeHarnessDefaults(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !HARNESS_DEFAULT_SLOTS.includes(key))) {
    throw new Error(`defaults may only set ${HARNESS_DEFAULT_SLOTS.join(', ')}`)
  }
  try { return raw.burner_fuel === undefined ? {} : { burner_fuel: itemName(raw.burner_fuel) } }
  catch { throw new Error('defaults.burner_fuel must be an item name') }
}
export function restoreHarnessDefaults(rows) {
  const defaults = new Map()
  for (const row of Array.isArray(rows) ? rows.slice(-128) : []) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || row[0].length > 300) continue
    try { defaults.set(row[0], normalizeHarnessDefaults(row[1])) }
    catch {}
  }
  return defaults
}

const list = rows => rows.map(row => `${row.item_name} ${row.count}`).join(', ')

// Named targets keep their item at the committed count and unrequired ones are
// dropped; when nothing named is required, the committed targets replace them.
export function repairTargets(intent, contract) {
  const required = finiteInventoryTargets(contract)
  if (!required.size) return undefined
  const kept = intent.targets.filter(row => required.has(row.item_name)).map(row => ({ item_name: row.item_name, count: required.get(row.item_name) }))
  const targets = kept.length ? kept : [...required].map(([item_name, count]) => ({ item_name, count }))
  const dropped = intent.targets.filter(row => !required.has(row.item_name))
  return { targets, rule: kept.length ? 'committed_counts' : 'committed_targets',
    note: `targets set to ${list(targets)} from the committed checkpoint${dropped.length ? ` (not in it: ${list(dropped)})` : ''}` }
}

const natural = fuel => Boolean(fuel.mined_from?.length || fuel.harvested_from?.length)
// Cheapest: a fuel some natural source yields before a crafted one, then the
// least energy per item, then name order.
const cheapest = fuels => [...fuels].sort((a, b) => Number(natural(b)) - Number(natural(a)) || a.fuel_value - b.fuel_value || a.name.localeCompare(b.name))[0]

// `fuels` are already accepted by every bound burner. A crafted fuel can only
// be spent from held stock, so it is chosen only while some is held.
export function chooseBurnerFuel({ fuels, held, preferred }) {
  const usable = fuel => natural(fuel) || (held[fuel.name] ?? 0) > 0
  const chosen = preferred && fuels.find(fuel => fuel.name === preferred)
  const ignored = preferred && !(chosen && usable(chosen)) ? preferred : undefined
  if (chosen && usable(chosen)) return { fuel: chosen, rule: 'your default burner_fuel' }
  const owned = fuels.filter(fuel => (held[fuel.name] ?? 0) > 0)
  if (owned.length === 1) return { fuel: owned[0], rule: 'the only accepted fuel held', ignored }
  if (owned.length > 1) return { fuel: cheapest(owned), rule: `the cheapest of the held accepted fuels ${owned.map(fuel => fuel.name).join(', ')}`, ignored }
  const sourced = fuels.filter(natural)
  if (sourced.length === 1) return { fuel: sourced[0], rule: 'the only accepted fuel with a natural source', ignored }
  return { ignored }
}

// A cap, not a delivery: the task inserts one item only when a burner runs
// out. Every burner at full draw for the task's whole time limit bounds it.
export function fuelAllowanceCount(burners, fuel, held = 0) {
  const seconds = PRODUCTION_LIMITS.duration_ms / 1000
  let count = 0
  for (const burner of burners) count += Math.ceil(burner.energy_watts * seconds / (fuel.fuel_value * (burner.burner_effectivity || 1)))
  count = Math.min(QUANTITY_LIMITS.quantity, Math.max(1, count))
  return natural(fuel) ? count : Math.min(count, held)
}
