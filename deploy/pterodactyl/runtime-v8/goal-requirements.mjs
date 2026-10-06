// Goal requirements: the harness tells the planner what the running game says
// the goal's targets need, instead of leaving the model to guess Factorio rules.
//
// Live run goal_052327n_1: the planner defined doneWhen as a machine rate of one
// item, then ordered "hand-craft the item" before "research the technology that
// unlocks it". The recipe was locked, craft_item preflight refused it, and the
// committed plan froze. Nothing deterministic had told the planner that the
// target recipe was locked, which technology unlocks it, that technology was a
// trigger technology (not lab science), or which prerequisites came first.
//
// - The mod answers (`autorio_planning.goal_requirements`, goal_requirements.ts)
//   from the live force and prototypes: locked target / ingredient / machine
//   recipes, the unlocking technology, its dependency-first pending research
//   with the exact trigger of each trigger node. This module holds no game
//   fact; it builds the request, validates the answer and renders it.
// - Targets come ONLY from the goal definition's done_when: items from
//   items_produced / inventory_count / production_rate, technologies from
//   research_completed, entities from entity_working /
//   electric_network_satisfied. A production_rate is a machine rate with hand
//   work excluded (goal-definition.mjs), so its item asks for machines too.
// - The block is shown in plan-authoring and revision rounds only (same rule as
//   [SKILL_OFFERS]) and re-queried at each shelf pickup and revision so it
//   reflects current research. It is omitted when nothing needs attention: a
//   one-line "all unlocked" would cost tokens in every authoring round (it is a
//   tail block, never cached) and say nothing the planner can act on, and
//   absence of the block already means "no constraint". The query itself is
//   traced either way.
// - On a new goal the definition arrives in the same submitPlan as the first
//   plan. After the definition is accepted and before anything is committed or
//   admitted the harness asks once (`planning.requirements_grounding_round`),
//   as one corrective round shared with the goal-reading challenge, whether
//   the roadmap and plan order respect the facts. It never edits the plan.
import { luaString } from '../staging/structured-policy.mjs'
import { isRevisionRound } from './skill-offers.mjs'

export const REQUIREMENTS_PREFIX = '[REQUIREMENTS]'
export const REQUIREMENTS_MAX_BLOCK_CHARS = 2400
export const REQUIREMENTS_MAX_LINE_CHARS = 420
export const REQUIREMENTS_GROUNDING_CODE = 'requirements_grounding'
const MAX_TARGETS = 8
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/
const ROLES = new Set(['target_recipe', 'ingredient_recipe', 'machine', 'target_entity', 'target_technology'])
const TRIGGER_NAME_KEYS = ['item', 'entity', 'fluid']

function text(value, max) {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const points = Array.from(clean)
  return points.length <= max ? clean : `${points.slice(0, max - 3).join('')}...`
}

function name(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value) ? value : undefined
}

// table_to_json renders an empty Lua table as [] or {}.
function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

// --- targets ----------------------------------------------------------------

// What a goal definition asks the game to prove, as requirement targets.
export function requirementTargets(definition) {
  const items = []
  const technologies = []
  const entities = []
  const addItem = (itemName, machineOutput) => {
    const clean = name(itemName)
    if (!clean) return
    const existing = items.find(entry => entry.name === clean)
    if (existing) existing.machine_output = existing.machine_output || machineOutput
    else items.push({ name: clean, machine_output: machineOutput })
  }
  for (const condition of asArray(definition?.done_when ?? definition?.doneWhen)) {
    switch (condition?.kind) {
      case 'items_produced':
      case 'inventory_count':
        addItem(condition.item_name, false)
        break
      // A machine rate with hand work excluded: the item needs machines.
      case 'production_rate':
        addItem(condition.item_name, true)
        break
      case 'research_completed': {
        const technology = name(condition.technology)
        if (technology && !technologies.includes(technology)) technologies.push(technology)
        break
      }
      case 'entity_working':
      case 'electric_network_satisfied': {
        const entity = name(condition.entity_name)
        if (entity && !entities.includes(entity)) entities.push(entity)
        break
      }
      default:
        break
    }
  }
  return {
    items: items.slice(0, MAX_TARGETS),
    technologies: technologies.slice(0, MAX_TARGETS),
    entities: entities.slice(0, MAX_TARGETS),
  }
}

export function hasRequirementTargets(targets) {
  return Boolean(targets) && (targets.items.length + targets.technologies.length + targets.entities.length) > 0
}

export function requirementsCommand(targets) {
  const request = JSON.stringify({
    items: targets.items.map(item => ({ name: item.name, machine_output: item.machine_output === true })),
    technologies: targets.technologies,
    entities: targets.entities,
  })
  return `/silent-command local request=helpers.json_to_table(${luaString(request)}); rcon.print(helpers.table_to_json(remote.call("autorio_planning","goal_requirements",request)))`
}

// --- parsing ----------------------------------------------------------------

function sanitizeTrigger(raw) {
  const source = asObject(raw)
  const type = name(source.type)
  if (!type) return undefined
  const trigger = { type }
  for (const key of TRIGGER_NAME_KEYS) {
    const value = name(source[key])
    if (value) trigger[key] = value
  }
  for (const key of ['item_quality', 'entity_quality']) {
    const value = name(source[key])
    if (value) trigger[key] = value
  }
  for (const key of ['count', 'amount']) {
    if (Number.isFinite(source[key])) trigger[key] = source[key]
  }
  return trigger
}

function sanitizeNode(raw) {
  const source = asObject(raw)
  const node = {
    mode: source.mode === 'trigger' ? 'trigger' : 'science',
    status: text(source.status, 40) || 'unknown',
    requires: asArray(source.requires).map(name).filter(Boolean).slice(0, 8),
  }
  const trigger = sanitizeTrigger(source.trigger)
  if (trigger) node.trigger = trigger
  if (source.science && typeof source.science === 'object') {
    node.science = {
      count: Number.isFinite(source.science.count) ? source.science.count : undefined,
      ingredients: asArray(source.science.ingredients)
        .map(ingredient => ({ name: name(ingredient?.name), amount: Number.isFinite(ingredient?.amount) ? ingredient.amount : 1 }))
        .filter(ingredient => ingredient.name)
        .slice(0, 6),
    }
  }
  return node
}

function sanitizeLocked(raw) {
  const subject = name(raw?.subject)
  if (!subject || !ROLES.has(raw?.role)) return undefined
  const entry = { subject, role: raw.role, path: asArray(raw.path).map(name).filter(Boolean).slice(0, 16) }
  for (const key of ['recipe', 'needed_for', 'unlocked_by']) {
    const value = name(raw[key])
    if (value) entry[key] = value
  }
  if (raw.unlock_unknown === true) entry.unlock_unknown = true
  if (raw.path_truncated === true) entry.path_truncated = true
  if (typeof raw.path_error === 'string') entry.path_error = text(raw.path_error, 60)
  return entry
}

function sanitizeMachines(raw) {
  const forItem = name(raw?.for_item)
  if (!forItem) return undefined
  return {
    for_item: forItem,
    recipe: name(raw.recipe) ?? forItem,
    craftable: raw.craftable === true,
    truncated: raw.truncated === true,
    options: asArray(raw.options)
      .map(option => ({
        entity: name(option?.entity),
        item: name(option?.item),
        status: ['craftable', 'locked', 'no_recipe'].includes(option?.status) ? option.status : 'no_recipe',
        unlocked_by: name(option?.unlocked_by),
      }))
      .filter(option => option.entity && option.item)
      .slice(0, 8),
  }
}

// { ok: true, ... } or { ok: false, reason, error? }. Strict: a malformed
// answer is "unavailable", never partly trusted.
export function parseGoalRequirements(raw) {
  let parsed
  try { parsed = JSON.parse(String(raw ?? '').trim()) }
  catch { return { ok: false, reason: 'lookup_unreadable' } }
  if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) {
    const error = parsed?.error
    const detail = typeof error === 'string' ? error : [error?.code, error?.message].filter(value => typeof value === 'string').join(': ')
    return { ok: false, reason: 'lookup_failed', error: text(detail, 200) || undefined }
  }
  const research = {}
  for (const [technology, node] of Object.entries(asObject(parsed.research)).slice(0, 32)) {
    if (name(technology)) research[technology] = sanitizeNode(node)
  }
  const truncated = asObject(parsed.truncated)
  const counts = asObject(parsed.counts)
  return {
    ok: true,
    tick: Number.isFinite(parsed.tick) ? parsed.tick : undefined,
    locked: asArray(parsed.locked).map(sanitizeLocked).filter(Boolean).slice(0, 16),
    research,
    machines: asArray(parsed.machines).map(sanitizeMachines).filter(Boolean).slice(0, MAX_TARGETS),
    unknown: asArray(parsed.unknown).map(name).filter(Boolean).slice(0, MAX_TARGETS),
    counts: {
      locked: count(counts.locked),
      recipes_walked: count(counts.recipes_walked),
      unlocked_recipes: count(counts.unlocked_recipes),
      raw_items: count(counts.raw_items),
    },
    truncated: Object.fromEntries(Object.entries(truncated).filter(([, value]) => value === true).map(([key]) => [key, true])),
  }
}

// --- rendering --------------------------------------------------------------

function triggerText(trigger) {
  const fields = []
  for (const key of ['item', 'entity', 'fluid']) if (trigger[key]) fields.push(`${key} ${trigger[key]}${trigger[`${key}_quality`] ? ` (${trigger[`${key}_quality`]})` : ''}`)
  if (trigger.count !== undefined) fields.push(`count ${trigger.count}`)
  if (trigger.amount !== undefined) fields.push(`amount ${trigger.amount}`)
  return `trigger ${trigger.type}${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`
}

function scienceText(science) {
  const ingredients = science.ingredients.map(ingredient => `${ingredient.amount} ${ingredient.name}`).join(' + ')
  return `lab research${science.count !== undefined ? `, ${science.count} units` : ''}${ingredients ? ` of ${ingredients}` : ''}`
}

// One research node: its name and exactly what it takes.
export function describeResearchNode(technology, node) {
  if (!node) return technology
  const detail = node.mode === 'trigger' && node.trigger
    ? triggerText(node.trigger)
    : node.mode === 'trigger' ? 'trigger' : node.science ? scienceText(node.science) : 'lab research'
  const flag = node.status === 'disabled' || node.status === 'research_disabled' ? '; research is disabled' : ''
  return `${technology} [${detail}${flag}]`
}

const ROLE_LABEL = {
  target_recipe: () => 'recipe of a goal target',
  ingredient_recipe: entry => `ingredient recipe${entry.needed_for ? `, needed for ${entry.needed_for}` : ''}`,
  machine: entry => `machine${entry.needed_for ? ` that crafts ${entry.needed_for} (machine output)` : ''}`,
  target_entity: entry => `entity of a goal target${entry.needed_for ? `, placed by item ${entry.needed_for}` : ''}`,
  target_technology: () => 'technology of a goal target',
}

function lockedLine(entry, research, index) {
  const label = ROLE_LABEL[entry.role](entry)
  const subject = entry.recipe && entry.recipe !== entry.subject ? `${entry.subject} (recipe ${entry.recipe})` : entry.subject
  let line = `${index}. ${subject} [${label}] ${entry.role === 'target_technology' ? 'is NOT RESEARCHED yet' : 'is LOCKED'}.`
  if (entry.unlock_unknown) {
    line += ' No technology in the running game unlocks this recipe.'
    return text(line, REQUIREMENTS_MAX_LINE_CHARS)
  }
  if (entry.role !== 'target_technology') line += ` Unlocked by technology ${entry.unlocked_by}.`
  if (entry.path.length === 0) {
    line += entry.path_error ? ` Research path unavailable (${entry.path_error}).` : ' Nothing is left to research.'
  }
  else {
    const steps = entry.path.map(technology => describeResearchNode(technology, research[technology]))
    line += ` Research in this order: ${steps.join(' -> ')}${entry.path_truncated ? ' -> ... (path truncated)' : ''}.`
  }
  return text(line, REQUIREMENTS_MAX_LINE_CHARS)
}

// Machine-output targets for which the game has no placeable crafting machine.
function machineGaps(parsed) {
  return parsed.machines.filter(report => report.options.length === 0)
}

// What needs the planner's attention in a parsed answer.
export function requirementsSummary(parsed) {
  if (!parsed?.ok) return { locked_count: 0, machine_gap_count: 0, attention: 0, locked_subjects: [] }
  const gaps = machineGaps(parsed)
  return {
    locked_count: parsed.locked.length,
    machine_gap_count: gaps.length,
    attention: parsed.locked.length + gaps.length,
    locked_subjects: parsed.locked.map(entry => `${entry.role}:${entry.subject}`).slice(0, 12),
  }
}

// The deterministic facts, without the block prefix. '' when nothing needs attention.
export function requirementsFacts(parsed) {
  const summary = requirementsSummary(parsed)
  if (summary.attention === 0) return ''
  const lines = parsed.locked.map((entry, index) => lockedLine(entry, parsed.research, index + 1))
  for (const report of machineGaps(parsed)) {
    lines.push(text(`${lines.length + 1}. No placeable crafting machine in the running game crafts ${report.for_item} (recipe ${report.recipe}); it can only be hand crafted, so a machine-output target for it cannot be met.`, REQUIREMENTS_MAX_LINE_CHARS))
  }
  if (parsed.unknown.length > 0) lines.push(`Not known to the running game: ${parsed.unknown.join(', ')}.`)
  const notes = []
  if (parsed.counts.unlocked_recipes > 0) notes.push(`${parsed.counts.unlocked_recipes} other recipes in the ingredient trees are already unlocked`)
  const truncated = Object.keys(parsed.truncated)
  if (truncated.length > 0) notes.push(`the query hit its bounds (${truncated.join(', ')}), so this list may be incomplete`)
  if (notes.length > 0) lines.push(`${notes.join('; ')}.`)
  const kept = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > REQUIREMENTS_MAX_BLOCK_CHARS) {
      kept.push(`(${lines.length - kept.length} more lines omitted)`)
      break
    }
    kept.push(line)
    used += line.length + 1
  }
  return kept.join('\n')
}

export function requirementsBlock(parsed) {
  const facts = requirementsFacts(parsed)
  if (!facts) return ''
  return `${REQUIREMENTS_PREFIX} Live facts for this goal's targets, read from the running game by the harness (authoritative game data, not advice; re-read each time you author or revise a plan). A locked recipe or machine cannot be crafted or built until its technology is researched, and a trigger technology is completed by performing its exact trigger, not by lab research. Order the unlocking research before any Roadmap node or plan step that needs a locked recipe or machine.\n${facts}`
}

const RECHECK = 'Re-check the Roadmap Shelf and the plan order against these facts: every step that crafts, builds or otherwise needs a locked recipe or machine must come after the research that unlocks it, and a trigger technology is completed by performing its exact trigger. Keep your goal, roadmap and plan if they already respect this, or correct them.'

function requirementsLead(parsed) {
  return `The harness read the live game for the targets of the goal you just defined, before committing anything. ${requirementsBlock(parsed).replace(REQUIREMENTS_PREFIX, 'Requirements:')}\n${RECHECK}`
}

// The corrective round for the first plan of a goal.
export function requirementsChallenge(parsed) {
  return `${requirementsLead(parsed)} Resend the complete submitPlan (goal, roadmap and plan); this check is asked only once.`
}

// --- locked-recipe blocker evidence (craft_item preflight) -----------------------

// The bounded facts of the mod's recipe_locked refusal: the recipe, its unlocking
// technology and the next research node that can start now (science or trigger,
// with the exact trigger). Still a terminal refusal; this is evidence only.
export function lockedRecipeFacts(preflight) {
  const recipe = name(preflight?.recipe_name) ?? name(preflight?.identity)
  const raw = asObject(preflight?.unlock)
  const technology = name(raw.unlocked_by)
  const next = raw.next_actionable ? sanitizeNode(raw.next_actionable) : undefined
  const nextName = name(raw.next_actionable?.name)
  return {
    ...(recipe ? { recipe } : {}),
    ...(technology ? { unlocked_by: technology } : {}),
    ...(nextName && next
      ? {
          next_actionable: {
            name: nextName,
            mode: next.mode,
            status: next.status,
            ...(next.trigger ? { trigger: next.trigger } : {}),
            ...(next.science ? { science: next.science } : {}),
          },
        }
      : {}),
    ...(raw.unlock_unknown === true ? { unlock_unknown: true } : {}),
  }
}

// One line of text for those facts ('' when the preflight carried no unlock facts).
export function lockedRecipeText(facts) {
  if (!facts?.unlocked_by && facts?.unlock_unknown !== true) return ''
  let line = facts.recipe ? `${facts.recipe} is locked` : 'the recipe is locked'
  if (facts.unlocked_by) line += ` until technology ${facts.unlocked_by} is researched`
  else line += ' and no technology unlocks it'
  const next = facts.next_actionable
  if (next && next.name !== facts.unlocked_by) line += `; next research: ${describeResearchNode(next.name, next)}`
  else if (next) line += `; ${describeResearchNode(next.name, next)}`
  return text(line, 360)
}

export function describeLockedRecipePreflight(preflight) {
  const facts = lockedRecipeFacts(preflight)
  return { facts, text: lockedRecipeText(facts) }
}

const LOCKED_RECIPE_BLOCKER = 'operation_preflight_failed:recipe_locked'
// The reducer keeps at most 120 characters of a blocker code.
const BLOCKER_MAX_CHARS = 120

// The blocker string. The `operation_preflight_failed:recipe_locked` prefix is
// unchanged (reducer reason codes and the supervisor summary key on it); the
// unlocking technology follows it when it fits. The next research node and the
// exact trigger travel in the blocker evidence (lockedRecipeFacts).
export function lockedRecipeBlocker(preflight) {
  const technology = lockedRecipeFacts(preflight).unlocked_by
  const blocker = technology ? `${LOCKED_RECIPE_BLOCKER}:${technology}` : LOCKED_RECIPE_BLOCKER
  return blocker.length <= BLOCKER_MAX_CHARS ? blocker : LOCKED_RECIPE_BLOCKER
}

function lockedRecipeEvidenceFacts(evidence, technology) {
  for (const item of Array.isArray(evidence) ? [...evidence].reverse() : []) {
    if (item?.kind !== 'operation_preflight_blocker' || typeof item.summary !== 'string') continue
    let parsed
    try { parsed = JSON.parse(item.summary) }
    catch { continue }
    const facts = parsed?.locked_recipe
    if (facts && typeof facts === 'object' && (!technology || facts.unlocked_by === technology)) return facts
  }
  return undefined
}

// Player-facing line for that blocker string; undefined for any other string.
// `evidence` (the task board's evidence list) supplies the next research node.
export function lockedRecipeSummary(raw, evidence) {
  if (typeof raw !== 'string' || !raw.startsWith(LOCKED_RECIPE_BLOCKER)) return undefined
  const technology = name(raw.slice(LOCKED_RECIPE_BLOCKER.length).replace(/^:/, '')) ?? undefined
  const facts = lockedRecipeEvidenceFacts(evidence, technology)
  const detail = facts ? lockedRecipeText(lockedRecipeFacts({ recipe_name: facts.recipe, unlock: facts })) : ''
  if (detail) return `SGLuna cannot craft that yet: ${detail}.`
  return technology
    ? `SGLuna cannot craft that yet: the recipe is locked until technology ${technology} is researched.`
    : 'SGLuna cannot craft that yet because the recipe is still locked behind research.'
}

// --- loop hooks -----------------------------------------------------------------

function errorText(error) {
  return text(error instanceof Error ? error.message : String(error), 200)
}

function goalDefinitionFor(loop, memoryKey) {
  const planning = loop.memory?.planningState?.(memoryKey)
  return planning?.goal?.definition ?? loop.memory?.goalDefinition?.(memoryKey)
}

// One query. Never throws. { ok: true, parsed, summary, targets } or
// { ok: false, reason } (traced as planning.requirements_unavailable).
async function queryRequirements(loop, definition, { trigger }) {
  const targets = requirementTargets(definition)
  if (!hasRequirementTargets(targets)) {
    await loop.traceEvent('planning.requirements_unavailable', { trigger, reason: 'no_requirement_targets' })
    return { ok: false, reason: 'no_requirement_targets' }
  }
  let raw
  try { raw = await loop.rcon.command(requirementsCommand(targets)) }
  catch (error) {
    await loop.traceEvent('planning.requirements_unavailable', { trigger, reason: 'lookup_failed', error: errorText(error) })
    return { ok: false, reason: 'lookup_failed' }
  }
  const parsed = parseGoalRequirements(raw)
  if (!parsed.ok) {
    await loop.traceEvent('planning.requirements_unavailable', { trigger, reason: parsed.reason, ...(parsed.error ? { error: parsed.error } : {}) })
    return { ok: false, reason: parsed.reason }
  }
  loop.recordRequirementsFacts?.(parsed) // D2: the machine options stay available to a fresh executor (never throws)
  return { ok: true, parsed, summary: requirementsSummary(parsed), targets }
}

function loadedTrace(result, extra) {
  return {
    target_items: result.targets.items.length,
    target_technologies: result.targets.technologies.length,
    target_entities: result.targets.entities.length,
    locked_count: result.summary.locked_count,
    machine_gap_count: result.summary.machine_gap_count,
    locked_subjects: result.summary.locked_subjects,
    recipes_walked: result.parsed.counts.recipes_walked,
    raw_items: result.parsed.counts.raw_items,
    truncated: Object.keys(result.parsed.truncated),
    ...extra,
  }
}

// Query for a plan-authoring round (revision or shelf pickup) and keep the block
// for it. Leaves no block when nothing needs attention. Never throws.
async function loadRequirements(loop, { memoryKey, trigger, definition }) {
  loop.goalRequirements = null
  if (!definition) {
    await loop.traceEvent('planning.requirements_unavailable', { trigger, reason: 'no_goal_definition' })
    return null
  }
  const generation = loop.generation
  const result = await queryRequirements(loop, definition, { trigger })
  if (!result.ok) return null
  // A newer request (a new goal, a cancel) started while the game was read: this
  // answer belongs to the old one and must not reach its planning rounds.
  if (loop.generation !== generation || memoryKey !== loop.activePlanKey?.()) {
    await loop.traceEvent('planning.requirements_unavailable', { trigger, reason: 'superseded' })
    return null
  }
  const block = requirementsBlock(result.parsed)
  if (!block) {
    await loop.traceEvent('planning.requirements_loaded', loadedTrace(result, { trigger, reason: 'no_locked_requirements', shown: false }))
    return null
  }
  loop.requirementsSequence = (loop.requirementsSequence ?? 0) + 1
  const requirements = { seq: loop.requirementsSequence, request_id: loop.traceRequest?.id, memoryKey, trigger, block, authoring: true }
  loop.goalRequirements = requirements
  await loop.traceEvent('planning.requirements_loaded', loadedTrace(result, { trigger, reason: 'locked_requirements_found', shown: true, block_chars: block.length, seq: requirements.seq }))
  return requirements
}

// Hook at the start of a planning request. A new goal has no definition yet, so
// it only resets the per-goal state (the first plan is grounded in
// groundFirstPlan). A revision round re-reads the live game. Never throws.
export async function ensureGoalRequirements(loop, { memoryKey, intent }) {
  try {
    if (intent === 'new_goal') {
      loop.goalRequirements = null
      loop.requirementsGroundingAsked = false
      return null
    }
    if (!isRevisionRound(loop, memoryKey, intent)) return loop.goalRequirements ?? null
    return await loadRequirements(loop, { memoryKey, trigger: 'revision', definition: goalDefinitionFor(loop, memoryKey) })
  }
  catch (error) {
    loop.log?.(`[requirements] revision query failed: ${errorText(error)}`)
    return null
  }
}

// Hook at the shelf -> active plan boundary (also used when the goal is active
// and the planner is woken for its next slice without a shelf). Never throws.
export async function refreshGoalRequirementsAtShelfPickup(loop, planning, trigger = 'shelf_pickup') {
  try {
    return await loadRequirements(loop, {
      memoryKey: loop.activePlanKey(),
      trigger,
      definition: planning?.goal?.definition ?? goalDefinitionFor(loop, loop.activePlanKey()),
    })
  }
  catch (error) {
    loop.log?.(`[requirements] shelf pickup query failed: ${errorText(error)}`)
    return null
  }
}

// The block, only while the planner is authoring or revising a plan.
export function goalRequirementsContext(loop) {
  const requirements = loop.goalRequirements
  if (!requirements || !requirements.authoring || requirements.memoryKey !== loop.activePlanKey?.()) return ''
  return requirements.block
}

export function injectedRequirementsChars(loop) {
  return goalRequirementsContext(loop).length
}

// Hook in commitPlan: a committed plan ends the authoring round.
export async function retireGoalRequirements(loop, plan) {
  const requirements = loop.goalRequirements
  if (!requirements?.authoring || !Array.isArray(plan?.plan) || plan.plan.length === 0) return
  requirements.authoring = false
  await loop.traceEvent('planning.requirements_retired', { reason: 'plan_committed', trigger: requirements.trigger, seq: requirements.seq })
}

function isFirstPlanOfGoal(loop, plan) {
  if (!plan?.goalDefinition || !Array.isArray(plan.plan) || plan.plan.length === 0) return false
  return !loop.memory?.goalDefinition?.(loop.activePlanKey())
}

// The harness never edits the plan, shelf or steps; it only supplies facts. The
// round goes through the planner's normal plan-category correction path, so it
// costs a provider call that the request's budget accounts for. When the
// retry allowance is already spent the round is skipped (traced), never turned
// into a block.
function canAskGroundingRound(loop) {
  return !(Number.isFinite(loop.maxToolValidationRetries) && (loop.planCategoryRetries ?? 0) >= loop.maxToolValidationRetries)
}

// After the first plan's goal definition is accepted and before the plan is
// committed or any operation admitted: query the live game once per goal. Returns
// { code, message, details } for the planner's corrective round, or undefined.
// The loop turns it into the plan-category error. Never throws.
export async function groundFirstPlan(loop, plan, { recovery = false } = {}) {
  try {
    if (loop.requirementsGroundingAsked || !isFirstPlanOfGoal(loop, plan)) return undefined
    if (recovery) {
      loop.requirementsGroundingAsked = true
      await loop.traceEvent('planning.requirements_grounding_skipped', { reason: 'recovery_path' })
      return undefined
    }
    if (!canAskGroundingRound(loop)) {
      loop.requirementsGroundingAsked = true
      await loop.traceEvent('planning.requirements_grounding_skipped', { reason: 'retry_budget_exhausted', retries: loop.planCategoryRetries })
      return undefined
    }
    loop.requirementsGroundingAsked = true
    const result = await queryRequirements(loop, plan.goalDefinition, { trigger: 'first_plan' })
    if (!result.ok) {
      await loop.traceEvent('planning.requirements_grounding_skipped', { reason: result.reason })
      return undefined
    }
    if (result.summary.attention === 0) {
      await loop.traceEvent('planning.requirements_loaded', loadedTrace(result, { trigger: 'first_plan', reason: 'no_locked_requirements', shown: false }))
      await loop.traceEvent('planning.requirements_grounding_skipped', { reason: 'no_locked_requirements' })
      return undefined
    }
    await loop.traceEvent('planning.requirements_loaded', loadedTrace(result, { trigger: 'first_plan', reason: 'locked_requirements_found', shown: false }))
    await loop.traceEvent('planning.requirements_grounding_round', {
      reason: 'locked_requirements_found',
      locked_count: result.summary.locked_count,
      machine_gap_count: result.summary.machine_gap_count,
      locked_subjects: result.summary.locked_subjects,
      combined_with_goal_reading: false,
      retry: (loop.planCategoryRetries ?? 0) + 1,
    })
    return {
      code: REQUIREMENTS_GROUNDING_CODE,
      message: requirementsChallenge(result.parsed),
      details: { requirements: { locked_count: result.summary.locked_count, machine_gap_count: result.summary.machine_gap_count, locked_subjects: result.summary.locked_subjects } },
    }
  }
  catch (error) {
    loop.log?.(`[requirements] first plan grounding failed: ${errorText(error)}`)
    return undefined
  }
}

// The goal-reading challenge already costs the first plan its one corrective
// round. When requirements are locked their facts ride in that same round
// (never a second one). Mutates the challenge error's message. Never throws.
export async function combineGroundingWithChallenge(loop, challenge, { recovery = false } = {}) {
  try {
    const definition = challenge?.goalDefinition
    if (!definition || loop.requirementsGroundingAsked) return
    if (recovery) {
      loop.requirementsGroundingAsked = true
      await loop.traceEvent('planning.requirements_grounding_skipped', { reason: 'recovery_path', combined_with_goal_reading: true })
      return
    }
    loop.requirementsGroundingAsked = true
    const result = await queryRequirements(loop, definition, { trigger: 'first_plan' })
    if (!result.ok) {
      await loop.traceEvent('planning.requirements_grounding_skipped', { reason: result.reason, combined_with_goal_reading: true })
      return
    }
    if (result.summary.attention === 0) {
      await loop.traceEvent('planning.requirements_loaded', loadedTrace(result, { trigger: 'first_plan', reason: 'no_locked_requirements', shown: false }))
      await loop.traceEvent('planning.requirements_grounding_skipped', { reason: 'no_locked_requirements', combined_with_goal_reading: true })
      return
    }
    await loop.traceEvent('planning.requirements_loaded', loadedTrace(result, { trigger: 'first_plan', reason: 'locked_requirements_found', shown: false }))
    await loop.traceEvent('planning.requirements_grounding_round', {
      reason: 'combined_with_goal_reading_challenge',
      locked_count: result.summary.locked_count,
      machine_gap_count: result.summary.machine_gap_count,
      locked_subjects: result.summary.locked_subjects,
      combined_with_goal_reading: true,
      retry: (loop.planCategoryRetries ?? 0) + 1,
    })
    challenge.message = `${challenge.message}\nSeparately: ${requirementsLead(result.parsed)} Answer both checks in the one complete submitPlan you resend; each is asked only once.`
    challenge.details = { ...(challenge.details ?? {}), requirements: { locked_count: result.summary.locked_count, locked_subjects: result.summary.locked_subjects } }
  }
  catch (error) {
    loop.log?.(`[requirements] combined grounding failed: ${errorText(error)}`)
  }
}
