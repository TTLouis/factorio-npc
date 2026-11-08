import { readFile } from 'node:fs/promises'

// The leveled method library export is the single knowledge source.
// Regenerate it with `node scripts/export-leveled-library.mjs`.
export const LIBRARY_SOURCE = 'packages/autorio/src/fixtures/leveled-library-v1.json'
export const LIBRARY_COUNTS = Object.freeze({ knowledge: 7, skills: 54 })
export const MAX_LIBRARY_RESULT_BYTES = 7 * 1024
const MAX_LIBRARY_FILE_BYTES = 512 * 1024
const MAX_QUERY = 160
const MAX_LIMIT = 8
const idPattern = /^[a-z0-9][a-z0-9-]{0,99}$/
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const fail = code => { throw Object.assign(new Error(code), { code, publicMessage: code }) }
let loaded

export function libraryMetadata() {
  return { tool: 'factorio_library', read_only: true, advisory_only: true, source: LIBRARY_SOURCE,
    counts: { ...LIBRARY_COUNTS }, loading: 'on_demand', result_bytes: MAX_LIBRARY_RESULT_BYTES }
}

async function catalog() {
  loaded ??= (async () => {
    const bytes = await readFile(new URL(`../../../${LIBRARY_SOURCE}`, import.meta.url)).catch(error => { if (error.code !== 'ENOENT') throw error; return readFile(new URL('./leveled-library-v1.json', import.meta.url)) })
    if (bytes.length > MAX_LIBRARY_FILE_BYTES) fail('library_integrity_failed')
    const pack = JSON.parse(bytes)
    if (pack.schema !== 2 || !Array.isArray(pack.knowledge) || !Array.isArray(pack.skills)) fail('library_integrity_failed')
    const all = [...pack.knowledge, ...pack.skills]
    const ids = new Set(all.map(entry => entry.id))
    if (ids.size !== all.length
      || pack.knowledge.some(entry => entry.content_type !== 'knowledge') || pack.skills.some(entry => entry.content_type !== 'skill')
      || all.some(entry => !idPattern.test(entry.id) || typeof entry.name !== 'string' || typeof entry.summary !== 'string')) fail('library_integrity_failed')
    // Links are bidirectional: an entry lists its own ids plus any entry that lists it.
    const links = new Map(all.map(entry => [entry.id, new Set()]))
    for (const entry of all) {
      for (const id of entry.related_ids ?? entry.guidance?.related_ids ?? []) {
        if (!ids.has(id)) fail('library_integrity_failed')
        links.get(entry.id).add(id)
        links.get(id).add(entry.id)
      }
    }
    return { pack, links }
  })()
  return loaded
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['kind', 'action', 'query', 'id', 'limit'].includes(key))
    || !['knowledge', 'skill'].includes(input.kind) || !['search', 'get'].includes(input.action)) fail('invalid_library_arguments')
  if (input.action === 'search') {
    if (input.id !== undefined || typeof input.query !== 'string' || input.query.length > MAX_QUERY
      // Reject control characters at the external input boundary.
      // eslint-disable-next-line no-control-regex
      || /[\u0000-\u001F\u007F]/u.test(input.query) || !normalize(input.query)
      || input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT)) fail('invalid_library_arguments')
  }
  else if (typeof input.id !== 'string' || !idPattern.test(input.id) || input.query !== undefined || input.limit !== undefined) fail('invalid_library_arguments')
}

function related(entry, links) {
  const own = entry.related_ids ?? entry.guidance?.related_ids ?? []
  return [...new Set([...own, ...links.get(entry.id)])]
}
function card(entry, links) {
  return { kind: entry.content_type, id: entry.id, name: entry.name, summary: entry.summary.slice(0, 400),
    ...(entry.summary.length > 400 ? { summary_truncated: true } : {}), level: entry.level,
    related_ids: related(entry, links) }
}
function view(entry, links) {
  const common = { kind: entry.content_type, content_type: entry.content_type, id: entry.id, revision: entry.revision,
    name: entry.name, summary: entry.summary, level: entry.level, source: entry.source,
    related_ids: related(entry, links), known_failure_modes: entry.known_failure_modes }
  if (entry.content_type === 'knowledge') return { ...common, search_aliases: entry.search_aliases,
    applicability: entry.applicability, reference: entry.reference }
  // Preserve complete authored guidance. Executable templates, topology,
  // verification and confidence fields are deliberately not execution evidence.
  return { ...common, goal_tags: entry.goal_tags, guidance: entry.guidance }
}

export async function readLibrary(input) {
  validate(input)
  const { pack, links } = await catalog()
  const entries = input.kind === 'knowledge' ? pack.knowledge : pack.skills
  const base = { kind: input.kind, action: input.action,
    authority: { content: 'untrusted_advisory', native_verified: false, availability: 'requires_live_checks',
      operation_authority: false, goal_authority: false },
    provenance: { source: LIBRARY_SOURCE } }
  let result
  if (input.action === 'get') {
    const entry = entries.find(entry => entry.id === input.id)
    if (!entry) fail('library_entry_not_found')
    result = { ...base, entry: view(entry, links) }
  }
  else {
    const query = normalize(input.query)
    const terms = query.split(' ')
    const matches = entries.map(entry => {
      const title = [entry.id, entry.name].map(normalize)
      const primary = [...title, ...(entry.search_aliases ?? []).map(normalize), ...(entry.goal_tags ?? []).map(normalize)]
      const secondary = [entry.summary].map(normalize)
      const detail = Object.values(entry.guidance ?? {}).flatMap(value => Array.isArray(value) ? value : [value]).filter(value => typeof value === 'string').map(normalize)
      const fields = [...primary, ...secondary, ...detail]
      const text = fields.join(' ')
      const phrase = fields.some(field => field.includes(query))
      const score = (title.some(field => field.includes(query)) ? 60 : primary.some(field => field.includes(query)) ? 30 : secondary.some(field => field.includes(query)) ? 15 : phrase ? 5 : 0)
        + terms.filter(term => text.includes(term)).length
      return { entry, score: phrase || terms.every(term => text.includes(term)) ? score : 0 }
    }).filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    const limit = input.limit ?? 5
    result = { ...base, query: input.query, total_matches: matches.length, truncated: matches.length > limit,
      results: matches.slice(0, limit).map(({ entry }) => card(entry, links)) }
  }
  // Never silently trim full guidance or return a partial authority disclaimer.
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_LIBRARY_RESULT_BYTES) fail('library_result_too_large')
  return structuredClone(result)
}
