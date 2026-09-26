import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [app, modSource] = process.argv.slice(2)
if (!app || !/^[a-f0-9]{40}$/.test(modSource)) throw new Error('Expected release directory and exact mod source SHA')

const manifestPath = path.join(app, 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
for (const name of ['autorio/control.lua', 'autorio/data.lua', 'autorio/info.json']) {
  const contents = fs.readFileSync(path.join(app, name))
  manifest.files[name] = crypto.createHash('sha256').update(contents).digest('hex')
}
manifest.modSource = modSource
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
fs.writeFileSync('/opt/airi/MOD_SOURCE_SHA', `${modSource}\n`)
