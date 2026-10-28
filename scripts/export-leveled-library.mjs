// Dependency-free export of the exact optional authored method library.
// Does not access a game, provider, credentials or network.
import { readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const source = new URL('../packages/autorio/src/leveled_skill_library.ts', import.meta.url)
const module = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(readFileSync(source, 'utf8')))}`)
const entries = module.LEVELED_SKILL_DEFINITIONS
const output = new URL('../packages/autorio/src/fixtures/leveled-library-v1.json', import.meta.url)
const pack = { schema: 1, profile: 'leveled', default_enabled: false,
  description: 'Optional knowledge and skill methods. No recipes or ratios. Current tool availability and live facts remain mandatory.', skills: entries }
const json = `${JSON.stringify(pack, null, 2)}\n`
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== json) throw new Error('Leveled library export is stale; run node scripts/export-leveled-library.mjs')
}
else writeFileSync(output, json)
console.log(`${process.argv.includes('--check') ? 'Checked' : 'Exported'} ${entries.length} entries: ${output.pathname}`)
