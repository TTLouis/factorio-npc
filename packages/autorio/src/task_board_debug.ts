import type { LuaGuiElement, ScrollPaneGuiElement } from 'factorio:runtime'

import * as activity_state from './task_board_activity'
import * as gui_text from './task_board_gui_text'

export const DEBUG_BUTTON_NAME = 'airi_task_board_debug'
export const DEBUG_CLOSE_BUTTON_NAME = 'airi_task_board_debug_close'
const CONVERSATION_HEIGHT = 300
const CONVERSATION = {
  section: 'airi_task_board_conversation_section',
  header: 'airi_task_board_conversation_header',
  state: 'airi_task_board_activity_live',
  count: 'airi_task_board_conversation_count',
  body: 'airi_task_board_conversation_body',
  empty: 'airi_task_board_conversation_empty',
  scroll: 'airi_task_board_activity_scroll',
  table: 'airi_task_board_activity_table',
}
export const DEBUG_ACTIVITY_STATE_NAME = 'airi_task_board_debug_activity_state'
export const DEBUG_ACTIVITY_SCROLL_NAME = 'airi_task_board_debug_activity_scroll'

declare const storage: {
  airi_task_board_debug_open?: Record<number, boolean>
  airi_task_board_ui_generation?: number
  airi_task_board_ui_revision?: number
  airi_task_board_ui?: any
  airi_task_board_ui_suppressed?: { goal_id: string, objective: string }
  airi_task_board_ui_last_seen?: { goal_id: string, objective: string }
  airi_task_board_ui_inputs?: any[]
  airi_task_board_activity_history?: any[]
  airi_task_board_conversation_goal_id?: string
  airi_task_board_conversation_start_key?: string
  airi_task_board_conversation_id?: string
  airi_task_board_debug_activity_view?: Record<number, { follow: boolean, behind: boolean, seen_key?: string }>
}

export interface TaskBoardUiStructuredContentDebug {
  json_valid?: boolean
  plan_valid?: boolean
  error: string
}

export interface TaskBoardUiDebugSnapshot {
  request_id: string
  turn: number
  provider_model: string
  provider_round: number
  provider_latency_ms: number
  provider_diagnostic_code: string
  provider_finish_reason: string
  response_id?: string
  response_bytes?: number
  tool_call_count?: number
  content_utf8_bytes?: number
  content_non_ascii_chars?: number
  content_replacement_chars?: number
  normalized_content_chars?: number
  structured_content?: TaskBoardUiStructuredContentDebug
  provider_capability_profile: string
  requested_token_field: string
  requested_output_cap: number
  requested_reasoning_effort: string
  requested_thinking_mode: string
  reported_reasoning_tokens: number
  usage_complete: number
  cap_enforcement_anomaly: number
  reasoning_effort: string
  reasoning_policy_reason: string
  content_chars: number
  reasoning_content_chars: number
  input_units: number
  cached_input_units: number
  output_units: number
  total_units: number
  latest_round_provider_round: number
  latest_round_input_units: number
  latest_round_cached_input_units: number
  latest_round_output_units: number
  latest_round_total_units: number
  decision_provider: string
  decision_model: string
  decision_shadow_intent: string
  decision_active_intent: string
  decision_post_step_route: string
  decision_post_step_applied_route: string
  decision_post_step_confidence_percent: number
  decision_post_step_latency_ms: number
  decision_post_step_fallback: string
  decision_scope_review: string
  decision_scope_review_confidence_percent: number
  decision_scope_review_reason_codes: string
  decision_scope_review_actionable_prefix: number
  decision_scope_review_failure_stage: string
  decision_scope_review_failure_reason: string
  decision_scope_review_packet_version: number
  decision_scope_review_grounding_observations: number
  decision_scope_review_live_entities: number
  decision_scope_review_preflight_count: number
  decision_granularity: string
  decision_granularity_confidence_percent: number
  decision_development: string
  decision_development_confidence_percent: number
  decision_reasoning_budget: string
  decision_reasoning_confidence_percent: number
  decision_planning_horizon: string
  decision_observation_budget: number
  decision_milestone_transition: string
  decision_milestone_transition_confidence_percent: number
  decision_hierarchy_action: string
  decision_confidence_percent: number
  decision_queue_conflict_percent: number
  decision_latency_ms: number
  decision_input_units: number
  decision_output_units: number
  decision_cost_micro_usd: number
  decision_calls_total: number
  decision_input_units_total: number
  decision_output_units_total: number
  decision_cost_micro_usd_total: number
  decision_shadow_matches_total: number
  decision_shadow_mismatches_total: number
  decision_post_step_calls_total: number
  decision_planner_skips_total: number
  decision_planner_wakes_total: number
  decision_planner_continue_low_wakes_total: number
  decision_planner_reanchor_low_wakes_total: number
  decision_planner_replan_high_wakes_total: number
  decision_planner_fallback_wakes_total: number
  decision_error: string
  step_relation: string
  step_checkpoint_boundary: string
  step_admission_alignment: string
  step_completion_contract: string
  step_completion_status: string
  step_completion_evidence: string
  runtime_condition: string
  runtime_condition_state: string
  last_tool: string
  last_event: string
  recovery_attempt: number
  recovery_result: string
  last_error: string
  actor_id: number
  actor_epoch: number
}

export interface TaskConversationMessage {
  key: string
  role: 'user' | 'assistant'
  sender: string
  text: string
  timestamp: string
}

function clean_text(value: unknown, max = 500) {
  let clean = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (clean.includes('  ')) clean = clean.split('  ').join(' ')
  return clean.length <= max ? clean : `${clean.slice(0, math.max(0, max - 1))}…`
}
function integer(value: unknown, fallback = 0) { return typeof value === 'number' && value === math.floor(value) && value >= 0 ? value : fallback }
function optional_integer(value: unknown) { return typeof value === 'number' && value === math.floor(value) && value >= 0 && value <= 2147483647 ? value : undefined }
function optional_text(value: unknown, max: number) {
  if (typeof value !== 'string') return undefined
  const clean = clean_text(value, max)
  return clean.length > 0 ? clean : undefined
}
function sanitize_structured_content(value: any): TaskBoardUiStructuredContentDebug | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const json_valid = typeof value.json_valid === 'boolean' ? value.json_valid : undefined
  const plan_valid = typeof value.plan_valid === 'boolean' ? value.plan_valid : undefined
  const error = optional_text(value.error, 300) ?? ''
  if (json_valid === undefined && plan_valid === undefined && error.length === 0) return undefined
  return { json_valid, plan_valid, error }
}
function valid_version(value: unknown) { return typeof value === 'number' && value === math.floor(value) && value >= 0 }

export function sanitize_debug_snapshot(value: any): TaskBoardUiDebugSnapshot {
  const debug = value !== null && typeof value === 'object' ? value : {}
  return {
    request_id: clean_text(debug.request_id, 120),
    turn: integer(debug.turn),
    provider_model: clean_text(debug.provider_model, 160),
    provider_round: integer(debug.provider_round),
    provider_latency_ms: integer(debug.provider_latency_ms),
    provider_diagnostic_code: clean_text(debug.provider_diagnostic_code, 160),
    provider_finish_reason: clean_text(debug.provider_finish_reason, 80),
    response_id: optional_text(debug.response_id, 160),
    response_bytes: optional_integer(debug.response_bytes),
    tool_call_count: optional_integer(debug.tool_call_count),
    content_utf8_bytes: optional_integer(debug.content_utf8_bytes),
    content_non_ascii_chars: optional_integer(debug.content_non_ascii_chars),
    content_replacement_chars: optional_integer(debug.content_replacement_chars),
    normalized_content_chars: optional_integer(debug.normalized_content_chars),
    structured_content: sanitize_structured_content(debug.structured_content),
    provider_capability_profile: clean_text(debug.provider_capability_profile, 40),
    requested_token_field: clean_text(debug.requested_token_field, 40),
    requested_output_cap: integer(debug.requested_output_cap),
    requested_reasoning_effort: clean_text(debug.requested_reasoning_effort, 32),
    requested_thinking_mode: clean_text(debug.requested_thinking_mode, 32),
    reported_reasoning_tokens: integer(debug.reported_reasoning_tokens),
    usage_complete: math.min(1, integer(debug.usage_complete)),
    cap_enforcement_anomaly: math.min(1, integer(debug.cap_enforcement_anomaly)),
    reasoning_effort: clean_text(debug.reasoning_effort, 32),
    reasoning_policy_reason: clean_text(debug.reasoning_policy_reason, 80),
    content_chars: integer(debug.content_chars),
    reasoning_content_chars: integer(debug.reasoning_content_chars),
    input_units: integer(debug.input_units),
    cached_input_units: integer(debug.cached_input_units),
    output_units: integer(debug.output_units),
    total_units: integer(debug.total_units),
    latest_round_provider_round: integer(debug.latest_round_provider_round),
    latest_round_input_units: integer(debug.latest_round_input_units),
    latest_round_cached_input_units: integer(debug.latest_round_cached_input_units),
    latest_round_output_units: integer(debug.latest_round_output_units),
    latest_round_total_units: integer(debug.latest_round_total_units),
    decision_provider: clean_text(debug.decision_provider, 80),
    decision_model: clean_text(debug.decision_model, 160),
    decision_shadow_intent: clean_text(debug.decision_shadow_intent, 80),
    decision_active_intent: clean_text(debug.decision_active_intent, 80),
    decision_post_step_route: clean_text(debug.decision_post_step_route, 80),
    decision_post_step_applied_route: clean_text(debug.decision_post_step_applied_route, 80),
    decision_post_step_confidence_percent: math.min(100, integer(debug.decision_post_step_confidence_percent)),
    decision_post_step_latency_ms: integer(debug.decision_post_step_latency_ms),
    decision_post_step_fallback: clean_text(debug.decision_post_step_fallback, 300),
    decision_scope_review: clean_text(debug.decision_scope_review, 32),
    decision_scope_review_confidence_percent: math.min(100, integer(debug.decision_scope_review_confidence_percent)),
    decision_scope_review_reason_codes: clean_text(debug.decision_scope_review_reason_codes, 300),
    decision_scope_review_actionable_prefix: math.min(100, integer(debug.decision_scope_review_actionable_prefix)),
    decision_scope_review_failure_stage: clean_text(debug.decision_scope_review_failure_stage, 40),
    decision_scope_review_failure_reason: clean_text(debug.decision_scope_review_failure_reason, 500),
    decision_scope_review_packet_version: integer(debug.decision_scope_review_packet_version),
    decision_scope_review_grounding_observations: integer(debug.decision_scope_review_grounding_observations),
    decision_scope_review_live_entities: integer(debug.decision_scope_review_live_entities),
    decision_scope_review_preflight_count: integer(debug.decision_scope_review_preflight_count),
    decision_granularity: clean_text(debug.decision_granularity, 32),
    decision_granularity_confidence_percent: math.min(100, integer(debug.decision_granularity_confidence_percent)),
    decision_development: clean_text(debug.decision_development, 32),
    decision_development_confidence_percent: math.min(100, integer(debug.decision_development_confidence_percent)),
    decision_reasoning_budget: clean_text(debug.decision_reasoning_budget, 32),
    decision_reasoning_confidence_percent: math.min(100, integer(debug.decision_reasoning_confidence_percent)),
    decision_planning_horizon: clean_text(debug.decision_planning_horizon, 32),
    decision_observation_budget: math.min(8, integer(debug.decision_observation_budget)),
    decision_milestone_transition: clean_text(debug.decision_milestone_transition, 48),
    decision_milestone_transition_confidence_percent: math.min(100, integer(debug.decision_milestone_transition_confidence_percent)),
    decision_hierarchy_action: clean_text(debug.decision_hierarchy_action, 80),
    decision_confidence_percent: math.min(100, integer(debug.decision_confidence_percent)),
    decision_queue_conflict_percent: math.min(100, integer(debug.decision_queue_conflict_percent)),
    decision_latency_ms: integer(debug.decision_latency_ms),
    decision_input_units: integer(debug.decision_input_units),
    decision_output_units: integer(debug.decision_output_units),
    decision_cost_micro_usd: integer(debug.decision_cost_micro_usd),
    decision_calls_total: integer(debug.decision_calls_total),
    decision_input_units_total: integer(debug.decision_input_units_total),
    decision_output_units_total: integer(debug.decision_output_units_total),
    decision_cost_micro_usd_total: integer(debug.decision_cost_micro_usd_total),
    decision_shadow_matches_total: integer(debug.decision_shadow_matches_total),
    decision_shadow_mismatches_total: integer(debug.decision_shadow_mismatches_total),
    decision_post_step_calls_total: integer(debug.decision_post_step_calls_total),
    decision_planner_skips_total: integer(debug.decision_planner_skips_total),
    decision_planner_wakes_total: integer(debug.decision_planner_wakes_total),
    decision_planner_continue_low_wakes_total: integer(debug.decision_planner_continue_low_wakes_total),
    decision_planner_reanchor_low_wakes_total: integer(debug.decision_planner_reanchor_low_wakes_total),
    decision_planner_replan_high_wakes_total: integer(debug.decision_planner_replan_high_wakes_total),
    decision_planner_fallback_wakes_total: integer(debug.decision_planner_fallback_wakes_total),
    decision_error: clean_text(debug.decision_error, 300),
    step_relation: clean_text(debug.step_relation, 80),
    step_checkpoint_boundary: clean_text(debug.step_checkpoint_boundary, 80),
    step_admission_alignment: clean_text(debug.step_admission_alignment, 80),
    step_completion_contract: clean_text(debug.step_completion_contract, 200),
    step_completion_status: clean_text(debug.step_completion_status, 120),
    step_completion_evidence: clean_text(debug.step_completion_evidence, 300),
    runtime_condition: clean_text(debug.runtime_condition, 300),
    runtime_condition_state: clean_text(debug.runtime_condition_state, 80),
    last_tool: clean_text(debug.last_tool, 120),
    last_event: clean_text(debug.last_event, 120),
    recovery_attempt: integer(debug.recovery_attempt),
    recovery_result: clean_text(debug.recovery_result, 64),
    last_error: clean_text(debug.last_error, 500),
    actor_id: integer(debug.actor_id),
    actor_epoch: integer(debug.actor_epoch),
  }
}

export function accept_sync_version(generation: unknown, revision: unknown) {
  if (!valid_version(generation) || !valid_version(revision)) return true
  const incoming_generation = generation as number
  const incoming_revision = revision as number
  const current_generation = storage.airi_task_board_ui_generation ?? -1
  const current_revision = storage.airi_task_board_ui_revision ?? -1
  if (incoming_generation < current_generation) return false
  if (incoming_generation === current_generation && incoming_revision <= current_revision) return false
  storage.airi_task_board_ui_generation = incoming_generation
  storage.airi_task_board_ui_revision = incoming_revision
  return true
}

export function current_sync_version() {
  return { generation: storage.airi_task_board_ui_generation ?? 0, revision: storage.airi_task_board_ui_revision ?? 0 }
}

function snapshot_identity(board: any) {
  return { goal_id: clean_text(board?.goal_id, 100), objective: clean_text(board?.objective, 500) }
}
export function suppress_snapshot(board: any) {
  if (board === undefined || board === null) return
  storage.airi_task_board_ui_suppressed = snapshot_identity(board)
}
export function clear_snapshot_suppression() { storage.airi_task_board_ui_suppressed = undefined }
export function snapshot_is_suppressed(value: any) {
  const suppressed = storage.airi_task_board_ui_suppressed
  if (suppressed === undefined || value === undefined || value === null || typeof value !== 'object') return false
  const objective = clean_text(value.objective, 500)
  const goal_id = clean_text(value.goal_id, 100)
  if (suppressed.objective.length === 0 || objective !== suppressed.objective) return false
  return goal_id.length === 0 || goal_id === suppressed.goal_id
}

function destructive_clear_is_queued() {
  for (const input of storage.airi_task_board_ui_inputs ?? []) {
    if (input?.kind === 'control' && (input?.action === 'terminate' || input?.action === 'new_task')) return true
  }
  return false
}

/**
 * Keep the UI projection monotonic around destructive clears without mutating
 * Factorio's `remote` object. The confirmed Terminate input creates a tombstone
 * before the runtime can drain it. We also learn a tombstone whenever a board
 * that was visible disappears, covering runtime-originated clears. If an old
 * heartbeat later republishes that same goal (including the plan-less live
 * projection with an empty goal id), clear it through the public remote
 * interface on the next deterministic game tick. A new durable goal id or a
 * different objective is accepted and becomes the new baseline.
 */
export function reconcile_task_board_freshness() {
  const current = storage.airi_task_board_ui
  if (destructive_clear_is_queued() && current !== undefined) {
    suppress_snapshot(current)
    storage.airi_task_board_ui_last_seen = snapshot_identity(current)
    return false
  }
  if (current === undefined) {
    if (storage.airi_task_board_ui_suppressed === undefined && storage.airi_task_board_ui_last_seen !== undefined) {
      storage.airi_task_board_ui_suppressed = storage.airi_task_board_ui_last_seen
    }
    return false
  }
  if (snapshot_is_suppressed(current)) {
    if (typeof remote !== 'undefined' && remote.interfaces?.autorio_task_board !== undefined) remote.call('autorio_task_board', 'clear')
    else storage.airi_task_board_ui = undefined
    return true
  }
  storage.airi_task_board_ui_last_seen = snapshot_identity(current)
  if (storage.airi_task_board_ui_suppressed !== undefined) clear_snapshot_suppression()
  return false
}

// New runtimes attach generation/revision numbers to every snapshot. Keep the
// watchdog as a rolling-upgrade fallback for an older unversioned supervisor.
if (typeof script !== 'undefined' && typeof defines !== 'undefined') {
  script.on_event(defines.events.on_tick, () => { reconcile_task_board_freshness() })
}

function ensure_debug_open_state() { if (storage.airi_task_board_debug_open === undefined) storage.airi_task_board_debug_open = {}; return storage.airi_task_board_debug_open }
export function debug_ui_is_open(player_index: number) { return storage.airi_task_board_debug_open?.[player_index] === true }
// Runtime diagnostics are intentionally bounded and ride the normal snapshot,
// so the poll schema stays unchanged and remains compatible with older eggs.
export function any_debug_ui_open(): any { return undefined }
export function toggle_debug_ui(player_index: number) { const next = !debug_ui_is_open(player_index); ensure_debug_open_state()[player_index] = next; return next }
export function close_debug_ui(player_index: number) { ensure_debug_open_state()[player_index] = false }
export function debug_button_caption(player_index: number) { return debug_ui_is_open(player_index) ? 'DEBUG ON' : 'DEBUG' }
export function follow_button_caption(active: boolean) { return active ? 'FOLLOWING' : 'FOLLOW' }

export function debug_activity_view(player_index: number) {
  if (storage.airi_task_board_debug_activity_view === undefined) storage.airi_task_board_debug_activity_view = {}
  let view = storage.airi_task_board_debug_activity_view[player_index]
  if (view === undefined) {
    view = { follow: true, behind: false }
    storage.airi_task_board_debug_activity_view[player_index] = view
  }
  return view
}
export function toggle_debug_activity_follow(player_index: number) {
  const view = debug_activity_view(player_index)
  view.follow = !view.follow
  if (view.follow) view.behind = true
  return view
}
function task_activity_key(entry: any) {
  const id = clean_text(entry?.id, 120)
  if (id.length > 0) return `id:${id}`
  return `${clean_text(entry?.kind, 32)}|${clean_text(entry?.timestamp, 16)}|${clean_text(entry?.text, 2000)}`
}

function activity_conversation_message(entry: any): TaskConversationMessage | undefined {
  const kind = clean_text(entry?.kind, 32)
  const line = clean_text(entry?.text, 2000)
  if (line.length === 0) return undefined
  const timestamp = clean_text(entry?.timestamp, 16)
  const key = task_activity_key(entry)
  if (kind === 'decision') return { key, role: 'assistant', sender: 'AIRI', text: line, timestamp }
  if (kind !== 'observation') return undefined
  const id = clean_text(entry?.id, 120)
  if (!id.startsWith('live_') || line.startsWith('Tool ')) return undefined
  const separator = line.indexOf(': ')
  if (separator < 1) return undefined
  const sender = clean_text(line.substring(0, separator), 128)
  const text = clean_text(line.substring(separator + 2), 2000)
  if (sender.length === 0 || text.length === 0) return undefined
  return { key, role: 'user', sender, text, timestamp }
}

function objective_matches_message(objective: string, message: string) {
  const left = clean_text(objective, 500)
  const right = clean_text(message, 500)
  if (left.length === 0 || right.length === 0) return false
  if (left === right) return true
  const length = math.min(220, math.min(left.length, right.length))
  return length >= 24 && left.substring(0, length) === right.substring(0, length)
}

/**
 * Conversation is a player-facing projection of the already-retained activity
 * history, not hidden model reasoning. A new durable goal establishes a new
 * start cursor, while pause/follow/continue keep using the same goal and cursor.
 */
export function reset_task_conversation() {
  storage.airi_task_board_conversation_goal_id = undefined
  storage.airi_task_board_conversation_start_key = undefined
  storage.airi_task_board_conversation_id = undefined
}

export function task_conversation_messages(board: any): TaskConversationMessage[] {
  if (board === undefined || board === null) return []
  // A destructive lifecycle boundary owns the current-conversation reset even
  // before the runtime has drained the queued control. Likewise, once the old
  // snapshot is tombstoned, never project its explicit conversation again while
  // waiting for the authoritative clear/new snapshot.
  if (destructive_clear_is_queued() || snapshot_is_suppressed(board)) return []
  const explicit = Array.isArray(board.conversation) ? board.conversation as any[] : []
  const conversation_id = clean_text(board.conversation_id, 120)
  if (conversation_id.length > 0) {
    if (storage.airi_task_board_conversation_id !== conversation_id) {
      storage.airi_task_board_conversation_id = conversation_id
      storage.airi_task_board_conversation_goal_id = clean_text(board.goal_id, 100)
      storage.airi_task_board_conversation_start_key = undefined
    }
    const visible: TaskConversationMessage[] = []
    for (let index = 0; index < explicit.length; index++) {
      const entry = explicit[index]
      const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : undefined
      const line = clean_text(entry?.text, 2000)
      if (role === undefined || line.length === 0) continue
      visible.push({
        key: `conversation:${clean_text(entry?.id || `message_${index + 1}`, 120)}`,
        role,
        sender: clean_text(entry?.sender || (role === 'assistant' ? 'AIRI' : 'Player'), 128),
        text: line,
        timestamp: '',
      })
    }
    return visible
  }

  const raw_history = Array.isArray(storage.airi_task_board_activity_history)
    ? storage.airi_task_board_activity_history as any[]
    : Array.isArray(board.activity) ? board.activity as any[] : []
  const messages: TaskConversationMessage[] = []
  for (const entry of raw_history) {
    const message = activity_conversation_message(entry)
    if (message === undefined) continue
    const previous = messages.length > 0 ? messages[messages.length - 1] : undefined
    if (message.role === 'assistant' && previous?.role === 'assistant' && previous.text === message.text) continue
    messages.push(message)
  }
  if (messages.length === 0) return []

  const goal_id = clean_text(board.goal_id, 100)
  const previous_goal = storage.airi_task_board_conversation_goal_id ?? ''
  if (goal_id.length > 0 && goal_id !== previous_goal) {
    let start_key = ''
    const objective = clean_text(board.objective, 500)
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.role !== 'user' || !objective_matches_message(objective, message.text)) continue
      start_key = message.key
      break
    }
    if (start_key.length === 0) {
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role !== 'user') continue
        start_key = messages[index].key
        break
      }
    }
    storage.airi_task_board_conversation_goal_id = goal_id
    storage.airi_task_board_conversation_start_key = start_key
  }

  const start_key = storage.airi_task_board_conversation_start_key ?? ''
  if (start_key.length === 0) return messages
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].key === start_key) return messages.slice(index)
  }
  return messages
}

/**
 * Activity keys (task_board_activity's form) of the rows the Current Task
 * Conversation shows right now. Recent activity skips them: the same player
 * message or AIRI reply printed twice, one panel above the other, is noise.
 */
export function conversation_activity_keys(board: any) {
  const hidden: Record<string, boolean> = {}
  const messages = task_conversation_messages(board)
  if (messages.length === 0) return hidden
  const shown: Record<string, boolean> = {}
  for (const message of messages) shown[message.key] = true
  const history = Array.isArray(storage.airi_task_board_activity_history)
    ? storage.airi_task_board_activity_history as any[]
    : Array.isArray(board?.activity) ? board.activity as any[] : []
  for (const entry of history) {
    if (shown[task_activity_key(entry)]) hidden[activity_state.activity_key(entry)] = true
  }
  return hidden
}

export function latest_ai_reply(board: any) {
  const direct = clean_text(board?.response, 2000)
  if (direct.length > 0) return direct
  const messages = task_conversation_messages(board)
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant') return messages[index].text
  }
  const activity = Array.isArray(board?.activity) ? board.activity as any[] : []
  for (let index = activity.length - 1; index >= 0; index--) {
    if (activity[index]?.kind !== 'decision') continue
    const reply = clean_text(activity[index]?.text, 2000)
    if (reply.length > 0) return reply
  }
  return ''
}

export function render_ai_reply(parent: LuaGuiElement, response: string, width: number) {
  // Status/Controls live in a dynamic flow that is cleared once a second. The
  // conversation must not live inside that flow: rebuilding a scroll-pane loses
  // the player's scroll position. Place it beside the dynamic flow in the left
  // column and refresh its rows in place, matching Recent activity's behavior.
  const host = parent.parent?.valid ? parent.parent : parent
  let section = host[CONVERSATION.section]
  let created = false
  if (!section?.valid) {
    created = true
    section = host.add({ type: 'frame', name: CONVERSATION.section, direction: 'vertical', style: 'inside_shallow_frame' })
    section.style.width = width
    section.style.horizontally_stretchable = false
    const header = section.add({ type: 'frame', name: CONVERSATION.header, direction: 'horizontal', style: 'subheader_frame' })
    header.style.horizontally_stretchable = true
    header.style.vertical_align = 'center'
    header.add({ type: 'label', caption: 'Current Task Conversation', style: 'subheader_caption_label' })
    const filler = header.add({ type: 'empty-widget' }); filler.style.horizontally_stretchable = true
    activity_state.style_feed_button(header.add({ type: 'button', name: CONVERSATION.state, caption: gui_text.trusted_rich_text('[img=utility/status_working] LIVE'), tooltip: 'Conversation follows the same LIVE/PAUSED reading mode as Activity. Click to pause or resume both feeds.' }), activity_state.FEED_STATE_BUTTON_WIDTH)
    const count = header.add({ type: 'label', name: CONVERSATION.count, caption: '0 messages', style: 'semibold_label' }); count.style.left_padding = 6; count.style.right_padding = 4
    const body = section.add({ type: 'flow', name: CONVERSATION.body, direction: 'vertical' })
    body.style.padding = 10
    body.style.horizontally_stretchable = true
    const empty = body.add({ type: 'label', name: CONVERSATION.empty, caption: 'No current task conversation.' }); empty.style.font_color = { r: 0.68, g: 0.68, b: 0.68 }
    const scroll = body.add({ type: 'scroll-pane', name: CONVERSATION.scroll, style: 'scroll_pane_in_shallow_frame', horizontal_scroll_policy: 'never', vertical_scroll_policy: 'auto-and-reserve-space' })
    scroll.style.horizontally_stretchable = true
    scroll.style.maximal_height = CONVERSATION_HEIGHT
    const table = scroll.add({ type: 'table', name: CONVERSATION.table, column_count: 3, tags: { keys: [], chat_seen: '', was_following: true } })
    table.style.horizontal_spacing = 8
    table.style.vertical_spacing = 5
  }

  const header = section[CONVERSATION.header]
  const body = section[CONVERSATION.body]
  const empty = body?.valid ? body[CONVERSATION.empty] : undefined
  const scroll = body?.valid ? body[CONVERSATION.scroll] : undefined
  const table = scroll?.valid ? scroll[CONVERSATION.table] : undefined
  if (!header?.valid || !empty?.valid || !scroll?.valid || !table?.valid) return

  const messages = task_conversation_messages(storage.airi_task_board_ui)
  const explicit = clean_text(response, 2000)
  const visible = [...messages]
  if (explicit.length > 0 && (visible.length === 0 || visible[visible.length - 1].role !== 'assistant' || visible[visible.length - 1].text !== explicit)) {
    visible.push({ key: `explicit-response:${explicit}`, role: 'assistant', sender: 'AIRI', text: explicit, timestamp: '' })
  }
  const keys = visible.map(message => message.key)
  empty.visible = visible.length === 0
  empty.caption = storage.airi_task_board_ui === undefined ? 'No current task conversation.' : 'No player/AIRI messages recorded for this task yet.'
  scroll.visible = visible.length > 0

  const add_message = (message: TaskConversationMessage) => {
    const timestamp = table.add({ type: 'label', caption: message.timestamp || '--:--:--', ignored_by_interaction: true })
    timestamp.style.minimal_width = 66
    timestamp.style.font_color = { r: 0.68, g: 0.68, b: 0.68 }
    const speaker = gui_text.literal_gui_text(table.add({ type: 'label', caption: message.role === 'assistant' ? 'AIRI' : message.sender, style: 'semibold_label', ignored_by_interaction: true }))
    speaker.style.minimal_width = 72
    const line = gui_text.literal_gui_text(table.add({ type: 'label', caption: message.text, ignored_by_interaction: true }))
    line.style.single_line = false
    line.style.maximal_width = width - 190
  }

  const shown = (table.tags.keys ?? []) as string[]
  const previous_follow = table.tags.was_following !== false
  let seen = String(table.tags.chat_seen ?? '')
  const diff = activity_state.activity_rows_diff(shown, keys)
  let appended = 0
  if (diff === undefined) {
    table.clear()
    for (const message of visible) add_message(message)
    appended = visible.length
  } else {
    const children = table.children
    for (let index = 0; index < diff.drop * 3 && index < children.length; index++) children[index].destroy()
    for (let index = visible.length - diff.append; index < visible.length; index++) add_message(visible[index])
    appended = diff.append
  }

  const view = activity_state.activity_view((parent as any).player_index)
  const last_key = keys.length > 0 ? keys[keys.length - 1] : ''
  if (!view.follow && previous_follow) seen = shown.length > 0 ? shown[shown.length - 1] : ''
  if (view.follow) {
    if (created || !previous_follow || appended > 0) (scroll as ScrollPaneGuiElement).scroll_to_bottom()
    seen = last_key
  } else if (created) {
    (scroll as ScrollPaneGuiElement).scroll_to_bottom()
    seen = last_key
  }

  table.tags = { keys, chat_seen: seen, was_following: view.follow }
  let unseen_count = 0
  let overflow = false
  if (!view.follow && keys.length > 0 && seen !== last_key) {
    const unseen = activity_state.activity_unseen(keys, seen.length > 0 ? seen : undefined)
    unseen_count = unseen.count
    overflow = unseen.overflow
  }
  const state = header[CONVERSATION.state]
  if (state?.valid) {
    if (view.follow && unseen_count === 0) {
      state.caption = gui_text.trusted_rich_text('[img=utility/status_working] LIVE')
      state.tooltip = 'Following the newest conversation. Click to pause both Conversation and Activity at their current positions.'
    } else if (unseen_count > 0) {
      state.caption = gui_text.trusted_rich_text(`[img=utility/status_yellow] ${unseen_count}${overflow ? '+' : ''} NEW`)
      state.tooltip = 'New conversation messages arrived without moving your reading position. Click to jump both feeds back to live.'
    } else {
      state.caption = gui_text.trusted_rich_text('[img=utility/status_inactive] PAUSED')
      state.tooltip = 'Conversation and Activity are paused at your reading position. Click to jump back to live.'
    }
  }
  const count = header[CONVERSATION.count]
  if (count?.valid) count.caption = `${visible.length} message${visible.length === 1 ? '' : 's'}`
}
