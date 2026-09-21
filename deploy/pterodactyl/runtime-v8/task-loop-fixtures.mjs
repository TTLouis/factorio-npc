// Shared fixtures for driving the real NpcAgentLoop through whole task loops.
//
// Unlike the reducer tests, these go through `request()` / `completed()` /
// `failed()` exactly as the supervisor does, against a fake Factorio that
// speaks the real RCON protocol, and a Jev that answers in the shape the live
// TypeSafe decision provider produces (one `choice`/`score`/`noul` per
// question, never the retired aggregate `multi_choice` shape).

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
        basic_operation: this.batchId > 0 ? { last_result: { operation_id: this.batchId, code: 'completed', completed: true } } : undefined,
      })
    }
    if (text.includes('remote.call("autorio_follow","status")')) {
      return JSON.stringify({ active: false, healthy: false, controller_live: false, state: 'idle' })
    }
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      return JSON.stringify(this.preflight(text))
    }
    if (text.includes('"evaluate_condition"') || text.includes("'evaluate_condition'")) {
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

export function liveShapedAnswer(questions, overrides = {}) {
  const answers = {}
  for (const [id, question] of Object.entries(questions ?? {})) {
    if (Object.hasOwn(overrides, id)) {
      answers[id] = overrides[id]
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
  const provider = async (state, questions, context) => {
    const call = { index: calls.length, keys: Object.keys(questions ?? {}), state }
    calls.push(call)
    const scripted = script ? await script(state, questions, call, context) : undefined
    if (scripted?.answers) return scripted
    return liveShapedAnswer(questions, scripted?.overrides ?? {})
  }
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
