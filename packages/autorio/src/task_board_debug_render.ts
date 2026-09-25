import type { FrameGuiElement, LuaGuiElement, LuaPlayer, ScrollPaneGuiElement } from 'factorio:runtime'

import * as activity_state from './task_board_activity'
import * as gui_text from './task_board_gui_text'
import {
  DEBUG_ACTIVITY_SCROLL_NAME,
  DEBUG_ACTIVITY_STATE_NAME,
  DEBUG_BUTTON_NAME,
  close_debug_ui,
  current_sync_version,
  debug_activity_view,
  debug_ui_is_open,
  latest_ai_reply,
  sanitize_debug_snapshot,
} from './task_board_debug'
import type { TaskBoardUiDebugSnapshot } from './task_board_debug'

const DEBUG_ROOT_NAME = 'airi_task_board_debug_panel'
const DEBUG_BODY_NAME = 'airi_task_board_debug_body'
const DEBUG_WIDTH = 1320
const DEBUG_KEY_WIDTH = 132
const DEBUG_BODY_INNER_WIDTH = DEBUG_WIDTH - 20
const DEBUG_COLUMN_GAP = 16
const DEBUG_COLUMN_WIDTH = math.floor((DEBUG_BODY_INNER_WIDTH - 2 * DEBUG_COLUMN_GAP) / 3)
const DEBUG_VALUE_WIDTH = DEBUG_WIDTH - DEBUG_KEY_WIDTH - 54
const DEBUG_COLUMN_VALUE_WIDTH = DEBUG_COLUMN_WIDTH - DEBUG_KEY_WIDTH - 34
const DEBUG_ACTIVITY = {
  section: 'airi_task_board_debug_activity_section',
  header: 'airi_task_board_debug_activity_header',
  count: 'airi_task_board_debug_activity_count',
  empty: 'airi_task_board_debug_activity_empty',
  feed: 'airi_task_board_debug_activity_feed',
}
const DEBUG_ACTIVITY_ROWS = 120

function clean_text(value: unknown, max = 500) {
  let clean = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (clean.includes('  ')) clean = clean.split('  ').join(' ')
  return clean.length <= max ? clean : `${clean.slice(0, math.max(0, max - 1))}…`
}

function integer(value: unknown, fallback = 0) {
  return typeof value === 'number' && value === math.floor(value) && value >= 0 ? value : fallback
}

function optional_metric(value: number | undefined) {
  return value === undefined ? '—' : `${integer(value)}`
}

function validity(value: boolean | undefined) {
  if (value === true) return 'valid'
  if (value === false) return 'invalid'
  return 'unknown'
}

function destroy_debug_popout(player: LuaPlayer) {
  const existing = player.gui.screen[DEBUG_ROOT_NAME]
  const location = existing?.valid ? existing.location : undefined
  if (existing?.valid) existing.destroy()
  return location
}
function add_row(table: LuaGuiElement, key: string, value: string, value_width = DEBUG_VALUE_WIDTH) {
  const left = table.add({ type: 'label', caption: key, style: 'semibold_label' }); left.style.minimal_width = DEBUG_KEY_WIDTH
  const right = gui_text.literal_gui_text(table.add({ type: 'label', caption: value.length > 0 ? value : '—' })); right.style.single_line = false; right.style.maximal_width = value_width
}
function add_compact_row(table: LuaGuiElement, key: string, value: string) {
  add_row(table, key, value, DEBUG_COLUMN_VALUE_WIDTH)
}
function sync_age(synced_tick: number | undefined) {
  if (synced_tick === undefined) return 'never'
  const seconds = math.floor(math.max(0, game.tick - synced_tick) / 60)
  return seconds < 60 ? `${seconds}s` : `${math.floor(seconds / 60)}m ${seconds % 60}s`
}

function add_debug_decision_rows(table: LuaGuiElement, debug: TaskBoardUiDebugSnapshot) {
  const decision_provider = clean_text(debug.decision_provider, 80)
  const decision_model = clean_text(debug.decision_model, 160)
  const decision_shadow = clean_text(debug.decision_shadow_intent, 80)
  const decision_active = clean_text(debug.decision_active_intent, 80)
  const decision_post_step = clean_text(debug.decision_post_step_route, 80)
  const decision_post_step_applied = clean_text(debug.decision_post_step_applied_route, 80)
  const decision_post_step_confidence = math.min(100, integer(debug.decision_post_step_confidence_percent))
  const decision_post_step_latency = integer(debug.decision_post_step_latency_ms)
  const decision_post_step_fallback = clean_text(debug.decision_post_step_fallback, 300)
  const decision_granularity = clean_text(debug.decision_granularity, 32)
  const decision_granularity_confidence = math.min(100, integer(debug.decision_granularity_confidence_percent))
  const decision_development = clean_text(debug.decision_development, 32)
  const decision_development_confidence = math.min(100, integer(debug.decision_development_confidence_percent))
  const decision_reasoning_budget = clean_text(debug.decision_reasoning_budget, 32)
  const decision_reasoning_confidence = math.min(100, integer(debug.decision_reasoning_confidence_percent))
  const decision_planning_horizon = clean_text(debug.decision_planning_horizon, 32)
  const decision_observation_budget = math.min(8, integer(debug.decision_observation_budget))
  const decision_milestone_transition = clean_text(debug.decision_milestone_transition, 48)
  const decision_milestone_transition_confidence = math.min(100, integer(debug.decision_milestone_transition_confidence_percent))
  const decision_hierarchy_action = clean_text(debug.decision_hierarchy_action, 80)
  const decision_confidence = math.min(100, integer(debug.decision_confidence_percent))
  const decision_conflict = math.min(100, integer(debug.decision_queue_conflict_percent))
  const decision_latency = integer(debug.decision_latency_ms)
  const decision_input = integer(debug.decision_input_units)
  const decision_output = integer(debug.decision_output_units)
  const decision_cost = integer(debug.decision_cost_micro_usd)
  const decision_calls_total = integer(debug.decision_calls_total)
  const decision_input_total = integer(debug.decision_input_units_total)
  const decision_output_total = integer(debug.decision_output_units_total)
  const decision_cost_total = integer(debug.decision_cost_micro_usd_total)
  const decision_matches = integer(debug.decision_shadow_matches_total)
  const decision_mismatches = integer(debug.decision_shadow_mismatches_total)
  const decision_post_step_calls = integer(debug.decision_post_step_calls_total)
  const decision_planner_skips = integer(debug.decision_planner_skips_total)
  const decision_planner_wakes = integer(debug.decision_planner_wakes_total)
  const decision_planner_low = integer(debug.decision_planner_continue_low_wakes_total)
  const decision_planner_reanchor = integer(debug.decision_planner_reanchor_low_wakes_total)
  const decision_planner_high = integer(debug.decision_planner_replan_high_wakes_total)
  const decision_planner_fallback = integer(debug.decision_planner_fallback_wakes_total)

  const jev_measurement = clean_text(debug.jev_measurement, 32)
  const jev_request_calls = integer(debug.jev_request_calls)
  const jev_request_fallbacks = integer(debug.jev_request_fallbacks)
  const jev_request_fallback_percent = math.min(100, integer(debug.jev_request_fallback_percent))
  const jev_last_fallback = clean_text(debug.jev_last_fallback, 300)
  const decision_fallbacks_total = integer(debug.decision_fallbacks_total)
  // A degraded measurement means Jev mostly fell back: this request is not
  // evidence about Jev's judgments.
  add_compact_row(table, 'Jev health', jev_measurement.length > 0
    ? `${jev_measurement.toUpperCase()} · ${jev_request_fallbacks}/${jev_request_calls} fell back (${jev_request_fallback_percent}%) · ${decision_fallbacks_total} total`
    : '—')
  add_compact_row(table, 'Jev last fallback', jev_last_fallback.length > 0 ? jev_last_fallback : '—')

  const scope_review = clean_text(debug.decision_scope_review, 32)
  const scope_review_confidence = math.min(100, integer(debug.decision_scope_review_confidence_percent))
  const scope_review_reasons = clean_text(debug.decision_scope_review_reason_codes, 300)
  const scope_review_prefix = integer(debug.decision_scope_review_actionable_prefix)
  const scope_failure_stage = clean_text(debug.decision_scope_review_failure_stage, 40)
  const scope_failure_reason = clean_text(debug.decision_scope_review_failure_reason, 500)
  const scope_packet_version = integer(debug.decision_scope_review_packet_version)
  const scope_observations = integer(debug.decision_scope_review_grounding_observations)
  const scope_live_entities = integer(debug.decision_scope_review_live_entities)
  const scope_preflight = integer(debug.decision_scope_review_preflight_count)
  add_compact_row(table, 'Jev scope review', scope_review.length > 0
    ? `${scope_review.toUpperCase()} · ${scope_review_confidence}%${scope_review_reasons ? ` · ${scope_review_reasons}` : ''}${scope_review_prefix > 0 ? ` · prefix ${scope_review_prefix}` : ''}`
    : '—')
  add_compact_row(table, 'Scope review packet', scope_packet_version > 0
    ? `v${scope_packet_version} · obs ${scope_observations} · live ${scope_live_entities} · preflight ${scope_preflight}`
    : '—')
  add_compact_row(table, 'Scope review failure', scope_failure_reason.length > 0
    ? `${scope_failure_stage || 'unknown'} · ${scope_failure_reason}`
    : '—')
  add_compact_row(table, 'Decision provider', decision_model.length > 0 ? `${decision_provider || 'decision'} · ${decision_model}` : '—')
  add_compact_row(table, 'Decision shadow', decision_shadow.length > 0 ? `${decision_shadow} · ${decision_confidence}% · active ${decision_active || 'unknown'} · conflict ${decision_conflict}%` : '—')
  add_compact_row(table, 'Jev ACTIVE post-step', decision_post_step.length > 0 ? `${decision_post_step}${decision_post_step_applied.length > 0 && decision_post_step_applied !== decision_post_step ? ` → ${decision_post_step_applied}` : ''} · ${decision_post_step_confidence}% · ${decision_post_step_latency} ms${decision_post_step_fallback.length > 0 ? ` · ${decision_post_step_fallback}` : ''}` : '—')
  add_compact_row(table, 'Jev hierarchy · gate', decision_granularity.length > 0 || decision_development.length > 0 || decision_reasoning_budget.length > 0
    ? `granularity ${decision_granularity || '—'} ${decision_granularity_confidence}% · development ${decision_development || '—'} ${decision_development_confidence}% · budget(shadow) ${decision_reasoning_budget || '—'} ${decision_reasoning_confidence}% · horizon(shadow) ${decision_planning_horizon || '—'} · observations(shadow) ${decision_observation_budget}`
    : '—')
  add_compact_row(table, 'Jev milestone transition', decision_milestone_transition.length > 0
    ? `${decision_milestone_transition} · ${decision_milestone_transition_confidence}%${decision_hierarchy_action.length > 0 ? ` → ${decision_hierarchy_action}` : ''}`
    : '—')
  add_compact_row(table, 'Decision usage', decision_shadow.length > 0 || decision_post_step.length > 0 ? `${decision_input} in / ${decision_output} out · ${decision_latency || decision_post_step_latency} ms${decision_cost > 0 ? ` · ${decision_cost} µUSD` : ''}` : '—')
  add_compact_row(table, 'Decision totals', decision_calls_total > 0 ? `${decision_calls_total} calls · ${decision_input_total} in / ${decision_output_total} out${decision_cost_total > 0 ? ` · ${decision_cost_total} µUSD` : ''} · shadow ${decision_matches} match / ${decision_mismatches} differ` : '—')
  add_compact_row(table, 'Planner routing · Jev', decision_post_step_calls > 0 || decision_planner_skips > 0 || decision_planner_wakes > 0 ? `${decision_planner_skips} skips / ${decision_planner_low} continue / ${decision_planner_reanchor} reanchor / ${decision_planner_high} replan / ${decision_planner_fallback} fallback · ${decision_post_step_calls} decisions` : 'not active yet')
}

function add_debug_step_rows(table: LuaGuiElement, debug: TaskBoardUiDebugSnapshot) {
  const step_completion_contract = clean_text(debug.step_completion_contract, 200)
  const step_completion_status = clean_text(debug.step_completion_status, 120)
  const step_completion_evidence = clean_text(debug.step_completion_evidence, 300)
  const runtime_condition = clean_text(debug.runtime_condition, 300)
  const runtime_condition_state = clean_text(debug.runtime_condition_state, 80)

  add_compact_row(table, 'Completion proof', step_completion_contract.length > 0 || step_completion_status.length > 0 ? `${step_completion_contract.length > 0 ? step_completion_contract : 'semantic'} · ${step_completion_status.length > 0 ? step_completion_status : 'unknown'}${step_completion_evidence.length > 0 ? ` · ${step_completion_evidence}` : ''}` : '—')
  add_compact_row(table, 'Runtime wait', runtime_condition.length > 0 || runtime_condition_state.length > 0 ? `${runtime_condition_state.length > 0 ? runtime_condition_state : 'unknown'} · ${runtime_condition.length > 0 ? runtime_condition : '—'}` : '—')
}

const DEBUG_SYNC = { columns: 'airi_debug_columns', runtime_column: 'airi_debug_runtime_column', runtime_table: 'airi_debug_runtime_table', value: 'airi_debug_sync_value' }
function sync_caption(synced_tick: number | undefined) {
  const version = current_sync_version()
  return `gen ${version.generation} · rev ${version.revision} · age ${sync_age(synced_tick)}`
}
/**
 * The body is rebuilt only when what it shows changes. The sync age ticks every
 * second, so that one label is updated in place instead of rebuilding the body.
 */
function fill_debug_body(body: LuaGuiElement, board: any, runtime: any, synced_tick: number | undefined) {
  const version_now = current_sync_version()
  const signature = helpers.table_to_json({ debug: board?.debug, agent: board?.agent, status: board?.status, objective: board?.objective, goal_id: board?.goal_id, active_index: board?.active_index, total_steps: board?.total_steps, completed_count: board?.completed_count, reply: latest_ai_reply(board), actor_name: runtime?.actor_name, actor_kind: runtime?.actor_kind, follow: runtime?.follow, world: runtime?.world_task, generation: version_now.generation, revision: version_now.revision })
  if (body.tags.signature === signature) {
    const columns = body[DEBUG_SYNC.columns]; const column = columns?.valid ? columns[DEBUG_SYNC.runtime_column] : undefined; const table = column?.valid ? column[DEBUG_SYNC.runtime_table] : undefined; const value = table?.valid ? table[DEBUG_SYNC.value] : undefined
    if (value?.valid) { const caption = sync_caption(synced_tick); if (value.caption !== caption) value.caption = caption; return }
  }
  body.clear()
  body.tags = { signature }
  const note = body.add({ type: 'label', caption: 'Structured runtime diagnostics only — no hidden chain-of-thought or secrets are exposed.' })
  note.style.font_color = { r: 0.68, g: 0.68, b: 0.68 }; note.style.single_line = false
  const debug = sanitize_debug_snapshot(board?.debug)
  const follow = runtime?.follow
  const world = runtime?.world_task
  const step = board !== undefined && board.total_steps > 0 ? `${math.min(board.active_index + 1, board.total_steps)}/${board.total_steps} (${board.completed_count} done)` : '—'
  const phase = board?.agent.phase ? String(board.agent.phase).toUpperCase() : 'IDLE'
  const detail = clean_text(board?.agent.detail, 300)
  const provider = clean_text(debug.provider_model, 160)
  const latency = integer(debug.provider_latency_ms)
  const response_id = clean_text(debug.response_id, 160)
  const has_response_metrics = debug.response_bytes !== undefined || debug.tool_call_count !== undefined
  const response_metrics = has_response_metrics
    ? `${optional_metric(debug.response_bytes)} bytes · ${optional_metric(debug.tool_call_count)} tool calls`
    : '—'
  const has_content_shape = debug.content_utf8_bytes !== undefined
    || debug.content_non_ascii_chars !== undefined
    || debug.content_replacement_chars !== undefined
    || debug.normalized_content_chars !== undefined
  const content_shape = has_content_shape
    ? `utf8 ${optional_metric(debug.content_utf8_bytes)} bytes · non-ascii ${optional_metric(debug.content_non_ascii_chars)} · replacement ${optional_metric(debug.content_replacement_chars)} · normalized ${optional_metric(debug.normalized_content_chars)} chars`
    : '—'
  const structured = debug.structured_content
  const structured_content = structured === undefined
    ? '—'
    : `json ${validity(structured.json_valid)} · plan ${validity(structured.plan_valid)}`
  const structured_error = clean_text(structured?.error, 300)
  const tokens = integer(debug.total_units) > 0 ? `${integer(debug.input_units)} in / ${integer(debug.cached_input_units)} cached / ${integer(debug.output_units)} out / ${integer(debug.total_units)} total` : '—'
  const latest_round_tokens = integer(debug.latest_round_total_units) > 0
    ? `round ${integer(debug.latest_round_provider_round) + 1} · ${integer(debug.latest_round_input_units)} in / ${integer(debug.latest_round_cached_input_units)} cached / ${integer(debug.latest_round_output_units)} out / ${integer(debug.latest_round_total_units)} total`
    : '—'
  const actor = integer(debug.actor_id) > 0 ? `${runtime?.actor_name ?? 'AIRI'} · id ${integer(debug.actor_id)} · epoch ${integer(debug.actor_epoch)}` : `${runtime?.actor_name ?? 'AIRI'} · ${runtime?.actor_kind ?? 'unknown'}`
  const world_text = world === undefined ? 'unknown' : `${clean_text(world.task_state, 48) || 'idle'} · queue ${integer(world.queue_length)}`
  const follow_text = follow?.active ? `active · ${clean_text(follow.target_player, 128) || 'target'}${typeof follow.current_distance === 'number' ? ` · ${math.floor(follow.current_distance * 10) / 10} tiles` : ''}` : 'inactive'
  const reply = latest_ai_reply(board)

  const overview = body.add({ type: 'table', column_count: 2 }); overview.style.width = DEBUG_BODY_INNER_WIDTH; overview.style.horizontal_spacing = 12; overview.style.vertical_spacing = 5
  add_row(overview, 'AI phase', detail.length > 0 ? `${phase} · ${detail}` : phase)
  add_row(overview, 'Goal', board?.status ? `${String(board.status).toUpperCase()} · ${clean_text(board.objective, 300) || clean_text(board.goal_id, 120)}` : 'none')
  add_row(overview, 'AI reply', reply || '—')
  add_row(overview, 'Plan step', step)
  add_row(overview, 'Request', clean_text(debug.request_id, 120) || '—')
  add_row(overview, 'Turn', integer(debug.turn) > 0 ? `${integer(debug.turn)}` : '—')

  const columns = body.add({ type: 'flow', name: DEBUG_SYNC.columns, direction: 'horizontal' }); columns.style.width = DEBUG_BODY_INNER_WIDTH; columns.style.horizontal_spacing = DEBUG_COLUMN_GAP; columns.style.vertical_align = 'top'
  const provider_column = columns.add({ type: 'flow', direction: 'vertical' }); provider_column.style.width = DEBUG_COLUMN_WIDTH; provider_column.style.vertical_spacing = 4
  provider_column.add({ type: 'label', caption: 'LLM / Provider', style: 'semibold_label' })
  const provider_table = provider_column.add({ type: 'table', column_count: 2 }); provider_table.style.width = DEBUG_COLUMN_WIDTH; provider_table.style.horizontal_spacing = 12; provider_table.style.vertical_spacing = 5
  add_compact_row(provider_table, 'Provider', provider.length > 0 ? `${provider} · round ${integer(debug.provider_round) + 1}` : '—')
  add_compact_row(provider_table, 'Provider profile', clean_text(debug.provider_capability_profile, 40) || '—')
  add_compact_row(provider_table, 'Wire output cap', clean_text(debug.requested_token_field, 40).length > 0 ? `${clean_text(debug.requested_token_field, 40)}=${integer(debug.requested_output_cap)}` : '—')
  add_compact_row(provider_table, 'Reasoning effort · latest round', clean_text(debug.reasoning_effort, 32) || '—')
  add_compact_row(provider_table, 'Policy reason · latest round', clean_text(debug.reasoning_policy_reason, 80) || '—')
  add_compact_row(provider_table, 'Latency', latency > 0 ? `${latency} ms` : '—')
  const think_rounds = integer(debug.think_rounds)
  const think_total_ms = integer(debug.think_total_ms)
  const think_slowest_ms = integer(debug.think_slowest_round_ms)
  const think_slowest_effort = clean_text(debug.think_slowest_round_effort, 32)
  add_compact_row(provider_table, 'Think time · this request', think_rounds > 0
    ? `${think_rounds} round${think_rounds === 1 ? '' : 's'} · ${math.floor(think_total_ms / 100) / 10}s total · slowest ${math.floor(think_slowest_ms / 100) / 10}s${think_slowest_effort.length > 0 ? ` (${think_slowest_effort})` : ''}`
    : '—')
  add_compact_row(provider_table, 'Tokens · request cumulative', tokens)
  add_compact_row(provider_table, 'Latest completed round', latest_round_tokens)
  const decision_column = columns.add({ type: 'flow', direction: 'vertical' }); decision_column.style.width = DEBUG_COLUMN_WIDTH; decision_column.style.vertical_spacing = 4
  decision_column.add({ type: 'label', caption: 'Jev / Planning', style: 'semibold_label' })
  const decision_table = decision_column.add({ type: 'table', column_count: 2 }); decision_table.style.width = DEBUG_COLUMN_WIDTH; decision_table.style.horizontal_spacing = 12; decision_table.style.vertical_spacing = 5
  add_debug_decision_rows(decision_table, debug)

  const runtime_column = columns.add({ type: 'flow', name: DEBUG_SYNC.runtime_column, direction: 'vertical' }); runtime_column.style.width = DEBUG_COLUMN_WIDTH; runtime_column.style.vertical_spacing = 4
  runtime_column.add({ type: 'label', caption: 'Step / Runtime', style: 'semibold_label' })
  const runtime_table = runtime_column.add({ type: 'table', name: DEBUG_SYNC.runtime_table, column_count: 2 }); runtime_table.style.width = DEBUG_COLUMN_WIDTH; runtime_table.style.horizontal_spacing = 12; runtime_table.style.vertical_spacing = 5
  add_debug_step_rows(runtime_table, debug)
  add_compact_row(runtime_table, 'Provider diag', clean_text(debug.provider_diagnostic_code, 160) || '—')
  add_compact_row(runtime_table, 'Finish', clean_text(debug.provider_finish_reason, 80) || '—')
  add_compact_row(runtime_table, 'Response id', response_id || '—')
  add_compact_row(runtime_table, 'Response bytes · tools', response_metrics)
  add_compact_row(runtime_table, 'Content chars', `${integer(debug.content_chars)}`)
  add_compact_row(runtime_table, 'Content shape', content_shape)
  add_compact_row(runtime_table, 'Structured content', structured_content)
  add_compact_row(runtime_table, 'Structured error', structured_error || '—')
  add_compact_row(runtime_table, 'Reasoning chars', `${integer(debug.reasoning_content_chars)}`)
  add_compact_row(runtime_table, 'Reasoning tokens', integer(debug.reported_reasoning_tokens) > 0 ? `${integer(debug.reported_reasoning_tokens)}` : 'unknown')
  add_compact_row(runtime_table, 'Requested reasoning', `${clean_text(debug.requested_reasoning_effort, 32) || 'not sent'} · thinking ${clean_text(debug.requested_thinking_mode, 32) || 'not sent'}`)
  add_compact_row(runtime_table, 'Usage integrity', `${integer(debug.usage_complete) === 1 ? 'complete' : 'incomplete'}${integer(debug.cap_enforcement_anomaly) === 1 ? ' · CAP ANOMALY' : ''}`)
  add_compact_row(runtime_table, 'Last tool', clean_text(debug.last_tool, 120) || '—')
  add_compact_row(runtime_table, 'Last event', clean_text(debug.last_event, 120) || '—')
  add_compact_row(runtime_table, 'Recovery', integer(debug.recovery_attempt) > 0 ? `attempt ${integer(debug.recovery_attempt)} · ${clean_text(debug.recovery_result, 64) || 'in progress'}` : (clean_text(debug.recovery_result, 64) || 'none'))
  add_compact_row(runtime_table, 'Actor', actor)
  add_compact_row(runtime_table, 'World task', world_text)
  add_compact_row(runtime_table, 'Follow', follow_text)
  const sync_key = runtime_table.add({ type: 'label', caption: 'UI sync', style: 'semibold_label' }); sync_key.style.minimal_width = DEBUG_KEY_WIDTH
  const sync_value = runtime_table.add({ type: 'label', name: DEBUG_SYNC.value, caption: sync_caption(synced_tick) }); sync_value.style.single_line = false; sync_value.style.maximal_width = DEBUG_COLUMN_VALUE_WIDTH

  const decision_error = clean_text(debug.decision_error, 300)
  const last_error = clean_text(debug.last_error, 500)
  if (decision_error.length > 0 || last_error.length > 0) {
    const errors = body.add({ type: 'table', column_count: 2 }); errors.style.width = DEBUG_BODY_INNER_WIDTH; errors.style.horizontal_spacing = 12; errors.style.vertical_spacing = 5
    if (decision_error.length > 0) add_row(errors, 'Decision error', decision_error)
    if (last_error.length > 0) add_row(errors, 'Last error', last_error)
  }
}

function build_debug_activity(root: LuaGuiElement) {
  const section = root.add({ type: 'flow', name: DEBUG_ACTIVITY.section, direction: 'vertical' })
  section.style.width = DEBUG_WIDTH
  section.style.padding = 10
  section.style.vertical_spacing = 4
  const header = section.add({ type: 'flow', name: DEBUG_ACTIVITY.header, direction: 'horizontal' })
  header.style.horizontally_stretchable = true
  header.style.vertical_align = 'center'
  header.add({ type: 'label', caption: 'Execution Activity', style: 'semibold_label' })
  const filler = header.add({ type: 'empty-widget' }); filler.style.horizontally_stretchable = true
  activity_state.style_feed_button(header.add({ type: 'button', name: DEBUG_ACTIVITY_STATE_NAME, caption: '' }), activity_state.FEED_STATE_BUTTON_WIDTH)
  const count = header.add({ type: 'label', name: DEBUG_ACTIVITY.count, caption: '0 events', style: 'semibold_label' }); count.style.left_padding = 6
  const empty = section.add({ type: 'label', name: DEBUG_ACTIVITY.empty, caption: 'No retained execution activity.' }); empty.style.font_color = { r: 0.68, g: 0.68, b: 0.68 }
  const scroll = section.add({ type: 'scroll-pane', name: DEBUG_ACTIVITY_SCROLL_NAME, horizontal_scroll_policy: 'never', vertical_scroll_policy: 'auto-and-reserve-space' })
  scroll.style.width = DEBUG_WIDTH - 20
  scroll.style.maximal_height = 280
  const feed = scroll.add({ type: 'flow', name: DEBUG_ACTIVITY.feed, direction: 'vertical', ignored_by_interaction: true, tags: { keys: [] } })
  feed.style.horizontally_stretchable = true
  feed.style.vertical_spacing = 3
}

function refresh_debug_activity(root: LuaGuiElement, player: LuaPlayer, force = false) {
  const section = root[DEBUG_ACTIVITY.section]
  const header = section?.valid ? section[DEBUG_ACTIVITY.header] : undefined
  const empty = section?.valid ? section[DEBUG_ACTIVITY.empty] : undefined
  const scroll = section?.valid ? section[DEBUG_ACTIVITY_SCROLL_NAME] : undefined
  const feed = scroll?.valid ? scroll[DEBUG_ACTIVITY.feed] : undefined
  if (!section?.valid || !header?.valid || !empty?.valid || !scroll?.valid || !feed?.valid) return false

  const activity = activity_state.activity_history()
  const start = math.max(0, activity.length - DEBUG_ACTIVITY_ROWS)
  const entries = activity.slice(start)
  const keys = entries.map(entry => activity_state.activity_key(entry))
  const shown = (feed.tags.keys ?? []) as string[]
  const view = debug_activity_view(player.index)
  const previous_last = shown.length > 0 ? shown[shown.length - 1] : undefined
  if (view.seen_key === undefined && previous_last !== undefined) view.seen_key = previous_last

  const add_entry = (entry: any) => {
    const timestamp = clean_text(entry.timestamp, 16) || '--:--:--'
    const kind = clean_text(entry.kind, 32).toUpperCase()
    const line = gui_text.literal_gui_text(feed.add({ type: 'label', caption: `${timestamp} · ${kind} · ${clean_text(entry.text, 1200)}`, ignored_by_interaction: true }))
    line.style.single_line = false
    line.style.maximal_width = DEBUG_WIDTH - 50
  }

  let appended = 0
  if (force || view.follow) {
    const diff = activity_state.activity_rows_diff(shown, keys)
    if (diff === undefined || force) {
      feed.clear()
      for (const entry of entries) add_entry(entry)
      appended = entries.length
    }
    else {
      const children = feed.children
      for (let index = 0; index < diff.drop && index < children.length; index++) children[index].destroy()
      for (let index = entries.length - diff.append; index < entries.length; index++) add_entry(entries[index])
      appended = diff.append
    }
    feed.tags = { keys }
    const last_key = keys.length > 0 ? keys[keys.length - 1] : undefined
    if (force || appended > 0 || previous_last !== last_key) (scroll as ScrollPaneGuiElement).scroll_to_bottom()
    view.seen_key = last_key
    view.behind = false
  }
  else {
    const unseen = activity_state.activity_unseen(keys, view.seen_key)
    view.behind = unseen.count > 0 || unseen.overflow
  }

  empty.visible = activity.length === 0
  scroll.visible = activity.length > 0
  const count = header[DEBUG_ACTIVITY.count]
  if (count?.valid) count.caption = `${activity.length} event${activity.length === 1 ? '' : 's'}`
  const unseen = activity_state.activity_unseen(keys, view.seen_key)
  const state = header[DEBUG_ACTIVITY_STATE_NAME]
  if (state?.valid) {
    if (view.follow && unseen.count === 0) {
      state.caption = gui_text.trusted_rich_text('[img=utility/status_working] LIVE')
      state.tooltip = 'Following the newest execution activity. Click to pause it.'
    }
    else if (unseen.count > 0) {
      state.caption = gui_text.trusted_rich_text(`[img=utility/status_yellow] ${unseen.count}${unseen.overflow ? '+' : ''} NEW`)
      state.tooltip = 'New execution activity arrived without moving your reading position. Click to catch up and resume live follow.'
    }
    else {
      state.caption = gui_text.trusted_rich_text('[img=utility/status_inactive] PAUSED')
      state.tooltip = 'Execution activity is paused at your reading position. Click to jump to the newest event and follow again.'
    }
  }
  return true
}


function build_debug_popout(player: LuaPlayer, board: any, runtime: any, synced_tick: number | undefined) {
  const previous_location = destroy_debug_popout(player)
  const root = player.gui.screen.add({ type: 'frame', name: DEBUG_ROOT_NAME, direction: 'vertical' }) as FrameGuiElement
  if (previous_location !== undefined) root.location = previous_location
  else root.auto_center = true
  const titlebar = root.add({ type: 'flow', direction: 'horizontal' }); titlebar.style.horizontally_stretchable = true; titlebar.style.horizontal_spacing = 8; titlebar.drag_target = root
  titlebar.add({ type: 'label', caption: 'SGLuna Debug', style: 'frame_title', ignored_by_interaction: true })
  const dragger = titlebar.add({ type: 'empty-widget', style: 'draggable_space_header', ignored_by_interaction: true }); dragger.style.horizontally_stretchable = true; dragger.style.height = 24
  // Reuse the ordinary DEBUG button route so the sixth control route remains
  // available to Projects without adding another Task Board click handler.
  titlebar.add({ type: 'sprite-button', name: DEBUG_BUTTON_NAME, sprite: 'utility/close', style: 'frame_action_button', tooltip: 'Close SGLuna Debug' })
  const body = root.add({ type: 'flow', name: DEBUG_BODY_NAME, direction: 'vertical' }); body.style.width = DEBUG_WIDTH; body.style.padding = 10; body.style.vertical_spacing = 8
  fill_debug_body(body, board, runtime, synced_tick)
  build_debug_activity(root)
  refresh_debug_activity(root, player, true)
  root.bring_to_front()
}

export function render_debug_popout(player: LuaPlayer, console_open: boolean, board: any, runtime: any, synced_tick: number | undefined) {
  if (!console_open) {
    close_debug_ui(player.index)
    destroy_debug_popout(player)
    return
  }

  if (!debug_ui_is_open(player.index)) { destroy_debug_popout(player); return }
  const root = player.gui.screen[DEBUG_ROOT_NAME]
  const body = root?.valid ? root[DEBUG_BODY_NAME] : undefined
  if (body?.valid && root?.valid) {
    fill_debug_body(body, board, runtime, synced_tick)
    if (!refresh_debug_activity(root, player)) {
      build_debug_activity(root)
      refresh_debug_activity(root, player, true)
    }
    return
  }
  build_debug_popout(player, board, runtime, synced_tick)
}
