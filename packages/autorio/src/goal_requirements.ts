// Goal requirements: what the running game says a goal's targets need.
//
// The planner used to get only milestone counts, hand-written skill
// preconditions and on-demand tools. Nothing told it "this target recipe is
// locked; technology X unlocks it; X is a trigger technology with this exact
// trigger; these prerequisites come first". A plan that crafted the target
// before unlocking it froze on `recipe_locked` (live run goal_052327n_1).
//
// This module reads that from the live force and prototypes only. It carries
// no vanilla fact (no technology names, triggers, ratios or build orders):
//   - target items: the recipe(s) producing it (exact recipe name first, then
//     recipes listing it as a product), whether enabled, else the unlocking
//     technology (fewest pending research nodes, then name) and its
//     dependency-first pending research path (research_path.ts);
//   - ingredients, walked recursively with tight depth and node caps; a LOCKED
//     ingredient recipe is reported the same way, unlocked ones are only
//     counted;
//   - machine_output items also report the crafting machine entities that can
//     craft the target recipe (by crafting category), the item that places each
//     and whether its recipe is enabled (else its unlocking technology and
//     path);
//   - target technologies get their pending path directly; target entities are
//     treated as the item that places them.
// Output is compact, with explicit truncation flags. Read only: the caller
// passes the peeked actor and nothing here writes `storage` or creates a body.
import type { LuaForce } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { recipe_categories } from './recipe_categories'
import { plan_research_path } from './research_path'

const MAX_TARGETS = 8
const MAX_DEPTH = 5
const MAX_RECIPES = 64
const MAX_LOCKED = 12
const MAX_PATH_NODES = 12
const MAX_RESEARCH_NODES = 24
const MAX_UNLOCK_CANDIDATES = 8
const MAX_PRODUCERS = 6
const MAX_MACHINE_OPTIONS = 6
const MAX_LOCKED_MACHINES = 3
const MAX_NODE_INGREDIENTS = 4
const MAX_NODE_PREREQUISITES = 4
const RESEARCH_PATH_MAX_NODES = 64
const UNREACHABLE = 1000000

type LockedRole = 'target_recipe' | 'ingredient_recipe' | 'machine' | 'target_entity' | 'target_technology'
type ItemStatus = 'unlocked' | 'locked' | 'no_recipe'

interface UnlockChoice {
  technology: string
  recipe: string
  distance: number
}

interface ItemAnalysis {
  status: ItemStatus
  recipe?: string
  unlock?: UnlockChoice
}

interface LockedEntry {
  subject: string
  role: LockedRole
  recipe?: string
  needed_for?: string
  unlocked_by?: string
  unlock_unknown?: boolean
  path: string[]
  path_truncated?: boolean
  path_error?: string
}

interface ResearchNode {
  mode: string
  status: string
  trigger?: Record<string, unknown>
  science?: { count?: number, ingredients: Array<{ name: string, amount: number }> }
  requires: string[]
}

interface MachineOption {
  entity: string
  item: string
  status: 'craftable' | 'locked' | 'no_recipe'
  unlocked_by?: string
}

interface MachineReport {
  for_item: string
  recipe: string
  options: MachineOption[]
  truncated: boolean
  craftable: boolean
}

interface Context {
  actor: ControlledActor
  force: LuaForce
  unlock_index?: Record<string, string[]>
  producer_index?: Record<string, string[]>
  paths: Record<string, any>
  analysis: Record<string, ItemAnalysis>
  visited: Record<string, boolean>
  locked: LockedEntry[]
  locked_keys: Record<string, boolean>
  research: Record<string, ResearchNode>
  research_count: number
  machines: MachineReport[]
  unknown: string[]
  recipes_visited: number
  raw_items: number
  unlocked_recipes: number
  truncated: {
    targets: boolean
    walk_depth: boolean
    walk_nodes: boolean
    producers: boolean
    locked: boolean
    paths: boolean
    research: boolean
    unlock_candidates: boolean
  }
}

function array_length<T>(values: T[] | undefined): number {
  return values ? values.length : 0
}

function valid_name(name: unknown): name is string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 200) return false
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 32 || code === 127) return false
  }
  return true
}

function as_list(value: unknown): unknown[] {
  const result: unknown[] = []
  if (typeof value !== 'object' || value === undefined || value === null) return result
  const list = value as unknown[]
  for (let index = 0; index < array_length(list); index++) result.push(list[index])
  return result
}

function plain_table(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== undefined && value !== null
}

function push_unique(list: string[], name: string) {
  for (const existing of list) if (existing === name) return
  list.push(name)
}

function failure(code: string, message: string) {
  return { ok: false, error: { code, message } }
}

function recipe_unlock_index(ctx: Context) {
  if (ctx.unlock_index) return ctx.unlock_index
  const index: Record<string, string[]> = {}
  for (const [name, technology] of pairs(ctx.force.technologies)) {
    const effects = technology.prototype.effects ?? []
    for (const effect of effects) {
      if (effect.type !== 'unlock-recipe') continue
      const recipe = (effect as any).recipe
      if (typeof recipe !== 'string') continue
      if (!index[recipe]) index[recipe] = []
      push_unique(index[recipe], name)
    }
  }
  for (const recipe in index) index[recipe].sort()
  ctx.unlock_index = index
  return index
}

function recipe_producer_index(ctx: Context) {
  if (ctx.producer_index) return ctx.producer_index
  const index: Record<string, string[]> = {}
  for (const [name, recipe] of pairs(ctx.force.recipes)) {
    if (recipe.hidden === true) continue
    const products = recipe.products ?? []
    for (const product of products) {
      if (typeof product.name !== 'string') continue
      if (!index[product.name]) index[product.name] = []
      push_unique(index[product.name], name)
    }
  }
  for (const product in index) index[product].sort()
  ctx.producer_index = index
  return index
}

// Recipe names that produce `item`: the recipe with exactly that name first
// (when it lists the item as a product), then the others by name.
function producer_recipes(ctx: Context, item: string): string[] {
  const names: string[] = []
  const exact = ctx.force.recipes[item]
  if (exact !== undefined) {
    for (const product of exact.products ?? []) {
      if (product.name === item) {
        names.push(item)
        break
      }
    }
  }
  const indexed = recipe_producer_index(ctx)[item] ?? []
  for (const name of indexed) {
    if (names.length >= MAX_PRODUCERS) {
      ctx.truncated.producers = true
      break
    }
    push_unique(names, name)
  }
  return names
}

function research_path_for(ctx: Context, technology: string): any {
  const cached = ctx.paths[technology]
  if (cached !== undefined) return cached
  const path: any = plan_research_path(ctx.actor, technology, RESEARCH_PATH_MAX_NODES)
  ctx.paths[technology] = path
  return path
}

// Smaller is nearer: usable technologies first, then fewest pending nodes.
function unlock_distance(ctx: Context, technology: string): number {
  const path: any = research_path_for(ctx, technology)
  if (!path || path.ok !== true) return UNREACHABLE
  return (path.blocked === true ? UNREACHABLE / 2 : 0) + path.pending_count
}

function best_unlock(ctx: Context, recipes: string[]): UnlockChoice | undefined {
  const index = recipe_unlock_index(ctx)
  let best: UnlockChoice | undefined
  let considered = 0
  for (const recipe of recipes) {
    for (const technology of index[recipe] ?? []) {
      if (considered >= MAX_UNLOCK_CANDIDATES) {
        ctx.truncated.unlock_candidates = true
        break
      }
      considered++
      const distance = unlock_distance(ctx, technology)
      if (!best
        || distance < best.distance
        || (distance === best.distance && technology < best.technology)
        || (distance === best.distance && technology === best.technology && recipe < best.recipe)) {
        best = { technology, recipe, distance }
      }
    }
  }
  return best
}

function analyze_item(ctx: Context, item: string): ItemAnalysis {
  const cached = ctx.analysis[item]
  if (cached !== undefined) return cached
  const names = producer_recipes(ctx, item)
  let result: ItemAnalysis
  let enabled: string | undefined
  for (const name of names) {
    const recipe = ctx.force.recipes[name]
    if (recipe && recipe.enabled) {
      enabled = name
      break
    }
  }
  if (enabled) result = { status: 'unlocked', recipe: enabled }
  else if (array_length(names) > 0) {
    const unlock = best_unlock(ctx, names)
    result = { status: 'locked', recipe: unlock ? unlock.recipe : names[0], unlock }
  }
  else result = { status: 'no_recipe' }
  ctx.analysis[item] = result
  return result
}

function compact_node(node: any): ResearchNode & { name: string } {
  const ingredients: Array<{ name: string, amount: number }> = []
  const science = node.science
  if (science && typeof science === 'object') {
    const source: any[] = science.ingredients ?? []
    for (let index = 0; index < array_length(source) && index < MAX_NODE_INGREDIENTS; index++) {
      ingredients.push({ name: source[index].name, amount: source[index].amount })
    }
  }
  const requires: string[] = []
  const unresolved: string[] = node.unresolved_prerequisites ?? []
  for (let index = 0; index < array_length(unresolved) && index < MAX_NODE_PREREQUISITES; index++) requires.push(unresolved[index])
  return {
    name: node.name,
    mode: node.mode,
    status: node.status,
    trigger: node.research_trigger,
    science: science && typeof science === 'object' ? { count: science.count, ingredients } : undefined,
    requires,
  }
}

// The dependency-first pending nodes of `technology`, registered once in the
// shared research table. Returns the node names and any path problem.
function register_path(ctx: Context, technology: string) {
  const path: any = research_path_for(ctx, technology)
  const names: string[] = []
  if (!path || path.ok !== true) {
    return { names, truncated: false, error: path && path.error ? path.error.code as string : 'PATH_UNAVAILABLE' }
  }
  const pending: any[] = path.pending_path ?? []
  let truncated = false
  for (let index = 0; index < array_length(pending); index++) {
    if (index >= MAX_PATH_NODES) {
      truncated = true
      ctx.truncated.paths = true
      break
    }
    const node = pending[index]
    if (!ctx.research[node.name]) {
      if (ctx.research_count >= MAX_RESEARCH_NODES) {
        ctx.truncated.research = true
        truncated = true
        break
      }
      ctx.research[node.name] = compact_node(node)
      ctx.research_count++
    }
    names.push(node.name)
  }
  return { names, truncated, error: undefined as string | undefined }
}

function add_locked(ctx: Context, entry: { subject: string, role: LockedRole, recipe?: string, needed_for?: string, unlock?: UnlockChoice, technology?: string }) {
  const key = `${entry.role}:${entry.subject}`
  if (ctx.locked_keys[key]) return
  if (array_length(ctx.locked) >= MAX_LOCKED) {
    ctx.truncated.locked = true
    return
  }
  ctx.locked_keys[key] = true
  const technology = entry.technology ?? (entry.unlock ? entry.unlock.technology : undefined)
  const locked: LockedEntry = {
    subject: entry.subject,
    role: entry.role,
    recipe: entry.recipe,
    needed_for: entry.needed_for,
    unlocked_by: technology,
    unlock_unknown: technology ? undefined : true,
    path: [],
  }
  if (technology) {
    const path = register_path(ctx, technology)
    locked.path = path.names
    locked.path_truncated = path.truncated ? true : undefined
    locked.path_error = path.error
  }
  ctx.locked.push(locked)
}

// Ingredients of `recipe_name`, recursively. A locked ingredient recipe is
// reported; unlocked ones are counted. `visited` makes it cycle-safe.
function walk_recipe(ctx: Context, recipe_name: string, parent: string, depth: number) {
  const recipe = ctx.force.recipes[recipe_name]
  if (!recipe) return
  if (ctx.recipes_visited >= MAX_RECIPES) {
    ctx.truncated.walk_nodes = true
    return
  }
  ctx.recipes_visited++
  for (const ingredient of recipe.ingredients ?? []) {
    const name = ingredient.name
    if (typeof name !== 'string' || ctx.visited[name]) continue
    ctx.visited[name] = true
    const analysis = analyze_item(ctx, name)
    if (analysis.status === 'no_recipe') {
      ctx.raw_items++
      continue
    }
    if (analysis.status === 'unlocked') ctx.unlocked_recipes++
    else add_locked(ctx, { subject: name, role: 'ingredient_recipe', recipe: analysis.recipe, needed_for: parent, unlock: analysis.unlock })
    if (!analysis.recipe) continue
    if (depth + 1 >= MAX_DEPTH) {
      ctx.truncated.walk_depth = true
      continue
    }
    walk_recipe(ctx, analysis.recipe, name, depth + 1)
  }
}

function place_item(prototype: any): string | undefined {
  const items: any[] = prototype && prototype.items_to_place_this ? prototype.items_to_place_this : []
  for (let index = 0; index < array_length(items); index++) {
    const name = items[index] ? items[index].name : undefined
    if (typeof name === 'string') return name
  }
  return undefined
}

function item_status(analysis: ItemAnalysis): MachineOption['status'] {
  if (analysis.status === 'unlocked') return 'craftable'
  return analysis.status === 'locked' ? 'locked' : 'no_recipe'
}

function status_rank(status: MachineOption['status']) {
  return status === 'craftable' ? 0 : status === 'locked' ? 1 : 2
}

// Crafting machines that can craft `recipe_name`, and what each needs.
function machine_report(ctx: Context, item: string, recipe_name: string) {
  const recipe = ctx.force.recipes[recipe_name]
  if (!recipe) return
  const seen: Record<string, boolean> = {}
  const candidates: Array<{ entity: string, item: string, analysis: ItemAnalysis }> = []
  for (const category of recipe_categories(recipe)) {
    const matches = prototypes.get_entity_filtered([{ filter: 'crafting-category', crafting_category: category }])
    for (const [entity, prototype] of pairs(matches)) {
      if (seen[entity]) continue
      seen[entity] = true
      const placing = place_item(prototype)
      // The character itself crafts by hand; it is never a placed machine.
      if (!placing || prototype.type === 'character') continue
      candidates.push({ entity, item: placing, analysis: analyze_item(ctx, placing) })
    }
  }
  candidates.sort((left, right) => {
    const rank = status_rank(item_status(left.analysis)) - status_rank(item_status(right.analysis))
    if (rank !== 0) return rank
    const distance = (left.analysis.unlock ? left.analysis.unlock.distance : UNREACHABLE) - (right.analysis.unlock ? right.analysis.unlock.distance : UNREACHABLE)
    if (distance !== 0) return distance
    return left.entity < right.entity ? -1 : left.entity > right.entity ? 1 : 0
  })
  const options: MachineOption[] = []
  for (const candidate of candidates) {
    if (array_length(options) >= MAX_MACHINE_OPTIONS) break
    options.push({
      entity: candidate.entity,
      item: candidate.item,
      status: item_status(candidate.analysis),
      unlocked_by: candidate.analysis.unlock ? candidate.analysis.unlock.technology : undefined,
    })
  }
  const craftable = array_length(candidates) > 0 && item_status(candidates[0].analysis) === 'craftable'
  ctx.machines.push({ for_item: item, recipe: recipe_name, options, truncated: array_length(candidates) > MAX_MACHINE_OPTIONS, craftable })
  if (array_length(candidates) === 0) return
  // With no craftable machine, the nearest locked ones are requirements.
  if (!craftable) {
    let reported = 0
    for (const candidate of candidates) {
      if (reported >= MAX_LOCKED_MACHINES) break
      if (candidate.analysis.status !== 'locked') continue
      reported++
      add_locked(ctx, { subject: candidate.entity, role: 'machine', recipe: candidate.analysis.recipe, needed_for: item, unlock: candidate.analysis.unlock })
    }
  }
  // Locked ingredients of the machine that would be built first.
  const best = candidates[0]
  if (best.analysis.recipe && !ctx.visited[best.item]) {
    ctx.visited[best.item] = true
    walk_recipe(ctx, best.analysis.recipe, best.item, 1)
  }
}

function target_item(ctx: Context, item: string, machine_output: boolean) {
  ctx.visited[item] = true
  const analysis = analyze_item(ctx, item)
  if (analysis.status === 'no_recipe') {
    if (prototypes.item[item] === undefined && prototypes.fluid[item] === undefined) push_unique(ctx.unknown, item)
    else ctx.raw_items++
    return
  }
  if (analysis.status === 'locked') {
    add_locked(ctx, { subject: item, role: 'target_recipe', recipe: analysis.recipe, unlock: analysis.unlock })
  }
  if (!analysis.recipe) return
  walk_recipe(ctx, analysis.recipe, item, 0)
  if (machine_output) machine_report(ctx, item, analysis.recipe)
}

function target_technology(ctx: Context, name: string) {
  const technology = ctx.force.technologies[name]
  if (!technology) {
    push_unique(ctx.unknown, name)
    return
  }
  if (technology.researched) return
  add_locked(ctx, { subject: name, role: 'target_technology', technology: name })
}

function target_entity(ctx: Context, name: string) {
  const prototype = prototypes.entity[name]
  if (!prototype) {
    push_unique(ctx.unknown, name)
    return
  }
  const placing = place_item(prototype)
  if (!placing) return
  const analysis = analyze_item(ctx, placing)
  if (analysis.status === 'no_recipe') return
  if (analysis.status === 'locked') {
    add_locked(ctx, { subject: name, role: 'target_entity', recipe: analysis.recipe, needed_for: placing, unlock: analysis.unlock })
  }
  if (analysis.recipe && !ctx.visited[placing]) {
    ctx.visited[placing] = true
    walk_recipe(ctx, analysis.recipe, placing, 0)
  }
}

function new_context(actor: ControlledActor): Context {
  return {
    actor,
    force: actor.force,
    paths: {},
    analysis: {},
    visited: {},
    locked: [],
    locked_keys: {},
    research: {},
    research_count: 0,
    machines: [],
    unknown: [],
    recipes_visited: 0,
    raw_items: 0,
    unlocked_recipes: 0,
    truncated: {
      targets: false,
      walk_depth: false,
      walk_nodes: false,
      producers: false,
      locked: false,
      paths: false,
      research: false,
      unlock_candidates: false,
    },
  }
}

// The unlocking technology of one locked recipe and the next research node that can be
// started now (science or trigger, with the exact trigger). Used to make a
// `recipe_locked` refusal say what unlocks the recipe. Same choice rule as the
// requirements query; read only.
export function recipe_unlock_summary(actor: ControlledActor, recipe_name: string) {
  const ctx = new_context(actor)
  const unlock = best_unlock(ctx, [recipe_name])
  if (!unlock) return { unlock_unknown: true }
  const path: any = research_path_for(ctx, unlock.technology)
  if (!path || path.ok !== true) {
    return { unlocked_by: unlock.technology, path_error: path && path.error ? path.error.code as string : 'PATH_UNAVAILABLE' }
  }
  return {
    unlocked_by: unlock.technology,
    pending_count: path.pending_count as number,
    next_actionable: path.next_actionable ? compact_node(path.next_actionable) : undefined,
    blocked: path.blocked === true ? true : undefined,
  }
}

export function goal_requirements(actor: ControlledActor | undefined, request: unknown) {
  if (!actor || !actor.is_valid || !actor.force || !actor.force.valid) {
    return failure('NO_ACTOR', 'controlled actor is unavailable')
  }
  if (!plain_table(request)) return failure('INVALID_REQUEST', 'request must be a table with items, technologies and entities')

  const raw = request as Record<string, unknown>
  const items: Array<{ name: string, machine_output: boolean }> = []
  const technologies: string[] = []
  const entities: string[] = []
  let targets_truncated = false

  for (const entry of as_list(raw.items)) {
    const name = plain_table(entry) ? (entry as Record<string, unknown>).name : entry
    if (!valid_name(name)) return failure('INVALID_NAME', 'item target names must be non-empty strings')
    if (array_length(items) >= MAX_TARGETS) {
      targets_truncated = true
      continue
    }
    const machine_output = plain_table(entry) && (entry as Record<string, unknown>).machine_output === true
    let merged = false
    for (const existing of items) {
      if (existing.name === name) {
        existing.machine_output = existing.machine_output || machine_output
        merged = true
      }
    }
    if (!merged) items.push({ name, machine_output })
  }
  for (const entry of as_list(raw.technologies)) {
    if (!valid_name(entry)) return failure('INVALID_NAME', 'technology target names must be non-empty strings')
    if (array_length(technologies) >= MAX_TARGETS) targets_truncated = true
    else push_unique(technologies, entry)
  }
  for (const entry of as_list(raw.entities)) {
    if (!valid_name(entry)) return failure('INVALID_NAME', 'entity target names must be non-empty strings')
    if (array_length(entities) >= MAX_TARGETS) targets_truncated = true
    else push_unique(entities, entry)
  }
  if (array_length(items) + array_length(technologies) + array_length(entities) === 0) {
    return failure('INVALID_REQUEST', 'request names no target item, technology or entity')
  }

  const ctx = new_context(actor)
  ctx.truncated.targets = targets_truncated
  for (const target of items) target_item(ctx, target.name, target.machine_output)
  for (const name of technologies) target_technology(ctx, name)
  for (const name of entities) target_entity(ctx, name)

  return {
    ok: true,
    tick: game.tick,
    targets: { items: array_length(items), technologies: array_length(technologies), entities: array_length(entities) },
    locked: ctx.locked,
    research: ctx.research,
    machines: ctx.machines,
    unknown: ctx.unknown,
    counts: {
      locked: array_length(ctx.locked),
      recipes_walked: ctx.recipes_visited,
      unlocked_recipes: ctx.unlocked_recipes,
      raw_items: ctx.raw_items,
    },
    truncated: ctx.truncated,
  }
}
