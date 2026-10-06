import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export class SourcePreparationError extends Error {}

function check(ok, message) {
  if (!ok) throw new SourcePreparationError(message)
}

const NPC_VISION_NAME = 'sgluna-npc-vision'

// The hidden NPC vision vehicle must not interact with the world at all
// (docs/NPC_CHARACTER_ARCHITECTURE.md, "Map knowledge"). Each guard below is one
// property that removes an interaction; dropping or changing any of them
// refuses the package. Comments are stripped first so a comment cannot satisfy a guard.
function npcVisionPrototype(dataLua) {
  const code = dataLua
    .split(/\r?\n/)
    .map(line => line.replace(/--.*$/, ''))
    .join('\n')
  const start = code.search(new RegExp(`type = "car",\\s*name = "${NPC_VISION_NAME}"`))
  if (start < 0) return undefined
  // The prototype table closes on its own line, indented like the table it sits in.
  const end = code.indexOf('\n  },', start)
  return code.slice(start, end < 0 ? undefined : end)
}

function checkNpcVisionPrototype(dataLua, runtimeSource) {
  const prototype = npcVisionPrototype(dataLua)
  check(prototype !== undefined, 'The NPC vision vehicle prototype is missing')
  check(dataLua.split(`name = "${NPC_VISION_NAME}"`).length === 2, 'The NPC vision vehicle name must name only its one prototype (no item, recipe or technology)')
  const has = pattern => pattern.test(prototype)
  check(has(/^\s*hidden = true,$/m), 'The NPC vision vehicle must be hidden')
  check(has(/^\s*chunk_exploration_radius = 2,$/m), 'The NPC vision vehicle must chart exactly a 5x5 chunk window (chunk_exploration_radius = 2)')
  check(has(/^\s*collision_mask = \{ layers = \{\} \},$/m), 'The NPC vision vehicle must have an empty collision mask')
  check(has(/^\s*is_military_target = false,$/m), 'The NPC vision vehicle must not be a military target')
  check(has(/^\s*allow_passengers = false,$/m), 'The NPC vision vehicle must not allow passengers')
  check(has(/^\s*energy_source = \{ type = "void" \},$/m), 'The NPC vision vehicle must have a void energy source')
  check(has(/^\s*trigger_target_mask = \{ "sgluna-untargetable" \},$/m), 'The NPC vision vehicle must carry only the untargetable trigger target type')
  check(has(/^\s*selectable_in_game = false,$/m), 'The NPC vision vehicle must not be selectable')
  check(!has(/\b(?:minable|placeable_by|selection_box|animation|pictures|guns|equipment_grid|light|working_sound|corpse|dying_explosion)\s*=/), 'The NPC vision vehicle must have no minable, placeable_by, selection_box, graphics, guns, equipment grid, light, sound or corpse')
  check(runtimeSource.includes(`export const NPC_VISION_ENTITY_NAME = '${NPC_VISION_NAME}'`), 'The NPC vision vehicle lifecycle is missing')
}

export async function prepareNativeNpcSource(sourceRoot, guardSource) {
  check(typeof sourceRoot === 'string' && sourceRoot.length > 0, 'Source root is required')
  check(typeof guardSource === 'string' && guardSource.length > 0, 'Deployment guard source is required')

  const autorio = path.join(sourceRoot, 'packages', 'autorio')
  const controlPath = path.join(autorio, 'src', 'control.ts')
  const toolsPath = path.join(autorio, 'src', 'tools.ts')
  const actorPath = path.join(autorio, 'src', 'actors', 'actor_controller.ts')
  const dataPath = path.join(autorio, 'data.lua')
  const mapKnowledgePath = path.join(autorio, 'src', 'map_knowledge.ts')
  const npcVisionPath = path.join(autorio, 'src', 'npc_vision.ts')
  const packagePath = path.join(autorio, 'package.json')
  const guardPath = path.join(autorio, 'src', 'sgluna_deployment_guard.ts')

  const [controlOriginal, tools, actorController, tsconfigText, dataLua, packageText, mapKnowledge, npcVision] = await Promise.all([
    fs.readFile(controlPath, 'utf8'),
    fs.readFile(toolsPath, 'utf8'),
    fs.readFile(actorPath, 'utf8'),
    fs.readFile(path.join(autorio, 'tsconfig.json'), 'utf8'),
    fs.readFile(dataPath, 'utf8'),
    fs.readFile(packagePath, 'utf8'),
    fs.readFile(mapKnowledgePath, 'utf8').catch(() => ''),
    fs.readFile(npcVisionPath, 'utf8').catch(() => ''),
  ])

  // Fail closed if the pinned source is not the native actor-aware runtime we
  // actually validated. v8 must not recreate the v7 connected-player patch set.
  check(controlOriginal.includes("remote.add_interface('autorio_operations'"), 'Native Autorio operations interface is missing')
  check(controlOriginal.includes('new_navigation_controller'), 'Native bounded navigation controller is missing')
  check(controlOriginal.includes('new_crafting_controller'), 'Native bounded crafting controller is missing')
  check(controlOriginal.includes('new_research_controller'), 'Native bounded research controller is missing')
  check(controlOriginal.includes('new_combat_controller'), 'Native bounded combat controller is missing')
  check(tools.includes('create_actor_remote_interface()'), 'Native actor interface is not wired through Autorio tools')
  check(actorController.includes("mode !== 'player' && mode !== 'npc'"), 'Native NPC actor mode control is missing')
  check(actorController.includes("get_actor_mode() === 'npc'"), 'Native NPC actor selection is missing')
  check(actorController.includes('StandaloneCharacterActor.create'), 'Standalone NPC creation is missing')
  check(!controlOriginal.includes('airi_guarded_interface'), 'Legacy guarded-interface patch is already present')
  check(!controlOriginal.includes('airi_guard_ready'), 'Legacy connected-player tick guard is already present')

  // The standalone NPC keeps its own bounded map knowledge instead of the
  // hidden radar, which charted nothing with zero connected players
  // (docs/NPC_CHARACTER_ARCHITECTURE.md, "Map knowledge"). Keep the contract
  // explicit so a stale package cannot reintroduce the radar or grow the window.
  check(!dataLua.includes('airi-npc-awareness-radar'), 'The removed NPC awareness radar prototype is present')
  check(mapKnowledge.includes('export function is_chunk_known_visible'), 'NPC map knowledge is missing')
  check(/^export const KNOWLEDGE_CHUNK_RADIUS = 2\r?$/m.test(mapKnowledge), 'NPC map knowledge must stay bounded to a 5x5 chunk window')
  // Live vision comes from one hidden vehicle that must not interact with the world.
  checkNpcVisionPrototype(dataLua, npcVision)

  let packageJson
  try { packageJson = JSON.parse(packageText) }
  catch { throw new SourcePreparationError('Invalid Autorio package.json') }
  check(typeof packageJson?.scripts?.build === 'string' && packageJson.scripts.build.includes("copyFileSync('data.lua','dist/data.lua')"), 'Autorio build does not package data.lua')

  let tsconfig
  try { tsconfig = JSON.parse(tsconfigText) }
  catch { throw new SourcePreparationError('Invalid Autorio tsconfig.json') }
  check(tsconfig?.tstl?.luaBundle === 'control.lua' && tsconfig?.tstl?.luaBundleEntry === 'src/control.ts', 'Unexpected Autorio Lua bundle configuration')

  check(guardSource.includes("revision: 'sgluna-deploy-v8-npc-staging'"), 'Unexpected deployment guard revision')
  check(guardSource.includes("remote.call('autorio_actor', 'set_mode', mode)"), 'Deployment guard does not select native actor mode')
  check(guardSource.includes("actor.kind === 'standalone_character'"), 'Deployment guard does not authorize standalone NPC ownership')

  const importLine = "import './sgluna_deployment_guard'\n"
  const control = controlOriginal.startsWith(importLine)
    ? controlOriginal
    : `${importLine}${controlOriginal}`

  await fs.writeFile(controlPath, control)
  await fs.writeFile(guardPath, guardSource)

  return {
    controller: 'native-actor-aware-autorio',
    deploymentGuard: 'sgluna-deploy-v8-npc-staging',
    actorMode: 'npc',
    mapKnowledge: 'bounded-5x5',
    patchedGameplaySemantics: false,
    controlPath,
    dataPath,
    guardPath,
  }
}

async function main() {
  const [sourceRoot, guardPath] = process.argv.slice(2)
  check(sourceRoot && guardPath, 'Usage: node source-preparer.mjs <source-root> <guard.ts>')
  const guardSource = await fs.readFile(guardPath, 'utf8')
  const result = await prepareNativeNpcSource(path.resolve(sourceRoot), guardSource)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
