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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sgluna-native-source-'))
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
    'packages/autorio/src/npc_vision.ts',
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
  const installedGuard = await fs.readFile(path.join(f.autorio, 'src', 'sgluna_deployment_guard.ts'), 'utf8')

  assert.equal(result.controller, 'native-actor-aware-autorio')
  assert.equal(result.mapKnowledge, 'bounded-5x5')
  assert.equal(result.patchedGameplaySemantics, false)
  assert.equal(after, `import './sgluna_deployment_guard'\n${before}`)
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
  assert.equal(control.split("import './sgluna_deployment_guard'").length - 1, 1)
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

  await assert.rejects(() => prepareNativeNpcSource(clean.root, 'remote.add_interface("sgluna_deployment", {})'), /Unexpected deployment guard revision/)
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

// The hidden NPC vision vehicle must not interact with the world at all, so each
// property that removes an interaction is a guard of its own.
const VISION_GUARDS = [
  { property: 'hidden', line: /^ *hidden = true,\r?\n/m, message: /vision vehicle must be hidden/ },
  { property: 'chunk_exploration_radius', line: /^ *chunk_exploration_radius = 2,\r?\n/m, message: /chunk_exploration_radius = 2/ },
  { property: 'collision_mask', line: /^ *collision_mask = \{ layers = \{\} \},\r?\n/m, message: /empty collision mask/ },
  { property: 'is_military_target', line: /^ *is_military_target = false,\r?\n/m, message: /not be a military target/ },
  { property: 'allow_passengers', line: /^ *allow_passengers = false,\r?\n/m, message: /not allow passengers/ },
  { property: 'energy_source', line: /^ *energy_source = \{ type = "void" \},\r?\n/m, message: /void energy source/ },
  { property: 'trigger_target_mask', line: /^ *trigger_target_mask = \{ "sgluna-untargetable" \},\r?\n/m, message: /untargetable trigger target type/ },
  { property: 'selectable_in_game', line: /^ *selectable_in_game = false,\r?\n/m, message: /must not be selectable/ },
]

async function visionFixture(t) {
  const f = await fixture(t)
  const dataPath = path.join(f.autorio, 'data.lua')
  return { ...f, dataPath, data: await fs.readFile(dataPath, 'utf8') }
}

test('preparer accepts the hidden NPC vision vehicle as shipped', async t => {
  const f = await visionFixture(t)
  for (const guard of VISION_GUARDS) assert.match(f.data, guard.line, `${guard.property} is present in the shipped prototype`)
  await prepareNativeNpcSource(f.root, f.guard)
})

for (const guard of VISION_GUARDS) {
  test(`preparer refuses the NPC vision vehicle without ${guard.property}`, async t => {
    const f = await visionFixture(t)
    await fs.writeFile(f.dataPath, f.data.replace(guard.line, ''))
    await assert.rejects(() => prepareNativeNpcSource(f.root, f.guard), guard.message)
  })
}

test('preparer refuses an unsafe value for each NPC vision vehicle guard', async t => {
  const widened = await visionFixture(t)
  await fs.writeFile(widened.dataPath, widened.data.replace('chunk_exploration_radius = 2,', 'chunk_exploration_radius = 3,'))
  await assert.rejects(() => prepareNativeNpcSource(widened.root, widened.guard), /chunk_exploration_radius = 2/)

  const military = await visionFixture(t)
  await fs.writeFile(military.dataPath, military.data.replace('is_military_target = false,', 'is_military_target = true,'))
  await assert.rejects(() => prepareNativeNpcSource(military.root, military.guard), /not be a military target/)

  const colliding = await visionFixture(t)
  await fs.writeFile(colliding.dataPath, colliding.data.replace('collision_mask = { layers = {} },', 'collision_mask = { layers = { object = true } },'))
  await assert.rejects(() => prepareNativeNpcSource(colliding.root, colliding.guard), /empty collision mask/)
})

test('preparer refuses an NPC vision vehicle that can be mined, placed, selected, driven or seen', async t => {
  for (const extra of [
    'minable = { mining_time = 1, result = "sgluna-npc-vision" },',
    'placeable_by = { item = "car", count = 1 },',
    'selection_box = {{-1, -1}, {1, 1}},',
    'animation = { layers = {} },',
    'guns = { "tank-cannon" },',
    'equipment_grid = "large-equipment-grid",',
    'light = { intensity = 1, size = 10 },',
    'corpse = "car-remnants",',
  ]) {
    const f = await visionFixture(t)
    await fs.writeFile(f.dataPath, f.data.replace('    hidden = true,', `    hidden = true,\n    ${extra}`))
    await assert.rejects(() => prepareNativeNpcSource(f.root, f.guard), /no minable, placeable_by, selection_box/, extra)
  }
})

test('preparer does not let a comment stand in for an NPC vision vehicle guard', async t => {
  const f = await visionFixture(t)
  await fs.writeFile(f.dataPath, f.data.replace(/^ *allow_passengers = false,\r?\n/m, '    -- allow_passengers = false,\n'))
  await assert.rejects(() => prepareNativeNpcSource(f.root, f.guard), /not allow passengers/)
})

test('preparer refuses a missing NPC vision vehicle, an item or recipe for it, or a missing lifecycle', async t => {
  const missing = await visionFixture(t)
  await fs.writeFile(missing.dataPath, missing.data.replace('name = "sgluna-npc-vision"', 'name = "sgluna-npc-vision-renamed"'))
  await assert.rejects(() => prepareNativeNpcSource(missing.root, missing.guard), /vision vehicle prototype is missing/)

  const item = await visionFixture(t)
  await fs.appendFile(item.dataPath, '\ndata:extend({{ type = "item", name = "sgluna-npc-vision", stack_size = 1 }})\n')
  await assert.rejects(() => prepareNativeNpcSource(item.root, item.guard), /name only its one prototype/)

  const noLifecycle = await visionFixture(t)
  await fs.rm(path.join(noLifecycle.autorio, 'src', 'npc_vision.ts'))
  await assert.rejects(() => prepareNativeNpcSource(noLifecycle.root, noLifecycle.guard), /vision vehicle lifecycle is missing/)
})
