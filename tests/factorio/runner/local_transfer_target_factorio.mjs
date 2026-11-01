#!/usr/bin/env node
// Run S: a legacy transfer searches within reach; a local miss is not destruction.
// Native first-slot proof, partial-prefix replay guard and real exact-target
// destruction controls. All model calls use injected scripted transport.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { PLANNER_MODEL, EXECUTOR_MODEL } from '../pterodactyl/runtime-v8/invalid-reference-fixtures.mjs'
import { configuration, Session } from '../pterodactyl/runtime-v8/supervisor.mjs'
import { providerRequest } from '../pterodactyl/runtime-v8/provider.mjs'
import { planReply, jevContractLog } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'
import { transferSupplyRecoveryCount } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'

globalThis.fetch = async () => { throw new Error('uninjected inference forbidden in local-transfer fixture') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const mode = arg('mode')
assert.ok(['recovery', 'prefix', 'destroyed'].includes(mode))
const results = path.resolve(arg('results'))
const transcript = []; const sent = []; const wire = []; const wireFaults = []; const seen = {}
let connection, ctx, intended, decoy, freshUnit
const historical = { x: 11, y: -62 }
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a=game.surfaces["local-transfer"].find_entities_filtered{name="character"}[1]; assert(a); ${  body}`))
const snapshot = () => lua(`local o=remote.call("autorio_operations","status"); local s=a.surface;
  local function counts(i) local t={} for _,v in pairs(i.get_contents()) do t[v.name]=v.count end return t end;
  local machines={}; for _,e in pairs(s.find_entities_filtered{force=a.force,name="stone-furnace"}) do machines[#machines+1]={unit_number=e.unit_number,position=e.position,
    output=counts(e.get_output_inventory()),source=counts(e.get_inventory(defines.inventory.crafter_input)),fuel=counts(e.get_fuel_inventory())} end;
  rcon.print(helpers.table_to_json({actor_id=a.unit_number,position=a.position,humans=#game.connected_players,speed=game.speed,tick=game.tick,
    held=counts(a.get_main_inventory()),machines=machines,electronics=a.force.technologies.electronics.researched,
    copper_produced=a.force.get_item_production_statistics(s).get_input_count("copper-plate"),
    queue_length=o.queue_length,task_state=o.task_state,last_completed=o.last_completed_batch,last_cancelled=o.last_cancelled_batch,
    basic=o.basic_operation and o.basic_operation.last_result,receipts=o.receipt_journal,
    journal=remote.call("autorio_operation_admission","status")}))`)
function healthy() {
  if (!ctx) return
  assert.deepEqual(wireFaults, [], 'local miss recovery must describe bounded target reacquisition, not destruction')
  assert.deepEqual(ctx.model.violations, [])
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual([...ctx.logs, ...ctx.world.agentLogs].filter(line => /listener failed|Unable to|follow-up failed|Behavior trace write failed/.test(line)), [])
}
async function until(label, predicate, timeout = 90000) {
  const end = Date.now() + timeout
  for (;;) {
    healthy()
    const result = await predicate()
    if (result) return result
    assert.ok(Date.now() < end, `timeout ${label}; labels=${JSON.stringify(ctx?.model.labels)} logs=${JSON.stringify(ctx?.logs)}`)
    await delay(100)
  }
}
async function idle() {
  await delay(250)
  return until('native queue idle', async () => {
    const s = await snapshot()
    assert.equal(s.humans, 0); assert.equal(s.speed, 1)
    return s.queue_length === 0 && s.task_state === 'idle' ? s : false
  })
}
async function completion() {
  const s = await idle()
  ctx.session.lastCompletionAt = 0
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session); healthy()
  return s
}
async function failure(code) {
  ctx.session.lastErrorAt = 0
  ctx.session.onGameLine(`[AUTORIO] [ERROR] moving_items failed: ${code}; dependent operations cancelled`)
  await settle(ctx.session); healthy()
}
const checkpoint = { mode: 'all', requirements: [{ id: 'electronics', kind: 'research_completed', technology: 'electronics' }] }
const STEP = 'Deliver copper ore and fuel to the remembered furnace and smelt ten copper plates'
const goal = { scope: 'finite', summary: 'Smelt ten copper plates in the intended furnace and unlock electronics', doneWhen: [
  { kind: 'research_completed', technology: 'electronics' }, { kind: 'items_produced', item_name: 'copper-plate', minimum: 10 },
] }
const reply = (operations = [], extra = {}) => planReply({ plan: [STEP], currentStep: 0, operations, checkpoint,
  ...(ctx?.world.memory.currentPlan(KEY)?.task_board.active_step_id ? { stepId: ctx.world.memory.currentPlan(KEY).task_board.active_step_id } : {}),
  stepCompletions: [{ kind: 'deterministic', checkpoint }], ...extra })
const legacy = [
  { name: 'move_items', args: { item_name: 'copper-ore', entity_name: 'stone-furnace', max_count: 10, to_entity: true } },
  { name: 'move_items', args: { item_name: 'coal', entity_name: 'stone-furnace', max_count: 10, to_entity: true } },
]
const initial = mode === 'prefix' ? [{ name: 'walk_to_position', args: { x: 8.539, y: -101.414, reach_distance: 0.5 } }, ...legacy] : legacy
let readCall = 0
const reads = tools => ({ content: null, tool_calls: tools.map(([name, args]) => ({ id: `local-transfer-${++readCall}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) })
const model = new ScriptedModel().push('planner', 'sol:immutable-electronics-goal', reply([], { goal }))
  .push('planner', 'sol:confirm-native-trigger-requirements', messages => {
    assert.match(messages.findLast(row => String(row.content).startsWith('[HARNESS]')).content, /requirements_grounding/)
    return reply([], { goal })
  })
if (mode === 'destroyed') {
  model.push('executor', 'luna:observe-before-native-removal', reads([['getEntityStatus', { name: 'stone-furnace', radius: 32 }]]))
    .push('executor', 'luna:native-removal-before-exact-transfer', messages => {
      const status = JSON.parse([...messages].reverse().find(row => row.role === 'tool').content)
      assert.equal(status.entity.unit_number, intended)
      freshUnit = status.entity.unit_number
      return reply([{ name: 'mine_entity_exact', args: { unit_number: freshUnit } },
        { name: 'move_items_exact', args: { item_name: 'copper-ore', unit_number: freshUnit, max_count: 10, to_entity: true } }])
    })
    .push('executor', 'luna:report-real-exact-target-destruction', () => {
      assert.equal(ctx.world.memory.currentPlan(KEY).status, 'blocked')
      assert.equal(transferSupplyRecoveryCount(ctx.world.memory.currentPlan(KEY).task_board), 0)
      assert.equal(sent.length, 1)
      return reply([], { chatMessage: 'BLOCKED: The native exact transfer receipt reports target_gone after actual removal of the observed intended furnace; no transfer recovery or replay is authorized.' })
    })
} else {
  model.push('executor', 'luna:legacy-local-transfer-batch', reply(initial))
  if (mode === 'recovery') model
    .push('executor', 'luna:choose-historical-approach-after-local-miss', async messages => {
      const all = messages.map(row => String(row.content)).join('\n')
      if (!/within.{0,20}reach|local.{0,30}(?:search|miss|absence)/i.test(all)
        || !/fresh|re-observe|observe/i.test(all)) {
        wireFaults.push({ reason: 'local_no_target_not_routed_to_fresh_target_reacquisition' })
        throw new Error('serialized execution recovery lacks local-target reacquisition guidance')
      }
      assert.equal(sent.length, 1, 'failure classification never chooses or dispatches a walk')
      const s = await snapshot()
      assert.deepEqual(s.position, seen.failed.position)
      assert.equal(s.held['copper-ore'], 10); assert.equal(s.held.coal, 10)
      assert.equal(s.machines.length, 2)
      seen.recoveryPrompt = all
      // A remembered position is a model-selected travel hint, not current identity.
      return reply([{ name: 'walk_to_position', args: { x: historical.x, y: historical.y - 4, reach_distance: 1 } }])
    })
    .push('executor', 'luna:fresh-target-and-spend-normal-budget-after-walk', reads([
      ['getEntityStatus', { name: 'stone-furnace', radius: 32 }], ['getActorStatus', {}], ['getTaskStatus', {}], ['getNavigationStatus', {}],
    ]))
    .push('executor', 'luna:one-targeted-held-count-read', (messages, context) => {
      // The unchanged normal cap admits its useful subset. Entity status is
      // first; any remaining normal slots are consumed by native runtime facts.
      const ids = new Set(messages.flatMap(row => row.tool_calls ?? []).filter(call => call.function?.name === 'getEntityStatus').map(call => call.id))
      const entityMessage = [...messages].reverse().find(row => row.role === 'tool' && ids.has(row.tool_call_id))
      assert.ok(entityMessage)
      const status = JSON.parse(entityMessage.content)
      assert.equal(status.observation_mode, 'full')
      assert.equal(status.entity.unit_number, intended)
      assert.deepEqual(status.entity.position, historical)
      assert.notEqual(status.entity.unit_number, decoy)
      freshUnit = status.entity.unit_number
      const row = [...messages].reverse().find(message => String(message.content).startsWith('[CONTROL_DECISION_STATE]'))
      assert.ok(row)
      const control = JSON.parse(row.content.split('\n')[0].slice('[CONTROL_DECISION_STATE] '.length))
      assert.equal(context.allowTools, false, 'targeted inventory proof begins only after normal tools actually close')
      assert.equal(control.toolsEnabled, false)
      assert.equal(control.targetedReadEligible, true)
      return { content: JSON.stringify({ plan: [STEP], currentStep: 0, stepId: control.stepId, operations: [],
        observationRequest: { stepId: control.stepId, tool: 'getInventoryItems', args: {},
          rationale: 'The freshly observed intended furnace is current; confirm held ore and fuel before exact delivery.' } }) }
    })
    .push('executor', 'luna:exact-delivery-to-fresh-intended-target', (messages, context) => {
      assert.equal(context.allowTools, false, 'one targeted count read leaves normal observations closed')
      const result = ctx.world.named('tool.result').findLast(row => row.name === 'getInventoryItems')
      assert.ok(result?.tool_call_id?.startsWith('targeted_'))
      assert.match(result.output, /copper-ore/); assert.match(result.output, /coal/)
      const normalized = value => String(value).replace(/\s+/g, ' ').trim()
      assert.ok(messages.some(row => normalized(row.content).includes(normalized(result.output))
        && (row.tool_call_id === result.tool_call_id || (row.role === 'user' && /getInventoryItems/.test(row.content)))),
      'the serialized request contains the specific current targeted inventory fact')
      const stateRow = [...messages].reverse().find(row => String(row.content).startsWith('[CONTROL_DECISION_STATE]'))
      const control = JSON.parse(stateRow.content.split('\n')[0].slice('[CONTROL_DECISION_STATE] '.length))
      assert.equal(control.targetedAllowanceUsed, true); assert.equal(control.targetedReadEligible, false)
      assert.ok(ctx.world.memory.targetedObservationLedger.has(KEY))
      return reply([{ name: 'move_items_exact', args: { item_name: 'copper-ore', unit_number: freshUnit, max_count: 10, to_entity: true } },
        { name: 'move_items_exact', args: { item_name: 'coal', unit_number: freshUnit, max_count: 10, to_entity: true } }])
    })
  if (mode === 'prefix') model.push('executor', 'luna:nonconflicting-travel-keeps-prefix-uncertainty', messages => {
    assert.match(messages.map(row => String(row.content)).join('\n'), /within interaction reach/)
    assert.equal(sent.length, 1)
    return reply([{ name: 'walk_to_position', args: { x: historical.x, y: historical.y - 4, reach_distance: 1 } }])
  })
}

try {
  await fsp.mkdir(results, { recursive: true })
  await until('RCON ready', async () => {
    connection?.close(); connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    try { await connection.connect(); return true } catch { return false }
  }, 20000)
  await configureNpcSession(rcon, `local-transfer-${mode}-session`)
  const setup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); '
    + 'game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); local s=game.create_surface("local-transfer",{seed=424242,width=0,height=0,water=0,cliff_settings={cliff_elevation_interval=0},autoplace_settings={entity={treat_missing_as_default=false,settings={}}}}); '
    + 's.request_to_generate_chunks({11,-80},3); s.force_generate_chunk_requests(); for _,e in pairs(s.find_entities()) do e.destroy() end; local tiles={}; '
    + 'for x=-64,95 do for y=-144,-17 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true); '
    + `assert(a.teleport(${mode === 'destroyed' ? '{11,-66}' : '{6.539,-101.414}'},s)); local inv=a.get_main_inventory(); inv.clear(); `
    + 'assert(inv.insert{name="copper-ore",count=10}==10); assert(inv.insert{name="coal",count=10}==10); '
    + 'local f=s.create_entity{name="stone-furnace",position={11,-62},force=a.force}; assert(f); local d=s.create_entity{name="stone-furnace",position={25,-62},force=a.force}; assert(d); '
    + 'assert(not a.force.technologies.electronics.researched); rcon.print(helpers.table_to_json({actor_id=a.unit_number,intended=f.unit_number,decoy=d.unit_number}))'))
  intended = setup.intended; decoy = setup.decoy
  // SETUP ENDS HERE. No further teleport, stock/terrain/technology edit,
  // direct destruction, insertion, or corrective gameplay command is issued.
  const before = await idle()
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only-not-a-real-key', OPENAI_API_BASEURL: 'https://provider.example.test/v1', AI_API_METHOD: 'local', OPENAI_MODEL: `${PLANNER_MODEL},${EXECUTOR_MODEL}` })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context,
    promptTraceFile: path.join(results, `local-transfer-${mode}-provider.jsonl`), fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      wire.push({ body, role: context.role, actor_id: context.actorId, epoch: context.epoch })
      const message = await model.provide(body.messages, context)
      return new Response(JSON.stringify({ id: `transfer-${wire.length}`, model: body.model,
        choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const decisionScript = (_state, questions) => {
    const overrides = {}
    for (const family of ['runtime_status', 'inventory_equipment', 'nearby_world', 'entity_status']) if (questions[`need_${family}`]) overrides[`need_${family}`] = { noul: 0.9 }
    if (questions.intent) overrides.intent = { choice: 'new_goal', confidence: 0.9 }
    return { overrides }
  }
  const world = recoveryWorld({ game: rcon, model, decisionScript, agentRoleConfig: bridge.config,
    stateFile: path.join(results, `local-transfer-${mode}-state.json`) })
  world.agent.provider = (messages, context) => bridge.roleProvider(messages, context)
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch, sessionId: status.session }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  ctx.session.queuePlayerRequest('TTLouis', 'Deliver copper and coal to the furnace remembered at (11,-62), then smelt ten copper plates to unlock electronics')
  await settle(ctx.session); healthy()
  const canonical = structuredClone(world.memory.planningState(KEY))
  seen.failed = await until('native cancelled moving-items receipt', async () => {
    const s = await snapshot()
    return s.last_cancelled?.reason === `moving_items:${mode === 'destroyed' ? 'target_gone' : 'no_target'}` ? s : false
  })
  assert.equal(sent.length, 1)
  assert.equal(seen.failed.basic.accepted, false); assert.equal(seen.failed.basic.completed, false)
  assert.equal(seen.failed.basic.actor_id, status.actor_id)
  assert.equal(seen.failed.basic.tick, seen.failed.last_cancelled.tick)
  const record = seen.failed.journal.records.at(-1)
  assert.ok(record && record.slots.length === initial.length)
  if (mode === 'recovery') {
    assert.equal(seen.failed.last_cancelled.started_count, 1)
    assert.equal(seen.failed.last_cancelled.failed_before_mutation, true)
    assert.equal(record.state, 'failed'); assert.equal(record.proven_refusal, true)
    assert.equal(record.error, 'refused_before_mutation')
  } else {
    assert.equal(seen.failed.last_cancelled.started_count, 2)
    assert.equal(record.state, 'uncertain'); assert.notEqual(record.proven_refusal, true)
    if (mode === 'destroyed') {
      assert.notEqual(seen.failed.last_cancelled.failed_before_mutation, true)
      assert.ok(!seen.failed.machines.some(row => row.unit_number === intended))
      assert.equal(seen.failed.basic.target_unit_number, intended)
      assert.equal(seen.failed.held['stone-furnace'], 1, 'native exact mining really removed and recovered the intended furnace')
    } else {
      assert.equal(seen.failed.last_cancelled.failed_before_mutation, true, 'per-task proof does not erase a completed prefix')
      assert.ok(Math.hypot(seen.failed.position.x - before.position.x, seen.failed.position.y - before.position.y) > 1,
        'the admitted movement prefix really changed the native actor position')
    }
  }
  await failure(mode === 'destroyed' ? 'target_gone' : 'no_target')
  if (mode === 'recovery') {
    assert.equal(sent.length, 2, 'only the model-selected approach follows local refusal')
    assert.equal(world.memory.currentPlan(KEY).status, 'active')
    assert.equal(transferSupplyRecoveryCount(world.memory.currentPlan(KEY).task_board), 1)
    const walk = await completion()
    assert.equal(sent.length, 3)
    assert.equal(world.memory.planningState(KEY).goal.goal_id, canonical.goal.goal_id)
    assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps, canonical.plans.at(-1).steps)
    assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
    seen.walked = walk
    seen.smelted = await until('ten native intended-furnace copper plates', async () => {
      const s = await snapshot(); const target = s.machines.find(row => row.unit_number === intended)
      return target?.output['copper-plate'] === 10 && s.electronics ? s : false
    })
    await completion()
    assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
    assert.equal(world.memory.currentPlan(KEY), undefined)
    assert.equal(sent.length, 3)
    assert.ok(world.named('transfer.supply_recovery').some(row => row.request_id && row.code === 'no_target'
      && row.retry_budget === 2 && row.plan_changed === false))
    assert.ok(world.named('transfer.target_recovery').some(row => row.request_id && row.reason === 'correlated_legacy_transfer_local_target_absent'))
    assert.equal(world.named('observation.targeted_granted').length, 1)
    assert.equal(world.named('observation.targeted_granted')[0].tool, 'getInventoryItems')
    assert.equal(world.named('operation.reconciled').some(row => row.verdict === 'refused_before_mutation'), true)
  } else {
    assert.equal(sent.length, mode === 'prefix' ? 2 : 1, 'negative control never replays the tail or substitutes the decoy')
    if (mode === 'prefix') seen.prefixWalked = await idle()
    const pending = world.memory.pendingOperations(KEY)
    assert.ok(pending.some(row => row.verdict === 'admitted_cancelled' && row.effect === 'partial_unknown'))
    const guard = world.memory.checkDuplicateEffect(KEY, { operations: mode === 'prefix' ? initial : [
      { name: 'move_items_exact', args: { item_name: 'copper-ore', unit_number: intended, max_count: 10, to_entity: true } },
    ] }, { requestId: `native-${mode}-replay-control` })
    assert.equal(guard.refuse, true)
    assert.equal(guard.reason, 'unresolved_operation_scope_conflict')
    assert.equal(guard.effect, 'partial_unknown')
    if (mode === 'prefix') assert.equal(transferSupplyRecoveryCount(world.memory.currentPlan(KEY).task_board), 1)
    else {
      assert.equal(world.memory.currentPlan(KEY).status, 'blocked')
      assert.equal(transferSupplyRecoveryCount(world.memory.currentPlan(KEY).task_board), 0)
      assert.deepEqual(world.named('transfer.supply_recovery'), [])
    }
  }
  const after = await idle(); const untouched = after.machines.find(row => row.unit_number === decoy)
  assert.ok(untouched)
  assert.deepEqual(untouched.output, {}); assert.deepEqual(untouched.source, {}); assert.deepEqual(untouched.fuel, {})
  assert.equal(after.actor_id, before.actor_id)
  assert.equal(after.held['copper-ore'] ?? 0, mode === 'recovery' ? 0 : 10)
  assert.equal(after.copper_produced - before.copper_produced, mode === 'recovery' ? 10 : 0)
  assert.equal(wire[0].body.model, PLANNER_MODEL)
  assert.equal(wire.filter(row => row.role === 'planner').length, 2, 'initial plan and required native grounding confirmation')
  assert.ok(wire.every(row => row.body.model === (row.role === 'planner' ? PLANNER_MODEL : EXECUTOR_MODEL)))
  assert.ok(wire.every(row => row.actor_id === status.actor_id && row.epoch === status.epoch))
  assert.deepEqual(model.remaining, []); healthy()
  assert.deepEqual(jevContractLog.filter(row => !row.ok), [])
  await fsp.writeFile(path.join(results, `local-transfer-${mode}-proof.json`), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null,
    mode, setup, before, seen, after, wire, trace: world.trace }, null, 2))
  process.stdout.write(`local-transfer ${mode} native delegation PASS\n`)
} catch (error) {
  await fsp.writeFile(path.join(results, `local-transfer-${mode}-error.txt`), `${error.stack}\n${JSON.stringify({ wireFaults, wire, seen, labels: model.labels, logs: ctx?.logs, transcript }, null, 2)}`)
  throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) }
  connection?.close()
}
