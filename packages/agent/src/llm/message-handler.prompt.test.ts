import { beforeEach, describe, expect, it, vi } from 'vitest'
import prompt from './prompt.md?raw'
import productionPlanningPrompt from './production-planning-prompt.md?raw'
import spatialPlacementPrompt from './spatial-placement-prompt.md?raw'

const systemPrompt = `${prompt}\n\n${productionPlanningPrompt}\n\n${spatialPlacementPrompt}`

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
}))

vi.mock('neuri/openai', () => ({
  assistant: (content: string) => ({ role: 'assistant', content }),
  composeAgent: () => ({ call: mocks.call }),
  defineToolFunction: (_definition: unknown, fn: unknown) => ({ fn }),
  system: (content: string) => ({ role: 'system', content }),
  toolFunction: async (name: string, description: string, schema: unknown) => ({ name, description, schema }),
  user: (content: string) => ({ role: 'user', content }),
}))

vi.mock('../config', () => ({
  openaiConfig: {
    apiKey: 'test-key',
    baseUrl: 'http://provider.invalid/v1',
  },
}))

vi.mock('./tools', () => ({
  tools: [],
}))

import { createMessageHandler } from './message-handler'

function modelPlan(overrides: Record<string, unknown> = {}) {
  return {
    chatMessage: 'Working on it.',
    plan: ['Wait briefly'],
    currentStep: 0,
    operations: [
      { name: 'wait', args: { ticks: 3 } },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.call.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(modelPlan()) } }],
  })
})

describe('actual prompt/message harness', () => {
  it('sends the production prompt and sender identity for a chat request', async () => {
    const handler = await createMessageHandler()

    const result = await handler.handleMessage({
      type: 'chat',
      username: 'Louis',
      message: 'wait a moment',
      isServer: false,
      date: '2026-09-13',
    })

    expect(mocks.call).toHaveBeenCalledTimes(1)
    const [messages, options] = mocks.call.mock.calls[0]
    expect(messages[0]).toEqual({ role: 'system', content: systemPrompt })
    expect(messages[1]).toEqual({ role: 'user', content: '[CHAT] Louis: wait a moment' })
    expect(options).toMatchObject({ maxRoundTrip: 10 })
    expect(result?.operationCommands).toEqual(["remote.call('autorio_operations', 'wait', 3)"])
  })

  it('keeps the structured model response in history and appends detailed completion receipts', async () => {
    const handler = await createMessageHandler()

    const firstResponse = JSON.stringify(modelPlan())
    mocks.call.mockResolvedValueOnce({
      choices: [{ message: { content: firstResponse } }],
    })

    await handler.handleMessage({
      type: 'chat',
      username: 'Louis',
      message: 'wait a moment',
      isServer: false,
      date: '2026-09-13',
    })

    mocks.call.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(modelPlan({ operations: [] })) } }],
    })

    await handler.handleMessage({
      type: 'operationsCompleted',
      serverTimestamp: '10.000',
      details: 'batch=4, task_count=1, tasks=waiting, tick=123',
    })

    expect(mocks.call).toHaveBeenCalledTimes(2)
    const [messages] = mocks.call.mock.calls[1]
    expect(messages[0]).toEqual({ role: 'system', content: systemPrompt })
    expect(messages).toContainEqual({ role: 'assistant', content: firstResponse })
    expect(messages).toContainEqual({
      role: 'user',
      content: '[MOD] All operations completed. Batch receipt: batch=4, task_count=1, tasks=waiting, tick=123',
    })
    expect(messages.filter((message: { role: string }) => message.role === 'system')).toHaveLength(1)
  })

  it('formats mod errors as model-visible state without changing the system prompt', async () => {
    const handler = await createMessageHandler()

    await handler.handleMessage({
      type: 'modError',
      serverTimestamp: '12.000',
      error: 'No iron-ore found',
    })

    const [messages] = mocks.call.mock.calls[0]
    expect(messages[0]).toEqual({ role: 'system', content: systemPrompt })
    expect(messages[1]).toEqual({ role: 'user', content: '[MOD] Error: No iron-ore found' })
  })
})