import type { SpritePath } from 'factorio:runtime'

export type Tone = 'good' | 'info' | 'warn' | 'bad' | 'muted'

export const TONE_COLORS: Record<Tone, { r: number, g: number, b: number }> = {
  good: { r: 0.45, g: 0.85, b: 0.35 },
  info: { r: 0.5, g: 0.72, b: 1 },
  warn: { r: 1, g: 0.8, b: 0.3 },
  bad: { r: 1, g: 0.42, b: 0.35 },
  muted: { r: 0.68, g: 0.68, b: 0.68 },
}

export const TONE_SPRITES: Record<Tone, SpritePath> = {
  good: 'utility/status_working',
  info: 'utility/status_blue',
  warn: 'utility/status_yellow',
  bad: 'utility/status_not_working',
  muted: 'utility/status_inactive',
}

export const BUTTON_NAME = 'airi_task_board_button'
export const MOD_GUI_LEGACY_FLOW_NAME = 'mod_gui_button_flow'
export const MOD_GUI_TOP_FRAME_NAME = 'mod_gui_top_frame'
export const MOD_GUI_INNER_FRAME_NAME = 'mod_gui_inner_frame'
export const ROOT_NAME = 'airi_task_board_panel'
export const COLUMNS_NAME = 'airi_task_board_columns'
export const LEFT_COLUMN_NAME = 'airi_task_board_left_column'
export const LEFT_DYNAMIC_NAME = 'airi_task_board_left_dynamic'
export const NOW_GOAL_SLOT_NAME = 'airi_task_board_now_goal'
export const NOW_CARD_SLOT_NAME = 'airi_task_board_now_card'
export const RIGHT_COLUMN_NAME = 'airi_task_board_right_column'
export const RIGHT_RESOURCES_NAME = 'airi_task_board_right_resources'
export const PROMPT_SECTION_NAME = 'airi_task_board_prompt_section'
export const PROMPT_FLOW_NAME = 'airi_task_board_prompt_flow'
// The tracker is built once and then refreshed in place. Rebuilding a
// scroll-pane resets its scroll, and Factorio gives Lua no way to read a scroll
// offset back (it is per-client state, so reading it would desync), which makes
// keeping the element alive the only way to keep the player's position. One
// table for every name keeps this to a single Lua local.
export const TRACKER = {
  section: 'airi_task_board_tracker_section',
  header: 'airi_task_board_tracker_header',
  body: 'airi_task_board_tracker_body',
  summary: 'airi_task_board_tracker_summary',
  empty: 'airi_task_board_tracker_empty',
  workspace: 'airi_task_board_tracker_workspace',
  shelf: 'airi_task_board_tracker_shelf',
  shelf_header: 'airi_task_board_tracker_shelf_header',
  shelf_count: 'airi_task_board_tracker_shelf_count',
  shelf_body: 'airi_task_board_tracker_shelf_body',
  shelf_scroll: 'airi_task_board_tracker_shelf_scroll',
  shelf_table: 'airi_task_board_tracker_shelf_table',
  plan_column: 'airi_task_board_tracker_plan_column',
  plan_header: 'airi_task_board_tracker_plan_header',
  plan_summary: 'airi_task_board_tracker_plan_summary',
  plan_body: 'airi_task_board_tracker_plan_body',
  plan: 'airi_task_board_tracker_plan',
  progress: 'airi_task_board_tracker_progress',
  steps_scroll: 'airi_task_board_tracker_steps',
  steps_table: 'airi_task_board_tracker_steps_table',
  attention: 'airi_task_board_tracker_attention',
  divider: 'airi_task_board_tracker_divider',
  activity_header: 'airi_task_board_activity_header',
  filters: 'airi_task_board_activity_filters',
  live: 'airi_task_board_activity_live',
  count: 'airi_task_board_activity_count',
  activity_empty: 'airi_task_board_activity_empty',
  activity_scroll: 'airi_task_board_activity_scroll',
  activity_table: 'airi_task_board_activity_table',
  // Declared in data.lua. Both listen to the wheel without consuming it.
  scroll_up_input: 'airi-task-board-activity-scroll-up',
  scroll_down_input: 'airi-task-board-activity-scroll-down',
}
// The preview is refreshed in place rather than rebuilt, so every element the
// refresh has to find needs a stable name.
export const PREVIEW_SECTION_NAME = 'airi_task_board_preview_section'
export const PREVIEW_HEADER_NAME = 'airi_task_board_preview_header'
export const PREVIEW_BODY_NAME = 'airi_task_board_preview_body'
export const PREVIEW_POSITION_NAME = 'airi_task_board_preview_position'
export const PREVIEW_CAMERA_FRAME_NAME = 'airi_task_board_preview_camera_frame'
export const PREVIEW_CAMERA_NAME = 'airi_task_board_preview_camera'
export const PREVIEW_ZOOM_SLIDER_NAME = 'airi_task_board_preview_zoom'
export const PREVIEW_ZOOM_VALUE_NAME = 'airi_task_board_preview_zoom_value'
export const SKILLS_ROOT_NAME = 'airi_task_board_skills_panel'
export const SKILLS_BODY_NAME = 'airi_task_board_skills_body'
export const SKILLS_BUTTON_NAME = 'airi_task_board_skills'
export const SKILLS_CLOSE_BUTTON_NAME = 'airi_task_board_skills_close'
export const SKILLS_POPOUT_TITLE = 'Skills & Area Learning'
// Only the fallback the button is created with. What it wears is the avatar of
// whichever provider AIRI is currently talking to, which task_board_provider
// resolves from the reported model identifier on every render.
export const BUTTON_SPRITE: SpritePath = 'entity/character'
export const CLOSE_BUTTON_NAME = 'airi_task_board_close'
export const TITLEBAR_NAME = 'airi_task_board_titlebar'
// PAUSE / FOLLOW / … under the prompt, and the … menu holding NEW TASK and
// TERMINATE. Rebuilt on every refresh like the old Controls grid was.
export const ACTIONS_NAME = 'airi_task_board_actions'
export const MORE_BUTTON_NAME = 'airi_task_board_more'
export const MORE_MENU_NAME = 'airi_task_board_more_menu'
export const PAUSE_BUTTON_NAME = 'airi_task_board_pause'
export const TERMINATE_BUTTON_NAME = 'airi_task_board_terminate'
export const NEW_TASK_BUTTON_NAME = 'airi_task_board_new_task'
export const FOLLOW_BUTTON_NAME = 'airi_task_board_follow'
// A blocked plan must be answerable, not just visible. These three buttons are
// the bounded choices roadmap §7/§12 requires; they ride the same control queue
// as PAUSE / TERMINATE / NEW TASK.
export const BLOCKED_SECTION_NAME = 'airi_task_board_blocked_section'
export const BLOCKED_KEEP_PAUSED_BUTTON_NAME = 'airi_task_board_blocked_keep_paused'
export const BLOCKED_REVISE_BUTTON_NAME = 'airi_task_board_blocked_revise'
export const BLOCKED_CANCEL_BUTTON_NAME = 'airi_task_board_blocked_cancel'
// A blocked choice has no guaranteed status transition to key off (the plan is
// meant to stay frozen when the answer is "keep paused"), so it mirrors the
// lighter prompt-send pattern: a per-player tick stamp cleared by any fresher
// runtime snapshot. Purely visual reassurance, not a durable lock.
export const BLOCKED_CHOICE_PENDING_TICKS = 5 * 60
export const PROMPT_FIELD_NAME = 'airi_task_board_prompt'
export const PROMPT_SEND_BUTTON_NAME = 'airi_task_board_prompt_send'
export const MAX_STEPS = 24
export const MAX_GOAL_CHECKS = 6
// The Goal and Now cards at the top of the left column, rebuilt every refresh.
export const GOAL_CARD_NAME = 'airi_task_board_goal_card'
export const NOW_CARD_NAME = 'airi_task_board_now_card'
export const TITLE_STATUS_NAME = 'airi_task_board_title_status'
export const TITLE_STATUS_WIDTH = 520
export const GOAL_PROGRESS_WIDTH = 90
export const MAX_SHELF_NODES = 12
export const MAX_ACTIVITY = 18
export const MAX_INVENTORY_ITEMS = 80
export const MAX_WANTED_ITEMS = 48
export const MAX_TEXT = 500
export const MAX_PROMPT_TEXT = 4000
export const UI_INPUT_QUEUE_LIMIT = 32
// The console asks for a snapshot rather than only waiting to be handed one: a
// push-only feed leaves `storage.airi_task_board_ui` untouched whether AIRI is
// idle or gone, so the two are indistinguishable. The request rides the input
// drain the runtime already performs, so it costs no extra round trip.
export const POLL_REQUEST_TICKS = 60
// Roughly forty unanswered drains. Past this the last snapshot is history, not
// status, and the console has to say so instead of repeating it as current.
export const SYNC_STALE_TICKS = 10 * 60
export const TERMINATE_CONFIRM_TICKS = 5 * 60
// Lifecycle requests are normally ACKed quickly, but this state is persisted in
// synchronized storage. Bound it so a lost runtime/RCON ACK cannot leave the
// controls disabled forever across save/reload cycles.
export const LIFECYCLE_PENDING_TICKS = 60 * 60
// A prompt send has no goal/status transition to key off (unlike pause/resume/
// terminate), so its "picked up" signal is any fresh runtime snapshot after the
// send tick. This is only the fallback bound in case that snapshot never
// arrives - short, since it is purely visual reassurance, not a durable lock.
export const PROMPT_SEND_PENDING_TICKS = 3 * 60
export const LEFT_COLUMN_WIDTH = 640
export const PREVIEW_COLUMN_WIDTH = 680
export const COLUMN_SPACING = 12
// Status takes the full left column: it carries wrapping prose (the live phase
// and its detail, the goal, the sync age), and the buttons that used to share
// its row now live in the title bar and the action row under the prompt.
export const STATUS_SECTION_WIDTH = LEFT_COLUMN_WIDTH
export const SECTION_PADDING = 10
export const KEY_COLUMN_WIDTH = 64
export const STATUS_VALUE_WIDTH = STATUS_SECTION_WIDTH - 2 * SECTION_PADDING - KEY_COLUMN_WIDTH - 12
// Keep the resource layout behind one table. TSTL turns module-scope constants
// and helper functions into Lua locals, and Factorio's Lua parser has a hard
// limit of 200 locals per function. One layout table leaves headroom for future
// console work without changing the Inventory / Wanted / Equipped geometry.
export const RESOURCE_LAYOUT = {
  slot_size: 40,
  inventory_slot_columns: 10,
  wanted_slot_columns: 5,
  equipped_slot_columns: 3,
  equipped_label_width: 48,
  // Each pane is exactly as wide as the grid it holds - columns * slot_size,
  // plus the reserved scrollbar, plus the body padding. Any width beyond that
  // is empty frame drawn to the right of the last slot. Inventory is the pane
  // that actually fills up, so it takes ten columns and the sidebar keeps the
  // five that still fit beside it.
  inventory_section_width: 10 * 40 + 12 + 2 * SECTION_PADDING,
  wanted_section_width: PREVIEW_COLUMN_WIDTH - COLUMN_SPACING - (10 * 40 + 12 + 2 * SECTION_PADDING),
  slot_rows_min: 5,
  slot_rows_mid: 6,
  slot_rows_max: 8,
  scrollbar_width: 12,
}
// Control-stage GUI mutations are synchronized game state. They must not branch
// on client display resolution or UI scale, because different peers may report
// different display settings. Use one deterministic layout baseline everywhere;
// Factorio can still render that same synchronized geometry at each local scale.
//
// Behind one table for the same reason as RESOURCE_LAYOUT: TSTL emits every
// module-scope constant as a Lua local, and Factorio's parser allows 200 per
// function.
export const CONSOLE_LAYOUT = {
  synced_gui_height: 1080,
  screen_fraction: 0.92,
  // Everything in the LEFT column that is not a tracker list: titlebar, the
  // status/controls row, the tracker's own header/progress/divider chrome and
  // the prompt. The resource row is deliberately not counted here - it sits in
  // the right column underneath the camera, so it costs the left column no
  // height at all, and charging the left column for it is what used to starve
  // the activity feed.
  fixed_height: 560,
  list_min_total: 150,
  list_max_total: 270,
  // A ceiling on the plan list's share, not its size. A plan shorter than the
  // ceiling only claims the rows it actually has and the remainder goes to the
  // activity feed, which is the list that keeps growing.
  steps_share: 0.36,
  step_row_height: 30,
  steps_floor: 120,
  preview_min_height: 360,
  preview_max_height: 900,
  preview_screen_fraction: 0.5,
  // The Roadmap Shelf is intentionally the smaller planning context. The
  // executable immutable slice keeps two thirds of the tracker's inner width.
  tracker_column_gap: 12,
  tracker_shelf_width: 200,
  tracker_plan_width: LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - 12 - 200,
}
export const PREVIEW_CAMERA_WIDTH = PREVIEW_COLUMN_WIDTH - 2 * SECTION_PADDING
export const PREVIEW_ZOOM_DEFAULT = 0.75
export const PREVIEW_ZOOM_MIN = 0.25
export const PREVIEW_ZOOM_MAX = 2
export const PREVIEW_ZOOM_STEP = 0.05
export const COMPACT_BUTTON_HEIGHT = 36
// Wide enough that a slightly off click lands on empty gap instead of the
// neighboring button - PAUSE and TERMINATE sit side by side, and a misclick
// there discards a durable goal instead of just pausing it.
export const COMPACT_BUTTON_SPACING = 12
// Every control is the same size. Two sizes across two rows read as a ragged
// grid, and sizing each button to its own caption made the panel look
// accidental. Two of these plus the gap exactly fill the section's inner width.
export const COMPACT_BUTTON_WIDTH = 116
// The action row: FOLLOW and … at fixed widths, PAUSE takes the rest, so the
// button used most is also the largest target.
export const FOLLOW_BUTTON_WIDTH = 160
export const MORE_BUTTON_WIDTH = 48
export const PAUSE_BUTTON_WIDTH = LEFT_COLUMN_WIDTH - FOLLOW_BUTTON_WIDTH - MORE_BUTTON_WIDTH - 2 * COMPACT_BUTTON_SPACING
export const MORE_MENU_BUTTON_WIDTH = 140
export const PROMPT_SEND_WIDTH = 84
export const PROMPT_FIELD_WIDTH = LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - 8 - PROMPT_SEND_WIDTH
// The left column's tabs. The three pages are all built once and switched by
// toggling .visible, so every scroll-pane inside them (steps, shelf, activity,
// conversation) keeps its position across both tab switches and refreshes.
export type ConsoleTab = 'now' | 'plan' | 'activity'
export const CONSOLE_TABS = {
  order: ['now', 'plan', 'activity'] as ConsoleTab[],
  captions: { now: 'NOW', plan: 'PLAN', activity: 'ACTIVITY' } as Record<ConsoleTab, string>,
  tooltips: {
    now: 'The goal, the current step and the conversation with AIRI',
    plan: 'The goal, the Roadmap Shelf and the committed plan slice',
    activity: 'Everything AIRI observed, decided and did, newest last',
  } as Record<ConsoleTab, string>,
  pages: { now: 'airi_task_board_tab_now', plan: 'airi_task_board_tab_plan', activity: 'airi_task_board_tab_activity' } as Record<ConsoleTab, string>,
  bar: 'airi_task_board_tab_bar',
  banner: 'airi_task_board_banner',
  plan_dynamic: 'airi_task_board_plan_dynamic',
  activity_section: 'airi_task_board_activity_section',
  activity_section_header: 'airi_task_board_activity_section_header',
  activity_section_body: 'airi_task_board_activity_section_body',
  // Carried in the tab buttons' tags; the click handler reads it back.
  tag: 'airi_console_tab',
  spacing: 6,
  activity_height: 460,
}
