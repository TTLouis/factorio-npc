import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { RELEASE_INTEGRITY_FAILURE, verifyManifest } from './release-integrity.mjs'
import { verifyManifest as supervisorVerifyManifest } from './supervisor.mjs'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('./release-integrity.mjs', import.meta.url))
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'installed-integrity-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'prompt.md'), 'original fixture prompt\n')
  const manifest = { revision: 'sgluna-pterodactyl-v8', files: { 'prompt.md': createHash('sha256').update('original fixture prompt\n').digest('hex') } }
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest))
  return { root, manifest }
}

test('valid installed integrity CLI is silent and the direct supervisor retains the same verifier', async t => {
  const { root, manifest } = await fixture(t)
  assert.equal(supervisorVerifyManifest, verifyManifest)
  assert.deepEqual(await verifyManifest(root), manifest)
  const result = await execute(process.execPath, [cli, root])
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '')
})

test('a changed installed prompt refuses with the stable integrity code before startup', async t => {
  const { root } = await fixture(t)
  await fs.appendFile(path.join(root, 'prompt.md'), 'changed')
  await assert.rejects(verifyManifest(root), { code: RELEASE_INTEGRITY_FAILURE })
  await assert.rejects(execute(process.execPath, [cli, root]), error => {
    assert.equal(error.code, 78)
    assert.equal(error.stdout, '')
    assert.match(error.stderr, /release_integrity_failed/)
    assert.equal(error.stderr.includes(root), false, 'public diagnostic does not expose release paths')
    return true
  })
})
