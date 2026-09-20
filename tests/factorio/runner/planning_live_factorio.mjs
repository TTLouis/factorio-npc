#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
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

function strictPlan(chatMessage, plan, operations) {
  return {
    content: JSON.stringify({
      chatMessage,
      plan,
      currentStep: 0,
      operations,
    }),
  }
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

function makeAgent({ rcon, stateFile, memory, provider }) {
  return new NpcAgentLoop({
    rcon,
    provider,
    systemPrompt: 'real Factorio planning-state integration test',
    stateFile,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    memory,
  })
}

async function prepare({ rcon, results, stateFile }) {
  await configureNpcSession(rcon, 'sgluna-factorio-planning-prepare-0001')

  let providerCalls = 0
  const memory = new CanonicalTaskBoardMemory()
  const agent = makeAgent({
    rcon,
    stateFile,
    memory,
    provider: async () => {
      providerCalls++
      return strictPlan(
        'Attempting the deterministic integration resource.',
        ['Gather the unavailable integration resource', 'Continue the build'],
        [{
          name: 'gather_resource',
          args: {
            resource_name: 'sgluna-missing-resource',
            count: 1,
            search_radius: 32,
          },
        }],
      )
    },
  })

  const result = await agent.request('gather the deterministic integration resource', { sender: 'Louis' })
  const planning = memory.planningState(key)
  const blocked = getActivePlan(planning)
  const engine = JSON.parse(await rcon.command(operationStatusCommand()))

  assert.equal(providerCalls, 1)
  assert.equal(result.goalStatus, 'blocked')
  assert.equal(result.operations.length, 0)
  assert.equal(result.blocker?.code, 'unknown_prototype')
  assert.equal(planning.plans.length, 1, 'preflight failure must not create a replacement suffix')
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(blocked.blocker?.reason_code, 'operation_preflight_failed:unknown_prototype')
  assert.equal(memory.currentPlan(key)?.planning?.blocked?.awaiting_choice, true)
  assert.equal(engine.task_state, 'idle', 'rejected preflight must not start world work')
  assert.equal(engine.queue_length, 0, 'rejected preflight must not queue world work')
  assert.equal(engine.queue_empty, true, 'rejected preflight must leave Autorio idle')

  await agent.persistState()
  await fsp.writeFile(path.join(results, 'planning-live-prepare.json'), JSON.stringify({
    status: 'blocked',
    plan_id: blocked.plan_id,
    plan_version: blocked.plan_version,
    reasoning_epoch: memory.planningReasoningEpoch(key),
    blocker: blocked.blocker,
    engine: {
      task_state: engine.task_state,
      queue_length: engine.queue_length,
      queue_empty: engine.queue_empty,
    },
  }, null, 2))

  console.log(`PASS: live coordinator reached BLOCKED on real Factorio preflight without mutation plan_id=${blocked.plan_id}`)
}

async function verify({ rcon, results, stateFile }) {
  await configureNpcSession(rcon, 'sgluna-factorio-planning-verify-0002')
  const before = JSON.parse(await fsp.readFile(path.join(results, 'planning-live-prepare.json'), 'utf8'))

  let providerCalls = 0
  const memory = new CanonicalTaskBoardMemory()
  const agent = makeAgent({
    rcon,
    stateFile,
    memory,
    provider: async () => {
      providerCalls++
      if (providerCalls === 1) {
        return strictPlan(
          'Ordinary continuation proposal that must remain frozen.',
          ['Gather the unavailable integration resource differently', 'Continue the build'],
          [{ name: 'wait', args: { ticks: 1 } }],
        )
      }
      if (providerCalls === 2) {
        return strictPlan(
          'Applying the user-approved bounded alternate route.',
          ['Wait briefly instead of gathering the unavailable integration resource', 'Continue the build'],
          [{ name: 'wait', args: { ticks: 1 } }],
        )
      }
      throw new Error(`unexpected provider call ${providerCalls}`)
    },
  })

  await agent.loadPersistentState()
  const restored = getActivePlan(memory.planningState(key))
  assert.equal(providerCalls, 0, 'restore itself must not wake the planner')
  assert.equal(restored.status, PLAN_STATUS.BLOCKED)
  assert.equal(restored.plan_id, before.plan_id)
  assert.equal(restored.plan_version, before.plan_version)
  assert.equal(memory.planningReasoningEpoch(key), before.reasoning_epoch)
  assert.equal(memory.planningState(key).plans.length, 1)

  const ordinary = await agent.request('continue', { sender: 'Louis' })
  const stillBlocked = getActivePlan(memory.planningState(key))
  assert.equal(providerCalls, 1)
  assert.equal(ordinary.goalStatus, 'blocked')
  assert.equal(ordinary.operations.length, 0, 'blocked continuation must not admit the proposed wait')
  assert.equal(stillBlocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(stillBlocked.plan_id, before.plan_id)
  assert.equal(memory.planningState(key).plans.length, 1, 'ordinary continuation must not create a suffix plan')

  memory.recordBlockedChoice(key, 'revise', 'Louis', { now: Date.now() })
  await agent.persistState()
  const choiceOnly = getActivePlan(memory.planningState(key))
  assert.equal(choiceOnly.status, PLAN_STATUS.BLOCKED)
  assert.equal(choiceOnly.blocker?.user_choice?.choice, 'revise')
  assert.equal(memory.planningState(key).plans.length, 1, 'revise click alone must not create a successor')

  const revised = await agent.request(
    'Use a bounded wait route instead of gathering the unavailable integration resource.',
    { sender: 'Louis' },
  )
  const successor = getActivePlan(memory.planningState(key))
  const successorEpoch = memory.planningReasoningEpoch(key)

  assert.equal(providerCalls, 2)
  assert.equal(revised.goalStatus, 'active')
  assert.notEqual(successor.status, PLAN_STATUS.BLOCKED)
  assert.equal(successor.derived_from_plan_id, before.plan_id)
  assert.equal(successor.plan_version, before.plan_version + 1)
  assert.equal(memory.planningState(key).plans.length, 2)
  assert.ok(successorEpoch > before.reasoning_epoch, 'approved revision must invalidate predecessor reasoning')
  assert.equal(successor.steps[0]?.description, 'Wait briefly instead of gathering the unavailable integration resource')

  await agent.persistState()
  await fsp.writeFile(path.join(results, 'planning-live-verify.json'), JSON.stringify({
    status: 'pass',
    predecessor_plan_id: before.plan_id,
    successor_plan_id: successor.plan_id,
    successor_version: successor.plan_version,
    predecessor_reasoning_epoch: before.reasoning_epoch,
    successor_reasoning_epoch: successorEpoch,
    provider_calls: providerCalls,
  }, null, 2))

  console.log(`PASS: BLOCKED survived real Factorio restart; ordinary continuation stayed frozen and explicit revision created successor=${successor.plan_id}`)
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
  const stateFile = path.join(results, 'planning-live-state.json')
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
      path.join(results, 'planning-live-factorio-error.txt'),
      `${error?.stack ?? error}\n`,
    ).catch(() => {})
  }
  console.error(error)
  process.exitCode = 1
})
