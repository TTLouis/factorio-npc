import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import {
  DEADLOCK_EVIDENCE_STALL_BATCHES,
  DEADLOCK_REPEATED_FAILURE_LIMIT,
  DEADLOCK_SIGNAL_KIND,
  getActivePlan,
  PLAN_STATUS,
  planTrackerView,
} from './planning-state.mjs'

function deployment() {
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
  }
}

class RejectingPreflightRcon {
  constructor() {
    this.mutations = []
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      return JSON.stringify({
        ok: false,
        code: 'missing_runtime_capability',
        operation: 'craft_item',
        detail: 'required deterministic capability is unavailable',
      })
    }
    if (text.includes('local ok,result=pcall')) {
      this.mutations.push(text)
      throw new Error('mutation must not be admitted after failed preflight')
    }
    return '{}'
  }
}

function proposedPlan(steps, currentStep = 0) {
  return {
    chatMessage: 'Working on the durable plan.',
    plan: steps,
    currentStep,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  }
}

// A plan only commits on a real Jev scope review plus a real preflight result.
// Tests that need a committed plan state that review explicitly rather than
// relying on a default, because there is deliberately no longer a default.
const REVIEWED_ACTIONABLE = Object.freeze({
  verdict: 'actionable',
  reason_codes: [],
  confidence: 0.9,
  runtime_validation: { passed: true },
})

function startCommittedPlan(memory, key = 'npc:airi') {
  const request = { sender: 'Louis', text: 'Build early automation' }
  const plan = proposedPlan(['Gather stone', 'Craft furnace', 'Build power'])
  const recorded = memory.recordPlan(key, request, plan)
  const reconciled = memory.reconcileTaskBoard(key, undefined, plan, recorded, { allowReplan: false })
  memory.commitPlanningPlan(key, { now: 100, review: REVIEWED_ACTIONABLE })
  return { request, plan, state: reconciled.state }
}

function block(memory, key = 'npc:airi') {
  return memory.applyOutcomeAuthority(key, {
    kind: 'world_blocked',
    source: 'deterministic_runtime',
    reason_code: 'operation_preflight_failed:missing_dependency',
    candidate_blocker: 'operation_preflight_failed:missing_dependency',
    evidence: [{
      kind: 'operation_preflight_blocker',
      ref: 'preflight_missing_dependency',
      summary: 'Required dependency cannot be satisfied by the committed route.',
    }],
  }).state
}

test('live coordinator turns deterministic preflight rejection into reducer BLOCKED with no mutation', async () => {
  const rcon = new RejectingPreflightRcon()
  const memory = new CanonicalTaskBoardMemory()
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async () => ({
      content: JSON.stringify({
        chatMessage: 'Crafting the first furnace.',
        plan: ['Craft the first furnace', 'Place the furnace'],
        currentStep: 0,
        operations: [{ name: 'craft_item', args: { item_name: 'stone-furnace', count: 1 } }],
      }),
    }),
    systemPrompt: 'planning preflight integration test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })

  const result = await agent.request('build the first furnace', { sender: 'Louis' })
  const planning = memory.planningState('npc:airi')
  const blocked = getActivePlan(planning)

  assert.equal(result.goalStatus, 'blocked')
  assert.equal(result.operations.length, 0)
  assert.equal(rcon.mutations.length, 0)
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(blocked.blocker.reason_code, 'operation_preflight_failed:missing_runtime_capability')
  assert.equal(blocked.blocker.evidence_refs.length, 1)
  assert.equal(planning.plans.length, 1, 'preflight failure must freeze rather than auto-create a suffix plan')
})

test('live planning state survives restart BLOCKED and requires explicit revision before successor', () => {
  const key = 'npc:airi'
  const beforeRestart = new CanonicalTaskBoardMemory()
  startCommittedPlan(beforeRestart, key)
  block(beforeRestart, key)

  const blockedBefore = getActivePlan(beforeRestart.planningState(key))
  const blockedEpoch = beforeRestart.planningReasoningEpoch(key)
  assert.equal(blockedBefore.status, PLAN_STATUS.BLOCKED)
  assert.equal(beforeRestart.planningState(key).plans.length, 1)

  const afterRestart = new CanonicalTaskBoardMemory()
  afterRestart.restore(JSON.parse(JSON.stringify(beforeRestart.snapshot())))

  const blockedAfter = getActivePlan(afterRestart.planningState(key))
  assert.equal(blockedAfter.status, PLAN_STATUS.BLOCKED)
  assert.equal(afterRestart.currentPlan(key).status, 'blocked')
  assert.equal(afterRestart.planningState(key).plans.length, 1)
  assert.equal(afterRestart.currentPlan(key).planning.blocked.awaiting_choice, true)
  assert.equal(afterRestart.planningReasoningEpoch(key), blockedEpoch, 'restart must preserve the reducer reasoning epoch')

  // A normal provider continuation cannot thaw BLOCKED or replace the suffix.
  const ordinary = proposedPlan(['Gather stone', 'Craft furnace differently', 'Build power'], 1)
  const previousBoard = afterRestart.currentPlan(key).task_board
  const ordinaryRecorded = afterRestart.recordPlan(key, {
    sender: 'Louis',
    text: 'continue',
  }, ordinary, { continuation: true })
  const ordinaryReconciled = afterRestart.reconcileTaskBoard(
    key,
    previousBoard,
    ordinary,
    ordinaryRecorded,
    { previousState: afterRestart.currentPlan(key), allowReplan: false },
  )
  assert.equal(ordinaryReconciled.blockedByHarness, true)
  assert.equal(getActivePlan(afterRestart.planningState(key)).plan_id, blockedAfter.plan_id)
  assert.equal(afterRestart.planningState(key).plans.length, 1)

  // The explicit UI choice records intent only; it still creates no successor.
  afterRestart.recordBlockedChoice(key, 'revise', 'Louis', { now: 200 })
  assert.equal(afterRestart.planningState(key).plans.length, 1)
  assert.equal(getActivePlan(afterRestart.planningState(key)).status, PLAN_STATUS.BLOCKED)

  // The following user-authored revision supplies the actual replacement.
  const revisedPlan = proposedPlan(['Gather stone', 'Use alternate furnace route', 'Build power'], 1)
  const revisedRecorded = afterRestart.recordPlan(key, {
    sender: 'Louis',
    text: 'Use the alternate furnace route instead.',
  }, revisedPlan)
  const revised = afterRestart.reconcileTaskBoard(
    key,
    previousBoard,
    revisedPlan,
    revisedRecorded,
    { previousState: ordinaryReconciled.state, allowReplan: false },
  )
  const successor = getActivePlan(afterRestart.planningState(key))

  assert.equal(revisedRecorded.userRevisionApproved, true)
  assert.equal(successor.status, PLAN_STATUS.DRAFT)
  assert.equal(successor.plan_version, blockedAfter.plan_version + 1)
  assert.equal(successor.derived_from_plan_id, blockedAfter.plan_id)
  assert.ok(afterRestart.planningReasoningEpoch(key) > blockedEpoch, 'user-approved successor must invalidate predecessor reasoning')
  assert.equal(afterRestart.planningState(key).plans.length, 2)
  assert.equal(revised.state.status, 'active')
  assert.equal(revised.blockedByHarness, false)
})

test('blocked cancel choice remains frozen until terminate emits PLAN_CANCELLED', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory, key)
  block(memory, key)

  memory.recordBlockedChoice(key, 'cancel', 'Louis', { now: 300 })
  const stillBlocked = getActivePlan(memory.planningState(key))
  assert.equal(stillBlocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(stillBlocked.blocker.user_choice.choice, 'cancel')
  assert.ok(memory.currentPlan(key), 'cancel choice alone must not destructively clear durable state')

  memory.terminatePlan(key)
  const cancelled = getActivePlan(memory.planningState(key))
  assert.equal(cancelled.status, PLAN_STATUS.CANCELLED)
  assert.equal(memory.currentPlan(key), undefined)
})

test('real state-file restart preserves BLOCKED, successor lineage, and reasoning epoch', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-planning-restart-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const stateFile = path.join(root, 'npc-state.json')
  const key = 'npc:airi'
  const makeAgent = () => new NpcAgentLoop({
    rcon: { command: async () => '{}' },
    provider: async () => { throw new Error('provider must not run in persistence test') },
    systemPrompt: 'planning persistence integration test',
    stateFile,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    memory: new CanonicalTaskBoardMemory(),
  })

  const first = makeAgent()
  startCommittedPlan(first.memory, key)
  block(first.memory, key)
  const blocked = getActivePlan(first.memory.planningState(key))
  const blockedEpoch = first.memory.planningReasoningEpoch(key)
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED)
  await first.persistState()

  const restarted = makeAgent()
  await restarted.loadPersistentState()
  const restoredBlocked = getActivePlan(restarted.memory.planningState(key))
  assert.equal(restoredBlocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(restoredBlocked.plan_id, blocked.plan_id)
  assert.equal(restarted.memory.planningReasoningEpoch(key), blockedEpoch)
  assert.equal(restarted.memory.currentPlan(key).planning.blocked.awaiting_choice, true)

  restarted.memory.recordBlockedChoice(key, 'revise', 'Louis', { now: 400 })
  const revisedPlan = proposedPlan(['Gather stone', 'Use alternate furnace route', 'Build power'], 1)
  const previousBoard = restarted.memory.currentPlan(key).task_board
  const recorded = restarted.memory.recordPlan(key, {
    sender: 'Louis',
    text: 'Use the alternate furnace route instead.',
  }, revisedPlan)
  restarted.memory.reconcileTaskBoard(
    key,
    previousBoard,
    revisedPlan,
    recorded,
    { previousState: restarted.memory.currentPlan(key), allowReplan: false },
  )
  const successor = getActivePlan(restarted.memory.planningState(key))
  const successorEpoch = restarted.memory.planningReasoningEpoch(key)
  assert.equal(recorded.userRevisionApproved, true)
  assert.equal(successor.derived_from_plan_id, blocked.plan_id)
  assert.equal(successor.plan_version, blocked.plan_version + 1)
  assert.ok(successorEpoch > blockedEpoch)
  await restarted.persistState()

  const restartedAgain = makeAgent()
  await restartedAgain.loadPersistentState()
  const restoredSuccessor = getActivePlan(restartedAgain.memory.planningState(key))
  assert.equal(restoredSuccessor.plan_id, successor.plan_id)
  assert.equal(restoredSuccessor.derived_from_plan_id, blocked.plan_id)
  assert.equal(restartedAgain.memory.planningReasoningEpoch(key), successorEpoch)
})


test('the harness evaluates steering at goal admission, without the model asking', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory, key)

  const steering = memory.planningState(key).steering
  assert.ok(steering, 'admitting a goal is a boundary; steering runs whether or not anyone requested it')
  assert.equal(steering.boundary, 'goal_admission')
  assert.equal(steering.authority, 'runtime', 'the harness is the authority, never the model')
  assert.equal(steering.sequence, 1)

  // Drafting again is not a boundary: the sequence must not inflate.
  memory.ensurePlanningDraft(key, memory.currentPlan(key), { now: 150 })
  assert.equal(memory.planningState(key).steering.sequence, 1)
})

test('the harness evaluates steering when a plan completes, carrying jev advice as provenance only', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory, key)

  // Jev advises; the advice is stored, never applied on its own.
  memory.recordSteeringAdvice(key, {
    recommended_mode: 'horizontal',
    confidence: 0.9,
    pressure: { horizontal: ['power_margin_low', 'a hunch about belts'] },
    reason_codes: ['frontier_reached'],
    recommended_by: 'jev',
  })
  assert.equal(
    memory.planningState(key).steering.recommendation.recommended_mode,
    null,
    'advice alone changes nothing',
  )

  // Drive the REAL completion path: outcome authority, one step at a time,
  // exactly as the running loop does. Nothing here asks for steering.
  const planId = getActivePlan(memory.planningState(key)).plan_id
  const stepCount = getActivePlan(memory.planningState(key)).steps.length
  for (let index = 0; index < stepCount; index += 1) {
    memory.applyOutcomeAuthority(key, {
      kind: 'verified_complete',
      source: 'deterministic_runtime',
      reason_code: 'step_verified',
      evidence: [{
        kind: 'verified_world_state',
        ref: `verified_step_${index}`,
        summary: 'step outcome verified against world state',
      }],
    })
  }

  const planning = memory.planningState(key)
  const completed = planning.plans.find(item => item.plan_id === planId)
  assert.equal(completed.status, PLAN_STATUS.COMPLETED, 'the slice actually finished')

  const steering = planning.steering
  assert.equal(steering.boundary, 'plan_completed', 'the harness reached the boundary on its own')
  assert.equal(steering.authority, 'runtime')
  assert.equal(steering.last_plan_id, planId)
  assert.equal(steering.recommendation.recommended_by, 'jev', 'advice is provenance, not authority')
  assert.equal(steering.recommendation.recommended_mode, 'horizontal')

  // Grounded pressure survives; the hunch does not, and says so.
  assert.deepEqual(steering.pressure.horizontal, ['power_margin_low'])
  assert.deepEqual(steering.dropped_pressure, ['a hunch about belts'])

  // Advice is written for one boundary and is consumed by it.
  assert.equal(memory.steeringAdviceByNpc.get(key), undefined)
})

test('a boundary the harness has no authority for is refused, not forged', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory, key)
  const before = memory.planningState(key).steering.sequence

  // The reducer requires user authority for these two, and the harness does
  // not have it. The emitter must decline rather than claim to be the user.
  for (const boundary of ['user_revision_approved', 'user_priority_change']) {
    assert.equal(memory.evaluateSteeringAtBoundary(key, { boundary, now: 500 }), undefined)
  }
  assert.equal(memory.planningState(key).steering.sequence, before)
})

test('repeated live failures reach the deterministic deadlock signal and stop for the user', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory, key)
  const planId = getActivePlan(memory.planningState(key)).plan_id

  // The same recoverable failure, over and over, on the same committed step.
  // Nothing here evaluates anything: the harness counts attempts, and the
  // deterministic signal is what notices.
  const failure = () => memory.applyOutcomeAuthority(key, {
    kind: 'recoverable_provider_failure',
    source: 'deterministic_runtime',
    reason_code: 'operation_rejected_by_preflight',
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  })

  for (let attempt = 1; attempt < DEADLOCK_REPEATED_FAILURE_LIMIT; attempt += 1) {
    failure()
    const plan = getActivePlan(memory.planningState(key))
    assert.notEqual(plan.status, PLAN_STATUS.BLOCKED, `attempt ${attempt} is not yet a deadlock`)
  }

  failure()
  const blocked = getActivePlan(memory.planningState(key))
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED, 'the repeating failure limit is reached')
  assert.equal(blocked.blocker.kind, 'deadlock')
  assert.equal(blocked.blocker.requires_user_decision, true, 'a deadlock asks the user; it never replans itself')
  assert.equal(blocked.blocker.signals[0].kind, 'repeating_failure')
  assert.equal(blocked.plan_id, planId, 'no successor was invented')
  assert.equal(memory.planningState(key).plans.length, 1)

  // And the player can actually see it.
  assert.equal(memory.currentPlan(key).planning.blocked.awaiting_choice, true)
})

test('an evidence stall deadlocks even when every batch reports success', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()

  // The evidence-stall signal reads a contract: it measures batches that fail
  // to advance one, so a prose-only step is invisible to it by design and gets
  // the operation ceiling as its backstop instead. The contract has to be in
  // place BEFORE the commit -- a committed plan is immutable.
  const plan = proposedPlan(['Gather stone', 'Craft furnace', 'Build power'])
  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'Build early automation' }, plan)
  const reconciled = memory.reconcileTaskBoard(key, undefined, plan, recorded, { allowReplan: false })
  memory.setStepCompletionContract(key, reconciled.state.task_board.steps[0].id, {
    mode: 'all',
    confidence: 0.9,
    requirements: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 20 }],
  })
  memory.commitPlanningPlan(key, { now: 120, review: REVIEWED_ACTIONABLE })
  assert.ok(
    getActivePlan(memory.planningState(key)).steps[0].completion_contract,
    'the committed step carries the contract the stall signal reads',
  )

  // Batches keep being submitted and keep being accepted, but no step evidence
  // ever lands. This is the failure mode that looks healthiest from inside.
  for (let attempt = 0; attempt < DEADLOCK_EVIDENCE_STALL_BATCHES; attempt += 1) {
    memory.applyOutcomeAuthority(key, {
      kind: 'execution_required',
      source: 'deterministic_runtime',
      reason_code: 'operations_submitted',
      operations: [{ name: 'wait', args: { ticks: 1 } }],
    })
  }

  const blocked = getActivePlan(memory.planningState(key))
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(blocked.blocker.kind, 'deadlock')
  assert.equal(blocked.blocker.signals[0].kind, 'evidence_stall')
})

test('successful batches do not accumulate toward a deadlock', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory, key)

  let completedSteps = 0
  // Interleave attempts with real verified evidence. The stall counter resets
  // on evidence, so healthy work must never trip the signal however long it
  // runs -- otherwise the harness would punish slow steps.
  for (let round = 0; round < DEADLOCK_EVIDENCE_STALL_BATCHES * 2; round += 1) {
    memory.applyOutcomeAuthority(key, {
      kind: 'execution_required',
      source: 'deterministic_runtime',
      reason_code: 'operations_submitted',
      operations: [{ name: 'wait', args: { ticks: 1 } }],
    })
    memory.applyOutcomeAuthority(key, {
      kind: 'verified_complete',
      source: 'deterministic_runtime',
      reason_code: 'step_verified',
      evidence: [{ kind: 'verified_world_state', ref: `verified_${round}`, summary: 'progress' }],
    })
    // Checked every round, not just at the end: once the plan finishes its
    // planning state is retired, so a late-only assertion would pass vacuously.
    const planning = memory.planningState(key)
    // Once the plan finishes, its planning state is retired -- reaching that
    // point is itself proof the run was healthy.
    if (!planning) {
      completedSteps = Infinity
      break
    }
    // Step completion lives in execution.step_progress, not on the step.
    for (const item of planning.plans) {
      const progress = Object.values(item.execution?.step_progress ?? {})
      completedSteps = Math.max(completedSteps, progress.filter(entry => entry.status === 'completed').length)
      if (item.status === PLAN_STATUS.COMPLETED) completedSteps = Math.max(completedSteps, 1)
    }
    assert.equal(
      planning.plans.some(item => item.status === PLAN_STATUS.BLOCKED),
      false,
      `round ${round}: evidence keeps resetting the stall counter`,
    )
    if (memory.currentPlan(key)?.status !== 'active') break
  }

  // Non-vacuous: the run has to have actually moved, or "never blocked" would
  // be satisfied by a plan that did nothing at all.
  assert.ok(completedSteps > 0, 'verified evidence advanced the plan while batches accumulated')
})

test('a draft cannot commit without a jev scope review', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  const plan = proposedPlan(['Gather stone', 'Craft furnace', 'Build power'])
  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'Build early automation' }, plan)
  memory.reconcileTaskBoard(key, undefined, plan, recorded, { allowReplan: false })

  // Silence is not consent. This used to commit, because the adapter supplied
  // jev_verdict: 'actionable' as a literal.
  memory.commitPlanningPlan(key, { now: 100 })
  assert.equal(getActivePlan(memory.planningState(key)).status, PLAN_STATUS.DRAFT)

  // Neither is a refusal.
  for (const verdict of ['refine', 'needs_grounding', 'needs_user_clarification']) {
    memory.commitPlanningPlan(key, {
      now: 110,
      review: { verdict, reason_codes: ['mixed_outcomes'], confidence: 0.8, runtime_validation: { passed: true } },
    })
    // A reviewed-and-refused plan legitimately sits in JEV_REVIEW; what matters
    // is that it is not admitted.
    assert.notEqual(
      getActivePlan(memory.planningState(key)).status,
      PLAN_STATUS.COMMITTED,
      `${verdict} must not admit the draft`,
    )
  }

  // Nor an actionable verdict whose runtime validation failed.
  memory.commitPlanningPlan(key, {
    now: 120,
    review: { verdict: 'actionable', reason_codes: [], confidence: 0.9, runtime_validation: { passed: false } },
  })
  assert.notEqual(getActivePlan(memory.planningState(key)).status, PLAN_STATUS.COMMITTED)

  // Both gates satisfied, and only then.
  memory.commitPlanningPlan(key, { now: 130, review: REVIEWED_ACTIONABLE })
  const committed = getActivePlan(memory.planningState(key))
  assert.equal(committed.status, PLAN_STATUS.COMMITTED)
  assert.equal(committed.jev_review.last_verdict, 'actionable')
})

test('execution cannot admit its own plan retroactively', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  const plan = proposedPlan(['Gather stone', 'Craft furnace', 'Build power'])
  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'Build early automation' }, plan)
  memory.reconcileTaskBoard(key, undefined, plan, recorded, { allowReplan: false })
  assert.equal(getActivePlan(memory.planningState(key)).status, PLAN_STATUS.DRAFT)

  // Outcomes arriving against an unreviewed draft used to force it committed so
  // they had somewhere to record themselves.
  memory.applyOutcomeAuthority(key, {
    kind: 'verified_complete',
    source: 'deterministic_runtime',
    reason_code: 'step_verified',
    evidence: [{ kind: 'verified_world_state', ref: 'verified_0', summary: 'done' }],
  })
  const after = getActivePlan(memory.planningState(key))
  assert.equal(after.status, PLAN_STATUS.DRAFT, 'an outcome is not an admission')
  assert.equal(
    Object.values(after.execution.step_progress).filter(entry => entry.status === 'completed').length,
    0,
    'and it records no progress against unadmitted work',
  )
})

// --- CONTRACT_PROVEN_UNSATISFIABLE / PLANNER_FOCUS_PROPOSED ----------------
//
// Both events had reducer handlers and reducer tests and no live emitter, so
// the reducer tests proved the handlers correct while nothing ever called them.
// These tests therefore drive the ADAPTER, never `applyPlanningEvent` directly.

function committedPlanWithExactContract(memory, key = 'npc:airi', { mode = 'all', unitNumber = 4412 } = {}) {
  const plan = proposedPlan(['Refuel the stone furnace', 'Craft gears', 'Build power'])
  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'Keep the furnace fed' }, plan)
  const reconciled = memory.reconcileTaskBoard(key, undefined, plan, recorded, { allowReplan: false })
  const stepId = reconciled.state.task_board.steps[0].id
  memory.setStepCompletionContract(key, stepId, {
    mode,
    confidence: 0.9,
    requirements: mode === 'any'
      ? [
          { id: 'furnace_fuel', kind: 'entity_inventory_count', unit_number: unitNumber, item_name: 'coal', minimum: 5 },
          { id: 'furnace_alive', kind: 'entity_exists', unit_number: unitNumber + 1 },
        ]
      : [{ id: 'furnace_fuel', kind: 'entity_inventory_count', unit_number: unitNumber, item_name: 'coal', minimum: 5 }],
  }, { now: 90 })
  memory.commitPlanningPlan(key, { now: 100, review: REVIEWED_ACTIONABLE })
  return { plan, state: memory.currentPlan(key) }
}

// The exact evidence `npc-agent-loop` records on the recoverable preflight path.
function staleExactTargetEvidence(unitNumber, ref = 'request/stale_exact_target') {
  return {
    kind: 'operation_preflight_recoverable',
    ref,
    summary: JSON.stringify({
      code: 'stale_exact_target',
      operation_index: 0,
      operation: 'move_items_exact',
      identity: unitNumber,
      last_observed: { name: 'stone-furnace', position: { x: 12, y: -4 } },
    }),
  }
}

test('live board evidence proves a contract unsatisfiable and the deadlock signal blocks the plan', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  committedPlanWithExactContract(memory, key, { unitNumber: 4412 })

  const before = getActivePlan(memory.planningState(key))
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(before.status))
  const stepId = before.steps[before.active_step_index].step_id
  assert.equal(before.execution.step_progress[stepId]?.unsatisfiable ?? null, null, 'nothing is proven impossible yet')
  const plansBefore = memory.planningState(key).plans.length

  // The game destroyed the furnace. This is the only input the test gives.
  memory.recordBoardEvidence(key, staleExactTargetEvidence(4412))

  const after = getActivePlan(memory.planningState(key))
  const progress = after.execution.step_progress[stepId]

  // (1) the event reached the reducer from the live path
  assert.ok(progress.unsatisfiable, 'CONTRACT_PROVEN_UNSATISFIABLE must have been emitted live')
  assert.match(progress.unsatisfiable.reason, /4412/)
  assert.equal(progress.unsatisfiable.proof_ref, 'request/stale_exact_target')

  // (2) the deterministic deadlock signal that reads it actually fired
  assert.equal(after.status, PLAN_STATUS.BLOCKED)
  assert.equal(after.blocker.kind, 'deadlock')
  assert.equal(after.blocker.reason_code, DEADLOCK_SIGNAL_KIND.UNSATISFIABLE_CONTRACT)
  assert.ok(after.blocker.signals.some(signal => signal.kind === DEADLOCK_SIGNAL_KIND.UNSATISFIABLE_CONTRACT))

  // (3) and it freezes for the user rather than replanning itself
  assert.equal(after.blocker.requires_user_decision, true)
  assert.equal(memory.planningState(key).plans.length, plansBefore, 'a proven-impossible contract must not auto-create a successor')
  assert.equal(memory.currentPlan(key).status, 'blocked')
})

test('a stale identity the contract does not name proves nothing', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  committedPlanWithExactContract(memory, key, { unitNumber: 4412 })

  memory.recordBoardEvidence(key, staleExactTargetEvidence(9999))

  const after = getActivePlan(memory.planningState(key))
  const stepId = after.steps[after.active_step_index].step_id
  assert.equal(after.execution.step_progress[stepId]?.unsatisfiable ?? null, null)
  assert.notEqual(after.status, PLAN_STATUS.BLOCKED, 'an unrelated destroyed entity is not a proof about this contract')
})

test('an any-mode contract survives until every branch identity is destroyed', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  committedPlanWithExactContract(memory, key, { mode: 'any', unitNumber: 4412 })
  const stepId = getActivePlan(memory.planningState(key)).steps[0].step_id

  // One dead branch leaves the other reachable, so the contract is still live.
  memory.recordBoardEvidence(key, staleExactTargetEvidence(4412, 'request/stale_a'))
  const midway = getActivePlan(memory.planningState(key))
  assert.equal(midway.execution.step_progress[stepId]?.unsatisfiable ?? null, null)
  assert.notEqual(midway.status, PLAN_STATUS.BLOCKED)

  // The second proof kills the last branch, and only now is it impossible.
  memory.recordBoardEvidence(key, staleExactTargetEvidence(4413, 'request/stale_b'))
  const after = getActivePlan(memory.planningState(key))
  assert.ok(after.execution.step_progress[stepId].unsatisfiable)
  assert.equal(after.status, PLAN_STATUS.BLOCKED)
  assert.equal(after.blocker.reason_code, DEADLOCK_SIGNAL_KIND.UNSATISFIABLE_CONTRACT)
})

test('repeated failures alone never prove a contract unsatisfiable', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  committedPlanWithExactContract(memory, key, { unitNumber: 4412 })
  const stepId = getActivePlan(memory.planningState(key)).steps[0].step_id

  for (let index = 0; index < DEADLOCK_REPEATED_FAILURE_LIMIT + 2; index++) {
    memory.applyOutcomeAuthority(key, {
      kind: 'recoverable_provider_failure',
      source: 'deterministic_runtime',
      reason_code: 'transfer_failed:full',
      evidence: [],
    })
  }

  const after = getActivePlan(memory.planningState(key))
  // It may well be deadlocked -- by the repeating-failure signal. It must not
  // be deadlocked by a contract it never proved impossible.
  assert.equal(after.execution.step_progress[stepId]?.unsatisfiable ?? null, null)
  assert.ok(
    !(after.blocker?.signals ?? []).some(signal => signal.kind === DEADLOCK_SIGNAL_KIND.UNSATISFIABLE_CONTRACT),
    'N failures is the repeating-failure signal, never an impossibility proof',
  )
})

test('planner focus reaches the reducer and still cannot advance or complete a step', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  const plan = proposedPlan(['Gather stone', 'Craft furnace', 'Build power'], 0)
  const recorded = memory.recordPlan(key, { sender: 'Louis', text: 'Build early automation' }, plan)
  const reconciled = memory.reconcileTaskBoard(key, undefined, plan, recorded, { allowReplan: false })
  memory.commitPlanningPlan(key, { now: 100, review: REVIEWED_ACTIONABLE })

  const before = getActivePlan(memory.planningState(key))
  assert.equal(before.active_step_index, 0)

  // The provider now claims it is working on step 3 while nothing verified
  // step 1. This is the divergence the Plan Tracker exists to show.
  const ahead = proposedPlan(['Gather stone', 'Craft furnace', 'Build power'], 2)
  const aheadRecorded = memory.recordPlan(key, { sender: 'Louis', text: 'continue' }, ahead, { continuation: true })
  memory.reconcileTaskBoard(key, reconciled.state.task_board, ahead, aheadRecorded, {
    previousState: memory.currentPlan(key),
    allowReplan: false,
  })

  const after = getActivePlan(memory.planningState(key))
  const tracker = planTrackerView(memory.planningState(key))

  // Recorded: PLANNER_FOCUS_PROPOSED ran on the live path.
  assert.equal(after.advisory.planner_focus_step_id, after.steps[2].step_id)
  assert.ok(Number.isFinite(after.advisory.planner_focus_at))
  assert.equal(tracker.advisory_planner_focus_step_id, after.steps[2].step_id)

  // Advisory: it moved nothing (roadmap 8).
  assert.equal(after.active_step_index, 0, 'planner focus must not advance the active step')
  assert.equal(tracker.active_step_index, 0)
  assert.equal(tracker.active_step_id, after.steps[0].step_id)
  assert.equal(after.execution.step_progress[after.steps[1].step_id]?.status ?? 'pending', 'pending')
  assert.equal(tracker.verified_completed_step_ids.length, 0, 'planner focus must not complete a step')
  assert.notEqual(after.status, PLAN_STATUS.COMPLETED)
})
