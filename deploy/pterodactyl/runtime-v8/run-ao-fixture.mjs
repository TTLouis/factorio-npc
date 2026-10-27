import fs from 'node:fs'
import path from 'node:path'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { getActivePlan } from './planning-state.mjs'
import { startContractPrediction } from './contract-prediction.mjs'
import { recoverInterruptedAgentPlan, Session } from './supervisor.mjs'
import { pinLegacyFixtureSkillContext, FakeFactorio, planReply } from './task-loop-fixtures.mjs'

export const ao = JSON.parse(fs.readFileSync(new URL('./fixtures/run-ao-controller.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))

export function preserveAoRepair(name, w) {
  const dir = process.env.AO_REPAIR_EVIDENCE_DIR
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), `${w.events.map(row => JSON.stringify(row)).join('\n')}\n`)
  fs.writeFileSync(path.join(dir, `${name}-outcome.json`), `${JSON.stringify({
    source: ao.baseline_sha, fixture: 'recorded AO plans plus scripted native scheduling/provider continuation',
    gameplay_success: false, active_step_index: w.held().active_step_index,
    native_batches_admitted: w.game.mutations.length, transfer_calls: w.game.mutations.filter(text => text.includes("'move_items_exact'")).length,
    recoveries: w.events.filter(row => /^controller.recovery_/.test(row.event)),
    ledger: [...(w.memory.controllerRecoveries ?? [])],
  }, null, 2)}\n`)
}

export async function aoWorld({ traceHook, readHook, providerHook } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(structuredClone(ao.memory))
  pinLegacyFixtureSkillContext(memory)
  const game = new FakeFactorio({ inventory: { 'iron-plate': 16, 'copper-plate': 11, lab: 1, 'transport-belt': 4 } })
  Object.assign(game.status, { actor_id: 19, epoch: 1, connected_players: 0 })
  game.nearby = { actor_position: { x: -21, y: 1 }, entities: [{ name: 'stone-furnace', type: 'furnace',
    unit_number: 44, position: { x: -21, y: 1 } }] }
  game.batchId = ao.native_batch_id - 1
  game.lastTaskTypes = ['waiting']
  const events = []; const contracts = []; const providers = []; const chats = []
  let agent; let observed = false
  const native = game.command.bind(game)
  game.command = async text => {
    await readHook?.({ text, agent, game, memory })
    if (text.includes('"get_entity_status"')) return JSON.stringify({ found: true,
      entity: { name: 'stone-furnace', type: 'furnace', unit_number: 44, position: { x: -21, y: 1 } },
      inventories: { furnace_result: { 'iron-plate': 34 } } })
    return native(text)
  }
  game.onMutation = text => {
    game.status.idle = false
    game.taskState = text.includes("'move_items_exact'") ? 'moving_items' : 'mining'
    game.queueLength = 1
  }
  const session = new Session({ root: '/tmp', app: '/tmp', game: '/tmp', config: {}, save: 'fixture', settingsFile: 'fixture', modDir: 'fixture', ini: 'fixture', log: () => {} })
  session.ready = true
  session.npcId = ao.key.slice(4)
  session.rcon = game
  session.ensureAuthorization = async () => game.status
  session.syncTaskBoardUi = async () => true
  session.printChat = async line => { chats.push(line) }
  const held = () => getActivePlan(memory.planningState(ao.key))
  agent = new NpcAgentLoop({ allowEphemeralSkillHandoff: true, rcon: game, memory, npcId: ao.key.slice(4), completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null, systemPrompt: 'Exact recorded Run AO controller fixture.',
    reserve: async () => {}, provider: async (messages, context) => {
      if (context.triggerSource === 'step_contract') {
        contracts.push({ messages, context })
        const text = messages.find(row => row.role === 'user' && row.content.startsWith('[STEP_CONTRACT_REQUEST]')).content
        const packet = JSON.parse(text.slice(text.indexOf(' {"goal"') + 1))
        return { content: packet.target.step_id === JSON.parse(ao.prediction_reply).stepId ? ao.prediction_reply
          : JSON.stringify({ stepId: packet.target.step_id, checkpoint: { mode: 'all', requirements: [
            ...['offshore-pump', 'boiler', 'steam-engine'].map(item_name => ({ kind: 'inventory_count', item_name, minimum: 1 })),
            { kind: 'inventory_count', item_name: 'small-electric-pole', minimum: 4 },
            { kind: 'inventory_count', item_name: 'pipe', minimum: 8 },
            { kind: 'inventory_count', item_name: 'coal', minimum: 20 },
            { kind: 'inventory_count', item_name: 'lab', minimum: 1 },
          ] } }) }
      }
      providers.push({ messages, context })
      const custom = await providerHook?.({ agent, game, memory, providers, context })
      if (custom) return custom
      const plan = held(); const step = plan.steps[plan.active_step_index]
      if (plan.active_step_index === 0 && !observed) {
        observed = true
        return { tool_calls: [{ id: 'ao-fresh-furnace', type: 'function', function: {
          name: 'getEntityStatus', arguments: JSON.stringify({ name: 'stone-furnace', unit_number: 44 }) } }] }
      }
      return planReply({ stepId: step.step_id, operations: plan.active_step_index === 0
        ? [{ name: ao.operation.name, args: structuredClone(ao.operation.args) }]
        : [{ name: 'gather_resource', args: { resource_name: 'stone', count: 5, search_radius: 32 } }] })
    } })
  agent.behaviorTrace = { emit: async row => { events.push(row); await traceHook?.({ row, agent, game, memory, session }) } }
  agent.onActivity = (event) => {
    if (['operations.ack', 'step.verified', 'step.semantic_completed'].includes(event)) session.controllerProgressSequence = (session.controllerProgressSequence ?? 0) + 1
  }
  session.agent = agent
  memory.resumePausedPlan(ao.key, { pauseClasses: ['transport'], reason: 'fixture_historical_prediction_setup' })
  agent.epoch = structuredClone(game.status)
  agent.active = true
  agent.lastMemoryKey = ao.key
  agent.requestInfo = { memoryKey: ao.key, turnId: 1, sender: 'Louis', text: ao.memory.plans[0].state.objective }
  agent.traceRequest = { id: ao.old_request_id, usage: {} }
  agent.baseMessages = [{ role: 'system', content: agent.systemPrompt }]
  agent.messages = [...agent.baseMessages]
  startContractPrediction(agent)
  if (!agent.contractPrediction) throw new Error('Recorded AO plan did not start its pending-step prediction')
  await agent.contractPrediction.flight
  const oldPrediction = agent.contractPrediction
  await agent.pausePersistentPlan('provider_transient: Provider timed out after 300000 ms', { pause_class: 'transport', pause_subkind: 'timeout' })
  const resumed = await recoverInterruptedAgentPlan(agent, 'auto_resume_after_transient_provider_failure', {}, { requestId: ao.resumed_request_id })
  if (!resumed.recovered) throw new Error(`AO fixture did not resume: ${resumed.reason}`)
  if (!agent.traceRequest) throw new Error(`AO fixture lost request before native callback: ${JSON.stringify({ blocker: resumed.result?.blocker,
    events: events.slice(-14).map(row => ({ event: row.event, reason: row.data?.reason })) })}`)
  const finishNative = () => {
      // Replay AO's actual strict transfer result, with only the simulator tick
      // changed to match its batch clock. A generic 'completed' result would
      // take the uncorrelated-receipt fallback instead of AO's callback path.
      game.lastBasicResult = structuredClone(ao.events.find(row => row.event === 'factorio.status').data.task_status.basic_operation.last_result)
      game.lastBasicResult.tick = 600 + game.batchId
      game.inventory['iron-plate'] = 50
      game.status.idle = true
      game.taskState = 'idle'
      game.queueLength = 0
  }
  return { agent, game, memory, session, held, events, contracts, providers, chats, oldPrediction, finishNative,
    close: () => { finishNative(); return agent.completed() } }
}
