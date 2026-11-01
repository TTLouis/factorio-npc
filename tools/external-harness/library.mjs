import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const DONOR = '20cdcd072b512c814c8af071f4f9ad1fe087f942'
const CATALOG_SHA256 = 'dd8c6585169b6a8e9a8108db06d390bd9666625822a24a84c7b62156d7b3e861'
export const OWNER_REQUIREMENT_ID = 'knowledge-owner-electrical-first-automation'
export const MAX_LIBRARY_RESULT_BYTES = 7 * 1024
const MAX_QUERY = 160
const MAX_LIMIT = 8
const idPattern = /^[a-z0-9][a-z0-9-]{0,99}$/
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const fail = code => { throw Object.assign(new Error(code), { code, publicMessage: code }) }
let loaded

export function libraryMetadata() {
  return { tool: 'factorio_library', read_only: true, advisory_only: true, donor_commit: DONOR,
    counts: { knowledge: 7, skills: 54 }, owner_requirement_id: OWNER_REQUIREMENT_ID,
    loading: 'on_demand', result_bytes: MAX_LIBRARY_RESULT_BYTES }
}

async function catalog() {
  loaded ??= (async () => {
    const bytes = await readFile(new URL('./library/jev-catalog.json', import.meta.url))
    if (bytes.length > 512 * 1024 || createHash('sha256').update(bytes).digest('hex') !== CATALOG_SHA256) fail('library_integrity_failed')
    const donor = JSON.parse(bytes)
    const provenance = JSON.parse(await readFile(new URL('./library/provenance.json', import.meta.url), 'utf8'))
    const overlay = JSON.parse(await readFile(new URL('./library/owner-requirements.json', import.meta.url), 'utf8'))
    if (donor.schema !== 2 || donor.knowledge.length !== 6 || donor.skills.length !== 54
      || provenance.donor_commit !== DONOR || provenance.artifacts.catalog.sha256 !== CATALOG_SHA256
      || overlay.schema !== 1 || overlay.knowledge.length !== 1 || overlay.knowledge[0].id !== OWNER_REQUIREMENT_ID) fail('library_integrity_failed')
    const all = [...donor.knowledge, ...donor.skills, ...overlay.knowledge]
    if (new Set(all.map(entry => entry.id)).size !== all.length
      || all.some(entry => !idPattern.test(entry.id) || !['skill', 'knowledge'].includes(entry.content_type))
      || overlay.related_skill_ids.some(id => !donor.skills.some(entry => entry.id === id))) fail('library_integrity_failed')
    return { donor, provenance, overlay }
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

function related(entry, overlay) {
  return [...new Set([...(entry.related_ids ?? entry.guidance?.related_ids ?? []),
    ...(overlay.related_skill_ids.includes(entry.id) ? [OWNER_REQUIREMENT_ID] : [])])]
}
function card(entry, overlay) {
  return { kind: entry.content_type, id: entry.id, name: entry.name, summary: entry.summary.slice(0, 400),
    ...(entry.summary.length > 400 ? { summary_truncated: true } : {}), level: entry.level,
    related_ids: related(entry, overlay) }
}
function view(entry, overlay) {
  const common = { kind: entry.content_type, content_type: entry.content_type, id: entry.id, revision: entry.revision,
    name: entry.name, summary: entry.summary, level: entry.level, source: entry.source,
    related_ids: related(entry, overlay), known_failure_modes: entry.known_failure_modes }
  if (entry.content_type === 'knowledge') return { ...common, search_aliases: entry.search_aliases,
    applicability: entry.applicability, reference: entry.reference }
  // Preserve complete authored guidance. Executable templates, topology,
  // verification and confidence fields are deliberately not execution evidence.
  return { ...common, goal_tags: entry.goal_tags, guidance: entry.guidance,
    ...(overlay.related_skill_ids.includes(entry.id) ? { owner_requirements: [{ id: OWNER_REQUIREMENT_ID,
      summary: overlay.knowledge[0].summary, applicability: 'Owner full-automation requirement; read this knowledge before applying this method.',
      capability_caveat: 'Check the currently admitted electric-miner placement capability. If unsupported, report the gap; do not silently substitute burner mining.' }] } : {}) }
}

export async function readLibrary(input) {
  validate(input)
  const { donor, provenance, overlay } = await catalog()
  const entries = input.kind === 'knowledge' ? [...donor.knowledge, ...overlay.knowledge] : donor.skills
  const base = { kind: input.kind, action: input.action,
    authority: { content: 'untrusted_advisory', native_verified: false, availability: 'requires_live_checks',
      operation_authority: false, goal_authority: false, owner_requirement_id: OWNER_REQUIREMENT_ID },
    provenance: { donor_commit: provenance.donor_commit, catalog_blob: provenance.artifacts.catalog.blob,
      catalog_sha256: provenance.artifacts.catalog.sha256, owner_overlay: 'owner-requirements.json' } }
  let result
  if (input.action === 'get') {
    const entry = entries.find(entry => entry.id === input.id)
    if (!entry) fail('library_entry_not_found')
    result = { ...base, entry: view(entry, overlay) }
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
      results: matches.slice(0, limit).map(({ entry }) => card(entry, overlay)) }
  }
  // Never silently trim full guidance or return a partial authority disclaimer.
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_LIBRARY_RESULT_BYTES) fail('library_result_too_large')
  return structuredClone(result)
}
