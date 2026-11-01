#!/usr/bin/env node
// Exact-version isolated canary, with scripted messages only. Parent owns the
// fresh server, native build, final save/load proof, resource ledger and teardown.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); if (i >= 0) return process.argv[i + 1]; assert.notEqual(fallback, undefined, `missing --${name}`); return fallback }
const repo = path.resolve(arg('repo')); const results = path.resolve(arg('results'))
const executionForm = arg('execution-form', 'finite'); const goalScope = arg('goal-scope', 'long_horizon')
assert.equal(executionForm, 'finite', 'This explicit-block canary uses the ordinary finite controller'); assert.ok(['finite', 'long_horizon'].includes(goalScope))
const residual = arg('residual', 'false') === 'true'
const load = name => import(pathToFileURL(path.join(repo, 'deploy/pterodactyl', name)).href)
const { Rcon, confirmLuaConsoleReady } = await load('runtime-v8/common.mjs')
const { toolCommand, luaString } = await load('runtime-v8/structured-policy.mjs')
const { configureNpcSession, deploymentStatus } = await load('staging/supervisor-adapter.mjs')
const { CanonicalTaskBoardMemory } = await load('runtime-v8/canonical-task-board-memory.mjs')
const { NpcAgentLoop } = await load('runtime-v8/npc-agent-loop.mjs')
const { FactoryRegistryError } = await load('runtime-v8/factory-registry.mjs')
const { getActivePlan, PLAN_STATUS, RECEIPT_LEDGER_LIMITS } = await load('runtime-v8/planning-state.mjs')
const { answersStepContract, planReply } = await load('runtime-v8/task-loop-fixtures.mjs')
const KEY = 'npc:block-startup-native'
const evidence = { status: 'failed', providers: 0, scripted_replies: 0, kind: 'explicit_production_block_startup_native_canary',
  execution_form: executionForm, goal_scope: goalScope, residual_injected: residual,
  fixture: 'One held furnace and native-derived input/fuel seeded into an isolated actor. Terrain cleared only during declared setup. Placement, step verification, enrollment, supply, wait and collection use the actual harness/native operations. No automated-production claim.' }
const transcript = []; const events = []; const issued = []
let connection; let agent
globalThis.fetch = async () => { evidence.providers++; throw new Error('External inference forbidden') }
const rcon = { command: async command => { const response = await connection.command(command); transcript.push({ command, response }); return response } }
const lua = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
const tool = async (name, args = {}) => JSON.parse(await rcon.command(toolCommand(name, args)))
try {
  await fs.mkdir(results, { recursive: true })
  await assert.rejects(fs.access(path.join(results, 'canary.json')), 'Never overwrite prior proof')
  connection = new Rcon(Number(arg('port')), 'offline-fixture-only', 15000, { host: arg('host', '127.0.0.1') })
  await connection.connect(); assert.match(await rcon.command('/version'), /2\.0\.77/)
  evidence.handshake = await confirmLuaConsoleReady(rcon)
  await lua('assert(#game.connected_players==0);game.speed=1;game.tick_paused=true;rcon.print("{}")')
  await configureNpcSession(rcon, 'block-startup-native-20261101')
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const world = await lua(`rcon.print(helpers.table_to_json(remote.call("sgluna_factory","bind_world_id",${luaString(randomUUID())})))`)
  assert.equal(world.ok, true); evidence.world_id = world.world_id
  const detail = await tool('getRecipeDetails', { item_or_recipe: 'copper-plate', requested_count: 1 })
  const recipe = detail.recipes?.find(row => row.name === 'copper-plate')
  assert.equal(detail.truncated, false); assert.equal(recipe?.enabled, true)
  assert.equal(recipe.ingredients.length, 1); assert.equal(recipe.products.length, 1)
  const input = recipe.ingredients[0]; const output = recipe.products[0]
  assert.equal(input.type, 'item'); assert.equal(output.type, 'item')
  assert.ok(input.amount > 0 && output.amount > 0 && (output.probability === undefined || output.probability === 1))
  const technology = executionForm === 'raw' || goalScope === 'long_horizon' ? await tool('getTechnology', { name: 'electronics' }) : undefined
  if (technology) {
    assert.equal(technology.found, true); assert.equal(technology.researched, false)
    assert.equal(technology.research_trigger?.type, 'craft-item'); assert.equal(technology.research_trigger.item, output.name)
    assert.ok(Number.isSafeInteger(technology.research_trigger.count) && technology.research_trigger.count > 0 && technology.research_trigger.count <= 64)
  }
  const targetCount = technology?.research_trigger.count ?? output.amount
  const executions = Math.ceil(targetCount / output.amount); const inputCount = input.amount * executions
  assert.ok(Number.isSafeInteger(inputCount) && inputCount > 0 && inputCount <= 256)
  const machine = recipe.crafting_machines.find(row => row.name === 'stone-furnace'); assert.ok(machine)
  const fuel = detail.burner_fuels.items.find(row => machine.fuel_categories.includes(row.category) && row.fuel_value > 0); assert.ok(fuel)
  const fuelCount = Math.max(1, Math.ceil(executions * recipe.energy * machine.energy_watts / (machine.crafting_speed * machine.burner_effectivity * fuel.fuel_value)) + 1)
  assert.ok(Number.isSafeInteger(fuelCount) && fuelCount <= 10)
  evidence.live_facts = { detail, technology, targetCount, inputCount, fuel, fuelCount }
  evidence.setup = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a);local s=a.surface;local x=math.floor(a.position.x);local y=math.floor(a.position.y)
    for _,e in pairs(s.find_entities_filtered{area={{x-10,y-10},{x+10,y+10}}})do if e~=a and e.name~="sgluna-npc-vision"then e.destroy()end end
    local tiles={};for xx=x-10,x+10 do for yy=y-10,y+10 do tiles[#tiles+1]={name="landfill",position={xx,yy}}end end;s.set_tiles(tiles,true,false,true)
    local inv=a.get_main_inventory();inv.clear();assert(inv.insert{name="stone-furnace",count=1}==1);assert(inv.insert{name=${luaString(input.name)},count=${inputCount}}==${inputCount});assert(inv.insert{name=${luaString(fuel.name)},count=${fuelCount}}==${fuelCount})
    rcon.print(helpers.table_to_json({x=x+4,y=y,surface_index=s.index,force_index=a.force.index,tick=game.tick,humans=#game.connected_players}))`)
  const memory = new CanonicalTaskBoardMemory(); memory.initializeFactoryRegistry(world.world_id)
  const stateFile = path.join(results, 'canonical-state.json')
  const inventoryContract = { mode: 'all', requirements: [{ id: 'finite-product', kind: 'inventory_count', item_name: output.name, minimum: targetCount },
    ...(technology ? [{ id: 'trigger-research', kind: 'research_completed', technology: technology.name }] : [])] }
  const guidance = { approach: 'Use exact retained placement and current native recipe evidence.', rationale: 'Finite bootstrap on the same immutable goal.', constraints: [], skillIds: [], materialSupply: { mode: 'manual_bootstrap', resource: input.name } }
  const objective = goalScope === 'long_horizon' ? 'Build a new automated factory producing at least one automation-science-pack per game minute. First place the held furnace and complete the native electronics bootstrap.'
    : `Place the held furnace, then produce and collect ${targetCount} ${output.name}.`
  const placementGuidance = { ...guidance, materialSupply: null, cellIntent: { kind: 'production_block', purpose: 'Retain the typed native bootstrap output',
    members: [{ role: 'bootstrap-smelter', entity: machine.name }], outputs: [{ role: 'bootstrap-smelter', kind: output.type, resource: output.name }] } }
  let planner = 0; let executor = 0
  const scripted = answersStepContract(async (_messages, context) => {
    if (context.role === 'planner') {
      assert.ok(++planner <= (goalScope === 'long_horizon' ? 2 : 1), 'Only initial goal grounding may repeat the scripted draft')
      return planReply({ plan: ['Place the held furnace', 'Produce and collect the finite product'], operations: [],
        goal: { scope: goalScope, summary: objective, doneWhen: goalScope === 'long_horizon'
          ? [{ kind: 'production_rate', item_name: 'automation-science-pack', per_minute: 1, window_minutes: 1 }] : inventoryContract.requirements },
        ...(goalScope === 'long_horizon' ? { roadmap: [
          { id: 'bootstrap-electronics', intent: 'Complete the native electronics production trigger.', why_it_matters: 'Finite bootstrap before later automation.', depends_on: [] },
          { id: 'later-factory', intent: 'Build and verify the automated factory after its live prerequisites.', why_it_matters: 'Only actual sustained output can satisfy the goal.', depends_on: ['bootstrap-electronics'] },
        ], roadmapNodeIds: ['bootstrap-electronics'] } : {}), executionGuidance: [placementGuidance, guidance],
        stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ id: 'placed', kind: 'entity_count', prototype: 'stone-furnace', minimum: 1 }] } },
          { kind: 'deterministic', checkpoint: inventoryContract }] })
    }
    assert.ok(++executor <= 2, 'No model retry or correction permitted')
    const plan = getActivePlan(memory.planningState(KEY)); const step = plan.steps[plan.active_step_index]
    const grant = memory.currentGoalGrant(KEY); assert.ok(grant?.grant_id && Number.isSafeInteger(grant.revision), 'Ordinary current goal grant required before placement/use')
    evidence.initial_grant ??= structuredClone(grant)
    assert.equal(grant.grant_id, evidence.initial_grant.grant_id); assert.equal(grant.revision, evidence.initial_grant.revision)
    if (plan.active_step_index === 0) return planReply({ stepId: step.step_id, operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: evidence.setup.x, y: evidence.setup.y } }] })
    const receipts = memory.snapshot().factory_placement_receipts
    assert.equal(receipts.length, 1); const receipt = receipts[0]
    assert.notEqual(receipt.semantic_step_id, step.semantic_step_id ?? step.step_id)
    assert.equal(plan.execution.step_progress[receipt.step_id].status, 'completed')
    evidence.retained_placement = structuredClone(receipt)
    if (executionForm === 'raw') {
      const observed = await tool('getEntityStatus', { unit_number: receipt.unit_number })
      assert.equal(observed.found, true); assert.equal(observed.entity.unit_number, receipt.unit_number)
      agent.recordLiveEntityToolResult('getEntityStatus', JSON.stringify(observed))
      evidence.raw_supply_observation = observed
      evidence.raw_checkpoint_echo = structuredClone(step.completion_contract)
      return planReply({ stepId: step.step_id, operations: [{ name: 'supply_entity', args: { unit_number: receipt.unit_number,
        items: [{ item_name: input.name, count: inputCount }, { item_name: fuel.name, count: fuelCount }] } }], checkpoint: evidence.raw_checkpoint_echo })
    }
    return planReply({ stepId: step.step_id, operations: [], productionTask: { targets: [{ item_name: output.name, count: targetCount }],
      producers: [{ recipe_name: recipe.name, unit_number: receipt.unit_number }], fuel: { item_name: fuel.name, count: fuelCount } } })
  })
  agent = new NpcAgentLoop({ rcon, memory, npcId: 'block-startup-native', completionProtocolVersion: 3, jevCheckpoints: false, replacementWake: true,
    stateFile, traceFile: null, decisionTraceFile: null, systemPrompt: 'Scripted offline native canary.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: async (messages, context) => { const row = { role: context.role, trigger: context.triggerSource, messages: structuredClone(messages) }; issued.push(row)
      row.reply = await scripted(messages, context); evidence.scripted_replies++; return row.reply } })
  agent.behaviorTrace = { emit: async row => events.push(row) }
  const close = agent.ensureFactoryCellClose.bind(agent)
  agent.ensureFactoryCellClose = async owner => {
    if (residual && !evidence.residual_bypassed) { evidence.residual_bypassed = true; throw new FactoryRegistryError('factory_enrollment_native_unverified') }
    return close(owner)
  }
  if (goalScope === 'long_horizon') {
    const settle = agent.settleCompletedStepState.bind(agent)
    agent.settleCompletedStepState = async (state, options) => {
      const result = await settle(state, { ...options, allowContinuation: false })
      return result ?? (state?.status === 'completed' && getActivePlan(memory.planningState(KEY))?.status === PLAN_STATUS.COMPLETED
        ? { sliceComplete: true, goalStatus: memory.planningState(KEY).goal.status } : undefined)
    }
    evidence.proof_boundary = 'Verified bootstrap slice only; next-slice planning suppressed through existing allowContinuation:false and not tested. Overall long-horizon goal must remain active.'
  }
  await lua('game.tick_paused=false;rcon.print("{}")')
  await agent.request(objective, { sender: 'owner' })
  const deadline = Date.now() + 180000
  while (goalScope === 'long_horizon' ? getActivePlan(memory.planningState(KEY))?.status !== PLAN_STATUS.COMPLETED : memory.planningState(KEY)?.goal?.status !== 'completed') {
    assert.ok(Date.now() < deadline, 'Bounded native finite-production timeout')
    const status = await tool('getTaskStatus')
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) await agent.completed()
    assert.notEqual(memory.pauseRecord(KEY)?.paused, true, JSON.stringify(events.slice(-5)))
    await delay(100)
  }
  assert.equal(memory.planningState(KEY).goal.status, goalScope === 'long_horizon' ? 'active' : 'completed')
  if (technology) { evidence.final_technology = await tool('getTechnology', { name: technology.name }); assert.equal(evidence.final_technology.researched, true) }
  assert.equal(events.filter(row => row.event === 'production.manual_bootstrap_normalized').length, executionForm === 'raw' ? 1 : 0)
  if (executionForm === 'raw') {
    const normalized = events.find(row => row.event === 'production.manual_bootstrap_normalized').data
    assert.equal(normalized.checkpoint_disposition, 'identical_committed_contract_retained')
    assert.equal(agent.contractSignature(normalized.original_checkpoint), agent.contractSignature(evidence.raw_checkpoint_echo))
  }
  assert.equal(events.filter(row => row.event.startsWith('production.manual_bootstrap_recovery_')).length, 0)
  const cells = memory.getFactoryRegistry().cells
  assert.equal(cells.length, 1); assert.equal(cells[0].members[0].unit_number, evidence.retained_placement.unit_number)
  assert.equal(cells[0].members[0].provenance.semantic_step_id, evidence.retained_placement.semantic_step_id)
  assert.equal(cells[0].origin.semantic_step_id, evidence.retained_placement.semantic_step_id)
  assert.equal(cells[0].assignment.method, 'production_block')
  assert.deepEqual(cells[0].assignment.products, [output.name])
  assert.equal(cells[0].enrollment.member_roles[0].role, 'bootstrap-smelter')
  assert.deepEqual(memory.snapshot().factory_placement_receipts, [evidence.retained_placement])
  assert.equal(events.filter(row => row.event === 'factory_cell.enrolled_from_production').length, 0)
  const startup = events.filter(row => row.event === 'factory_cell.block_startup_compatible')
  assert.ok(startup.length > 0); assert.ok(startup.every(row => row.data.commissioning === 'unverified' && row.data.members.every(member => member.native_recipe_state === 'none')))
  assert.equal(events.filter(row => row.event === 'factory_cell.block_startup_recovery_started').length, residual ? 1 : 0)
  assert.equal(events.filter(row => row.event === 'factory_cell.block_startup_recovery_completed').length, residual ? 1 : 0)
  evidence.final_grant = memory.currentGoalGrant(KEY)
  assert.equal(evidence.final_grant.grant_id, evidence.initial_grant.grant_id); assert.equal(evidence.final_grant.revision, evidence.initial_grant.revision)
  const finalPlan = getActivePlan(memory.planningState(KEY))
  assert.deepEqual(finalPlan.steps[0].execution_guidance.cellIntent, placementGuidance.cellIntent)
  assert.equal(finalPlan.steps[0].completion_contract.requirements[0].kind, 'entity_count')
  assert.equal(finalPlan.steps[1].completion_contract.requirements[0].item_name, output.name)
  assert.equal(events.filter(row => row.event === 'factory_cell.enrollment_recovery_started').length, 0, 'Normal prevention spends no residual allowance')
  const locator = evidence.retained_placement
  evidence.final_identity = await deploymentStatus(rcon, { requireAllowed: true })
  for (const key of ['actor_id', 'epoch', 'session', 'surface_index', 'force_index']) assert.equal(evidence.final_identity[key], actor[key], `Final actor ${key} changed`)
  evidence.final_entity_status = await tool('getEntityStatus', { unit_number: locator.unit_number })
  const status = evidence.final_entity_status
  assert.equal(status.found, true); assert.equal(status.actor_id, actor.actor_id)
  assert.equal(status.surface_index, locator.surface_index); assert.equal(status.force_index, locator.force_index)
  assert.equal(status.unit_number, locator.unit_number); assert.equal(status.entity.unit_number, locator.unit_number)
  assert.equal(status.entity.name, locator.name); assert.deepEqual(status.entity.position, locator.position)
  // Ordinary buildings need not have the get-by-unit-number prototype flag.
  // Match the native factory observer's bounded exact locator, never a replacement.
  evidence.native_product = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a and a.valid,"final actor unavailable");assert(a.surface.index==${locator.surface_index} and a.force.index==${locator.force_index},"final actor scope changed")
    local s=game.surfaces[${locator.surface_index}];assert(s and s.valid,"final surface unavailable")
    local candidates=s.find_entities_filtered{name=${luaString(locator.name)},position={${locator.position.x},${locator.position.y}},radius=0.25,force=${locator.force_index},limit=9};assert(#candidates<=8,"final locator scan truncated")
    local f;local matched=0;for _,e in pairs(candidates)do if e.valid and e.unit_number==${locator.unit_number} and e.name==${luaString(locator.name)} and e.position.x==${locator.position.x} and e.position.y==${locator.position.y} and e.surface.index==${locator.surface_index} and e.force.index==${locator.force_index} then matched=matched+1;f=e end end;assert(matched==1 and f,"final exact producer identity unavailable or ambiguous")
    local direct=game.get_entity_by_unit_number(${locator.unit_number});assert(not direct or direct==f,"global producer identity disagrees")
    rcon.print(helpers.table_to_json({held=a.get_main_inventory().get_item_count(${luaString(output.name)}),products_finished=f.products_finished,recipe=f.get_recipe() and f.get_recipe().name,recipe_selected=f.get_recipe()~=nil,direct_lookup_found=direct~=nil,exact_locator_matches=matched,unit_number=f.unit_number,name=f.name,position=f.position,surface_index=f.surface.index,force_index=f.force.index,speed=game.speed,humans=#game.connected_players}))`)
  assert.equal(evidence.native_product.exact_locator_matches, 1); assert.equal(evidence.native_product.unit_number, locator.unit_number)
  assert.equal(evidence.native_product.name, locator.name); assert.deepEqual(evidence.native_product.position, locator.position)
  assert.equal(evidence.native_product.surface_index, locator.surface_index); assert.equal(evidence.native_product.force_index, locator.force_index)
  evidence.native_product.expected_recipe = recipe.name
  evidence.native_product.output_item = output.name
  evidence.native_product.recipe ??= null // Actual unselected native recipe, not expected assignment.
  assert.ok(evidence.native_product.held >= targetCount); assert.ok(evidence.native_product.products_finished >= executions)
  assert.ok(evidence.native_product.recipe_selected === false || evidence.native_product.recipe === recipe.name); assert.equal(evidence.native_product.speed, 1); assert.equal(evidence.native_product.humans, 0)
  await agent.persistState({ strict: true })
  const restored = new CanonicalTaskBoardMemory(); restored.restore(JSON.parse(await fs.readFile(stateFile, 'utf8')))
  assert.deepEqual(restored.getFactoryRegistry(), memory.getFactoryRegistry())
  assert.deepEqual(restored.snapshot().factory_placement_receipts, memory.snapshot().factory_placement_receipts)
  assert.deepEqual(restored.snapshot().factory_use_recovery, memory.snapshot().factory_use_recovery)
  const expectedPlanning = structuredClone(memory.planningState(KEY))
  evidence.persisted_diagnostic_tails = []
  for (const plan of expectedPlanning.plans) {
    if (![PLAN_STATUS.COMPLETED, PLAN_STATUS.SUPERSEDED, PLAN_STATUS.CANCELLED].includes(plan.status)) continue
    for (const [stepId, receipts] of Object.entries(plan.execution.receipts)) {
      const retained = receipts.slice(-RECEIPT_LEDGER_LIMITS.closedPlanPerStep)
      if (retained.length !== receipts.length) evidence.persisted_diagnostic_tails.push({
        plan_id: plan.plan_id, step_id: stepId, field: 'execution.receipts',
        limit: RECEIPT_LEDGER_LIMITS.closedPlanPerStep,
        original_sequences: receipts.map(row => row.seq), retained_sequences: retained.map(row => row.seq),
      })
      plan.execution.receipts[stepId] = retained
    }
  }
  // Only closed-plan diagnostic receipt tails may differ. Goal, plan/step
  // identity, progress, contracts, permissions and every other field stay exact.
  assert.deepEqual(restored.planningState(KEY), expectedPlanning)
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
