import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { LEVELED_SKILL_DEFINITIONS, LEVELED_KNOWLEDGE_DEFINITIONS, LEVELED_LIBRARY_DEFINITIONS, LEGACY_KNOWLEDGE_DEFINITIONS } from './leveled_skill_library'
import { BASIC_SKILL_DEFINITIONS } from './basic_skill_library'
import {
  canonicalize_skill_definition, curated_library_profile, ensure_basic_skill_definitions, score_skill_for_goal,
  find_knowledge_references, get_knowledge_reference, get_procedural_skill, knowledge_reference, create_skill_remote_interface, export_skill, find_skill_definitions, generate_skill_markdown, get_skill_definition, list_skill_definitions,
  put_untrusted_skill_definition, select_curated_library, skill_cards_for_goal, trim_skill_text, normalize_skill_tag, goal_search_terms,
} from './skills'
import { filtered_library_entries, skill_detail_rows } from './skills_window'

beforeEach(() => { (globalThis as any).storage = {} })

describe('leveled knowledge and skills as a selectable, honest method library', () => {
  it('finds ordinary symptoms through authored aliases without query-specific rules or unrelated matches', () => {
    select_curated_library('leveled')
    const cases = [
      ['The furnace is not making plates', 'knowledge-machine-state'],
      ['These two buildings are next to each other but nothing transfers', 'knowledge-connection-geometry'],
      ['This machine exists but can I actually use it here?', 'knowledge-available-capabilities'],
      ['I have an empty inventory and cannot craft the missing material', 'knowledge-acquisition-paths'],
      ['What comes first when research is blocked by a prerequisite?', 'knowledge-production-dependencies'],
      ['The inventory is unchanged; is there enough production?', 'knowledge-rates-stocks-freshness'],
      ['The machine stopped working and there is no output', 'knowledge-machine-state'],
      ['A stopped producer may simply have nowhere to put the result', 'knowledge-machine-state'],
      ['The inserter cannot pick up from the belt', 'knowledge-connection-geometry'],
      ['Are the adjacent buildings not connected or facing the wrong direction?', 'knowledge-connection-geometry'],
    ]
    for (const [query, id] of cases) expect(find_knowledge_references(query, 3).map(row => row.id), query).toContain(id)
    for (const query of ['banana poetry telescope', 'purple penguins', 'zzqvflorp']) expect(find_knowledge_references(query, 3)).toEqual([])
    for (const entry of LEVELED_KNOWLEDGE_DEFINITIONS) {
      const canonical = canonicalize_skill_definition(entry)
      const reference = knowledge_reference(canonical)!
      expect(reference.search_aliases).toEqual(entry.search_aliases)
      expect(canonicalize_skill_definition(reference).search_aliases).toEqual(entry.search_aliases)
      expect(reference.summary).not.toBe(`${entry.guidance.when_to_use} ${entry.guidance.completion[0]}`)
      expect(reference.reference!.concepts.filter(text => text.startsWith('Contrast:'))).toHaveLength(1)
      expect(JSON.stringify(reference)).not.toMatch(/executable_candidate|production_output|recipe_ids":\["/)
    }
    expect(() => canonicalize_skill_definition({ ...LEVELED_KNOWLEDGE_DEFINITIONS[0], search_aliases: Array.from({ length: 25 }, () => 'alias') })).toThrow(/search_aliases/)
  })

  it('matches aliases alone using the same stopword and plural normalization as queries', () => {
    for (const alias of ['what comes first', 'out of items', 'where to get', 'can use', 'boxes beside machines']) {
      const entry = canonicalize_skill_definition({ id: 'alias-only', name: 'Neutral', summary: 'Reference metadata.', content_type: 'knowledge', search_aliases: [alias] })
      expect(score_skill_for_goal(entry, goal_search_terms(alias)).tag_hits, alias).toBe(1)
      expect(score_skill_for_goal(entry, goal_search_terms(`Please ${alias.toUpperCase()}?`)).tag_hits, alias).toBe(1)
      expect(score_skill_for_goal(entry, goal_search_terms('banana poetry telescope')).tag_hits).toBe(0)
      expect(score_skill_for_goal({ ...entry, search_aliases: [] }, goal_search_terms(alias)).tag_hits).toBe(0)
    }
    const empty = canonicalize_skill_definition({ id: 'alias-empty', name: 'Neutral', summary: 'Reference metadata.', search_aliases: ['the of a'] })
    expect(score_skill_for_goal(empty, goal_search_terms('the of a')).tag_hits).toBe(0)
  })

  it('upgrades only exact historical knowledge copies while preserving unmarked personal variants, profiles and saved snapshots', () => {
    select_curated_library('leveled')
    const registry = (globalThis as any).storage.sgluna_skill_definitions
    for (const old of LEGACY_KNOWLEDGE_DEFINITIONS) registry[old.id] = canonicalize_skill_definition(old)
    expect(ensure_basic_skill_definitions().upgraded).toBe(6)
    for (const entry of LEVELED_KNOWLEDGE_DEFINITIONS) expect(get_skill_definition(entry.id)).toEqual(canonicalize_skill_definition(entry))
    const old = canonicalize_skill_definition(LEGACY_KNOWLEDGE_DEFINITIONS[0])
    const personal = { ...old, summary: 'Owner-specific reference without a provenance edit marker', search_aliases: ['owner terminology'] }
    registry[old.id] = personal
    const personalBytes = JSON.stringify(personal)
    expect(ensure_basic_skill_definitions().upgraded).toBe(0)
    select_curated_library('basic')
    ;(globalThis as any).storage = JSON.parse(JSON.stringify((globalThis as any).storage))
    select_curated_library('leveled')
    expect(JSON.stringify(get_skill_definition(old.id))).toBe(personalBytes)
  })

  it('trims complete whitespace characters without deleting Unicode content or corrupting tags and queries', () => {
    for (const text of ['并线', '煤蛇', '¿', '»', 'ÿ', 'A\u00A0B', 'A\uFEFFB']) {
      expect(trim_skill_text(`\uFEFF \t\u00A0${text}\u3000\u2009 \uFEFF`)).toBe(text)
      expect(normalize_skill_tag(`\u00A0${text}\uFEFF`)).toBe(text.toLowerCase())
      expect(canonicalize_skill_definition({ id: 'unicode-probe', name: text, summary: text }).name).toBe(text)
    }
    expect(trim_skill_text('\u00A0\uFEFF \t')).toBe('')
    expect(goal_search_terms(' 并线 ').normalized).toBe('并线')
  })

  it('upgrades untouched malformed curated tags but preserves personal edits across existing save state', () => {
    ensure_basic_skill_definitions()
    const registry = (globalThis as any).storage.sgluna_skill_definitions
    registry['belt-side-load-merge'].revision = 2
    registry['belt-side-load-merge'].goal_tags = ['并�']
    expect(ensure_basic_skill_definitions().upgraded).toBe(1)
    expect(get_skill_definition('belt-side-load-merge')!.goal_tags).toContain('并线')
    select_curated_library('leveled')
    registry['skill-deliberate-belt-routing'].revision = 1
    registry['skill-deliberate-belt-routing'].goal_tags = ['并�']
    expect(ensure_basic_skill_definitions().upgraded).toBe(1)
    expect(get_skill_definition('skill-deliberate-belt-routing')!.goal_tags).toContain('并线')
    const personal = registry['skill-deliberate-belt-routing']
    personal.revision = 1; personal.goal_tags = ['owner-choice']; personal.source.evidence_refs.push('player-edit:owner')
    expect(ensure_basic_skill_definitions().upgraded).toBe(0)
    expect(get_skill_definition(personal.id)!.goal_tags).toEqual(['owner-choice'])
  })

  it('incorporates every basic canonical id as a classified method and restores the unchanged basic profile', () => {
    expect(curated_library_profile()).toBe('basic')
    ensure_basic_skill_definitions()
    const baseline = list_skill_definitions().map(entry => JSON.stringify(entry))
    expect(baseline).toHaveLength(11)
    expect(select_curated_library('leveled')).toMatchObject({ profile: 'leveled', added: 56, upgraded: 11, removed: 0, total: 67 })
    const entries = list_skill_definitions()
    expect(entries).toHaveLength(67)
    expect(entries.filter(entry => entry.content_type === 'knowledge')).toHaveLength(9)
    expect(entries.filter(entry => entry.content_type === 'skill')).toHaveLength(58)
    for (const raw of BASIC_SKILL_DEFINITIONS) {
      const foundation = get_skill_definition(raw.id)!
      expect(foundation.content_type).toBe('skill')
      expect([1, 2]).toContain(foundation.level)
      expect(foundation.guidance!.steps.length).toBeGreaterThanOrEqual(3)
      expect(foundation.revision).toBeGreaterThan(raw.revision)
    }
    expect(ensure_basic_skill_definitions()).toEqual({ added: 0, upgraded: 0, removed: 0, total: 67 })
    select_curated_library('basic')
    expect(list_skill_definitions().map(entry => JSON.stringify(entry))).toEqual(baseline)
    for (const entry of BASIC_SKILL_DEFINITIONS) expect(get_skill_definition(entry.id)).toBeDefined()
  })

  it('restores incorporated foundations when loading a save made by the former replacement profile', () => {
    select_curated_library('leveled')
    const registry = (globalThis as any).storage.sgluna_skill_definitions
    for (const raw of BASIC_SKILL_DEFINITIONS) delete registry[raw.id]
    delete registry['burner-inserter-refueling']
    expect(list_skill_definitions()).toHaveLength(55)
    expect(ensure_basic_skill_definitions()).toMatchObject({ added: 12, removed: 0, total: 67 })
    expect(list_skill_definitions()).toHaveLength(67)
    expect(find_skill_definitions('煤蛇', 10).some(entry => entry.id === 'burner-coal-loop')).toBe(true)
  })

  it('preserves personal edits and learned entries across profile selection and refuses invalid selection without mutation', () => {
    ensure_basic_skill_definitions()
    const original = get_skill_definition('burner-coal-loop')!
    const edited = put_untrusted_skill_definition({ ...original, revision: original.revision + 1,
      name: 'Owner-edited method', source: { ...original.source, evidence_refs: [...original.source.evidence_refs, 'player-edit:owner'] } })
    const learned = put_untrusted_skill_definition({ ...original, id: 'personal-method', source: { ...original.source, kind: 'completed_goal', evidence_refs: ['goal:local'] } })
    select_curated_library('leveled')
    expect(get_skill_definition(edited.id)).toEqual(edited)
    expect(get_skill_definition(learned.id)).toEqual(learned)
    const before = JSON.stringify((globalThis as any).storage)
    expect(() => select_curated_library('anything')).toThrow(/unknown curated/)
    expect(JSON.stringify((globalThis as any).storage)).toBe(before)
    select_curated_library('basic')
    expect(get_skill_definition(edited.id)).toEqual(edited)
  })

  it('contains methods and live checks, never a stored bill, numerical game mechanic, recipe topology or native-mastery claim', () => {
    const pack = JSON.parse(readFileSync(new URL('./fixtures/leveled-library-v1.json', import.meta.url), 'utf8'))
    expect(pack.skills).toEqual(LEVELED_SKILL_DEFINITIONS)
    expect(pack.schema).toBe(3)
    expect(pack.knowledge).toEqual(LEVELED_KNOWLEDGE_DEFINITIONS.map(raw => knowledge_reference(canonicalize_skill_definition(raw))))
    for (const reference of pack.knowledge) {
      const imported = canonicalize_skill_definition(reference)
      expect(imported.guidance!.steps).toEqual(reference.reference.concepts)
      expect(imported.guidance!.completion).toEqual(reference.reference.interpretation_checks)
      expect(knowledge_reference(imported)).toEqual(reference)
    }
    const ids = LEVELED_LIBRARY_DEFINITIONS.map(entry => entry.id)
    expect(new Set(ids).size).toBe(67)
    for (const raw of LEVELED_LIBRARY_DEFINITIONS) {
      const entry = canonicalize_skill_definition(raw)
      expect(entry.inputs).toEqual([])
      expect(entry.outputs).toEqual([])
      expect(entry.topology).toEqual({ nodes: [], relations: [] })
      expect(entry.source.recipe_ids).toEqual([])
      expect(entry.parameters).toEqual([])
      expect(entry.preconditions.every(condition => condition.kind === 'custom')).toBe(true)
      expect(entry.status).toBe('candidate')
      expect(entry.verification.production_output).toBe('not_tested')
      expect(entry.guidance!.steps.length).toBeGreaterThanOrEqual(3)
      expect(entry.guidance!.live_checks.length).toBeGreaterThanOrEqual(2)
      expect(entry.guidance!.completion.length).toBeGreaterThan(0)
      const prose = JSON.stringify({ summary: entry.summary, guidance: entry.guidance, failures: entry.known_failure_modes })
      expect(prose).not.toMatch(/\d|\bper (?:second|minute|tick)\b/i)
      for (const id of entry.guidance!.related_ids) expect(ids).toContain(id)
      expect(canonicalize_skill_definition(JSON.parse(JSON.stringify(entry)))).toEqual(entry)
    }
  })

  it('preserves customized imports with inherited curated refs across profile changes and saved storage reload', () => {
    for (const profile of ['basic', 'leveled'] as const) {
      ;(globalThis as any).storage = {}
      select_curated_library(profile)
      const original = get_skill_definition('burner-coal-loop')!
      const imported = put_untrusted_skill_definition({ ...original, revision: 100, name: 'Imported custom coal method' })
      expect(imported.source.evidence_refs).toContain('imported:caller-definition')
      select_curated_library(profile === 'basic' ? 'leveled' : 'basic')
      ;(globalThis as any).storage = JSON.parse(JSON.stringify((globalThis as any).storage))
      ensure_basic_skill_definitions()
      select_curated_library(profile)
      expect(get_skill_definition(imported.id)).toEqual(imported)
      // Older saves may predate the import marker. A different family may
      // replace only an exact current canonical copy, even at a lower revision.
      for (const revision of [1, original.revision, 100]) {
        const legacy = { ...original, revision, name: 'Older imported custom method' }
        const expected = JSON.parse(JSON.stringify(legacy))
        delete (globalThis as any).storage.sgluna_preserved_curated_variants?.[legacy.id]
        ;(globalThis as any).storage.sgluna_skill_definitions[legacy.id] = legacy
        select_curated_library(profile === 'basic' ? 'leveled' : 'basic')
        ;(globalThis as any).storage = JSON.parse(JSON.stringify((globalThis as any).storage))
        select_curated_library(profile)
        expect(get_skill_definition(legacy.id)).toEqual(expected)
      }
    }
  })

  it('preserves type, complexity and actionable content through discovery, details and Markdown export', () => {
    select_curated_library('leveled')
    const result = find_knowledge_references('freshness', 10).find(entry => entry.id === 'knowledge-rates-stocks-freshness')!
    expect(result).toMatchObject({ content_type: 'knowledge', level: 0 })
    const card = skill_cards_for_goal('freshness', 10).find(entry => entry.id === result.id)!
    expect(card).toBeUndefined()
    expect(find_skill_definitions('freshness', 10).every(entry => entry.content_type !== 'knowledge')).toBe(true)
    expect(get_procedural_skill(result.id)).toBeUndefined()
    expect(get_knowledge_reference(result.id)).not.toHaveProperty('verification')
    const entry = get_skill_definition(result.id)!
    const rows = new Map(skill_detail_rows(entry))
    expect(rows.get('TYPE')).toContain('Knowledge')
    expect(rows.get('LEVEL')).toContain('L0 complexity')
    expect(rows.get('METHOD')).toContain(entry.guidance!.steps[0])
    expect(rows.get('DONE WHEN')).toContain(entry.guidance!.completion[0])
    const markdown = generate_skill_markdown(entry)
    expect(markdown).toContain('Content type: knowledge')
    expect(markdown).toContain('Complexity level: L0')
    expect(markdown).toContain(entry.guidance!.steps[0])
  })

  it('filters knowledge, skills and complexity independently without changing stored entries', () => {
    select_curated_library('leveled')
    const entries = list_skill_definitions()
    const before = JSON.stringify((globalThis as any).storage)
    expect(filtered_library_entries(entries, { type: 'knowledge', level: -1 })).toHaveLength(9)
    expect(filtered_library_entries(entries, { type: 'skill', level: 3 })).toHaveLength(6)
    expect(filtered_library_entries(entries, { type: 'knowledge', level: 3 })).toEqual([])
    expect(filtered_library_entries(entries, { type: 'all', level: -2 })).toEqual([])
    expect(JSON.stringify((globalThis as any).storage)).toBe(before)
  })

  it('refuses invalid new metadata and does not let physical verification claim knowledge mastery', () => {
    const entry = LEVELED_KNOWLEDGE_DEFINITIONS[0]
    for (const level of [-1, 8, 1.5, '0']) expect(() => canonicalize_skill_definition({ ...entry, level })).toThrow(/level/)
    expect(() => canonicalize_skill_definition({ ...entry, content_type: 'recipe' })).toThrow(/content_type/)
    expect(() => canonicalize_skill_definition({ ...entry, guidance: { ...entry.guidance, steps: [] } })).toThrow(/steps/)
    expect(() => canonicalize_skill_definition({ ...entry, status: 'verified', stage: 'verified_skill' })).toThrow(/knowledge is not verified/)
    const legacy = canonicalize_skill_definition(BASIC_SKILL_DEFINITIONS[0])
    expect(legacy).not.toHaveProperty('content_type')
    expect(legacy).not.toHaveProperty('level')
    expect(legacy).not.toHaveProperty('guidance')
  })
})

it('native typed interfaces keep imported references out of every procedure endpoint through profile and save cycles', () => {
  select_curated_library('leveled')
  const native: Record<string, any> = {}
  vi.stubGlobal('remote', { add_interface: (name: string, value: any) => { native[name] = value } })
  create_skill_remote_interface()
  const raw = get_skill_definition('knowledge-rates-stocks-freshness')!
  const custom = put_untrusted_skill_definition({ ...raw, id: 'personal-reference', name: 'Personal concept', goal_tags: ['freshness'],
    source: { ...raw.source, evidence_refs: ['owner:personal'] } })
  const original = JSON.stringify(custom)
  for (const profile of ['basic', 'leveled'] as const) {
    select_curated_library(profile)
    ;(globalThis as any).storage = JSON.parse(JSON.stringify((globalThis as any).storage))
    ensure_basic_skill_definitions()
    expect(JSON.stringify(get_skill_definition(custom.id))).toBe(original)
    expect(native.autorio_skills.get(custom.id)).toBeUndefined()
    expect(native.autorio_skills.list().every((entry: any) => entry.content_type !== 'knowledge')).toBe(true)
    expect(find_skill_definitions('freshness', 10).some(entry => entry.id === custom.id)).toBe(false)
    expect(skill_cards_for_goal('freshness', 10).some(entry => entry.id === custom.id)).toBe(false)
    expect(native.autorio_references.get(custom.id)).toEqual(knowledge_reference(custom))
    expect(native.autorio_references.find('freshness', 10).results.some((entry: any) => entry.id === custom.id)).toBe(true)
    expect(native.autorio_references.get('burner-coal-loop')).toBeUndefined()
    expect(native.autorio_references.find('freshness', 11).ok).toBe(false)
  }
  const writes: Record<string, string> = {}
  vi.stubGlobal('helpers', { table_to_json: JSON.stringify, write_file: (path: string, body: string) => { writes[path] = body } })
  vi.stubGlobal('game', { tick: 1 })
  export_skill(custom.id)
  expect(Object.keys(writes)).toEqual([`sgluna-knowledge/${custom.id}/r${custom.revision}/knowledge.json`, `sgluna-knowledge/${custom.id}/r${custom.revision}/KNOWLEDGE.md`])
  const exported = JSON.parse(Object.values(writes)[0])
  expect(exported).toEqual(knowledge_reference(custom))
  expect(exported).not.toHaveProperty('verification')
  expect(skill_detail_rows(custom).some(([label]) => label === 'CHECKED')).toBe(false)
  // The native RPC is bounded, while exports retain the full personal reference.
  const large = put_untrusted_skill_definition({ ...custom, id: 'personal-large-reference',
    guidance: { ...custom.guidance!, steps: Array.from({ length: 30 }, () => 'c'.repeat(280)) } })
  expect(native.autorio_references.get(large.id)).toEqual({ ok: false, error: 'knowledge_reference_too_large' })
  const exportResult = export_skill(large.id)
  expect(exportResult.duplicate).toBe(false)
  const full = JSON.parse(writes[`sgluna-knowledge/${large.id}/r${large.revision}/knowledge.json`])
  expect(JSON.stringify(full).length).toBeGreaterThan(7000)
  expect(full.reference.concepts).toEqual(large.guidance!.steps)
  const imported = canonicalize_skill_definition(full)
  expect(knowledge_reference(imported)).toEqual(full)
  vi.unstubAllGlobals()
})
