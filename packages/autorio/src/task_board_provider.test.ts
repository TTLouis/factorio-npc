import { beforeEach, describe, expect, it } from 'vitest'

import {
  current_provider_model,
  provider_avatar_variant,
  provider_button_sprite,
  provider_button_tooltip,
  remember_provider_model,
  roll_provider_avatar,
  task_board_provider_of,
} from './task_board_provider'

const store = (globalThis as any).storage as Record<string, any>

describe('provider avatar selection', () => {
  beforeEach(() => {
    delete store.sgluna_task_board_provider_model
    delete store.sgluna_task_board_avatar_roll
  })

  it('maps the vendor naming each provider actually ships', () => {
    expect(task_board_provider_of('deepseek-chat').id).toBe('deepseek')
    expect(task_board_provider_of('deepseek-reasoner').id).toBe('deepseek')
    expect(task_board_provider_of('claude-sonnet-4-5').id).toBe('claude')
    expect(task_board_provider_of('anthropic/claude-opus-4-1').id).toBe('claude')
    expect(task_board_provider_of('gpt-4o-mini').id).toBe('openai')
    expect(task_board_provider_of('openai/o3-mini').id).toBe('openai')
    expect(task_board_provider_of('gemini-2.5-pro').id).toBe('gemini')
    expect(task_board_provider_of('google/gemini-2.5-flash').id).toBe('gemini')
    expect(task_board_provider_of('qwen3-max').id).toBe('qwen')
    expect(task_board_provider_of('qwen-plus').id).toBe('qwen')
  })

  // Every vendor ships a "flash" tier, so the word says nothing about who is
  // answering and is deliberately not a match key for any of them.
  it('does not read a speed tier as a vendor', () => {
    expect(task_board_provider_of('deepseek-v3-flash').id).toBe('deepseek')
    expect(task_board_provider_of('gemini-2.5-flash').id).toBe('gemini')
    expect(task_board_provider_of('some-flash-model').id).toBe('')
  })

  it('reads case-insensitively, the way model identifiers are typed', () => {
    expect(task_board_provider_of('DeepSeek-V3').id).toBe('deepseek')
    expect(task_board_provider_of('Claude-Haiku').id).toBe('claude')
    expect(task_board_provider_of('Qwen3-Max').id).toBe('qwen')
  })

  // No house avatar for "none of the above": the button reports which vendor is
  // answering, so with no answer it keeps the sprite it was created with.
  it('claims no avatar for an unknown or missing model', () => {
    expect(task_board_provider_of('').id).toBe('')
    expect(task_board_provider_of(undefined).id).toBe('')
    expect(task_board_provider_of('replace-me').id).toBe('')
    expect(task_board_provider_of('llama-3.3-70b').id).toBe('')
  })

  // A proxy or router prefix puts a second vendor word in the identifier. The
  // model that actually answers is the one on the right of the path.
  it('resolves a routed identifier to the vendor that answers', () => {
    expect(task_board_provider_of('openai-compatible/deepseek-chat').id).toBe('deepseek')
    expect(task_board_provider_of('my-openai-proxy/claude-sonnet-4-5').id).toBe('claude')
  })

  it('keeps the last known model when a snapshot reports none', () => {
    remember_provider_model('deepseek-chat')
    remember_provider_model('')
    remember_provider_model(undefined)
    expect(current_provider_model()).toBe('deepseek-chat')
    roll_provider_avatar(1, 0)
    expect(provider_button_sprite(1, 'item/logistic-robot')).toMatch(/^sgluna-provider-deepseek-[1-4]$/)
  })

  it('names only the UI-owned provider in the button tooltip', () => {
    remember_provider_model('claude-sonnet-4-5')
    expect(provider_button_tooltip('SGLuna NPC Console')).toBe('SGLuna NPC Console\nClaude')
  })

  it('never reflects rich-text-looking model ids into the tooltip', () => {
    remember_provider_model('claude-[item=iron-plate]-[color=red]x[/color]')
    const tooltip = provider_button_tooltip('SGLuna NPC Console')
    expect(tooltip).toBe('SGLuna NPC Console\nClaude')
    expect(tooltip).not.toContain('[item=')
    expect(tooltip).not.toContain('[color=')
  })
  it('leaves the button alone until a model has been reported', () => {
    expect(provider_button_tooltip('SGLuna NPC Console')).toBe('SGLuna NPC Console')
    expect(provider_button_sprite(1, 'item/logistic-robot')).toBe('item/logistic-robot')
  })

  it('keeps the default sprite for a model no vendor claims', () => {
    remember_provider_model('llama-3.3-70b')
    expect(provider_button_sprite(1, 'item/logistic-robot')).toBe('item/logistic-robot')
    expect(provider_button_tooltip('SGLuna NPC Console')).toBe('SGLuna NPC Console\nUnrecognized provider')
  })
})

describe('avatar variant rotation', () => {
  beforeEach(() => {
    delete store.sgluna_task_board_provider_model
    delete store.sgluna_task_board_avatar_roll
  })

  it('stays put for a player until they rejoin', () => {
    roll_provider_avatar(1, 12345)
    const first = provider_avatar_variant(1, 'claude')
    expect(provider_avatar_variant(1, 'claude')).toBe(first)
    expect(provider_avatar_variant(1, 'claude')).toBe(first)
  })

  it('rolls a variant the data stage actually declares', () => {
    for (const tick of [0, 1, 599, 3600, 100003, 250000]) {
      roll_provider_avatar(4, tick)
      const variant = provider_avatar_variant(4, 'gemini')
      expect(variant).toBeGreaterThanOrEqual(1)
      expect(variant).toBeLessThanOrEqual(4)
    }
  })

  // The console is synchronized state, so the button a player sees has to be
  // decided from `storage`, not while drawing. A player who has never been
  // rolled still has to get one rather than render nothing.
  it('rolls on demand for a player who predates the roll', () => {
    remember_provider_model('claude-sonnet-4-5')
    expect(provider_button_sprite(7, 'item/logistic-robot')).toMatch(/^sgluna-provider-claude-[1-4]$/)
    expect(store.sgluna_task_board_avatar_roll[7]).toBeTypeOf('number')
  })

  it('reaches every variant across joins, and varies between players', () => {
    const seen = new Set<number>()
    for (let tick = 0; tick < 400; tick++) {
      roll_provider_avatar(1, tick)
      seen.add(provider_avatar_variant(1, 'claude'))
    }
    expect(seen.size).toBe(4)

    const together = new Set<number>()
    for (let player = 1; player <= 4; player++) {
      roll_provider_avatar(player, 900)
      together.add(provider_avatar_variant(player, 'claude'))
    }
    expect(together.size).toBeGreaterThan(1)
  })
})
