import { beforeEach, describe, expect, it } from 'vitest'
import {
  clear_snapshot_suppression,
  conversation_activity_keys,
  debug_activity_view,
  follow_button_caption,
  latest_ai_reply,
  snapshot_is_suppressed,
  suppress_snapshot,
  task_conversation_messages,
  toggle_debug_activity_follow,
  reset_task_conversation,
  sanitize_debug_snapshot,
} from './task_board_debug'

const store = () => (globalThis as any).storage as Record<string, any>

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('task board debug and UI freshness helpers', () => {
  it('sanitizes Jev decision diagnostics independently from planner diagnostics', () => {
    const debug = sanitize_debug_snapshot({
      provider_model: 'deepseek-chat',
      input_units: 100000,
      decision_provider: 'TypeSafe',
      decision_model: 'jev-latest',
      decision_shadow_intent: 'status_query',
      decision_active_intent: 'status_query',
      decision_post_step_route: 'wait_runtime',
      decision_post_step_applied_route: 'fallback_planner',
      decision_post_step_confidence_percent: 87,
      decision_post_step_latency_ms: 42,
      decision_post_step_fallback: 'runtime not healthy',
      decision_confidence_percent: 109,
      decision_queue_conflict_percent: 17,
      decision_latency_ms: 84,
      decision_input_units: 120,
      decision_output_units: 20,
      decision_cost_micro_usd: 5,
      decision_calls_total: 7,
      decision_input_units_total: 840,
      decision_output_units_total: 140,
      decision_cost_micro_usd_total: 35,
      decision_shadow_matches_total: 6,
      decision_shadow_mismatches_total: 1,
      decision_post_step_calls_total: 5,
      decision_planner_skips_total: 3,
      decision_planner_wakes_total: 3,
      decision_planner_continue_low_wakes_total: 1,
      decision_planner_reanchor_low_wakes_total: 2,
      decision_planner_replan_high_wakes_total: 1,
      decision_planner_fallback_wakes_total: 1,
      decision_error: '',
      decision_fallbacks_total: 4,
      jev_measurement: 'degraded',
      jev_request_calls: 5,
      jev_request_fallbacks: 4,
      jev_request_fallback_percent: 180,
      jev_last_fallback: 'post_step_planner_gate · request_contract · Decision provider state contains an unsupported value',
    })

    expect(debug.provider_model).toBe('deepseek-chat')
    expect(debug.input_units).toBe(100000)
    expect(debug.decision_provider).toBe('TypeSafe')
    expect(debug.decision_model).toBe('jev-latest')
    expect(debug.decision_shadow_intent).toBe('status_query')
    expect(debug.decision_active_intent).toBe('status_query')
    expect(debug.decision_post_step_route).toBe('wait_runtime')
    expect(debug.decision_post_step_applied_route).toBe('fallback_planner')
    expect(debug.decision_post_step_confidence_percent).toBe(87)
    expect(debug.decision_post_step_latency_ms).toBe(42)
    expect(debug.decision_post_step_fallback).toBe('runtime not healthy')
    expect(debug.decision_confidence_percent).toBe(100)
    expect(debug.decision_queue_conflict_percent).toBe(17)
    expect(debug.decision_latency_ms).toBe(84)
    expect(debug.decision_input_units).toBe(120)
    expect(debug.decision_output_units).toBe(20)
    expect(debug.decision_cost_micro_usd).toBe(5)
    expect(debug.decision_calls_total).toBe(7)
    expect(debug.decision_input_units_total).toBe(840)
    expect(debug.decision_output_units_total).toBe(140)
    expect(debug.decision_cost_micro_usd_total).toBe(35)
    expect(debug.decision_shadow_matches_total).toBe(6)
    expect(debug.decision_shadow_mismatches_total).toBe(1)
    expect(debug.decision_post_step_calls_total).toBe(5)
    expect(debug.decision_planner_skips_total).toBe(3)
    expect(debug.decision_planner_wakes_total).toBe(3)
    expect(debug.decision_planner_continue_low_wakes_total).toBe(1)
    expect(debug.decision_planner_reanchor_low_wakes_total).toBe(2)
    expect(debug.decision_planner_replan_high_wakes_total).toBe(1)
    expect(debug.decision_planner_fallback_wakes_total).toBe(1)
    expect(debug.decision_fallbacks_total).toBe(4)
    expect(debug.jev_measurement).toBe('degraded')
    expect(debug.jev_request_calls).toBe(5)
    expect(debug.jev_request_fallbacks).toBe(4)
    expect(debug.jev_request_fallback_percent).toBe(100)
    expect(debug.jev_last_fallback).toBe('post_step_planner_gate · request_contract · Decision provider state contains an unsupported value')
  })

  it('bounds second-layer provider diagnostics and keeps missing or malformed fields unknown', () => {
    const debug = sanitize_debug_snapshot({
      response_id: '  resp-123\nprovider  ',
      response_bytes: 2048,
      tool_call_count: 3,
      content_utf8_bytes: 512,
      content_non_ascii_chars: 7,
      content_replacement_chars: 1,
      normalized_content_chars: 490,
      structured_content: {
        json_valid: true,
        plan_valid: false,
        error: 'schema\n'.repeat(80),
      },
    })

    expect(debug.response_id).toBe('resp-123 provider')
    expect(debug.response_bytes).toBe(2048)
    expect(debug.tool_call_count).toBe(3)
    expect(debug.content_utf8_bytes).toBe(512)
    expect(debug.content_non_ascii_chars).toBe(7)
    expect(debug.content_replacement_chars).toBe(1)
    expect(debug.normalized_content_chars).toBe(490)
    expect(debug.structured_content?.json_valid).toBe(true)
    expect(debug.structured_content?.plan_valid).toBe(false)
    expect(debug.structured_content?.error.includes('\n')).toBe(false)
    expect((debug.structured_content?.error.length ?? 0) <= 300).toBe(true)

    const missing = sanitize_debug_snapshot({})
    expect(missing.response_id).toBeUndefined()
    expect(missing.response_bytes).toBeUndefined()
    expect(missing.tool_call_count).toBeUndefined()
    expect(missing.structured_content).toBeUndefined()

    const malformed = sanitize_debug_snapshot({
      response_id: { secret: 'do not stringify arbitrary objects into the debug UI' },
      response_bytes: -1,
      tool_call_count: 1.5,
      content_utf8_bytes: Number.NaN,
      content_non_ascii_chars: Number.POSITIVE_INFINITY,
      normalized_content_chars: 2147483648,
      structured_content: { json_valid: 'yes', plan_valid: 1, error: { raw: 'not text' } },
    })
    expect(malformed.response_id).toBeUndefined()
    expect(malformed.response_bytes).toBeUndefined()
    expect(malformed.tool_call_count).toBeUndefined()
    expect(malformed.content_utf8_bytes).toBeUndefined()
    expect(malformed.content_non_ascii_chars).toBeUndefined()
    expect(malformed.normalized_content_chars).toBeUndefined()
    expect(malformed.structured_content).toBeUndefined()
  })

  it('uses concise follow captions', () => {
    expect(follow_button_caption(false)).toBe('FOLLOW')
    expect(follow_button_caption(true)).toBe('FOLLOWING')
  })

  it('keeps Debug execution-feed follow state independent and explicitly pausable', () => {
    expect(debug_activity_view(7)).toEqual({ follow: true, behind: false })
    expect(toggle_debug_activity_follow(7)).toMatchObject({ follow: false, behind: false })
    expect(toggle_debug_activity_follow(7)).toMatchObject({ follow: true, behind: true })
  })

  it('shows the explicit AIRI reply or falls back to the newest decision activity', () => {
    expect(latest_ai_reply({ response: 'Direct answer', activity: [{ kind: 'decision', text: 'Older answer' }] })).toBe('Direct answer')
    expect(latest_ai_reply({ activity: [
      { kind: 'decision', text: 'First answer' },
      { kind: 'observation', text: 'Observed something' },
      { kind: 'decision', text: 'Newest answer' },
    ] })).toBe('Newest answer')
    expect(latest_ai_reply({ activity: [
      { kind: 'system', text: 'Jev shadow: status_query · 91%' },
    ] })).toBe('')
  })

  it('projects all player and AIRI messages for the current durable goal', () => {
    store().airi_task_board_activity_history = [
      { id: 'live_1', kind: 'observation', text: 'TTLouis: old task', timestamp: '00:00:01' },
      { kind: 'decision', text: 'Old answer', timestamp: '00:00:02' },
      { id: 'live_2', kind: 'observation', text: 'TTLouis: build power', timestamp: '00:01:00' },
      { id: 'live_3', kind: 'observation', text: 'Tool getInventory', timestamp: '00:01:01' },
      { kind: 'decision', text: 'I will build the boiler first.', timestamp: '00:01:02' },
      { id: 'live_4', kind: 'observation', text: 'TTLouis: continue', timestamp: '00:01:30' },
      { kind: 'decision', text: 'The boiler is done; next is steam.', timestamp: '00:01:31' },
    ]
    expect(task_conversation_messages({ goal_id: 'goal_power', objective: 'build power' })).toEqual([
      { key: 'id:live_2', role: 'user', sender: 'TTLouis', text: 'build power', timestamp: '00:01:00' },
      { key: 'decision|00:01:02|I will build the boiler first.', role: 'assistant', sender: 'AIRI', text: 'I will build the boiler first.', timestamp: '00:01:02' },
      { key: 'id:live_4', role: 'user', sender: 'TTLouis', text: 'continue', timestamp: '00:01:30' },
      { key: 'decision|00:01:31|The boiler is done; next is steam.', role: 'assistant', sender: 'AIRI', text: 'The boiler is done; next is steam.', timestamp: '00:01:31' },
    ])
  })

  it('names the activity rows the conversation already shows so the feed can skip them', () => {
    store().airi_task_board_activity_history = [
      { id: 'live_1', kind: 'observation', text: 'TTLouis: build power', timestamp: '00:01:00' },
      { id: 'live_2', kind: 'observation', text: 'Tool getInventory', timestamp: '00:01:01' },
      { kind: 'decision', text: 'Boiler first.', timestamp: '00:01:02' },
      { kind: 'result', text: 'Autorio batch 1 completed: 1 task(s)', timestamp: '00:01:10' },
    ]
    expect(conversation_activity_keys({ goal_id: 'goal_power', objective: 'build power' })).toEqual({
      'id:live_1': true,
      'decision|00:01:02|Boiler first.': true,
    })
    expect(conversation_activity_keys(undefined)).toEqual({})
  })

  it('starts a new conversation cursor when the durable goal changes', () => {
    store().airi_task_board_activity_history = [
      { id: 'live_1', kind: 'observation', text: 'TTLouis: build power', timestamp: '00:01:00' },
      { kind: 'decision', text: 'Power done.', timestamp: '00:01:10' },
    ]
    task_conversation_messages({ goal_id: 'goal_power', objective: 'build power' })
    store().airi_task_board_activity_history.push(
      { id: 'live_2', kind: 'observation', text: 'TTLouis: mine stone', timestamp: '00:02:00' },
      { kind: 'decision', text: 'Mining stone now.', timestamp: '00:02:01' },
    )
    expect(task_conversation_messages({ goal_id: 'goal_stone', objective: 'mine stone' }).map(message => message.text)).toEqual([
      'mine stone',
      'Mining stone now.',
    ])
  })

  it('hides retained task messages when there is no current task board', () => {
    store().airi_task_board_activity_history = [
      { id: 'live_1', kind: 'observation', text: 'TTLouis: build power', timestamp: '00:01:00' },
      { kind: 'decision', text: 'Power done.', timestamp: '00:01:10' },
    ]
    expect(task_conversation_messages(undefined)).toEqual([])
  })

  it('hides an explicit old conversation as soon as its snapshot is suppressed', () => {
    const old = {
      goal_id: 'goal-old',
      objective: 'build power',
      conversation_id: 'task-old',
      conversation: [
        { id: 'm1', role: 'user', sender: 'TTLouis', text: 'old request' },
        { id: 'm2', role: 'assistant', sender: 'AIRI', text: 'old answer' },
      ],
    }
    expect(task_conversation_messages(old)).toHaveLength(2)
    suppress_snapshot(old)
    expect(task_conversation_messages(old)).toEqual([])
  })

  it('rejects a delayed projection of a cleared goal but accepts a genuinely new goal', () => {
    suppress_snapshot({ goal_id: 'goal_old', objective: 'Build green circuits' })
    expect(snapshot_is_suppressed({ goal_id: 'goal_old', objective: 'Build green circuits' })).toBe(true)
    expect(snapshot_is_suppressed({ goal_id: '', objective: 'Build green circuits' })).toBe(true)
    expect(snapshot_is_suppressed({ goal_id: 'goal_new', objective: 'Build green circuits' })).toBe(false)
    expect(snapshot_is_suppressed({ goal_id: '', objective: 'Build red circuits' })).toBe(false)
    clear_snapshot_suppression()
    expect(snapshot_is_suppressed({ goal_id: '', objective: 'Build green circuits' })).toBe(false)
  })
})

describe('current task conversation regression', () => {
  it('shows more than four visible user/assistant messages from the explicit task conversation', () => {
    const conversation = [
      { id: '1', role: 'user', sender: 'TTLouis', text: 'one' },
      { id: '2', role: 'assistant', sender: 'AIRI', text: 'two' },
      { id: '3', role: 'user', sender: 'TTLouis', text: 'three' },
      { id: '4', role: 'assistant', sender: 'AIRI', text: 'four' },
      { id: '5', role: 'user', sender: 'TTLouis', text: 'five' },
      { id: '6', role: 'assistant', sender: 'AIRI', text: 'six' },
      { id: '7', role: 'user', sender: 'TTLouis', text: 'seven' },
      { id: '8', role: 'assistant', sender: 'AIRI', text: 'eight' },
    ]
    expect(task_conversation_messages({ goal_id: 'goal-a', conversation_id: 'task-a', conversation }).map(message => message.text)).toEqual(
      ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'],
    )
  })

  it('New Task reset rebinds the view to a fresh conversation generation', () => {
    const old = { goal_id: 'goal-a', conversation_id: 'task-a', conversation: [
      { id: '1', role: 'user', sender: 'TTLouis', text: 'old request' },
      { id: '2', role: 'assistant', sender: 'AIRI', text: 'old answer' },
    ] }
    expect(task_conversation_messages(old)).toHaveLength(2)
    reset_task_conversation()
    const fresh = { goal_id: 'goal-b', conversation_id: 'task-b', conversation: [
      { id: '1', role: 'user', sender: 'TTLouis', text: 'fresh request' },
    ] }
    expect(task_conversation_messages(fresh).map(message => message.text)).toEqual(['fresh request'])
    expect(store().airi_task_board_conversation_id).toBe('task-b')
  })

  it('does not resurrect old activity-history messages after a fresh conversation sync', () => {
    store().airi_task_board_activity_history = [
      { id: 'live_old_1', kind: 'observation', text: 'TTLouis: old request', timestamp: '00:00:01' },
      { kind: 'decision', text: 'old answer', timestamp: '00:00:02' },
    ]
    reset_task_conversation()
    const fresh = { goal_id: 'goal-b', conversation_id: 'task-b', conversation: [
      { id: 'new-1', role: 'user', sender: 'TTLouis', text: 'fresh request' },
      { id: 'new-2', role: 'assistant', sender: 'AIRI', text: 'fresh answer' },
    ] }
    expect(task_conversation_messages(fresh).map(message => message.text)).toEqual(['fresh request', 'fresh answer'])
    expect(task_conversation_messages(fresh).map(message => message.text)).toEqual(['fresh request', 'fresh answer'])
  })
})
