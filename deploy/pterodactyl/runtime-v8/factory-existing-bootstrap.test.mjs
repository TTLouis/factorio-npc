import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { answerBootstrapRead } from './direct-feed-bootstrap-fixtures.mjs'
import { directFeedBootstrapRefusal } from './direct-feed-bootstrap-runtime.mjs'
import { recoveryFixture, recoveryGuidance, RECOVERY_OBJECTIVE } from './factory-use-recovery-fixtures.mjs'

test('live-shaped known recipe closure does not demand another pair when the exact assigned iron supplier already exists', async () => {
  const root = path.resolve('test-results/factory-existing-bootstrap'); await fs.mkdir(root, { recursive: true })
  const dir = await fs.mkdtemp(path.join(root, 'case-'))
  try {
    const w = recoveryFixture(path.join(dir, 'state.json'))
    const command = w.game.command.bind(w.game)
    w.game.command = async text => {
      // Existing declared historical recipe fixture supplies positive known
      // native-shaped closure, which the previous minimal fake left unknown.
      if (/"(?:recipe_details|mining_details)"/.test(text)) return answerBootstrapRead(text, { inventory: w.game.inventory })
      return command(text)
    }
    const result = await w.agent.request(RECOVERY_OBJECTIVE, { sender: 'owner' })
    assert.equal(w.plannerCalls(), 2)
    assert.equal(result.operations[0].args.unit_number, 138)
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.events.filter(row => row.event === 'role.contract_refused' && row.data.reason === 'direct_feed_bootstrap_infeasible').length, 0)
  } finally { assert.ok(dir.startsWith(root + path.sep)); await fs.rm(dir, { recursive: true, force: true }) }
})

for (const mode of ['wrong_resource', 'unknown_member', 'new_cell_intent', 'stale_native_session']) test(`existing supplier bootstrap exemption refuses ${mode}`, async () => {
  const root = path.resolve('test-results/factory-existing-bootstrap'); await fs.mkdir(root, { recursive: true })
  const dir = await fs.mkdtemp(path.join(root, 'case-'))
  const stop = new Error('bounded bootstrap probe complete')
  let verdict; let failure; let probed = false
  try {
    const w = recoveryFixture(path.join(dir, 'state.json'), {
      onProvider: async (context, fixture) => {
        if (context.role !== 'planner' || probed) return
        probed = true
        const brief = recoveryGuidance()
        if (mode === 'wrong_resource') {
          const source = fixture.game.factoryMembers.get(138)
          source.source_resources.resources = [{ name: 'copper-ore', products_truncated: false, products: [{ type: 'item', name: 'copper-ore' }] }]
        }
        if (mode === 'unknown_member') fixture.game.factoryMembers.get(138).state = 'unknown'
        if (mode === 'new_cell_intent') brief.cellIntent = { purpose: 'Build an additional supplier' }
        try { verdict = await directFeedBootstrapRefusal(fixture.agent, { executionGuidance: [brief] }) }
        catch (error) { failure = error }
        throw stop
      },
      onTrace: (row, fixture) => {
        if (mode === 'stale_native_session' && row.event === 'factory_cell.use_resolved') fixture.game.status.session = 'replaced-during-observation'
      },
    })
    const command = w.game.command.bind(w.game)
    w.game.command = async text => /"(?:recipe_details|mining_details)"/.test(text)
      ? answerBootstrapRead(text, { inventory: w.game.inventory }) : command(text)
    await assert.rejects(w.agent.request(RECOVERY_OBJECTIVE, { sender: 'owner' }))
    assert.equal(probed, true)
    if (mode === 'stale_native_session') assert.ok(failure, 'fresh guarded observation must fence the native session')
    else { assert.equal(failure, undefined); assert.equal(verdict?.code, 'direct_feed_bootstrap_infeasible') }
    assert.equal(w.events.filter(row => row.event === 'plan.direct_feed_existing_supplier_verified').length, 0)
    assert.equal(w.game.mutations.length, 0)
  } finally { assert.ok(dir.startsWith(root + path.sep)); await fs.rm(dir, { recursive: true, force: true }) }
})
