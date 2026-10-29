import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compactLoadedSkill, parseSkillOffers, renderSkillCard } from './skill-offers.mjs'

const pack = JSON.parse(readFileSync(new URL('../../../packages/autorio/src/fixtures/leveled-library-v1.json', import.meta.url), 'utf8'))

test('all authored leveled methods survive the real model-context compactor without losing decisions or applicability', () => {
  assert.equal(pack.skills.length, 60)
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

test('discovery preserves knowledge/skill and level labels without treating difficulty as verification', () => {
  const raw = { ...pack.skills.find(entry => entry.id === 'knowledge-available-capabilities'), produces: [], needs: [], matched: ['capability'], score: 1 }
  const offer = parseSkillOffers(JSON.stringify({ ok: true, cards: [raw] }))
  assert.equal(offer.cards[0].content_type, 'knowledge')
  assert.equal(offer.cards[0].level, 0)
  assert.match(renderSkillCard(offer.cards[0]), /candidate; knowledge; L0/)
  const invalid = parseSkillOffers(JSON.stringify({ ok: true, cards: [{ ...raw, content_type: 'recipe', level: 99 }] }))
  assert.equal(invalid.cards[0].content_type, undefined)
  assert.equal(invalid.cards[0].level, undefined)
})
