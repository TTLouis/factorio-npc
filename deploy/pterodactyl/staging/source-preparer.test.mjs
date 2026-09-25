import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareNativeNpcSource } from './source-preparer.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airi-native-source-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const autorio = path.join(root, 'packages', 'autorio')
  await fs.mkdir(path.join(autorio, 'src', 'actors'), { recursive: true })
  for (const relative of [
    'packages/autorio/src/control.ts',
    'packages/autorio/src/tools.ts',
    'packages/autorio/src/actors/actor_controller.ts',
    'packages/autorio/tsconfig.json',
    'packages/autorio/package.json',
    'packages/autorio/data.lua',
    'packages/autorio/src/map_knowledge.ts',
  ]) {
    const destination = path.join(root, relative)
    await fs.copyFile(path.join(repo, relative), destination)
  }
  const guard = await fs.readFile(path.join(here, 'guard.ts'), 'utf8')
  return { root, autorio, guard }
}

test('preparer injects only the v8 deployment guard into the native validated Autorio source', async t => {
  const f = await fixture(t)
  const controlPath = path.join(f.autorio, 'src', 'control.ts')
  const before = await fs.readFile(controlPath, 'utf8')

  const result = await prepareNativeNpcSource(f.root, f.guard)
  const after = await fs.readFile(controlPath, 'utf8')
  const installedGuard = await fs.readFile(path.join(f.autorio, 'src', 'airi_deployment_guard.ts'), 'utf8')

  assert.equal(result.controller, 'native-actor-aware-autorio')
  assert.equal(result.mapKnowledge, 'bounded-5x5')
  assert.equal(result.patchedGameplaySemantics, false)
  assert.equal(after, `import './airi_deployment_guard'\n${before}`)
  assert.equal(installedGuard, f.guard)
  assert.equal(after.includes('airi_guarded_interface'), false)
  assert.equal(after.includes('airi_guard_ready'), false)
  assert.match(after, /new_navigation_controller/)
  assert.match(after, /new_crafting_controller/)
  assert.match(after, /new_research_controller/)
  assert.match(after, /new_combat_controller/)
})

test('preparer is idempotent and does not stack deployment imports', async t => {
  const f = await fixture(t)
  await prepareNativeNpcSource(f.root, f.guard)
  await prepareNativeNpcSource(f.root, f.guard)
  const control = await fs.readFile(path.join(f.autorio, 'src', 'control.ts'), 'utf8')
  assert.equal(control.split("import './airi_deployment_guard'").length - 1, 1)
})

test('preparer refuses legacy connected-player-patched or non-NPC source', async t => {
  const f = await fixture(t)
  const controlPath = path.join(f.autorio, 'src', 'control.ts')
  const actorPath = path.join(f.autorio, 'src', 'actors', 'actor_controller.ts')

  await fs.writeFile(controlPath, `${await fs.readFile(controlPath, 'utf8')}\nconst airi_guard_ready = true\n`)
  await assert.rejects(() => prepareNativeNpcSource(f.root, f.guard), /Legacy connected-player tick guard/)

  const clean = await fixture(t)
  await fs.writeFile(actorPath, (await fs.readFile(actorPath, 'utf8')).replace("get_actor_mode() === 'npc'", "get_actor_mode() === 'player'"))
  await assert.rejects(() => prepareNativeNpcSource(f.root, f.guard), /Native NPC actor selection is missing/)

  await assert.rejects(() => prepareNativeNpcSource(clean.root, 'remote.add_interface("airi_deployment", {})'), /Unexpected deployment guard revision/)
})

test('preparer fails closed if the bounded map-knowledge contract is missing, widened or the radar returns', async t => {
  const missing = await fixture(t)
  await fs.rm(path.join(missing.autorio, 'src', 'map_knowledge.ts'))
  await assert.rejects(() => prepareNativeNpcSource(missing.root, missing.guard), /NPC map knowledge is missing/)

  const widened = await fixture(t)
  const widenedPath = path.join(widened.autorio, 'src', 'map_knowledge.ts')
  await fs.writeFile(widenedPath, (await fs.readFile(widenedPath, 'utf8')).replace('KNOWLEDGE_CHUNK_RADIUS = 2', 'KNOWLEDGE_CHUNK_RADIUS = 6'))
  await assert.rejects(() => prepareNativeNpcSource(widened.root, widened.guard), /bounded to a 5x5 chunk window/)

  const radar = await fixture(t)
  const radarPath = path.join(radar.autorio, 'data.lua')
  await fs.appendFile(radarPath, '\nlocal radar = {name = "airi-npc-awareness-radar"}\n')
  await assert.rejects(() => prepareNativeNpcSource(radar.root, radar.guard), /removed NPC awareness radar prototype is present/)
})

test('preparer fails closed if the Autorio build stops packaging data.lua', async t => {
  const f = await fixture(t)
  const packagePath = path.join(f.autorio, 'package.json')
  const parsed = JSON.parse(await fs.readFile(packagePath, 'utf8'))
  parsed.scripts.build = 'tstl'
  await fs.writeFile(packagePath, `${JSON.stringify(parsed, null, 2)}\n`)

  await assert.rejects(() => prepareNativeNpcSource(f.root, f.guard), /Autorio build does not package data.lua/)
})
