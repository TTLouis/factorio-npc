import type { MapPositionStruct } from 'factorio:prototype'
import type { ButtonGuiElement, CameraGuiElement, FrameGuiElement, LuaEntity, LuaGuiElement, LuaInventory, LuaPlayer, LuaSurface, ProgressBarGuiElement, ScrollPaneGuiElement, SpriteButtonGuiElement, SpritePath, TextFieldGuiElement } from 'factorio:runtime'

import * as ui_constants from './task_board_ui_constants'
import * as console_ui from './task_board_console'
import { peek_controlled_actor } from './actors/actor_controller'
import { create_learning_remote_interface, handle_learning_ui_click, handle_task_board_learning_transition } from './learning_pipeline'
import { create_skill_remote_interface, handle_skill_export_click } from './skills'
import * as skills_ui from './skills_window'
// Namespace import on purpose: one Lua local instead of one per helper.
import * as activity_state from './task_board_activity'
import * as gui_text from './task_board_gui_text'
import * as debug_ui from './task_board_debug'
import { render_debug_popout as render_task_board_debug_popout } from './task_board_debug_render'
import * as project_ui from './projects/project_window'
import * as provider_ui from './task_board_provider'
import { get_actor_inventory_items } from './utils/inventory'



type TaskBoardUiControlAction = 'pause' | 'terminate' | 'follow' | 'stop_follow' | 'new_task' | 'keep_paused' | 'revise' | 'cancel'
type TaskBoardUiLifecycleAction = 'pause' | 'resume' | 'terminate'
type TaskBoardUiActivityKind = 'observation' | 'decision' | 'action' | 'result' | 'blocker' | 'system' | 'note'
type TaskBoardUiAgentPhase = 'idle' | 'thinking' | 'observing' | 'executing' | 'waiting' | 'error'
type Tone = ui_constants.Tone
type TaskBoardUiItem = { name: string, count: number }

const TONE_COLORS = ui_constants.TONE_COLORS
const TONE_SPRITES = ui_constants.TONE_SPRITES

export interface TaskBoardUiStep {
  id: string
  description: string
  status: 'pending' | 'active' | 'completed' | 'blocked' | 'paused'
  /**
   * Completion contracts are best-effort, so a prose-only step is legal. Both
   * fields are optional and absent-tolerant: the runtime does not emit them
   * until the immutable-plan writer is wired, and a step without them renders
   * exactly as it always did.
   */
  contract_kind?: 'grounded' | 'prose'
  reduced_confidence?: boolean
}
export interface TaskBoardUiActivity { id?: string, kind: TaskBoardUiActivityKind, text: string, timestamp?: string }
export interface TaskBoardUiWantedItem { name: string, count: number, reason: string }
export type TaskBoardUiShelfStatus = 'tentative' | 'ready_to_refine' | 'partially_realized' | 'realized' | 'invalidated'
export interface TaskBoardUiShelfNode {
  id: string
  intent: string
  why_it_matters: string
  status: TaskBoardUiShelfStatus
  depends_on: string[]
  development_hint?: string
  linked: boolean
}
export interface TaskBoardUiConversationMessage { id: string, role: 'user' | 'assistant', sender: string, text: string }
export interface TaskBoardUiAgentStatus { phase: TaskBoardUiAgentPhase, detail: string }
/**
 * Which deterministic harness signal tripped the freeze. These are measured,
 * not categorized by a model: evidence stall over N batches, the same failure
 * reason code K times, or a committed contract proven unsatisfiable.
 */
export type TaskBoardUiDeadlockSignal = 'evidence_stall' | 'repeated_failure' | 'unsatisfiable_contract'
export type TaskBoardUiBlockedChoice = 'keep_paused' | 'revise' | 'cancel'
export interface TaskBoardUiDeadlockEvidence { signal: TaskBoardUiDeadlockSignal, count: number, detail?: string }
/**
 * A first-class structural blocker, distinct from an ordinary pause. `blocked`
 * carries the verified reason plus, when the freeze came from harness deadlock
 * detection, which signal tripped and how many times.
 */
export interface TaskBoardUiBlocked {
  reason: string
  summary?: string
  deadlock?: TaskBoardUiDeadlockEvidence
  awaiting_choice: boolean
  choice?: TaskBoardUiBlockedChoice
}
/** Identity and lineage of the one immutable plan the tracker is a view of. */
export interface TaskBoardUiPlanIdentity {
  plan_id: string
  plan_version: number
  roadmap_node_id?: string
  derived_from?: string
  superseded_by?: string
}
/**
 * The goal's done-when checks as the runtime last read them from the game.
 * `read` is false when that read failed; `defined` is false before the planner
 * has defined the goal.
 */
export interface TaskBoardUiGoalCheck { text: string, met: boolean, progress: string }
export interface TaskBoardUiGoal { summary: string, defined: boolean, read: boolean, met: number, total: number, checks: TaskBoardUiGoalCheck[] }
export interface TaskBoardUiSnapshot {
  goal?: TaskBoardUiGoal
  goal_id: string
  objective: string
  plan?: TaskBoardUiPlanIdentity
  blocked?: TaskBoardUiBlocked
  steering?: string
  response: string
  status: 'idle' | 'active' | 'blocked' | 'paused' | 'completed'
  blocker: string
  blocker_summary?: string
  pause_reason: string
  pause_summary?: string
  completed_count: number
  total_steps: number
  active_index: number
  steps: TaskBoardUiStep[]
  activity: TaskBoardUiActivity[]
  wanted_items: TaskBoardUiWantedItem[]
  shelf?: TaskBoardUiShelfNode[]
  conversation_id: string
  conversation: TaskBoardUiConversationMessage[]
  agent: TaskBoardUiAgentStatus
  debug?: debug_ui.TaskBoardUiDebugSnapshot
}

interface TaskBoardUiFollowStatus { active: boolean, state: string, target_player: string, current_distance?: number, desired_distance?: number, last_failure: string }
interface TaskBoardUiLifecyclePending { action: TaskBoardUiLifecycleAction, goal_id: string, started_tick?: number }
interface TaskBoardUiControlInput { kind: 'control', version: 1, action: TaskBoardUiControlAction, player_index: number, player_name: string, tick: number }
interface TaskBoardUiPromptInput { kind: 'prompt', version: 1, player_index: number, player_name: string, text: string, tick: number }
interface TaskBoardUiPollInput { kind: 'poll', version: 1, tick: number, debug: boolean }
type TaskBoardUiInput = TaskBoardUiControlInput | TaskBoardUiPromptInput
// Polls are produced while draining, never queued, so enqueue stays typed to
// the player-originated inputs only.
type TaskBoardUiDrainedInput = TaskBoardUiInput | TaskBoardUiPollInput
interface TaskBoardUiWorldPreview { position: MapPositionStruct, surface_index: LuaSurface['index'], entity?: LuaEntity }
interface TaskBoardUiWorldTask { task_state: string, queue_length: number }
interface TaskBoardUiRuntimeSnapshot {
  actor_name: string
  actor_kind: string
  inventory: TaskBoardUiItem[]
  guns: TaskBoardUiItem[]
  ammo: TaskBoardUiItem[]
  follow?: TaskBoardUiFollowStatus
  preview?: TaskBoardUiWorldPreview
  world_task?: TaskBoardUiWorldTask
}

declare const storage: {
  airi_task_board_ui?: TaskBoardUiSnapshot
  airi_task_board_ui_synced_tick?: number
  airi_task_board_ui_open?: Record<number, boolean>
  airi_task_board_skills_open?: Record<number, boolean>
  airi_task_board_terminate_confirm_until?: Record<number, number>
  airi_task_board_prompt_draft?: Record<number, string>
  // Tick a prompt was submitted at, keyed by player. Not goal/status-keyed like
  // LIFECYCLE - see task_board_ui_prompt_send_pending.
  airi_task_board_prompt_pending?: Record<number, number>
  // A blocked plan deliberately has no automatic state transition. This is a
  // visual debounce only; it never changes the durable blocked plan.
  airi_task_board_blocked_choice_pending?: Record<number, number>
  airi_task_board_ui_inputs?: TaskBoardUiInput[]
  airi_task_board_preview_zoom?: Record<number, number>
  airi_task_board_lifecycle_pending?: Record<number, TaskBoardUiLifecyclePending>
  // Whether a player has the … menu (NEW TASK, TERMINATE) open. Written only
  // by the click handler.
  airi_task_board_more_open?: Record<number, boolean>
  airi_task_board_tab?: Record<number, ui_constants.ConsoleTab>
}

let world_task_provider: ((this: void) => unknown) | undefined
export function set_task_board_world_task_provider(provider: (this: void) => unknown) { world_task_provider = provider }

function text(value: unknown, max = ui_constants.MAX_TEXT) {
  let clean = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (clean.includes('  ')) clean = clean.split('  ').join(' ')
  return clean.length <= max ? clean : `${clean.slice(0, math.max(0, max - 1))}…`
}
function task_condition_text(summary: unknown, raw: string, fallback: string) { const clean = text(summary, 500); return clean.length > 0 ? clean : raw.length > 0 ? fallback : '' }
function integer(value: unknown, fallback = 0) { return typeof value === 'number' && value === math.floor(value) && value >= 0 ? value : fallback }
function positive_integer(value: unknown, fallback = 1) { return math.max(1, integer(value, fallback)) }
function status(value: unknown): TaskBoardUiSnapshot['status'] { return value === 'idle' || value === 'blocked' || value === 'paused' || value === 'completed' ? value : 'active' }
function step_status(value: unknown): TaskBoardUiStep['status'] { return value === 'active' || value === 'completed' || value === 'blocked' || value === 'paused' ? value : 'pending' }
function activity_kind(value: unknown): TaskBoardUiActivityKind { return value === 'observation' || value === 'decision' || value === 'action' || value === 'result' || value === 'blocker' || value === 'system' ? value : 'note' }
function agent_phase(value: unknown): TaskBoardUiAgentPhase { return value === 'thinking' || value === 'observing' || value === 'executing' || value === 'waiting' || value === 'error' ? value : 'idle' }

function deadlock_signal(value: unknown): TaskBoardUiDeadlockSignal | undefined { return value === 'evidence_stall' || value === 'repeated_failure' || value === 'unsatisfiable_contract' ? value : undefined }
function blocked_choice(value: unknown): TaskBoardUiBlockedChoice | undefined { return value === 'keep_paused' || value === 'revise' || value === 'cancel' ? value : undefined }
function contract_kind(value: unknown): TaskBoardUiStep['contract_kind'] { return value === 'grounded' || value === 'prose' ? value : undefined }

function sanitize_deadlock_evidence(value: any): TaskBoardUiDeadlockEvidence | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const signal = deadlock_signal(value.signal)
  if (signal === undefined) return undefined
  const evidence: TaskBoardUiDeadlockEvidence = { signal, count: integer(value.count) }
  const detail = text(value.detail, 200)
  if (detail.length > 0) evidence.detail = detail
  return evidence
}

/**
 * The runtime side of the immutable-plan refactor is being wired separately, so
 * every field here is optional in both directions: a snapshot with no `blocked`
 * object, or with a partially filled one, must sanitize without throwing and
 * must not invent a blocker that was never reported.
 */
function sanitize_blocked(value: any): TaskBoardUiBlocked | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const reason = text(value.reason, 500)
  const summary = text(value.summary, 500)
  const deadlock = sanitize_deadlock_evidence(value.deadlock)
  const awaiting_choice = value.awaiting_choice === true
  const choice = blocked_choice(value.choice)
  if (reason.length === 0 && summary.length === 0 && deadlock === undefined && !awaiting_choice && choice === undefined) return undefined
  const blocked: TaskBoardUiBlocked = { reason, awaiting_choice }
  if (summary.length > 0) blocked.summary = summary
  if (deadlock !== undefined) blocked.deadlock = deadlock
  if (choice !== undefined) blocked.choice = choice
  return blocked
}

function sanitize_goal(value: any): TaskBoardUiGoal | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const summary = text(value.summary, 400)
  if (summary.length === 0) return undefined
  // Plain Lua table at runtime: index it rather than calling Array methods.
  const raw_checks = (Array.isArray(value.checks) ? value.checks : []) as any[]
  const checks: TaskBoardUiGoalCheck[] = []
  for (let index = 0; index < raw_checks.length && index < ui_constants.MAX_GOAL_CHECKS; index++) {
    const check = raw_checks[index]
    const check_text = text(check?.text, 160)
    if (check_text.length > 0) checks.push({ text: check_text, met: check?.met === true, progress: text(check?.progress, 80) })
  }
  let met = 0
  for (const check of checks) if (check.met) met++
  return { summary, defined: value.defined === true && checks.length > 0, read: value.read === true, met, total: checks.length, checks }
}
function sanitize_plan_identity(value: any): TaskBoardUiPlanIdentity | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const plan_id = text(value.plan_id, 100)
  if (plan_id.length === 0) return undefined
  const plan: TaskBoardUiPlanIdentity = { plan_id, plan_version: positive_integer(value.plan_version, 1) }
  const roadmap_node_id = text(value.roadmap_node_id, 100)
  const derived_from = text(value.derived_from, 100)
  const superseded_by = text(value.superseded_by, 100)
  if (roadmap_node_id.length > 0) plan.roadmap_node_id = roadmap_node_id
  if (derived_from.length > 0) plan.derived_from = derived_from
  if (superseded_by.length > 0) plan.superseded_by = superseded_by
  return plan
}

export function sanitize_task_board_ui_snapshot(value: any): TaskBoardUiSnapshot | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || !Array.isArray(value.steps)) return undefined

  // Snapshot values arrive through helpers.json_to_table(), so these arrays are
  // plain Lua tables at runtime. Calling JS Array methods directly on `any`
  // makes TSTL emit `table:slice(...)`, which plain Lua tables do not have.
  // Iterate the dynamic boundary explicitly, then return normal typed arrays.
  const raw_steps = value.steps as any[]
  const steps: TaskBoardUiStep[] = []
  const step_count = math.min(raw_steps.length, 30)
  for (let index = 0; index < step_count; index++) {
    const step = raw_steps[index]
    const description = text(step?.description, ui_constants.MAX_TEXT)
    if (description.length === 0) continue
    const next_step: TaskBoardUiStep = { id: text(step?.id || `step_${index + 1}`, 80), description, status: step_status(step?.status) }
    const kind = contract_kind(step?.contract_kind)
    if (kind !== undefined) next_step.contract_kind = kind
    if (step?.reduced_confidence === true) next_step.reduced_confidence = true
    steps.push(next_step)
  }

  const raw_activity = (Array.isArray(value.activity) ? value.activity : []) as any[]
  const activity: TaskBoardUiActivity[] = []
  const activity_start = math.max(0, raw_activity.length - ui_constants.MAX_ACTIVITY)
  for (let index = activity_start; index < raw_activity.length; index++) {
    const entry = raw_activity[index]
    const entry_text = text(entry?.text, 1000)
    if (entry_text.length === 0) continue
    const id = text(entry?.id, 120)
    const timestamp = text(entry?.timestamp, 16)
    const next: TaskBoardUiActivity = { kind: activity_kind(entry?.kind), text: entry_text }
    if (id.length > 0) next.id = id
    if (timestamp.length > 0) next.timestamp = timestamp
    activity.push(next)
  }

  const raw_wanted_items = (Array.isArray(value.wanted_items) ? value.wanted_items : []) as any[]
  const wanted_items: TaskBoardUiWantedItem[] = []
  const wanted_count = math.min(raw_wanted_items.length, ui_constants.MAX_WANTED_ITEMS)
  for (let index = 0; index < wanted_count; index++) {
    const item = raw_wanted_items[index]
    const name = text(item?.name, 200)
    if (name.length === 0) continue
    wanted_items.push({ name, count: positive_integer(item?.count, 1), reason: text(item?.reason, 300) })
  }

  const raw_shelf = (Array.isArray(value.shelf) ? value.shelf : []) as any[]
  const shelf: TaskBoardUiShelfNode[] = []
  const shelf_count = math.min(raw_shelf.length, ui_constants.MAX_SHELF_NODES)
  for (let index = 0; index < shelf_count; index++) {
    const node = raw_shelf[index]
    const id = text(node?.id, 100)
    const intent = text(node?.intent, 300)
    if (id.length === 0 || intent.length === 0) continue
    const raw_status = node?.status
    const shelf_status: TaskBoardUiShelfStatus = raw_status === 'ready_to_refine' || raw_status === 'partially_realized' || raw_status === 'realized' || raw_status === 'invalidated' ? raw_status : 'tentative'
    const raw_dependencies = (Array.isArray(node?.depends_on) ? node.depends_on : []) as any[]
    const depends_on: string[] = []
    for (let dep_index = 0; dep_index < raw_dependencies.length && dep_index < 4; dep_index++) {
      const dependency = text(raw_dependencies[dep_index], 100)
      if (dependency.length > 0) depends_on.push(dependency)
    }
    const development_hint = text(node?.development_hint, 32)
    shelf.push({
      id,
      intent,
      why_it_matters: text(node?.why_it_matters, 240),
      status: shelf_status,
      depends_on,
      ...(development_hint.length > 0 ? { development_hint } : {}),
      linked: node?.linked === true,
    })
  }

  const raw_conversation = (Array.isArray(value.conversation) ? value.conversation : []) as any[]
  const conversation: TaskBoardUiConversationMessage[] = []
  for (let index = 0; index < raw_conversation.length && index < 96; index++) {
    const entry = raw_conversation[index]
    const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : undefined
    const line = text(entry?.text, 2000)
    if (role === undefined || line.length === 0) continue
    conversation.push({
      id: text(entry?.id || `message_${index + 1}`, 120),
      role,
      sender: text(entry?.sender || (role === 'assistant' ? 'AIRI' : 'Player'), 128),
      text: line,
    })
  }

  const total = integer(value.total_steps, steps.length)
  const goal = sanitize_goal(value.goal)
  const plan = sanitize_plan_identity(value.plan)
  const blocked = sanitize_blocked(value.blocked)
  const steering = text(value.steering, 32)
  const agent = value.agent !== null && typeof value.agent === 'object' ? value.agent : undefined
  const debug = value.debug !== undefined ? debug_ui.sanitize_debug_snapshot(value.debug) : undefined
  return {
    goal, goal_id: text(value.goal_id, 100), objective: text(value.objective, 500), plan, blocked, steering: steering.length > 0 ? steering : undefined, response: text(value.response, 2000), status: status(value.status), blocker: text(value.blocker, 500), blocker_summary: text(value.blocker_summary, 500), pause_reason: text(value.pause_reason, 300), pause_summary: text(value.pause_summary, 500),
    completed_count: math.min(integer(value.completed_count), total), total_steps: total, active_index: math.min(integer(value.active_index), math.max(0, total - 1)), steps, activity, wanted_items, shelf,
    conversation_id: text(value.conversation_id, 120), conversation,
    agent: { phase: agent_phase(agent?.phase), detail: text(agent?.detail, 300) }, debug,
  }
}

function two_digits(value: number) { return value < 10 ? `0${value}` : `${value}` }
export function task_board_game_time(tick: number) {
  const total_seconds = math.floor(math.max(0, tick) / 60)
  const hours = math.floor(total_seconds / 3600)
  const minutes = math.floor((total_seconds % 3600) / 60)
  const seconds = total_seconds % 60
  return `${two_digits(hours)}:${two_digits(minutes)}:${two_digits(seconds)}`
}
export function stamp_activity_times(next: TaskBoardUiSnapshot, previous: TaskBoardUiSnapshot | undefined, tick: number) {
  const previous_activity = previous?.activity ?? []
  const used: boolean[] = []
  const claimed: Record<string, boolean> = {}
  const now = task_board_game_time(tick)
  return { ...next, activity: next.activity.map(entry => {
    if (entry.timestamp !== undefined && entry.timestamp.length > 0) return entry
    if (entry.id !== undefined && entry.id.length > 0) {
      for (let index = 0; index < previous_activity.length; index++) {
        const old = previous_activity[index]
        if (old.id !== entry.id || !old.timestamp) continue
        return { ...entry, timestamp: old.timestamp }
      }
      return { ...entry, timestamp: now }
    }
    let timestamp: string | undefined
    for (let index = 0; index < previous_activity.length; index++) {
      const old = previous_activity[index]
      if ((old.id !== undefined && old.id.length > 0) || used[index] === true || old.kind !== entry.kind || old.text !== entry.text || !old.timestamp) continue
      used[index] = true
      timestamp = old.timestamp
      break
    }
    timestamp = timestamp ?? activity_state.retained_activity_timestamp(entry.kind, entry.text, claimed) ?? now
    const stamped = { ...entry, timestamp }
    claimed[activity_state.activity_key(stamped)] = true
    return stamped
  }) }
}

function ensure_open_state() { if (storage.airi_task_board_ui_open === undefined) storage.airi_task_board_ui_open = {}; return storage.airi_task_board_ui_open }
export function task_board_lifecycle_pending_expired(started_tick: number | undefined, tick: number) {
  // Missing timestamps are legacy persisted pending records from before the
  // timeout existed. Treat them as expired so upgrading an old save repairs the
  // stuck controls on the first render/click instead of preserving the lock.
  if (started_tick === undefined) return true
  return math.max(0, tick - started_tick) >= ui_constants.LIFECYCLE_PENDING_TICKS
}
const LIFECYCLE = {
  ensure: () => { if (storage.airi_task_board_lifecycle_pending === undefined) storage.airi_task_board_lifecycle_pending = {}; return storage.airi_task_board_lifecycle_pending },
  current: (player_index: number) => {
    const pending = storage.airi_task_board_lifecycle_pending?.[player_index]
    if (pending === undefined) return undefined
    const board = storage.airi_task_board_ui
    const goal_changed = pending.goal_id.length > 0 && board?.goal_id !== pending.goal_id
    const expired = task_board_lifecycle_pending_expired(pending.started_tick, game.tick)
    const done = expired || goal_changed
      || (pending.action === 'pause' && board?.status === 'paused')
      || (pending.action === 'resume' && board !== undefined && board.status !== 'paused')
      || (pending.action === 'terminate' && board === undefined)
    if (!done) return pending
    delete LIFECYCLE.ensure()[player_index]
    return undefined
  },
  begin: (player_index: number, action: TaskBoardUiLifecycleAction) => {
    if (LIFECYCLE.current(player_index) !== undefined) return false
    LIFECYCLE.ensure()[player_index] = { action, goal_id: storage.airi_task_board_ui?.goal_id ?? '', started_tick: game.tick }
    return true
  },
  ack: (player_index: number, action: TaskBoardUiLifecycleAction) => {
    const pending = storage.airi_task_board_lifecycle_pending?.[player_index]
    if (pending === undefined || pending.action !== action) return false
    delete LIFECYCLE.ensure()[player_index]
    return true
  },
}
function ensure_terminate_confirm_state() { if (storage.airi_task_board_terminate_confirm_until === undefined) storage.airi_task_board_terminate_confirm_until = {}; return storage.airi_task_board_terminate_confirm_until }
function ensure_prompt_pending_state() { if (storage.airi_task_board_prompt_pending === undefined) storage.airi_task_board_prompt_pending = {}; return storage.airi_task_board_prompt_pending }
function ensure_blocked_choice_pending_state() { if (storage.airi_task_board_blocked_choice_pending === undefined) storage.airi_task_board_blocked_choice_pending = {}; return storage.airi_task_board_blocked_choice_pending }
// Sending a free-text prompt is not goal/status-keyed the way pause/resume/
// terminate are, so this does not reuse LIFECYCLE: LIFECYCLE.current()'s "done"
// check is built entirely from board?.status and goal_id transitions specific
// to those three actions, and a prompt has no equivalent guaranteed
// transition (an in-progress goal's status usually never changes just because
// a follow-up prompt was sent). Instead this mirrors the lighter
// terminate-confirmation pattern: a per-player tick stamp. "Picked up" is
// inferred from the runtime pushing any fresh snapshot after the send tick;
// the tick bound is only the fallback for a lost round-trip, so it can stay
// short - this is visual reassurance, not a durable cross-save lock.
function task_board_ui_prompt_send_pending(player_index: number, tick: number) {
  const started = storage.airi_task_board_prompt_pending?.[player_index]
  if (started === undefined) return false
  const synced_tick = storage.airi_task_board_ui_synced_tick
  const picked_up = synced_tick !== undefined && synced_tick > started
  const expired = math.max(0, tick - started) >= ui_constants.PROMPT_SEND_PENDING_TICKS
  if (picked_up || expired) { delete ensure_prompt_pending_state()[player_index]; return false }
  return true
}
function mark_prompt_sent(player_index: number) { ensure_prompt_pending_state()[player_index] = game.tick }
function task_board_ui_blocked_choice_pending(player_index: number, tick: number) {
  const started = storage.airi_task_board_blocked_choice_pending?.[player_index]
  if (started === undefined) return false
  const synced_tick = storage.airi_task_board_ui_synced_tick
  const picked_up = synced_tick !== undefined && synced_tick > started
  const expired = math.max(0, tick - started) >= ui_constants.BLOCKED_CHOICE_PENDING_TICKS
  if (picked_up || expired) { delete ensure_blocked_choice_pending_state()[player_index]; return false }
  return true
}
function mark_blocked_choice_sent(player_index: number) { ensure_blocked_choice_pending_state()[player_index] = game.tick }
function ensure_prompt_draft_state() { if (storage.airi_task_board_prompt_draft === undefined) storage.airi_task_board_prompt_draft = {}; return storage.airi_task_board_prompt_draft }
function ensure_ui_input_queue() { if (storage.airi_task_board_ui_inputs === undefined) storage.airi_task_board_ui_inputs = []; return storage.airi_task_board_ui_inputs }
function ensure_preview_zoom_state() { if (storage.airi_task_board_preview_zoom === undefined) storage.airi_task_board_preview_zoom = {}; return storage.airi_task_board_preview_zoom }
function normalize_preview_zoom(value: unknown) {
  if (typeof value !== 'number') return ui_constants.PREVIEW_ZOOM_DEFAULT
  const clamped = math.max(ui_constants.PREVIEW_ZOOM_MIN, math.min(ui_constants.PREVIEW_ZOOM_MAX, value))
  const steps = math.floor((clamped - ui_constants.PREVIEW_ZOOM_MIN) / ui_constants.PREVIEW_ZOOM_STEP + 0.5)
  return math.floor((ui_constants.PREVIEW_ZOOM_MIN + steps * ui_constants.PREVIEW_ZOOM_STEP) * 100 + 0.5) / 100
}
export function task_board_preview_zoom(player_index: number) { return normalize_preview_zoom(storage.airi_task_board_preview_zoom?.[player_index] ?? ui_constants.PREVIEW_ZOOM_DEFAULT) }
function set_preview_zoom(player_index: number, value: unknown) { const zoom = normalize_preview_zoom(value); ensure_preview_zoom_state()[player_index] = zoom; return zoom }
function preview_zoom_caption(zoom: number) { return `${zoom}×` }
function enqueue_ui_input(input: TaskBoardUiInput) { const queue = ensure_ui_input_queue(); queue.push(input); while (queue.length > ui_constants.UI_INPUT_QUEUE_LIMIT) queue.shift() }
function any_console_open() { for (const player of game.connected_players) { if (task_board_ui_is_open(player.index)) return true } return false }

// Only ask when somebody is looking, and no faster than the console refreshes.
// A dead runtime never drains, so the request simply goes unanswered and the
// status panel degrades on its own.
function poll_request(): TaskBoardUiPollInput | undefined {
  if (!any_console_open()) return undefined
  const synced = storage.airi_task_board_ui_synced_tick
  if (synced !== undefined && math.max(0, game.tick - synced) < ui_constants.POLL_REQUEST_TICKS) return undefined
  return { kind: 'poll', version: 1, tick: game.tick, debug: debug_ui.any_debug_ui_open() }
}

function drain_ui_inputs() {
  const queued = storage.airi_task_board_ui_inputs ?? []
  storage.airi_task_board_ui_inputs = []
  const drained: TaskBoardUiDrainedInput[] = queued
  const poll = poll_request()
  if (poll !== undefined) drained.push(poll)
  return drained
}
export function task_board_ui_prompt_draft(player_index: number) { return storage.airi_task_board_prompt_draft?.[player_index] ?? '' }
function set_prompt_draft(player_index: number, value: unknown) { ensure_prompt_draft_state()[player_index] = text(value, ui_constants.MAX_PROMPT_TEXT) }
export function task_board_ui_is_open(player_index: number) { return storage.airi_task_board_ui_open?.[player_index] === true }
export function toggle_task_board_ui_open(player_index: number) { const next = !task_board_ui_is_open(player_index); ensure_open_state()[player_index] = next; return next }
function close_task_board_ui(player_index: number) { ensure_open_state()[player_index] = false }
/** Plain chat text standing in for the console during the first few seconds after joining. */
function join_status_line() {
  const board = storage.airi_task_board_ui
  if (board === undefined) return '[SGLuna] No active task yet. Click the SGLuna button to open the console.'
  return `[SGLuna] ${board.status.toUpperCase()} - ${board.objective || 'no objective set'}. Click the SGLuna button to open the console.`
}
function ensure_skills_open_state() { if (storage.airi_task_board_skills_open === undefined) storage.airi_task_board_skills_open = {}; return storage.airi_task_board_skills_open }
export function task_board_skills_ui_is_open(player_index: number) { return storage.airi_task_board_skills_open?.[player_index] === true }
export function toggle_task_board_skills_ui_open(player_index: number) { const next = !task_board_skills_ui_is_open(player_index); ensure_skills_open_state()[player_index] = next; return next }
function close_task_board_skills_ui(player_index: number) { ensure_skills_open_state()[player_index] = false }
export function task_board_ui_terminate_is_armed(player_index: number, tick: number) { return (storage.airi_task_board_terminate_confirm_until?.[player_index] ?? 0) >= tick }
function clear_terminate_confirmation(player_index: number) { ensure_terminate_confirm_state()[player_index] = 0 }
function close_more_menu(player_index: number) { if (storage.airi_task_board_more_open !== undefined) storage.airi_task_board_more_open[player_index] = false }
function arm_terminate(player_index: number) { ensure_terminate_confirm_state()[player_index] = game.tick + ui_constants.TERMINATE_CONFIRM_TICKS }

function mod_gui_button_flow(player: LuaPlayer): LuaGuiElement {
  const top = player.gui.top
  const legacy = top[ui_constants.MOD_GUI_LEGACY_FLOW_NAME]
  if (legacy?.valid) return legacy
  const frame = top[ui_constants.MOD_GUI_TOP_FRAME_NAME] ?? top.add({ type: 'frame', name: ui_constants.MOD_GUI_TOP_FRAME_NAME, direction: 'horizontal', style: 'slot_window_frame' })
  return frame[ui_constants.MOD_GUI_INNER_FRAME_NAME] ?? frame.add({ type: 'frame', name: ui_constants.MOD_GUI_INNER_FRAME_NAME, direction: 'horizontal', style: 'mod_gui_inside_deep_frame' })
}
function ensure_button(player: LuaPlayer) {
  const legacy = player.gui.top[ui_constants.BUTTON_NAME]
  if (legacy?.valid) legacy.destroy()
  const flow = mod_gui_button_flow(player)
  const existing = flow[ui_constants.BUTTON_NAME]
  const button = (existing?.valid ? existing : flow.add({ type: 'sprite-button', name: ui_constants.BUTTON_NAME, sprite: ui_constants.BUTTON_SPRITE, style: 'slot_button', tooltip: 'SGLuna NPC Console' })) as SpriteButtonGuiElement
  button.sprite = provider_ui.provider_button_sprite(player.index, ui_constants.BUTTON_SPRITE)
  button.tooltip = provider_ui.provider_button_tooltip('SGLuna NPC Console')
  button.toggled = task_board_ui_is_open(player.index)
  // Factorio's stock mod-GUI slot is easy to miss at 1080p. A conservative
  // 48px square keeps the standard slot-button styling while making AIRI's
  // provider avatar materially easier to see and click.
  button.style.width = 48
  button.style.height = 48
  button.style.minimal_width = 48
  button.style.maximal_width = 48
  button.style.minimal_height = 48
  button.style.maximal_height = 48
  return button
}
function destroy_panel(player: LuaPlayer) {
  const existing = player.gui.screen[ui_constants.ROOT_NAME]
  const location = existing?.valid ? existing.location : undefined
  if (existing?.valid) existing.destroy()
  const legacy = player.gui.left[ui_constants.ROOT_NAME]
  if (legacy?.valid) legacy.destroy()
  return location
}

function step_tone(step: TaskBoardUiStep): Tone { if (step.status === 'completed') return 'good'; if (step.status === 'active') return 'info'; if (step.status === 'blocked') return 'bad'; if (step.status === 'paused') return 'warn'; return 'muted' }
/**
 * Plans habitually number their own steps, and the tracker already prints the
 * canonical index in a column of its own, so a raw description renders as
 * "1. 1. build a boiler". Strip one leading ASCII ordinal; anything else is
 * shown exactly as the plan wrote it.
 */
export function step_caption(description: string) {
  let cursor = 0
  while (description.substring(cursor, cursor + 1) === ' ') cursor++
  const first_digit = cursor
  while (cursor < description.length && '0123456789'.indexOf(description.substring(cursor, cursor + 1)) >= 0) cursor++
  const digits = cursor - first_digit
  if (digits < 1 || digits > 2) return description
  const separator = description.substring(cursor, cursor + 1)
  if (separator !== '.' && separator !== ')') return description
  cursor++
  while (description.substring(cursor, cursor + 1) === ' ') cursor++
  const rest = description.substring(cursor)
  return rest.length > 0 ? rest : description
}
function activity_prefix(kind: TaskBoardUiActivityKind) { if (kind === 'observation') return 'OBS'; if (kind === 'decision') return 'PLAN'; if (kind === 'action') return 'ACT'; if (kind === 'result') return 'RESULT'; if (kind === 'blocker') return 'BLOCK'; if (kind === 'system') return 'SYS'; return 'NOTE' }
function activity_tone(kind: TaskBoardUiActivityKind): Tone { if (kind === 'decision' || kind === 'observation') return 'info'; if (kind === 'action' || kind === 'result') return 'good'; if (kind === 'blocker') return 'bad'; if (kind === 'system') return 'warn'; return 'muted' }
function board_tone(board_status: TaskBoardUiSnapshot['status']): Tone { if (board_status === 'active') return 'good'; if (board_status === 'completed') return 'info'; if (board_status === 'paused') return 'warn'; if (board_status === 'blocked') return 'bad'; return 'muted' }
function agent_tone(phase: TaskBoardUiAgentPhase): Tone { if (phase === 'thinking' || phase === 'observing') return 'info'; if (phase === 'executing') return 'good'; if (phase === 'waiting') return 'warn'; if (phase === 'error') return 'bad'; return 'muted' }
function agent_caption(phase: TaskBoardUiAgentPhase) { if (phase === 'thinking') return 'THINKING'; if (phase === 'observing') return 'OBSERVING'; if (phase === 'executing') return 'EXECUTING'; if (phase === 'waiting') return 'WORKING'; if (phase === 'error') return 'ERROR'; return 'IDLE' }
function item_caption(name: string) { const item_prototypes = prototypes.item; if (item_prototypes !== undefined && item_prototypes[name] !== undefined) return gui_text.trusted_rich_text(`[item=${name}] ${name}`); return name }
function item_sprite(name: string): SpritePath { const item: SpritePath = `item/${name}`; if (helpers.is_valid_sprite_path(item)) return item; const entity: SpritePath = `entity/${name}`; if (helpers.is_valid_sprite_path(entity)) return entity; return 'utility/questionmark' }
function read_follow_status(): TaskBoardUiFollowStatus | undefined {
  if (remote.interfaces?.autorio_follow === undefined || typeof remote.call !== 'function') return undefined
  const raw = remote.call('autorio_follow', 'status') as any
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  return { active: raw.active === true, state: text(raw.state, 32), target_player: text(raw.target_player ?? raw.player_name, 128), current_distance: typeof raw.current_distance === 'number' ? raw.current_distance : undefined, desired_distance: typeof raw.desired_distance === 'number' ? raw.desired_distance : undefined, last_failure: text(raw.last_failure ?? raw.blocked_reason, 300) }
}
function read_world_task(): TaskBoardUiWorldTask | undefined {
  if (world_task_provider === undefined) return undefined
  const raw = world_task_provider() as any
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  return { task_state: text(raw.task_state, 48), queue_length: integer(raw.queue_length) }
}
function runtime_snapshot(): TaskBoardUiRuntimeSnapshot {
  const actor = peek_controlled_actor()
  const identity = actor?.status_snapshot()
  const inventory = actor ? get_actor_inventory_items(actor) : []
  inventory.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  const character = actor?.character
  // Keep this helper inside runtime_snapshot so it does not consume another Lua
  // local in the already-large module wrapper.
  const inventory_items = (source: LuaInventory | undefined): TaskBoardUiItem[] => source === undefined ? [] : source.get_contents().map(({ name, count }) => ({ name, count }))
  const guns = character?.valid ? inventory_items(character.get_inventory(defines.inventory.character_guns)) : []
  const ammo = character?.valid ? inventory_items(character.get_inventory(defines.inventory.character_ammo)) : []
  const preview: TaskBoardUiWorldPreview | undefined = actor?.is_valid ? { position: actor.position, surface_index: actor.surface.index, entity: character?.valid ? character : undefined } : undefined
  return { actor_name: text(identity?.name ?? 'AIRI', 128), actor_kind: text(identity?.kind ?? '', 64), inventory: inventory.slice(0, ui_constants.MAX_INVENTORY_ITEMS), guns, ammo, follow: read_follow_status(), preview, world_task: read_world_task() }
}
function emit_control(player: LuaPlayer, action: TaskBoardUiControlAction) { enqueue_ui_input({ kind: 'control', version: 1, action, player_index: player.index, player_name: player.name, tick: game.tick }) }
function emit_resume(player: LuaPlayer) { enqueue_ui_input({ kind: 'prompt', version: 1, player_index: player.index, player_name: player.name, text: 'continue', tick: game.tick }) }
function emit_prompt(player: LuaPlayer, raw: unknown) {
  const prompt = text(raw, ui_constants.MAX_PROMPT_TEXT)
  if (prompt.length === 0) return false
  enqueue_ui_input({ kind: 'prompt', version: 1, player_index: player.index, player_name: player.name, text: prompt, tick: game.tick })
  set_prompt_draft(player.index, '')
  return true
}

function create_section(parent: LuaGuiElement, title: string, width?: number, tooltip?: string, stretch_vertical = true, names?: { section?: string, header?: string, body?: string }) {
  const section = parent.add({ type: 'frame', name: names?.section, direction: 'vertical', style: 'inside_shallow_frame' })
  if (width !== undefined) section.style.width = width
  else section.style.horizontally_stretchable = true
  section.style.vertically_stretchable = stretch_vertical
  const header = section.add({ type: 'frame', name: names?.header, direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.style.vertical_align = 'center'
  header.add({ type: 'label', caption: title, style: 'subheader_caption_label', tooltip })
  const filler = header.add({ type: 'empty-widget' }); filler.style.horizontally_stretchable = true
  const body = section.add({ type: 'flow', name: names?.body, direction: 'vertical' })
  body.style.horizontally_stretchable = true
  body.style.vertically_stretchable = stretch_vertical
  body.style.padding = ui_constants.SECTION_PADDING
  body.style.vertical_spacing = 6
  return { header, body }
}
function create_key_value_table(parent: LuaGuiElement) { const table = parent.add({ type: 'table', column_count: 2 }); table.style.horizontal_spacing = 12; table.style.vertical_spacing = 4; return table }
function add_key_value(table: LuaGuiElement, key: string, value: string, options: { tone?: Tone, static_tooltip?: string, width?: number } = {}) { const key_label = table.add({ type: 'label', caption: key, style: 'semibold_label' }); key_label.style.minimal_width = ui_constants.KEY_COLUMN_WIDTH; const value_label = gui_text.literal_gui_text(table.add({ type: 'label', caption: value, tooltip: options.static_tooltip })); value_label.style.single_line = false; if (options.width !== undefined) value_label.style.maximal_width = options.width; if (options.tone !== undefined) value_label.style.font_color = TONE_COLORS[options.tone]; return value_label }
function add_empty_state(parent: LuaGuiElement, caption: string) { const label = gui_text.literal_gui_text(parent.add({ type: 'label', caption })); label.style.font_color = TONE_COLORS.muted; return label }
function board_goal(board: TaskBoardUiSnapshot) { if (board.objective.length > 0) return board.objective; if (board.goal_id.length > 0) return board.goal_id; return board.status === 'idle' ? 'No active SGLuna task.' : 'Current task' }
/**
 * How much the last snapshot is still worth believing.
 *
 * Tick-explicit and pure so the console never has to guess: `offline` means the
 * runtime has never answered, `stale` means it answered once and has since
 * stopped, and only `live` means the displayed phase is current.
 */
export function task_board_sync_freshness(synced_tick: number | undefined, tick: number): 'offline' | 'stale' | 'live' {
  if (synced_tick === undefined) return 'offline'
  return math.max(0, tick - synced_tick) > ui_constants.SYNC_STALE_TICKS ? 'stale' : 'live'
}

function sync_summary(synced_tick: number | undefined) { if (synced_tick === undefined) return 'Never — SGLuna runtime not connected'; const seconds = math.floor(math.max(0, game.tick - synced_tick) / 60); const age = seconds < 60 ? `${seconds}s ago` : `${math.floor(seconds / 60)}m ago`; return task_board_sync_freshness(synced_tick, game.tick) === 'stale' ? `${age} — polls unanswered` : age }
function world_task_summary(task: TaskBoardUiWorldTask | undefined) { if (task === undefined) return 'UNKNOWN'; const state = task.task_state.length > 0 ? task.task_state.split('_').join(' ').toUpperCase() : 'IDLE'; return task.queue_length > 0 ? `${state} · ${task.queue_length} queued` : state }
function overall_state(board: TaskBoardUiSnapshot | undefined, synced_tick: number | undefined): { tone: Tone, caption: string } {
  const freshness = task_board_sync_freshness(synced_tick, game.tick)
  if (freshness === 'offline') return { tone: 'muted', caption: 'OFFLINE' }
  // A snapshot only ever describes the tick it was pushed at. Once the runtime
  // stops answering polls, repeating its last phase would claim AIRI is still
  // doing work that nothing is driving any more.
  if (freshness === 'stale') return { tone: 'bad', caption: 'STALE' }
  if (board === undefined) return { tone: 'muted', caption: 'IDLE' }
  // The header answers "what is AIRI doing right now?". The durable plan state
  // remains visible in Plan Tracker, so a live phase must not be hidden behind
  // the generic ACTIVE badge while the model is thinking/observing/executing.
  if (board.agent.phase !== 'idle') return { tone: agent_tone(board.agent.phase), caption: agent_caption(board.agent.phase) }
  return { tone: board_tone(board.status), caption: board.status.toUpperCase() }
}

// The title bar's status line: what AIRI is doing right now, and whether that
// is still current. The NPC, world task and sync age are in its tooltip.
function console_title_status(board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot, synced_tick: number | undefined): console_ui.ConsoleTitleStatus {
  const overall = overall_state(board, synced_tick)
  const freshness = task_board_sync_freshness(synced_tick, game.tick)
  const phase = board?.agent.phase ?? 'idle'; const detail = board?.agent.detail ?? ''
  const caption = freshness === 'offline'
    ? 'NOT CONNECTED'
    : freshness === 'stale'
      ? `NO ANSWER — last seen ${agent_caption(phase)}`
      : detail.length > 0 ? `${overall.caption} · ${text(detail, 90)}` : overall.caption
  const tooltip = `NPC: ${runtime.actor_name || 'AIRI'}\nWorld task: ${world_task_summary(runtime.world_task)}\nLast sync: ${sync_summary(synced_tick)}\nThe console polls the SGLuna runtime; this line reports its answer, not a guess.`
  return { caption, tone: overall.tone, tooltip }
}
function console_goal_card(board: TaskBoardUiSnapshot | undefined): console_ui.ConsoleGoalCard {
  const goal = board?.goal
  if (goal !== undefined) {
    return {
      summary: goal.summary,
      note: goal.defined ? '' : 'AIRI has not defined how the game will check this goal yet.',
      read: goal.read,
      met: goal.met,
      total: goal.total,
      checks: goal.checks,
    }
  }
  const summary = board === undefined ? 'No active goal.' : board_goal(board)
  const note = board === undefined || board.status === 'idle' ? 'Tell AIRI what to do in the prompt below.' : ''
  return { summary, note, read: false, met: 0, total: 0, checks: [] }
}
// The last meaningful result: a result or blocker, else the latest action.
function last_result_line(board: TaskBoardUiSnapshot | undefined): { caption: string, tone: Tone } {
  const retained = activity_state.activity_history()
  const recent = retained.length > 0 ? retained : (board?.activity ?? [])
  const board_blocker_text = board === undefined ? '' : task_condition_text(board.blocker_summary, board.blocker, 'SGLuna is blocked by an internal task condition.')
  let action_fallback = ''
  for (let index = recent.length - 1; index >= 0; index--) {
    const entry = recent[index]
    if ((entry.kind === 'result' || entry.kind === 'blocker') && entry.text.length > 0) {
      const current_board_blocker = entry.kind === 'blocker' && board !== undefined && board.blocker.length > 0 && (entry.text === board.blocker || entry.text === board_blocker_text)
      return { caption: current_board_blocker ? board_blocker_text : entry.text, tone: activity_tone(entry.kind) }
    }
    if (action_fallback.length === 0 && entry.kind === 'action' && entry.text.length > 0) action_fallback = entry.text
  }
  return { caption: action_fallback, tone: 'good' }
}
function console_now_card(board: TaskBoardUiSnapshot | undefined): console_ui.ConsoleNowCard {
  const attention: Array<{ caption: string, tone: Tone }> = []
  if (board !== undefined && board.pause_reason.length > 0) attention.push({ caption: `Paused: ${task_condition_text(board.pause_summary, board.pause_reason, 'SGLuna is paused by an internal task condition.')}`, tone: 'warn' })
  const last = last_result_line(board)
  const last_caption = last.caption.length > 0 ? `Last: ${text(last.caption, 140)}` : ''
  if (board === undefined || board.steps.length === 0) {
    return { heading: 'Now', step: board?.agent.detail || 'No active plan slice.', step_tone: 'muted', progress: 0, show_progress: false, next: '', attention, last: last_caption, last_tone: last.tone }
  }
  const index = math.min(board.active_index, board.steps.length - 1)
  const step = board.steps[index]
  const upcoming: string[] = []
  for (let next = index + 1; next < board.steps.length && upcoming.length < 2; next++) {
    if (board.steps[next].status === 'pending') upcoming.push(text(step_caption(board.steps[next].description), 70))
  }
  const remaining = board.steps.length - index - 1 - upcoming.length
  const next = upcoming.length === 0 ? '' : `Next: ${upcoming.join(' · ')}${remaining > 0 ? ` · +${remaining} more` : ''}`
  return {
    heading: `Now · step ${index + 1} of ${board.total_steps} · ${board.completed_count} verified`,
    step: step_caption(step.description),
    step_tone: step_tone(step),
    progress: board.total_steps > 0 ? board.completed_count / board.total_steps : 0,
    show_progress: true,
    next,
    attention,
    last: last_caption,
    last_tone: last.tone,
  }
}
function follow_button_tooltip(follow: TaskBoardUiFollowStatus | undefined) { return follow?.active ? 'Click to stop following. A goal paused by Follow will automatically resume.' : 'Temporarily suspend current world work and follow this player. A goal paused by Follow automatically resumes when Follow stops.' }
// State for the chrome drawn by task_board_console. Built here because it reads
// this module's lifecycle, confirmation and window state; drawn there.
function console_window_buttons(player: LuaPlayer): console_ui.ConsoleWindowButton[] {
  const skills_open = task_board_skills_ui_is_open(player.index)
  const projects_open = project_ui.projects_ui_is_open(player.index)
  const debug_open = debug_ui.debug_ui_is_open(player.index)
  return [
    { name: ui_constants.SKILLS_BUTTON_NAME, icon: 'learn', open: skills_open, tooltip: skills_open ? 'Close area learning.' : 'Area learning and saved skill candidates, in their own window.' },
    { name: project_ui.PROJECTS_BUTTON_NAME, icon: 'history', open: projects_open, tooltip: projects_open ? 'Close old tasks.' : 'Old tasks: history, conversations and evidence.' },
    { name: debug_ui.DEBUG_BUTTON_NAME, icon: 'debug', open: debug_open, tooltip: debug_open ? 'Close diagnostics.' : 'SGLuna runtime diagnostics, provider usage, actor state and execution activity.' },
  ]
}
function console_action_state(player: LuaPlayer, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot): console_ui.ConsoleActionState {
  const follow = runtime.follow
  const has_open_goal = board !== undefined && board.status !== 'idle' && board.status !== 'completed'
  const paused = board?.status === 'paused'
  const pending = LIFECYCLE.current(player.index)
  const pending_tip = pending === undefined ? '' : `Waiting for SGLuna runtime to confirm ${pending.action}.`
  const armed = task_board_ui_terminate_is_armed(player.index, game.tick)
  return {
    pause_caption: pending?.action === 'pause' ? 'PAUSING...' : pending?.action === 'resume' ? 'RESUMING...' : paused ? 'RESUME' : 'PAUSE',
    pause_tooltip: pending_tip.length > 0 ? pending_tip : paused ? 'Resume this durable SGLuna goal. SGLuna will re-observe mutable state before acting.' : has_open_goal ? 'Pause the durable SGLuna goal and stop current world work' : 'Stop the current world work. There is no durable SGLuna goal to pause.',
    pause_enabled: pending === undefined,
    follow_caption: debug_ui.follow_button_caption(follow?.active === true),
    follow_tooltip: follow_button_tooltip(follow),
    follow_active: follow?.active === true,
    // A blank last_failure is still truthy, which drew a lone warning triangle
    // with no message. Only report a failure there is something to read about.
    follow_issue: text(follow?.last_failure ?? '', 100),
    // Armed TERMINATE keeps the menu open so the confirming click is there.
    more_open: storage.airi_task_board_more_open?.[player.index] === true || armed,
    new_task_tooltip: pending === undefined ? "Stop current work and clear this NPC's conversation and durable plan. Learned skills and Factorio world state are kept." : pending_tip,
    new_task_enabled: pending === undefined,
    terminate_caption: pending?.action === 'terminate' ? 'TERMINATING...' : armed ? 'CONFIRM' : 'TERMINATE',
    terminate_tooltip: pending_tip.length > 0 ? pending_tip : armed ? 'Click again within 5 seconds to discard the goal permanently' : has_open_goal ? 'Discard the current durable SGLuna goal permanently' : 'Stop the current world work. There is no durable SGLuna goal to discard.',
    terminate_enabled: pending === undefined,
    issue_color: TONE_COLORS.bad,
    muted_color: TONE_COLORS.muted,
  }
}
// BLOCKED is a durable freeze, not a variant of PAUSED: its reason and the only
// three user-authorized exits sit in a banner above everything else.
function render_blocked(parent: LuaGuiElement, player: LuaPlayer, board: TaskBoardUiSnapshot | undefined) {
  if (board?.status !== 'blocked') return
  const blocked = board.blocked
  const summary = blocked?.summary ?? task_condition_text(board.blocker_summary, board.blocker, 'AIRI stopped because the committed plan needs your decision.')
  const deadlock = blocked?.deadlock === undefined ? '' : `Deadlock: ${blocked.deadlock.signal.replace('_', ' ')} (${blocked.deadlock.count})${typeof blocked.deadlock.detail === 'string' && blocked.deadlock.detail !== '' ? ` — ${blocked.deadlock.detail}` : ''}`
  console_ui.render_blocked_banner(parent, {
    summary,
    reason: blocked?.reason ?? board.blocker,
    deadlock,
    choice_pending: task_board_ui_blocked_choice_pending(player.index, game.tick),
    bad_color: TONE_COLORS.bad,
    muted_color: TONE_COLORS.muted,
    warn_color: TONE_COLORS.warn,
  })
}

/**
 * Pure conversion helper retained for layout tests and future non-runtime
 * callers. The synchronized control-stage rendering path deliberately does not
 * read LuaPlayer display properties; see player_gui_height below.
 */
export function task_board_gui_height(resolution_height: number, scale: number) {
  const safe_scale = scale > 0 ? scale : 1
  return math.floor(resolution_height / safe_scale)
}

/**
 * How much vertical room the two tracker lists may take, split between them.
 *
 * The total is clamped at both ends: never shorter than the previous fixed
 * layout, and never so tall that a list stops being a list. The split is not
 * even. The plan list is sized to the plan that actually exists, capped at its
 * share, and everything it does not need goes to the activity feed - a plan has
 * a handful of steps and stops, while activity keeps arriving.
 */
export function task_board_tracker_heights(gui_height: number, step_count = ui_constants.MAX_STEPS) {
  const budget = math.max(ui_constants.CONSOLE_LAYOUT.list_min_total, math.min(ui_constants.CONSOLE_LAYOUT.list_max_total, math.floor(gui_height * ui_constants.CONSOLE_LAYOUT.screen_fraction) - ui_constants.CONSOLE_LAYOUT.fixed_height))
  if (step_count <= 0) return { steps: 0, activity: 0 }
  const wanted = math.max(ui_constants.CONSOLE_LAYOUT.steps_floor, step_count * ui_constants.CONSOLE_LAYOUT.step_row_height)
  return { steps: math.min(budget, wanted), activity: 0 }
}

/**
 * The inventory pane always exposes at least an 8×5 viewport. Taller displays
 * spend some of their extra vertical room on an 8×6 or full 8×8 inventory.
 * Wanted items deliberately consume fewer rows so the narrow sidebar can also
 * show the character's equipped gun and ammo state underneath.
 */
export function task_board_resource_rows(gui_height: number) {
  if (gui_height >= 1200) return ui_constants.RESOURCE_LAYOUT.slot_rows_max
  if (gui_height >= 900) return ui_constants.RESOURCE_LAYOUT.slot_rows_mid
  return ui_constants.RESOURCE_LAYOUT.slot_rows_min
}
export function task_board_wanted_rows(gui_height: number) { return math.max(1, task_board_resource_rows(gui_height) - 4) }

/**
 * The camera's floor, which is what keeps the console tall while AIRI has no
 * plan to show and the left column is therefore short.
 */
export function task_board_preview_min_height(gui_height: number) {
  return math.max(ui_constants.CONSOLE_LAYOUT.preview_min_height, math.min(ui_constants.CONSOLE_LAYOUT.preview_max_height, math.floor(gui_height * ui_constants.CONSOLE_LAYOUT.preview_screen_fraction)))
}

function player_gui_height(_player: LuaPlayer) {
  return ui_constants.CONSOLE_LAYOUT.synced_gui_height
}

function preview_position_caption(preview: TaskBoardUiWorldPreview) { return `X ${math.floor(preview.position.x)} · Y ${math.floor(preview.position.y)}` }
function focus_npc_preview(player: LuaPlayer) {
  const preview = runtime_snapshot().preview
  if (preview === undefined) return false
  const surface = game.get_surface(preview.surface_index)
  if (surface === undefined) return false
  player.set_controller({ type: defines.controllers.remote, position: preview.position, surface })
  return true
}

/**
 * Updates the preview without rebuilding it.
 *
 * The console refreshes every second, and rebuilding this column destroyed the
 * zoom slider along with it, cancelling a drag in progress. Only the camera and
 * the coordinate label carry live data; the slider holds the player's own state
 * and must survive untouched. Returns false when the structure itself has to
 * change, which is the only case that still warrants a rebuild.
 */
function refresh_world_preview(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot, player: LuaPlayer) {
  const preview = runtime.preview
  const section = parent[ui_constants.PREVIEW_SECTION_NAME]
  const header = section?.valid ? section[ui_constants.PREVIEW_HEADER_NAME] : undefined
  const body = section?.valid ? section[ui_constants.PREVIEW_BODY_NAME] : undefined
  if (preview === undefined) return body?.valid === true && body[ui_constants.PREVIEW_CAMERA_FRAME_NAME]?.valid !== true
  const frame = body?.valid ? body[ui_constants.PREVIEW_CAMERA_FRAME_NAME] : undefined
  // Keep the element typed: the camera's live properties are read-only on the
  // base union, and casting to `any` would emit the wrong Lua self ABI.
  const camera = frame?.valid ? frame[ui_constants.PREVIEW_CAMERA_NAME] as CameraGuiElement | undefined : undefined
  const position = header?.valid ? header[ui_constants.PREVIEW_POSITION_NAME] : undefined
  if (!frame?.valid || !camera?.valid || !position?.valid) return false

  if (camera.position.x !== preview.position.x || camera.position.y !== preview.position.y) camera.position = preview.position
  if (camera.surface_index !== preview.surface_index) camera.surface_index = preview.surface_index
  if (preview.entity?.valid && camera.entity !== preview.entity) camera.entity = preview.entity
  // Follow storage rather than the slider: the slider is the player's input, and
  // writing to it mid-drag is exactly what this refresh must not do.
  const zoom = task_board_preview_zoom(player.index)
  if (camera.zoom !== zoom) camera.zoom = zoom
  const caption = preview_position_caption(preview)
  if (position.caption !== caption) position.caption = caption

  const preview_min_height = task_board_preview_min_height(player_gui_height(player))
  if (frame.style.minimal_height !== preview_min_height) frame.style.minimal_height = preview_min_height
  if (camera.style.minimal_height !== preview_min_height) camera.style.minimal_height = preview_min_height
  return true
}

function render_world_preview(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot, player: LuaPlayer) {
  const { header, body } = create_section(parent, 'NPC World Preview', ui_constants.PREVIEW_COLUMN_WIDTH, undefined, true, { section: ui_constants.PREVIEW_SECTION_NAME, header: ui_constants.PREVIEW_HEADER_NAME, body: ui_constants.PREVIEW_BODY_NAME })
  const preview = runtime.preview
  if (preview === undefined) { add_empty_state(body, 'NPC world preview is unavailable.'); return }
  const zoom = task_board_preview_zoom(player.index)
  const preview_min_height = task_board_preview_min_height(player_gui_height(player))
  const position = header.add({ type: 'button', name: ui_constants.PREVIEW_POSITION_NAME, caption: preview_position_caption(preview), style: 'mini_button_aligned_to_text_vertically', tooltip: 'Show NPC in remote view' }); position.style.right_margin = 4
  const frame = body.add({ type: 'frame', name: ui_constants.PREVIEW_CAMERA_FRAME_NAME, direction: 'vertical', style: 'deep_frame_in_shallow_frame' })
  frame.style.width = ui_constants.PREVIEW_CAMERA_WIDTH; frame.style.minimal_height = preview_min_height; frame.style.horizontally_stretchable = false; frame.style.vertically_stretchable = true
  const camera = frame.add({ type: 'camera', name: ui_constants.PREVIEW_CAMERA_NAME, position: preview.position, surface_index: preview.surface_index, zoom })
  camera.style.width = ui_constants.PREVIEW_CAMERA_WIDTH; camera.style.minimal_height = preview_min_height; camera.style.horizontally_stretchable = true; camera.style.vertically_stretchable = true
  if (preview.entity?.valid) camera.entity = preview.entity
  const zoom_row = body.add({ type: 'flow', direction: 'horizontal' }); zoom_row.style.horizontally_stretchable = true; zoom_row.style.vertical_align = 'center'; zoom_row.style.horizontal_spacing = 8
  zoom_row.add({ type: 'label', caption: 'ZOOM', style: 'semibold_label' })
  const slider = zoom_row.add({ type: 'slider', name: ui_constants.PREVIEW_ZOOM_SLIDER_NAME, minimum_value: ui_constants.PREVIEW_ZOOM_MIN, maximum_value: ui_constants.PREVIEW_ZOOM_MAX, value: zoom, value_step: ui_constants.PREVIEW_ZOOM_STEP })
  slider.style.horizontally_stretchable = true; slider.style.width = ui_constants.PREVIEW_CAMERA_WIDTH - 100
  const zoom_value = zoom_row.add({ type: 'label', name: ui_constants.PREVIEW_ZOOM_VALUE_NAME, caption: preview_zoom_caption(zoom), style: 'semibold_label' }); zoom_value.style.minimal_width = 46
}

export function task_board_activity_for_display(board: TaskBoardUiSnapshot | undefined): TaskBoardUiActivity[] {
  const history = activity_state.activity_history()
  if (history.length > 0) return history
  if (board === undefined) return []
  if (board.activity.length > 0) return board.activity
  if (board.status === 'idle') return []
  if (board.steps.length === 0) return [{ kind: 'system', text: `Goal is ${board.status}; no auditable step activity has been recorded yet.` }]
  const index = math.min(board.active_index, board.steps.length - 1); const step = board.steps[index]
  return [{ kind: 'system', text: `Current canonical step ${index + 1}/${board.total_steps}: ${step.description} (${step.status}). Waiting for the next auditable observation, action, or result.` }]
}
/**
 * Build the tracker skeleton once. Everything that changes is written by
 * refresh_tracker, which the once-a-second refresh calls instead of rebuilding.
 */
function render_tracker(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, player: LuaPlayer) {
  const { header, body } = create_section(parent, 'Plan Tracker', undefined, 'Roadmap Shelf on the left; the immutable executable plan slice on the right. Execution activity has its own tab.', true, { section: ui_constants.TRACKER.section, header: ui_constants.TRACKER.header, body: ui_constants.TRACKER.body })
  const summary = header.add({ type: 'label', name: ui_constants.TRACKER.summary, caption: '', style: 'semibold_label' }); summary.style.right_padding = 4

  const workspace = body.add({ type: 'flow', name: ui_constants.TRACKER.workspace, direction: 'horizontal' })
  workspace.style.width = ui_constants.LEFT_COLUMN_WIDTH - 2 * ui_constants.SECTION_PADDING
  workspace.style.horizontal_spacing = ui_constants.CONSOLE_LAYOUT.tracker_column_gap
  workspace.style.vertical_align = 'top'

  // Each half of the workspace is its own bordered, titled sub-panel - a
  // standalone list, not a bare flow glued to its neighbour - so the shelf and
  // the executing plan read as two distinct trackers sharing one card.
  const shelf = workspace.add({ type: 'frame', name: ui_constants.TRACKER.shelf, direction: 'vertical', style: 'inside_shallow_frame' })
  shelf.style.width = ui_constants.CONSOLE_LAYOUT.tracker_shelf_width
  const shelf_header = shelf.add({ type: 'frame', name: ui_constants.TRACKER.shelf_header, direction: 'horizontal', style: 'subheader_frame' })
  shelf_header.style.horizontally_stretchable = true
  shelf_header.style.vertical_align = 'center'
  shelf_header.add({ type: 'label', caption: 'Roadmap Shelf', style: 'subheader_caption_label' })
  const shelf_spacer = shelf_header.add({ type: 'empty-widget' }); shelf_spacer.style.horizontally_stretchable = true
  shelf_header.add({ type: 'label', name: ui_constants.TRACKER.shelf_count, caption: '0', style: 'semibold_label' })
  const shelf_body = shelf.add({ type: 'flow', name: ui_constants.TRACKER.shelf_body, direction: 'vertical' }); shelf_body.style.padding = ui_constants.SECTION_PADDING; shelf_body.style.horizontally_stretchable = true
  const shelf_scroll = shelf_body.add({ type: 'scroll-pane', name: ui_constants.TRACKER.shelf_scroll, style: 'scroll_pane_in_shallow_frame', horizontal_scroll_policy: 'never' })
  shelf_scroll.style.horizontally_stretchable = true
  const shelf_table = shelf_scroll.add({ type: 'table', name: ui_constants.TRACKER.shelf_table, column_count: 2, tags: { signature: '' } })
  shelf_table.style.horizontal_spacing = 6
  shelf_table.style.vertical_spacing = 5

  const plan_column = workspace.add({ type: 'frame', name: ui_constants.TRACKER.plan_column, direction: 'vertical', style: 'inside_shallow_frame' })
  plan_column.style.width = ui_constants.CONSOLE_LAYOUT.tracker_plan_width
  const plan_header = plan_column.add({ type: 'frame', name: ui_constants.TRACKER.plan_header, direction: 'horizontal', style: 'subheader_frame' })
  plan_header.style.horizontally_stretchable = true
  plan_header.style.vertical_align = 'center'
  plan_header.add({ type: 'label', caption: 'Active Plan', style: 'subheader_caption_label' })
  const plan_header_spacer = plan_header.add({ type: 'empty-widget' }); plan_header_spacer.style.horizontally_stretchable = true
  plan_header.add({ type: 'label', name: ui_constants.TRACKER.plan_summary, caption: '', style: 'semibold_label' })
  const plan_body = plan_column.add({ type: 'flow', name: ui_constants.TRACKER.plan_body, direction: 'vertical' }); plan_body.style.padding = ui_constants.SECTION_PADDING; plan_body.style.horizontally_stretchable = true; plan_body.style.vertical_spacing = 6
  const empty = plan_body.add({ type: 'label', name: ui_constants.TRACKER.empty, caption: 'No active plan slice.' }); empty.style.font_color = TONE_COLORS.muted
  const plan = plan_body.add({ type: 'flow', name: ui_constants.TRACKER.plan, direction: 'vertical' }); plan.style.horizontally_stretchable = true; plan.style.vertical_spacing = 6
  const progress = plan.add({ type: 'progressbar', name: ui_constants.TRACKER.progress, value: 0 }); progress.style.horizontally_stretchable = true
  const steps_scroll = plan.add({ type: 'scroll-pane', name: ui_constants.TRACKER.steps_scroll, style: 'scroll_pane_in_shallow_frame', horizontal_scroll_policy: 'never' }); steps_scroll.style.horizontally_stretchable = true
  const steps_table = steps_scroll.add({ type: 'table', name: ui_constants.TRACKER.steps_table, column_count: 4 }); steps_table.style.horizontal_spacing = 8; steps_table.style.vertical_spacing = 4
  plan.add({ type: 'flow', name: ui_constants.TRACKER.attention, direction: 'vertical' })

  refresh_tracker(parent, board, player)
}

function refresh_tracker(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, player: LuaPlayer) {
  const section = parent[ui_constants.TRACKER.section]
  const header = section?.valid ? section[ui_constants.TRACKER.header] : undefined
  const body = section?.valid ? section[ui_constants.TRACKER.body] : undefined
  if (!header?.valid || !body?.valid) return false
  const workspace = body[ui_constants.TRACKER.workspace]
  const shelf = workspace?.valid ? workspace[ui_constants.TRACKER.shelf] : undefined
  const plan_column = workspace?.valid ? workspace[ui_constants.TRACKER.plan_column] : undefined
  const summary = header[ui_constants.TRACKER.summary]
  const plan_header = plan_column?.valid ? plan_column[ui_constants.TRACKER.plan_header] : undefined
  const plan_summary = plan_header?.valid ? plan_header[ui_constants.TRACKER.plan_summary] : undefined
  // Factorio indexes only direct children by name, so reach the list through its body.
  const plan_body = plan_column?.valid ? plan_column[ui_constants.TRACKER.plan_body] : undefined
  const empty = plan_body?.valid ? plan_body[ui_constants.TRACKER.empty] : undefined
  const plan = plan_body?.valid ? plan_body[ui_constants.TRACKER.plan] : undefined
  if (!workspace?.valid || !shelf?.valid || !plan_column?.valid || !summary?.valid || !plan_header?.valid || !plan_summary?.valid || !empty?.valid || !plan?.valid) return false

  const shelf_nodes = board?.shelf ?? []
  const row_count = board === undefined ? 0 : math.max(board.steps.length, shelf_nodes.length)
  const tracker_heights = task_board_tracker_heights(player_gui_height(player), math.min(row_count, ui_constants.MAX_STEPS))
  const has_steps = board !== undefined && board.steps.length > 0
  const has_shelf = shelf_nodes.length > 0
  empty.visible = !has_steps
  empty.caption = has_shelf ? 'No active plan slice.' : 'No active plan.'
  plan.visible = has_steps
  summary.caption = ''
  plan_summary.caption = ''

  if (!refresh_shelf(shelf, shelf_nodes, tracker_heights.steps)) return false
  if (board !== undefined && has_steps) {
    if (!refresh_steps(plan, board, tracker_heights.steps)) return false
    const active_number = board.status === 'completed' ? board.total_steps : math.min(board.active_index + 1, board.total_steps)
    plan_summary.caption = `STEP ${active_number}/${board.total_steps} · ${board.completed_count} verified`
  }
  return true
}

/**
 * The ACTIVITY page: the feed with its filters and LIVE button, built once and
 * then brought up to date by refresh_activity, like the tracker.
 */
function render_activity_section(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, player: LuaPlayer) {
  const names = ui_constants.CONSOLE_TABS
  const { header, body } = create_section(parent, 'Activity', ui_constants.LEFT_COLUMN_WIDTH, 'What AIRI observed, decided and did. Messages already in the conversation on NOW are not repeated here.', false, { section: names.activity_section, header: names.activity_section_header, body: names.activity_section_body })
  const activity_header = header.add({ type: 'flow', name: ui_constants.TRACKER.activity_header, direction: 'horizontal' }); activity_header.style.vertical_align = 'center'; activity_header.style.horizontal_spacing = 6
  const filters = activity_header.add({ type: 'flow', name: ui_constants.TRACKER.filters, direction: 'horizontal' }); filters.style.horizontal_spacing = 2
  activity_state.style_feed_button(filters.add({ type: 'button', caption: 'ALL', tooltip: 'Show every kind of activity', tags: { airi_activity_filter: activity_state.ACTIVITY_FILTER_ALL } }))
  for (const filter of activity_state.ACTIVITY_FILTERS) activity_state.style_feed_button(filters.add({ type: 'button', caption: filter.caption, tooltip: `${filter.tooltip}. Click to show or hide; several can be on at once.`, tags: { airi_activity_filter: filter.flag } }))
  activity_state.style_feed_button(activity_header.add({ type: 'button', name: ui_constants.TRACKER.live, caption: '' }), activity_state.FEED_STATE_BUTTON_WIDTH)
  const count = activity_header.add({ type: 'label', name: ui_constants.TRACKER.count, caption: '', style: 'semibold_label' }); count.style.right_padding = 4
  const activity_empty = body.add({ type: 'label', name: ui_constants.TRACKER.activity_empty, caption: 'No activity yet.' }); activity_empty.style.font_color = TONE_COLORS.muted
  const activity_scroll = body.add({ type: 'scroll-pane', name: ui_constants.TRACKER.activity_scroll, style: 'scroll_pane_in_shallow_frame', horizontal_scroll_policy: 'never' }); activity_scroll.style.horizontally_stretchable = true
  const activity_table = activity_scroll.add({ type: 'table', name: ui_constants.TRACKER.activity_table, column_count: 3, ignored_by_interaction: true, tags: { keys: [] } }); activity_table.style.horizontal_spacing = 10; activity_table.style.vertical_spacing = 4
  refresh_activity_section(parent, board, player)
}

function refresh_activity_section(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, player: LuaPlayer) {
  const names = ui_constants.CONSOLE_TABS
  const section = parent[names.activity_section]
  const header = section?.valid ? section[names.activity_section_header] : undefined
  const body = section?.valid ? section[names.activity_section_body] : undefined
  const activity_header = header?.valid ? header[ui_constants.TRACKER.activity_header] : undefined
  const activity_empty = body?.valid ? body[ui_constants.TRACKER.activity_empty] : undefined
  const activity_scroll = body?.valid ? body[ui_constants.TRACKER.activity_scroll] : undefined
  const activity_table = activity_scroll?.valid ? activity_scroll[ui_constants.TRACKER.activity_table] : undefined
  if (!activity_header?.valid || !activity_empty?.valid || !activity_scroll?.valid || !activity_table?.valid) return false
  refresh_activity(activity_header, activity_empty, activity_scroll, activity_table, task_board_activity_for_display(board), names.activity_height, player)
  return true
}

function refresh_shelf(shelf: LuaGuiElement, nodes: TaskBoardUiShelfNode[], max_height: number) {
  const header = shelf[ui_constants.TRACKER.shelf_header]
  const count = header?.valid ? header[ui_constants.TRACKER.shelf_count] : undefined
  const shelf_body = shelf[ui_constants.TRACKER.shelf_body]
  const scroll = shelf_body?.valid ? shelf_body[ui_constants.TRACKER.shelf_scroll] : undefined
  const table = scroll?.valid ? scroll[ui_constants.TRACKER.shelf_table] : undefined
  if (!header?.valid || !count?.valid || !scroll?.valid || !table?.valid) return false
  count.caption = `${nodes.length}`
  scroll.style.maximal_height = max_height
  const visible = nodes.slice(0, ui_constants.MAX_SHELF_NODES)
  let signature = `${visible.length}`
  for (const node of visible) signature = `${signature}#${node.id}:${node.status}:${node.linked ? '1' : '0'}:${node.intent}`
  if (table.tags.signature === signature) return true
  table.clear()
  if (visible.length === 0) {
    table.add({ type: 'sprite', sprite: TONE_SPRITES.muted, style: 'status_image' })
    const label = gui_text.literal_gui_text(table.add({ type: 'label', caption: 'No shelved roadmap nodes.' }))
    label.style.single_line = false
    label.style.maximal_width = ui_constants.CONSOLE_LAYOUT.tracker_shelf_width - 2 * ui_constants.SECTION_PADDING - 36
  }
  else {
    for (const node of visible) {
      const tone: Tone = node.status === 'realized' ? 'good' : node.status === 'partially_realized' ? 'info' : node.status === 'ready_to_refine' ? 'warn' : node.status === 'invalidated' ? 'bad' : 'muted'
      table.add({ type: 'sprite', sprite: TONE_SPRITES[tone], style: 'status_image', tooltip: node.status.split('_').join(' ') })
      let tooltip = node.status.split('_').join(' ').toUpperCase()
      if (node.development_hint) tooltip = `${tooltip} · ${node.development_hint}`
      if (node.depends_on.length > 0) tooltip = `${tooltip} · depends on ${node.depends_on.join(', ')}`
      if (node.why_it_matters.length > 0) tooltip = `${tooltip}\n${node.why_it_matters}`
      const caption = node.linked ? `→ ${node.intent}` : node.intent
      const label = gui_text.literal_gui_text(table.add({ type: 'label', caption, style: node.linked ? 'bold_label' : 'label', tooltip }))
      label.style.single_line = false
      label.style.maximal_width = ui_constants.CONSOLE_LAYOUT.tracker_shelf_width - 2 * ui_constants.SECTION_PADDING - 36
      if (node.status === 'invalidated') label.style.font_color = TONE_COLORS.muted
    }
  }
  table.tags = { signature }
  return true
}

function refresh_steps(plan: LuaGuiElement, board: TaskBoardUiSnapshot, max_height: number) {
  const progress = plan[ui_constants.TRACKER.progress]; const steps_scroll = plan[ui_constants.TRACKER.steps_scroll]; const steps_table = steps_scroll?.valid ? steps_scroll[ui_constants.TRACKER.steps_table] : undefined; const attention = plan[ui_constants.TRACKER.attention]
  if (!progress?.valid || !steps_scroll?.valid || !steps_table?.valid || !attention?.valid) return false
  ;(progress as ProgressBarGuiElement).value = board.total_steps > 0 ? board.completed_count / board.total_steps : 0
  steps_scroll.style.maximal_height = max_height
  const visible = board.steps.slice(0, ui_constants.MAX_STEPS)
  let signature = `${board.goal_id}#${board.steps.length}`; let active_index = -1
  for (let index = 0; index < visible.length; index++) {
    const step = visible[index]; signature = `${signature}#${step.status}:${step.description}`
    if (step.status === 'active' || step.status === 'blocked' || step.status === 'paused') active_index = index
  }
  if (steps_table.tags.signature !== signature) {
    const previous_active = steps_table.tags.active
    steps_table.clear(); let active_label: LuaGuiElement | undefined
    for (let index = 0; index < visible.length; index++) {
      const step = visible[index]; const tone = step_tone(step)
      steps_table.add({ type: 'sprite', sprite: TONE_SPRITES[tone], style: 'status_image', tooltip: step.status }); steps_table.add({ type: 'label', caption: `${index + 1}.`, style: 'semibold_label' })
      const description = gui_text.literal_gui_text(steps_table.add({ type: 'label', caption: step_caption(step.description), style: step.status === 'active' ? 'bold_label' : 'label' })); description.style.single_line = false; description.style.maximal_width = ui_constants.CONSOLE_LAYOUT.tracker_plan_width - 2 * ui_constants.SECTION_PADDING - 140
      if (step.status === 'completed' || step.status === 'pending') description.style.font_color = TONE_COLORS.muted
      const state = steps_table.add({ type: 'label', caption: step.status.toUpperCase(), style: 'semibold_label' }); state.style.font_color = TONE_COLORS[tone]; state.style.minimal_width = 72
      if (index === active_index) active_label = description
    }
    if (board.steps.length > visible.length) { steps_table.add({ type: 'empty-widget' }); steps_table.add({ type: 'label', caption: '+', style: 'semibold_label' }); add_empty_state(steps_table, `${board.steps.length - visible.length} more steps`); steps_table.add({ type: 'empty-widget' }) }
    steps_table.tags = { signature, active: active_index }
    if (active_label !== undefined && previous_active !== active_index) (steps_scroll as ScrollPaneGuiElement).scroll_to_element(active_label, 'top-third')
  }
  const attention_signature = `${board.blocker}|${board.blocker_summary}|${board.pause_reason}|${board.pause_summary}`
  if (attention.tags.signature === attention_signature) return true
  attention.clear(); attention.tags = { signature: attention_signature }
  if (board.blocker.length > 0 || board.pause_reason.length > 0) {
    const table = create_key_value_table(attention)
    const width = ui_constants.CONSOLE_LAYOUT.tracker_plan_width - ui_constants.KEY_COLUMN_WIDTH - 12
    if (board.blocker.length > 0) add_key_value(table, 'BLOCKED', task_condition_text(board.blocker_summary, board.blocker, 'SGLuna is blocked by an internal task condition.'), { tone: 'bad', width })
    if (board.pause_reason.length > 0) add_key_value(table, 'PAUSED', task_condition_text(board.pause_summary, board.pause_reason, 'SGLuna is paused by an internal task condition.'), { tone: 'warn', width })
  }
  return true
}
/**
 * Bring the feed up to date by appending new rows and dropping trimmed ones, so
 * the scroll-pane and the player's position in it survive every refresh. The
 * feed only moves when it is following, something new arrived, and the cursor
 * is not over it.
 */
function refresh_activity(header: LuaGuiElement, empty: LuaGuiElement, scroll: LuaGuiElement, table: LuaGuiElement, all_activity: TaskBoardUiActivity[], max_height: number, player: LuaPlayer) {
  const mask = activity_state.activity_filter_mask(player.index)
  // Player messages and AIRI replies already read in full in the conversation
  // panel above; only what that panel does not show is listed here.
  const in_conversation = debug_ui.conversation_activity_keys(storage.airi_task_board_ui)
  const entries: TaskBoardUiActivity[] = []; const keys: string[] = []; let total = 0
  for (const entry of all_activity) { const key = activity_state.activity_key(entry); if (in_conversation[key]) continue; total++; if (!activity_state.activity_matches_mask(entry.kind, mask)) continue; entries.push(entry); keys.push(key) }
  scroll.style.maximal_height = max_height
  scroll.visible = entries.length > 0
  empty.visible = entries.length === 0
  empty.caption = total === 0 ? 'No activity yet.' : mask === 0 ? 'No activity categories selected.' : 'No recent activity matches this filter.'
  // Repeats of one line are one row with ×N, updated in place as they arrive.
  const rows = activity_state.activity_rows(entries)
  const add_row = (row: activity_state.ActivityRow) => {
    const entry = row.entry
    const timestamp = table.add({ type: 'label', caption: entry.timestamp ?? '--:--:--', ignored_by_interaction: true }); timestamp.style.minimal_width = 66; timestamp.style.font_color = TONE_COLORS.muted
    const tag = table.add({ type: 'label', caption: activity_prefix(entry.kind), style: 'bold_label', ignored_by_interaction: true }); tag.style.minimal_width = 52; tag.style.font_color = TONE_COLORS[activity_tone(entry.kind)]
    const line = gui_text.literal_gui_text(table.add({ type: 'label', caption: activity_state.activity_row_text(row), ignored_by_interaction: true })); line.style.single_line = false; line.style.maximal_width = ui_constants.LEFT_COLUMN_WIDTH - 2 * ui_constants.SECTION_PADDING - 160
  }
  const shown_heads = table.tags.heads as string[] | undefined
  const shown_tails = table.tags.tails as string[] | undefined
  const diff = shown_heads === undefined || shown_tails === undefined ? undefined : activity_state.activity_row_diff(shown_heads, shown_tails, rows)
  let appended = 0
  if (diff === undefined) {
    table.clear(); for (const row of rows) add_row(row); appended = rows.length
  }
  else {
    const children = table.children
    for (let index = 0; index < diff.drop * 3 && index < children.length; index++) children[index].destroy()
    // Only the ends of the kept rows can have changed: the oldest run loses
    // trimmed entries and the newest run gains repeats.
    const kept = rows.length - diff.append
    const remaining = table.children
    for (const index of kept > 1 ? [0, kept - 1] : kept === 1 ? [0] : []) {
      const time = remaining[index * 3]; const line = remaining[index * 3 + 2]; const caption = activity_state.activity_row_text(rows[index])
      if (time?.valid && time.caption !== (rows[index].entry.timestamp ?? '--:--:--')) time.caption = rows[index].entry.timestamp ?? '--:--:--'
      if (line?.valid && line.caption !== caption) line.caption = caption
    }
    for (let index = kept; index < rows.length; index++) add_row(rows[index])
    appended = diff.append
  }
  table.tags = { keys, heads: rows.map(row => row.head), tails: rows.map(row => row.tail) }
  const view = activity_state.activity_view(player.index)
  const last_key = keys.length > 0 ? keys[keys.length - 1] : undefined
  if (activity_state.activity_should_scroll(view, appended, last_key)) (scroll as ScrollPaneGuiElement).scroll_to_bottom()

  const filters = header[ui_constants.TRACKER.filters]
  if (filters?.valid) { for (const button of filters.children) { const flag = button.tags.airi_activity_filter; if (typeof flag === 'number') (button as ButtonGuiElement).toggled = activity_state.activity_filter_selected(mask, flag) } }
  const live = header[ui_constants.TRACKER.live]
  if (live?.valid) {
    const unseen = view.follow ? { count: 0, overflow: false } : activity_state.activity_unseen(keys, view.seen_key)
    const tone: Tone = view.follow ? 'good' : unseen.count > 0 ? 'warn' : 'muted'
    const state = view.follow ? 'LIVE' : unseen.count > 0 ? `${unseen.count}${unseen.overflow ? '+' : ''} NEW` : 'PAUSED'
    live.caption = gui_text.trusted_rich_text(`[img=${TONE_SPRITES[tone]}] ${state}`)
    live.tooltip = view.follow ? 'Following the newest activity. Scrolling the feed stops following; so does clicking here.' : 'Not following, so the feed stays where you left it. Click to jump to the newest activity and follow it again.'
  }
  const count = header[ui_constants.TRACKER.count]
  if (count?.valid) count.caption = mask === activity_state.ACTIVITY_FILTER_ALL ? `${total} event${total === 1 ? '' : 's'}` : `${entries.length}/${total}`
}
/** The rendered activity feed for a player, if their console is open. */
function activity_scroll_of(player: LuaPlayer) {
  const root = player.gui.screen[ui_constants.ROOT_NAME]; const columns = root?.valid ? root[ui_constants.COLUMNS_NAME] : undefined; const left = columns?.valid ? columns[ui_constants.LEFT_COLUMN_NAME] : undefined
  const page = left?.valid ? console_ui.console_tab_page(left, 'activity') : undefined
  const section = page?.[ui_constants.CONSOLE_TABS.activity_section]; const body = section?.valid ? section[ui_constants.CONSOLE_TABS.activity_section_body] : undefined
  const scroll = body?.valid ? body[ui_constants.TRACKER.activity_scroll] : undefined
  return scroll?.valid ? scroll : undefined
}
/** Key of the newest row currently drawn in a feed, which is what the player could see. */
function last_shown_activity_key(scroll: LuaGuiElement | undefined) {
  const table = scroll?.valid ? scroll[ui_constants.TRACKER.activity_table] : undefined
  const keys = table?.valid ? table.tags.keys as string[] | undefined : undefined
  return keys !== undefined && keys.length > 0 ? keys[keys.length - 1] : undefined
}
function add_slot_grid(parent: LuaGuiElement, slots: Array<{ name: string, count: number, tooltip: string }>, style: 'slot_button' | 'yellow_slot_button', rows: number, columns: number) {
  const height = rows * ui_constants.RESOURCE_LAYOUT.slot_size
  const scroll = parent.add({ type: 'scroll-pane', style: 'deep_slots_scroll_pane', horizontal_scroll_policy: 'never', vertical_scroll_policy: 'auto-and-reserve-space' }); scroll.style.width = columns * ui_constants.RESOURCE_LAYOUT.slot_size + ui_constants.RESOURCE_LAYOUT.scrollbar_width; scroll.style.height = height; scroll.style.minimal_height = height; scroll.style.maximal_height = height
  const grid = scroll.add({ type: 'table', column_count: columns, style: 'slot_table' }); for (const slot of slots) grid.add({ type: 'sprite-button', sprite: item_sprite(slot.name), number: slot.count, style, tooltip: slot.tooltip })
}
function render_inventory(parent: LuaGuiElement, runtime: TaskBoardUiRuntimeSnapshot, player: LuaPlayer) { const { header, body } = create_section(parent, 'NPC Inventory', ui_constants.RESOURCE_LAYOUT.inventory_section_width, undefined, false); header.add({ type: 'label', caption: `${runtime.inventory.length} items`, style: 'semibold_label' }); add_slot_grid(body, runtime.inventory.map(item => ({ name: item.name, count: item.count, tooltip: gui_text.trusted_rich_text(`${item_caption(item.name)} × ${item.count}`) })), 'slot_button', task_board_resource_rows(player_gui_height(player)), ui_constants.RESOURCE_LAYOUT.inventory_slot_columns) }
function render_wanted_items(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, player: LuaPlayer) { const { header, body } = create_section(parent, 'Wanted / Needed', ui_constants.RESOURCE_LAYOUT.wanted_section_width, undefined, false); const items = board?.wanted_items ?? []; header.add({ type: 'label', caption: `${items.length} items`, style: 'semibold_label' }); add_slot_grid(body, items.slice(0, ui_constants.MAX_WANTED_ITEMS).map(item => ({ name: item.name, count: item.count, tooltip: gui_text.trusted_rich_text(`${item_caption(item.name)} × ${item.count}`) })), 'yellow_slot_button', task_board_wanted_rows(player_gui_height(player)), ui_constants.RESOURCE_LAYOUT.wanted_slot_columns) }
function render_resource_sidebar(parent: LuaGuiElement, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot, player: LuaPlayer) {
  const sidebar = parent.add({ type: 'flow', direction: 'vertical' }); sidebar.style.width = ui_constants.RESOURCE_LAYOUT.wanted_section_width; sidebar.style.vertical_spacing = ui_constants.COLUMN_SPACING
  render_wanted_items(sidebar, board, player)
  const { body } = create_section(sidebar, 'Equipped', ui_constants.RESOURCE_LAYOUT.wanted_section_width, undefined, false)
  // Nest the row helper here rather than allocating two more module-scope Lua
  // locals for add_equipped_row/render_equipped.
  const add_equipped_row = (caption: string, items: TaskBoardUiItem[]) => {
    const row = body.add({ type: 'flow', direction: 'horizontal' }); row.style.vertical_align = 'center'; row.style.horizontal_spacing = 4
    const label = row.add({ type: 'label', caption, style: 'semibold_label' }); label.style.minimal_width = ui_constants.RESOURCE_LAYOUT.equipped_label_width
    const slots = row.add({ type: 'table', column_count: ui_constants.RESOURCE_LAYOUT.equipped_slot_columns, style: 'slot_table' })
    for (let index = 0; index < ui_constants.RESOURCE_LAYOUT.equipped_slot_columns; index++) {
      const item = items[index]
      if (item !== undefined) slots.add({ type: 'sprite-button', sprite: item_sprite(item.name), number: item.count, style: 'slot_button', tooltip: gui_text.trusted_rich_text(`${item_caption(item.name)} × ${item.count}`) })
      else slots.add({ type: 'sprite-button', style: 'slot_button', tooltip: `Empty ${caption.toLowerCase()} slot` })
    }
  }
  add_equipped_row('GUN', runtime.guns)
  add_equipped_row('AMMO', runtime.ammo)
}
function render_prompt(parent: LuaGuiElement, player: LuaPlayer) {
  const section = parent.add({ type: 'frame', name: ui_constants.PROMPT_SECTION_NAME, direction: 'vertical', style: 'inside_shallow_frame' }); section.style.width = ui_constants.LEFT_COLUMN_WIDTH; section.style.horizontally_stretchable = false
  const header = section.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' }); header.style.horizontally_stretchable = true; header.style.vertical_align = 'center'
  header.add({ type: 'label', caption: 'Prompt SGLuna', style: 'subheader_caption_label' })
  const row = section.add({ type: 'flow', name: ui_constants.PROMPT_FLOW_NAME, direction: 'horizontal' }); row.style.padding = ui_constants.SECTION_PADDING; row.style.horizontally_stretchable = true; row.style.vertical_align = 'center'; row.style.horizontal_spacing = 8
  const field = row.add({ type: 'textfield', name: ui_constants.PROMPT_FIELD_NAME, text: task_board_ui_prompt_draft(player.index), tooltip: 'Send a prompt directly to SGLuna without typing !luna in chat. Press Enter to send.' }); field.style.width = ui_constants.PROMPT_FIELD_WIDTH; field.style.minimal_width = ui_constants.PROMPT_FIELD_WIDTH; field.style.maximal_width = ui_constants.PROMPT_FIELD_WIDTH
  const send_pending = task_board_ui_prompt_send_pending(player.index, game.tick)
  const send = row.add({ type: 'button', name: ui_constants.PROMPT_SEND_BUTTON_NAME, caption: send_pending ? 'SENDING...' : 'SEND', style: 'confirm_button', tooltip: send_pending ? 'Waiting for SGLuna runtime to pick up this prompt.' : 'Send this prompt directly to SGLuna' }) as ButtonGuiElement; send.style.width = ui_constants.PROMPT_SEND_WIDTH; send.style.minimal_width = ui_constants.PROMPT_SEND_WIDTH; send.style.maximal_width = ui_constants.PROMPT_SEND_WIDTH; send.style.height = ui_constants.COMPACT_BUTTON_HEIGHT
  send.enabled = !send_pending
}
function selected_console_tab(player: LuaPlayer): ui_constants.ConsoleTab { return console_ui.console_tab_of(storage.airi_task_board_tab?.[player.index]) ?? 'now' }
function resources_signature(player: LuaPlayer, board: TaskBoardUiSnapshot | undefined, runtime: TaskBoardUiRuntimeSnapshot) {
  return helpers.table_to_json({ inventory: runtime.inventory, guns: runtime.guns, ammo: runtime.ammo, wanted: board?.wanted_items, height: player_gui_height(player) })
}
/** Rebuild one card only when what it shows changes, so the others and the window stay put. */
function refresh_slot(slot: LuaGuiElement, signature: string, build: (this: void, slot: LuaGuiElement) => void) {
  if (slot.tags.signature === signature) return
  slot.clear(); build(slot); slot.tags = { signature }
}
function slot_of(parent: LuaGuiElement, name: string) {
  const existing = parent[name]; if (existing?.valid) return existing
  const slot = parent.add({ type: 'flow', name, direction: 'vertical', tags: { signature: '' } }); slot.style.width = ui_constants.LEFT_COLUMN_WIDTH; return slot
}
/** The blocked banner, NOW's Goal and Now cards and PLAN's Goal card each update on their own. None owns a scroll-pane. */
function build_left_dynamic(banner: LuaGuiElement, now: LuaGuiElement, plan: LuaGuiElement, player: LuaPlayer, board: TaskBoardUiSnapshot | undefined) {
  const goal = console_goal_card(board); const now_card = console_now_card(board); const goal_signature = helpers.table_to_json(goal)
  refresh_slot(banner, helpers.table_to_json({ blocked: board?.blocked, status: board?.status, blocker: board?.blocker, blocker_summary: board?.blocker_summary, choice_pending: task_board_ui_blocked_choice_pending(player.index, game.tick) }), slot => render_blocked(slot, player, board))
  refresh_slot(slot_of(now, ui_constants.NOW_GOAL_SLOT_NAME), goal_signature, slot => console_ui.render_goal_card(slot, goal))
  refresh_slot(slot_of(now, ui_constants.NOW_CARD_SLOT_NAME), helpers.table_to_json(now_card), slot => console_ui.render_now_card(slot, now_card))
  refresh_slot(plan, goal_signature, slot => console_ui.render_goal_card(slot, goal))
}
function build_columns(columns: LuaGuiElement, player: LuaPlayer) {
  const board = storage.airi_task_board_ui; const runtime = runtime_snapshot()
  const left = columns.add({ type: 'flow', name: ui_constants.LEFT_COLUMN_NAME, direction: 'vertical' }); left.style.width = ui_constants.LEFT_COLUMN_WIDTH; left.style.vertical_spacing = ui_constants.COLUMN_SPACING
  // The blocked banner sits above the tabs so a plan waiting on the player is seen whichever tab is open.
  const banner = left.add({ type: 'flow', name: ui_constants.CONSOLE_TABS.banner, direction: 'vertical' }); banner.style.width = ui_constants.LEFT_COLUMN_WIDTH
  const pages = console_ui.render_console_tabs(left, selected_console_tab(player))
  const dynamic = pages.now.add({ type: 'flow', name: ui_constants.LEFT_DYNAMIC_NAME, direction: 'vertical' }); dynamic.style.width = ui_constants.LEFT_COLUMN_WIDTH; dynamic.style.vertical_spacing = ui_constants.COLUMN_SPACING
  const plan_dynamic = pages.plan.add({ type: 'flow', name: ui_constants.CONSOLE_TABS.plan_dynamic, direction: 'vertical' }); plan_dynamic.style.width = ui_constants.LEFT_COLUMN_WIDTH
  build_left_dynamic(banner, dynamic, plan_dynamic, player, board)
  // The conversation hosts itself beside dynamic (in the NOW page), outside the flow that is cleared.
  debug_ui.render_ai_reply(dynamic, board?.response ?? '', ui_constants.LEFT_COLUMN_WIDTH)
  render_tracker(pages.plan, board, player); render_activity_section(pages.activity, board, player)
  render_prompt(left, player)
  const action_state = console_action_state(player, board, runtime)
  console_ui.render_action_row(left, action_state)
  const actions = left[ui_constants.ACTIONS_NAME]; if (actions?.valid) actions.tags = { signature: helpers.table_to_json(action_state) }
  const right = columns.add({ type: 'flow', name: ui_constants.RIGHT_COLUMN_NAME, direction: 'vertical' }); right.style.width = ui_constants.PREVIEW_COLUMN_WIDTH; right.style.vertical_spacing = ui_constants.COLUMN_SPACING; right.style.vertically_stretchable = true; render_world_preview(right, runtime, player)
  const resources = right.add({ type: 'flow', name: ui_constants.RIGHT_RESOURCES_NAME, direction: 'horizontal' }); resources.style.horizontal_spacing = ui_constants.COLUMN_SPACING; resources.style.vertical_align = 'top'; render_inventory(resources, runtime, player); render_resource_sidebar(resources, board, runtime, player); resources.tags = { signature: resources_signature(player, board, runtime) }
}
function refresh_columns(columns: LuaGuiElement, player: LuaPlayer) {
  const left = columns[ui_constants.LEFT_COLUMN_NAME]; const right = columns[ui_constants.RIGHT_COLUMN_NAME]
  if (!left?.valid || !right?.valid) return false
  // A console built before the tabs existed has none of these, and is rebuilt.
  const banner = left[ui_constants.CONSOLE_TABS.banner]; const now = console_ui.console_tab_page(left, 'now'); const plan = console_ui.console_tab_page(left, 'plan'); const activity = console_ui.console_tab_page(left, 'activity')
  const dynamic = now?.[ui_constants.LEFT_DYNAMIC_NAME]; const plan_dynamic = plan?.[ui_constants.CONSOLE_TABS.plan_dynamic]
  if (!banner?.valid || now === undefined || plan === undefined || activity === undefined || !dynamic?.valid || !plan_dynamic?.valid) return false
  const board = storage.airi_task_board_ui; const runtime = runtime_snapshot()
  // The tracker and the feed are never cleared on a routine refresh: they own scroll-panes.
  if (!refresh_tracker(plan, board, player) || !refresh_activity_section(activity, board, player)) return false
  build_left_dynamic(banner, dynamic, plan_dynamic, player, board)
  // Current Task Conversation intentionally lives outside the dynamic flow so
  // its scroll position survives refreshes. That also means it must be
  // explicitly refreshed here; otherwise snapshots update storage while an
  // already-open console keeps stale rows until it is closed and reopened.
  debug_ui.render_ai_reply(dynamic, board?.response ?? '', ui_constants.LEFT_COLUMN_WIDTH)
  if (!console_ui.apply_console_tab(left, selected_console_tab(player))) return false
  const actions = left[ui_constants.ACTIONS_NAME]
  const action_state = console_action_state(player, board, runtime)
  const action_signature = helpers.table_to_json(action_state)
  if (!actions?.valid || actions.tags.signature !== action_signature) { if (actions?.valid) actions.destroy(); console_ui.render_action_row(left, action_state); const rebuilt_actions = left[ui_constants.ACTIONS_NAME]; if (rebuilt_actions?.valid) rebuilt_actions.tags = { signature: action_signature } }
  // Never clear the preview column on a routine refresh: it owns the zoom slider.
  const resources = right[ui_constants.RIGHT_RESOURCES_NAME]
  if (!refresh_world_preview(right, runtime, player) || !resources?.valid) {
    right.clear()
    render_world_preview(right, runtime, player)
    const rebuilt_resources = right.add({ type: 'flow', name: ui_constants.RIGHT_RESOURCES_NAME, direction: 'horizontal' }); rebuilt_resources.style.horizontal_spacing = ui_constants.COLUMN_SPACING; rebuilt_resources.style.vertical_align = 'top'; render_inventory(rebuilt_resources, runtime, player); render_resource_sidebar(rebuilt_resources, board, runtime, player); rebuilt_resources.tags = { signature: resources_signature(player, board, runtime) }
    return true
  }
  const resource_signature = resources_signature(player, board, runtime)
  if (resources.tags.signature !== resource_signature) { resources.clear(); render_inventory(resources, runtime, player); render_resource_sidebar(resources, board, runtime, player); resources.tags = { signature: resource_signature } }
  return true
}
function build_panel(player: LuaPlayer) {
  const previous_location = destroy_panel(player)
  const root = player.gui.screen.add({ type: 'frame', name: ui_constants.ROOT_NAME, direction: 'vertical' }) as FrameGuiElement
  if (previous_location !== undefined) root.location = previous_location
  else root.auto_center = true
  console_ui.render_console_titlebar(root, 'SGLuna NPC Console', console_window_buttons(player), console_title_status(storage.airi_task_board_ui, runtime_snapshot(), storage.airi_task_board_ui_synced_tick))
  const columns = root.add({ type: 'flow', name: ui_constants.COLUMNS_NAME, direction: 'horizontal' }); columns.style.horizontal_spacing = ui_constants.COLUMN_SPACING; build_columns(columns, player); root.bring_to_front()
}
function render_panel(player: LuaPlayer) {
  if (!task_board_ui_is_open(player.index)) { destroy_panel(player); return }
  const root = player.gui.screen[ui_constants.ROOT_NAME]; const columns = root?.valid ? root[ui_constants.COLUMNS_NAME] : undefined
  if (columns?.valid && refresh_columns(columns, player) && root !== undefined && console_ui.refresh_console_titlebar(root as FrameGuiElement, console_window_buttons(player), console_title_status(storage.airi_task_board_ui, runtime_snapshot(), storage.airi_task_board_ui_synced_tick))) return
  build_panel(player)
}
// The skills window owns its own refresh; it redraws only what changed.
function render_skills_popout(player: LuaPlayer) { skills_ui.render_skills_window(player, task_board_ui_is_open(player.index) && task_board_skills_ui_is_open(player.index)) }
function render_debug_popout(player: LuaPlayer) { render_task_board_debug_popout(player, task_board_ui_is_open(player.index), storage.airi_task_board_ui, runtime_snapshot(), storage.airi_task_board_ui_synced_tick) }
function render(player: LuaPlayer) { ensure_button(player); render_panel(player); render_skills_popout(player); project_ui.render_projects_popout(player, task_board_ui_is_open(player.index), storage.airi_task_board_ui?.goal_id ?? ''); render_debug_popout(player) }
function render_all() { for (const player of game.connected_players) { ensure_button(player); render_panel(player); render_skills_popout(player); project_ui.render_projects_popout(player, task_board_ui_is_open(player.index), storage.airi_task_board_ui?.goal_id ?? ''); render_debug_popout(player) } }
function prompt_field(player: LuaPlayer) { const root = player.gui.screen[ui_constants.ROOT_NAME]; const columns = root?.valid ? root[ui_constants.COLUMNS_NAME] : undefined; const left = columns?.valid ? columns[ui_constants.LEFT_COLUMN_NAME] : undefined; const section = left?.valid ? left[ui_constants.PROMPT_SECTION_NAME] : undefined; const row = section?.valid ? section[ui_constants.PROMPT_FLOW_NAME] : undefined; const field = row?.valid ? row[ui_constants.PROMPT_FIELD_NAME] : undefined; return field?.valid ? field as TextFieldGuiElement : undefined }
function submit_prompt(player: LuaPlayer, raw: unknown) { if (!emit_prompt(player, raw)) return false; mark_prompt_sent(player.index); const field = prompt_field(player); if (field !== undefined) field.text = ''; render_panel(player); return true }
function handle_control_click(player: LuaPlayer, element_name: string) {
  const blocked_action: TaskBoardUiControlAction | undefined = element_name === ui_constants.BLOCKED_KEEP_PAUSED_BUTTON_NAME
    ? 'keep_paused'
    : element_name === ui_constants.BLOCKED_REVISE_BUTTON_NAME
      ? 'revise'
      : element_name === ui_constants.BLOCKED_CANCEL_BUTTON_NAME
        ? 'cancel'
        : undefined
  if (blocked_action !== undefined) {
    // The names are only rendered for a blocked plan, but verify the current
    // snapshot again so an old GUI click cannot race a fresh state transition.
    if (storage.airi_task_board_ui?.status !== 'blocked' || task_board_ui_blocked_choice_pending(player.index, game.tick)) return true
    clear_terminate_confirmation(player.index)
    mark_blocked_choice_sent(player.index)
    emit_control(player, blocked_action)
    render_panel(player)
    return true
  }
  if (element_name === ui_constants.PAUSE_BUTTON_NAME) {
    if (LIFECYCLE.current(player.index) !== undefined) return true
    clear_terminate_confirmation(player.index)
    const action: TaskBoardUiLifecycleAction = storage.airi_task_board_ui?.status === 'paused' ? 'resume' : 'pause'
    if (LIFECYCLE.begin(player.index, action)) {
      if (action === 'resume') emit_resume(player)
      else emit_control(player, 'pause')
    }
    render_panel(player)
    return true
  }
  if (element_name === ui_constants.TERMINATE_BUTTON_NAME) {
    if (LIFECYCLE.current(player.index) !== undefined) return true
    if (task_board_ui_terminate_is_armed(player.index, game.tick)) {
      clear_terminate_confirmation(player.index)
      if (LIFECYCLE.begin(player.index, 'terminate')) {
        debug_ui.suppress_snapshot(storage.airi_task_board_ui)
        debug_ui.reset_task_conversation()
        activity_state.clear_activity_history()
        emit_control(player, 'terminate')
      }
      close_more_menu(player.index)
    } else arm_terminate(player.index)
    render_panel(player)
    return true
  }
  if (element_name === ui_constants.MORE_BUTTON_NAME) {
    const open = storage.airi_task_board_more_open ?? {}
    open[player.index] = open[player.index] !== true
    storage.airi_task_board_more_open = open
    // Closing the menu also disarms a pending TERMINATE confirmation.
    if (open[player.index] !== true) clear_terminate_confirmation(player.index)
    render_panel(player)
    return true
  }
  if (element_name === ui_constants.FOLLOW_BUTTON_NAME) { clear_terminate_confirmation(player.index); const follow = read_follow_status(); emit_control(player, follow?.active ? 'stop_follow' : 'follow'); return true }
  if (element_name === ui_constants.NEW_TASK_BUTTON_NAME) { if (LIFECYCLE.current(player.index) !== undefined) return true; clear_terminate_confirmation(player.index); debug_ui.suppress_snapshot(storage.airi_task_board_ui); debug_ui.reset_task_conversation(); activity_state.clear_activity_history(); emit_control(player, 'new_task'); close_more_menu(player.index); render_panel(player); return true }
  if (element_name === ui_constants.PROMPT_SEND_BUTTON_NAME) { if (task_board_ui_prompt_send_pending(player.index, game.tick)) return true; submit_prompt(player, task_board_ui_prompt_draft(player.index)); return true }
  return false
}

export function create_task_board_ui_remote_interface() {
  create_skill_remote_interface(); create_learning_remote_interface()
  remote.add_interface('autorio_task_board', {
    set_snapshot: (value: unknown, generation?: unknown, revision?: unknown) => {
      if (!debug_ui.accept_sync_version(generation, revision)) return true
      const next = sanitize_task_board_ui_snapshot(value)
      if (next === undefined) return false
      const previous = storage.airi_task_board_ui
      const changed_task = activity_state.bind_activity_context(next.conversation_id, next.goal_id)
      const stamped = stamp_activity_times(next, changed_task ? undefined : previous, game.tick)
      activity_state.merge_activity_history(stamped.activity)
      storage.airi_task_board_ui = stamped
      storage.airi_task_board_ui_synced_tick = game.tick
      provider_ui.remember_provider_model(stamped.debug?.provider_model)
      project_ui.record_project_snapshot(stamped, game.tick)
      try { handle_task_board_learning_transition(previous, stamped) }
      catch (error) { log(`[SGLuna learning] completion learning skipped: ${error instanceof Error ? error.message : 'unknown error'}`) }
      render_all()
      return true
    },
    clear: (generation?: unknown, revision?: unknown) => {
      if (!debug_ui.accept_sync_version(generation, revision)) return true
      activity_state.clear_activity_history()
      storage.airi_task_board_ui = undefined
      storage.airi_task_board_ui_synced_tick = game.tick
      render_all()
      return true
    },
    ack_lifecycle: (player_index: unknown, action: unknown) => { const index = integer(player_index); const kind: TaskBoardUiLifecycleAction | undefined = action === 'pause' || action === 'resume' || action === 'terminate' ? action : undefined; if (index < 1 || kind === undefined) return false; LIFECYCLE.ack(index, kind); render_all(); return true },
    status: () => storage.airi_task_board_ui,
    sync_version: () => debug_ui.current_sync_version(),
    drain_inputs: () => drain_ui_inputs(),
  })
  // Joining re-rolls which avatar variant this player sees, so the console does
  // not look identical every session. The roll lands in synchronized storage
  // here rather than being decided while drawing, which would make the button a
  // client-local decision.
  //
  // The console never reopens itself on join, even if this player left it open
  // last session: rebuilding the panel rebinds the live remote-position camera,
  // and doing that automatically right as a peer's own simulation is still
  // settling into the game reproduced a real multiplayer desync. Requiring an
  // explicit click keeps that rebuild off every join transition, not just the
  // exact join tick. A short chat line stands in for the first few seconds so
  // the player still has an immediate read on AIRI without needing to open
  // anything - plain player-local text, no GUI or camera involved.
  script.on_event(defines.events.on_player_joined_game, (event: any) => {
    const player = game.get_player(event.player_index)
    if (!player?.valid) return
    provider_ui.roll_provider_avatar(player.index, game.tick)
    close_task_board_ui(player.index)
    destroy_panel(player)
    ensure_button(player)
    player.print(join_status_line())
  })
  script.on_event(defines.events.on_gui_click, (event: any) => {
    const element = event.element; if (!element?.valid || element.player_index !== event.player_index) return; const player = game.get_player(event.player_index); if (!player?.valid) return
    if (element.name === ui_constants.BUTTON_NAME) { toggle_task_board_ui_open(player.index); render(player); return }
    if (!task_board_ui_is_open(player.index)) return
    if (element.name === ui_constants.PREVIEW_POSITION_NAME) { focus_npc_preview(player); return }
    if (element.name === ui_constants.CLOSE_BUTTON_NAME) { clear_terminate_confirmation(player.index); close_task_board_ui(player.index); close_task_board_skills_ui(player.index); project_ui.close_projects_ui(player.index); debug_ui.close_debug_ui(player.index); skills_ui.close_skills_window(player); project_ui.render_projects_popout(player, false); render_debug_popout(player); destroy_panel(player); ensure_button(player); return }
    if (element.name === project_ui.PROJECTS_BUTTON_NAME) { project_ui.toggle_projects_ui(player.index); render_panel(player); project_ui.render_projects_popout(player, true, storage.airi_task_board_ui?.goal_id ?? ''); return }
    if (element.name === project_ui.PROJECTS_CLOSE_BUTTON_NAME) { project_ui.close_projects_ui(player.index); project_ui.render_projects_popout(player, true, storage.airi_task_board_ui?.goal_id ?? ''); render_panel(player); return }
    if (project_ui.handle_project_export_click(player, element.name, storage.airi_task_board_ui?.goal_id ?? '')) return
    if (element.name === ui_constants.SKILLS_BUTTON_NAME) { toggle_task_board_skills_ui_open(player.index); render_panel(player); render_skills_popout(player); return }
    if (element.name === ui_constants.SKILLS_CLOSE_BUTTON_NAME) { close_task_board_skills_ui(player.index); skills_ui.close_skills_window(player); render_panel(player); return }
    if (element.name === debug_ui.DEBUG_BUTTON_NAME) { debug_ui.toggle_debug_ui(player.index); render_panel(player); render_debug_popout(player); return }
    if (element.name === debug_ui.DEBUG_CLOSE_BUTTON_NAME) { debug_ui.close_debug_ui(player.index); render_debug_popout(player); render_panel(player); return }
    if (element.name === debug_ui.DEBUG_ACTIVITY_STATE_NAME) { debug_ui.toggle_debug_activity_follow(player.index); render_debug_popout(player); return }
    const tab = console_ui.console_tab_of(element.tags?.[ui_constants.CONSOLE_TABS.tag])
    if (tab !== undefined) {
      const selected = storage.airi_task_board_tab ?? {}; selected[player.index] = tab; storage.airi_task_board_tab = selected
      // Only visibility changes, so nothing is rebuilt and no scroll position is lost.
      const root = player.gui.screen[ui_constants.ROOT_NAME]; const columns = root?.valid ? root[ui_constants.COLUMNS_NAME] : undefined; const left = columns?.valid ? columns[ui_constants.LEFT_COLUMN_NAME] : undefined
      if (!left?.valid || !console_ui.apply_console_tab(left, tab)) render_panel(player)
      return
    }
    if (element.name === ui_constants.TRACKER.live || element.name === debug_ui.CONVERSATION_STATE_NAME) {
      const scroll = activity_scroll_of(player); const view = activity_state.activity_view(player.index)
      if (view.follow) activity_state.stop_activity_follow(player.index, last_shown_activity_key(scroll))
      else activity_state.resume_activity_follow(player.index, last_shown_activity_key(scroll))
      render_panel(player); return
    }
    const filter_flag = element.tags?.airi_activity_filter
    if (typeof filter_flag === 'number' && element.tags?.airi_activity_surface === 'projects') { activity_state.toggle_activity_filter(player.index, filter_flag, 'projects'); project_ui.render_projects_popout(player, true, storage.airi_task_board_ui?.goal_id ?? ''); return }
    if (typeof filter_flag === 'number') { activity_state.toggle_activity_filter(player.index, filter_flag); if (activity_state.activity_view(player.index).follow) activity_state.reset_activity_view(player.index); render_panel(player); return }
    if (skills_ui.handle_skills_window_click(player, element.name)) return
    if (handle_learning_ui_click(player, element.name)) { render_skills_popout(player); return }
    if (handle_skill_export_click(player, element.name)) { render_skills_popout(player); return }
    handle_control_click(player, element.name)
  })
  // One handler per event per mod: list-box selections for both Old tasks and Skills go through here.
  script.on_event(defines.events.on_gui_selection_state_changed, (event: any) => {
    const element = event.element; if (!element?.valid || element.player_index !== event.player_index) return
    const player = game.get_player(event.player_index); if (!player?.valid) return
    if (!project_ui.handle_project_selection(player, element)) skills_ui.handle_skills_window_selection(player, element)
  })
  script.on_event(defines.events.on_gui_text_changed, (event: any) => { const element = event.element; if (!element?.valid || element.player_index !== event.player_index || element.name !== ui_constants.PROMPT_FIELD_NAME || !task_board_ui_is_open(event.player_index)) return; set_prompt_draft(event.player_index, element.text) })
  script.on_event(defines.events.on_gui_confirmed, (event: any) => { const element = event.element; if (!element?.valid || element.player_index !== event.player_index || element.name !== ui_constants.PROMPT_FIELD_NAME || !task_board_ui_is_open(event.player_index)) return; const player = game.get_player(event.player_index); if (!player?.valid) return; submit_prompt(player, element.text) })
  // Scrolling up to read either feed ends follow. Scrolling down does not
  // implicitly resume it; the reader uses LIVE to jump back to the newest row.
  // The inputs listen without consuming, so the pane still scrolls normally.
  const on_activity_wheel = (event: any) => {
    if (!event.in_gui || !task_board_ui_is_open(event.player_index)) return
    let element = event.element; let depth = 0
    while (element?.valid && element.name !== ui_constants.TRACKER.activity_scroll && element.name !== debug_ui.CONVERSATION_SCROLL_NAME && depth < 6) { element = element.parent; depth++ }
    if (!element?.valid || element.player_index !== event.player_index || (element.name !== ui_constants.TRACKER.activity_scroll && element.name !== debug_ui.CONVERSATION_SCROLL_NAME)) return
    const player = game.get_player(event.player_index); if (!player?.valid) return
    if (activity_state.stop_activity_follow(player.index, last_shown_activity_key(activity_scroll_of(player)))) render_panel(player)
  }
  script.on_event(ui_constants.TRACKER.scroll_up_input, on_activity_wheel)
  script.on_event(defines.events.on_gui_value_changed, (event: any) => {
    const element = event.element; if (!element?.valid || element.player_index !== event.player_index || element.name !== ui_constants.PREVIEW_ZOOM_SLIDER_NAME || !task_board_ui_is_open(event.player_index)) return; const player = game.get_player(event.player_index); if (!player?.valid) return
    const zoom = set_preview_zoom(player.index, element.slider_value); element.slider_value = zoom
    const row = element.parent; const value = row?.valid ? row[ui_constants.PREVIEW_ZOOM_VALUE_NAME] : undefined; if (value?.valid) value.caption = preview_zoom_caption(zoom)
    const body = row?.parent; const frame = body?.valid ? body[ui_constants.PREVIEW_CAMERA_FRAME_NAME] : undefined; const camera = frame?.valid ? frame[ui_constants.PREVIEW_CAMERA_NAME] : undefined; if (camera?.valid) camera.zoom = zoom
  })
  script.on_nth_tick(60, () => { for (const player of game.connected_players) { if (!task_board_ui_is_open(player.index)) continue; render_panel(player); render_skills_popout(player); render_debug_popout(player) } })
}
