import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { LEVELED_SKILL_DEFINITIONS } from './leveled_skill_library'
import { BASIC_SKILL_DEFINITIONS } from './basic_skill_library'
import {
  canonicalize_skill_definition, curated_library_profile, ensure_basic_skill_definitions,
  find_skill_definitions, generate_skill_markdown, get_skill_definition, list_skill_definitions,
  put_untrusted_skill_definition, select_curated_library, skill_cards_for_goal,
} from './skills'
import { filtered_library_entries, skill_detail_rows } from './skills_window'

beforeEach(() => { (globalThis as any).storage = {} })

describe('leveled knowledge and skills as a selectable, honest method library', () => {
  it('keeps the legacy default unchanged and installs the complete classified profile without duplicate basic curation', () => {
    expect(curated_library_profile()).toBe('basic')
    ensure_basic_skill_definitions()
    const baseline = list_skill_definitions().map(entry => JSON.stringify(entry))
    expect(baseline).toHaveLength(11)
    expect(select_curated_library('leveled')).toMatchObject({ profile: 'leveled', added: 48, removed: 11, total: 48 })
    const entries = list_skill_definitions()
    expect(entries).toHaveLength(48)
    expect(entries.filter(entry => entry.content_type === 'knowledge')).toHaveLength(6)
    expect(entries.filter(entry => entry.content_type === 'skill')).toHaveLength(42)
    for (let level = 0; level <= 7; level++) expect(entries.filter(entry => entry.level === level)).toHaveLength(6)
    expect(ensure_basic_skill_definitions()).toEqual({ added: 0, upgraded: 0, removed: 0, total: 48 })
    select_curated_library('basic')
    expect(list_skill_definitions().map(entry => JSON.stringify(entry))).toEqual(baseline)
    for (const entry of BASIC_SKILL_DEFINITIONS) expect(get_skill_definition(entry.id)).toBeDefined()
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
    const ids = LEVELED_SKILL_DEFINITIONS.map(entry => entry.id)
    expect(new Set(ids).size).toBe(48)
    for (const raw of LEVELED_SKILL_DEFINITIONS) {
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

  it('preserves type, complexity and actionable content through discovery, details and Markdown export', () => {
    select_curated_library('leveled')
    const result = find_skill_definitions('freshness', 10).find(entry => entry.id === 'knowledge-rates-stocks-freshness')!
    expect(result).toMatchObject({ content_type: 'knowledge', level: 0 })
    const card = skill_cards_for_goal('freshness', 10).find(entry => entry.id === result.id)!
    expect(card).toMatchObject({ content_type: 'knowledge', level: 0 })
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
    expect(filtered_library_entries(entries, { type: 'knowledge', level: -1 })).toHaveLength(6)
    expect(filtered_library_entries(entries, { type: 'skill', level: 3 })).toHaveLength(6)
    expect(filtered_library_entries(entries, { type: 'knowledge', level: 3 })).toEqual([])
    expect(filtered_library_entries(entries, { type: 'all', level: -2 })).toEqual([])
    expect(JSON.stringify((globalThis as any).storage)).toBe(before)
  })

  it('refuses invalid new metadata and does not let physical verification claim knowledge mastery', () => {
    const entry = LEVELED_SKILL_DEFINITIONS[0]
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
