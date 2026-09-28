// Plan item 2.8: skill cards are offered in plan-authoring context without the
// model asking, Jev ranks the SAME cards (advisory, deterministic fallback, no
// key needed), and offered / ranked / loaded / followed are traced with the
// request id. Static scenario: fake Factorio, scripted planner and Jev replies.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { DECISION_PROVIDER_DEFAULTS, normalizeDecisionProviderRequest } from './provider.mjs'
import {
  parseSkillChoice,
  parseSkillOffers,
  renderSkillCard,
  SKILL_CARD_MAX_CHARS,
  SKILL_OFFERS_PREFIX,
  skillChoiceQuestions,
  skillOfferBlock,
  skillOfferCommand,
} from './skill-offers.mjs'
import { FakeFactorio, planReply, recordingJev } from './task-loop-fixtures.mjs'

// What the mod's autorio_skills.offer returns for the steam goal on a fresh
// save (same shape as the card snapshot in packages/autorio skills.test.ts).
const STEAM_CARDS = [
  {
    id: 'steam-power-bootstrap',
    name: 'Steam Power Bootstrap',
    status: 'candidate',
    summary: 'Bring up the first reliable electric power with the smallest live-compatible water-to-steam-to-generator chain, then connect the electrical network and fuel ...',
    produces: ['electric-power'],
    needs: ['offshore-pump', 'boiler', 'generator', 'fuel-or-energy-input'],
    matched: ['power', 'electricity', 'steam', 'steam-power', 'text:running'],
    unmet: ['offshore-pump', 'boiler', 'generator'],
    score: 16.25,
  },
  {
    id: 'starter-mining-belt-output',
    name: 'Starter Mining Belt Output',
    status: 'candidate',
    summary: 'Build an early scalable mining row by placing drills that genuinely cover the resource patch and orienting their outputs onto a shared belt or other collection path.',
    produces: ['mined-resource'],
    needs: ['resource-patch', 'mining-drill', 'collection-path'],
    matched: ['text:power'],
    unmet: ['mining-drill'],
    score: 0.75,
  },
]

const STEAM_GOAL = 'Get steam power running so we have electricity'

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

async function scenario({ game = new SkillFactorio(), jev, planner } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-skill-offers-'))
  const traceFile = path.join(dir, 'sgluna-behavior.jsonl')
  const calls = []
  const agent = new NpcAgentLoop({
    rcon: game,
    memory: new CanonicalTaskBoardMemory(),
    systemPrompt: 'skill offers scenario',
    npcId: 'airi',
    stateFile: null,
    traceFile,
    decisionTraceFile: null,
    ...(jev ? { skillDecisionProvider: jev } : {}),
    provider: async (messages) => {
      calls.push(messages.map(message => ({ ...message })))
      return planner
        ? planner(calls.length, messages)
        : planReply({ plan: ['Build a starter steam power chain'], operations: [{ name: 'wait', args: { ticks: 1 } }] })
    },
  })
  await agent.request(STEAM_GOAL, { sender: 'Louis' })
  const rows = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { agent, game, calls, rows, events: name => rows.filter(row => row.event === name) }
}

test('offer command asks the mod for at most five cards for the goal text, safely quoted', () => {
  const command = skillOfferCommand('it\'s "steam" power', 5)
  assert.match(command, /remote\.call\("autorio_skills","offer",request\)/)
  assert.doesNotMatch(command, /loadstring|game\.print|pcall/)
  const encoded = /helpers\.json_to_table\('((?:[^'\\]|\\.)*)'\)/.exec(command)[1]
  assert.deepEqual(JSON.parse(encoded.replace(/\\(.)/g, '$1')), { goal: 'it\'s "steam" power', limit: 5 })
})

test('parsed cards are bounded, deduplicated and drop malformed entries', () => {
  const long = 'x'.repeat(900)
  const parsed = parseSkillOffers(JSON.stringify({
    ok: true,
    cards: [
      STEAM_CARDS[0],
      STEAM_CARDS[0],
      { id: 'Bad Id!', name: 'bad' },
      { id: 'huge-card', name: long, status: 'weird', summary: long, produces: Array(20).fill('a'), needs: [], matched: [], unmet: [], score: 1 },
      ...Array.from({ length: 6 }, (_, index) => ({ ...STEAM_CARDS[1], id: `extra-${index}` })),
    ],
  }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.cards.length, 5)
  assert.deepEqual(parsed.cards.map(card => card.id).slice(0, 2), ['steam-power-bootstrap', 'huge-card'])
  const huge = parsed.cards[1]
  assert.equal(huge.status, 'candidate')
  assert.equal(huge.produces.length, 5)
  assert.ok(renderSkillCard(huge).length <= SKILL_CARD_MAX_CHARS)
  assert.deepEqual(parseSkillOffers('{}'), { ok: false, reason: 'lookup_failed', error: undefined })
  assert.deepEqual(parseSkillOffers('not json'), { ok: false, reason: 'lookup_unreadable' })
  assert.deepEqual(parseSkillOffers(JSON.stringify({ ok: true, cards: {} })), { ok: true, cards: [] })
})

test('card snapshot: one compact line with id, name, status, summary, produces, needs and why it matched', () => {
  const [card] = parseSkillOffers(JSON.stringify({ ok: true, cards: STEAM_CARDS })).cards
  assert.equal(
    renderSkillCard(card),
    'steam-power-bootstrap "Steam Power Bootstrap" [candidate]: Bring up the first reliable electric power with the smallest live-compatible water-to-steam-to-generator chain, then connect the electrical network and fuel ... '
    + 'Produces: electric-power. Needs: offshore-pump, boiler, generator, fuel-or-energy-input. '
    + 'Why: matched power, electricity, steam, steam-power, text:running; unmet offshore-pump, boiler, generator.',
  )
})

test('Jev is asked about exactly the cards the model sees, in a request the live TypeSafe adapter accepts', () => {
  const { cards } = parseSkillOffers(JSON.stringify({ ok: true, cards: STEAM_CARDS }))
  const questions = skillChoiceQuestions(cards)
  normalizeDecisionProviderRequest({ ...DECISION_PROVIDER_DEFAULTS, key: 'contract-check' }, { contract: 'skill_choice', goal: STEAM_GOAL, candidate_count: 2 }, questions)
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
  assert.equal(offered.data.reason, 'new_goal')
  assert.deepEqual(offered.data.offered_ids, ['steam-power-bootstrap', 'starter-mining-belt-output'])
  assert.deepEqual(offered.data.cards[0].unmet, ['offshore-pump', 'boiler', 'generator'])

  const [ranked] = events('skill.ranked')
  assert.equal(ranked.request_id, offered.request_id)
  assert.equal(ranked.data.source, 'deterministic')
  assert.equal(ranked.data.reason, 'jev_unavailable')
  assert.deepEqual(ranked.data.deterministic_order, ['steam-power-bootstrap', 'starter-mining-belt-output'])
})

test('a confident Jev pick adds one advisory line; the card order stays deterministic', async () => {
  const jev = recordingJev(async (_state, questions) => {
    if (!questions.skill_choice) return undefined
    return {
      answers: {
        skill_choice: {
          type: 'choice',
          choice: 'steam-power-bootstrap',
          confidence: 0.82,
          probabilities: { 'steam-power-bootstrap': 0.82, 'starter-mining-belt-output': 0.08, 'none': 0.1 },
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

  const block = calls[0].find(message => typeof message.content === 'string' && message.content.startsWith(SKILL_OFFERS_PREFIX)).content
  assert.match(block, /1\. steam-power-bootstrap .*\n2\. starter-mining-belt-output /)
  assert.match(block, /Advisor: Jev ranked steam-power-bootstrap first \(confidence 0\.82\)\. Advisory only\./)

  const [ranked] = events('skill.ranked')
  assert.ok(ranked.request_id)
  assert.equal(ranked.data.source, 'jev')
  assert.equal(ranked.data.reason, 'jev_confident_pick')
  assert.equal(ranked.data.agrees_with_top, true)
  assert.deepEqual(ranked.data.jev_order, ['steam-power-bootstrap', 'starter-mining-belt-output'])
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
  assert.ok(failed.calls[0].some(message => typeof message.content === 'string' && message.content.startsWith(SKILL_OFFERS_PREFIX)))

  const unsure = recordingJev(async (_state, questions) => {
    if (!questions.skill_choice) return undefined
    return { overrides: { skill_choice: { choice: 'starter-mining-belt-output', confidence: 0.4 } } }
  })
  const low = await scenario({ jev: unsure })
  const [lowRanked] = low.events('skill.ranked')
  assert.equal(lowRanked.data.reason, 'jev_low_confidence')
  assert.equal(lowRanked.data.advisory_applied, false)
  const block = low.calls[0].find(message => typeof message.content === 'string' && message.content.startsWith(SKILL_OFFERS_PREFIX)).content
  assert.doesNotMatch(block, /Advisor:/)
})

test('loading an offered skill and committing a plan with it traces skill.loaded and skill.followed', async () => {
  const { events } = await scenario({
    planner: (callIndex) => {
      if (callIndex === 1) {
        return { content: 'Loading the offered steam pattern.', tool_calls: [toolCall('call_00_skill0000000000000001', 0, 'getSkillDetails', { id: 'steam-power-bootstrap' })] }
      }
      return planReply({ plan: ['Follow steam-power-bootstrap: place an offshore pump, boiler and steam engine'], operations: [{ name: 'wait', args: { ticks: 1 } }] })
    },
  })
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

test('no match or a failed lookup offers nothing, traces why, and never blocks planning', async () => {
  const none = await scenario({ game: new SkillFactorio({ offer: { ok: true, cards: [] } }) })
  assert.equal(none.events('skill.offer_skipped')[0].data.reason, 'no_matching_skill')
  assert.ok(none.events('skill.offer_skipped')[0].request_id)
  assert.ok(!none.calls[0].some(message => typeof message.content === 'string' && message.content.startsWith(SKILL_OFFERS_PREFIX)))

  const broken = await scenario({ game: new SkillFactorio({ offer: 'throw' }) })
  assert.equal(broken.events('skill.offer_skipped')[0].data.reason, 'lookup_failed')
  assert.equal(broken.events('plan.accepted').length, 1)

  const oldMod = await scenario({ game: new SkillFactorio({ offer: { ok: false, error: 'Unknown interface: offer' } }) })
  assert.equal(oldMod.events('skill.offer_skipped')[0].data.reason, 'lookup_failed')
  assert.equal(oldMod.events('skill.ranked').length, 0)
})
