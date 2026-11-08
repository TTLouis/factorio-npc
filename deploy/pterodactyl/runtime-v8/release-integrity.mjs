// Installed startup gate. Builtins only: verify the release before importing
// any selected lifecycle, reading its configuration or opening a connection.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASE_INTEGRITY_FAILURE = 'release_integrity_failed'

function check(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { code: RELEASE_INTEGRITY_FAILURE })
}

export async function verifyManifest(app) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(app, 'manifest.json'), 'utf8'))
    check(manifest?.revision === 'sgluna-pterodactyl-v8' && manifest.files && typeof manifest.files === 'object', 'Missing v8 release manifest')
    for (const [name, expected] of Object.entries(manifest.files)) {
      check(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected), `Invalid manifest digest: ${name}`)
      const filename = path.join(app, name)
      const current = await fs.lstat(filename)
      check(current.isFile() && !current.isSymbolicLink(), `Expected regular file: ${filename}`)
      check(current.size > 0, `Expected non-empty file: ${filename}`)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(filename)) hash.update(chunk)
      check(hash.digest('hex') === expected, `Release file integrity failed: ${name}`)
    }
    return manifest
  }
  catch (error) {
    if (error?.code === RELEASE_INTEGRITY_FAILURE) throw error
    throw Object.assign(new Error('Unable to read installed release manifest or files'), { code: RELEASE_INTEGRITY_FAILURE })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = process.argv.length === 3 ? process.argv[2] : undefined
  Promise.resolve().then(() => {
    check(typeof app === 'string' && path.isAbsolute(app), 'Expected installed release directory')
    return verifyManifest(app)
  }).catch(() => {
    // Stable, path-free diagnostic; successful verification is silent so stdio
    // MCP stdout remains exclusively protocol data.
    process.stderr.write(`Harness stopped: ${RELEASE_INTEGRITY_FAILURE}. Installed release verification failed.\n`)
    process.exitCode = 78
  })
}
