// Dependency-free export of the exact optional authored method library.
// Does not access a game, provider, credentials or network.
import { readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const source = new URL('../packages/autorio/src/leveled_skill_library.ts', import.meta.url)
const module = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(readFileSync(source, 'utf8')))}`)
const entries = module.LEVELED_LIBRARY_DEFINITIONS
const knowledge = module.LEVELED_KNOWLEDGE_DEFINITIONS.map(entry => ({
  schema_version: 1, content_type: 'knowledge', id: entry.id, revision: entry.revision, name: entry.name, summary: entry.summary,
  level: entry.level,
  ...(entry.search_aliases ? { search_aliases: entry.search_aliases } : {}),
  applicability: { when_to_use: entry.guidance.when_to_use, when_to_skip: entry.guidance.when_to_skip, live_checks: entry.guidance.live_checks, required_capabilities: entry.guidance.required_capabilities },
  reference: { concepts: entry.guidance.steps, interpretation_checks: entry.guidance.completion }, related_ids: entry.guidance.related_ids,
  known_failure_modes: entry.known_failure_modes, source: entry.source,
}))
const output = new URL('../packages/autorio/src/fixtures/leveled-library-v1.json', import.meta.url)
const pack = { schema: 2, profile: 'leveled', default_enabled: false,
  description: 'Optional knowledge and skill methods. No recipes or ratios. Current tool availability and live facts remain mandatory.', knowledge, skills: module.LEVELED_SKILL_DEFINITIONS,
  stages: module.PROGRESSION_STAGES }
const json = `${JSON.stringify(pack, null, 2)}\n`
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8').replaceAll('\r\n', '\n') !== json) throw new Error('Leveled library export is stale; run node scripts/export-leveled-library.mjs')
}
else writeFileSync(output, json)
console.log(`${process.argv.includes('--check') ? 'Checked' : 'Exported'} ${entries.length} entries: ${output.pathname}`)
