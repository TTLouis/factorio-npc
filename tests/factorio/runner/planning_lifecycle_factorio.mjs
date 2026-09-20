#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from '../pterodactyl/runtime-v8/planning-state.mjs'
import { configureNpcSession } from '../pterodactyl/staging/supervisor-adapter.mjs'

const execFileAsync = promisify(execFile)
const key = 'npc:airi'

function requiredArg(name) {
  const index = process.argv.indexOf(`--${name}`)
  assert.ok(index >= 0 && process.argv[index + 1], `missing --${name}`)
  return process.argv[index + 1]
}

class OneShotRcon {
  constructor({ host, port, password }) {
    this.host = host
    this.port = port
    this.password = password
  }

  async command(command) {
    const { stdout } = await execFileAsync('/usr/bin/python3', [
      '/test/runner/rcon_once.py',
      '--host', this.host,
      '--port', String(this.port),
      '--password', this.password,
      '--command', command,
    ], {
      maxBuffer: 1024 * 1024,
      timeout: 15000,
    })
    return stdout.trim()
  }
}

function operationStatusCommand() {
  return '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))'
}

function actorIronCommand() {
  return '/silent-command local request={kind="inventory_count",item_name="iron-ore",minimum=1}; local result=remote.call("autorio_tools","evaluate_condition",request); rcon.print(helpers.table_to_json({iron=result and result.current or 0,ok=result and result.ok or false}))'
}

async function waitForIdle(rcon, timeoutMs = 15000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = JSON.parse(await rcon.command(operationStatusCommand()))
    if (last.task_state === 'idle' && Number(last.queue_length ?? 0) === 0) return last
    await delay(100)
  }
  throw new Error(`Autorio did not become idle: ${JSON.stringify(last)}`)
}

function checkpoint(itemName, minimum) {
  return {
    mode: 'all',
    requirements: [{
      id: 'inventory_target',
      kind: 'inventory_count',
      item_name: itemName,
      minimum,
    }],
  }
}

function planMessage({
  chatMessage,
  step,
  resourceName = 'iron-ore',
  count = 1,
  minimum = 1,
  roadmap,
  roadmapNodeIds,
  developmentMode,
}) {
  return {
    content: JSON.stringify({
      chatMessage,
      plan: [step],
      currentStep: 0,
      operations: [{
        name: 'gather_resource',
        args: {
          resource_name: resourceName,
          count,
          search_radius: 32,
        },
      }],
      checkpoint: checkpoint(resourceName, minimum),
      ...(roadmap ? { roadmap } : {}),
      ...(roadmapNodeIds ? { roadmapNodeIds } : {}),
      ...(developmentMode ? { developmentMode } : {}),
    }),
  }
}

function steeringAnswer(mode, reasonCode, criticalPath, candidateShelfNodes = []) {
  return {
    answers: {
      development: { choice: mode, confidence: 0.95 },
      steering: {
        choice: mode,
        confidence: 0.95,
        reason_codes: [reasonCode],
        critical_path_summary: criticalPath,
        candidate_shelf_nodes: candidateShelfNodes,
      },
    },
    provider: 'fixture-jev',
    model: 'fixture-steering',
  }
}

function scopeAnswer({ verdict = 'actionable', mode = 'vertical', reasonCodes = [], prefix = 1 } = {}) {
  return {
    answers: {
      scope_review: { choice: verdict, confidence: 0.95 },
      scope_review_reason_codes: { choices: reasonCodes },
      actionable_prefix: { score: prefix },
      step_directions: { choices: [mode] },
    },
    provider: 'fixture-jev',
    model: 'fixture-scope',
  }
}

function makeAgent({
  rcon,
  stateFile,
  memory,
  provider,
  interactionDecisionProvider,
  scopeReviewDecisionProvider,
  steeringDecisionProvider,
}) {
  return new NpcAgentLoop({
    rcon,
    provider,
    interactionDecisionProvider,
    scopeReviewDecisionProvider,
    steeringDecisionProvider,
    systemPrompt: 'real Factorio full planning lifecycle acceptance test',
    stateFile,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    memory,
  })
}

function assertPlannerMode(messages, mode, label) {
  const text = messages.map(message => String(message?.content ?? '')).join('\n')
  assert.match(text, /\[PLANNING_STATE\]/, `${label}: planner did not receive planning state`)
  assert.match(text, new RegExp(`"current_mode":"${mode}"`), `${label}: planner did not receive ${mode} steering`)
  assert.match(text, new RegExp(`"recommended_mode":"${mode}"`), `${label}: planner did not receive Jev ${mode} recommendation provenance`)
}

function nodeById(planning, id) {
  return planning?.roadmap?.nodes?.find(node => node.id === id)
}

async function prepare({ rcon, results, stateFile }) {
  await configureNpcSession(rcon, 'sgluna-factorio-planning-lifecycle-prepare-0001')

  const ironBefore = JSON.parse(await rcon.command(actorIronCommand())).iron
  const roadmap = [
    {
      id: 'acquisition-frontier',
      intent: 'The NPC has demonstrated a working iron acquisition capability.',
      why_it_matters: 'The long-horizon factory needs a verified material acquisition frontier.',
      development_hint: 'vertical',
    },
    {
      id: 'acquisition-support',
      intent: 'The demonstrated acquisition path has enough repeated support for the next push.',
      why_it_matters: 'The next capability should not rest on a one-off acquisition.',
      depends_on: ['acquisition-frontier'],
      development_hint: 'horizontal',
    },
    {
      id: 'next-capability-frontier',
      intent: 'The next capability frontier can be attempted from the supported foundation.',
      why_it_matters: 'This is the next vertical slice on the user goal critical path.',
      depends_on: ['acquisition-support'],
      development_hint: 'vertical',
    },
  ]

  let providerCalls = 0
  let scopeCalls = 0
  let steeringCalls = 0
  const memory = new CanonicalTaskBoardMemory()

  const provider = async (messages) => {
    providerCalls++
    const expectedModes = ['vertical', 'vertical', 'horizontal', 'vertical']
    const expectedMode = expectedModes[providerCalls - 1]
    const durableSteering = memory.planningState(key)?.steering
    assert.equal(
      durableSteering?.current_mode,
      expectedMode,
      `planner call ${providerCalls}: durable steering mismatch before provider context; steeringCalls=${steeringCalls}; steering=${JSON.stringify(durableSteering)}`,
    )
    assertPlannerMode(messages, expectedMode, `planner call ${providerCalls}`)

    if (providerCalls === 1) {
      return planMessage({
        chatMessage: 'Drafting too much of the project in one slice.',
        step: 'Establish iron acquisition and all downstream support in one oversized slice',
        minimum: ironBefore + 1,
        roadmap,
        roadmapNodeIds: ['acquisition-frontier'],
        developmentMode: 'vertical',
      })
    }
    if (providerCalls === 2) {
      return planMessage({
        chatMessage: 'Using the bounded first capability slice.',
        step: 'Demonstrate the first iron acquisition capability',
        minimum: ironBefore + 1,
        roadmapNodeIds: ['acquisition-frontier'],
        developmentMode: 'vertical',
      })
    }
    if (providerCalls === 3) {
      return planMessage({
        chatMessage: 'Strengthening the reached acquisition frontier.',
        step: 'Exercise the iron acquisition path again as supporting capacity',
        minimum: ironBefore + 2,
        roadmapNodeIds: ['acquisition-support'],
        developmentMode: 'horizontal',
      })
    }
    if (providerCalls === 4) {
      return planMessage({
        chatMessage: 'Starting the next vertical frontier slice.',
        step: 'Advance the next capability frontier',
        minimum: ironBefore + 3,
        roadmapNodeIds: ['next-capability-frontier'],
        developmentMode: 'vertical',
      })
    }
    throw new Error(`unexpected prepare provider call ${providerCalls}`)
  }

  let checkpointCalls = 0
  const interactionDecisionProvider = async (_state, questions) => {
    checkpointCalls++
    const hasGroundedCandidate = Boolean(questions?.contract?.criteria?.candidate_1)
    return {
      answers: {
        contract: { choice: hasGroundedCandidate ? 'candidate_1' : 'semantic_unknown', confidence: 0.95 },
        compound_step: { noul: 0.1 },
        step_relation: { choice: 'advances_current', confidence: 0.95 },
        checkpoint_boundary: { choice: hasGroundedCandidate ? 'checkpoint_here' : 'keep_step_open', confidence: 0.95 },
      },
      provider: 'fixture-jev',
      model: 'fixture-checkpoint',
    }
  }

  const scopeReviewDecisionProvider = async () => {
    scopeCalls++
    if (scopeCalls === 1) {
      return scopeAnswer({
        verdict: 'refine',
        mode: 'vertical',
        reasonCodes: ['too_broad'],
        prefix: 0,
      })
    }
    const mode = scopeCalls === 3 ? 'horizontal' : 'vertical'
    return scopeAnswer({ mode })
  }

  const steeringDecisionProvider = async (state, questions) => {
    steeringCalls++
    assert.ok(questions.steering, 'Phase 9 must use the dedicated steering recommendation contract')
    if (steeringCalls === 1) {
      assert.equal(state.boundary, 'goal_admission')
      return steeringAnswer(
        'vertical',
        'goal_requires_new_capability',
        'establish the first verified acquisition frontier',
      )
    }
    if (steeringCalls === 2) {
      assert.equal(state.boundary, 'plan_completed')
      return steeringAnswer(
        'horizontal',
        'power_margin_low',
        'strengthen the reached acquisition frontier before pushing again',
        ['acquisition-support'],
      )
    }
    if (steeringCalls === 3) {
      assert.equal(state.boundary, 'plan_completed')
      return steeringAnswer(
        'vertical',
        'shelf_node_ready_to_refine',
        'advance the next capability frontier from the supported base',
        ['next-capability-frontier'],
      )
    }
    throw new Error(`unexpected steering call ${steeringCalls}`)
  }

  const agent = makeAgent({
    rcon,
    stateFile,
    memory,
    provider,
    interactionDecisionProvider,
    scopeReviewDecisionProvider,
    steeringDecisionProvider,
  })

  const first = await agent.request('Build a staged long-horizon factory through successive capability frontiers.', { sender: 'Louis' })
  assert.equal(providerCalls, 2, 'the first draft must be rejected once and re-authored by the Main LLM')
  assert.equal(scopeCalls, 2)
  assert.equal(first.goalStatus, 'active')
  await waitForIdle(rcon)

  const second = await agent.completed()
  const afterV1 = memory.planningState(key)
  assert.equal(
    providerCalls,
    3,
    `v1 completion must automatically wake the next shelf slice; steeringCalls=${steeringCalls}; checkpointCalls=${checkpointCalls}; scopeCalls=${scopeCalls}; second=${JSON.stringify(second)}; legacy=${JSON.stringify(memory.currentPlan(key))}; planning=${JSON.stringify(afterV1)}`,
  )
  assert.equal(second?.goalStatus, 'active')
  await waitForIdle(rcon)

  const third = await agent.completed()
  assert.equal(providerCalls, 4, 'v2 completion must automatically wake the next vertical shelf slice')
  assert.equal(third?.goalStatus, 'active')
  await waitForIdle(rcon)

  const planning = memory.planningState(key)
  const active = getActivePlan(planning)
  const completedV1 = planning.plans.find(plan =>
    plan.status === PLAN_STATUS.COMPLETED
    && plan.roadmap_node_ids.includes('acquisition-frontier'))
  const completedV2 = planning.plans.find(plan =>
    plan.status === PLAN_STATUS.COMPLETED
    && plan.roadmap_node_ids.includes('acquisition-support'))

  assert.ok(completedV1, 'vertical v1 did not complete')
  assert.ok(completedV2, 'horizontal v2 did not complete')
  assert.ok(active && [PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(active.status), 'v3 must be committed before restart')
  assert.deepEqual(active.roadmap_node_ids, ['next-capability-frontier'])
  assert.equal(completedV1.development_mode, 'vertical')
  assert.equal(completedV2.development_mode, 'horizontal')
  assert.equal(active.development_mode, 'vertical')
  assert.deepEqual(completedV1.steps.map(step => step.description), ['Demonstrate the first iron acquisition capability'])
  assert.deepEqual(completedV2.steps.map(step => step.description), ['Exercise the iron acquisition path again as supporting capacity'])
  assert.deepEqual(active.steps.map(step => step.description), ['Advance the next capability frontier'])
  assert.equal(completedV1.steering_at_draft?.mode, 'vertical')
  assert.equal(completedV2.steering_at_draft?.mode, 'horizontal')
  assert.equal(active.steering_at_draft?.mode, 'vertical')

  assert.equal(nodeById(planning, 'acquisition-frontier')?.status, 'realized')
  assert.equal(nodeById(planning, 'acquisition-support')?.status, 'realized')
  assert.equal(nodeById(planning, 'next-capability-frontier')?.status, 'ready_to_refine')
  assert.equal(planning.goal.status, 'active')
  assert.equal(planning.steering.current_mode, 'vertical')
  assert.deepEqual(
    planning.steering.history.slice(-3).map(entry => entry.mode),
    ['vertical', 'horizontal', 'vertical'],
  )
  assert.equal(steeringCalls, 3)
  assert.equal(scopeCalls, 4)
  assert.equal(checkpointCalls, 4, 'each authored prepare draft uses the live checkpoint-normalization contract')

  const ironAfter = JSON.parse(await rcon.command(actorIronCommand())).iron
  assert.ok(ironAfter >= ironBefore + 3, `real Factorio inventory did not reflect three admitted acquisition slices: before=${ironBefore} after=${ironAfter}`)

  await agent.persistState()
  await fsp.writeFile(path.join(results, 'planning-lifecycle-prepare.json'), JSON.stringify({
    status: 'prepared',
    goal_id: planning.goal.goal_id,
    roadmap_revision_id: planning.roadmap.roadmap_revision_id,
    reasoning_epoch: memory.planningReasoningEpoch(key),
    steering: planning.steering,
    shelf: planning.roadmap.nodes.map(node => ({
      id: node.id,
      status: node.status,
      resolved_by: node.resolved_by,
      verified_results: node.verified_results,
    })),
    completed_v1: completedV1.plan_id,
    completed_v2: completedV2.plan_id,
    active_v3: active.plan_id,
    active_v3_version: active.plan_version,
    plan_count: planning.plans.length,
    iron_before: ironBefore,
    iron_after: ironAfter,
  }, null, 2))

  process.stdout.write(`PASS: real Factorio planning lifecycle reached VERTICAL -> HORIZONTAL -> VERTICAL with v3 committed before restart plan_id=${active.plan_id}\n`)
}

async function verify({ rcon, results, stateFile }) {
  await configureNpcSession(rcon, 'sgluna-factorio-planning-lifecycle-verify-0002')
  const before = JSON.parse(await fsp.readFile(path.join(results, 'planning-lifecycle-prepare.json'), 'utf8'))

  let providerCalls = 0
  let scopeCalls = 0
  const memory = new CanonicalTaskBoardMemory()
  const provider = async (messages) => {
    providerCalls++
    assertPlannerMode(messages, 'vertical', `restored planner call ${providerCalls}`)
    if (providerCalls === 1) {
      return planMessage({
        chatMessage: 'Testing the committed frontier against its now-known structural dependency.',
        step: 'Advance the next capability frontier',
        resourceName: 'sgluna-missing-resource',
        roadmapNodeIds: ['next-capability-frontier'],
        developmentMode: 'vertical',
      })
    }
    if (providerCalls === 2) {
      return planMessage({
        chatMessage: 'Following the user-approved bounded alternate route.',
        step: 'Use the verified iron route while the unavailable frontier dependency is reconsidered',
        minimum: before.iron_after + 1,
        roadmapNodeIds: ['next-capability-frontier'],
        developmentMode: 'vertical',
      })
    }
    throw new Error(`unexpected verify provider call ${providerCalls}`)
  }

  let checkpointCalls = 0
  const interactionDecisionProvider = async (_state, questions) => {
    checkpointCalls++
    const hasGroundedCandidate = Boolean(questions?.contract?.criteria?.candidate_1)
    return {
      answers: {
        contract: { choice: hasGroundedCandidate ? 'candidate_1' : 'semantic_unknown', confidence: 0.95 },
        compound_step: { noul: 0.1 },
        step_relation: { choice: 'advances_current', confidence: 0.95 },
        checkpoint_boundary: { choice: hasGroundedCandidate ? 'checkpoint_here' : 'keep_step_open', confidence: 0.95 },
      },
      provider: 'fixture-jev',
      model: 'fixture-checkpoint',
    }
  }

  const scopeReviewDecisionProvider = async () => {
    scopeCalls++
    return scopeAnswer({ mode: 'vertical' })
  }

  const agent = makeAgent({
    rcon,
    stateFile,
    memory,
    provider,
    interactionDecisionProvider,
    scopeReviewDecisionProvider,
    steeringDecisionProvider: async () => {
      throw new Error('restoring or blocking an in-flight plan must not invent a new steering boundary')
    },
  })

  const persistedSnapshot = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
  const persistedPlanning = (persistedSnapshot.planning_states ?? []).find(item => item?.key === key)?.state
  assert.equal(
    persistedPlanning?.active_plan_id,
    before.active_v3,
    `persisted lifecycle snapshot drifted before restore; expected=${before.active_v3}; active=${persistedPlanning?.active_plan_id}; plans=${JSON.stringify((persistedPlanning?.plans ?? []).map(plan => ({ id: plan.plan_id, status: plan.status })))}`,
  )

  await agent.loadPersistentState()
  let planning = memory.planningState(key)
  const active = getActivePlan(planning)
  assert.equal(
    active?.plan_id,
    persistedPlanning?.active_plan_id,
    `restore changed authoritative active plan identity; persisted=${persistedPlanning?.active_plan_id}; restored=${active?.plan_id}; persistedPlans=${JSON.stringify((persistedPlanning?.plans ?? []).map(plan => ({ id: plan.plan_id, status: plan.status })))}; restoredPlans=${JSON.stringify((planning?.plans ?? []).map(plan => ({ id: plan.plan_id, status: plan.status })))}`,
  )
  assert.equal(providerCalls, 0, 'restore itself must not wake the Main LLM')
  assert.equal(planning.goal.goal_id, before.goal_id)
  assert.equal(planning.goal.status, 'active')
  assert.equal(planning.roadmap.roadmap_revision_id, before.roadmap_revision_id)
  assert.equal(active.plan_id, before.active_v3)
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(active.status))
  assert.equal(planning.steering.current_mode, 'vertical')
  assert.deepEqual(
    planning.steering.history.slice(-3).map(entry => entry.mode),
    ['vertical', 'horizontal', 'vertical'],
  )
  assert.equal(nodeById(planning, 'acquisition-frontier')?.status, 'realized')
  assert.equal(nodeById(planning, 'acquisition-support')?.status, 'realized')
  assert.equal(nodeById(planning, 'next-capability-frontier')?.status, 'ready_to_refine')

  const blockedResult = await agent.request('continue', { sender: 'Louis' })
  planning = memory.planningState(key)
  const blocked = getActivePlan(planning)
  assert.equal(providerCalls, 1)
  assert.equal(blockedResult.goalStatus, 'blocked')
  assert.equal(blockedResult.operations.length, 0)
  assert.equal(
    blocked.plan_id,
    before.active_v3,
    `blocker request replaced committed v3 unexpectedly; expected=${before.active_v3}; blocked=${blocked.plan_id}; blockedResult=${JSON.stringify(blockedResult)}; legacy=${JSON.stringify(memory.currentPlan(key))}; plans=${JSON.stringify(planning.plans.map(plan => ({
      id: plan.plan_id,
      status: plan.status,
      origin: plan.origin,
      derived_from: plan.derived_from_plan_id,
      superseded_by: plan.superseded_by_plan_id,
      steps: plan.steps.map(step => step.description),
      roadmap_node_ids: plan.roadmap_node_ids,
    })))}`,
  )
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(blocked.blocker?.reason_code, 'operation_preflight_failed:unknown_prototype')
  assert.equal(planning.plans.length, before.plan_count, 'structural blocker must not create an automatic suffix')
  assert.equal(planning.goal.goal_id, before.goal_id)
  assert.equal(planning.roadmap.roadmap_revision_id, before.roadmap_revision_id)
  assert.equal(planning.steering.current_mode, 'vertical')

  memory.recordBlockedChoice(key, 'revise', 'Louis', { now: Date.now() })
  await agent.persistState()
  assert.equal(getActivePlan(memory.planningState(key)).blocker?.user_choice?.choice, 'revise')

  const revisedResult = await agent.request(
    'Use the verified iron acquisition route as the bounded alternate while we reconsider the unavailable frontier dependency.',
    { sender: 'Louis' },
  )
  planning = memory.planningState(key)
  const successor = getActivePlan(planning)

  assert.equal(providerCalls, 2)
  assert.equal(scopeCalls, 1, 'the user-approved successor still passes Jev pre-commit scope review')
  assert.equal(revisedResult.goalStatus, 'active')
  assert.equal(successor.derived_from_plan_id, before.active_v3)
  assert.equal(successor.plan_version, before.active_v3_version + 1)
  assert.deepEqual(successor.roadmap_node_ids, ['next-capability-frontier'])
  assert.equal(successor.development_mode, 'vertical')
  assert.equal(planning.goal.goal_id, before.goal_id)
  assert.equal(planning.goal.status, 'active')
  assert.equal(planning.roadmap.roadmap_revision_id, before.roadmap_revision_id)
  assert.equal(planning.steering.current_mode, 'vertical')
  assert.deepEqual(
    planning.steering.history.slice(-3).map(entry => entry.mode),
    ['vertical', 'horizontal', 'vertical'],
  )
  assert.equal(nodeById(planning, 'acquisition-frontier')?.status, 'realized')
  assert.equal(nodeById(planning, 'acquisition-support')?.status, 'realized')
  assert.equal(memory.planningReasoningEpoch(key) > before.reasoning_epoch, true, 'explicit user revision must invalidate predecessor reasoning')

  await waitForIdle(rcon)
  await agent.persistState()
  await fsp.writeFile(path.join(results, 'planning-lifecycle-verify.json'), JSON.stringify({
    status: 'pass',
    goal_id: planning.goal.goal_id,
    predecessor_plan_id: before.active_v3,
    successor_plan_id: successor.plan_id,
    successor_version: successor.plan_version,
    steering_modes: planning.steering.history.slice(-3).map(entry => entry.mode),
    roadmap_revision_id: planning.roadmap.roadmap_revision_id,
    provider_calls: providerCalls,
    checkpoint_calls: checkpointCalls,
    scope_calls: scopeCalls,
  }, null, 2))

  process.stdout.write(`PASS: full planning lifecycle survived real Factorio restart, froze on structural blocker, and resumed only through explicit user successor=${successor.plan_id}\n`)
}

async function main() {
  const mode = requiredArg('mode')
  const host = requiredArg('host')
  const port = Number(requiredArg('port'))
  const password = requiredArg('password')
  const results = path.resolve(requiredArg('results'))
  assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536, 'invalid --port')
  assert.ok(mode === 'prepare' || mode === 'verify', 'mode must be prepare or verify')

  await fsp.mkdir(results, { recursive: true })
  const stateFile = path.join(results, 'planning-lifecycle-state.json')
  const rcon = new OneShotRcon({ host, port, password })

  if (mode === 'prepare') await prepare({ rcon, results, stateFile })
  else await verify({ rcon, results, stateFile })
}

main().catch(async (error) => {
  const resultsIndex = process.argv.indexOf('--results')
  if (resultsIndex >= 0 && process.argv[resultsIndex + 1]) {
    const results = path.resolve(process.argv[resultsIndex + 1])
    await fsp.mkdir(results, { recursive: true }).catch(() => {})
    await fsp.writeFile(
      path.join(results, 'planning-lifecycle-factorio-error.txt'),
      `${error?.stack ?? error}\n`,
    ).catch(() => {})
  }
  console.error(error)
  process.exitCode = 1
})
