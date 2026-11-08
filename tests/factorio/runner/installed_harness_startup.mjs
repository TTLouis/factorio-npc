#!/usr/bin/env node
// Runs inside the real installer-built image. All runtime entrypoints are
// subprocesses; pursuit speaks to a bounded loopback HTTP fixture, never DI.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const mode = process.argv[2]
assert.ok(['external', 'plan', 'pursuit'].includes(mode))
const output = process.env.STARTUP_PROOF_DIR ?? '/proof'
const root = path.join(output, 'data')
const installedStart = '/opt/sgluna/start-sgluna.sh'
const app = path.dirname(await fs.realpath(installedStart))
const { Rcon, confirmLuaConsoleReady } = await import(pathToFileURL(path.join(app, 'src/runtime-v8/common.mjs')))
const run = promisify(execFile)
const password = randomBytes(32).toString('hex')
const session = `external-${randomUUID()}`
const record = { mode, source: process.env.STARTUP_EXPECT_SOURCE, app, node: process.version,
  runtimeEntry: installedStart, inferenceRequests: 0, network: 'Docker network none; loopback only',
  http: [], rcon: [], childProcesses: [], status: 'RUNNING', started: new Date().toISOString() }
await fs.mkdir(root, { recursive: true })
const scrub = value => String(value).split(password).join('[fixture-rcon-password]')
const write = async (name, value) => fs.writeFile(path.join(output, name), typeof value === 'string' ? scrub(value) : JSON.stringify(value, null, 2) + '\n')
const persist = () => write('RESULTS.json', record)
let connection, engine, runtime, stub
const children = new Set()
async function bounded(promise, milliseconds) {
  let timer
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
function launch(label, file, args, env = {}) {
  const child = spawn(file, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const item = { label, pid: child.pid, file, args: args.map(scrub), stdout: '', stderr: '' }
  record.childProcesses.push(item)
  child.stdout.on('data', chunk => { item.stdout += scrub(chunk) })
  child.stderr.on('data', chunk => { item.stderr += scrub(chunk) })
  child.closed = new Promise(resolve => child.once('close', (code, signal) => { item.code = code; item.signal = signal; children.delete(child); resolve(item) }))
  children.add(child)
  child.capture = item
  return child
}
async function finish(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return
  child.kill(signal)
  const result = await bounded(child.closed, 20000)
  if (!result) { child.kill('SIGKILL'); await child.closed; throw Error(`${child.capture.label} required SIGKILL`) }
}
async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function command(label, body) {
  const text = `/silent-command ${body}`
  const result = await connection.command(text)
  record.rcon.push({ label, command: text, result, at: new Date().toISOString() })
  await persist()
  return result
}
async function status(label) {
  return JSON.parse(await command(label, 'local a=remote.call("sgluna_deployment","status");local o=remote.call("autorio_operations","status");rcon.print(helpers.table_to_json({guard=a,status=o,board=remote.call("autorio_task_board","status") or false,tick=game.tick,speed=game.speed,humans=#game.connected_players}))'))
}
async function connect(port) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const candidate = new Rcon(port, password, 2000)
    try { await candidate.connect(); connection = candidate; await confirmLuaConsoleReady(connection); return }
    catch { candidate.close(); await sleep(250) }
  }
  throw Error('prepared host RCON not ready')
}
async function requestBody(request) {
  const chunks = []
  for await (const chunk of request) { chunks.push(chunk); assert.ok(chunks.reduce((n, part) => n + part.length, 0) <= 1024 * 1024) }
  return JSON.parse(Buffer.concat(chunks))
}
async function openStub() {
  stub = http.createServer(async (request, response) => {
    try {
      assert.equal(mode, 'pursuit', 'idle plan/external must make zero HTTP requests')
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions')
      const body = await requestBody(request)
      assert.equal(body.model, 'deterministic-http-fixture')
      const count = record.http.length + 1
      assert.ok(count <= 3, 'unexpected fourth provider request')
      const lastTool = body.messages.filter(message => message.role === 'tool').at(-1)
      let message
      if (count === 1) message = { role: 'assistant', content: '', tool_calls: [{ id: 'submit-wait', type: 'function', function: {
        name: 'factorio_submit', arguments: JSON.stringify({ request_id: `${mode}-wait`, operation: { name: 'wait', args: { ticks: 60 } } }),
      } }] }
      else if (count === 2) {
        const submitted = JSON.parse(lastTool.content); assert.ok(submitted.operation_id)
        message = { role: 'assistant', content: '', tool_calls: [{ id: 'receipt-wait', type: 'function', function: {
          name: 'factorio_receipt', arguments: JSON.stringify({ operation_id: submitted.operation_id, wait_ms: 30000 }),
        } }] }
      }
      else {
        const receipt = JSON.parse(lastTool.content)
        assert.equal(receipt.state, 'completed'); assert.equal(receipt.effect, 'happened')
        record.pursuitReceipt = receipt
        message = { role: 'assistant', content: 'Check the native goal; this wait does not supply wood.' }
      }
      const reply = { id: `scripted-${count}`, model: body.model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
      record.http.push({ request: count, body, reply }); await persist()
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(reply))
    }
    catch (error) {
      record.httpFailure = scrub(error.stack); await persist()
      response.writeHead(500); response.end('deterministic fixture refused request')
    }
  })
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
  return stub.address().port
}
async function mcp(child) {
  let sequence = 0, buffer = ''
  const pending = new Map()
  child.stdout.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id) }
      catch { record.mcpUnexpectedOutput = line }
    }
  })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP timeout ${method}`)) }, 45000)
    pending.set(id, reply => { clearTimeout(timer); record.mcp ??= []; record.mcp.push({ method, params, reply }); resolve(reply) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'installed-startup-fixture', version: '1' } })).error, undefined)
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
  const call = async (name, args = {}) => {
    const reply = await rpc('tools/call', { name, arguments: args })
    assert.equal(reply.error, undefined); assert.equal(reply.result.isError, false)
    return reply.result.structuredContent
  }
  await call('factorio_context'); await call('factorio_capabilities')
  const submitted = await call('factorio_submit', { request_id: 'installed-external-wait', operation: { name: 'wait', args: { ticks: 60 } } })
  record.externalReceipt = await call('factorio_receipt', { operation_id: submitted.operation_id, wait_ms: 30000 })
  assert.equal(record.externalReceipt.state, 'completed'); assert.equal(record.externalReceipt.effect, 'happened')
  child.stdin.end(); const closed = await child.closed; assert.equal(closed.code, 0)
  assert.equal(record.mcpUnexpectedOutput, undefined, 'external Docker entrypoint must keep stdout exclusively JSON-RPC')
}
async function prepareHost(port) {
  const host = path.join(output, 'host')
  await fs.mkdir(path.join(host, 'data/saves'), { recursive: true })
  await fs.mkdir(path.join(host, 'mods'), { recursive: true })
  await fs.cp(path.join(app, 'autorio'), path.join(host, 'mods/autorio_0.1.0'), { recursive: true })
  await fs.writeFile(path.join(host, 'mods/mod-list.json'), JSON.stringify({ mods: [{ name: 'base', enabled: true }, { name: 'autorio', enabled: true }, ...['space-age', 'quality', 'elevated-rails'].map(name => ({ name, enabled: false }))] }))
  await fs.writeFile(path.join(host, 'config.ini'), `[path]\nread-data=${app}/factorio/data\nwrite-data=${host}/data\n`)
  await fs.writeFile(path.join(host, 'map-gen.json'), JSON.stringify({ seed: 424242, width: 256, height: 256, peaceful_mode: true }))
  await fs.writeFile(path.join(host, 'server-settings.json'), JSON.stringify({ name: 'installed-startup-fixture', description: 'zero inference', visibility: { public: false, lan: false }, require_user_verification: false, allow_commands: 'admins-only', auto_pause: false, autosave_interval: 0 }))
  const flags = ['--config', path.join(host, 'config.ini'), '--mod-directory', path.join(host, 'mods')]
  const create = launch('create-world', path.join(app, 'factorio/bin/x64/factorio'), [...flags, '--create', path.join(host, 'data/saves/start.zip'), '--map-gen-settings', path.join(host, 'map-gen.json')])
  assert.equal((await create.closed).code, 0)
  engine = launch('prepared-native-host', path.join(app, 'factorio/bin/x64/factorio'), [...flags, '--start-server', path.join(host, 'data/saves/start.zip'), '--server-settings', path.join(host, 'server-settings.json'), '--rcon-bind', `127.0.0.1:${port}`, '--rcon-password', password])
  await connect(port)
  return { host, flags }
}
try {
  record.manifest = JSON.parse(await fs.readFile(path.join(app, 'manifest.json'), 'utf8'))
  assert.equal(record.manifest.source, record.source)
  for (const [name, expected] of Object.entries(record.manifest.files)) assert.equal(createHash('sha256').update(await fs.readFile(path.join(app, name))).digest('hex'), expected, name)
  const port = await freePort(), stubPort = await openStub()
  const env = { CONTAINER_ROOT: root, SGLUNA_HARNESS_MODE: mode, SGLUNA_ACTOR_MODE: 'npc', SGLUNA_CHAT_PLAYERS: 'none',
    SGLUNA_RCON_HOST: '127.0.0.1', SGLUNA_RCON_PORT: String(port), SGLUNA_RCON_PASSWORD: password,
    EXTERNAL_HARNESS_SESSION: session, EXTERNAL_HARNESS_STATE_DIR: path.join(output, 'ledger'),
    OPENAI_API_KEY: 'fixture-unused-placeholder', OPENAI_MODEL: 'deterministic-http-fixture', OPENAI_API_BASEURL: `http://127.0.0.1:${stubPort}/v1`, AI_API_METHOD: 'local' }
  let host
  if (mode !== 'plan') {
    host = await prepareHost(port)
    const binder = launch('installed-external-bind', process.execPath, [path.join(app, 'src/runtime-v8/external-harness-cli.mjs'), '--bind'], { ...env, SGLUNA_HARNESS_MODE: 'external' })
    assert.equal((await binder.closed).code, 0, binder.capture.stderr)
  }
  if (mode === 'pursuit') {
    const profilePath = path.join(output, 'profile.json')
    await fs.writeFile(profilePath, JSON.stringify({ runId: 'installed-startup', goalId: 'installed-pursuit', model: 'deterministic-http-fixture', brief: 'Issue one bounded wait, read its exact receipt, then ask native acceptance.', wallCapMs: 60000,
      goal: { scope: 'finite', summary: 'Hold one wood.', doneWhen: [{ id: 'wood', kind: 'inventory_count', item_name: 'wood', minimum: 1 }] }, options: { maxUnacceptedYields: 1 } }))
    env.SGLUNA_PURSUIT_PROFILE = profilePath; env.OPERATOR_PROVIDER_BASE = `http://127.0.0.1:${stubPort}/v1`; env.CLI_PROXY_GATEWAY_KEY = 'fixture-unused-placeholder'
  }
  runtime = launch('actual-installed-docker-start-sgluna', '/usr/local/bin/sgluna-docker-entrypoint', [], env)
  if (mode === 'plan') {
    await connect(port)
    for (let attempt = 0; attempt < 120 && !runtime.capture.stdout.includes('SGLuna Factorio ready;'); attempt++) {
      assert.equal(runtime.exitCode, null, runtime.capture.stderr); await sleep(250)
    }
    assert.match(runtime.capture.stdout, /SGLuna Factorio ready;/)
    record.ready = await status('installed-plan-ready')
    assert.equal(record.ready.guard.allowed, true); assert.equal(record.ready.guard.actor_kind, 'standalone_character')
    assert.equal(record.ready.humans, 0); assert.equal(record.ready.speed, 1); assert.equal(record.ready.status.task_state, 'idle'); assert.equal(record.ready.status.queue_length, 0)
    await sleep(1000); assert.equal(record.http.length, 0); assert.equal(record.httpFailure, undefined)
    await finish(runtime, 'SIGTERM'); assert.equal(runtime.capture.code, 0)
    assert.match(runtime.capture.stdout, /SGLuna Factorio stopped cleanly/)
    connection.close(); connection = null
    const saves = (await fs.readdir(path.join(root, 'saves'))).filter(name => name.endsWith('.zip'))
    assert.equal(saves.length, 1, 'fresh installed plan fixture has one saved world')
    await fs.copyFile(path.join(root, 'saves', saves[0]), path.join(output, 'checkpoint.zip'))
    const reloadRoot = path.join(output, 'reload')
    await fs.mkdir(path.join(reloadRoot, 'mods'), { recursive: true })
    await fs.cp(path.join(app, 'autorio'), path.join(reloadRoot, 'mods/autorio_0.1.0'), { recursive: true })
    await fs.writeFile(path.join(reloadRoot, 'config.ini'), `[path]\nread-data=${app}/factorio/data\nwrite-data=${reloadRoot}/data\n`)
    const reload = launch('exact-version-fresh-load', path.join(app, 'factorio/bin/x64/factorio'), ['--config', path.join(reloadRoot, 'config.ini'), '--mod-directory', path.join(reloadRoot, 'mods'), '--benchmark', path.join(output, 'checkpoint.zip'), '--benchmark-ticks', '1', '--benchmark-runs', '1'])
    assert.equal((await reload.closed).code, 0)
    assert.match(reload.capture.stdout, /Factorio 2\.1\.24/); record.reload = 'PASS'
  }
  else {
    if (mode === 'external') { await mcp(runtime); assert.equal(record.http.length, 0) }
    else {
      const closed = await bounded(runtime.closed, 45000)
      assert.ok(closed, 'pursuit startup exceeded bounded fixture')
      assert.equal(closed.code, 0, closed.stderr)
      record.controllerStop = JSON.parse(closed.stdout.trim().split('\n').at(-1))
      assert.equal(record.controllerStop.outcome, 'paused_operator_yielded_unaccepted'); assert.equal(record.http.length, 3); assert.equal(record.httpFailure, undefined)
    }
    record.ready = await status('completed-mode-native-idle')
    assert.equal(record.ready.humans, 0); assert.equal(record.ready.speed, 1); assert.equal(record.ready.status.task_state, 'idle'); assert.equal(record.ready.status.queue_length, 0)
    await command('strict-stop', 'remote.call("sgluna_deployment","cancel");remote.call("sgluna_deployment","disable");rcon.print(helpers.table_to_json(remote.call("sgluna_deployment","status")))')
    record.stopped = await status('post-stop')
    await command('quit-save', 'game.server_save()')
    await sleep(2000); await finish(engine, 'SIGTERM')
    const savePath = path.join(host.host, 'data/saves/start.zip')
    await fs.copyFile(savePath, path.join(output, 'checkpoint.zip'))
    connection.close(); connection = null
    const reload = launch('exact-version-fresh-load', path.join(app, 'factorio/bin/x64/factorio'), [...host.flags, '--benchmark', path.join(output, 'checkpoint.zip'), '--benchmark-ticks', '1', '--benchmark-runs', '1'])
    assert.equal((await reload.closed).code, 0)
    assert.match(reload.capture.stdout, /Factorio 2\.1\.24/); record.reload = 'PASS'
  }
  record.status = 'PASS'
}
catch (error) { record.status = 'FAIL'; record.failure = scrub(error.stack); process.exitCode = 1 }
finally {
  if (connection) {
    try { await command('failure-stop', 'if remote.interfaces.sgluna_deployment then remote.call("sgluna_deployment","cancel");remote.call("sgluna_deployment","disable") end;rcon.print("stopped")') } catch (error) { record.stopFailure = scrub(error.message) }
    connection.close()
  }
  const cleanupErrors = []
  for (const child of [...children]) { try { await finish(child) } catch (error) { cleanupErrors.push(scrub(error.message)) } }
  if (stub) await new Promise(resolve => stub.close(resolve))
  record.cleanup = { childProcessesExited: children.size === 0, errors: cleanupErrors }
  record.finished = new Date().toISOString()
  await persist()
  console.log(JSON.stringify({ mode, status: record.status, httpRequests: record.http.length, failure: record.failure, cleanup: record.cleanup }))
}
