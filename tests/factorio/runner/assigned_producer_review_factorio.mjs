#!/usr/bin/env node
// Zero-inference exact-version canary. Parent owns the isolated server, save,
// pristine reload and teardown. All recipe and fuel amounts come from live tools.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); if (i >= 0) return process.argv[i + 1]; assert.notEqual(fallback, undefined, `missing --${name}`); return fallback }
const repo = path.resolve(arg('repo')); const results = path.resolve(arg('results'))
const load = name => import(pathToFileURL(path.join(repo, 'deploy/pterodactyl', name)).href)
const { Rcon, confirmLuaConsoleReady } = await load('runtime-v8/common.mjs')
const { toolCommand, luaString } = await load('runtime-v8/structured-policy.mjs')
const { configureNpcSession, deploymentStatus } = await load('staging/supervisor-adapter.mjs')
const { CanonicalTaskBoardMemory } = await load('runtime-v8/canonical-task-board-memory.mjs')
const { NpcAgentLoop } = await load('runtime-v8/npc-agent-loop.mjs')
const { getActivePlan, PLAN_STATUS, RECEIPT_LEDGER_LIMITS } = await load('runtime-v8/planning-state.mjs')
const { answersStepContract, planReply } = await load('runtime-v8/task-loop-fixtures.mjs')
const KEY = 'npc:assigned-producer-native'
const evidence = { status: 'failed', providers: 0, scripted_replies: 0, kind: 'assigned_producer_advisory_native_canary',
  fixture: 'Declared setup seeds two held furnaces and native-derived input/fuel. Actual placement, finite production, assignment, wrong-proposal refusal, advisory review and new same-step finite production use the harness. No automatic-throughput claim.' }
const transcript = []; const events = []; const issued = []
let connection; let agent
globalThis.fetch = async () => { evidence.providers++; throw new Error('External inference forbidden') }
const rcon = { command: async command => { const response = await connection.command(command); transcript.push({ command, response }); return response } }
const lua = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
const tool = async (name, args = {}) => JSON.parse(await rcon.command(toolCommand(name, args)))
try {
  await fs.mkdir(results, { recursive: true }); await assert.rejects(fs.access(path.join(results, 'canary.json')), 'Never overwrite prior proof')
  connection = new Rcon(Number(arg('port')), 'offline-fixture-only', 15000, { host: arg('host', '127.0.0.1') })
  await connection.connect(); assert.match(await rcon.command('/version'), /2\.0\.77/)
  evidence.handshake = await confirmLuaConsoleReady(rcon)
  await lua('assert(#game.connected_players==0);game.speed=1;game.tick_paused=true;rcon.print("{}")')
  await configureNpcSession(rcon, 'assigned-producer-native-20261101')
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const world = await lua(`rcon.print(helpers.table_to_json(remote.call("sgluna_factory","bind_world_id",${luaString(randomUUID())})))`)
  assert.equal(world.ok, true); evidence.world_id = world.world_id
  const facts = []
  for (const name of ['copper-plate', 'iron-plate']) {
    const detail = await tool('getRecipeDetails', { item_or_recipe: name, requested_count: 1 })
    const recipe = detail.recipes?.find(row => row.name === name)
    assert.equal(detail.truncated, false); assert.equal(recipe?.enabled, true)
    assert.equal(recipe.ingredients.length, 1); assert.equal(recipe.products.length, 1)
    const input = recipe.ingredients[0]; const output = recipe.products[0]
    assert.equal(input.type, 'item'); assert.equal(output.type, 'item'); assert.ok(input.amount > 0 && output.amount > 0)
    assert.ok(output.probability === undefined || output.probability === 1)
    const machine = recipe.crafting_machines.find(row => row.name === 'stone-furnace'); assert.ok(machine)
    const fuel = detail.burner_fuels.items.find(row => machine.fuel_categories.includes(row.category) && row.fuel_value > 0); assert.ok(fuel)
    const cycles = name === 'iron-plate' ? 2 : 1
    const fuelCount = Math.max(1, Math.ceil(cycles * recipe.energy * machine.energy_watts / (machine.crafting_speed * machine.burner_effectivity * fuel.fuel_value)) + 1)
    assert.ok(Number.isSafeInteger(input.amount * cycles) && input.amount * cycles <= 256)
    assert.ok(Number.isSafeInteger(fuelCount) && fuelCount <= 10)
    facts.push({ recipe, input, output, fuel, fuelCount, cycles, detail })
  }
  const [copper, iron] = facts
  assert.equal(copper.fuel.name, iron.fuel.name, 'Fixture requires one common live-proven fuel')
  const fuelCount = facts.reduce((sum, row) => sum + row.fuelCount, 0) + 2
  evidence.live_facts = facts
  evidence.setup = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a);local s=a.surface;local x=math.floor(a.position.x);local y=math.floor(a.position.y)
    for _,e in pairs(s.find_entities_filtered{area={{x-12,y-12},{x+12,y+12}}})do if e~=a and e.name~="sgluna-npc-vision"then e.destroy()end end
    local tiles={};for xx=x-12,x+12 do for yy=y-12,y+12 do tiles[#tiles+1]={name="landfill",position={xx,yy}}end end;s.set_tiles(tiles,true,false,true)
    local inv=a.get_main_inventory();inv.clear();assert(inv.insert{name="stone-furnace",count=2}==2)
    ${facts.map(row => `assert(inv.insert{name=${luaString(row.input.name)},count=${row.input.amount * row.cycles}}==${row.input.amount * row.cycles})`).join(';')}
    assert(inv.insert{name=${luaString(iron.fuel.name)},count=${fuelCount}}==${fuelCount})
    rcon.print(helpers.table_to_json({x=x+4,y=y,surface_index=s.index,force_index=a.force.index,tick=game.tick,humans=#game.connected_players}))`)
  const memory = new CanonicalTaskBoardMemory(); memory.initializeFactoryRegistry(world.world_id)
  const stateFile = path.join(results, 'canonical-state.json')
  const firstStock = { mode: 'all', requirements: facts.map(row => ({ kind: 'inventory_count', item_name: row.output.name, minimum: row.output.amount })) }
  const finalStock = { mode: 'all', requirements: facts.map(row => ({ kind: 'inventory_count', item_name: row.output.name, minimum: row.output.amount * row.cycles })) }
  const guidance = { approach: 'Preserve the two assigned producers and obtain the exact requested stock.', rationale: 'Native finite inventory proof; assigned jobs are immutable.',
    constraints: ['Preserve both furnaces and their assigned jobs.'], skillIds: [], materialSupply: { mode: 'manual_bootstrap', resource: iron.input.name } }
  const objective = 'Build an automated factory producing at least one automation-science-pack per game minute. First establish dedicated copper and iron furnaces and obtain the bootstrap stock.'
  let planner = 0; let reviews = 0; let wrongIssued = false; let reviewedProposal = false
  const placements = () => {
    const receipts = memory.snapshot().factory_placement_receipts
    assert.equal(receipts.length, 2)
    return facts.map((_, index) => { const receipt = receipts.find(row => row.position.x === evidence.setup.x + index * 3 && row.position.y === evidence.setup.y); assert.ok(receipt); return receipt })
  }
  const scripted = answersStepContract(async (_messages, context) => {
    const plan = getActivePlan(memory.planningState(KEY))
    if (context.role === 'planner' && agent.reviewContinuation) {
      assert.equal(++reviews, 1); assert.equal(wrongIssued, true)
      assert.deepEqual(plan.steps, evidence.before_conflict.steps)
      assert.equal(events.filter(row => row.event === 'factory_cell.assigned_review_started').length, 1)
      const boundary = events.findLast(row => row.event === 'factory_cell.boundary_refused')
      assert.equal(boundary.data.code, 'factory_cell_input_unproven'); assert.equal(boundary.data.current_batch_sent, false)
      const sends = transcript.slice(evidence.wrong_submission_transcript_index).filter(row => row.command.includes("remote.call('autorio_operations'"))
      assert.equal(sends.length, 0, 'The rejected proposal cannot dispatch any native operation before advisory review')
      evidence.advisory_boundary = boundary; evidence.wrong_proposal_unsent = true
      evidence.review_registry = memory.getFactoryRegistry()
      return planReply({ plan: plan.steps.map(step => step.description), operations: [],
        chatMessage: `Keep the plan, stock checkpoint and assignments unchanged. The copper producer ${placements()[0].unit_number} does not accept the selected iron input. Reobserve the iron producer ${placements()[1].unit_number} and propose ordinary compatible work; these notes confer no operation authority.` })
    }
    if (context.role === 'planner') {
      assert.ok(++planner <= 2, 'Only initial goal grounding may repeat')
      return planReply({ plan: ['Place the held copper furnace', 'Place the held iron furnace', 'Produce and collect the initial stock in dedicated producers', 'Obtain the remaining stock while preserving both assigned jobs'], operations: [],
        goal: { scope: 'long_horizon', summary: objective, doneWhen: [{ kind: 'production_rate', item_name: 'automation-science-pack', per_minute: 1, window_minutes: 1 }] },
        roadmap: [{ id: 'bootstrap', intent: 'Establish dedicated producers and obtain finite bootstrap stock.', why_it_matters: 'Verified prerequisites before later automation.', depends_on: [] },
          { id: 'automation', intent: 'Build and verify sustained automated output using current native facts.', why_it_matters: 'Only native sustained output completes the goal.', depends_on: ['bootstrap'] }],
        roadmapNodeIds: ['bootstrap'], executionGuidance: [guidance, guidance, guidance, guidance],
        stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ kind: 'entity_count', prototype: 'stone-furnace', minimum: 1 }] } },
          { kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ kind: 'entity_count', prototype: 'stone-furnace', minimum: 2 }] } },
          { kind: 'deterministic', checkpoint: firstStock }, { kind: 'deterministic', checkpoint: finalStock }] })
    }
    const step = plan.steps[plan.active_step_index]
    if (plan.active_step_index < 2) return planReply({ stepId: step.step_id, operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: evidence.setup.x + plan.active_step_index * 3, y: evidence.setup.y } }] })
    const receipts = placements()
    if (plan.active_step_index === 2) return planReply({ stepId: step.step_id, operations: [], productionTask: {
      targets: facts.map(row => ({ item_name: row.output.name, count: row.output.amount })),
      producers: facts.map((row, index) => ({ recipe_name: row.recipe.name, unit_number: receipts[index].unit_number })), fuel: { item_name: iron.fuel.name, count: fuelCount - 1 } } })
    assert.equal(plan.active_step_index, 3)
    if (!wrongIssued) {
      const observed = await tool('getEntityStatus', { unit_number: receipts[0].unit_number }); assert.equal(observed.found, true)
      agent.recordLiveEntityToolResult('getEntityStatus', JSON.stringify(observed))
      evidence.before_conflict = { goal: structuredClone(memory.planningState(KEY).goal), plan_id: plan.plan_id, plan_version: plan.plan_version,
        steps: structuredClone(plan.steps), registry: memory.getFactoryRegistry(), placements: structuredClone(receipts), native: observed }
      wrongIssued = true
      evidence.wrong_submission_transcript_index = transcript.length
      evidence.original_wrong_proposal = { stepId: step.step_id, operations: [{ name: 'supply_entity', args: { unit_number: receipts[0].unit_number,
        items: [{ item_name: iron.input.name, count: iron.input.amount }, { item_name: iron.fuel.name, count: 1 }] } }], checkpoint: step.completion_contract }
      return planReply(evidence.original_wrong_proposal)
    }
    assert.equal(reviews, 1); assert.equal(reviewedProposal, false); reviewedProposal = true
    assert.deepEqual(plan.steps, evidence.before_conflict.steps)
    const observed = await tool('getEntityStatus', { unit_number: receipts[1].unit_number }); assert.equal(observed.found, true)
    agent.recordLiveEntityToolResult('getEntityStatus', JSON.stringify(observed)); evidence.new_proposal_observation = observed
    evidence.new_executor_proposal = { stepId: step.step_id, operations: [], productionTask: {
      targets: [{ item_name: iron.output.name, count: iron.output.amount * 2 }], producers: [{ recipe_name: iron.recipe.name, unit_number: receipts[1].unit_number }],
      fuel: { item_name: iron.fuel.name, count: 1 } } }
    return planReply(evidence.new_executor_proposal)
  })
  agent = new NpcAgentLoop({ rcon, memory, npcId: 'assigned-producer-native', completionProtocolVersion: 3, jevCheckpoints: false,
    stateFile, traceFile: null, decisionTraceFile: null, systemPrompt: 'Scripted offline assigned-producer canary.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: async (messages, context) => { const active = getActivePlan(memory.planningState(KEY)); const row = { role: context.role, trigger: context.triggerSource,
      request_id: agent.traceRequest?.id, plan_id: active?.plan_id, step_id: active?.steps?.[active.active_step_index]?.step_id, messages: structuredClone(messages) }; issued.push(row)
      row.reply = await scripted(messages, context); evidence.scripted_replies++; return row.reply } })
  agent.behaviorTrace = { emit: async row => events.push(row) }
  const settle = agent.settleCompletedStepState.bind(agent)
  agent.settleCompletedStepState = async (state, options) => {
    const result = await settle(state, { ...options, allowContinuation: false })
    return result ?? (state?.status === 'completed' && getActivePlan(memory.planningState(KEY))?.status === PLAN_STATUS.COMPLETED
      ? { sliceComplete: true, goalStatus: memory.planningState(KEY).goal.status } : undefined)
  }
  evidence.proof_boundary = 'Finite bootstrap slice only; next-slice planning suppressed with existing allowContinuation:false. Overall goal remains active.'
  await lua('game.tick_paused=false;rcon.print("{}")'); await agent.request(objective, { sender: 'owner' })
  const deadline = Date.now() + 180000
  while (getActivePlan(memory.planningState(KEY))?.status !== PLAN_STATUS.COMPLETED) {
    assert.ok(Date.now() < deadline, 'Bounded native canary timeout')
    const status = await tool('getTaskStatus')
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) await agent.completed()
    assert.notEqual(memory.pauseRecord(KEY)?.paused, true, JSON.stringify(events.slice(-5))); await delay(100)
  }
  const final = getActivePlan(memory.planningState(KEY)); assert.equal(memory.planningState(KEY).goal.status, 'active')
  assert.equal(reviews, 1); assert.equal(reviewedProposal, true)
  assert.equal(final.plan_id, evidence.before_conflict.plan_id); assert.equal(final.plan_version, evidence.before_conflict.plan_version)
  assert.deepEqual(final.steps, evidence.before_conflict.steps)
  assert.deepEqual(memory.getFactoryRegistry(), evidence.before_conflict.registry)
  assert.deepEqual(memory.snapshot().factory_placement_receipts, evidence.before_conflict.placements)
  assert.equal(events.filter(row => row.event === 'plan.replacement_committed').length, 0)
  assert.equal(memory.snapshot().factory_use_recovery.records[0].attempts.length, 1)
  assert.ok(memory.planningState(KEY).goal.review_notes[final.steps[3].step_id])
  evidence.native_products = []
  for (const [index, locator] of placements().entries()) {
    const fact = facts[index]
    const status = await tool('getEntityStatus', { unit_number: locator.unit_number })
    assert.equal(status.found, true); assert.equal(status.actor_id, actor.actor_id)
    assert.equal(status.entity.unit_number, locator.unit_number); assert.equal(status.entity.name, locator.name); assert.deepEqual(status.entity.position, locator.position)
    const row = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a and a.valid);assert(a.surface.index==${locator.surface_index} and a.force.index==${locator.force_index})
      local s=game.surfaces[${locator.surface_index}];local candidates=s.find_entities_filtered{name=${luaString(locator.name)},position={${locator.position.x},${locator.position.y}},radius=0.25,force=${locator.force_index},limit=9};assert(#candidates<=8)
      local f;local matched=0;for _,e in pairs(candidates)do if e.valid and e.unit_number==${locator.unit_number} and e.name==${luaString(locator.name)} and e.position.x==${locator.position.x} and e.position.y==${locator.position.y} and e.surface.index==${locator.surface_index} and e.force.index==${locator.force_index} then matched=matched+1;f=e end end;assert(matched==1 and f)
      local direct=game.get_entity_by_unit_number(${locator.unit_number});assert(not direct or direct==f)
      rcon.print(helpers.table_to_json({held=a.get_main_inventory().get_item_count(${luaString(fact.output.name)}),products_finished=f.products_finished,recipe=f.get_recipe() and f.get_recipe().name,recipe_selected=f.get_recipe()~=nil,direct_lookup_found=direct~=nil,exact_locator_matches=matched,unit_number=f.unit_number,name=f.name,position=f.position,surface_index=f.surface.index,force_index=f.force.index,speed=game.speed,humans=#game.connected_players}))`)
    row.recipe ??= null; row.expected_recipe = fact.recipe.name; row.output_item = fact.output.name
    row.expected_minimum = fact.output.amount * fact.cycles; row.placement = locator
    assert.equal(row.exact_locator_matches, 1); assert.ok(row.held >= row.expected_minimum); assert.ok(row.products_finished >= fact.cycles)
    assert.ok(!row.recipe_selected || row.recipe === row.expected_recipe); assert.equal(row.speed, 1); assert.equal(row.humans, 0)
    evidence.native_products.push(row)
  }
  await agent.persistState({ strict: true })
  const restored = new CanonicalTaskBoardMemory(); restored.restore(JSON.parse(await fs.readFile(stateFile, 'utf8')))
  assert.deepEqual(restored.getFactoryRegistry(), memory.getFactoryRegistry())
  assert.deepEqual(restored.snapshot().factory_placement_receipts, memory.snapshot().factory_placement_receipts)
  assert.deepEqual(restored.snapshot().factory_use_recovery, memory.snapshot().factory_use_recovery)
  const expected = structuredClone(memory.planningState(KEY)); evidence.persisted_diagnostic_tails = []
  for (const plan of expected.plans) if ([PLAN_STATUS.COMPLETED, PLAN_STATUS.SUPERSEDED, PLAN_STATUS.CANCELLED].includes(plan.status)) {
    for (const [stepId, receipts] of Object.entries(plan.execution.receipts)) {
      const retained = receipts.slice(-RECEIPT_LEDGER_LIMITS.closedPlanPerStep)
      if (retained.length !== receipts.length) evidence.persisted_diagnostic_tails.push({ plan_id: plan.plan_id, step_id: stepId, field: 'execution.receipts',
        limit: RECEIPT_LEDGER_LIMITS.closedPlanPerStep, original_sequences: receipts.map(row => row.seq), retained_sequences: retained.map(row => row.seq) })
      plan.execution.receipts[stepId] = retained
    }
  }
  assert.deepEqual(restored.planningState(KEY), expected)
  evidence.final_snapshot = memory.snapshot(); assert.equal(evidence.providers, 0); evidence.status = 'passed'
} catch (error) { evidence.error = String(error?.stack ?? error); process.exitCode = 1 }
finally {
  if (connection) {
    try {
      if (agent) { agent.active = false; agent.generation++ }
      evidence.final_native = await lua('game.speed=1;game.tick_paused=true;rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed,humans=#game.connected_players}))')
      evidence.final_task = await tool('getTaskStatus')
      assert.equal(evidence.final_native.paused, true); assert.equal(evidence.final_native.speed, 1); assert.equal(evidence.final_native.humans, 0)
      assert.equal(evidence.final_task.task_state, 'idle'); assert.equal(evidence.final_task.queue_length, 0); assert.ok(!evidence.final_task.active_batch)
    } catch (error) { evidence.status = 'failed'; evidence.final_error = String(error); process.exitCode = 1 }
    connection.close()
  }
  await fs.mkdir(results, { recursive: true })
  for (const [name, value] of [['canary', evidence], ['transcript', transcript], ['events', events], ['scripted-replies', issued]]) await fs.writeFile(path.join(results, `${name}.json`), JSON.stringify(value, null, 2))
  console.log(JSON.stringify({ status: evidence.status, providers: evidence.providers, scripted_replies: evidence.scripted_replies }))
}
