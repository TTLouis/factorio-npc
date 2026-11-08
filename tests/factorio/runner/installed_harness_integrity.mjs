#!/usr/bin/env node
// One tampered installed prompt, in a disposable image filesystem. Startup must
// refuse integrity before contacting the native/provider tripwires in any mode.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

const mode = process.argv[2]
assert.ok(['external', 'plan', 'pursuit'].includes(mode))
const output = process.env.STARTUP_PROOF_DIR ?? '/proof', root = path.join(output, 'data')
const app = path.dirname(await fs.realpath('/opt/sgluna/start-sgluna.sh'))
const record = { mode, source: process.env.STARTUP_EXPECT_SOURCE, scenario: 'tampered-prompt-before-startup',
  runtimeEntry: '/usr/local/bin/sgluna-docker-entrypoint -> actual installed start-sgluna.sh',
  inferenceRequests: 0, nativeConnections: 0, http: [], status: 'RUNNING' }
const persist = () => fs.writeFile(path.join(output, 'RESULTS.json'), JSON.stringify(record, null, 2) + '\n')
let child
const native = net.createServer(socket => { record.nativeConnections++; socket.destroy() })
const provider = http.createServer((request, response) => { record.http.push({ method: request.method, url: request.url }); response.writeHead(500); response.end('tripwire') })
try {
  await fs.mkdir(root, { recursive: true })
  await new Promise(resolve => native.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const manifest = JSON.parse(await fs.readFile(path.join(app, 'manifest.json'), 'utf8'))
  assert.equal(manifest.source, record.source)
  const file = 'src/prompt.md', filename = path.join(app, file)
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  record.originalHash = hash(await fs.readFile(filename)); assert.equal(record.originalHash, manifest.files[file])
  await fs.appendFile(filename, '\n<!-- disposable startup integrity fixture -->\n')
  record.tamperedHash = hash(await fs.readFile(filename)); assert.notEqual(record.tamperedHash, manifest.files[file])
  const profilePath = path.join(output, 'profile.json')
  await fs.writeFile(profilePath, JSON.stringify({ runId: 'integrity-fixture', goalId: 'integrity-goal', model: 'deterministic-http-fixture', brief: 'Do not run: integrity must refuse first.', wallCapMs: 60000,
    goal: { scope: 'finite', summary: 'Hold one wood.', doneWhen: [{ id: 'wood', kind: 'inventory_count', item_name: 'wood', minimum: 1 }] } }))
  const base = `http://127.0.0.1:${provider.address().port}/v1`
  const env = { PATH: process.env.PATH, CONTAINER_ROOT: root, SGLUNA_HARNESS_MODE: mode, SGLUNA_ACTOR_MODE: 'npc', SGLUNA_CHAT_PLAYERS: 'none',
    SGLUNA_RCON_HOST: '127.0.0.1', SGLUNA_RCON_PORT: String(native.address().port), SGLUNA_RCON_PASSWORD: 'unused-fixture-placeholder',
    EXTERNAL_HARNESS_SESSION: 'external-integrity-fixture-00000000000000', EXTERNAL_HARNESS_STATE_DIR: path.join(output, 'ledger'),
    SGLUNA_PURSUIT_PROFILE: profilePath, OPERATOR_PROVIDER_BASE: base, CLI_PROXY_GATEWAY_KEY: 'unused-fixture-placeholder',
    OPENAI_API_KEY: 'unused-fixture-placeholder', OPENAI_MODEL: 'deterministic-http-fixture', OPENAI_API_BASEURL: base, AI_API_METHOD: 'local' }
  child = spawn('/usr/local/bin/sgluna-docker-entrypoint', [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  record.stdout = ''; record.stderr = ''
  child.stdout.on('data', chunk => { record.stdout += chunk })
  child.stderr.on('data', chunk => { record.stderr += chunk })
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  let timer
  const result = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(null), 12000) })])
  clearTimeout(timer)
  assert.ok(result, 'tampered release startup did not refuse promptly')
  record.exit = result
  record.integritySpecific = /release_integrity_failed|Release file integrity failed|installed release integrity/i.test(record.stderr)
  record.configCreated = await fs.stat(path.join(root, 'sgluna-config.json')).then(() => true, () => false)
  await persist()
  assert.notEqual(result.code, 0)
  assert.equal(record.integritySpecific, true, 'must report integrity refusal, not an unrelated config/transport failure')
  assert.equal(record.nativeConnections, 0, 'integrity must fence native connection')
  assert.equal(record.http.length, 0, 'integrity must fence provider connection')
  assert.equal(record.configCreated, false, 'integrity must fence lifecycle/config work')
  record.status = 'PASS'
}
catch (error) { record.status = 'FAIL'; record.failure = error.stack; process.exitCode = 1 }
finally {
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)) }
  await new Promise(resolve => native.close(resolve)); await new Promise(resolve => provider.close(resolve))
  record.cleanup = { childExited: !child || child.exitCode !== null || child.signalCode !== null }
  await persist()
  console.log(JSON.stringify({ mode, status: record.status, nativeConnections: record.nativeConnections, httpRequests: record.http.length, integritySpecific: record.integritySpecific, failure: record.failure }))
}
