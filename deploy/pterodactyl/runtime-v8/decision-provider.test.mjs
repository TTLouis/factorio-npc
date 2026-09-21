import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DECISION_PROVIDER_DEFAULTS,
  decisionProviderConfiguration,
  decisionProviderRequest,
  normalizeDecisionProviderRequest,
} from './provider.mjs'

const KEY = `fixture-typesafe-${'x'.repeat(24)}`

test('decision provider is absent when no API key is supplied, without a separate enabled flag', () => {
  assert.equal(decisionProviderConfiguration({}), undefined)
  assert.equal(decisionProviderConfiguration({
    DECISION_PROVIDER_API_URL: 'not-a-url',
    DECISION_PROVIDER_MODEL: 'also ignored without credentials',
  }), undefined)
})

test('TypeSafe credentials automatically configure Jev with conservative request limits', () => {
  const config = decisionProviderConfiguration({ TYPESAFE_API_KEY: KEY })
  assert.deepEqual(config, {
    provider: 'typesafe',
    key: KEY,
    url: DECISION_PROVIDER_DEFAULTS.url,
    model: 'jev-latest',
    timeoutMs: 5000,
    maxRequestsPerHour: 180,
    maxInputChars: 16000,
    maxQuestions: 16,
  })
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'enabled'), false)
})

test('decision provider accepts explicit generic configuration and bounded conservation knobs', () => {
  const config = decisionProviderConfiguration({
    DECISION_PROVIDER_API_KEY: KEY,
    DECISION_PROVIDER_API_URL: 'https://decision.example.test/v1/systemone',
    DECISION_PROVIDER_MODEL: 'jev-preview',
    DECISION_PROVIDER_TIMEOUT_MS: '2500',
    MAX_DECISION_PROVIDER_REQUESTS_PER_HOUR: '60',
    DECISION_PROVIDER_MAX_INPUT_CHARS: '4096',
    DECISION_PROVIDER_MAX_QUESTIONS: '6',
  })

  assert.equal(config.url, 'https://decision.example.test/v1/systemone')
  assert.equal(config.model, 'jev-preview')
  assert.equal(config.timeoutMs, 2500)
  assert.equal(config.maxRequestsPerHour, 60)
  assert.equal(config.maxInputChars, 4096)
  assert.equal(config.maxQuestions, 6)
})

test('decision request normalization keeps state and multiple questions in one bounded call', () => {
  const config = decisionProviderConfiguration({ TYPESAFE_API_KEY: KEY })
  const questions = {
    route: {
      type: 'choice',
      instructions: 'Which route best matches `message`?',
      criteria: {
        conversation: 'The player is talking without changing the world goal.',
        new_goal: 'The player is asking SGLuna to pursue a new world goal.',
        amend_goal: 'The player is changing the active goal.',
      },
    },
    needs_planner: {
      type: 'noul',
      instructions: 'Does this message require the planning model to reason about world actions?',
    },
  }

  const normalized = normalizeDecisionProviderRequest(
    config,
    { message: 'what are you doing?', current_goal: 'build drills' },
    questions,
  )

  assert.equal(normalized.body.model, 'jev-latest')
  assert.deepEqual(normalized.body.questions, questions)
  assert.ok(normalized.serialized.length < config.maxInputChars)
})

test('decision request normalization rejects oversized payloads before spending provider credit', () => {
  const config = decisionProviderConfiguration({
    TYPESAFE_API_KEY: KEY,
    DECISION_PROVIDER_MAX_INPUT_CHARS: '1024',
  })

  assert.throws(
    () => normalizeDecisionProviderRequest(
      config,
      { message: 'x'.repeat(2000) },
      {
        route: {
          type: 'choice',
          instructions: 'Choose a route.',
          criteria: { conversation: 'Talk only.', planning: 'Needs planning.' },
        },
      },
    ),
    /exceeds 1024 characters/,
  )
})

test('scope review questions are directly valid for the TypeSafe decision provider', async () => {
  const { scopeReviewQuestions } = await import('./jev-decision-taxonomy.mjs')
  const config = decisionProviderConfiguration({ TYPESAFE_API_KEY: KEY })
  const questions = scopeReviewQuestions({ draftStepCount: 4 })
  assert.ok(Object.keys(questions).length <= config.maxQuestions)
  for (const question of Object.values(questions)) assert.ok(['choice', 'score', 'noul'].includes(question.type))
  const normalized = normalizeDecisionProviderRequest(
    config,
    { goal: 'semi-automate iron and copper plates', draft_steps: ['observe', 'gather', 'smelt', 'verify'] },
    questions,
  )
  assert.equal(normalized.body.questions.scope_review_reason_codes.type, 'choice')
  assert.equal(normalized.body.questions.scope_review_reason_code_secondary.type, 'choice')
  assert.equal(normalized.body.questions.step_direction_0.type, 'choice')
  assert.equal(normalized.body.questions.actionable_prefix.type, 'score')
})
test('decision provider batches questions into one TypeSafe System One request and preserves usage', async () => {
  const config = decisionProviderConfiguration({ TYPESAFE_API_KEY: KEY })
  const questions = {
    route: {
      type: 'choice',
      instructions: 'Which route best matches `message`?',
      criteria: {
        conversation: 'The player is talking without changing the world goal.',
        planning: 'The player needs planning or a world action.',
      },
    },
    urgent: {
      type: 'noul',
      instructions: 'Does `message` require an immediate response?',
    },
  }

  let calls = 0
  let reserves = 0
  const result = await decisionProviderRequest(
    config,
    { message: 'what are you doing?', phase: 'waiting' },
    questions,
    {
      reserve: async () => { reserves++ },
      fetchImpl: async (url, init) => {
        calls++
        assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
        assert.equal(init.method, 'POST')
        assert.equal(init.headers.authorization, `Bearer ${KEY}`)
        const body = JSON.parse(init.body)
        assert.equal(body.model, 'jev-latest')
        assert.deepEqual(Object.keys(body.questions).sort(), ['route', 'urgent'])
        return new Response(JSON.stringify({
          model: 'jev-latest',
          answers: {
            route: {
              type: 'choice',
              choice: 'conversation',
              probabilities: { conversation: 0.94, planning: 0.06 },
              confidence: 0.88,
            },
            urgent: {
              type: 'noul',
              noul: 0.12,
            },
          },
          provider: 'TypeSafe',
          usage: {
            input_tokens: 187,
            output_tokens: 19,
            cost: 0.000007854,
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    },
  )

  assert.equal(calls, 1)
  assert.equal(reserves, 1)
  assert.equal(result.answers.route.choice, 'conversation')
  assert.equal(result.answers.urgent.noul, 0.12)
  assert.equal(result.provider, 'TypeSafe')
  assert.deepEqual(result.usage, { input_tokens: 187, output_tokens: 19, cost: 0.000007854 })
})

test('decision provider validates Score legend, indexed probabilities, and range', async () => {
  const config = decisionProviderConfiguration({ TYPESAFE_API_KEY: KEY })

  const result = await decisionProviderRequest(
    config,
    { failure_count: 2, operation: 'place_candidate' },
    {
      severity: {
        type: 'score',
        instructions: 'How severe is the recovery situation?',
        criteria: ['routine', 'needs observation', 'needs planner', 'blocked'],
      },
    },
    {
      reserve: async () => {},
      fetchImpl: async () => new Response(JSON.stringify({
        answers: {
          severity: {
            type: 'score',
            score: 1.8,
            legend: {
              0: 'routine',
              1: 'needs observation',
              2: 'needs planner',
              3: 'blocked',
            },
            probabilities: {
              0: 0.05,
              1: 0.25,
              2: 0.65,
              3: 0.05,
            },
            confidence: 0.83,
          },
        },
      }), { status: 200 }),
    },
  )

  assert.equal(result.answers.severity.score, 1.8)
  assert.equal(result.answers.severity.legend['2'], 'needs planner')
})

test('decision provider refuses to spend credit without an explicit budget reservation', async () => {
  const config = decisionProviderConfiguration({ TYPESAFE_API_KEY: KEY })
  let fetchCalls = 0

  await assert.rejects(
    decisionProviderRequest(
      config,
      { message: 'hello' },
      {
        route: {
          type: 'choice',
          instructions: 'Choose a route.',
          criteria: { conversation: 'Talk.', planning: 'Plan.' },
        },
      },
      {
        fetchImpl: async () => {
          fetchCalls++
          throw new Error('must not be reached')
        },
      },
    ),
    /requires a budget reservation callback/,
  )

  assert.equal(fetchCalls, 0)
})

test('decision provider rejects an answer outside the declared choice contract', async () => {
  const config = decisionProviderConfiguration({ TYPESAFE_API_KEY: KEY })
  await assert.rejects(
    decisionProviderRequest(
      config,
      { message: 'hello' },
      {
        route: {
          type: 'choice',
          instructions: 'Choose a route.',
          criteria: { conversation: 'Talk.', planning: 'Plan.' },
        },
      },
      {
        reserve: async () => {},
        fetchImpl: async () => new Response(JSON.stringify({
          answers: {
            route: {
              type: 'choice',
              choice: 'invented_route',
              probabilities: { conversation: 0.5, planning: 0.5 },
              confidence: 0,
            },
          },
        }), { status: 200 }),
      },
    ),
    /unknown choice/,
  )
})


test('hierarchy observation budget uses the provider-supported score schema', async () => {
  const { decisionEnvelopeQuestions } = await import('./jev-decision-taxonomy.mjs')
  const config = decisionProviderConfiguration({ TYPESAFE_API_KEY: KEY })
  const questions = decisionEnvelopeQuestions()
  assert.equal(questions.observation_budget.type, 'score')
  assert.equal(questions.observation_budget.criteria.length, 9)
  const normalized = normalizeDecisionProviderRequest(
    config,
    { goal: 'Reach Automation', boundary: 'planning' },
    questions,
  )
  assert.equal(normalized.body.questions.observation_budget.type, 'score')
})
