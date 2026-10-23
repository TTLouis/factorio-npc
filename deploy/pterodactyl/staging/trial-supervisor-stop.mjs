import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stopTrialIfTerminal } from './trial-stop-policy.mjs'

// External E2E supervisor entry point. The identity is written once by the
// runner, not inferred from an old pause message or selected by the model.
export async function supervisorStop({ rcon, root, snapshotCommand, expectedRunId, now = Date.now }) {
  const logs = path.join(root, 'logs')
  const identity = JSON.parse(await fs.readFile(path.join(logs, 'e2e-trial-identity.json'), 'utf8'))
  if (identity.run_id !== expectedRunId || !identity.goal_id || !identity.actor_id) throw new Error('Trial identity mismatch')
  const decision = await stopTrialIfTerminal({ policy: { speedPolicy: identity.speed_policy ?? { profile: 'normal' } }, readCurrent: async () => {
    const native = JSON.parse(await rcon.command(snapshotCommand))
    const names = (await fs.readdir(logs)).filter(name => /^sgluna-behavior\.jsonl(?:\.\d+)?$/.test(name))
    const events = (await Promise.all(names.map(name => fs.readFile(path.join(logs, name), 'utf8'))))
      .flatMap(text => text.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }))
    const previous = JSON.parse(await fs.readFile(path.join(logs, 'e2e-stop-decision.json'), 'utf8').catch(() => '{}'))
    const hardFloorReached = Boolean(await fs.stat(path.join(identity.helper_root, 'stop-at-hard-floor')).catch(() => null))
    // Canonical state is read last: a slow RCON/trace observation must not leave
    // a cleared pause looking terminal. stopTrialIfTerminal repeats the full
    // observation before issuing any automatic stop.
    const state = JSON.parse(await fs.readFile(path.join(root, '.sgluna/npc-state.json'), 'utf8'))
    return { canonical: state.planning_states?.find(row => row.state?.goal)?.state,
      native, events, startedAt: identity.started_at, now: now(), pausedSince: previous.pausedSince,
      goalId: identity.goal_id, actorId: identity.actor_id, constructionLimitMs: identity.construction_limit_ms,
      hardFloorReached }
  }, stop: async () => {
    await rcon.command('/silent-command if remote.interfaces.sgluna_tick_sprint then local g=remote.call("sgluna_tick_sprint","status");if g.binding then local s=remote.call("sgluna_tick_sprint","seal","external_stop");assert(s.speed==1 and not s.lease) end end')
    await rcon.command('!luna stop')
  } })
  await fs.writeFile(path.join(logs, 'e2e-supervisor-stop-decision.json'), JSON.stringify(decision, null, 2))
  return decision
}

async function main() {
  const runId = process.argv[2]
  if (!runId) throw new Error('Explicit expected run ID required')
  const release = path.dirname(await fs.realpath('/opt/sgluna/start-sgluna.sh'))
  const { Rcon } = await import(pathToFileURL(path.join(release, 'src/runtime-v8/common.mjs')))
  const rcon = new Rcon(27015, process.env.SGLUNA_RCON_PASSWORD, 15000)
  try {
    await rcon.connect()
    const decision = await supervisorStop({ rcon, root: '/data', expectedRunId: runId,
      snapshotCommand: await fs.readFile('/e2e/snapshot.lua', 'utf8') })
    process.stdout.write(`${JSON.stringify(decision)}\n`)
  } finally { rcon.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
