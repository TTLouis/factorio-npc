import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { chatAuthorized, describeChatPlayers } from './common.mjs'
import { providerEndpoint } from './provider.mjs'
import { configuration, deploymentCompatibilityWarnings, factorioVisibilityDiagnostics, installedAppRoot, Session } from './supervisor.mjs'

async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-v8-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

const baseEnv = {
  SGLUNA_ACTOR_MODE: 'npc',
  AIRI_CHAT_PLAYER: 'Louis',
  OPENAI_API_KEY: 'test-key-1234',
  OPENAI_MODEL: 'test-model',
  OPENAI_API_BASEURL: 'https://api.example.test/v1',
  SERVER_PORT: '34197',
}

test('configuration defaults to standalone NPC and keeps chat authorization separate', () => {
  const config = configuration({}, baseEnv)
  assert.equal(config.actorMode, 'npc')
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['Louis'] })
  assert.equal(config.gamePort, 34197)
  const explicitBlank = configuration({}, { ...baseEnv, AIRI_CHAT_PLAYER: '', AIRI_PLAYER: 'LegacyName' })
  assert.deepEqual(explicitBlank.chatPlayers, { mode: 'all', names: [] })
  const aliasEnv = { ...baseEnv, AIRI_PLAYER: 'LegacyName' }
  delete aliasEnv.AIRI_CHAT_PLAYER
  const alias = configuration({}, aliasEnv)
  assert.deepEqual(alias.chatPlayers, { mode: 'allowlist', names: ['LegacyName'] })
  assert.throws(() => configuration({}, { ...baseEnv, SGLUNA_ACTOR_MODE: 'player' }))
})

test('SGLUNA deployment variables override AIRI compatibility values deterministically', () => {
  const env = {
    ...baseEnv,
    SGLUNA_ACTOR_MODE: 'npc',
    AIRI_ACTOR_MODE: 'player',
    SGLUNA_CHAT_PLAYERS: 'TTLouis',
    AIRI_CHAT_PLAYERS: 'Legacy',
  }
  const config = configuration({}, env)
  assert.equal(config.actorMode, 'npc')
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['TTLouis'] })
  assert.deepEqual(deploymentCompatibilityWarnings(env), [
    'SGLUNA_ACTOR_MODE overrides conflicting compatibility value AIRI_ACTOR_MODE.',
    'SGLUNA_CHAT_PLAYERS overrides conflicting compatibility value AIRI_CHAT_PLAYERS.',
  ])
})

test('legacy AIRI deployment variables remain accepted when SGLUNA variables are absent', () => {
  const env = { ...baseEnv }
  delete env.SGLUNA_ACTOR_MODE
  env.AIRI_ACTOR_MODE = 'npc'
  env.AIRI_CHAT_PLAYERS = 'Legacy'
  const config = configuration({}, env)
  assert.equal(config.actorMode, 'npc')
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['Legacy'] })
})

test('explicit blank SGLUNA_CHAT_PLAYERS overrides non-blank AIRI compatibility values', () => {
  const config = configuration({}, { ...baseEnv, SGLUNA_CHAT_PLAYERS: '', AIRI_CHAT_PLAYERS: 'Legacy' })
  assert.deepEqual(config.chatPlayers, { mode: 'all', names: [] })
})

test('SGLUNA_CHAT_PLAYERS blank or "*" allows every player', () => {
  const blank = configuration({}, { ...baseEnv, SGLUNA_CHAT_PLAYERS: '' })
  assert.deepEqual(blank.chatPlayers, { mode: 'all', names: [] })
  assert.equal(chatAuthorized(blank.chatPlayers, 'AnyoneAtAll'), true)
  const wildcard = configuration({}, { ...baseEnv, SGLUNA_CHAT_PLAYERS: '*' })
  assert.deepEqual(wildcard.chatPlayers, { mode: 'all', names: [] })
  assert.equal(chatAuthorized(wildcard.chatPlayers, 'AnyoneAtAll'), true)
})

test('SGLUNA_CHAT_PLAYERS "none" disables every player', () => {
  const config = configuration({}, { ...baseEnv, SGLUNA_CHAT_PLAYERS: 'none' })
  assert.deepEqual(config.chatPlayers, { mode: 'disabled', names: [] })
  assert.equal(chatAuthorized(config.chatPlayers, 'Louis'), false)
})

test('SGLUNA_CHAT_PLAYERS supports a single-name allowlist', () => {
  const config = configuration({}, { ...baseEnv, SGLUNA_CHAT_PLAYERS: 'TTLouis' })
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['TTLouis'] })
  assert.equal(chatAuthorized(config.chatPlayers, 'TTLouis'), true)
  assert.equal(chatAuthorized(config.chatPlayers, 'Alice'), false)
})

test('SGLUNA_CHAT_PLAYERS supports a multi-name allowlist and trims/dedupes whitespace', () => {
  const config = configuration({}, { ...baseEnv, SGLUNA_CHAT_PLAYERS: ' TTLouis , Alice ,,Bob, Alice ' })
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['TTLouis', 'Alice', 'Bob'] })
  assert.equal(chatAuthorized(config.chatPlayers, 'TTLouis'), true)
  assert.equal(chatAuthorized(config.chatPlayers, 'Alice'), true)
  assert.equal(chatAuthorized(config.chatPlayers, 'Bob'), true)
})

test('SGLUNA_CHAT_PLAYERS rejects a player not on the allowlist', () => {
  const config = configuration({}, { ...baseEnv, SGLUNA_CHAT_PLAYERS: 'TTLouis,Alice' })
  assert.equal(chatAuthorized(config.chatPlayers, 'Eve'), false)
})

test('AIRI_CHAT_PLAYERS takes priority over the legacy AIRI_CHAT_PLAYER fallback', () => {
  const config = configuration({}, { ...baseEnv, AIRI_CHAT_PLAYER: 'Legacy', AIRI_CHAT_PLAYERS: 'TTLouis' })
  assert.deepEqual(config.chatPlayers, { mode: 'allowlist', names: ['TTLouis'] })
})

test('AIRI_CHAT_PLAYERS explicitly blank does not fall back to a non-blank legacy AIRI_CHAT_PLAYER', () => {
  const config = configuration({}, { ...baseEnv, AIRI_CHAT_PLAYER: 'Legacy', AIRI_CHAT_PLAYERS: '' })
  assert.deepEqual(config.chatPlayers, { mode: 'all', names: [] })
  assert.equal(chatAuthorized(config.chatPlayers, 'AnyoneAtAll'), true)
  assert.equal(chatAuthorized(config.chatPlayers, 'Legacy'), true)
})

test('Factorio account: blank username and token is a hidden server', () => {
  const config = configuration({}, baseEnv)
  assert.deepEqual(config.factorio, { username: '', token: '', public: false })
})

test('Factorio account: matching username and token publishes the server', () => {
  const config = configuration({}, { ...baseEnv, FACTORIO_USERNAME: 'ttlouis', FACTORIO_TOKEN: 'dummy-token-1234' })
  assert.deepEqual(config.factorio, { username: 'ttlouis', token: 'dummy-token-1234', public: true })
})

test('Factorio account: only one of username/token supplied fails configuration', () => {
  assert.throws(() => configuration({}, { ...baseEnv, FACTORIO_USERNAME: 'ttlouis' }))
  assert.throws(() => configuration({}, { ...baseEnv, FACTORIO_TOKEN: 'dummy-token-1234' }))
})

test('Factorio visibility diagnostics report state without exposing credentials', () => {
  const token = 'never-print-this-token'
  const publicText = factorioVisibilityDiagnostics({ username: 'ttlouis', token, public: true }).join('\n')
  assert.match(publicText, /Factorio visibility: PUBLIC/)
  assert.doesNotMatch(publicText, /ttlouis|never-print-this-token/)
  const privateText = factorioVisibilityDiagnostics({ username: '', token: '', public: false }).join('\n')
  assert.match(privateText, /Factorio visibility: PRIVATE\/HIDDEN/)
  assert.match(privateText, /No Factorio listing credentials supplied/)
})

test('Factorio account: a stored factorioUsername in airi-config.json is never read', () => {
  const config = configuration({ factorioUsername: 'stored-old-username' }, baseEnv)
  assert.equal(config.factorio.username, '')
  assert.equal(config.factorio.public, false)
})

test('provider base URL: env OPENAI_API_BASEURL overrides a stored providerUrl', () => {
  const config = configuration({ providerUrl: 'https://stored.example/v1' }, { ...baseEnv, OPENAI_API_BASEURL: 'https://env-override.example/v1' })
  assert.equal(config.base, 'https://env-override.example/v1')
})

test('provider base URL: a stored providerUrl is used when no env override is set', () => {
  const envWithoutBase = { ...baseEnv }
  delete envWithoutBase.OPENAI_API_BASEURL
  const config = configuration({ providerUrl: 'https://stored.example/v1' }, envWithoutBase)
  assert.equal(config.base, 'https://stored.example/v1')
})

test('startup chat summary is understandable without logging the allowlist itself', () => {
  assert.equal(describeChatPlayers({ mode: 'all', names: [] }), 'all')
  assert.equal(describeChatPlayers({ mode: 'disabled', names: [] }), 'disabled')
  assert.equal(describeChatPlayers({ mode: 'allowlist', names: ['TTLouis', 'Alice', 'Bob'] }), 'allowlist:3')
})

test('cleanEnv strips the Factorio auth token from the game child process environment', () => {
  process.env.FACTORIO_TOKEN = 'super-secret-token'
  process.env.FACTORIO_USERNAME = 'ttlouis'
  try {
    const session = new Session({ root: '/tmp/airi-root', app: '/tmp/app', game: '/tmp/game', config: configuration({}, baseEnv), save: 'x', settingsFile: 'x', modDir: 'x', ini: 'x' })
    const env = session.cleanEnv()
    assert.equal(env.FACTORIO_TOKEN, undefined)
    assert.equal(env.FACTORIO_USERNAME, 'ttlouis')
  }
  finally {
    delete process.env.FACTORIO_TOKEN
    delete process.env.FACTORIO_USERNAME
  }
})

test('installed supervisor resolves the release root above src/runtime-v8', () => {
  const moduleUrl = pathToFileURL('/srv/.airi/releases/v8/src/runtime-v8/supervisor.mjs').href
  assert.equal(installedAppRoot(moduleUrl), path.resolve('/srv/.airi/releases/v8'))
})

test('provider URL is HTTPS remotely and may be loopback HTTP', () => {
  assert.equal(providerEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(providerEndpoint('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1/chat/completions')
  assert.equal(providerEndpoint('http://host.docker.internal:1234/v1'), 'http://host.docker.internal:1234/v1/chat/completions')
  assert.throws(() => providerEndpoint('http://example.com/v1'))
  assert.throws(() => providerEndpoint('https://user:pass@example.com/v1'))
})

const fakeFactorio = `#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
const args=process.argv.slice(2);const get=n=>{const i=args.indexOf(n);return i>=0?args[i+1]:undefined};
const binding=get('--rcon-bind');const password=get('--rcon-password');const save=get('--start-server');
let session='',mode='player',actorId=18,epoch=0,stopping=false,configureCommand='';const sockets=new Set();
function packet(id,type,text){const body=Buffer.from(String(text));const b=Buffer.alloc(body.length+14);b.writeInt32LE(body.length+10,0);b.writeInt32LE(id,4);b.writeInt32LE(type,8);body.copy(b,12);return b}
function status(){return {revision:'airi-deploy-v8-npc-staging',session,mode,actor_id:actorId,actor_kind:mode==='npc'?'standalone_character':'connected_player',connected_players:0,allowed:!!session&&mode==='npc',idle:true,epoch,tools:true,operations:true,actor_interface:true}}
const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buffer=Buffer.alloc(0),auth=false;socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const size=buffer.readInt32LE(0);if(buffer.length<size+4)break;const msg=buffer.subarray(4,size+4);buffer=buffer.subarray(size+4);const id=msg.readInt32LE(0),type=msg.readInt32LE(4),text=msg.subarray(8,-2).toString();if(type===3){auth=text===password;socket.write(packet(auth?id:-1,2,''));continue}if(!auth){socket.destroy();return}let response='';if(text==='/version')response='Version: 2.0.77 (fixture)';else if(text.includes('"configure","npc"')){if(!configureCommand){configureCommand=text;response='Player <server> tried using the command '+text+'. Lua console commands will disable achievements. Please repeat the command to proceed.'}else if(text!==configureCommand){response='configure command was not repeated exactly'}else{const m=text.match(/"configure","npc",("(?:[^"\\\\]|\\\\.)*")/);const marker=(text.match(/AIRI_CONFIG_[a-f0-9]{24}:/)||[])[0];if(!m||!marker){response='invalid configure fixture command'}else{session=JSON.parse(m[1]);mode='npc';epoch++;response=marker+JSON.stringify({ok:true,result:session})}}}else if(text.includes('"airi_deployment","status"'))response=JSON.stringify(status());else if(text.includes('"airi_deployment","cancel"')){epoch++;response='true'}else if(text==='/quit'){if(save)fs.appendFileSync(save,'quit-saved');response='Quitting';setTimeout(()=>{console.log('Goodbye');stop()},10)}else if(text==='/server-save'){if(save)fs.appendFileSync(save,'saved');response='Saving map'}else response='ok';const out=packet(id,0,response);socket.write(out.subarray(0,3));socket.write(out.subarray(3))}})});
server.listen(Number(binding.split(':').pop()),'127.0.0.1',()=>console.log('Fixture Factorio ready'));
function stop(){if(stopping)return;stopping=true;for(const s of sockets)s.destroy();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),100)};process.on('SIGINT',stop);process.on('SIGTERM',stop);setInterval(()=>{},1000);
`

test('session starts zero-player standalone NPC over authenticated loopback RCON, handles the first-Lua confirmation, and quits cleanly through Factorio', async t => {
  const root = await temp(t)
  const app = path.join(root, 'app')
  const game = path.join(app, 'factorio')
  const bin = path.join(game, 'bin', 'x64')
  await fsp.mkdir(path.join(app, 'src'), { recursive: true })
  await fsp.mkdir(bin, { recursive: true })
  await fsp.writeFile(path.join(app, 'src', 'prompt.md'), 'NPC prompt')
  const executable = path.join(bin, 'factorio')
  await fsp.writeFile(executable, fakeFactorio, { mode: 0o755 })
  const save = path.join(root, 'world.zip')
  await fsp.writeFile(save, 'PKfixture')
  const settingsFile = path.join(root, 'server-settings.json')
  const ini = path.join(root, 'config.ini')
  const modDir = path.join(root, 'mods-run')
  await fsp.mkdir(modDir)
  await fsp.writeFile(settingsFile, '{}')
  await fsp.writeFile(ini, '[path]\n')
  const logs = []
  const config = configuration({}, { ...baseEnv, SERVER_PORT: '34198' })
  const session = new Session({ root, app, game, config, save, settingsFile, modDir, ini, log: line => logs.push(line), provider: async () => { throw new Error('provider should not be called') }, startupMs: 10000 })
  const status = await session.start()
  assert.equal(status.mode, 'npc')
  assert.equal(status.actor_kind, 'standalone_character')
  assert.equal(status.connected_players, 0)
  assert.equal(status.allowed, true)
  assert.match(logs.find(line => line.includes('SGLuna Factorio ready')) ?? '', /SGLuna Factorio ready; npc=AIRI \(airi\), actor_id=18/)

  let reserveAuthorizationChecks = 0
  session.ensureAuthorization = async () => {
    reserveAuthorizationChecks++
    throw new Error('provider budget reserve must not reauthorize the NPC')
  }
  await session.agent.reserve({ epoch: status.epoch, actorId: status.actor_id })
  assert.equal(reserveAuthorizationChecks, 0)

  const clean = await session.stop('requested')
  assert.equal(clean, true)
  const saved = await fsp.readFile(save, 'utf8')
  assert.match(saved, /quit-saved/)
  assert.ok(logs.some(line => line.includes('Goodbye')))
})

test('chat authorization triggers provider path only for configured requester', async t => {
  const root = await temp(t)
  const config = configuration({}, baseEnv)
  const session = new Session({ root, app: root, game: root, config, save: 'x', settingsFile: 'x', modDir: 'x', ini: 'x', log: () => {} })
  const requests = []
  const prints = []
  session.ready = true
  session.rcon = { command: async text => { prints.push(text); return 'ok' } }
  session.ensureAuthorization = async () => ({ actor_id: 18, epoch: 3 })
  session.agent = {
    active: false,
    request: async text => { requests.push(text); return { chatMessage: 'Accepted.' } },
    completed: async () => null,
    cancel: () => {},
  }
  session.onGameLine('2026-09-13 20:00:00 [CHAT] SomeoneElse: !airi wait')
  await session.eventQueue
  assert.deepEqual(requests, [])
  session.onGameLine('2026-09-13 20:00:01 [CHAT] Louis: !airi wait')
  await session.eventQueue
  assert.deepEqual(requests, ['wait'])
  assert.ok(prints.some(text => text.includes('[AIRI] Accepted.')))
})
