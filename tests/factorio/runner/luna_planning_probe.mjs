#!/usr/bin/env node
// Opt-in only. No RCON connection, operation admission, Jev call, or provider retry.
// Docker must inject .env with --env-file; this file never opens an environment file.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const runtime = path.join(root, 'deploy/pterodactyl/runtime-v8')
const load = name => import(pathToFileURL(path.join(runtime, name)).href)
const { providerRequest, normalizeProviderPlanContentDetailed, providerEndpoint } = await load('provider.mjs')
const { NpcAgentLoop } = await load('npc-agent-loop.mjs')
const { CanonicalTaskBoardMemory } = await load('canonical-task-board-memory.mjs')
const { getActivePlan } = await load('planning-state.mjs')
const { evaluateCompletionContract, sanitizeStepCompletionContract } = await load('step-completion.mjs')
const { buildHandoffPacket } = await load('handoff-packet.mjs')
const { roleSystemPrompt } = await load('agent-roles.mjs')
const { RUNTIME_RELIABILITY_GUIDANCE } = await load('supervisor.mjs')

const args = process.argv.slice(2)
const live = args.includes('--live')
assert.equal(live && args.includes('--dry-run'), false, 'choose --live or --dry-run')
assert.ok(live || args.includes('--dry-run'), 'explicit --live or --dry-run is required')
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const names = ['new_plan', 'unmet_research', 'satisfied_continuation', 'grounded_semantic']
const chosen = option('--cases', 'all')
const selected = chosen === 'all' ? names : chosen.split(',')
assert.ok(selected.length > 0 && selected.length <= 4 && new Set(selected).size === selected.length)
assert.ok(selected.every(name => names.includes(name)), 'unknown probe case')
const output = path.resolve(root, option('--output', 'test-results/luna-planning-probe'))
const resultsRoot = path.join(root, 'test-results')
assert.ok(output.startsWith(`${resultsRoot}${path.sep}`), 'output must remain below test-results')
const key = process.env.OPENAI_API_KEY ?? ''
const base = process.env.OPENAI_API_BASEURL ?? ''
const model = live ? process.env.OPENAI_MODEL : 'gpt-6-luna'
let expectedEndpoint
if (live) {
  assert.equal(model, 'gpt-6-luna', 'this probe only permits OPENAI_MODEL=gpt-6-luna')
  assert.ok(key.trim(), 'OPENAI_API_KEY must be injected by Docker')
  let url
  try { url = new URL(base) } catch { throw new Error('invalid configured proxy URL') }
  const host = url.hostname
  const parts = host.split('.').map(Number)
  const privateIpv4 = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127))
  assert.ok(url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash
    && (privateIpv4 || host.endsWith('.ts.net') || ['localhost', 'host.docker.internal'].includes(host)),
  'the probe requires an HTTP local/tailnet proxy')
  expectedEndpoint = providerEndpoint(base)
}
const config = { base, key, model, profile: 'local', timeoutMs: 90_000 }
const sanitize = value => {
  let text = JSON.stringify(value)
  for (const secret of [key, base, expectedEndpoint].filter(Boolean)) text = text.split(secret).join('[redacted]')
  return JSON.parse(text.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]'))
}
const copper = { mode: 'all', requirements: [{ id: 'copper', kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] }
const research = { mode: 'all', requirements: [{ id: 'research', kind: 'research_completed', technology: 'automation' }] }
const gather = { name: 'gather_resource', args: { resource_name: 'copper-ore', count: 10, search_radius: 256 } }
const researchAction = { name: 'research_technology', args: { technology_name: 'automation' } }
const objective = 'Gather ten copper ore and research automation.'
const goal = { scope: 'finite', summary: objective, doneWhen: [{ kind: 'research_completed', technology: 'automation' }] }
const request = { sender: 'probe_owner', text: objective, turnId: 1, memoryKey: 'npc:sgluna' }
const actor = { actor_id: 18, actor_kind: 'standalone_character', epoch: 3, allowed: true, idle: true }
const steps = ['Gather ten copper ore', 'Research automation']
const draft = { chatMessage: '', plan: steps, currentStep: 0, operations: [gather], goal,
  stepCompletions: [{ kind: 'deterministic', checkpoint: copper }, { kind: 'deterministic', checkpoint: research }] }
const basePrompt = await fsp.readFile(path.join(root, 'packages/agent/src/llm/prompt.md'), 'utf8')

// Only fixed fixture observations can be read. This is not a network RCON adapter.
const frozenFacts = { async command(command) {
  assert.ok(command.includes('evaluate_condition'), 'probe forbids every non-condition RCON command')
  if (command.includes('research_completed')) return JSON.stringify({ ok: true, satisfied: false, technology: 'automation' })
  if (command.includes('inventory_count')) return JSON.stringify({ ok: true, current: 0, satisfied: false })
  throw new Error('probe fixture has no observation for this predicate')
} }
function controller(seed) {
  const memory = new CanonicalTaskBoardMemory()
  const agent = new NpcAgentLoop({ memory, rcon: frozenFacts, completionProtocolVersion: 2,
    provider: async () => { throw new Error('nested providers are forbidden') },
    systemPrompt: `${basePrompt}\n\n${RUNTIME_RELIABILITY_GUIDANCE}`, npcId: 'sgluna',
    stateFile: null, traceFile: null, decisionTraceFile: null })
  agent.requestInfo = { ...request }
  agent.epoch = actor
  agent.behaviorTrace = { emit: async () => {} }
  if (seed) {
    const recorded = memory.recordPlan(request.memoryKey, request, seed, { validatedSemanticAdmission: seed.operations.length === 0 })
    memory.reconcileTaskBoard(request.memoryKey, recorded.state.task_board, seed, recorded)
    memory.commitPlanningPlan(request.memoryKey, { runtime_validation: { passed: true } })
  }
  return { agent, memory }
}
function packet(world) {
  return buildHandoffPacket({ planningState: world.memory.planningState(request.memoryKey),
    role: 'executor', checkpoint: 'C3', reason: 'planning_only_fixture', actor,
    runtime: { task_state: 'idle', queue_length: 0 } })
}
function messages(world, instruction, executor = false) {
  const rows = [{ role: 'system', content: roleSystemPrompt(world.agent.systemPrompt, executor ? 'executor' : 'planner') }]
  if (executor) {
    const handoff = packet(world)
    rows.push({ role: 'user', content: handoff.stableText }, { role: 'user', content: handoff.volatileText })
  }
  rows.push({ role: 'user', content: instruction })
  return rows
}
function requireResearchAction(plan) {
  assert.ok(plan.operations.some(op => op.name === 'research_technology' && op.args.technology_name === 'automation'),
    'expected a research action proposal for unmet automation; no action will be admitted')
}
async function makeCase(name) {
  if (name === 'new_plan') {
    const world = controller()
    return { world, role: 'planner', sample: draft,
      messages: messages(world, '[CHAT] probe_owner: Gather ten copper ore and research automation. Fresh authoritative fixture facts: copper ore held=0, automation researched=false, research is available. Propose the first plan using the production completion declarations. No operations from this response will execute.'),
      async validate(plan) {
        await world.agent.validateStepCompletionDeclarations(plan)
        assert.ok(plan.stepCompletions?.length === plan.plan.length)
        assert.ok(plan.stepCompletions.some(spec => spec.kind === 'deterministic' && spec.checkpoint.requirements.some(req => req.kind === 'inventory_count' && req.item_name === 'copper-ore' && req.minimum === 10)))
        assert.ok(plan.stepCompletions.some(spec => spec.kind === 'deterministic' && spec.checkpoint.requirements.some(req => req.kind === 'research_completed' && req.technology === 'automation')))
        const recorded = world.memory.recordPlan(request.memoryKey, request, plan)
        world.memory.reconcileTaskBoard(request.memoryKey, recorded.state.task_board, plan, recorded)
        world.memory.commitPlanningPlan(request.memoryKey, { runtime_validation: { passed: true } })
        assert.equal(getActivePlan(world.memory.planningState(request.memoryKey)).status, 'COMMITTED')
        assert.equal(world.memory.currentPlan(request.memoryKey).task_board.completed_count, 0)
        assert.equal(world.memory.planningState(request.memoryKey).goal.status, 'active')
      } }
  }
  if (name === 'unmet_research') {
    const world = controller({ ...draft, plan: [steps[1]], currentStep: 0, operations: [], stepCompletions: [draft.stepCompletions[1]] })
    return { world, role: 'executor', sample: { chatMessage: '', plan: [steps[1]], currentStep: 0, operations: [researchAction] },
      messages: messages(world, '[HARNESS] Older research snapshot said researched=true, but that snapshot is stale. The fresh authoritative research read says automation researched=false. No research completion receipt exists. Keep the committed step active and choose the next action. Only proposals are collected; none execute.', true),
      async validate(plan) {
        for (const facts of [{ research: { kind: 'research_completed', technology: 'automation', authoritative: true, satisfied: true, stale: true } },
          { research: { kind: 'research_completed', technology: 'automation', authoritative: true, satisfied: false } }]) assert.equal(evaluateCompletionContract(research, facts).satisfied, false)
        assert.equal(evaluateCompletionContract(research, { research: { kind: 'research_completed', technology: 'automation', authoritative: true, satisfied: true } }).satisfied, true)
        const before = structuredClone(world.memory.planningState(request.memoryKey))
        await world.agent.enforceExecutorContract(plan)
        await world.agent.validateStepCompletionDeclarations(plan)
        assert.equal(plan.semanticCompletion, undefined)
        assert.equal(plan.currentStep, 0)
        assert.ok(plan.plan.length > 0)
        requireResearchAction(plan)
        assert.deepEqual(world.memory.planningState(request.memoryKey), before)
      } }
  }
  if (name === 'satisfied_continuation') {
    const world = controller(draft)
    const boardStep = world.memory.currentPlan(request.memoryKey).task_board.steps[0]
    const contract = sanitizeStepCompletionContract(copper)
    const evaluation = evaluateCompletionContract(contract, { copper: { kind: 'inventory_count', current: 10, item_name: 'copper-ore', stale: false } })
    assert.equal(evaluation.satisfied, true)
    const closed = await world.agent.applyStepClose('planning_probe_fixture', { key: request.memoryKey, step: boardStep,
      contract, results: evaluation.results, reasonCode: 'deterministic_checkpoint_satisfied', source: 'deterministic_completion_contract' })
    assert.equal(closed.closed, true, JSON.stringify(closed))
    return { world, role: 'executor', sample: { chatMessage: '', plan: steps, currentStep: 1, operations: [researchAction] },
      messages: messages(world, '[MOD] Autorio operation batch completed. The harness verified copper ore held=10 and closed the first step using its immutable predicate. Fresh automation researched=false. Decide for the current active step shown in this packet. Do not replay the completed gathering action. Your proposed operations will not execute.', true),
      async validate(plan) {
        await world.agent.enforceExecutorContract(plan)
        await world.agent.validateStepCompletionDeclarations(plan)
        assert.equal(plan.currentStep, 1)
        assert.equal(plan.semanticCompletion, undefined)
        requireResearchAction(plan)
        assert.ok(!plan.operations.some(op => op.name === 'gather_resource'))
        assert.equal(world.memory.currentPlan(request.memoryKey).task_board.completed_count, 1)
        assert.equal(getActivePlan(world.memory.planningState(request.memoryKey)).active_step_index, 1)
      } }
  }
  const semanticSeed = { ...draft, plan: ['Assess the observed copper approach', steps[0]], currentStep: 0, operations: [],
    stepCompletions: [{ kind: 'semantic', rationale: 'Assess the approach after observing the patch.' }, draft.stepCompletions[0]] }
  const world = controller(semanticSeed)
  const stepId = getActivePlan(world.memory.planningState(request.memoryKey)).steps[0].step_id
  world.memory.recordBoardEvidence(request.memoryKey, { kind: 'verified_world_state', ref: 'probe/approach_read',
    summary: 'Authoritative read-only fixture: a nearby copper patch has a clear reachable approach; no world changes have been requested.' })
  return { world, role: 'executor', sample: { chatMessage: '', plan: semanticSeed.plan, currentStep: 0, operations: [],
    semanticCompletion: { stepId, rationale: 'The authoritative read-only approach observation grounds this assessment.' } },
    messages: messages(world, `[HARNESS] The active assessment is genuinely semantic. A fresh authoritative read-only observation, ref=probe/approach_read, found a nearby copper patch with a clear reachable approach. Assess that evidence and close only this assessment through semanticCompletion for its exact Plan Tracker stepId=${stepId}. Return operations:[]; defer the next gameplay action to another decision. Tool calls are closed but the control contract remains available.`, true),
    async validate(plan) {
      assert.equal(plan.operations.length, 0)
      assert.ok(plan.semanticCompletion)
      world.agent.semanticCompletionClaimCheck(plan.semanticCompletion, world.memory.currentPlan(request.memoryKey))
      const applied = await world.agent.applySemanticCompletionClaim(plan, world.memory.currentPlan(request.memoryKey))
      assert.equal(applied.applied, true)
      assert.equal(world.memory.currentPlan(request.memoryKey).task_board.completed_count, 1)
      assert.equal(getActivePlan(world.memory.planningState(request.memoryKey)).active_step_index, 1)
    } }
}

let httpCalls = 0
let wireRequest
async function boundedFetch(url, options) {
  assert.equal(String(url), expectedEndpoint, 'unexpected endpoint')
  wireRequest = JSON.parse(options.body)
  assert.equal(wireRequest.model, 'gpt-6-luna')
  assert.ok(++httpCalls <= selected.length && httpCalls <= 4, 'probe HTTP call cap exceeded')
  const response = await fetch(url, { ...options, redirect: 'error' })
  // Production providerRequest retains its stricter 256 KiB success-body bound.
  return response
}
await fsp.mkdir(output, { recursive: true })
const results = []
for (const name of selected) {
  wireRequest = undefined
  let scenario
  let reply
  let result
  const started = Date.now()
  try {
    scenario = await makeCase(name)
    if (!live) {
      reply = { content: JSON.stringify(scenario.sample) }
    } else {
      reply = await providerRequest(config, scenario.messages, { allowTools: false, recoveryAttempt: 0,
        round: 1, requestId: `luna_probe_${name}`, promptTraceFile: null, fetchImpl: boundedFetch,
        triggerSource: name === 'new_plan' ? 'new_goal' : 'post_step_continue', forceFullPlanner: true })
      assert.equal(reply.tool_calls?.length ?? 0, 0, 'closed round returned a tool call')
      assert.ok(!reply._sglunaProvider?.model || reply._sglunaProvider.model === 'gpt-6-luna', 'response reports a different model')
    }
    const normalized = normalizeProviderPlanContentDetailed(reply.content)
    assert.equal(normalized.refused, undefined, 'provider returned conflicting plan objects')
    const parsed = scenario.world.agent.parsePlanMessage({ ...reply, content: normalized.content })
    await scenario.validate(parsed)
    result = { case: name, passed: true, parsed, tracker: scenario.world.memory.planningTrackerView(request.memoryKey) }
  } catch (error) {
    result = { case: name, passed: false, error: { code: error.cause?.code ?? error.code ?? 'probe_validation_failed', message: error.message } }
  }
  result.mode = live ? 'live_luna_planning_only' : 'offline_sample_validation'
  result.elapsed_ms = Date.now() - started
  result.no_gameplay = true
  result.wire_request = wireRequest
  await fsp.writeFile(path.join(output, `${name}.json`), `${JSON.stringify(sanitize({ ...result,
    messages: scenario?.messages, response: reply ? { content: reply.content, tool_calls: reply.tool_calls, diagnostics: reply._sglunaProvider } : null }), null, 2)}\n`)
  results.push({ case: name, passed: result.passed, elapsed_ms: result.elapsed_ms })
  console.log(`${name}: ${result.passed ? 'PASS' : 'FAIL'}`)
}
await fsp.writeFile(path.join(output, 'summary.json'), `${JSON.stringify({ mode: live ? 'live' : 'dry_run',
  http_calls: httpCalls, max_http_calls: 4, timeout_ms: 90_000, production_success_response_limit_bytes: 256 * 1024,
  retries: 0, jev_calls: 0, game_connections: 0, gameplay_admissions: 0, results }, null, 2)}\n`)
process.exitCode = results.every(row => row.passed) ? 0 : 1
