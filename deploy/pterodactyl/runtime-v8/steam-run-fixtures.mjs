// Recorded replies from the 2026-09-26 steam-power run, trimmed into a static
// scenario (work plan items 1.3 and 1.5). No provider is ever called.
//
// Source: request req_muhsihjg_1 in data/logs/sgluna-prompts.jsonl and
// sgluna-behavior.jsonl (observer record: docs/validation/E2E_STEAM_POWER_2026-09-26.md).
// Kept verbatim per round: usage (output, reasoning, input, cached input),
// reasoning length, finish reason, the observation calls the model made, the
// committed six-step plan with its step-1 operations and checkpoint, the
// step-2 supply batch, the nothing_moved receipt, and the size of every tool
// result. Tool result bodies are padded to the recorded size; only the heads
// are real.
//
// Trimmed: the four completion cycles between 03:06 and 03:25 are left out,
// so step 1 closing is followed directly by the recorded 03:25 cycle and the
// two failure rounds that ended the run. `failure_1`'s two reads were not in
// the trace excerpt and are reconstructed; one read in `tail_2` replaces a
// repeated inventory read that the loop would suppress as a duplicate.
//
// The whole request is two slices of recorded usage:
//   authoring (rounds 0-3):               42,915 output units
//   the last cycle + failure (6 rounds):  20,941 output units (the doc's "last six")

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { providerRequest } from './provider.mjs'
import { FakeFactorio } from './task-loop-fixtures.mjs'

export const STEAM_REQUEST_ID = 'req_muhsihjg_1'
export const STEAM_REQUEST_TEXT = 'Can you get steam power going and run an electric mining drill with it?'

export const STEAM_PLAN = Object.freeze([
  'Hand-mine the first quota: stone, coal, iron ore, copper ore.',
  'Smelt iron/copper plates in stone furnaces; craft gears, cables, circuits, pipes, extra furnaces.',
  'Build red science (lab + automation science packs) and complete the steam-power and electric-mining-drill technologies.',
  'Craft the steam plant parts and drill: offshore pump, boiler, steam engine, pipes, power poles, electric mining drill.',
  'Find water; build pump → boiler → steam engine chain; load coal; verify electricity production.',
  'Place the electric mining drill on an ore patch, connect it to the grid with poles, verify it is running, and keep the boiler fed.',
])

export const STEAM_STEP1_INVENTORY = Object.freeze({ coal: 80, stone: 60, 'iron-ore': 180, 'copper-ore': 70 })

const STEP1_OPERATIONS = Object.entries(STEAM_STEP1_INVENTORY).map(([resource, count]) => ({
  name: 'gather_resource',
  args: { resource_name: resource, count, search_radius: 512 },
}))

const STEP1_CHECKPOINT = {
  mode: 'all',
  requirements: Object.entries(STEAM_STEP1_INVENTORY).map(([item, minimum], index) => ({
    id: `requirement_${index + 1}`,
    kind: 'inventory_count',
    item_name: item,
    minimum,
  })),
}

const STEP2_SUPPLY_OPERATIONS = [
  { name: 'supply_entity', args: { unit_number: 55, items: [{ item_name: 'iron-ore', count: 95 }, { item_name: 'coal', count: 20 }] } },
  { name: 'supply_entity', args: { unit_number: 56, items: [{ item_name: 'iron-ore', count: 94 }, { item_name: 'coal', count: 20 }] } },
  { name: 'supply_entity', args: { unit_number: 57, items: [{ item_name: 'copper-ore', count: 120 }, { item_name: 'coal', count: 20 }] } },
]

// The receipt Autorio returned for the first move of that batch (03:26:16).
export const STEAM_NOTHING_MOVED = Object.freeze({
  type: 'moving_items',
  code: 'nothing_moved',
  target_unit_number: 55,
  item_name: 'iron-ore',
  requested_count: 95,
  to_entity: true,
  moved_count: 0,
})

const read = (name, args = {}) => ({ name, args })

// One entry per provider call, in the order the loop makes them.
export const STEAM_ROUNDS = Object.freeze([
  // Plan authoring (new_goal). Decision pressure fired after round 2
  // ("Consecutive observation-only rounds reached 3"), so round 3 wrote the plan.
  {
    id: 'authoring_0', phase: 'authoring', recorded_policy: 'plan_authoring', recorded_effort: 'max',
    usage: { output: 1141, reasoning: 1059, input: 20237, cached: 11264 }, reasoning_chars: 4554,
    reads: [read('getInventoryItems'), read('getActorStatus'), read('getNearbyEntities', { radius: 64, limit: 40 })],
  },
  {
    id: 'authoring_1', phase: 'authoring', recorded_policy: 'plan_authoring', recorded_effort: 'max',
    usage: { output: 9432, reasoning: 8919, input: 23300, cached: 19712 }, reasoning_chars: 35999,
    reads: [
      read('findLongRangeEntities', { name: 'iron-ore', max_radius: 1024, limit: 8 }),
      read('findLongRangeEntities', { name: 'copper-ore', max_radius: 1024, limit: 8 }),
      read('findLongRangeEntities', { name: 'stone', max_radius: 1024, limit: 8 }),
      read('findLongRangeEntities', { name: 'water', max_radius: 1024, limit: 4 }),
    ],
  },
  {
    id: 'authoring_2', phase: 'authoring', recorded_policy: 'plan_authoring', recorded_effort: 'max',
    usage: { output: 3461, reasoning: 3176, input: 22552, cached: 19712 }, reasoning_chars: 12752,
    reads: ['electric-mining-drill', 'steam-engine', 'boiler', 'offshore-pump']
      .map(item => read('getRecipeDetails', { item_or_recipe: item, requested_count: 1 })),
  },
  {
    id: 'authoring_3', phase: 'authoring', recorded_policy: 'plan_authoring', recorded_effort: 'max',
    usage: { output: 28881, reasoning: 27816, input: 27018, cached: 20224 }, reasoning_chars: 112412,
    submitPlan: {
      chatMessage: 'Yes — starting with the material bootstrap now; research, steam power, and the powered drill follow.',
      plan: STEAM_PLAN,
      currentStep: 0,
      operations: STEP1_OPERATIONS,
      checkpoint: STEP1_CHECKPOINT,
    },
  },
  // Step 1 closes on its inventory contract. Recorded 03:25 cycle for step 2.
  {
    id: 'tail_0', phase: 'step_2', recorded_policy: 'deterministic_completion', recorded_effort: 'low',
    usage: { output: 147, reasoning: 76, input: 16563, cached: 9216 }, reasoning_chars: 331,
    reads: [read('getInventoryItems'), read('getEntityStatus', { name: 'stone-furnace', radius: 8 })],
  },
  {
    id: 'tail_1', phase: 'step_2', recorded_policy: 'deterministic_completion', recorded_effort: 'low',
    usage: { output: 1762, reasoning: 1295, input: 16975, cached: 16000 }, reasoning_chars: 5370,
    reads: [
      read('getResearchPath', { name: 'electric-mining-drill' }),
      read('getRecipe', { item: 'electric-mining-drill' }),
      read('getRecipe', { item: 'boiler' }),
      read('getRecipe', { item: 'steam-engine' }),
    ],
  },
  {
    id: 'tail_2', phase: 'step_2', recorded_policy: 'ordinary_planning', recorded_effort: 'high',
    usage: { output: 1864, reasoning: 1729, input: 31509, cached: 19840 }, reasoning_chars: 6829,
    reads: [
      read('getTechnology', { name: 'steam-power' }),
      read('getRecipeDetails', { item_or_recipe: 'iron-plate' }),
      read('getNearbyEntities', { name: 'stone-furnace', radius: 12, limit: 6 }),
    ],
  },
  {
    id: 'tail_3', phase: 'step_2', recorded_policy: 'ordinary_replan', recorded_effort: 'high',
    usage: { output: 9260, reasoning: 8830, input: 32099, cached: 30080 }, reasoning_chars: 33902,
    submitPlan: { chatMessage: '', plan: STEAM_PLAN, currentStep: 1, operations: STEP2_SUPPLY_OPERATIONS },
  },
  // After the batch failed with nothing_moved (the plan is blocked here).
  {
    id: 'failure_0', phase: 'failure', recorded_policy: 'ordinary_replan', recorded_effort: 'high',
    usage: { output: 532, reasoning: 461, input: 30948, cached: 19968 }, reasoning_chars: 1870,
    reads: [read('getInventoryItems'), read('getEntityStatus', { name: 'stone-furnace', radius: 12 })],
  },
  {
    id: 'failure_1', phase: 'failure', recorded_policy: 'ordinary_replan', recorded_effort: 'high',
    usage: { output: 7376, reasoning: 7268, input: 31360, cached: 30336 }, reasoning_chars: 29435,
    reads: [read('getTechnology', { name: 'electronics' }), read('getRecipeDetails', { item_or_recipe: 'stone-furnace' })],
  },
])

export const STEAM_AUTHORING_OUTPUT_UNITS = 42915
export const STEAM_TAIL_OUTPUT_UNITS = 20941

// The round after failure_1 never happened live: the request died at the cap.
// A replay that survives the cap needs an answer; this one is scripted.
export const STEAM_SCRIPTED_BLOCKED_ANSWER = Object.freeze({
  id: 'scripted_blocked_answer', phase: 'failure', scripted: true,
  usage: { output: 900, reasoning: 700, input: 31800, cached: 30336 }, reasoning_chars: 2800,
  content: {
    chatMessage: 'BLOCKED: furnace 55 accepted no iron ore (transfer_failed:nothing_moved); its source slot needs checking before I supply it again.',
    plan: STEAM_PLAN,
    currentStep: 1,
    operations: [],
  },
})

function usageBody(usage) {
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cached },
    completion_tokens_details: { reasoning_tokens: usage.reasoning },
  }
}

function toolCalls(round) {
  if (round.submitPlan) {
    return [{
      id: `call_${round.id}_submit`,
      type: 'function',
      function: { name: 'submitPlan', arguments: JSON.stringify(round.submitPlan) },
    }]
  }
  return (round.reads ?? []).map((call, index) => ({
    id: `call_${round.id}_${index}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }))
}

// An assistant message in the shape the loop receives from provider.mjs,
// including the non-enumerable provider metadata carrying the usage.
export function recordedMessage(round) {
  const calls = round.content ? [] : toolCalls(round)
  const message = round.content
    ? { role: 'assistant', content: JSON.stringify(round.content) }
    : { role: 'assistant', content: '', tool_calls: calls }
  Object.defineProperty(message, '_airiProvider', {
    enumerable: false,
    value: {
      diagnostic_code: 'ok',
      finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
      output_budget_exhausted: false,
      tool_call_count: calls.length,
      reasoning_content_chars: round.reasoning_chars,
      usage: usageBody(round.usage),
    },
  })
  return message
}

// The same round as the chat-completions HTTP body provider-base.mjs parses.
export function recordedResponseBody(round, model = 'deepseek-flash') {
  const calls = round.content ? [] : toolCalls(round)
  return {
    id: `recorded-${round.id}`,
    model,
    choices: [{
      finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content: round.content ? JSON.stringify(round.content) : '',
        reasoning_content: 'r'.repeat(round.reasoning_chars),
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      },
    }],
    usage: usageBody(round.usage),
  }
}

// Recorded tool-result sizes (characters), keyed by the RCON command marker.
const RECORDED_RESULT_SIZES = [
  ['"autorio_actor","status"', 630],
  ['"find_entities",\'iron-ore\'', 1437],
  ['"find_entities",\'copper-ore\'', 1477],
  ['"find_entities",\'stone\'', 1424],
  ['"recipe_details",\'electric-mining-drill\'', 5445],
  ['"recipe_details",\'steam-engine\'', 5283],
  ['"recipe_details",\'boiler\'', 2705],
  ['"recipe_details",\'offshore-pump\'', 3868],
  ['"recipe_details",\'iron-plate\'', 2545],
  ['"recipe_details",\'stone-furnace\'', 1873],
  ['"get_entity_status"', 758],
  ['"research_path"', 3029],
  ['"autorio_research","technology"', 326],
]

function paddedJson(head, size) {
  const base = JSON.stringify({ ...head, detail: '' })
  const filler = 'x'.repeat(Math.max(0, size - base.length))
  return JSON.stringify({ ...head, detail: filler })
}

// FakeFactorio answering the recorded reads at their recorded sizes, with the
// three furnaces the run supplied (units 55-57) visible to nearby reads so the
// exact supply targets bind through a live observation.
export class RecordedSteamFactorio extends FakeFactorio {
  constructor(options = {}) {
    super(options)
    this.nearby = {
      observation_mode: 'full',
      source: 'live_factorio_nearby_entities',
      actor_position: { x: 98.17, y: -37.93 },
      entities: [55, 56, 57].map((unit, index) => ({
        name: 'stone-furnace',
        type: 'furnace',
        unit_number: unit,
        position: { x: 99, y: -37 + index * 2 },
        force: 'player',
        status: 'no_ingredients',
      })),
    }
  }

  async command(text) {
    if (text.includes('"get_inventory_items"')) {
      return JSON.stringify(Object.entries(this.inventory).map(([name, count]) => ({ name, count })))
    }
    if (text.includes('"find_entities",\'water\'')) {
      return JSON.stringify({ found: false, entities: {}, error: 'invalid entity name', name: 'water' })
    }
    for (const [marker, size] of RECORDED_RESULT_SIZES) {
      if (text.includes(marker)) return paddedJson({ found: true, recorded_marker: marker, source: 'steam_run_2026_09_26' }, size)
    }
    return super.command(text)
  }
}

// The live system prompt is tens of kilobytes; the first recorded request
// carried 53,992 message characters. A toy prompt would hide working-context
// and compaction behavior, so the replay uses one of comparable size.
const REPLAY_SYSTEM_PROMPT = [
  'You are SGLuna, an autonomous Factorio NPC. Plan with the approved observation tools and submit plans with submitPlan.',
  ...Array.from({ length: 300 }, (_, index) => `Rule ${index + 1}: prefer grounded observations over guesses; keep plans bounded to the active step and verify world state before claiming progress.`),
].join('\n')

export const STEAM_PROVIDER_CONFIG = Object.freeze({
  key: 'fixture-key-not-a-secret',
  model: 'deepseek-flash',
  base: 'https://provider.invalid/v1',
  profile: 'deepseek',
  timeoutMs: 5000,
})

// Drives the real NpcAgentLoop through request()/completed()/failed() with the
// recorded replies. `transport: 'http'` sends every call through the real
// provider.mjs + provider-base.mjs stack (effort, output cap, prompt trace)
// against a replay fetch; `transport: 'message'` hands the loop recorded
// messages directly, as the other loop tests do.
export function steamReplayHarness({
  transport = 'message',
  maxProviderOutputUnits = 100000,
  promptTraceFile = null,
  extraRounds = [],
  // When set, chat is routed like the live stack (the router answers with
  // this intent) instead of bypassing the interaction router.
  routedIntent,
} = {}) {
  const game = new RecordedSteamFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const rounds = [...STEAM_ROUNDS, ...extraRounds]
  const calls = []
  const trace = []

  const nextRound = () => {
    const round = rounds[calls.length]
    if (!round) throw new Error(`steam replay exhausted after ${calls.length} provider calls`)
    return round
  }
  const provider = transport === 'http'
    ? (messages, context) => providerRequest(STEAM_PROVIDER_CONFIG, messages, {
        ...context,
        promptTraceFile,
        fetchImpl: async (_url, init) => {
          const round = nextRound()
          calls.push({ round, context, body: JSON.parse(init.body) })
          return new Response(JSON.stringify(recordedResponseBody(round)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      })
    : async (messages, context) => {
        const round = nextRound()
        calls.push({ round, context, messages })
        return recordedMessage(round)
      }

  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider,
    maxProviderOutputUnits,
    ...(routedIntent ? { interactionProvider: async () => ({ content: JSON.stringify({ intent: routedIntent(), queue_conflict: false, reply: '' }) }) } : {}),
    systemPrompt: REPLAY_SYSTEM_PROMPT,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  // Capture the behavior trace records (request_id, seq, event, data) exactly
  // as the JSONL writer would receive them.
  agent.behaviorTrace = { emit: async record => { trace.push(record) } }

  return {
    game,
    memory,
    agent,
    calls,
    trace,
    events: name => trace.filter(record => record.event === name),
    request: () => agent.request(STEAM_REQUEST_TEXT, { sender: 'TTLouis' }),
    closeStep1: () => {
      Object.assign(game.inventory, STEAM_STEP1_INVENTORY)
      return agent.completed()
    },
    failSupplyBatch: () => agent.failed(game.failLastBatch({ ...STEAM_NOTHING_MOVED })),
  }
}
