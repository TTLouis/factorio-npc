import type { LuaGuiElement } from 'factorio:runtime'

import type { TaskBoardUiActivity } from './task_board_ui'

/**
 * Filtering and follow state for the console's Recent activity feed.
 *
 * Everything persisted here is driven only by synchronized game input/state.
 * Reading mode changes only through synchronized scroll/custom-input or explicit
 * LIVE/PAUSED clicks; pointer-local state is deliberately not modeled here.
 * This module lives apart from task_board_ui because TSTL emits each
 * module-scope constant and helper as a Lua local, and that module is already
 * close to Factorio's 200-locals-per-function limit.
 */

type ActivityKind = TaskBoardUiActivity['kind']

export interface ActivityFilter { caption: string, flag: number, tooltip: string }

// Flags are powers of two combined by plain arithmetic, never bitwise operators:
// TSTL's JIT target emits `bit.band`, and Factorio's Lua has no `bit` library.
// Keep every visible caption to three glyphs so the auto-sized Factorio buttons
// stay visually uniform next to the hard-coded ALL button in task_board_ui.
export const ACTIVITY_FILTERS: ActivityFilter[] = [
  { caption: 'PLN', flag: 1, tooltip: 'Plan decisions' },
  { caption: 'OBS', flag: 2, tooltip: 'Observations and notes' },
  { caption: 'ACT', flag: 4, tooltip: 'Actions' },
  { caption: 'RES', flag: 8, tooltip: 'Results' },
  { caption: 'ISS', flag: 16, tooltip: 'Blockers and system events' },
]
export const ACTIVITY_FILTER_ALL = 31
const ACTIVITY_HISTORY_LIMIT = 160

// Wide enough for the longest LIVE / PAUSED / "n NEW" caption, so nothing beside
// the button shifts when the reading mode changes.
export const FEED_STATE_BUTTON_WIDTH = 76
const FEED_BUTTON_HEIGHT = 24

/**
 * Feed controls belong in the heading of the section they filter, never in a
 * second header row inside its body. A default-height button would make that
 * heading taller than a section title, so every feed in the console - Plan
 * Tracker, Conversation, Projects - sizes its controls through here and the
 * headings read as one pattern.
 */
export function style_feed_button(button: LuaGuiElement, minimal_width = 0) {
  button.style.height = FEED_BUTTON_HEIGHT
  button.style.minimal_width = minimal_width
  button.style.top_padding = 0
  button.style.bottom_padding = 0
  button.style.left_padding = 4
  button.style.right_padding = 4
  button.style.font = 'default-small-semibold'
  return button
}

export interface ActivityView {
  // Scroll to each new event as it arrives.
  follow: boolean
  // New rows were appended while follow was paused; catch up once it resumes.
  behind: boolean
  // The last event the player has seen. Everything after it counts as new.
  seen_key?: string
}

declare const storage: {
  airi_task_board_activity_filter?: Record<number, number>
  airi_task_board_activity_filters?: Record<number, number>
  airi_task_board_project_activity_filters?: Record<number, number>
  airi_task_board_activity_view?: Record<number, ActivityView>
  airi_task_board_activity_history?: TaskBoardUiActivity[]
  airi_task_board_activity_history_context?: string
}

function has_flag(mask: number, flag: number) { return math.floor(mask / flag) % 2 === 1 }

function kind_flag(kind: ActivityKind) {
  if (kind === 'decision') return 1
  if (kind === 'observation' || kind === 'note') return 2
  if (kind === 'action') return 4
  if (kind === 'result') return 8
  return 16
}

function normalize_mask(value: unknown) {
  return typeof value === 'number' && value === math.floor(value) && value >= 0 && value <= ACTIVITY_FILTER_ALL ? value : undefined
}

/**
 * Where a feed is shown. The console and the Projects window keep separate
 * selections, so narrowing one feed never hides rows in the other.
 */
export type ActivityFilterSurface = 'console' | 'projects'

function filter_store(surface: ActivityFilterSurface) {
  if (surface === 'projects') {
    if (storage.airi_task_board_project_activity_filters === undefined) storage.airi_task_board_project_activity_filters = {}
    return storage.airi_task_board_project_activity_filters
  }
  if (storage.airi_task_board_activity_filters === undefined) storage.airi_task_board_activity_filters = {}
  return storage.airi_task_board_activity_filters
}

/**
 * The categories this player currently shows. A save from the single-select
 * drop-down stored an index into ALL, PLAN, OBS, ACTIONS, RESULTS, ISSUES; that
 * selection carries over as the equivalent single category on the console.
 */
export function activity_filter_mask(player_index: number, surface: ActivityFilterSurface = 'console') {
  const current = normalize_mask(filter_store(surface)[player_index])
  if (current !== undefined) return current
  if (surface !== 'console') return ACTIVITY_FILTER_ALL
  const legacy = storage.airi_task_board_activity_filter?.[player_index]
  if (legacy === 2) return 1
  if (legacy === 3) return 2
  if (legacy === 4) return 4
  if (legacy === 5) return 8
  if (legacy === 6) return 16
  return ACTIVITY_FILTER_ALL
}

/** Toggle one category, or select every category when `flag` is ALL. */
export function toggle_activity_filter(player_index: number, flag: number, surface: ActivityFilterSurface = 'console') {
  const mask = activity_filter_mask(player_index, surface)
  let next = ACTIVITY_FILTER_ALL
  if (flag !== ACTIVITY_FILTER_ALL) next = has_flag(mask, flag) ? mask - flag : mask + flag
  filter_store(surface)[player_index] = next
  return next
}

export function activity_filter_selected(mask: number, flag: number) {
  return flag === ACTIVITY_FILTER_ALL ? mask === ACTIVITY_FILTER_ALL : has_flag(mask, flag)
}

export function activity_matches_mask(kind: ActivityKind, mask: number) { return has_flag(mask, kind_flag(kind)) }

function activity_context_id(conversation_id: unknown, goal_id: unknown) {
  const conversation = typeof conversation_id === 'string' ? conversation_id : ''
  const goal = typeof goal_id === 'string' ? goal_id : ''
  if (conversation.length > 0) return `conversation:${conversation}`
  if (goal.length > 0) return `goal:${goal}`
  return ''
}

export function bind_activity_context(conversation_id: unknown, goal_id: unknown) {
  const next = activity_context_id(conversation_id, goal_id)
  const current = storage.airi_task_board_activity_history_context ?? ''
  if (current === next) return false
  storage.airi_task_board_activity_history_context = next
  storage.airi_task_board_activity_history = []
  storage.airi_task_board_activity_view = undefined
  return true
}

export function clear_activity_history() {
  storage.airi_task_board_activity_history_context = ''
  storage.airi_task_board_activity_history = []
  storage.airi_task_board_activity_view = undefined
}

/**
 * The time a content-keyed entry (one without an id) was first seen, if it is
 * already retained in history.
 *
 * Snapshots carry a small window, and entries derived from runtime state fall
 * out of it and come back as live events push them around. Stamping only against
 * the previous snapshot gave a returning entry a fresh time, so its key changed
 * and history kept it twice, out of order. `claimed` holds keys this snapshot
 * already assigned, so two identical entries in one snapshot stay distinct.
 */
export function retained_activity_timestamp(kind: string, text: string, claimed: Record<string, boolean>) {
  const history = storage.airi_task_board_activity_history ?? []
  for (let index = history.length - 1; index >= 0; index--) {
    const old = history[index]
    if ((old.id !== undefined && old.id.length > 0) || old.kind !== kind || old.text !== text || !old.timestamp) continue
    if (claimed[activity_key(old)]) continue
    return old.timestamp
  }
  return undefined
}

/**
 * Stable identity for one rendered row. The runtime gives live events an id;
 * derived entries without one fall back to their content, which is stable
 * because timestamps are stamped once and then preserved.
 */
export function activity_key(entry: TaskBoardUiActivity) {
  return entry.id !== undefined && entry.id.length > 0 ? `id:${entry.id}` : `${entry.kind}|${entry.timestamp ?? ''}|${entry.text}`
}

/**
 * Snapshots intentionally carry only a small recent activity window so RCON
 * payloads stay bounded. Preserve those windows locally in synchronized mod
 * storage so the UI can scroll farther back without making every heartbeat
 * larger. Duplicate overlap between snapshots is ignored by stable activity key.
 */
export function merge_activity_history(incoming: TaskBoardUiActivity[]) {
  if (storage.airi_task_board_activity_history === undefined) storage.airi_task_board_activity_history = []
  const history = storage.airi_task_board_activity_history
  for (const entry of incoming) {
    const key = activity_key(entry)
    let seen = false
    for (let index = history.length - 1; index >= 0; index--) {
      if (activity_key(history[index]) !== key) continue
      seen = true
      break
    }
    if (!seen) history.push(entry)
  }
  while (history.length > ACTIVITY_HISTORY_LIMIT) history.shift()
  return history
}

export function activity_history() { return storage.airi_task_board_activity_history ?? [] }

/**
 * How to turn the rows on screen into the rows that should be there without
 * rebuilding the feed, which is what would throw away the player's scroll.
 *
 * The feed only ever grows at the end and is trimmed from the front, so the
 * rows that survive are a suffix of what is shown that is also a prefix of what
 * should be shown. Returns how many leading rows to drop and how many trailing
 * entries to append, or undefined when the two lists do not line up and the
 * feed has to be rebuilt.
 */
export function activity_rows_diff(shown: string[], wanted: string[]) {
  for (let overlap = math.min(shown.length, wanted.length); overlap >= 0; overlap--) {
    if (overlap === 0 && shown.length > 0) return undefined
    let matches = true
    for (let index = 0; index < overlap; index++) {
      if (shown[shown.length - overlap + index] !== wanted[index]) { matches = false; break }
    }
    if (matches) return { drop: shown.length - overlap, append: wanted.length - overlap }
  }
  return undefined
}

/**
 * New events the player has not seen: those after `seen_key`. When that event
 * has already been trimmed out of the feed, every row shown is new and there
 * may be more that were never shown, which `overflow` reports.
 */
export function activity_unseen(keys: string[], seen_key: string | undefined) {
  if (seen_key === undefined) return { count: keys.length, overflow: false }
  for (let index = keys.length - 1; index >= 0; index--) {
    if (keys[index] === seen_key) return { count: keys.length - 1 - index, overflow: false }
  }
  return { count: keys.length, overflow: keys.length > 0 }
}

export function activity_view(player_index: number): ActivityView {
  if (storage.airi_task_board_activity_view === undefined) storage.airi_task_board_activity_view = {}
  let view = storage.airi_task_board_activity_view[player_index]
  if (view === undefined) {
    view = { follow: true, behind: false }
    storage.airi_task_board_activity_view[player_index] = view
  }
  return view
}

/** A freshly opened feed, or one whose contents a filter change replaced. */
export function reset_activity_view(player_index: number) {
  const view = activity_view(player_index)
  view.follow = true
  view.behind = false
  view.seen_key = undefined
  return view
}

/**
 * Take follow away the moment the player scrolls the feed themselves,
 * remembering the newest event they could see at that point. Custom-input
 * activation is synchronized; unlike raw pointer hover it is safe to persist.
 */
export function stop_activity_follow(player_index: number, last_shown_key: string | undefined) {
  const view = activity_view(player_index)
  if (!view.follow) return false
  view.follow = false
  view.behind = false
  view.seen_key = last_shown_key
  return true
}

/**
 * Jump back to the newest event and keep following from there. The feed is
 * marked behind so the next refresh scrolls even though nothing new arrived.
 */
export function resume_activity_follow(player_index: number, last_shown_key: string | undefined) {
  const view = activity_view(player_index)
  view.follow = true
  view.behind = true
  view.seen_key = last_shown_key
  return view
}

/**
 * Whether the feed should scroll to its newest row after a synchronized refresh.
 * Only explicit synchronized follow/pause state affects this behavior.
 */
export function activity_should_scroll(view: ActivityView, appended: number, last_key: string | undefined) {
  if (!view.follow) return false
  view.seen_key = last_key
  const scroll = appended > 0 || view.behind
  view.behind = false
  return scroll
}
