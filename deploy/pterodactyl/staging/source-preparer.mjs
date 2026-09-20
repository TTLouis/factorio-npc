import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export class SourcePreparationError extends Error {}

function check(ok, message) {
  if (!ok) throw new SourcePreparationError(message)
}

export async function prepareNativeNpcSource(sourceRoot, guardSource) {
  check(typeof sourceRoot === 'string' && sourceRoot.length > 0, 'Source root is required')
  check(typeof guardSource === 'string' && guardSource.length > 0, 'Deployment guard source is required')

  const autorio = path.join(sourceRoot, 'packages', 'autorio')
  const controlPath = path.join(autorio, 'src', 'control.ts')
  const toolsPath = path.join(autorio, 'src', 'tools.ts')
  const actorPath = path.join(autorio, 'src', 'actors', 'actor_controller.ts')
  const dataPath = path.join(autorio, 'data.lua')
  const packagePath = path.join(autorio, 'package.json')
  const guardPath = path.join(autorio, 'src', 'airi_deployment_guard.ts')

  const [controlOriginal, tools, actorController, tsconfigText, dataLua, packageText] = await Promise.all([
    fs.readFile(controlPath, 'utf8'),
    fs.readFile(toolsPath, 'utf8'),
    fs.readFile(actorPath, 'utf8'),
    fs.readFile(path.join(autorio, 'tsconfig.json'), 'utf8'),
    fs.readFile(dataPath, 'utf8'),
    fs.readFile(packagePath, 'utf8'),
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

  // The standalone NPC's fog-of-war awareness is implemented as a hidden,
  // engine-native RadarPrototype. Keep this deployment contract explicit so a
  // stale package cannot silently omit data.lua, grow the scan window, or
  // reintroduce inherited world graphics/ground decals.
  check(dataLua.includes('airi-npc-awareness-radar'), 'NPC awareness radar prototype is missing')
  check(dataLua.includes('max_distance_of_sector_revealed = 1'), 'NPC awareness radar sector scan must stay bounded to a 3x3 chunk window')
  check(dataLua.includes('max_distance_of_nearby_sector_revealed = 1'), 'NPC awareness radar nearby scan must stay bounded to a 3x3 chunk window')
  check(dataLua.includes('energy_source = {type = "void"}'), 'NPC awareness radar must not depend on the electric network')
  check(dataLua.includes('radar.pictures = nil'), 'NPC awareness radar must not render the inherited radar sprite/shadow')
  check(dataLua.includes('radar.integration_patch = nil'), 'NPC awareness radar must not render the inherited ground integration patch')
  check(dataLua.includes('radar.water_reflection = nil'), 'NPC awareness radar must not render an inherited water reflection')

  let packageJson
  try { packageJson = JSON.parse(packageText) }
  catch { throw new SourcePreparationError('Invalid Autorio package.json') }
  check(typeof packageJson?.scripts?.build === 'string' && packageJson.scripts.build.includes("copyFileSync('data.lua','dist/data.lua')"), 'Autorio build does not package data.lua')

  let tsconfig
  try { tsconfig = JSON.parse(tsconfigText) }
  catch { throw new SourcePreparationError('Invalid Autorio tsconfig.json') }
  check(tsconfig?.tstl?.luaBundle === 'control.lua' && tsconfig?.tstl?.luaBundleEntry === 'src/control.ts', 'Unexpected Autorio Lua bundle configuration')

  check(guardSource.includes("revision: 'airi-deploy-v8-npc-staging'"), 'Unexpected deployment guard revision')
  check(guardSource.includes("remote.call('autorio_actor', 'set_mode', mode)"), 'Deployment guard does not select native actor mode')
  check(guardSource.includes("actor.kind === 'standalone_character'"), 'Deployment guard does not authorize standalone NPC ownership')

  const importLine = "import './airi_deployment_guard'\n"
  const control = controlOriginal.startsWith(importLine)
    ? controlOriginal
    : `${importLine}${controlOriginal}`

  await fs.writeFile(controlPath, control)
  await fs.writeFile(guardPath, guardSource)

  return {
    controller: 'native-actor-aware-autorio',
    deploymentGuard: 'airi-deploy-v8-npc-staging',
    actorMode: 'npc',
    awarenessRadar: 'airi-npc-awareness-radar',
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
