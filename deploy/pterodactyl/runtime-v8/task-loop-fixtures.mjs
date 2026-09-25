// Shared fixtures for driving the real NpcAgentLoop through whole task loops.
//
// Unlike the reducer tests, these go through `request()` / `completed()` /
// `failed()` exactly as the supervisor does, against a fake Factorio that
// speaks the real RCON protocol, and a Jev that answers in the shape the live
// TypeSafe decision provider produces (one `choice`/`score`/`noul` per
// question, never the retired aggregate `multi_choice` shape).

import assert from 'node:assert/strict'
import { after } from 'node:test'
import { DECISION_PROVIDER_DEFAULTS, normalizeDecisionProviderRequest } from './provider.mjs'

// Fake decision providers bypass the real TypeSafe adapter, so a request the
// live adapter would reject still "works" in unit tests. That is how every live
// Jev call fell back on 2026-09-24 while CI stayed green. Every fixture Jev
// therefore runs the real request normalizer, with production limits, on the
// exact state/questions the runtime built. The loop swallows provider errors
// into fallbacks, so violations are also collected and fail the file.
const LIVE_DECISION_CONTRACT = Object.freeze({ ...DECISION_PROVIDER_DEFAULTS, key: 'fixture-contract-check' })
export const jevContractLog = []

after(() => {
  const violations = jevContractLog.filter(entry => !entry.ok)
  assert.deepEqual(violations, [], 'a Jev boundary built a request the live TypeSafe adapter rejects')
})

export function contractCheckedJev(provider) {
  const checked = async (state, questions, context) => {
    const keys = Object.keys(questions ?? {})
    try {
      normalizeDecisionProviderRequest(LIVE_DECISION_CONTRACT, state, questions)
      jevContractLog.push({ keys, ok: true })
    }
    catch (error) {
      jevContractLog.push({ keys, ok: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    return provider(state, questions, context)
  }
  return Object.assign(checked, provider)
}

export function deployment(overrides = {}) {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 1,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
    ...overrides,
  }
}

// Mirrors the strict receipt task types Autorio reports per admitted operation.
const TASK_TYPES_BY_OPERATION = {
  gather_resource: ['walking_to_entity', 'mining'],
  mine_entity: ['mining'],
  harvest_product: ['harvesting'],
  craft_item: ['crafting'],
  place_entity: ['placing'],
  walk_to_entity: ['walking_to_entity'],
  launch_rocket: ['launching_rocket'],
}

export class FakeFactorio {
  constructor({ inventory = {}, preflight } = {}) {
    this.status = deployment()
    this.inventory = { ...inventory }
    this.preflight = preflight ?? (() => ({ ok: true }))
    this.mutations = []
    this.batchId = 0
    this.lastTaskTypes = []
    this.taskState = 'idle'
    this.queueLength = 0
    this.unknown = []
    // Force-level facts for goal done_when conditions.
    this.rocketsLaunched = 0
    this.researched = new Set()
    this.produced = {}
    this.knownTechnologies = new Set(['automation', 'logistics', 'rocket-silo', 'electronics'])
    this.progressFactsAvailable = true
    // Optional hook run on every admitted batch, for scenarios whose world
    // changes because of what was admitted (a launch raising the rocket count).
    this.onMutation = null
    // What getNearbyEntities reports, so a scenario can bind an exact
    // unit_number through a live observation.
    this.nearby = { actor_position: { x: 0, y: 0 }, entities: [] }
    // Overrides the basic-operation receipt, for a scenario whose operation fails.
    this.lastBasicResult = undefined
    // What autorio_skills.get returns per skill id, so getSkillDetails can
    // load task-local skill context.
    this.skills = {}
  }

  // Mirrors autorio_tools.goal_progress_facts.
  goalProgressFacts(request) {
    if (!this.progressFactsAvailable) throw new Error('Unknown interface: goal_progress_facts')
    const milestones = {}
    for (const name of request.technologies ?? []) {
      if (this.knownTechnologies.has(name)) milestones[name] = this.researched.has(name)
    }
    return {
      ok: true,
      rockets_launched: this.rocketsLaunched,
      researched_technologies: this.researched.size,
      enabled_technologies: this.knownTechnologies.size,
      milestones,
      space_age: false,
    }
  }

  // Mirrors autorio_tools.evaluate_condition for goal-level kinds.
  evaluateGoalCondition(request) {
    if (request.kind === 'rockets_launched') {
      return { ok: true, kind: request.kind, satisfied: this.rocketsLaunched >= request.minimum, current: this.rocketsLaunched, minimum: request.minimum }
    }
    if (request.kind === 'research_completed') {
      if (!this.knownTechnologies.has(request.technology)) return { ok: false, error: 'unknown_technology', technology: request.technology }
      return { ok: true, kind: request.kind, satisfied: this.researched.has(request.technology), technology: request.technology }
    }
    if (request.kind === 'items_produced') {
      const current = this.produced[request.item_name] ?? 0
      return { ok: true, kind: request.kind, satisfied: current >= request.minimum, current, minimum: request.minimum }
    }
    return undefined
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: this.taskState,
        queue_empty: this.queueLength === 0,
        queue_length: this.queueLength,
        last_completed_batch: this.batchId > 0
          ? { batch_id: this.batchId, task_count: this.lastTaskTypes.length, task_types: this.lastTaskTypes, tick: 600 + this.batchId }
          : undefined,
        basic_operation: this.batchId > 0 ? { last_result: this.lastBasicResult ?? { operation_id: this.batchId, code: 'completed', completed: true } } : undefined,
      })
    }
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify(this.nearby)
    if (text.includes('remote.call("autorio_skills","get"')) {
      const id = /remote\.call\("autorio_skills","get",'([^']+)'\)/.exec(text)?.[1]
      return JSON.stringify(this.skills[id] ?? { ok: false, error: 'unknown_skill' })
    }
    if (text.includes('remote.call("autorio_follow","status")')) {
      return JSON.stringify({ active: false, healthy: false, controller_live: false, state: 'idle' })
    }
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      return JSON.stringify(this.preflight(text))
    }
    if (text.includes('"goal_progress_facts"')) {
      const encoded = /helpers\.json_to_table\('((?:[^'\\]|\\.)*)'\)/.exec(text)?.[1]
      return JSON.stringify(this.goalProgressFacts(JSON.parse(encoded.replace(/\\(.)/g, '$1'))))
    }
    if (text.includes('"evaluate_condition"') || text.includes("'evaluate_condition'")) {
      const encoded = /helpers\.json_to_table\('((?:[^'\\]|\\.)*)'\)/.exec(text)?.[1]
      if (encoded) {
        const request = JSON.parse(encoded.replace(/\\(.)/g, '$1'))
        const goalResult = this.evaluateGoalCondition(request)
        if (goalResult) return JSON.stringify(goalResult)
      }
      const item = /item_name\s*=\s*["']([^"']+)["']/.exec(text)?.[1]
        ?? /"item_name"\s*:\s*"([^"]+)"/.exec(text)?.[1]
      const minimum = Number(/minimum\s*=\s*(\d+)/.exec(text)?.[1] ?? /"minimum"\s*:\s*(\d+)/.exec(text)?.[1] ?? 1)
      const current = this.inventory[item] ?? 0
      return JSON.stringify({ ok: true, satisfied: current >= minimum, current, minimum, item_name: item })
    }
    if (text.includes('local ok,result=pcall') && text.includes('"authorize"')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      this.mutations.push(text)
      this.batchId++
      this.lastTaskTypes = [...text.matchAll(/remote\.call\('autorio_operations','([a-z_]+)'/g)]
        .flatMap(([, name]) => TASK_TYPES_BY_OPERATION[name] ?? ['waiting'])
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      this.onMutation?.(text)
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    this.unknown.push(text.slice(0, 160))
    return '{}'
  }
}

// Preferred live answers for every choice question family Jev can be asked.
const PREFERRED_CHOICES = [
  'actionable', 'none', 'advances_current', 'checkpoint_here', 'candidate_1',
  'vertical', 'new_goal', 'normal', 'checkpoint', 'maintain',
]

// Jev's blind goal reading defaults to "no opinion" so it never challenges a
// planner in tests that do not script it.
const NEUTRAL_ANSWERS = {
  goal_scope: { choice: 'unclear', confidence: 0.9 },
  goal_family: { choice: 'other', confidence: 0.9 },
}

export function liveShapedAnswer(questions, overrides = {}) {
  const answers = {}
  for (const [id, question] of Object.entries(questions ?? {})) {
    if (Object.hasOwn(overrides, id)) {
      answers[id] = overrides[id]
      continue
    }
    if (Object.hasOwn(NEUTRAL_ANSWERS, id)) {
      answers[id] = NEUTRAL_ANSWERS[id]
      continue
    }
    const criteria = question?.criteria
    if (question?.type === 'score') {
      const length = Array.isArray(criteria) ? criteria.length : Object.keys(criteria ?? {}).length
      answers[id] = { score: Math.max(0, length - 1) }
      continue
    }
    if (question?.type === 'noul') {
      answers[id] = { noul: 0.1 }
      continue
    }
    const keys = Array.isArray(criteria) ? criteria : Object.keys(criteria ?? {})
    const choice = PREFERRED_CHOICES.find(value => keys.includes(value)) ?? keys[0]
    answers[id] = { choice, confidence: 0.9 }
  }
  return { answers, provider: 'fixture-jev', model: 'fixture-live-shape' }
}

// A Jev that answers every question family in the live provider shape and
// records what it was asked. `script(state, questions, call)` may return a
// full response, a partial `overrides` object via { overrides }, or throw.
export function recordingJev(script) {
  const calls = []
  const provider = contractCheckedJev(async (state, questions, context) => {
    const call = { index: calls.length, keys: Object.keys(questions ?? {}), state }
    calls.push(call)
    const scripted = script ? await script(state, questions, call, context) : undefined
    if (scripted?.answers) return scripted
    return liveShapedAnswer(questions, scripted?.overrides ?? {})
  })
  provider.calls = calls
  provider.callsWith = key => calls.filter(call => call.keys.includes(key))
  return provider
}

export function planReply({ chatMessage = 'Working.', plan, currentStep = 0, operations = [], checkpoint, ...rest }) {
  return {
    content: JSON.stringify({
      chatMessage,
      plan,
      currentStep,
      operations,
      ...(checkpoint ? { checkpoint } : {}),
      ...rest,
    }),
  }
}

export function inventoryCheckpoint(itemName, minimum) {
  return {
    mode: 'all',
    requirements: [{ id: `${itemName}_target`, kind: 'inventory_count', item_name: itemName, minimum }],
  }
}

export function gather(resourceName, count = 10) {
  return { name: 'gather_resource', args: { resource_name: resourceName, count, search_radius: 32 } }
}
