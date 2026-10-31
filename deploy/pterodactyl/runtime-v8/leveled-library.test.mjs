import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compactLoadedSkill, parseSkillOffers, renderSkillCard } from './skill-offers.mjs'

const pack = JSON.parse(readFileSync(new URL('../../../packages/autorio/src/fixtures/leveled-library-v1.json', import.meta.url), 'utf8'))

test('all authored leveled methods survive the real model-context compactor without losing decisions or applicability', () => {
  assert.equal(pack.skills.length, 54)
  assert.equal(pack.default_enabled, false)
  const sizes = []
  for (const original of pack.skills) {
    const compact = compactLoadedSkill(original, original.id)
    assert.equal(compact.content_type, original.content_type)
    assert.equal(compact.level, original.level)
    assert.deepEqual(compact.guidance, original.guidance)
    assert.deepEqual(compact.known_failure_modes, original.known_failure_modes)
    sizes.push(JSON.stringify(compact).length)
    assert.ok(sizes.at(-1) <= 7000)
  }
  sizes.sort((left, right) => right - left)
  assert.ok(sizes.slice(0, 3).reduce((sum, size) => sum + size, 2) + 2 <= 16000,
    'even the largest selected set fits the existing executor ceiling')
  assert.ok(sizes.slice(0, 6).reduce((sum, size) => sum + size, 2) + 5 <= 32000,
    'the largest planner set fits the existing planner ceiling')
})

test('knowledge stays out of procedural cards and compaction, including invalid type results', () => {
  assert.equal(pack.schema, 2)
  assert.equal(pack.knowledge.length, 6)
  for (const raw of pack.knowledge) {
    assert.equal(compactLoadedSkill(raw, raw.id), undefined)
    assert.deepEqual(parseSkillOffers(JSON.stringify({ ok: true, cards: [raw] })).cards, [])
    assert.equal(raw.verification, undefined)
  }
  assert.deepEqual(parseSkillOffers(JSON.stringify({ ok: true, cards: [{ ...pack.skills[0], content_type: 'recipe' }] })).cards, [])
  assert.match(renderSkillCard({ ...pack.skills[0], produces: [], needs: [], matched: [], score: 1 }), /skill; L1/)
})
