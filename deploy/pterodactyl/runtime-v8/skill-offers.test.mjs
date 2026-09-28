// Plan item 2.8: skill cards are offered in plan-authoring context without the
// model asking; each need is have / can_craft / locked (with the technology) /
// unknown; Jev judges the SAME cards in shadow mode (traced, never in the
// prompt, no key needed); offered / ranked / loaded / followed are traced with
// the request id. Static scenario: fake Factorio, scripted planner and Jev.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { DECISION_PROVIDER_DEFAULTS, normalizeDecisionProviderRequest } from './provider.mjs'
import {
  injectedSkillChars,
  parseSkillChoice,
  parseSkillOffers,
  refreshSkillOffersAtShelfPickup,
  renderSkillCard,
  SKILL_CARD_MAX_CHARS,
  SKILL_CHOICE_MODE,
  SKILL_OFFERS_PREFIX,
  skillChoiceQuestions,
  skillOfferBlock,
  skillOfferCommand,
  skillOffersContext,
  utf8Prefix,
} from './skill-offers.mjs'
import { FakeFactorio, planReply, recordingJev } from './task-loop-fixtures.mjs'

// What the mod's autorio_skills.offer returns for the steam goal on a fresh
// base-game save (same shape as the card snapshot in packages/autorio
// skills.test.ts).
const STEAM_CARDS = [
  {
    id: 'steam-power-bootstrap',
    name: 'Steam Power Bootstrap',
    status: 'candidate',
    summary: 'Bring up the first reliable electric power with the smallest live-compatible water-to-steam-to-generator chain, then connect the electrical network and fuel ...',
    produces: ['electric-power'],
    needs: [
      { subject: 'offshore-pump', state: 'locked', technology: 'steam-power' },
      { subject: 'boiler', state: 'locked', technology: 'steam-power' },
      { subject: 'generator', state: 'locked', technology: 'steam-power', via: 'steam-engine' },
      { subject: 'fuel-or-energy-input', state: 'unknown' },
    ],
    matched: ['power', 'electricity', 'steam', 'steam-power', 'text:running'],
    score: 16.25,
  },
  {
    id: 'starter-mining-belt-output',
    name: 'Starter Mining Belt Output',
    status: 'candidate',
    summary: 'Build an early scalable mining row by placing drills that genuinely cover the resource patch and orienting their outputs onto a shared belt or other collection path.',
    produces: ['mined-resource'],
    needs: [
      { subject: 'resource-patch', state: 'unknown' },
      { subject: 'mining-drill', state: 'can_craft', via: 'burner-mining-drill' },
      { subject: 'collection-path', state: 'unknown' },
    ],
    matched: ['text:power', 'text:running'],
    score: 2,
  },
]

const STEAM_GOAL = 'Get steam power running so we have electricity'
const offersIn = messages => messages.find(message => typeof message.content === 'string' && message.content.includes(SKILL_OFFERS_PREFIX))

class SkillFactorio extends FakeFactorio {
  constructor({ offer } = {}) {
    super()
    this.offer = offer
    this.offerRequests = []
    this.skills['steam-power-bootstrap'] = { id: 'steam-power-bootstrap', name: 'Steam Power Bootstrap', revision: 2, status: 'candidate', stage: 'pattern', summary: 'Starter steam power.' }
  }

  async command(text) {
    if (text.includes('remote.call("autorio_skills","offer"')) {
      const encoded = /helpers\.json_to_table\('((?:[^'\\]|\\.)*)'\)/.exec(text)?.[1]
      this.offerRequests.push(JSON.parse(encoded.replace(/\\(.)/g, '$1')))
      if (this.offer === 'throw') throw new Error('RCON timed out')
      return JSON.stringify(this.offer ?? { ok: true, cards: STEAM_CARDS })
    }
    return super.command(text)
  }
}

const toolCall = (id, index, name, args = {}) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

async function scenario({ game = new SkillFactorio(), jev, planner, intents, requests = [STEAM_GOAL], afterFirst } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-skill-offers-'))
  const traceFile = path.join(dir, 'sgluna-behavior.jsonl')
  const calls = []
  const world = { intent: intents?.[0] ?? 'new_goal' }
  const agent = new NpcAgentLoop({
    rcon: game,
    memory: new CanonicalTaskBoardMemory(),
    systemPrompt: 'skill offers scenario',
    npcId: 'airi',
    stateFile: null,
    traceFile,
    decisionTraceFile: null,
    ...(jev ? { skillDecisionProvider: jev } : {}),
    ...(intents ? { interactionProvider: async () => ({ content: JSON.stringify({ intent: world.intent, queue_conflict: false, reply: 'ok' }) }) } : {}),
    provider: async (messages) => {
      calls.push(messages.map(message => ({ ...message })))
      return planner
        ? planner(calls.length, messages)
        : planReply({ plan: ['Build a starter steam power chain', 'Check the generator runs'], operations: [{ name: 'wait', args: { ticks: 1 } }] })
    },
  })
  for (let index = 0; index < requests.length; index++) {
    world.intent = intents?.[index] ?? world.intent
    await agent.request(requests[index], { sender: 'Louis' })
    if (index === 0 && afterFirst) await afterFirst(agent)
  }
  const rows = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { agent, game, calls, rows, events: name => rows.filter(row => row.event === name) }
}

test('offer command sends the goal cut to 500 UTF-8 bytes on a character boundary, safely quoted', () => {
  const command = skillOfferCommand('it\'s "steam" power', 5)
  assert.match(command, /remote\.call\("autorio_skills","offer",request\)/)
  assert.doesNotMatch(command, /loadstring|game\.print|pcall/)
  const decode = text => JSON.parse(/helpers\.json_to_table\('((?:[^'\\]|\\.)*)'\)/.exec(text)[1].replace(/\\(.)/g, '$1'))
  assert.deepEqual(decode(command), { goal: 'it\'s "steam" power', limit: 5 })

  // A long Chinese goal: 3 bytes per character, so 166 characters fit.
  const chinese = '我们需要尽快建一个煤蛇'.repeat(30)
  const goal = decode(skillOfferCommand(chinese)).goal
  assert.equal(Buffer.byteLength(goal, 'utf8'), 498)
  assert.equal(goal.length, 166)
  assert.ok(chinese.startsWith(goal))
  assert.equal(utf8Prefix('ab煤蛇', 4), 'ab')
  assert.equal(utf8Prefix('ab煤蛇', 5), 'ab煤')
  assert.equal(utf8Prefix('😀x', 3), '')
})

test('parsed cards are bounded, deduplicated and drop malformed entries and needs', () => {
  const long = 'x'.repeat(900)
  const parsed = parseSkillOffers(JSON.stringify({
    ok: true,
    cards: [
      STEAM_CARDS[0],
      STEAM_CARDS[0],
      { id: 'Bad Id!', name: 'bad' },
      { id: 'none', name: 'collides with the Jev none option' },
      { id: 'huge-card', name: long, status: 'weird', summary: long, produces: Array(20).fill('a'), needs: [{ subject: 'x', state: 'bogus', technology: 'BAD TECH' }, 'plain-need', ...Array(8).fill({ subject: 'y', state: 'have' })], matched: [], score: 1 },
      ...Array.from({ length: 6 }, (_, index) => ({ ...STEAM_CARDS[1], id: `extra-${index}` })),
    ],
  }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.cards.length, 5)
  assert.deepEqual(parsed.cards.map(card => card.id).slice(0, 2), ['steam-power-bootstrap', 'huge-card'])
  const huge = parsed.cards[1]
  assert.equal(huge.status, 'candidate')
  assert.equal(huge.produces.length, 5)
  assert.equal(huge.needs.length, 5)
  assert.deepEqual(huge.needs.slice(0, 2), [{ subject: 'x', state: 'unknown' }, { subject: 'plain-need', state: 'unknown' }])
  assert.ok(renderSkillCard(huge).length <= SKILL_CARD_MAX_CHARS)
  assert.deepEqual(parseSkillOffers('{}'), { ok: false, reason: 'lookup_failed', error: undefined })
  assert.deepEqual(parseSkillOffers('not json'), { ok: false, reason: 'lookup_unreadable' })
  assert.deepEqual(parseSkillOffers(JSON.stringify({ ok: true, cards: {} })), { ok: true, cards: [] })
})

test('card snapshot: id, name, status, summary, produces, needs as have / can craft / locked with the technology, and matched tags', () => {
  const [steam, mining] = parseSkillOffers(JSON.stringify({ ok: true, cards: STEAM_CARDS })).cards
  assert.equal(
    renderSkillCard(steam),
    'steam-power-bootstrap "Steam Power Bootstrap" [candidate]: Bring up the first reliable electric power with the smallest live-compatible water-to-steam-to-generator chain, then connect the electrical network and fuel ... '
    + 'Produces: electric-power. '
    + 'Needs: offshore-pump (locked: offshore-pump needs steam-power), boiler (locked: boiler needs steam-power), generator (locked: steam-engine needs steam-power), fuel-or-energy-input. '
    + 'Matched: power, electricity, steam, steam-power, text:running.',
  )
  assert.match(renderSkillCard(mining), /Needs: resource-patch, mining-drill \(can craft burner-mining-drill\), collection-path\./)
  const researched = { ...steam, needs: [{ subject: 'automation', state: 'locked', technology: 'automation' }, { subject: 'boiler', state: 'have' }] }
  assert.match(renderSkillCard(researched), /Needs: automation \(locked: needs research automation\), boiler \(have\)\./)
})

test('Jev is asked about exactly the cards the model sees, in a request the live TypeSafe adapter accepts', () => {
  const { cards } = parseSkillOffers(JSON.stringify({ ok: true, cards: STEAM_CARDS }))
  const questions = skillChoiceQuestions(cards)
  normalizeDecisionProviderRequest({ ...DECISION_PROVIDER_DEFAULTS, key: 'contract-check' }, { contract: 'skill_choice', goal: STEAM_GOAL, trigger: 'new_goal', candidate_count: 2 }, questions)
  const block = skillOfferBlock({ cards })
  for (const card of cards) {
    assert.equal(questions.skill_choice.criteria[card.id], renderSkillCard(card))
    assert.ok(block.includes(renderSkillCard(card)))
  }
  assert.ok(questions.skill_choice.criteria.none)

  const choice = parseSkillChoice({
    answers: { skill_choice: { type: 'choice', choice: 'starter-mining-belt-output', confidence: 0.7, probabilities: { 'steam-power-bootstrap': 0.2, 'starter-mining-belt-output': 0.7, 'none': 0.1 } } },
  }, cards)
  assert.deepEqual(choice, { pick: 'starter-mining-belt-output', confidence: 0.7, order: ['starter-mining-belt-output', 'steam-power-bootstrap'] })
  assert.equal(parseSkillChoice({ answers: { skill_choice: { choice: 'made-up-skill', confidence: 1 } } }, cards), undefined)
})

test('a new goal offers the top cards in the planner context before the first model turn, with no Jev key', async () => {
  const { game, calls, events } = await scenario()
  assert.equal(game.offerRequests.length, 1)
  assert.deepEqual(game.offerRequests[0], { goal: STEAM_GOAL, limit: 5 })

  const first = calls[0]
  const offerIndex = first.findIndex(message => typeof message.content === 'string' && message.content.startsWith(SKILL_OFFERS_PREFIX))
  assert.ok(offerIndex > 0, 'the [SKILL_OFFERS] block is in the first planner request')
  const firstTurn = first.findIndex(message => message.role === 'assistant' || message.role === 'tool')
  assert.ok(firstTurn < 0 || offerIndex < firstTurn, 'offers sit in the fixed prefix, before any model turn')
  const block = first[offerIndex].content
  assert.match(block, /^\[SKILL_OFFERS\] .*getSkillDetails/)
  assert.ok(block.includes(`1. ${renderSkillCard(parseSkillOffers(JSON.stringify({ ok: true, cards: STEAM_CARDS })).cards[0])}`))
  assert.doesNotMatch(block, /Advisor:/)

  const [offered] = events('skill.offered')
  assert.ok(offered.request_id, 'skill.offered carries the request id')
  assert.equal(offered.data.trigger, 'new_goal')
  assert.deepEqual(offered.data.offered_ids, ['steam-power-bootstrap', 'starter-mining-belt-output'])
  assert.deepEqual(offered.data.need_counts, { have: 0, can_craft: 1, locked: 3, unknown: 3 })
  assert.deepEqual(offered.data.cards[0].need_counts, { have: 0, can_craft: 0, locked: 3, unknown: 1 })
  assert.deepEqual(offered.data.cards[0].locked[2], { subject: 'generator', technology: 'steam-power' })

  const [ranked] = events('skill.ranked')
  assert.equal(ranked.request_id, offered.request_id)
  assert.equal(ranked.data.source, 'deterministic')
  assert.equal(ranked.data.reason, 'jev_unavailable')
  assert.equal(ranked.data.mode, 'shadow')
  assert.deepEqual(ranked.data.deterministic_order, ['steam-power-bootstrap', 'starter-mining-belt-output'])
})

test('Jev runs in shadow mode: its pick is traced with a cancel signal but never reaches the prompt', async () => {
  assert.equal(SKILL_CHOICE_MODE, 'shadow')
  const signals = []
  const jev = recordingJev(async (_state, questions, _call, context) => {
    if (!questions.skill_choice) return undefined
    signals.push(context?.signal)
    return {
      answers: {
        skill_choice: {
          type: 'choice',
          choice: 'starter-mining-belt-output',
          confidence: 0.82,
          probabilities: { 'steam-power-bootstrap': 0.08, 'starter-mining-belt-output': 0.82, 'none': 0.1 },
        },
      },
      provider: 'fixture-jev',
      model: 'fixture',
    }
  })
  const { calls, events } = await scenario({ jev })
  const asked = jev.callsWith('skill_choice')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].state.contract, 'skill_choice')
  assert.equal(asked[0].state.trigger, 'new_goal')
  assert.ok(signals[0] instanceof AbortSignal)

  const block = offersIn(calls[0]).content
  assert.match(block, /1\. steam-power-bootstrap .*\n2\. starter-mining-belt-output /)
  assert.doesNotMatch(block, /Advisor|Jev/)

  const [ranked] = events('skill.ranked')
  assert.ok(ranked.request_id)
  assert.equal(ranked.data.source, 'jev')
  assert.equal(ranked.data.mode, 'shadow')
  assert.equal(ranked.data.reason, 'jev_confident_pick')
  assert.equal(ranked.data.jev_pick, 'starter-mining-belt-output')
  assert.equal(ranked.data.agrees_with_top, false)
  assert.equal(ranked.data.prompt_applied, false)
  assert.deepEqual(ranked.data.jev_order, ['starter-mining-belt-output', 'steam-power-bootstrap'])
})

test('a failing or unsure Jev falls back to the deterministic order and says why', async () => {
  const failing = recordingJev(async (_state, questions) => {
    if (questions.skill_choice) throw new Error('Decision provider HTTP 503; request will not be retried automatically')
    return undefined
  })
  const failed = await scenario({ jev: failing })
  const [fallback] = failed.events('skill.ranked')
  assert.equal(fallback.data.source, 'deterministic')
  assert.equal(fallback.data.reason, 'jev_error')
  assert.match(fallback.data.error, /HTTP 503/)
  assert.ok(offersIn(failed.calls[0]))

  const unsure = recordingJev(async (_state, questions) => {
    if (!questions.skill_choice) return undefined
    return { overrides: { skill_choice: { choice: 'starter-mining-belt-output', confidence: 0.4 } } }
  })
  const low = await scenario({ jev: unsure })
  const [lowRanked] = low.events('skill.ranked')
  assert.equal(lowRanked.data.reason, 'jev_low_confidence')
  assert.equal(lowRanked.data.prompt_applied, false)
})

test('loading an offered skill and committing a plan with it traces skill.loaded and skill.followed', async () => {
  const { calls, events } = await scenario({
    planner: (callIndex) => {
      if (callIndex === 1) {
        return { content: 'Loading the offered steam pattern.', tool_calls: [toolCall('call_00_skill0000000000000001', 0, 'getSkillDetails', { id: 'steam-power-bootstrap' })] }
      }
      return planReply({ plan: ['Follow steam-power-bootstrap: place an offshore pump, boiler and steam engine', 'Check it runs'], operations: [{ name: 'wait', args: { ticks: 1 } }] })
    },
  })
  // Still authoring after the tool round, so the block stays in the prompt.
  assert.ok(offersIn(calls[1]))
  const [loaded] = events('skill.loaded')
  assert.ok(loaded.request_id)
  assert.deepEqual(
    { skill_id: loaded.data.skill_id, offered: loaded.data.offered, offer_rank: loaded.data.offer_rank, reason: loaded.data.reason },
    { skill_id: 'steam-power-bootstrap', offered: true, offer_rank: 1, reason: 'loaded_offered_skill' },
  )
  const followed = events('skill.followed')
  assert.equal(followed.length, 1)
  assert.equal(followed[0].request_id, loaded.request_id)
  assert.deepEqual(followed[0].data.skill_ids, ['steam-power-bootstrap'])
  assert.deepEqual(followed[0].data.offered_ids, ['steam-power-bootstrap'])
  assert.deepEqual(followed[0].data.mentioned_in_plan, ['steam-power-bootstrap'])
  assert.equal(followed[0].data.reason, 'plan_committed_with_skill_context')
})

test('the block is shown only while authoring or revising: gone after commit, back for an amendment, no per-step re-offer', async () => {
  const { agent, game, calls, events } = await scenario({
    intents: ['new_goal', 'amend_current'],
    requests: [STEAM_GOAL, 'Use the lake to the north for the pump'],
    afterFirst: async (loop) => {
      // After the commit, rounds that carry out the step get no block.
      assert.equal(skillOffersContext(loop), '')
      assert.equal(injectedSkillChars(loop), 0)
    },
  })
  assert.ok(offersIn(calls[0]), 'authoring round has the block')
  const [retired] = events('skill.offer_retired')
  assert.equal(retired.data.reason, 'plan_committed')
  assert.ok(retired.request_id)

  // The amendment is a revision round: the same cards come back without a new search.
  assert.equal(game.offerRequests.length, 1, 'no new search for a revision or a step')
  const [reshown] = events('skill.offer_reshown')
  assert.equal(reshown.data.trigger, 'revision')
  assert.ok(reshown.request_id)
  assert.ok(offersIn(calls.at(-1)), 'the revision round has the block')
  assert.equal(events('skill.offered').length, 1)
  assert.equal(agent.skillOffers.authoring, false, 'the revised plan was committed')
})

test('shelf pickup runs a complete search for the next shelf node and logs Jev\'s shadow pick', async () => {
  const traced = []
  const decisions = []
  const game = new SkillFactorio()
  const jev = recordingJev(async (_state, questions) => questions.skill_choice
    ? { overrides: { skill_choice: { choice: 'steam-power-bootstrap', confidence: 0.9 } } }
    : undefined)
  const loop = {
    rcon: game,
    skillOffers: { memoryKey: 'npc:airi', cards: [], authoring: false, trigger: 'new_goal' },
    decisionRequestSequence: 0,
    skillDecisionProvider: jev,
    activePlanKey: () => 'npc:airi',
    traceEvent: async (event, data) => { traced.push({ event, data }) },
    decisionTraceEvent: async (event, data) => { decisions.push({ event, data }) },
    log: () => {},
  }
  const planning = {
    goal: { status: 'active', objective: 'Launch a rocket' },
    roadmap: {
      nodes: [
        { id: 'node_smelting', intent: 'Iron and copper smelting', why_it_matters: 'Plates for everything', status: 'realized', depends_on: [], resolved_by: ['plan_1'], verified_results: ['result_1'] },
        { id: 'node_power', intent: 'Steam power for electricity', why_it_matters: 'Electric drills and assemblers need power', status: 'ready_to_refine', depends_on: ['node_smelting'], resolved_by: [], verified_results: [] },
      ],
    },
  }
  const offer = await refreshSkillOffersAtShelfPickup(loop, planning)
  assert.equal(game.offerRequests.length, 1)
  assert.equal(game.offerRequests[0].goal, 'Steam power for electricity. Electric drills and assemblers need power')
  assert.equal(offer.shelf_node_id, 'node_power')
  assert.equal(offer.authoring, true, 'the pickup opens a new authoring round')
  assert.ok(skillOffersContext(loop).startsWith(SKILL_OFFERS_PREFIX))
  const offered = traced.find(entry => entry.event === 'skill.offered')
  assert.equal(offered.data.trigger, 'shelf_pickup')
  const ranked = traced.find(entry => entry.event === 'skill.ranked')
  assert.equal(ranked.data.trigger, 'shelf_pickup')
  assert.equal(ranked.data.jev_pick, 'steam-power-bootstrap')
  assert.equal(ranked.data.mode, 'shadow')
  assert.deepEqual(decisions.map(entry => entry.event), ['decision.request', 'decision.response'])
})

test('the shelf pickup and ceiling hooks are wired in the live loop (not only implemented)', async () => {
  const source = await fsp.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'npc-agent-loop.mjs'), 'utf8')
  const wake = source.indexOf("route: 'next_shelf_slice'")
  const hook = source.indexOf('await refreshSkillOffersAtShelfPickup(this, planningAfterCompletion)')
  assert.ok(wake > 0 && hook > wake && hook - wake < 400, 'the shelf pickup search runs right after the next_shelf_slice wake')
  assert.match(source, /> this\.maxWorkingChars - injectedSkillChars\(this\)/)
})

test('the working-character ceiling counts the injected skill text', async () => {
  const { agent } = await scenario({
    planner: (callIndex) => callIndex === 1
      ? { content: 'Loading.', tool_calls: [toolCall('call_00_skill0000000000000001', 0, 'getSkillDetails', { id: 'steam-power-bootstrap' })] }
      : planReply({ plan: ['Build steam power', 'Check it'], operations: [{ name: 'wait', args: { ticks: 1 } }] }),
  })
  agent.skillOffers.authoring = true
  const expected = skillOffersContext(agent).length + agent.skillContext().length
  assert.ok(expected > 0)
  assert.equal(injectedSkillChars(agent), expected)
})

test('no match or a failed lookup offers nothing, traces why, and never blocks planning', async () => {
  const none = await scenario({ game: new SkillFactorio({ offer: { ok: true, cards: [] } }) })
  assert.equal(none.events('skill.offer_skipped')[0].data.reason, 'no_matching_skill')
  assert.ok(none.events('skill.offer_skipped')[0].request_id)
  assert.ok(!offersIn(none.calls[0]))

  const broken = await scenario({ game: new SkillFactorio({ offer: 'throw' }) })
  assert.equal(broken.events('skill.offer_skipped')[0].data.reason, 'lookup_failed')
  assert.equal(broken.events('plan.accepted').length, 1)

  const oldMod = await scenario({ game: new SkillFactorio({ offer: { ok: false, error: 'Unknown interface: offer' } }) })
  assert.equal(oldMod.events('skill.offer_skipped')[0].data.reason, 'lookup_failed')
  assert.equal(oldMod.events('skill.ranked').length, 0)
})
