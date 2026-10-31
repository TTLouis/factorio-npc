#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { withMcpClient } from './mcp-call.mjs'
import { MCP_PROTOCOL_VERSION, MCP_TOOLS } from './mcp-server.mjs'

const fail = code => Object.assign(new Error(code), { code })
function requireCheck(condition, code) { if (!condition) throw fail(code) }
function toolValue(reply) {
  requireCheck(!reply.error && reply.result?.isError === false, 'setup_tool_failed')
  requireCheck(reply.result.structuredContent && Array.isArray(reply.result.content), 'setup_tool_envelope_invalid')
  return reply.result.structuredContent
}

// Checks an already bound world. Binding, engine launch and host registration
// remain explicit setup steps; this helper can never submit gameplay operations.
export async function checkSetup({ env = process.env, fresh = false, ...clientOptions } = {}) {
  requireCheck(typeof env.EXTERNAL_HARNESS_STATE_DIR === 'string' && env.EXTERNAL_HARNESS_STATE_DIR.length > 0, 'state_directory_required')
  requireCheck(/^[a-z0-9_-]{32,120}$/i.test(env.EXTERNAL_HARNESS_SESSION ?? ''), 'world_unique_session_required')
  const ledgerPath = path.join(path.resolve(env.EXTERNAL_HARNESS_STATE_DIR), 'ledger.json')
  const readLedger = async () => {
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
    requireCheck(ledger.version === 1 && ledger.session === env.EXTERNAL_HARNESS_SESSION && Array.isArray(ledger.records), 'setup_ledger_invalid')
    requireCheck(ledger.records.every(row => row.terminal === true && !row.current_fence && !row.result?.requires_reconciliation), 'setup_ledger_unsettled')
    if (fresh) requireCheck(ledger.records.length === 0 && ledger.native_high_water === 0, 'setup_ledger_not_fresh')
    return ledger.records.length
  }
  let prior
  let ledgerRecords
  const checks = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await withMcpClient(async client => {
      const listed = await client.request('tools/list', {})
      requireCheck(!listed.error && Array.isArray(listed.result?.tools), 'setup_tools_missing')
      try { assert.deepEqual(listed.result.tools, MCP_TOOLS) }
      catch { throw fail('setup_tool_schema_mismatch') }
      const context = toolValue(await client.request('tools/call', { name: 'factorio_context', arguments: {} }))
      const capabilities = toolValue(await client.request('tools/call', { name: 'factorio_capabilities', arguments: {} }))
      const actor = toolValue(await client.request('tools/call', { name: 'factorio_observe', arguments: { name: 'getActorStatus', args: {} } }))
      requireCheck(context.mode === 'external-harness' && context.session === env.EXTERNAL_HARNESS_SESSION
        && context.actor?.allowed === true && Number.isSafeInteger(context.actor.actor_id) && context.actor.actor_id > 0
        && Number.isSafeInteger(context.actor.epoch) && context.actor.epoch > 0, 'setup_actor_invalid')
      requireCheck(context.native?.task_state === 'idle' && context.native.queue_length === 0
        && Array.isArray(context.pending) && context.pending.length === 0
        && Array.isArray(context.reconciliation_required) && context.reconciliation_required.length === 0
        && Number.isSafeInteger(context.journal_capacity_remaining) && context.journal_capacity_remaining > 0, 'setup_not_idle')
      if (fresh) requireCheck(Array.isArray(context.recent) && context.recent.length === 0 && context.journal_capacity_remaining === 512, 'setup_not_fresh')
      requireCheck(Array.isArray(capabilities.operations) && capabilities.operations.length > 0
        && Array.isArray(capabilities.observation_schemas) && capabilities.observation_schemas.some(row => row.name === 'getActorStatus')
        && actor?.mode === 'npc' && actor.actor?.kind === 'standalone_character' && actor.actor.valid === true
        && actor.actor.actor_id === context.actor.actor_id, 'setup_capabilities_invalid')
      if (fresh) requireCheck(actor.connected_players === 0, 'setup_humans_connected')
      return { context, tools: listed.result.tools, initialize: client.initialize.result }
    }, { env, ...clientOptions })
    const records = await readLedger()
    if (ledgerRecords !== undefined) requireCheck(records === ledgerRecords, 'setup_ledger_changed')
    ledgerRecords = records
    if (prior) requireCheck(prior.session === result.context.session && prior.actor.actor_id === result.context.actor.actor_id
      && prior.actor.epoch === result.context.actor.epoch, 'setup_reconnect_identity_changed')
    prior = result.context
    checks.push({ connection: attempt + 1, protocol: result.initialize.protocolVersion, tools: result.tools, context: result.context })
  }
  requireCheck(!await fs.stat(path.join(path.dirname(ledgerPath), 'owner.lock')).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  }), 'setup_client_lock_retained')
  return { version: 1, checked_at: new Date().toISOString(), status: 'local_stdio_ready', protocol: MCP_PROTOCOL_VERSION,
    session: prior.session, actor: prior.actor, native_idle: true, ledger_records: ledgerRecords, gameplay_submissions: 0, fresh,
    reconnect_verified: true, native_host_registration_verified: false, checks }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node tools/external-harness/setup-check.mjs [--fresh] [--output ABSOLUTE_PRIVATE_RECEIPT_PATH]\nChecks an already bound world twice through stdio MCP. --fresh requires zero native history and an empty ledger. Default permits settled history. Never binds, submits gameplay, or configures a host.\n')
    return
  }
  const rest = [...args]
  const fresh = rest[0] === '--fresh'
  if (fresh) rest.shift()
  requireCheck(rest.length === 0 || rest.length === 2 && rest[0] === '--output' && path.isAbsolute(rest[1]), 'invalid_setup_check_arguments')
  const receipt = await checkSetup({ fresh })
  if (rest.length) await fs.writeFile(rest[1], `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ status: receipt.status, actor: receipt.actor, native_idle: true, reconnect_verified: true, native_host_registration_verified: false })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'setup_check_failed'
    process.stderr.write(`Setup readiness check stopped: ${code}. No gameplay was submitted.\n`)
    process.exitCode = 1
  })
}
