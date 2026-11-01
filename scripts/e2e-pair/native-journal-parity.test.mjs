import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('future paired template imports byte-identical canonical journal normalization', () => {
  const canonical = fs.readFileSync(new URL('../../deploy/pterodactyl/staging/native-admission-journal.mjs', import.meta.url), 'utf8')
  const template = fs.readFileSync(new URL('./templates/native-admission-journal.mjs', import.meta.url), 'utf8')
  assert.equal(template, canonical)
})
