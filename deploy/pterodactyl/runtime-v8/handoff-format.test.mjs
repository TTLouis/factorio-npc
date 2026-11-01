import assert from 'node:assert/strict'
import test from 'node:test'

import { HANDOFF_NOTE_CHARS, HANDOFF_PACKET_MAX_CHARS, handoffPacketChars, isHandoffPacketRow, plannerReviewNotesRecord,
  PLANNER_REVIEW_NOTES_LABEL, sanitizeHandoffNote } from './handoff-format.mjs'
import { buildHandoffPacket, HANDOFF_PACKET_LIMITS, sanitizeHandoffNote as compatibleSanitizer,
  PLANNER_REVIEW_NOTES_LABEL as compatibleLabel } from './handoff-packet.mjs'
import { MAX_REVIEW_NOTES_CHARS } from './planning-state.mjs'
import { POST_BATCH_FACT_CHARS } from './post-batch-facts.mjs'
import { deduplicateTopologySkillRefs, TOPOLOGY_LIMITS } from './topology-context.mjs'

test('public packet limits and sanitizer exports retain their values and identity', () => {
  assert.equal(HANDOFF_PACKET_LIMITS.maxChars, HANDOFF_PACKET_MAX_CHARS)
  assert.equal(HANDOFF_PACKET_MAX_CHARS, 6000)
  assert.equal(HANDOFF_NOTE_CHARS, 500)
  assert.equal(POST_BATCH_FACT_CHARS, 8000)
  assert.equal(TOPOLOGY_LIMITS.chars, 1950)
  assert.equal(compatibleSanitizer, sanitizeHandoffNote)
  assert.equal(compatibleLabel, PLANNER_REVIEW_NOTES_LABEL)
})

test('shared row measurement includes separators and excludes topology, non-packet and assistant rows', () => {
  const rows = [{ role: 'user', content: '[HANDOFF] stable' }, { role: 'user', content: '--- step block ---\nactive_step: current' }]
  const other = [{ role: 'assistant', content: '[HANDOFF] not a packet' }, { role: 'user', content: 'fresh_topology: {}' },
    { role: 'user', content: 'ordinary user text' }, { role: 'tool', content: '[HANDOFF] tool' }, { role: 'user', content: null }]
  assert.equal(handoffPacketChars([...rows, ...other]), rows.reduce((sum, row) => sum + row.content.length + 1, 0))
  assert.ok(rows.every(isHandoffPacketRow))
  assert.ok(other.every(row => !isHandoffPacketRow(row)))
})

test('topology skill-reference deduplication retains the exact cap boundary and isolates request copies', () => {
  const step = { role: 'user', content: '--- step block ---\nloaded_skills: fluid' }
  const details = { role: 'user', content: '[SKILL_CONTEXT]\n[{"id":"fluid"}]' }
  const stable = { role: 'user', content: '[HANDOFF]' }
  const target = HANDOFF_PACKET_MAX_CHARS - TOPOLOGY_LIMITS.chars
  stable.content += 'x'.repeat(target - handoffPacketChars([stable, step]))
  const rows = [stable, step, details]
  assert.equal(handoffPacketChars(rows), target)
  assert.deepEqual(deduplicateTopologySkillRefs(rows), { messages: rows, removed: 0 })
  const pressured = [{ ...stable, content: `${stable.content}x` }, step, details]
  const result = deduplicateTopologySkillRefs(pressured)
  assert.equal(result.removed, 'loaded_skills: fluid'.length + 1)
  assert.equal(step.content, '--- step block ---\nloaded_skills: fluid')
  assert.equal(result.messages[0], pressured[0])
  assert.equal(result.messages[2], details)
  assert.equal(result.messages[1].content, '--- step block ---')
})

test('a mandatory packet exactly at the shared ceiling fits; one more character preserves mandatory records and reports over_limit', () => {
  const state = { goal: { goal_id: 'g', objective: 'test' } }
  const build = planningState => buildHandoffPacket({ planningState, role: 'executor', checkpoint: 'C3' })
  const seed = build(state)
  const atLimit = { goal: { ...state.goal, goal_id: 'g'.repeat(1 + HANDOFF_PACKET_MAX_CHARS - seed.chars) } }
  const packet = build(atLimit)
  assert.equal(packet.chars, HANDOFF_PACKET_MAX_CHARS)
  assert.equal(packet.over_limit, false)
  assert.deepEqual(packet.dropped, [])
  const over = build({ goal: { ...atLimit.goal, goal_id: `${atLimit.goal.goal_id}g` } })
  assert.equal(over.chars, HANDOFF_PACKET_MAX_CHARS + 1)
  assert.equal(over.over_limit, true)
  assert.deepEqual(over.dropped, [])
})

test('review-note record normalizes controls, sanitizes whole identities before capping, and keeps 1200-char notes', () => {
  const note = `${'A'.repeat(MAX_REVIEW_NOTES_CHARS - 12)} tail intact`
  assert.equal(note.length, 1200)
  assert.deepEqual(plannerReviewNotesRecord(note), { key: 'review_notes', block: 'step', drop: 'review_notes', text: `${PLANNER_REVIEW_NOTES_LABEL}${note}` })
  assert.equal(plannerReviewNotesRecord(' \u0000\r\n\t '), undefined)
  assert.equal(sanitizeHandoffNote('one\u0000\u007F\n two\tthree'), 'one two three')
  assert.equal(sanitizeHandoffNote('a'.repeat(501)).length, 500)
  assert.equal(sanitizeHandoffNote('a'.repeat(501)).at(-1), '…')
  const redacted = plannerReviewNotesRecord('unit 37; target_unit_number=48; water@(9,51) approach=(8,49.5)')
  assert.doesNotMatch(redacted.text, /unit 37|=48/)
  assert.match(redacted.text, /water@\(9,51\) approach=\(8,49.5\)/)
  assert.doesNotMatch(sanitizeHandoffNote(`observed_unit_numbers=[${'424242,'.repeat(500)}424242]`, 20), /424242/)
  assert.doesNotMatch(sanitizeHandoffNote('{"unit_number":37,"nested":{"target_unit_number":48},"position":{"x":9,"y":51}}', 1200), /unit_number/)
})
