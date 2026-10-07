#!/usr/bin/env node
// Isolated engine fixture, not fresh-map production acceptance. No live inference.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { parseGoalRequirements, requirementsCommand } from '../pterodactyl/runtime-v8/goal-requirements.mjs'
import { configureNpcSession } from '../pterodactyl/staging/supervisor-adapter.mjs'

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  assert.ok(index >= 0 && process.argv[index + 1], `missing --${name}`)
  return process.argv[index + 1]
}

const results = path.resolve(arg('results'))
const key = 'npc:sgluna'
const transcript = []
const calls = []
const targets = { items: [{ name: 'automation-science-pack', machine_output: true }], technologies: [], entities: [] }
const snapshotCommand = '/silent-command local f=game.forces.player; local o=remote.call("autorio_operations","status"); '
  + 'local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; '
  + 'local researched={}; for n,t in pairs(f.technologies) do if t.researched then researched[#researched+1]=n end end; table.sort(researched); '
  + 'rcon.print(helpers.table_to_json({actor_id=o.actor.actor_id,connected_players=#game.connected_players,'
  + 'inventory=a.get_inventory(defines.inventory.character_main).get_contents(),crafting_queue=a.crafting_queue_size,'
  + 'recipe_enabled=f.recipes["automation-science-pack"].enabled,researched=researched,'
  + 'task_state=o.task_state,queue_length=o.queue_length,queue_empty=o.queue_empty,'
  + 'trigger=prototypes.technology["automation-science-pack"].research_trigger}))'

async function main() {
  await fsp.mkdir(results, { recursive: true })
  const connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  try {
    await connection.connect()
    const rcon = { command: async command => {
      const response = await connection.command(command)
      transcript.push({ command, response })
      await fsp.writeFile(path.join(results, 'requirements-transcript.json'), JSON.stringify(transcript, null, 2))
      return response
    } }
    await configureNpcSession(rcon, 'requirements-engine-0001')
    const before = JSON.parse(await rcon.command(snapshotCommand))
    assert.equal(before.connected_players, 0)
    assert.equal(before.recipe_enabled, false, 'target recipe must really be locked')
    assert.equal(before.task_state, 'idle')
    assert.equal(before.queue_length, 0)
    const raw = await rcon.command(requirementsCommand(targets))
    const facts = JSON.parse(raw)
    const parsed = parseGoalRequirements(raw)
    assert.equal(parsed.ok, true, raw)
    const locked = parsed.locked.find(row => row.role === 'target_recipe' && row.subject === 'automation-science-pack')
    assert.ok(locked, raw)
    assert.equal(locked.unlocked_by, 'automation-science-pack')
    assert.equal(locked.path.at(-1), locked.unlocked_by)
    const node = parsed.research[locked.unlocked_by]
    const engineItem = typeof before.trigger.item === 'string' ? before.trigger.item : before.trigger.item.name
    assert.deepEqual(node.trigger, { type: before.trigger.type, item: engineItem, count: before.trigger.count })
    assert.equal(node.mode, 'trigger')
    // The engine label describes production, not the NPC's hand-craft command.
    // Check every craft-item node against native LuaRecipe/character/prototype
    // reads, including smelting-category items along this fresh-world path.
    let craftNodes = 0
    let machineOnlyRecipes = 0
    for (const research of Object.values(parsed.research)) {
      if (research.trigger?.type !== 'craft-item') continue
      craftNodes++
      const report = research.trigger_crafting
      assert.ok(report && !report.unavailable && report.item === research.trigger.item, raw)
      for (const producer of report.recipes) {
        const native = JSON.parse(await rcon.command('/silent-command '
          + `local r=game.forces.player.recipes[${JSON.stringify(producer.recipe)}]; assert(r); `
          + 'local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; '
          + 'local cats={r.category}; for _,c in pairs(r.additional_categories) do cats[#cats+1]=c end; '
          + 'local supported=false; for _,c in pairs(cats) do if a.prototype.crafting_categories[c] then supported=true end end; '
          + 'local fluid=false; for _,i in pairs(r.ingredients) do if i.type=="fluid" then fluid=true end end; '
          + 'for _,p in pairs(r.products) do if p.type=="fluid" then fluid=true end end; '
          + 'local hand=r.enabled and supported and not r.prototype.hidden_from_player_crafting and not fluid; '
          + 'rcon.print(helpers.table_to_json({enabled=r.enabled,categories=cats,hand=hand,count=hand and a.get_craftable_count(r.name) or nil}))'))
        assert.equal(producer.enabled, native.enabled)
        assert.deepEqual(producer.categories, native.categories.slice(0, 4))
        assert.equal(producer.hand_craftable, native.hand)
        if (native.hand) assert.equal(producer.craftable_now_count, native.count)
        if (producer.hand_craftable_reason === 'category_unsupported') {
          machineOnlyRecipes++
          assert.ok(producer.machines.length > 0, `${producer.recipe}: machine-only native recipe must report options`)
        }
      }
    }
    assert.ok(craftNodes > 0 && machineOnlyRecipes > 0, 'fresh science path must exercise native craft-item machine-only facts')
    for (const name of locked.path) {
      for (const dependency of parsed.research[name].requires) {
        assert.ok(locked.path.indexOf(dependency) >= 0 && locked.path.indexOf(dependency) < locked.path.indexOf(name), 'research must be dependency-first')
      }
    }
    const machines = parsed.machines.find(row => row.for_item === 'automation-science-pack')
    assert.ok(machines?.options.some(row => row.entity === 'assembling-machine-1' && row.status === 'locked' && row.unlocked_by === 'automation'), raw)
    assert.equal(machines.craftable, false)
    assert.ok(!parsed.locked.some(row => ['iron-ore', 'copper-ore', 'metallic-asteroid-chunk'].includes(row.subject)), 'mineable ore must not create asteroid-processing prerequisites')
    assert.ok(!parsed.research['space-platform'] && !parsed.research['advanced-asteroid-processing'], 'raw ores must not inject orbital research')
    assert.ok(!locked.path_truncated, 'the target red-science unlock path must be complete')
    const firstMachine = parsed.locked.find(row => row.role === 'machine' && row.subject === 'assembling-machine-1')
    assert.ok(firstMachine && !firstMachine.path_truncated, 'the first assembler unlock path must be complete')
    // Optional higher-tier machine paths can legitimately exceed the report cap.
    // Require truthful truncation evidence, rather than assuming every option is
    // part of the minimal red-science path.
    assert.equal(facts.truncated.paths, parsed.locked.some(row => row.path_truncated === true))

    const memory = new CanonicalTaskBoardMemory()
    const traceFile = path.join(results, 'requirements-behavior.jsonl')
    const agent = new NpcAgentLoop({
      rcon, memory, npcId: 'sgluna', stateFile: path.join(results, 'requirements-state.json'),
      traceFile, decisionTraceFile: null, systemPrompt: 'Scripted requirements engine fixture',
      goalDefinitionPolicy: 'required',
      interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: 'ok' }) }),
      provider: async messages => {
        const snapshot = JSON.parse(await rcon.command(snapshotCommand))
        assert.deepEqual(snapshot, before, 'grounding must not craft, queue work, research or replace the actor')
        assert.equal(memory.goalDefinition(key), undefined, 'grounding precedes goal commit')
        calls.push({ messages, snapshot })
        assert.ok(calls.length <= 2, 'only one corrective grounding round')
        return { content: JSON.stringify({
          chatMessage: 'Attempt the locked craft.', currentStep: 0,
          plan: ['Hand-craft ten red packs', 'Research the unlock'],
          operations: [{ name: 'craft_item', args: { item_name: 'automation-science-pack', count: 10 } }],
          goal: { scope: 'long_horizon', summary: 'Automate red science at 20 packs per minute.',
            doneWhen: [{ id: 'rate', kind: 'production_rate', item_name: 'automation-science-pack', per_minute: 20, window_minutes: 1 }] },
          roadmap: [{ id: 'n1', intent: 'Research the science unlock' }, { id: 'n2', intent: 'Build powered production', depends_on: ['n1'] }],
        }) }
      },
    })
    const result = await agent.request('Automate red science at 20 packs per minute.', { sender: 'Louis' })
    assert.equal(calls.length, 2)
    const grounding = calls[1].messages.map(row => String(row.content ?? '')).join('\n')
    await fsp.writeFile(path.join(results, 'planner-grounding.txt'), grounding)
    assert.match(grounding, /requirements_grounding/)
    assert.match(grounding, /automation-science-pack \[recipe of a goal target\] is LOCKED/)
    assert.ok(grounding.includes(`trigger ${node.trigger.type} (item ${engineItem}, count ${node.trigger.count})`))
    assert.match(grounding, /assembling-machine-1/)
    const state = memory.currentPlan(key)
    assert.equal(state.status, 'blocked')
    assert.equal(state.blocker, 'operation_preflight_failed:recipe_locked:automation-science-pack')
    assert.equal(result.operations.length, 0)
    const evidence = state.task_board.evidence.find(row => row.kind === 'operation_preflight_blocker')
    const blocker = JSON.parse(evidence.summary)
    assert.equal(blocker.locked_recipe.unlocked_by, locked.unlocked_by)
    assert.equal(blocker.reason_code, 'recipe_locked')
    const after = JSON.parse(await rcon.command(snapshotCommand))
    assert.deepEqual(after, before, 'terminal refusal must leave engine state unchanged')
    const rows = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
    for (const event of ['planning.requirements_loaded', 'planning.requirements_grounding_round']) {
      const selected = rows.filter(row => row.event === event)
      assert.equal(selected.length, 1, event)
      assert.ok(selected[0].request_id, event)
    }
    assert.equal(rows.filter(row => row.event === 'planning.requirements_unavailable').length, 0)
    const loaded = rows.find(row => row.event === 'planning.requirements_loaded')
    assert.equal(loaded.data.reason, 'locked_requirements_found')
    assert.ok(loaded.data.raw_items >= 2, 'trace must identify raw ingredients instead of orbital recipe locks')
    assert.equal(rows.filter(row => row.event === 'provider.request').length, 2)
    await agent.persistState()
    await fsp.writeFile(path.join(results, 'requirements-prompts.json'), JSON.stringify(calls, null, 2))
    await fsp.writeFile(path.join(results, 'requirements-engine.json'), JSON.stringify({
      status: 'pass', scenario: 'first-plan-locked-red-science-grounding', candidate_sha: process.env.NPC_TEST_CANDIDATE_SHA,
      provider_mode: 'scripted', before, after, facts, parsed, provider_calls: calls.length, blocker,
    }, null, 2))
    console.log('PASS: real recipe/research/machine facts reached one scripted grounding round; repeated locked craft blocked without world mutation')
  } finally {
    connection.close()
  }
}

main().catch(async error => {
  await fsp.mkdir(results, { recursive: true })
  await fsp.writeFile(path.join(results, 'requirements-error.txt'), `${error.stack ?? error}\n`)
  console.error(error)
  process.exitCode = 1
})
