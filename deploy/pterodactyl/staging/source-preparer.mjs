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
  const mapKnowledgePath = path.join(autorio, 'src', 'map_knowledge.ts')
  const packagePath = path.join(autorio, 'package.json')
  const guardPath = path.join(autorio, 'src', 'airi_deployment_guard.ts')

  const [controlOriginal, tools, actorController, tsconfigText, dataLua, packageText, mapKnowledge] = await Promise.all([
    fs.readFile(controlPath, 'utf8'),
    fs.readFile(toolsPath, 'utf8'),
    fs.readFile(actorPath, 'utf8'),
    fs.readFile(path.join(autorio, 'tsconfig.json'), 'utf8'),
    fs.readFile(dataPath, 'utf8'),
    fs.readFile(packagePath, 'utf8'),
    fs.readFile(mapKnowledgePath, 'utf8').catch(() => ''),
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
