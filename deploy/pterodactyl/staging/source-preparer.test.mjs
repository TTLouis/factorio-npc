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
  assert.equal(result.awarenessRadar, 'airi-npc-awareness-radar')
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

test('preparer fails closed if the hidden 3x3 radar data-stage contract is missing or unbounded', async t => {
  const missingName = await fixture(t)
  const missingNamePath = path.join(missingName.autorio, 'data.lua')
  await fs.writeFile(missingNamePath, (await fs.readFile(missingNamePath, 'utf8')).replace('airi-npc-awareness-radar', 'renamed-radar'))
  await assert.rejects(() => prepareNativeNpcSource(missingName.root, missingName.guard), /NPC awareness radar prototype is missing/)

  const longRange = await fixture(t)
  const longRangePath = path.join(longRange.autorio, 'data.lua')
  await fs.writeFile(longRangePath, (await fs.readFile(longRangePath, 'utf8')).replace('max_distance_of_sector_revealed = 0', 'max_distance_of_sector_revealed = 14'))
  await assert.rejects(() => prepareNativeNpcSource(longRange.root, longRange.guard), /must disable long-range sector scanning/)

  const oversized = await fixture(t)
  const oversizedPath = path.join(oversized.autorio, 'data.lua')
  await fs.writeFile(oversizedPath, (await fs.readFile(oversizedPath, 'utf8')).replace('max_distance_of_nearby_sector_revealed = 1', 'max_distance_of_nearby_sector_revealed = 3'))
  await assert.rejects(() => prepareNativeNpcSource(oversized.root, oversized.guard), /nearby scan must stay bounded to a 3x3 chunk window/)
})

test('preparer fails closed if the Autorio build stops packaging data.lua', async t => {
  const f = await fixture(t)
  const packagePath = path.join(f.autorio, 'package.json')
  const parsed = JSON.parse(await fs.readFile(packagePath, 'utf8'))
  parsed.scripts.build = 'tstl'
  await fs.writeFile(packagePath, `${JSON.stringify(parsed, null, 2)}\n`)

  await assert.rejects(() => prepareNativeNpcSource(f.root, f.guard), /Autorio build does not package data.lua/)
})
