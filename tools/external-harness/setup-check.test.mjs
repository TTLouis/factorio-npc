import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { withMcpClient } from './mcp-call.mjs'
import { MCP_TOOLS } from './mcp-server.mjs'
import { checkSetup } from './setup-check.mjs'

const serverUrl = new URL('./mcp-server.mjs', import.meta.url).href
const session = 'external-11111111-2222-4333-8444-555555555555'
const context = { mode: 'external-harness', session, actor: { actor_id: 1, epoch: 1, allowed: true },
  native: { task_state: 'idle', queue_length: 0 }, pending: [], reconciliation_required: [], recent: [], journal_capacity_remaining: 512 }

async function fixture(t, { change = '', records = [], nativeHighWater = 0, env: extraEnv = {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'external-setup-check-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, 'ledger.json'), JSON.stringify({ version: 1, session, records, native_high_water: nativeHighWater }))
  const script = `
import fs from 'node:fs/promises';
import { startMcpServer, MCP_TOOLS } from ${JSON.stringify(serverUrl)};
const directory = process.env.EXTERNAL_HARNESS_STATE_DIR;
const context = ${JSON.stringify(context)};
const calls = [];
const runtime = {
 context: async () => { calls.push('context'); return context },
 capabilities: async () => { calls.push('capabilities'); return { operations: [{name:'wait'}], observation_schemas:[{name:'getActorStatus',inputSchema:{type:'object'}}] } },
 observe: async value => { calls.push('observe'); return { mode:'npc',actor:{kind:'standalone_character',valid:true,actor_id:context.actor.actor_id},connected_players:0 } },
 submit: async () => { calls.push('FORBIDDEN-submit'); throw new Error('forbidden') },
 get: async () => ({}), cancel: async () => { calls.push('FORBIDDEN-cancel'); throw new Error('forbidden') }, resume: async () => ({})
};
${change}
const server = startMcpServer({runtime});
await server.done;
await fs.appendFile(directory+'/calls.jsonl',JSON.stringify(calls)+'\\n');
`
  return { env: { ...process.env, EXTERNAL_HARNESS_SESSION: session, EXTERNAL_HARNESS_STATE_DIR: directory,
    SGLUNA_RCON_PASSWORD: 'private-test-credential-not-for-output', ...extraEnv },
  command: process.execPath, args: ['--input-type=module', '-e', script], directory }
}

test('fresh setup checks full live schemas and read-only calls over two clean connections', async t => {
  const options = await fixture(t)
  const result = await checkSetup({ ...options, fresh: true })
  assert.equal(result.status, 'local_stdio_ready')
  assert.equal(result.native_host_registration_verified, false)
  assert.equal(result.reconnect_verified, true)
  assert.equal(result.ledger_records, 0)
  assert.deepEqual(result.checks[0].tools, MCP_TOOLS)
  assert.equal(JSON.stringify(result).includes(options.env.SGLUNA_RCON_PASSWORD), false)
  const calls = (await fs.readFile(path.join(options.directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls, [['context', 'capabilities', 'observe'], ['context', 'capabilities', 'observe']])
})

test('ordinary readiness retains settled history while fresh proof refuses it', async t => {
  const row = { terminal: true }
  const options = await fixture(t, { records: [row], nativeHighWater: 1,
    change: 'context.recent=[{operation_id:"old",state:"completed"}];context.journal_capacity_remaining=511;' })
  const result = await checkSetup(options)
  assert.equal(result.ledger_records, 1)
  await assert.rejects(checkSetup({ ...options, fresh: true }), { code: 'setup_not_fresh' })
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.directory, 'ledger.json'), 'utf8')).records, [row])
})

for (const [name, change, code] of [
  ['busy native state', 'context.native.task_state="running";', 'setup_not_idle'],
  ['pending operation', 'context.pending=[{operation_id:"old",state:"uncertain"}];', 'setup_not_idle'],
  ['reconciliation fence', 'context.reconciliation_required=[{operation_id:"old"}];', 'setup_not_idle'],
  ['wrong session', 'context.session="wrong";', 'setup_actor_invalid'],
  ['lost ownership', 'context.actor.allowed=false;', 'setup_actor_invalid'],
  ['missing full input schema', 'delete MCP_TOOLS[3].inputSchema.properties.operation;', 'setup_tool_schema_mismatch'],
  ['read-only tool failure', 'runtime.observe=async()=>{throw new Error("private-test-credential-not-for-output")};', 'setup_tool_failed'],
]) {
  test(`readiness refuses ${name} without gameplay`, async t => {
    const options = await fixture(t, { change })
    await assert.rejects(checkSetup(options), { code })
    const calls = await fs.readFile(path.join(options.directory, 'calls.jsonl'), 'utf8')
    assert.equal(calls.includes('FORBIDDEN'), false)
  })
}

test('reconnect refuses changed actor epoch', async t => {
  const options = await fixture(t, { change: `const countFile=directory+'/connections';let count=Number(await fs.readFile(countFile,'utf8').catch(()=>0));await fs.writeFile(countFile,String(++count));context.actor.epoch=count;` })
  await assert.rejects(checkSetup(options), { code: 'setup_reconnect_identity_changed' })
})

test('unsettled ledger is refused without clearing or rewriting it', async t => {
  const records = [{ terminal: false }]
  const options = await fixture(t, { records })
  await assert.rejects(checkSetup(options), { code: 'setup_ledger_unsettled' })
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.directory, 'ledger.json'), 'utf8')).records, records)
})

test('process adapter preserves tools/list schemas and full tool success/error envelopes', async t => {
  const options = await fixture(t)
  const listed = await withMcpClient(client => client.request('tools/list'), options)
  assert.deepEqual(listed.result.tools, MCP_TOOLS)
  const success = await withMcpClient(client => client.request('tools/call', { name: 'factorio_context', arguments: {} }), options)
  assert.equal(success.jsonrpc, '2.0')
  assert.equal(success.id, 2)
  assert.equal(success.result.isError, false)
  assert.deepEqual(success.result.structuredContent, context)
  assert.equal(JSON.parse(success.result.content[0].text).session, session)
  const refused = await withMcpClient(client => client.request('tools/call', { name: 'factorio_context', arguments: { unexpected: true } }), options)
  assert.equal(refused.error.code, -32602)
  assert.equal(Object.hasOwn(refused, 'result'), false)
})

test('abrupt child failure and stderr never reveal credentials', async () => {
  await assert.rejects(withMcpClient(() => {}, { command: process.execPath, args: ['-e', 'process.stderr.write("private-test-credential-not-for-output");process.exit(9)'] }), error => {
    assert.equal(error.code, 'mcp_exited')
    assert.equal(error.cleanupCode, 'mcp_child_failed')
    assert.equal(error.stack.includes('private-test-credential-not-for-output'), false)
    return true
  })
})

test('default adapter deadline preserves a supported 30-second receipt wait past 15 seconds', async t => {
  const options = await fixture(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const reply = await withMcpClient(async client => {
      const pending = client.request('tools/call', { name: 'factorio_receipt', arguments: { operation_id: 'existing-operation', wait_ms: 30000 } })
      // Advance only the parent's deadline clock. The real child still replies
      // through stdio, so the former 15-second default would reject this call.
      t.mock.timers.tick(30000)
      return await pending
    }, options)
    assert.equal(reply.result.isError, false)
    assert.deepEqual(reply.result.structuredContent, {})
  }
  finally { t.mock.timers.reset() }
})

test('timed-out child is reaped and preserves the initiating failure', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'external-setup-timeout-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const pidPath = path.join(directory, 'pid')
  await assert.rejects(withMcpClient(() => {}, { timeoutMs: 200,
    command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000)`] }), error => {
    assert.equal(error.code, 'mcp_request_timeout')
    assert.equal(error.cleanupCode, 'mcp_close_timeout')
    return true
  })
  const pid = Number(await fs.readFile(pidPath, 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
