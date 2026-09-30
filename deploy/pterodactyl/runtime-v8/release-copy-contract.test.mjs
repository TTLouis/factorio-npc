import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pterodactylRoot = path.dirname(here)
const installerPath = path.join(pterodactylRoot, 'payload-src', 'installer.sh')

function installerCopySet(installer, sourceDirectory, destinationDirectory) {
  const marker = `cp "$WORK/source/deploy/pterodactyl/${sourceDirectory}/$file" "$APP/src/${destinationDirectory}/$file"`
  const markerIndex = installer.indexOf(marker)
  assert.notEqual(markerIndex, -1, `installer copy contract for ${sourceDirectory} was not found`)
  const loopStart = installer.lastIndexOf('for file in ', markerIndex)
  const loopEnd = installer.indexOf('; do', loopStart)
  assert.ok(loopStart >= 0 && loopEnd > loopStart, `installer copy loop for ${sourceDirectory} is malformed`)
  return installer.slice(loopStart + 'for file in '.length, loopEnd).trim().split(/\s+/)
}

function localMjsDependencies(source) {
  const dependencies = new Set()
  const fromPattern = /\bfrom\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]/g
  const sideEffectPattern = /\bimport\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]/g
  const dynamicPattern = /\bimport\(\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]\s*\)/g
  for (const pattern of [fromPattern, sideEffectPattern, dynamicPattern]) {
    for (const match of source.matchAll(pattern)) dependencies.add(match[1])
  }
  return dependencies
}

async function assertLocalDependencyClosure(root, copiedFiles) {
  const copied = new Set(copiedFiles.map(filename => path.resolve(filename)))
  for (const filename of copied) {
    const source = await fsp.readFile(filename, 'utf8')
    for (const specifier of localMjsDependencies(source)) {
      const dependency = path.resolve(path.dirname(filename), specifier)
      assert.ok(
        copied.has(dependency),
        `${path.relative(root, filename)} requires ${specifier}, but the installer does not ship ${path.relative(root, dependency)}`,
      )
    }
  }
}

test('installer-shipped runtime is transitively complete and preserves structured policy', async () => {
  const installer = await fsp.readFile(installerPath, 'utf8')
  const runtimeFiles = installerCopySet(installer, 'runtime-v8', 'runtime-v8')
  const stagingFiles = installerCopySet(installer, 'staging', 'staging')
  assert.ok(runtimeFiles.includes('outcome-authority.mjs'), 'installer must ship the runtime outcome authority module')
  assert.ok(runtimeFiles.includes('recovery-route.mjs'), 'installer must ship the runtime recovery router module')
  assert.ok(runtimeFiles.includes('step-completion.mjs'), 'installer must ship the runtime step completion module')
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-release-copy-'))

  try {
    const copiedFiles = []
    for (const [directory, files] of [['runtime-v8', runtimeFiles], ['staging', stagingFiles]]) {
      const destination = path.join(root, 'src', directory)
      await fsp.mkdir(destination, { recursive: true })
      for (const file of files) {
        const target = path.join(destination, file)
        await fsp.copyFile(path.join(pterodactylRoot, directory, file), target)
        copiedFiles.push(target)
      }
    }

    await assertLocalDependencyClosure(root, copiedFiles)

    const supervisorUrl = `${pathToFileURL(path.join(root, 'src', 'runtime-v8', 'supervisor.mjs')).href}?copy-contract=${Date.now()}`
    const supervisor = await import(supervisorUrl)
    assert.equal(typeof supervisor.migrateConfigFile, 'function')

    const policyUrl = `${pathToFileURL(path.join(root, 'src', 'runtime-v8', 'structured-policy.mjs')).href}?copy-contract=${Date.now()}`
    const policy = await import(policyUrl)
    assert.ok(policy.toolDefinitions.some(tool => tool.function.name === 'solveProduction'))
    assert.ok(policy.toolDefinitions.some(tool => tool.function.name === 'getTransportCapacity'))
    assert.ok(policy.toolDefinitions.some(tool => tool.function.name === 'getPlacementCandidates'))
    assert.equal(policy.toolCommand('getActorStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor","status")))')
    assert.equal(
      policy.renderOperation({
        name: 'place_candidate',
        args: { candidate_set_id: 'placement-4', candidate_id: 'candidate-2' },
      }),
      "remote.call('autorio_operations','place_candidate','placement-4','candidate-2')",
    )
  }
  finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
