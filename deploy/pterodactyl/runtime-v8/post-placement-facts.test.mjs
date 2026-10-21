import assert from 'node:assert/strict'
import test from 'node:test'

import { EXECUTOR_ROLE } from './agent-roles.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { buildHandoffPacket } from './handoff-packet.mjs'
import { applyPlanningEvent, createEmptyPlanningState, getActivePlan, MAX_REVIEW_NOTES_CHARS, PLANNING_EVENT } from './planning-state.mjs'
import { POST_BATCH_COVERAGE_REASON, POST_BATCH_FACTS_PREFIX, postBatchStepKey } from './post-batch-facts.mjs'
import * as topologyContext from './topology-context.mjs'
import { answersStepContract, FakeFactorio, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

const { TOPOLOGY_LIMITS, TOPOLOGY_PREFIX, topologyEntities, topologyText } = topologyContext

// Run AJ (2026-10-21, req_mvi6bs3r_1), step 5 "Establish a shoreline pump, connected boiler and steam engine". Shapes from
// test-results/red-automation-live-2026-10-21aj; the model and Jev replies are scripted and no provider is called.
//  A. The planner's 1,122-char review notes were cut at 500 chars in the C3 step block; the whole copy rode only in the working
//     messages and was gone after the first batch-receipt continuation (14:21:30Z) and from both C7 restages.
//  B. The C3 packet (5,266 chars, 11 historical fluid_source_hints) was sized while fresh_topology had no entities. After batch 32
//     placed offshore-pump unit 37 the block was 1,080 chars in a 734-char room, and unit 37 was the entity trimmed away.
//  C. Jev selected only nearby_world, so [POST_BATCH_FACTS] held only the inventory, and the executor spent its one closed-round
//     targeted read on getEntityStatus(37).
const KEY = 'npc:sgluna'
const RUN_AJ_NOTES = "Continue the unchanged shoreline-construction step. Missing placement candidates are an observation gap, not yet a demonstrated blocker. Verify the last movement with getNavigationStatus, then read fresh water and covered-fluid hints at the current shoreline. For exposed water, request getPlacementCandidates for offshore-pump near the observed shoreline and execute only a returned candidate ID; do not guess pump coordinates. If covered water is selected, use the required preparation workflow and revalidate afterward. After placement, obtain the pump's live unit_number and fluid geometry. Request boiler candidates using connects_to on its water port, then observe the placed boiler and use its steam-output port for connected engine candidates, adding validated pipes only if necessary. Place and observe each dependency before selecting the next connection. Verify the completed fluid chain with getLogisticsTopology. Unplaced machines cannot yet supply runtime geometry; obtain it after placing them. Preserve the existing iron-production cell and leave electrical distribution and coal delivery to the next step."
// The tail the executor never saw again in Run AJ.
const NOTES_TAIL = "After placement, obtain the pump's live unit_number and fluid geometry. Request boiler candidates using connects_to on its water port"
// The two C3 packet rows of the 14:21:30Z provider request, verbatim (stable block 1,545 chars, step block 3,719 chars).
const AJ_STABLE = "[HANDOFF] Rebuilt from durable harness state, not from the previous conversation. Verify against the world before acting.\n--- plan block (stable while this plan runs) ---\ngoal_id: goal_19qf4j1_1\ngoal: Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.\nscope: long_horizon; Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources, with automatic ingredient and fuel delivery.\ndone_when done_1: machines produce 1 × automation-science-pack per minute (last 1 min, hand work excluded)\nroadmap_node: starter-electricity: Establish working steam electricity\nplan: goal_19qf4j1_1_p5 v1\nstep 1: goal_19qf4j1_1_p5_v1_s1_055mho5 | Obtain five stone and craft one additional stone furnace for the boiler, preserving the existing iron-production cell.\nstep 2: goal_19qf4j1_1_p5_v1_s2_14rep73 | Craft one offshore pump, one boiler and one steam engine.\nstep 3: goal_19qf4j1_1_p5_v1_s3_058g55w | Prepare four wood and twelve coal for electrical distribution and startup fuel.\nstep 4: goal_19qf4j1_1_p5_v1_s4_1cnnnnl | Craft four small electric poles, eight spare pipes, one inserter and one wooden chest.\nstep 5: goal_19qf4j1_1_p5_v1_s5_1dplaiu | Establish a shoreline pump, connected boiler and steam engine using validated live fluid geometry.\nstep 6: goal_19qf4j1_1_p5_v1_s6_0togvpu | Connect electrical distribution and chest-to-boiler coal delivery, then verify the engine generates electricity and the inserter is powered."
const AJ_STEP = "--- step block ---\nrestage: role=executor checkpoint=C3 reason=executor_fresh_at_plan_commit\nactor: actor_id=18 actor_kind=standalone_character epoch=1 connected_players=0\nplan_status: EXECUTING; steps 1:completed 2:completed 3:completed 4:completed 5:active 6:pending\nactive_step: 5 of 6 goal_19qf4j1_1_p5_v1_s5_1dplaiu | Establish a shoreline pump, connected boiler and steam engine using validated live fluid geometry. | batches=0 accepted_for_close=0\nexecution_guidance (planner choice; revalidate live facts): {\"approach\":\"Select an observed exposed-water site, approach dry land, and build a pump-to-boiler-to-engine chain using native placement candidates and exact fluid connections.\",\"rationale\":\"The local 128-tile water scan was empty, not a world blocker. Use the wider observation or a fresh water read to select the site; direct connections minimize pipe use.\",\"constraints\":[\"Read fresh water and inspect covered-fluid hints before pump placement.\",\"Use place_candidate for the offshore pump.\",\"Validate fluid connections using freshly observed entity identities.\"],\"skillIds\":[],\"materialSupply\":null}\nplanner_review_notes (the planner's reply to your review of this step; the plan is unchanged; advisory, not world evidence): Continue the unchanged shoreline-construction step. Missing placement candidates are an observation gap, not yet a demonstrated blocker. Verify the last movement with getNavigationStatus, then read fresh water and covered-fluid hints at the current shoreline. For exposed water, request getPlacementCandidates for offshore-pump near the observed shoreline and execute only a returned candidate ID; do not guess pump coordinates. If covered water is selected, use the required preparation workflow an…\nauthority: active_step=goal_19qf4j1_1_p5_v1_s5_1dplaiu (committed plan) contract=all (committed) latest_receipt=#3 operation_receipt batch-g1-31 (this step) entity_ids_in_receipts_and_snapshots=historical_observations\nresidual_needs (derived from recipe_fact and fresh held_counts for the step contract build:offshore-pumpx1,build:boilerx1,build:steam-enginex1; shared stock counted once): steam-engine required=1 held=1 missing=0 [build steam-engine: placed=0 of 1, 1 more to place] | boiler required=1 held=1 missing=0 [build boiler: placed=0 of 1, 1 more to place] | offshore-pump required=1 held=1 missing=0 [build offshore-pump: placed=0 of 1, 1 more to place]\nfluid_source_hints (HISTORICAL: positions where native fluid tiles were observed earlier, newest first; NOT current, not nearest, not a reachable or legal placement; re-check with getFluidSourceTiles before placing anything): water:water@(9,51) approach=(8,49.5) surface=1 observed tick:98887,epoch:1 | water:water@(9,48) approach=(8.5,47.5) surface=1 observed tick:98887,epoch:1 | water:water@(7,51) approach=(7.5,51.5) surface=1 observed tick:98887,epoch:1 | water:water@(8,51) approach=(7.5,50.5) surface=1 observed tick:98887,epoch:1 | water:water@(9,50) approach=(8.5,49.5) surface=1 observed tick:98887,epoch:1 | water:water@(9,49) approach=(8.5,48.5) surface=1 observed tick:98887,epoch:1 | water:water@(8,50) approach=(7.5,51.5) surface=1 observed tick:98887,epoch:1 | water:water@(8,49) approach=(8.5,49.5) surface=1 observed tick:98887,epoch:1 | water:water@(9,47) approach=(9.5,47.5) surface=1 observed tick:97221,epoch:1 coverage=INCOMPLETE(93 chunks ungenerated; nearer water may exist) | water:water@(11,47) approach=(10.5,46.5) surface=1 observed tick:93783,epoch:1 coverage=INCOMPLETE(107 chunks ungenerated; nearer water may exist) | water:water@(12,46) approach=(11.5,45.5) surface=1 observed tick:93783,epoch:1 coverage=INCOMPLETE(107 chunks ungenerated; nearer water may exist) | (+5 more)"
// The 679-char block that request sent: the 1,080-char read with unit 37 trimmed out of `entities`.
const AJ_SENT_TOPOLOGY = "fresh_topology: {\"state\":\"fresh\",\"source\":\"native_bounded_reads\",\"actor_id\":18,\"epoch\":1,\"session\":\"a1c841f8b08d226acfac1cbf01f32725da3e8cce3a98b8cedb1a7e25bbb214ac\",\"reason\":\"bounded_safe_boundary_native_facts\",\"identities\":\"observations_not_execution_authority\",\"observed_tick\":104273,\"surface_index\":1,\"force_index\":1,\"truncated\":true,\"entities\":[],\"held\":{\"wooden-chest\":1,\"inserter\":1,\"small-electric-pole\":4,\"pipe\":8,\"boiler\":1,\"steam-engine\":1,\"copper-plate\":8,\"copper-cable\":1},\"held_scope\":\"selected_inventory_items; omitted_counts_unknown\",\"held_omitted\":2,\"capacity\":[],\"expansion\":\"capacity_unknown; request a bounded relevant prototype fact before assuming a ratio\"}"
const AJ_STEP_ID = 'goal_19qf4j1_1_p5_v1_s5_1dplaiu'
const AJ_STEP_TEXT = 'Establish a shoreline pump, connected boiler and steam engine using validated live fluid geometry.'

// Labelled copies only: the legacy [RUNTIME_COMPAT_STATE] projection dumps the goal's whole review_notes map (every step's) as JSON
// state, which is neither the advisory-labelled record nor step-scoped; Run AJ's request carried the notes only there.
const COMPAT = '[RUNTIME_COMPAT_STATE]'
const occurrences = (messages, needle) => messages.filter(row => !String(row.content ?? '').startsWith(COMPAT))
  .reduce((count, row) => count + (String(row.content ?? '').split(needle).length - 1), 0)
const notesLine = messages => messages.flatMap(row => String(row.content ?? '').split('\n')).find(line => line.startsWith('planner_review_notes')) ?? ''

// --- A: review notes ------------------------------------------------------------------------------------------------

const PUMP_STEP = 'Establish a shoreline pump, connected boiler and steam engine'
const pumpDraft = (overrides = {}) => ({ chatMessage: '', plan: [PUMP_STEP], currentStep: 0, operations: [],
  stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('copper-ore', 10) }],
  executionGuidance: [{ approach: 'Place the pump at a returned candidate, then connect the boiler and engine to its live ports.',
    rationale: 'Direct fluid connections minimize pipe use.', constraints: ['Validate fluid connections using freshly observed entity identities.'], skillIds: [] }],
  goal: { scope: 'finite', summary: 'Establish steam power.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] },
  ...overrides })
const stepIdOf = memory => { const held = getActivePlan(memory.planningState(KEY)); return held.steps[held.active_step_index].step_id }
const askReview = ({ memory }) => ({ stepId: stepIdOf(memory), operations: [],
  plannerReview: { reason: 'local_recovery_exhausted', rationale: 'No placement candidate was returned for the offshore pump at the observed shoreline.' } })
// Run AJ batch 32: one placement of the offshore pump at (7.5,50.5), direction 4.
const placePump = ({ memory }) => ({ stepId: stepIdOf(memory),
  operations: [{ name: 'place_entity', args: { entity_name: 'offshore-pump', x: 7.5, y: 50.5, direction: 4 } }] })

function notesWorld(script) {
  const game = new FakeFactorio({ inventory: { 'offshore-pump': 1, boiler: 1, 'steam-engine': 1 } })
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  const events = []
  const agent = new NpcAgentLoop({ rcon: game, memory, completionProtocolVersion: 3, replacementWake: true,
    provider: answersStepContract(async (messages, context) => {
      calls.push({ messages, context })
      const next = script[calls.length - 1]
      assert.ok(next, `Unexpected provider call ${calls.length}`)
      const reply = typeof next === 'function' ? await next({ agent, game, memory, messages, context }) : next
      return reply.tool_calls ? reply : planReply(reply)
    }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'Scripted Run AJ review-notes fixture.', npcId: 'sgluna',
    stateFile: null, traceFile: null, decisionTraceFile: null,
    onActivity: (event, data) => events.push({ event, data }),
  })
  return { agent, game, memory, calls, events, say: () => agent.request('Establish steam power.', { sender: 'Louis' }) }
}

test('Run AJ: the planner\'s whole review notes reach the executor once at the C3 handback and again after the placement batch continuation', async () => {
  assert.equal(RUN_AJ_NOTES.length, 1122, 'the Run AJ reply')
  assert.ok(RUN_AJ_NOTES.length <= MAX_REVIEW_NOTES_CHARS)
  const seen = []
  const w = notesWorld([pumpDraft(), askReview, pumpDraft({ chatMessage: RUN_AJ_NOTES, plan: [PUMP_STEP] }), ctx => {
    assert.equal(ctx.context.role, 'executor')
    seen.push({ round: 'C3 handback', whole: occurrences(ctx.messages, RUN_AJ_NOTES), line: notesLine(ctx.messages) })
    return placePump(ctx)
  }, ctx => {
    assert.equal(ctx.context.role, 'executor')
    seen.push({ round: 'batch continuation', whole: occurrences(ctx.messages, RUN_AJ_NOTES), line: notesLine(ctx.messages),
      receipt: ctx.messages.some(row => String(row.content).startsWith('[MOD] Autorio operation batch completed')) })
    return placePump(ctx)
  }])
  await w.say()
  w.game.lastBasicResult = { operation_id: 32, type: 'placing', accepted: true, completed: true, code: 'completed', tick: 104221, actor_id: w.game.status.actor_id,
    entity_name: 'offshore-pump', placed_unit_number: 37, placed_position: { x: 7.5, y: 50.5 }, placed_entity_type: 'offshore-pump', placed_direction: 4 }
  await w.agent.completed()
  assert.equal(seen.length, 2, 'the C3 handback round and the continuation round reached the model')
  assert.equal(seen[1].receipt, true, 'the second round is the continuation after the batch receipt')
  for (const round of seen) {
    assert.equal(round.whole, 1, `${round.round}: the whole notes, exactly once`)
    assert.ok(round.line.includes(NOTES_TAIL), `${round.round}: the step block record holds the notes past the old 500-char cut`)
  }
  const delivered = w.events.filter(row => row.event === 'context.review_notes_delivered').map(row => row.data)
  assert.equal(delivered.length, 1)
  assert.ok(delivered[0].request_id)
  assert.deepEqual([delivered[0].reason, delivered[0].carried_by, delivered[0].notes_chars, delivered[0].step_id],
    ['notes_whole_in_step_block_record', 'step_block_record', RUN_AJ_NOTES.length, stepIdOf(w.memory)])
})

test('Run AJ: a C7 recovery restage of the reviewed step carries the whole notes once', async () => {
  const w = notesWorld([pumpDraft(), askReview, pumpDraft({ chatMessage: RUN_AJ_NOTES, plan: [PUMP_STEP] }), placePump])
  await w.say()
  const restaged = await w.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:run_aj_c7', actor: w.agent.epoch, requestId: 'run-aj-c7' })
  assert.equal(restaged.restaged, true)
  assert.match(String(w.agent.baseMessages.find(row => String(row.content).startsWith('--- step block ---'))?.content), /restage: role=executor checkpoint=C7/)
  assert.equal(occurrences(w.agent.baseMessages, RUN_AJ_NOTES), 1, 'the packet rebuilt from durable state holds the whole notes')
  assert.equal(occurrences(w.agent.messages, RUN_AJ_NOTES), 1)
  assert.ok(notesLine(w.agent.baseMessages).includes(NOTES_TAIL))
})

test('Run AJ: notes the packet record cannot carry verbatim follow as one message that survives the batch continuation', async () => {
  // The packet sanitizes exact entity ids out of model prose, so this record is not the planner's text; the whole text follows once.
  const NOTES = `Use unit 37 as the water source. ${RUN_AJ_NOTES}`.slice(0, MAX_REVIEW_NOTES_CHARS)
  const seen = []
  const w = notesWorld([pumpDraft(), askReview, pumpDraft({ chatMessage: NOTES, plan: [PUMP_STEP] }), ctx => {
    seen.push(occurrences(ctx.messages, NOTES))
    return placePump(ctx)
  }, ctx => {
    seen.push(occurrences(ctx.messages, NOTES))
    return placePump(ctx)
  }])
  await w.say()
  await w.agent.completed()
  assert.deepEqual(seen, [1, 1], 'once at the handback, once after the continuation rebuilt the conversation')
  const [delivered] = w.events.filter(row => row.event === 'context.review_notes_delivered').map(row => row.data)
  assert.deepEqual([delivered?.reason, delivered?.carried_by], ['packet_record_shortened_or_dropped', 'conversation_message'])
})

test('Run AJ: under packet pressure the review notes outlast every historical fluid-source hint', () => {
  let state = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 10, goal_id: 'goal_aj', owner: 'louis', objective: 'automate red science' })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.DRAFT_CREATED, now: 20, steps: [{ description: AJ_STEP_TEXT }, { description: 'Connect electrical distribution' }] })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 30, plan_id: getActivePlan(state).plan_id, runtime_validation: { passed: true } })
  const stepId = getActivePlan(state).steps[0].step_id
  state = { ...state, goal: { ...state.goal, review_notes: { [stepId]: RUN_AJ_NOTES } } }
  const hints = Array.from({ length: 11 }, (_, index) => ({ name: 'water', fluid_name: 'water', surface_index: 1, position: { x: 9, y: 40 + index },
    approach: { x: 8.5, y: 39.5 + index }, as_of: { tick: 98887, epoch: 1 } }))
  const packet = maxChars => buildHandoffPacket({ planningState: state, role: 'executor', checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', now: 1,
    executorFacts: { fluid_source_hints: hints, build_fluids: ['water'] }, limits: { maxChars } })
  const roomy = packet(6000 - 679)
  assert.ok(notesLine([{ content: roomy.text }]).includes(RUN_AJ_NOTES), 'the whole notes in the record')
  assert.ok(roomy.text.includes('fluid_source_hints (HISTORICAL'))
  const tight = packet(roomy.chars - 200)
  assert.ok(tight.dropped.includes('fluid_source_hints'), 'the hints drop first')
  assert.ok(notesLine([{ content: tight.text }]).includes(RUN_AJ_NOTES), 'the notes stay whole')
})

// --- B and C: the batch that placed offshore-pump unit 37 ------------------------------------------------------------

function deployment() {
  return { revision: 'sgluna-deploy-v8-npc-staging', session: 'a1c841f8b08d226acfac1cbf01f32725', mode: 'npc', actor_id: 18, actor_kind: 'standalone_character',
    connected_players: 0, allowed: true, idle: true, epoch: 1, actor_interface: true, operations: true, tools: true }
}

// The batch 32 receipt, as the 14:21:30Z request carried it.
const AJ_RECEIPT = {
  observation_mode: 'full', task_state: 'idle', queue_empty: true, queue_length: 0,
  last_completed_batch: { batch_id: 32, task_count: 1, task_types: ['placing'], tick: 104221 },
  basic_operation: { last_result: { operation_id: 28, type: 'placing', accepted: true, completed: true, code: 'completed', tick: 104221, actor_id: 18,
    actor_kind: 'standalone_character', force_index: 1, entity_name: 'offshore-pump', requested_position: { x: 7.5, y: 50.5 }, direction: 4,
    placed_unit_number: 37, placed_position: { x: 7.5, y: 50.5 }, placed_entity_type: 'offshore-pump', placed_surface_index: 1, placed_direction: 4 } },
}
// getEntityStatus(37): the live identity and the output port, which opens on (6.5,50.5).
const PUMP_STATUS = { found: true, entity: { name: 'offshore-pump', type: 'offshore-pump', unit_number: 37, position: { x: 7.5, y: 50.5 }, direction: 4,
  status: 'working', fluidboxes: [{ index: 1, filter: 'water', connections: [{ connection_index: 1, flow_direction: 'output', position: { x: 7.5, y: 50.5 },
    target_position: { x: 6.5, y: 50.5 }, connected: false }] }] } }
// The bounded native read after batch 32, with unit 37 in it.
const PUMP_NEARBY = { actor_id: 18, observed_tick: 104273, surface_index: 1, force_index: 1, truncated: false, entities: [{ name: 'offshore-pump', type: 'offshore-pump',
  unit_number: 37, position: { x: 7.5, y: 50.5 }, direction: 4, status_name: 'working',
  spatial: { fluid: { storages: [{ index: 1, filter: 'water', capacity: 100, contents: { name: 'water', amount: 100, temperature: 15 }, connections: [
    { connection_index: 1, direction: 12, flow_direction: 'output', connected: false, position: { x: 7.5, y: 50.5 }, target_position: { x: 6.5, y: 50.5 } },
  ] }] } } }] }
const ajTopology = (nearby = PUMP_NEARBY) => {
  const sent = JSON.parse(AJ_SENT_TOPOLOGY.slice(TOPOLOGY_PREFIX.length))
  return { ...sent, ...topologyEntities(nearby), state: 'fresh', reason: 'bounded_safe_boundary_native_facts', held: sent.held, held_scope: sent.held_scope, held_omitted: sent.held_omitted,
    capacity: [], expansion: sent.expansion }
}

class RunAjRcon {
  constructor() { this.commands = [] }
  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_operations","status")')) return JSON.stringify(AJ_RECEIPT)
    if (text.includes('"get_inventory_items"')) return JSON.stringify({ items: [{ name: 'boiler', count: 1 }, { name: 'steam-engine', count: 1 }, { name: 'pipe', count: 8 }, { name: 'coal', count: 12 }] })
    if (text.includes('"get_entity_status"')) return JSON.stringify(PUMP_STATUS)
    return '{}'
  }
}

function ajPlanningState() {
  let state = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 10, goal_id: 'goal_19qf4j1_1', owner: '<server>',
    objective: 'Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.' })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.DRAFT_CREATED, now: 20, steps: [{ description: AJ_STEP_TEXT }, { description: 'Connect electrical distribution and chest-to-boiler coal delivery.' }] })
  return applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 30, plan_id: getActivePlan(state).plan_id, runtime_validation: { passed: true } })
}

function legacyPlan() {
  return { goal_id: 'goal_19qf4j1_1', owner: '<server>', objective: 'automate red science', status: 'active', blocker: '', pause_reason: '',
    plan: [AJ_STEP_TEXT, 'Connect electrical distribution'], current_step: 0, revision: 1, last_chat_message: 'Placing the pump.', last_operations: [], updated_at: Date.now(), history: [],
    task_board: { kind: 'task_board_lite', goal_id: 'goal_19qf4j1_1', status: 'active', blocker: '', pause_reason: '', completed_count: 0, total_steps: 2, active_index: 0,
      active_step_id: 'step_5', steps: [{ id: 'step_5', description: AJ_STEP_TEXT, status: 'active' }, { id: 'step_6', description: 'Connect electrical distribution', status: 'pending' }], evidence: [] } }
}

function runAjAgent({ families = ['nearby_world'], route = 'targeted_observation', topology = ajTopology() } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(KEY, legacyPlan())
  const planning = ajPlanningState()
  memory.planningByNpc.set(KEY, planning)
  const stepId = getActivePlan(planning).steps[0].step_id
  const calls = []
  const events = []
  const rcon = new RunAjRcon()
  const agent = new NpcAgentLoop({ rcon, memory, systemPrompt: 'executor', npcId: 'sgluna',
    provider: async (messages, context) => {
      calls.push({ allowTools: context.allowTools, roundPhase: context.roundPhase, messages })
      throw new Error('scripted stop after the first round')
    },
    traceFile: null, decisionTraceFile: null, stateFile: null })
  const traceEvent = agent.traceEvent.bind(agent)
  agent.traceEvent = async (event, data) => {
    events.push({ event, data })
    return traceEvent(event, data)
  }
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = KEY
  // The C3 packet rows of Run AJ, re-pointed at this fixture's step id so the step block stays current.
  agent.baseMessages = [
    { role: 'system', content: agent.systemPrompt },
    { role: 'user', content: AJ_STABLE },
    { role: 'user', content: AJ_STEP.replaceAll(AJ_STEP_ID, stepId) },
  ]
  agent.messages = agent.baseMessages.map(message => ({ ...message }))
  agent.requestInfo = { memoryKey: KEY, turnId: 1, sender: '<server>', text: 'automate red science' }
  agent.agentContext.role = EXECUTOR_ROLE
  agent.postBatchStepKey = () => postBatchStepKey('npc:standalone_character:18:1', 'plan-aj', stepId)
  agent.gatherTopologyContext = async () => topology
  agent.routePostStepDecision = async () => ({ route, decision_called: true,
    steering: { reasoning_budget: 'normal', planning_horizon: 'checkpoint', observation_budget: 1,
      observation_relevance: { source: 'typed_relevance', threshold: 0.5, selected_families: families, budget: families.length } } })
  return { agent, rcon, calls, events }
}

async function firstRound(options) {
  const world = runAjAgent(options)
  await world.agent.completed().catch(() => undefined)
  assert.ok(world.calls.length >= 1, 'the decision after batch 32 reached the model')
  const first = world.calls[0]
  const text = row => String(row.content ?? '')
  return { ...world, first,
    facts: first.messages.find(row => text(row).startsWith(POST_BATCH_FACTS_PREFIX))?.content ?? '',
    topologyRows: first.messages.filter(row => text(row).startsWith(TOPOLOGY_PREFIX)).map(text),
    packetChars: first.messages.filter(row => text(row).startsWith('[HANDOFF]') || text(row).startsWith('--- step block ---')).reduce((sum, row) => sum + text(row).length + 1, 0),
    stepBlock: text(first.messages.find(row => text(row).startsWith('--- step block ---')) ?? {}),
    named: name => world.events.filter(row => row.event === name).map(row => row.data) }
}

test('Run AJ: the post-batch facts after a single placement carry the placed entity\'s live identity and port when Jev selected only nearby_world', async () => {
  const { facts, rcon, named, first } = await firstRound()
  assert.match(facts, /getEntityStatus \{"unit_number":37\} => /, 'the harness read the entity the receipt names')
  assert.match(facts, /"target_position":\{"x":6\.5,"y":50\.5\}/, 'its output port geometry')
  assert.equal(rcon.commands.filter(command => command.includes('"get_entity_status"')).length, 1)
  const [bundle] = named('observation.post_batch_facts')
  assert.ok(bundle.request_id !== undefined)
  assert.deepEqual(bundle.tools, ['getInventoryItems', 'getEntityStatus'])
  assert.deepEqual(bundle.placed_entity, { unit_number: 37, reason: 'single_placement_receipt', family_selected: false, answered: true })
  // A harness read answers no family Jev did not select, so it opens nothing and closes nothing.
  assert.deepEqual([bundle.selected_families, bundle.covered_families, bundle.uncovered_families], [['nearby_world'], [], ['nearby_world']])
  assert.equal(named('observation.phase_closed').length, 0)
  assert.equal(first.allowTools, true, 'the nearby_world read the model chooses is still available')
  assert.doesNotMatch(facts, /Selected observation families these reads answer/)
})

test('Run AJ: the placed-entity read never changes which selected families the bundle covers', async () => {
  // Inventory alone covered and closed the phase before; it still does, and the entity read is not credited to any family.
  const inventory = await firstRound({ families: ['inventory_equipment'] })
  const [bundle] = inventory.named('observation.post_batch_facts')
  assert.deepEqual(bundle.covered_families, ['inventory_equipment'])
  assert.match(inventory.facts, /getEntityStatus \{"unit_number":37\} => /)
  const [closed] = inventory.named('observation.phase_closed')
  assert.equal(closed?.reason_code, POST_BATCH_COVERAGE_REASON)
  assert.deepEqual(closed.covered_by, { inventory_equipment: 'getInventoryItems' })
  // Jev's own entity_status selection is answered by the same single read.
  const entity = await firstRound({ families: ['entity_status'] })
  assert.equal(entity.rcon.commands.filter(command => command.includes('"get_entity_status"')).length, 1)
  const [selected] = entity.named('observation.post_batch_facts')
  assert.deepEqual(selected.covered_families, ['entity_status'])
  assert.equal(selected.placed_entity.family_selected, true)
})

test('Run AJ: fresh_topology keeps the placed offshore pump by shedding historical fluid hints, within the 6000-character total', async () => {
  const topology = ajTopology()
  const full = topologyText(topology)
  assert.ok(full.length > 734 && full.length <= TOPOLOGY_LIMITS.chars, `the post-placement block (${full.length}) exceeds the 734-char room Run AJ left`)
  const { topologyRows, packetChars, stepBlock, named } = await firstRound({ topology })
  assert.equal(topologyRows.length, 1)
  const sent = JSON.parse(topologyRows[0].slice(TOPOLOGY_PREFIX.length))
  assert.deepEqual(sent.entities.map(entity => [entity.name, entity.unit_number, entity.position, entity.direction]), [['offshore-pump', 37, { x: 7.5, y: 50.5 }, 4]])
  assert.deepEqual(sent.entities[0].fluid[0].ports[0].opens, { x: 6.5, y: 50.5 })
  assert.equal(topologyRows[0], full, 'the whole block')
  assert.ok(packetChars + topologyRows[0].length + 1 <= 6000, `packet ${packetChars} + topology ${topologyRows[0].length}`)
  assert.equal(named('context.topology_trimmed').length, 0)
  const [reclaimed] = named('context.topology_room_reclaimed')
  assert.ok(reclaimed?.request_id !== undefined)
  assert.equal(reclaimed.reason, 'live_topology_entities_outrank_historical_packet_records')
  assert.deepEqual([reclaimed.room_before, reclaimed.full_chars], [734, full.length])
  assert.ok(reclaimed.room_after >= full.length)
  assert.equal(reclaimed.shed.at(-1).record, 'fluid_source_hints')
  assert.ok(reclaimed.shed.at(-1).hints_removed > 0)
  // Only the oldest hints were shed; the newest, the notes, the residual and the authority record stay.
  assert.match(stepBlock, /fluid_source_hints \(HISTORICAL[^\n]*water:water@\(9,51\)/)
  assert.doesNotMatch(stepBlock, /water:water@\(12,46\)/)
  for (const record of ['planner_review_notes', 'residual_needs', 'authority: ', 'execution_guidance']) assert.match(stepBlock, new RegExp(`^${record.replace(/[()]/g, '\\$&')}`, 'm'))
})

test('Run AJ: with no live entity in the block, the historical hints are not shed', async () => {
  const empty = ajTopology({ ...PUMP_NEARBY, entities: [] })
  const { stepBlock, named, topologyRows } = await firstRound({ topology: empty })
  assert.equal(named('context.topology_room_reclaimed').length, 0)
  assert.match(stepBlock, /water:water@\(12,46\)/)
  assert.equal(topologyRows.length, 1)
})

test('the provider-time shed only removes the lines it names from packet rows, never the canonical conversation', () => {
  assert.equal(typeof topologyContext.reclaimTopologyRoom, 'function')
  const step = { role: 'user', content: AJ_STEP }
  const other = { role: 'user', content: 'fluid_source_hints (HISTORICAL: not a packet row)' }
  const result = topologyContext.reclaimTopologyRoom([{ role: 'user', content: AJ_STABLE }, step, other], 300, { liveEntities: true })
  assert.ok(result.reclaimed >= 300)
  assert.equal(result.messages[2], other)
  assert.equal(step.content, AJ_STEP, 'the input row is not mutated')
  assert.match(result.messages[1].content, /\(\+\d+ more\)$/m, 'the cut is reported in the record')
  const none = topologyContext.reclaimTopologyRoom([{ role: 'user', content: AJ_STABLE }, step], 300, { liveEntities: false })
  assert.equal(none.reclaimed, 0, 'historical hints shed only for live entities')
})