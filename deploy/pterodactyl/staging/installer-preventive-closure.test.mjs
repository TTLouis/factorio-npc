import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const deploy = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const helpers = ['decision-budgets.mjs', 'inventory-facts.mjs', 'handoff-format.mjs']

test('installer enumerates preventive helpers for copy and checksum manifest', async () => {
  const installer = await fs.readFile(path.join(deploy, 'payload-src/installer.sh'), 'utf8')
  const runtimeList = /for file in ([^\r\n]+); do\s+cp "\$WORK\/source\/deploy\/pterodactyl\/runtime-v8\/\$file"/.exec(installer)
  assert.ok(runtimeList, 'runtime copy list must remain explicit')
  const names = runtimeList[1].trim().split(/\s+/)
  assert.equal(names.length, new Set(names).size, 'duplicate runtime copy entry')
  const manifest = installer.split("<<'MANIFEST'")[1]?.split('\nMANIFEST')[0]
  assert.ok(manifest, 'missing manifest writer')
  for (const name of helpers) {
    assert.ok(names.includes(name), `installer must copy ${name}`)
    assert.ok(manifest.includes(`'src/runtime-v8/${name}'`), `manifest must checksum ${name}`)
  }
})

test('enumerated installer files form an importable supervisor closure', async t => {
  const installer = await fs.readFile(path.join(deploy, 'payload-src/installer.sh'), 'utf8')
  const groups = [...installer.matchAll(/for file in ([^\r\n]+); do\s+cp "\$WORK\/source\/deploy\/pterodactyl\/(runtime-v8|staging)\/\$file"/g)]
  assert.equal(groups.length, 2, 'expected runtime and staging copy lists')
  const release = await fs.mkdtemp(path.join(os.tmpdir(), 'sgluna-installer-closure-'))
  t.after(() => fs.rm(release, { recursive: true, force: true }))
  for (const [, list, group] of groups) {
    await fs.mkdir(path.join(release, group))
    for (const name of list.trim().split(/\s+/)) {
      assert.match(name, /^[a-z0-9-]+\.mjs$/)
      await fs.copyFile(path.join(deploy, group, name), path.join(release, group, name))
    }
  }
  // Import precisely the shipped tree without starting main, Factorio or providers.
  // The child cannot inherit credentials or runtime configuration.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "await import('./runtime-v8/supervisor.mjs')"], {
    cwd: release, encoding: 'utf8', timeout: 10000,
    env: { PATH: path.dirname(process.execPath) },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
})
