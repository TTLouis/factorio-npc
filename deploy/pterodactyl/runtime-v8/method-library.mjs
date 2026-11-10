import { existsSync, readFileSync } from 'node:fs'

// The leveled method library export is the default knowledge source.
// Regenerate it with `node scripts/export-leveled-library.mjs`.
// The loader is content-agnostic: counts, knowledge categories and their
// record fields come from the pack itself, so another library loads unchanged.
export const LIBRARY_SOURCE = 'packages/autorio/src/fixtures/leveled-library-v1.json'
export const LIBRARY_SCHEMA = 3
export const MAX_LIBRARY_RESULT_BYTES = 7 * 1024
const MAX_LIBRARY_FILE_BYTES = 512 * 1024
const MAX_QUERY = 160
const MAX_LIMIT = 8
const MAX_CATEGORIES = 16
// A category lists whole by default; a pack may not declare a larger one.
const MAX_CATEGORY_RECORDS = 16
const idPattern = /^[a-z0-9][a-z0-9-]{0,99}$/
const categoryPattern = /^[a-z][a-z0-9_-]{0,39}$/
const fieldPattern = /^[a-z][a-z0-9_]{0,39}$/
// Fields every category record has; any other record field is authored text.
const RECORD_KEYS = ['id', 'name', 'summary', 'aliases', 'methods']
// Keys of the record view; authored fields must not shadow them.
const VIEW_KEYS = ['kind', 'content_type', 'category', 'order', 'of', 'previous', 'next', 'search_aliases', ...RECORD_KEYS]
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const fail = code => { throw Object.assign(new Error(code), { code, publicMessage: code }) }
const texts = value => Array.isArray(value) && value.length > 0 && value.every(text => typeof text === 'string' && text.length > 0)

function loadPack(bytes) {
  if (bytes.length > MAX_LIBRARY_FILE_BYTES) fail('library_integrity_failed')
  let pack
  try { pack = JSON.parse(bytes) } catch { fail('library_integrity_failed') }
  const categoriesIn = pack?.knowledge_categories ?? []
  if (pack?.schema !== LIBRARY_SCHEMA || !Array.isArray(pack.knowledge) || !Array.isArray(pack.skills)
    || !Array.isArray(categoriesIn) || categoriesIn.length > MAX_CATEGORIES) fail('library_integrity_failed')
  const all = [...pack.knowledge, ...pack.skills]
  const ids = new Set(all.map(entry => entry?.id))
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
  // Knowledge categories: named record groups the pack declares, optionally ordered.
  // Records are knowledge; their methods name existing entries; other fields are text lists.
  const recordIds = new Set()
  const categories = categoriesIn.map(category => {
    if (!categoryPattern.test(category?.id) || typeof category.name !== 'string' || typeof category.summary !== 'string'
      || typeof category.ordered !== 'boolean' || !Array.isArray(category.records) || category.records.length === 0
      || category.records.length > MAX_CATEGORY_RECORDS) fail('library_integrity_failed')
    const records = category.records.map((record, index) => {
      const fields = Object.keys(record ?? {}).filter(key => !RECORD_KEYS.includes(key))
      if (!idPattern.test(record?.id) || ids.has(record.id) || recordIds.has(record.id)
        || typeof record.name !== 'string' || typeof record.summary !== 'string'
        || record.aliases !== undefined && !texts(record.aliases)
        || record.methods !== undefined && (!texts(record.methods) || record.methods.some(id => !ids.has(id)))
        || fields.some(key => !fieldPattern.test(key) || VIEW_KEYS.includes(key) || !texts(record[key]))) fail('library_integrity_failed')
      recordIds.add(record.id)
      return { content_type: 'knowledge', category: category.id, id: record.id, name: record.name, summary: record.summary,
        search_aliases: record.aliases ?? [], record, fields, ...(category.ordered ? { order: index + 1 } : {}) }
    })
    return { id: category.id, name: category.name, summary: category.summary, ordered: category.ordered, records }
  })
  if (new Set(categories.map(category => category.id)).size !== categories.length) fail('library_integrity_failed')
  const byId = new Map(all.map(entry => [entry.id, entry]))
  return { pack, links, categories, byId }
}

function validate(input, catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['kind', 'action', 'query', 'id', 'limit', 'category'].includes(key))
    || !['knowledge', 'skill'].includes(input.kind) || !['search', 'get'].includes(input.action)) fail('invalid_library_arguments')
  if (input.category !== undefined) {
    if (input.kind !== 'knowledge' || input.action !== 'search' || typeof input.category !== 'string' || !categoryPattern.test(input.category)) fail('invalid_library_arguments')
    if (!catalog.categories.some(category => category.id === input.category)) fail('library_category_not_found')
  }
  if (input.action === 'search') {
    // A knowledge category may be listed without a query.
    const listing = input.query === undefined && input.category !== undefined
    if (input.id !== undefined || !listing && (typeof input.query !== 'string' || input.query.length > MAX_QUERY
      // Reject control characters at the external input boundary.
      || /[\u0000-\u001F\u007F]/u.test(input.query) || !normalize(input.query))
      || input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT)) fail('invalid_library_arguments')
  }
  else if (typeof input.id !== 'string' || !idPattern.test(input.id) || input.query !== undefined || input.limit !== undefined) fail('invalid_library_arguments')
}

function related(entry, links) {
  if (entry.category) return [...(entry.record.methods ?? [])]
  const own = entry.related_ids ?? entry.guidance?.related_ids ?? []
  return [...new Set([...own, ...links.get(entry.id)])]
}
function card(entry, links) {
  return { kind: entry.content_type, ...(entry.category ? { category: entry.category, ...(entry.order !== undefined ? { order: entry.order } : {}) } : {}), id: entry.id, name: entry.name,
    summary: entry.summary.slice(0, 400), ...(entry.summary.length > 400 ? { summary_truncated: true } : {}), ...(entry.level !== undefined ? { level: entry.level } : {}),
    related_ids: related(entry, links) }
}
function recordView(entry, category, byId) {
  const { record } = entry
  const position = category.ordered
    ? { order: entry.order, of: category.records.length, previous: category.records[entry.order - 2]?.id ?? null, next: category.records[entry.order]?.id ?? null }
    : {}
  return { kind: 'knowledge', content_type: 'knowledge', category: category.id, id: entry.id, name: entry.name, summary: entry.summary,
    ...position, search_aliases: entry.search_aliases, ...Object.fromEntries(entry.fields.map(key => [key, record[key]])),
    methods: (record.methods ?? []).map(id => ({ kind: byId.get(id).content_type, id, name: byId.get(id).name })) }
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

function search(input, entries) {
  const query = normalize(input.query)
  const terms = query.split(' ')
  const matches = entries.map(entry => {
    const title = [entry.id, entry.name].map(normalize)
    const primary = [...title, ...(entry.search_aliases ?? []).map(normalize), ...(entry.goal_tags ?? []).map(normalize)]
    const secondary = [entry.summary].map(normalize)
    const detail = [...Object.values(entry.guidance ?? {}), ...(entry.fields ?? []).map(key => entry.record[key])]
      .flatMap(value => Array.isArray(value) ? value : [value]).filter(value => typeof value === 'string').map(normalize)
    const fields = [...primary, ...secondary, ...detail]
    const text = fields.join(' ')
    const phrase = fields.some(field => field.includes(query))
    const score = (title.some(field => field.includes(query)) ? 60 : primary.some(field => field.includes(query)) ? 30 : secondary.some(field => field.includes(query)) ? 15 : phrase ? 5 : 0)
      + terms.filter(term => text.includes(term)).length
    return { entry, score: phrase || terms.every(term => text.includes(term)) ? score : 0 }
  }).filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
  return matches.map(match => match.entry)
}

// Opens one library pack. `file` is a URL or path; `source` is the provenance label.
export function openLibrary({ file, source }) {
  let catalog
  const load = () => (catalog ??= loadPack(readFileSync(file)))

  function metadata() {
    const { pack, categories } = load()
    return { tool: 'factorio_library', read_only: true, advisory_only: true, source,
      counts: { knowledge: pack.knowledge.length, skills: pack.skills.length },
      knowledge_categories: categories.map(category => ({ id: category.id, name: category.name, summary: category.summary,
        ordered: category.ordered, records: category.records.length })),
      loading: 'on_demand', result_bytes: MAX_LIBRARY_RESULT_BYTES }
  }

  async function read(input) {
    const current = load()
    validate(input, current)
    const { pack, links, categories, byId } = current
    const records = categories.flatMap(category => category.records)
    const entries = input.kind === 'skill' ? pack.skills
      : input.category ? categories.find(category => category.id === input.category).records : [...pack.knowledge, ...records]
    const base = { kind: input.kind, action: input.action,
      authority: { content: 'untrusted_advisory', native_verified: false, availability: 'requires_live_checks',
        operation_authority: false, goal_authority: false },
      provenance: { source } }
    let result
    if (input.action === 'get') {
      const entry = entries.find(entry => entry.id === input.id)
      if (!entry) fail('library_entry_not_found')
      result = { ...base, entry: entry.category ? recordView(entry, categories.find(category => category.id === entry.category), byId) : view(entry, links) }
    }
    else if (input.query === undefined) {
      // Category listing in authored order: the whole category unless a limit is given.
      const limit = input.limit ?? entries.length
      result = { ...base, category: input.category, total_matches: entries.length, truncated: entries.length > limit,
        results: entries.slice(0, limit).map(entry => card(entry, links)) }
    }
    else {
      const matches = search(input, entries)
      const limit = input.limit ?? 5
      result = { ...base, query: input.query, ...(input.category ? { category: input.category } : {}), total_matches: matches.length, truncated: matches.length > limit,
        results: matches.slice(0, limit).map(entry => card(entry, links)) }
    }
    // Never silently trim full guidance or return a partial authority disclaimer.
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_LIBRARY_RESULT_BYTES) fail('library_result_too_large')
    return structuredClone(result)
  }

  return { metadata, read }
}

// A checkout reads the source fixture; a deployed runtime reads its bundled copy.
function defaultFile() {
  const checkout = new URL(`../../../${LIBRARY_SOURCE}`, import.meta.url)
  return existsSync(checkout) ? checkout : new URL('./leveled-library-v1.json', import.meta.url)
}

let shipped
const defaultLibrary = () => (shipped ??= openLibrary({ file: defaultFile(), source: LIBRARY_SOURCE }))
export const libraryMetadata = () => defaultLibrary().metadata()
export const readLibrary = input => defaultLibrary().read(input)
