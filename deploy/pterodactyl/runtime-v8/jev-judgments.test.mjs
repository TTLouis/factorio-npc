import assert from 'node:assert/strict'
import test from 'node:test'

import {
  abandonJudgment,
  earnedStage,
  effectiveStage,
  emptyLedger,
  familyAgreement,
  JUDGMENT_FAMILIES,
  JUDGMENT_PROMOTION,
  pendingJudgment,
  recordJudgment,
  restoreLedger,
  c4ObservationNeeded,
  scoreC4Judgment,
  scoreJudgment,
  scoreObservationFamilies,
  scoreShelfRanking,
  scoreSkillOrder,
  serializeLedger,
  summarizeFamily,
  summarizeLedger,
  tokenBaseline,
} from './jev-judgments.mjs'

// One judgment recorded and scored. Returns { ledger, transitions }.
function judge(ledger, family, agreed, { saving, tokenSample, requestId = 'req_test_1' } = {}) {
  const recorded = recordJudgment(ledger, { family, request_id: requestId, step_id: 'step_1', jev_choice: 'x', jev_confidence: 0.9, alternative: { kind: 'test' }, acted: false })
  const scored = scoreJudgment(recorded.ledger, recorded.judgment.judgment_id, { agreed, saving, token_sample: tokenSample, outcome: { agreed } })
  return { ledger: scored.ledger, transitions: scored.transitions }
}

// Feed `pattern` (true/false per judgment) through the ledger.
function feed(ledger, family, pattern) {
  let current = ledger
  const transitions = []
  for (const agreed of pattern) {
    const step = judge(current, family, agreed)
    current = step.ledger
    transitions.push(...step.transitions)
  }
  return { ledger: current, transitions }
}

const agreeing = count => Array.from({ length: count }, () => true)

test('every family starts in shadow and the caps are the owner\'s: c4 may decide, observation and shelf are advisory, skill order stays shadow', () => {
  const ledger = emptyLedger()
  for (const family of Object.keys(JUDGMENT_FAMILIES)) assert.equal(effectiveStage(ledger, family), 'shadow', family)
  assert.equal(JUDGMENT_FAMILIES.c4_next_step.cap, 'deciding')
  assert.equal(JUDGMENT_FAMILIES.observation_families.cap, 'advisory')
  assert.equal(JUDGMENT_FAMILIES.shelf_ranking.cap, 'advisory')
  assert.equal(JUDGMENT_FAMILIES.skill_order.cap, 'shadow')
  assert.equal(JUDGMENT_PROMOTION.advisoryMinScored, 30)
  assert.equal(JUDGMENT_PROMOTION.decidingMinScored, 60)
  assert.equal(JUDGMENT_PROMOTION.minAgreement, 0.9)
})

test('advisory needs 30 scored judgments: 29 stay shadow, the 30th promotes, each with the evidence in the reason', () => {
  const at29 = feed(emptyLedger(), 'c4_next_step', agreeing(29))
  assert.equal(effectiveStage(at29.ledger, 'c4_next_step'), 'shadow')
  assert.deepEqual(at29.transitions, [])
  const at30 = feed(at29.ledger, 'c4_next_step', [true])
  assert.equal(effectiveStage(at30.ledger, 'c4_next_step'), 'advisory')
  assert.equal(at30.transitions.length, 1)
  const [change] = at30.transitions
  assert.equal(change.direction, 'promoted')
  assert.equal(change.from, 'shadow')
  assert.equal(change.to, 'advisory')
  assert.match(change.reason, /evidence_met: 30\/30 agreed over 30 scored judgments/)
  assert.equal(change.scored_total, 30)
})

test('deciding needs 60 scored judgments: 59 stay advisory, the 60th promotes', () => {
  const at59 = feed(emptyLedger(), 'c4_next_step', agreeing(59))
  assert.equal(effectiveStage(at59.ledger, 'c4_next_step'), 'advisory')
  assert.equal(at59.transitions.length, 1, 'only the advisory promotion so far')
  const at60 = feed(at59.ledger, 'c4_next_step', [true])
  assert.equal(effectiveStage(at60.ledger, 'c4_next_step'), 'deciding')
  assert.equal(at60.transitions.length, 1)
  assert.equal(at60.transitions[0].to, 'deciding')
  assert.match(at60.transitions[0].reason, /evidence_met: 60\/60 agreed over 60 scored judgments/)
})

test('the 90% boundary is inclusive: 27/30 promotes, 26/30 does not; 54/60 decides, 53/60 does not', () => {
  const ninety = [...agreeing(27), false, false, false]
  assert.equal(effectiveStage(feed(emptyLedger(), 'c4_next_step', ninety).ledger, 'c4_next_step'), 'advisory')
  const eightySeven = [...agreeing(26), false, false, false, false]
  assert.equal(effectiveStage(feed(emptyLedger(), 'c4_next_step', eightySeven).ledger, 'c4_next_step'), 'shadow')

  // 54/60: the misses come first, then enough agreement to keep the rolling 60 at exactly 90%.
  const sixty = [...agreeing(30), ...agreeing(24), false, false, false, false, false, false]
  const reached = feed(emptyLedger(), 'c4_next_step', sixty)
  assert.equal(effectiveStage(reached.ledger, 'c4_next_step'), 'deciding')
  assert.equal(familyAgreement(reached.ledger, 'c4_next_step'), 0.9)
  const tooMany = [...agreeing(30), ...agreeing(23), false, false, false, false, false, false, false]
  assert.notEqual(effectiveStage(feed(emptyLedger(), 'c4_next_step', tooMany).ledger, 'c4_next_step'), 'deciding')
})

test('a stage change is never skipped: an unscored family with 60 good judgments earned advisory at 30 and deciding at 60, in that order', () => {
  const { transitions } = feed(emptyLedger(), 'observation_families', agreeing(60))
  assert.deepEqual(transitions.map(change => `${change.from}->${change.to}`), ['shadow->advisory', 'advisory->deciding'])
})

test('a family above 90% is demoted to shadow as soon as its rolling agreement drops below 90%, and must earn promotion again from fresh evidence', () => {
  const promoted = feed(emptyLedger(), 'c4_next_step', agreeing(60))
  assert.equal(effectiveStage(promoted.ledger, 'c4_next_step'), 'deciding')
  // 54/60 is still exactly 90%: one more miss pushes the rolling window under it.
  const six = feed(promoted.ledger, 'c4_next_step', [false, false, false, false, false, false])
  assert.equal(effectiveStage(six.ledger, 'c4_next_step'), 'deciding', '54/60 holds')
  const seventh = feed(six.ledger, 'c4_next_step', [false])
  assert.equal(effectiveStage(seventh.ledger, 'c4_next_step'), 'shadow')
  assert.equal(seventh.transitions.length, 1)
  const [demotion] = seventh.transitions
  assert.equal(demotion.direction, 'demoted')
  assert.equal(demotion.from, 'deciding')
  assert.equal(demotion.to, 'shadow')
  assert.match(demotion.reason, /rolling_agreement_below_threshold: 53\/60/)
  assert.equal(summarizeFamily(seventh.ledger, 'c4_next_step').demotions, 1)

  // Nothing from before the demotion counts: 29 perfect judgments are not enough, the 30th is.
  const again29 = feed(seventh.ledger, 'c4_next_step', agreeing(29))
  assert.equal(effectiveStage(again29.ledger, 'c4_next_step'), 'shadow')
  const again30 = feed(again29.ledger, 'c4_next_step', [true])
  assert.equal(effectiveStage(again30.ledger, 'c4_next_step'), 'advisory')
})

test('an advisory family is demoted too, and tracing (scoring) goes on after promotion', () => {
  const promoted = feed(emptyLedger(), 'shelf_ranking', agreeing(30))
  assert.equal(effectiveStage(promoted.ledger, 'shelf_ranking'), 'advisory')
  const scoredBefore = summarizeFamily(promoted.ledger, 'shelf_ranking').scored
  const more = feed(promoted.ledger, 'shelf_ranking', agreeing(5))
  assert.equal(summarizeFamily(more.ledger, 'shelf_ranking').scored, scoredBefore + 5, 'still scored after promotion')
  const dropped = feed(more.ledger, 'shelf_ranking', [false, false, false, false])
  assert.equal(effectiveStage(dropped.ledger, 'shelf_ranking'), 'shadow')
  assert.equal(dropped.transitions.at(-1).direction, 'demoted')
})

test('a family never acts above its cap: skill order earns advisory on the evidence but stays shadow in use', () => {
  const { ledger, transitions } = feed(emptyLedger(), 'skill_order', agreeing(60))
  assert.equal(earnedStage(ledger, 'skill_order'), 'deciding')
  assert.equal(effectiveStage(ledger, 'skill_order'), 'shadow')
  assert.ok(transitions.every(change => change.effective_to === 'shadow' && change.cap === 'shadow'))
  assert.equal(summarizeFamily(ledger, 'skill_order').stage, 'shadow')
  assert.equal(summarizeFamily(ledger, 'skill_order').earned_stage, 'deciding')
  const observation = feed(emptyLedger(), 'observation_families', agreeing(60)).ledger
  assert.equal(effectiveStage(observation, 'observation_families'), 'advisory')
})

test('a judgment records the stage it was made in and only acts above shadow', () => {
  const shadow = recordJudgment(emptyLedger(), { family: 'c4_next_step', request_id: 'req_1', acted: true, jev_choice: 'direct_to_executor' })
  assert.equal(shadow.judgment.stage, 'shadow')
  assert.equal(shadow.judgment.acted, false, 'a shadow judgment cannot act, whatever the caller asked')
  const promoted = feed(emptyLedger(), 'c4_next_step', agreeing(60)).ledger
  const deciding = recordJudgment(promoted, { family: 'c4_next_step', request_id: 'req_1', acted: true, jev_choice: 'direct_to_executor' })
  assert.equal(deciding.judgment.stage, 'deciding')
  assert.equal(deciding.judgment.acted, true)
  assert.equal(recordJudgment(emptyLedger(), { family: 'not_a_family' }), undefined)
})

test('a judgment abandoned before an outcome is never counted as agreement', () => {
  const recorded = recordJudgment(emptyLedger(), { family: 'c4_next_step', request_id: 'req_1', jev_choice: 'direct_to_executor' })
  const abandoned = abandonJudgment(recorded.ledger, recorded.judgment.judgment_id)
  const summary = summarizeFamily(abandoned.ledger, 'c4_next_step')
  assert.equal(summary.scored, 0)
  assert.equal(summary.agreed, 0)
  assert.equal(summary.unscored, 1)
  assert.equal(pendingJudgment(abandoned.ledger, recorded.judgment.judgment_id), undefined)
  assert.equal(scoreJudgment(abandoned.ledger, recorded.judgment.judgment_id, { agreed: true }), undefined, 'an abandoned judgment cannot be scored later')
  assert.equal(abandonJudgment(abandoned.ledger, 'jdg_nope'), undefined)
})

test('the ledger is bounded: pending judgments are capped and a persisted ledger keeps only bounded fields', () => {
  let ledger = emptyLedger()
  for (let index = 0; index < 100; index++) ledger = recordJudgment(ledger, { family: 'skill_order', request_id: `req_${index}` }).ledger
  assert.ok(Object.keys(ledger.pending).length <= 64)
  assert.ok(summarizeFamily(ledger, 'skill_order').unscored >= 36)
  const fed = feed(emptyLedger(), 'c4_next_step', agreeing(200)).ledger
  const saved = serializeLedger(fed)
  assert.ok(saved.families.c4_next_step.window.length <= JUDGMENT_PROMOTION.window)
  assert.ok(saved.families.c4_next_step.recent.length <= 20)
  assert.equal(saved.families.c4_next_step.scored, 200)
  assert.equal('pending' in saved, false)
})

test('the ledger survives a restart: serialize, JSON round trip and restore give the same stages, counts and agreement', () => {
  let ledger = feed(emptyLedger(), 'c4_next_step', agreeing(60)).ledger
  ledger = feed(ledger, 'observation_families', [...agreeing(12), false, false]).ledger
  ledger = feed(ledger, 'shelf_ranking', agreeing(30)).ledger
  const restored = restoreLedger(JSON.parse(JSON.stringify(serializeLedger(ledger))))
  assert.deepEqual(restored.clamped, [])
  assert.deepEqual(summarizeLedger(restored.ledger), summarizeLedger(ledger))
  assert.equal(effectiveStage(restored.ledger, 'c4_next_step'), 'deciding')
  assert.equal(effectiveStage(restored.ledger, 'shelf_ranking'), 'advisory')
  assert.equal(effectiveStage(restored.ledger, 'observation_families'), 'shadow')
  // A restored ledger keeps counting from where it was: the 61st judgment and the demotion rules still apply.
  const next = feed(restored.ledger, 'c4_next_step', [true])
  assert.equal(summarizeFamily(next.ledger, 'c4_next_step').scored, 61)
  // Ids stay unique: the counter persisted.
  assert.equal(restored.ledger.seq, ledger.seq)
})

test('a persisted stage the recorded evidence does not support is clamped down on restore, never trusted', () => {
  const forged = serializeLedger(emptyLedger())
  forged.families.c4_next_step.stage = 'deciding'
  forged.families.observation_families = { ...forged.families.observation_families, stage: 'advisory', scored: 40, evidence: 40, window: [...agreeing(30), ...Array.from({ length: 10 }, () => false)] }
  const { ledger, clamped } = restoreLedger(forged)
  assert.equal(effectiveStage(ledger, 'c4_next_step'), 'shadow')
  assert.equal(effectiveStage(ledger, 'observation_families'), 'shadow', '30/40 is 75%')
  assert.deepEqual(clamped.map(item => `${item.family}: ${item.from}->${item.to}`), ['c4_next_step: deciding->shadow', 'observation_families: advisory->shadow'])
  // Garbage never throws and starts every family in shadow.
  for (const raw of [undefined, null, 'x', { version: 2 }, { version: 1, families: { c4_next_step: { stage: 'deciding', scored: 'many' } } }]) {
    const restored = restoreLedger(raw).ledger
    for (const family of Object.keys(JUDGMENT_FAMILIES)) assert.equal(effectiveStage(restored, family), 'shadow')
  }
})

test('savings: a saving counts only when the outcome agreed, in the shadow or the realized column by whether the judgment acted; a family with no saving after 30 scored is flagged for removal', () => {
  let ledger = emptyLedger()
  ledger = judge(ledger, 'c4_next_step', true, { saving: { jev_calls: 2, rounds: 1, tokens: 900 } }).ledger
  ledger = judge(ledger, 'c4_next_step', false, { saving: { jev_calls: 2, rounds: 3, tokens: 5000 } }).ledger
  let summary = summarizeFamily(ledger, 'c4_next_step')
  assert.deepEqual(summary.would_save, { wakes: 0, rounds: 1, tokens: 900, calls: 0, jev_calls: 2 }, 'the disagreeing judgment saved nothing')
  assert.deepEqual(summary.saved, { wakes: 0, rounds: 0, tokens: 0, calls: 0, jev_calls: 0 })
  assert.equal(summary.removal_candidate, false, 'too few scored judgments to call')

  // A judgment that acted: its saving is the realized column.
  const promoted = feed(emptyLedger(), 'c4_next_step', agreeing(60)).ledger
  const acted = recordJudgment(promoted, { family: 'c4_next_step', request_id: 'req_1', acted: true })
  const scored = scoreJudgment(acted.ledger, acted.judgment.judgment_id, { agreed: true, saving: { jev_calls: 2 } })
  summary = summarizeFamily(scored.ledger, 'c4_next_step')
  assert.deepEqual(summary.saved, { wakes: 0, rounds: 0, tokens: 0, calls: 0, jev_calls: 2 })

  // 30 scored judgments and nothing saved in ANY channel: flagged, never removed.
  const barren = feed(emptyLedger(), 'shelf_ranking', agreeing(30)).ledger
  const flagged = summarizeFamily(barren, 'shelf_ranking')
  assert.equal(flagged.removal_candidate, true)
  assert.match(flagged.removal_reason, /no measured saving .* after 30 scored judgments; removal is the owner's call/)
  assert.equal(summarizeFamily(feed(emptyLedger(), 'shelf_ranking', agreeing(29)).ledger, 'shelf_ranking').removal_candidate, false)
  const saving = judge(barren, 'shelf_ranking', true, { saving: { calls: 1 } }).ledger
  assert.equal(summarizeFamily(saving, 'shelf_ranking').removal_candidate, false, 'any measured saving clears the flag')
  const jevCalls = judge(barren, 'shelf_ranking', true, { saving: { jev_calls: 1 } }).ledger
  assert.equal(summarizeFamily(jevCalls, 'shelf_ranking').removal_candidate, false, 'Jev calls not made count')
})

test('scoreC4Judgment: ONE outcome label (observation needed = the wake looked something up OR the step did not verify on its first batch); direct agrees iff not needed, ground_first iff needed', () => {
  const clean = { fresh_lookups: 0, verified: true, first_try: true }
  assert.deepEqual(scoreC4Judgment({ choice: 'direct_to_executor', ...clean }), { agreed: true, observation_needed: false })
  assert.deepEqual(scoreC4Judgment({ choice: 'ground_first', ...clean }), { agreed: false, observation_needed: false }, 'over-cautious')
  // A lookup makes observation needed, whatever happened to the step: the two answers can never both agree.
  assert.deepEqual(scoreC4Judgment({ choice: 'direct_to_executor', fresh_lookups: 3, verified: true, first_try: true }), { agreed: false, observation_needed: true })
  assert.deepEqual(scoreC4Judgment({ choice: 'ground_first', fresh_lookups: 3, verified: true, first_try: true }), { agreed: true, observation_needed: true })
  // A step that did not verify on its first batch needs observation, with or without lookups.
  assert.deepEqual(scoreC4Judgment({ choice: 'direct_to_executor', fresh_lookups: 0, verified: true, first_try: false }), { agreed: false, observation_needed: true })
  assert.deepEqual(scoreC4Judgment({ choice: 'direct_to_executor', fresh_lookups: 0, verified: false, first_try: false }), { agreed: false, observation_needed: true })
  assert.deepEqual(scoreC4Judgment({ choice: 'ground_first', fresh_lookups: 0, verified: false, first_try: false }), { agreed: true, observation_needed: true })
  assert.deepEqual(scoreC4Judgment({ choice: 'direct_to_executor', fresh_lookups: 0, verified: undefined, first_try: false }), { agreed: false, observation_needed: true }, 'a failed first batch is final: no need to wait for the step')
  // Only "not needed" has to wait for the step to verify.
  assert.equal(scoreC4Judgment({ choice: 'direct_to_executor', fresh_lookups: 0, verified: undefined, first_try: true }), undefined)
  assert.equal(c4ObservationNeeded({ fresh_lookups: 0, verified: undefined, first_try: true }), undefined)
  assert.equal(scoreC4Judgment({ choice: 'maybe', ...clean }), undefined)
  assert.equal(scoreC4Judgment({ choice: 'direct_to_executor', fresh_lookups: undefined, verified: true, first_try: true }), undefined)
  // Mutually exclusive over every outcome.
  for (const fresh_lookups of [0, 1, 4]) for (const verified of [true, false, undefined]) for (const first_try of [true, false]) {
    const direct = scoreC4Judgment({ choice: 'direct_to_executor', fresh_lookups, verified, first_try })
    const ground = scoreC4Judgment({ choice: 'ground_first', fresh_lookups, verified, first_try })
    assert.equal(direct === undefined, ground === undefined)
    if (direct) assert.notEqual(direct.agreed, ground.agreed)
  }
})

test('scoreObservationFamilies: two-sided in shadow; with facts supplied precision is scored over the UNSUPPLIED picks; no lookup at all is never agreement', () => {
  assert.equal(scoreObservationFamilies({ selected: ['inventory_equipment'], looked: ['inventory_equipment'] }).agreed, true)
  assert.equal(scoreObservationFamilies({ selected: ['inventory_equipment', 'nearby_world'], looked: ['inventory_equipment'] }).agreed, true, 'precision 0.5')
  assert.equal(scoreObservationFamilies({ selected: ['a', 'b', 'c'], looked: ['a'] }).agreed, false, 'precision 1/3')
  assert.equal(scoreObservationFamilies({ selected: ['nearby_world'], looked: ['inventory_equipment', 'entity_status'] }).agreed, false, 'recall 0')
  assert.equal(scoreObservationFamilies({ selected: [], looked: ['nearby_world'] }).agreed, false, 'Jev predicted nothing and the agent looked something up')
  // Nothing looked up and nothing picked: there is nothing to compare, so it is NOT agreement (neutral, left unscored).
  const nothing = scoreObservationFamilies({ selected: [], looked: [] })
  assert.equal(nothing.neutral, true)
  assert.equal(nothing.agreed, undefined)
  // Something picked, nothing looked up, nothing supplied: Jev over-predicted.
  assert.deepEqual({ agreed: scoreObservationFamilies({ selected: ['nearby_world'], looked: [] }).agreed, neutral: scoreObservationFamilies({ selected: ['nearby_world'], looked: [] }).neutral }, { agreed: false, neutral: false })
  // Facts supplied: a supplied family is never looked up, so every pick supplied and no lookup is neutral, not agreement.
  const supplied = scoreObservationFamilies({ selected: ['inventory_equipment', 'research_state'], looked: [], provided: ['inventory_equipment', 'research_state'] })
  assert.equal(supplied.neutral, true)
  assert.equal(supplied.agreed, undefined)
  // Precision over what was NOT supplied: Jev picked nearby_world too and the agent never looked there: disagree.
  assert.equal(scoreObservationFamilies({ selected: ['inventory_equipment', 'nearby_world'], looked: [], provided: ['inventory_equipment'] }).agreed, false)
  assert.equal(scoreObservationFamilies({ selected: ['inventory_equipment', 'nearby_world'], looked: ['nearby_world'], provided: ['inventory_equipment'] }).agreed, true)
  assert.equal(scoreObservationFamilies({ selected: ['inventory_equipment'], looked: ['nearby_world', 'entity_status'], provided: ['inventory_equipment'] }).agreed, false, 'the agent still needed lookups Jev missed')
  assert.equal(scoreObservationFamilies({ selected: ['a', 'a', 'b'], looked: ['a', 'a'] }).precision, 0.5, 'duplicates are counted once')
})

test('scoreShelfRanking: the planner must have picked Jev\'s first node and that slice must have verified', () => {
  const ranked = ['node_b', 'node_a', 'node_c']
  assert.deepEqual(scoreShelfRanking({ ranked, picked: 'node_b', verified: true }), { agreed: true, picked_rank: 1 })
  assert.deepEqual(scoreShelfRanking({ ranked, picked: 'node_a', verified: true }), { agreed: false, picked_rank: 2 })
  assert.deepEqual(scoreShelfRanking({ ranked, picked: 'node_b', verified: false }), { agreed: false, picked_rank: 1 })
  assert.equal(scoreShelfRanking({ ranked, picked: 'node_b', verified: undefined }), undefined, 'the slice has not closed')
  assert.equal(scoreShelfRanking({ ranked, picked: undefined, verified: true }), undefined)
  assert.equal(scoreShelfRanking({ ranked: [], picked: 'node_b', verified: true }), undefined)
  assert.deepEqual(scoreShelfRanking({ ranked, picked: 'node_z', verified: true }), { agreed: false, picked_rank: undefined })
})

test('scoreSkillOrder: Jev\'s pick counts when the fresh agent loaded that skill; none counts when it loaded nothing', () => {
  assert.equal(scoreSkillOrder({ pick: 'burner-coal-loop', loaded: ['burner-coal-loop'] }).agreed, true)
  assert.equal(scoreSkillOrder({ pick: 'burner-coal-loop', loaded: [] }).agreed, false)
  assert.equal(scoreSkillOrder({ pick: 'burner-coal-loop', loaded: ['other'] }).agreed, false)
  assert.equal(scoreSkillOrder({ pick: 'none', loaded: [] }).agreed, true)
  assert.equal(scoreSkillOrder({ pick: 'none', loaded: ['other'] }).agreed, false)
})
