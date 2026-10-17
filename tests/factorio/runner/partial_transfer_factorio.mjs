#!/usr/bin/env node
// Run X: native reserved iron craft survives clearing/refuelling, rejects
// copper after a completed prefix, then recovers through the actual Session.
// Unknown-receipt control deliberately removes evidence, never native effects.
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

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('live inference forbidden in partial-transfer fixture') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const mode = arg('mode')
assert.ok(['recovery', 'unknown'].includes(mode))
const results = path.resolve(arg('results'))
const transcript = []; const sent = []; const wire = []; const seen = {}; const corruptions = []
let connection; let ctx; let unit
const refusal = 'moving_items:nothing_moved:target_rejects_item'
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  // The diagnostic snapshot below nests operations, so it always preserves the
  // complete real receipt. Only ordinary production status reads lose a field.
  if (mode === 'unknown' && command.includes('"autorio_operations","status"')) {
    let status
    try { status = JSON.parse(answer) } catch { /* non-JSON native diagnostic */ }
    if (status?.task_state && status.last_cancelled_batch?.reason === refusal) {
      const before = structuredClone(status.last_cancelled_batch)
      delete status.last_cancelled_batch.completed_count
      for (const receipt of status.receipt_journal ?? []) if (receipt.reason === refusal) delete receipt.completed_count
      corruptions.push({ reason: 'missing_terminal_completed_count', before, after: structuredClone(status.last_cancelled_batch) })
      return JSON.stringify(status)
    }
  }
  return answer
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a=game.surfaces["partial-transfer"].find_entities_filtered{name="character"}[1]; assert(a); ${body}`))
const snapshot = () => lua(`local f=a.surface.find_entity("stone-furnace",{6,4}); assert(f and f.unit_number==${unit});
  local function counts(i) local t={} for _,v in pairs(i.get_contents()) do t[v.name]=v.count end return t end;
  local o=remote.call("autorio_operations","status");
  rcon.print(helpers.table_to_json({actor_id=a.unit_number,humans=#game.connected_players,speed=game.speed,tick=game.tick,
    held=counts(a.get_main_inventory()),source=counts(f.get_inventory(defines.inventory.furnace_source)),output=counts(f.get_output_inventory()),fuel=counts(f.get_fuel_inventory()),
    remaining_fuel=f.burner.remaining_burning_fuel,energy=f.energy,crafting_progress=f.crafting_progress,recipe=f.get_recipe() and f.get_recipe().name,
    position=a.position,target={unit_number=f.unit_number,position=f.position,surface_index=f.surface.index},
    copper_produced=a.force.get_item_production_statistics(a.surface).get_input_count("copper-plate"),
    operations=o,journal=remote.call("autorio_operation_admission","status")}))`)
function healthy() {
  if (!ctx) return
  assert.deepEqual(model.violations, [])
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual([...ctx.logs, ...ctx.world.agentLogs].filter(line => /listener failed|Unable to|follow-up failed|Behavior trace write failed/.test(line)), [])
}
async function until(label, predicate, timeout = 90000) {
  const end = Date.now() + timeout
  for (;;) { healthy(); const result = await predicate(); if (result) return result
    assert.ok(Date.now() < end, `timeout ${label}; labels=${JSON.stringify(model.labels)} logs=${JSON.stringify(ctx?.logs)}`)
    await delay(100)
  }
}
async function idle() {
  await delay(250)
  return until('native idle', async () => {
    const s = await snapshot(); assert.equal(s.humans, 0); assert.equal(s.speed, 1)
    return s.operations.queue_length === 0 && s.operations.task_state === 'idle' ? s : false
  })
}
async function completion() {
  await idle(); ctx.session.lastCompletionAt = 0
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session); healthy()
}
const STEP = 'Clear the remaining iron from the existing furnace and smelt five copper plates to hold fifteen'
const checkpoint = { mode: 'all', requirements: [{ id: 'copper15', kind: 'inventory_count', item_name: 'copper-plate', minimum: 15 }] }
const goal = { scope: 'finite', summary: 'Hold fifteen copper plates after smelting five new copper plates', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 15 }] }
const reply = (operations = [], extra = {}) => planReply({ plan: [STEP], currentStep: 0, operations, checkpoint,
  stepCompletions: [{ kind: 'deterministic', checkpoint }], ...extra })
const initial = () => [
  { name: 'move_items_exact', args: { item_name: 'iron-ore', unit_number: unit, max_count: 7, to_entity: false } },
  { name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: unit, max_count: 17, to_entity: false } },
  { name: 'supply_entity', args: { unit_number: unit, items: [{ item_name: 'copper-ore', count: 5 }, { item_name: 'coal', count: 5 }] } },
]
let readId = 0
const readStatus = () => ({ content: null, tool_calls: [{ id: `partial-status-${++readId}`, type: 'function', function: { name: 'getEntityStatus', arguments: JSON.stringify({ name: 'stone-furnace', radius: 12 }) } }] })
const lastTool = messages => JSON.parse(messages.findLast(row => row.role === 'tool').content)
function rawRepair() {
  const active = ctx.world.memory.planningState(KEY).plans.at(-1)
  return { content: JSON.stringify({ stepId: active.steps[active.active_step_index].step_id ?? ctx.world.memory.currentPlan(KEY).task_board.active_step_id,
    operations: [
      { name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: unit, max_count: 1, to_entity: false } },
      { name: 'supply_entity', args: { unit_number: unit, items: [{ item_name: 'copper-ore', count: 5 }] } },
    ], checkpoint: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 1 }] },
    chatMessage: 'The fresh furnace has one residual iron plate and fuel. Clear only that residue and load five copper ore.' }) }
}
const model = new ScriptedModel()
  .push('planner', 'sol:immutable-fifteen-copper-checkpoint', reply([], { goal }))
  .push('executor', 'luna:observe-real-reserved-iron-craft', () => readStatus())
  .push('executor', 'luna:clear-prefix-and-switch-to-copper', messages => {
    const status = lastTool(messages); assert.equal(status.entity.unit_number, unit)
    seen.initialDeliveredEntity = structuredClone(status.entity)
    const items = status.entity.inventories.flatMap(row => Array.isArray(row.items) ? row.items : [])
    assert.ok(items.some(row => row.name === 'iron-ore' && row.count === 7))
    assert.ok(items.some(row => row.name === 'iron-plate' && row.count === 17))
    return reply(initial())
  })
if (mode === 'recovery') model
  .push('executor', 'luna:fresh-observation-after-accounted-partial-effect', () => readStatus())
  .push('executor', 'luna:canonical-continuation-without-new-completion-contracts', messages => {
    const status = lastTool(messages)
    seen.freshDeliveredStatus = structuredClone(status)
    let entity = status.entity
    if (status.observation_mode === 'diff') {
      assert.equal(status.reference, `entity:${unit}`)
      assert.equal(status.query.name, 'stone-furnace')
      assert.ok(Array.isArray(status.changes?.entity?.inventories), 'fresh inventories must be present in the delivered diff')
      const baseline = messages.filter(row => row.role === 'tool').map(row => {
        try { return JSON.parse(row.content).entity } catch { return undefined }
      }).find(row => row?.unit_number === unit)
      assert.deepEqual(baseline, seen.initialDeliveredEntity, 'the actual current provider conversation must retain the delivered full baseline')
      seen.currentConversationRetainsBaseline = true
      entity = { ...baseline, ...status.changes.entity }
    }
    assert.equal(entity.unit_number, unit)
    seen.freshDeliveredEntity = structuredClone(entity)
    const items = entity.inventories.flatMap(row => Array.isArray(row.items) ? row.items : [])
    assert.ok(items.some(row => row.name === 'iron-plate' && row.count === 1))
    assert.ok(items.some(row => row.name === 'coal' && row.count === 4))
    assert.ok(!items.some(row => row.name === 'iron-ore'))
    assert.equal(sent.length, 1, 'no completed prefix may replay before the model chooses a fresh repair')
    seen.beforeRepairPlan = structuredClone(ctx.world.memory.planningState(KEY).plans.at(-1))
    return rawRepair()
  })
  .push('executor', 'luna:collect-five-newly-smelted-copper', () => reply([
    { name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: unit, max_count: 5, to_entity: false } },
  ]))
else model.push('executor', 'luna:blocked-continuation-cannot-bypass-canonical-authority', () => {
  assert.equal(ctx.world.memory.planningState(KEY).plans.at(-1).status, 'BLOCKED')
  return rawRepair()
})

try {
  await fsp.mkdir(results, { recursive: true })
  await until('RCON ready', async () => { connection?.close(); connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') }); try { await connection.connect(); return true } catch { return false } }, 20000)
  await configureNpcSession(rcon, `partial-transfer-${mode}-session`)
  const setup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); remote.call("autorio_operations","cancel_all_tasks"); '
    + 'local s=game.create_surface("partial-transfer",{seed=424242,width=0,height=0,water=0,cliff_settings={cliff_elevation_interval=0},autoplace_settings={entity={treat_missing_as_default=false,settings={}}}}); s.request_to_generate_chunks({4,4},1); s.force_generate_chunk_requests(); for _,e in pairs(s.find_entities()) do e.destroy() end; '
    + 'local tiles={}; for x=-16,31 do for y=-16,31 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true); assert(a.teleport({3,4},s)); s.always_day=true; '
    + 'a.get_main_inventory().clear(); for _,v in pairs({{"copper-plate",10},{"copper-ore",10},{"coal",5}}) do assert(a.insert{name=v[1],count=v[2]}==v[2]) end; '
    + 'local f=s.create_entity{name="stone-furnace",position={6,4},force=a.force}; assert(f); assert(f.get_inventory(defines.inventory.furnace_source).insert{name="iron-ore",count=21}==21); assert(f.get_output_inventory().insert{name="iron-plate",count=4}==4); assert(f.get_fuel_inventory().insert{name="coal",count=1}==1); '
    + 'game.speed=16; rcon.print(helpers.table_to_json({actor_id=a.unit_number,unit=f.unit_number,surface_index=s.index}))'))
  unit = setup.unit
  seen.nativeSetup = await until('real coal exhaustion with a reserved unfinished iron craft', async () => {
    const s = await snapshot()
    return (s.fuel.coal ?? 0) === 0 && s.remaining_fuel === 0 && s.energy === 0 && s.crafting_progress > 0 && s.crafting_progress < 1 ? s : false
  }, 20000)
  await lua('game.speed=1; rcon.print("true")')
  // Declared setup ends here. Partial crafting progress was reached by native
  // fuel consumption; no direct progress/energy writes or post-goal stock edits.
  const before = await idle()
  assert.equal(before.source['iron-ore'], 7); assert.equal(before.output['iron-plate'], 17)
  assert.equal(before.held['copper-plate'], 10)
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', AI_API_METHOD: 'cli-proxy', OPENAI_API_KEY: 'fixture-only-not-a-real-key', OPENAI_API_BASEURL: 'https://fixture.example.test/v1', OPENAI_MODEL: `${PLANNER_MODEL},${EXECUTOR_MODEL}` })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: null, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.tools.length, 40); assert.equal(body.tool_choice, context.allowTools === false ? 'none' : 'auto')
    wire.push({ role: context.role, model: body.model, tool_choice: body.tool_choice, tools: body.tools.length })
    const message = await model.provide(body.messages, context)
    return new Response(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 2000, completion_tokens: 120 } }), { status: 200 })
  } })
  const decisionScript = (_state, questions) => ({ overrides: Object.fromEntries(Object.keys(questions).filter(key => key.startsWith('need_')).map(key => [key, { noul: 0.9 }])) })
  const world = recoveryWorld({ game: rcon, model, decisionScript, agentRoleConfig: bridge.config, roleProvider: (messages, context) => bridge.roleProvider(messages, context), stateFile: path.join(results, `partial-transfer-${mode}-state.json`) })
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  ctx.session.queuePlayerRequest('TTLouis', goal.summary)
  await settle(ctx.session); healthy()
  const canonical = structuredClone(world.memory.planningState(KEY))
  seen.failed = await until('native copper refusal after three completed transfer tasks', async () => {
    const s = await snapshot()
    return s.operations.last_cancelled_batch?.reason === refusal ? s : false
  })
  const failed = seen.failed.operations.last_cancelled_batch
  assert.equal(failed.task_count, 4); assert.equal(failed.started_count, 4)
  assert.equal(failed.completed_count, 3); assert.equal(failed.refused_count, 1)
  assert.equal(seen.failed.operations.basic_operation.last_result.moved_count, 0)
  assert.ok(['partial', 'uncertain'].includes(seen.failed.journal.records.at(-1).state))
  seen.afterReservedCraft = await until('reserved native iron product finishes after real refuelling', async () => {
    const s = await snapshot(); return s.output['iron-plate'] === 1 && (s.source['iron-ore'] ?? 0) === 0 ? s : false
  })
  assert.equal(sent.length, 1)
  ctx.session.lastErrorAt = 0
  ctx.session.onGameLine('[AUTORIO] [ERROR] moving_items failed: nothing_moved:target_rejects_item; dependent operations cancelled')
  await settle(ctx.session); healthy()
  if (mode === 'recovery') {
    assert.equal(sent.length, 2)
    assert.equal(world.memory.planningState(KEY).goal.goal_id, canonical.goal.goal_id)
    assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps, canonical.plans.at(-1).steps)
    assert.ok(world.named('operation.reconciled').some(row => row.verdict === 'admitted_partial' && row.effect === 'partial_known' && row.reason === 'exact_terminal_transfer_refusal'))
    assert.equal(seen.failed.journal.records.at(-1).state, 'partial', 'the real native journal must preserve the fully accounted terminal partial effect')
    const closed = world.memory.planningState(KEY).operation_ledger.closed.find(row => row.verdict === 'admitted_partial')
    assert.equal(closed.effect, 'partial_known')
    assert.equal(world.memory.pendingOperations(KEY).some(row => row.operation_key === closed.operation_key), false)
    seen.reconciledLedger = structuredClone(world.memory.planningState(KEY).operation_ledger)
    assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0, 'the root one-plate checkpoint cannot close the committed fifteen-plate step')
    seen.smelted = await until('five real new copper plates', async () => {
      const s = await snapshot(); return s.output['copper-plate'] === 5 && s.copper_produced - before.copper_produced === 5 ? s : false
    })
    await completion()
    assert.equal(sent.length, 3)
    await completion()
    const after = await idle()
    assert.equal(after.held['copper-plate'], 15); assert.equal(after.copper_produced - before.copper_produced, 5)
    assert.equal(after.held['iron-ore'], 7); assert.equal(after.held['iron-plate'], 18)
    assert.equal(after.held['copper-ore'], 5); assert.equal(after.held.coal ?? 0, 0)
    assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
    assert.equal(world.memory.currentPlan(KEY), undefined)
    assert.equal(sent.filter(command => command.includes(`'move_items_exact','iron-ore',${unit},7,false`)).length, 1)
    assert.equal(sent.filter(command => command.includes(`'move_items_exact','iron-plate',${unit},17,false`)).length, 1)
    seen.after = after
  } else {
    assert.ok(corruptions.length > 0)
    const pending = world.memory.pendingOperations(KEY)
    assert.ok(pending.some(row => row.effect === 'partial_unknown'))
    seen.replayGuard = world.memory.checkDuplicateEffect(KEY, { operations: initial() }, { requestId: 'partial-transfer-unknown-replay-control' })
    assert.equal(seen.replayGuard.refuse, true)
    assert.equal(seen.replayGuard.effect, 'partial_unknown')
    assert.equal(sent.length, 1, 'missing receipt fields cannot authorize a repair or completed-prefix replay')
    assert.equal(world.named('operation.reconciled').some(row => row.verdict === 'admitted_partial'), false)
    const errors = world.named('request.failed')
    assert.deepEqual(errors, [], 'canonical refusal is not a malformed completion-declaration failure')
    assert.ok(world.named('plan.completion_declarations_preserved').some(row => row.reason === 'canonical_plan_blocked'))
    assert.ok(world.named('operations.skipped').some(row => row.reason === 'plan_blocked_awaiting_user'))
    const originalPlan = structuredClone(world.memory.planningState(KEY).plans.at(-1))
    const originalPending = structuredClone(world.memory.pendingOperations(KEY))
    const calls = wire.length
    seen.stopPairs = []
    for (let i = 0; i < 2; i++) {
      const traceStart = world.trace.length
      ctx.session.queuePlayerRequest('TTLouis', 'stop')
      await settle(ctx.session)
      const traces = world.trace.slice(traceStart)
      const cancelled = traces.find(row => row.event === 'request.cancelled' && row.data?.reason === 'user_stop_immediate')
      const paused = traces.find(row => row.event === 'goal.paused' && row.data?.cause === 'user_stop' && row.data?.pause_class === 'operator' && row.data?.goal_id === canonical.goal.goal_id)
      assert.ok(cancelled && paused, 'each actual stop must emit a fresh cancel and same-goal operator pause pair')
      assert.deepEqual(world.memory.planningState(KEY).plans.at(-1), originalPlan)
      assert.deepEqual(world.memory.pendingOperations(KEY), originalPending)
      assert.equal(wire.length, calls)
      seen.stopPairs.push({ cancelled, paused })
    }
    seen.after = await idle()
    assert.equal(seen.after.held['copper-plate'], 10)
    assert.equal(seen.after.held['copper-ore'], 10)
    assert.equal(seen.after.output['iron-plate'], 1)
    assert.equal(seen.after.copper_produced - before.copper_produced, 0)
  }
  assert.equal(seen.after.actor_id, before.actor_id)
  assert.equal(wire[0].model, PLANNER_MODEL)
  assert.ok(wire.slice(1).every(row => row.model === EXECUTOR_MODEL))
  assert.deepEqual(model.remaining, []); assert.deepEqual(model.violations, [])
  assert.deepEqual(jevContractLog.filter(row => !row.ok), []); assert.equal(forbiddenFetchCalls, 0)
  assert.deepEqual(world.named('recovery.auto_resume_started'), [], 'neither a proven partial effect nor operator stop replenishes automatic resumes')
  await fsp.writeFile(path.join(results, `partial-transfer-${mode}-proof.json`), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null, mode, setup, before, seen, wire, corruptions, sent, trace: world.trace, forbiddenFetchCalls }, null, 2))
  process.stdout.write(`partial-transfer ${mode} native full-loop PASS\n`)
} catch (error) {
  await fsp.writeFile(path.join(results, `partial-transfer-${mode}-error.txt`), `${error.stack}\n${JSON.stringify({ mode, seen, corruptions, labels: model.labels, logs: ctx?.logs, trace: ctx?.world.trace, wire, transcript }, null, 2)}`)
  throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) }
  connection?.close()
}
