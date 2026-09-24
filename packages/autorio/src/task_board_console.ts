import type { ButtonGuiElement, FrameGuiElement, LuaGuiElement, ProgressBarGuiElement, SpriteButtonGuiElement, SpriteGuiElement, SpritePath } from 'factorio:runtime'
import * as ui_constants from './task_board_ui_constants'
import * as gui_text from './task_board_gui_text'

// The console's chrome: the title bar with its window buttons, the blocked
// banner, and the action row under the prompt. Kept out of task_board_ui.ts so
// that module keeps its Lua local headroom, and fed plain state objects so it
// never imports the console back.

type Color = { r: number, g: number, b: number }

export interface ConsoleWindowButton {
  name: string
  icon: 'learn' | 'history' | 'debug'
  tooltip: string
  open: boolean
}

export interface ConsoleActionState {
  pause_caption: string
  pause_tooltip: string
  pause_enabled: boolean
  follow_caption: string
  follow_tooltip: string
  follow_active: boolean
  follow_issue: string
  more_open: boolean
  new_task_tooltip: string
  new_task_enabled: boolean
  terminate_caption: string
  terminate_tooltip: string
  terminate_enabled: boolean
  issue_color: Color
  muted_color: Color
}

// What AIRI is doing, in the title bar: the live phase and its detail, with
// the NPC, the world task and the sync age in the tooltip.
export interface ConsoleTitleStatus { caption: string, tone: ui_constants.Tone, tooltip: string }

export interface ConsoleGoalCard {
  summary: string
  // Shown instead of checks: no goal, or a goal the planner has not defined yet.
  note: string
  read: boolean
  met: number
  total: number
  checks: Array<{ text: string, met: boolean, progress: string }>
}

export interface ConsoleNowCard {
  heading: string
  step: string
  step_tone: ui_constants.Tone
  progress: number
  show_progress: boolean
  next: string
  attention: Array<{ caption: string, tone: ui_constants.Tone }>
  last: string
  last_tone: ui_constants.Tone
}

export interface ConsoleBlockedState {
  summary: string
  reason: string
  deadlock: string
  choice_pending: boolean
  bad_color: Color
  muted_color: Color
  warn_color: Color
}

function icon_sprite(icon: ConsoleWindowButton['icon'], variant: 'white' | 'black'): SpritePath {
  return `airi-console-${icon}-${variant}` as SpritePath
}

/**
 * The main console's title bar. Window buttons sit beside Close as icon
 * buttons, the way Factorio's own windows carry them, instead of taking a row
 * of full-size buttons in the body. Built once; refresh_console_titlebar keeps
 * their open/closed state current.
 */
export function render_console_titlebar(root: FrameGuiElement, caption: string, buttons: ConsoleWindowButton[], status: ConsoleTitleStatus) {
  const titlebar = root.add({ type: 'flow', name: ui_constants.TITLEBAR_NAME, direction: 'horizontal' })
  titlebar.style.horizontally_stretchable = true
  titlebar.style.horizontal_spacing = 8
  titlebar.drag_target = root
  titlebar.add({ type: 'label', caption, style: 'frame_title', ignored_by_interaction: true })
  titlebar.add({ type: 'sprite', name: `${ui_constants.TITLE_STATUS_NAME}_icon`, sprite: ui_constants.TONE_SPRITES[status.tone], style: 'status_image' })
  const status_label = gui_text.literal_gui_text(titlebar.add({ type: 'label', name: ui_constants.TITLE_STATUS_NAME, caption: '', style: 'bold_label' }))
  status_label.style.maximal_width = ui_constants.TITLE_STATUS_WIDTH
  const dragger = titlebar.add({ type: 'empty-widget', style: 'draggable_space_header', ignored_by_interaction: true })
  dragger.style.horizontally_stretchable = true
  dragger.style.height = 24
  for (const button of buttons) {
    titlebar.add({
      type: 'sprite-button',
      name: button.name,
      sprite: icon_sprite(button.icon, 'white'),
      hovered_sprite: icon_sprite(button.icon, 'black'),
      clicked_sprite: icon_sprite(button.icon, 'black'),
      style: 'frame_action_button',
      tooltip: button.tooltip,
      auto_toggle: false,
    })
  }
  titlebar.add({ type: 'sprite-button', name: ui_constants.CLOSE_BUTTON_NAME, sprite: 'utility/close', style: 'frame_action_button', tooltip: `Close ${caption}` })
  refresh_console_titlebar(root, buttons, status)
}

export function refresh_console_titlebar(root: FrameGuiElement, buttons: ConsoleWindowButton[], status: ConsoleTitleStatus) {
  const titlebar = root[ui_constants.TITLEBAR_NAME]
  if (!titlebar?.valid) return false
  const icon = titlebar[`${ui_constants.TITLE_STATUS_NAME}_icon`] as SpriteGuiElement | undefined
  const label = titlebar[ui_constants.TITLE_STATUS_NAME]
  if (!icon?.valid || !label?.valid) return false
  icon.sprite = ui_constants.TONE_SPRITES[status.tone]
  label.caption = status.caption
  label.tooltip = status.tooltip
  label.style.font_color = ui_constants.TONE_COLORS[status.tone]
  for (const button of buttons) {
    const element = titlebar[button.name] as SpriteButtonGuiElement | undefined
    if (!element?.valid) return false
    element.toggled = button.open
    element.tooltip = button.tooltip
  }
  return true
}

/**
 * A blocked plan across the full width of the left column, above everything
 * else, so the three answers it needs are the first thing the player sees.
 */
export function render_blocked_banner(parent: LuaGuiElement, state: ConsoleBlockedState) {
  const banner = parent.add({ type: 'frame', name: ui_constants.BLOCKED_SECTION_NAME, direction: 'vertical', style: 'inside_shallow_frame' })
  banner.style.width = ui_constants.LEFT_COLUMN_WIDTH
  banner.style.padding = ui_constants.SECTION_PADDING
  banner.style.vertical_spacing = 4
  const width = ui_constants.LEFT_COLUMN_WIDTH - 2 * ui_constants.SECTION_PADDING
  const heading = gui_text.literal_gui_text(banner.add({ type: 'label', caption: `BLOCKED · ${state.summary}`, style: 'bold_label' }))
  heading.style.single_line = false; heading.style.maximal_width = width; heading.style.font_color = state.bad_color
  if (state.reason.length > 0 && state.reason !== state.summary) {
    const detail = gui_text.literal_gui_text(banner.add({ type: 'label', caption: `Reason: ${state.reason}` }))
    detail.style.single_line = false; detail.style.maximal_width = width; detail.style.font_color = state.muted_color
  }
  if (state.deadlock.length > 0) {
    const evidence = gui_text.literal_gui_text(banner.add({ type: 'label', caption: state.deadlock }))
    evidence.style.single_line = false; evidence.style.maximal_width = width; evidence.style.font_color = state.warn_color
  }
  const choices = banner.add({ type: 'flow', direction: 'horizontal' })
  choices.style.horizontal_spacing = ui_constants.COMPACT_BUTTON_SPACING
  const tip = state.choice_pending ? 'Waiting for SGLuna runtime to acknowledge your blocked-plan decision.' : ''
  const keep = action_button(choices.add({ type: 'button', name: ui_constants.BLOCKED_KEEP_PAUSED_BUTTON_NAME, caption: state.choice_pending ? 'SAVING...' : 'KEEP PAUSED', style: 'dialog_button', tooltip: tip || 'Keep this committed plan frozen. No work or replanning will start.' }), ui_constants.COMPACT_BUTTON_WIDTH)
  keep.enabled = !state.choice_pending
  const revise = action_button(choices.add({ type: 'button', name: ui_constants.BLOCKED_REVISE_BUTTON_NAME, caption: 'REVISE…', style: 'confirm_button', tooltip: tip || 'Keep the plan frozen, then describe the revised goal or constraints in the prompt below. AIRI will not invent a replacement plan.' }), ui_constants.COMPACT_BUTTON_WIDTH)
  revise.enabled = !state.choice_pending
  const cancel = action_button(choices.add({ type: 'button', name: ui_constants.BLOCKED_CANCEL_BUTTON_NAME, caption: 'CANCEL…', style: 'red_button', tooltip: tip || 'Request cancellation, then use the TERMINATE confirmation under … to discard this blocked goal permanently.' }), ui_constants.COMPACT_BUTTON_WIDTH)
  cancel.enabled = !state.choice_pending
}

function action_button(element: LuaGuiElement, width: number) {
  element.style.width = width
  element.style.minimal_width = width
  element.style.maximal_width = width
  element.style.height = ui_constants.COMPACT_BUTTON_HEIGHT
  element.style.minimal_height = ui_constants.COMPACT_BUTTON_HEIGHT
  element.style.maximal_height = ui_constants.COMPACT_BUTTON_HEIGHT
  return element as ButtonGuiElement
}

/**
 * The action row under the prompt: PAUSE, FOLLOW and … . The two buttons that
 * throw work away, NEW TASK and TERMINATE, only appear once … is opened, each
 * with a line saying what it discards, so neither sits one misclick from PAUSE.
 * Rebuilt on every refresh; it holds no player-owned state of its own.
 */
export function render_action_row(parent: LuaGuiElement, state: ConsoleActionState) {
  const actions = parent.add({ type: 'flow', name: ui_constants.ACTIONS_NAME, direction: 'vertical' })
  actions.style.width = ui_constants.LEFT_COLUMN_WIDTH
  actions.style.vertical_spacing = 6
  if (state.more_open) {
    const menu = actions.add({ type: 'frame', name: ui_constants.MORE_MENU_NAME, direction: 'vertical', style: 'inside_shallow_frame' })
    menu.style.width = ui_constants.LEFT_COLUMN_WIDTH
    menu.style.padding = ui_constants.SECTION_PADDING
    menu.style.vertical_spacing = 6
    const choice_row = () => {
      const row = menu.add({ type: 'flow', direction: 'horizontal' })
      row.style.vertical_align = 'center'
      row.style.horizontal_spacing = 10
      return row
    }
    const new_task_row = choice_row()
    const new_task = action_button(new_task_row.add({ type: 'button', name: ui_constants.NEW_TASK_BUTTON_NAME, caption: 'NEW TASK', style: 'dialog_button', tooltip: state.new_task_tooltip }), ui_constants.MORE_MENU_BUTTON_WIDTH)
    new_task.enabled = state.new_task_enabled
    const new_task_note = new_task_row.add({ type: 'label', caption: 'Clears the goal and conversation. Skills and the world stay.' })
    new_task_note.style.font_color = state.muted_color
    const terminate_row = choice_row()
    const terminate = action_button(terminate_row.add({ type: 'button', name: ui_constants.TERMINATE_BUTTON_NAME, caption: state.terminate_caption, style: 'red_button', tooltip: state.terminate_tooltip }), ui_constants.MORE_MENU_BUTTON_WIDTH)
    terminate.enabled = state.terminate_enabled
    const terminate_note = terminate_row.add({ type: 'label', caption: 'Discards the goal permanently. Asks again first.' })
    terminate_note.style.font_color = state.muted_color
  }
  const row = actions.add({ type: 'flow', direction: 'horizontal' })
  row.style.horizontal_spacing = ui_constants.COMPACT_BUTTON_SPACING
  const pause = action_button(row.add({ type: 'button', name: ui_constants.PAUSE_BUTTON_NAME, caption: state.pause_caption, style: 'dialog_button', tooltip: state.pause_tooltip }), ui_constants.PAUSE_BUTTON_WIDTH)
  pause.enabled = state.pause_enabled
  action_button(row.add({ type: 'button', name: ui_constants.FOLLOW_BUTTON_NAME, caption: state.follow_caption, style: state.follow_active ? 'confirm_button' : 'dialog_button', tooltip: state.follow_tooltip }), ui_constants.FOLLOW_BUTTON_WIDTH)
  const more = action_button(row.add({ type: 'button', name: ui_constants.MORE_BUTTON_NAME, caption: '…', style: 'dialog_button', tooltip: state.more_open ? 'Hide New task and Terminate.' : 'New task and Terminate.' }), ui_constants.MORE_BUTTON_WIDTH)
  more.toggled = state.more_open
  if (state.follow_issue.length > 0) {
    const issue = gui_text.literal_gui_text(actions.add({ type: 'label', caption: `⚠ ${state.follow_issue}` }))
    issue.style.single_line = false
    issue.style.maximal_width = ui_constants.LEFT_COLUMN_WIDTH
    issue.style.font_color = state.issue_color
  }
}

// A titled card spanning the left column, with an optional caption on the
// right of its header (the "1/2 checks met" of the Goal card).
function card(parent: LuaGuiElement, name: string, title: string, right: string) {
  const section = parent.add({ type: 'frame', name, direction: 'vertical', style: 'inside_shallow_frame' })
  section.style.width = ui_constants.LEFT_COLUMN_WIDTH
  const header = section.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.style.vertical_align = 'center'
  header.add({ type: 'label', caption: title, style: 'subheader_caption_label' })
  const filler = header.add({ type: 'empty-widget' })
  filler.style.horizontally_stretchable = true
  if (right.length > 0) {
    const caption = header.add({ type: 'label', caption: right, style: 'semibold_label' })
    caption.style.right_padding = 4
  }
  const body = section.add({ type: 'flow', direction: 'vertical' })
  body.style.padding = ui_constants.SECTION_PADDING
  body.style.vertical_spacing = 4
  body.style.horizontally_stretchable = true
  return body
}

function wrapped(parent: LuaGuiElement, caption: string, width: number, style = 'label') {
  const label = gui_text.literal_gui_text(parent.add({ type: 'label', caption, style }))
  label.style.single_line = false
  label.style.maximal_width = width
  return label
}

/**
 * The goal and each done-when check the game reports, with its progress.
 * This is the one place the console answers "how far is the goal?", which the
 * old Status panel never showed.
 */
export function render_goal_card(parent: LuaGuiElement, goal: ConsoleGoalCard) {
  const right = goal.total > 0 ? (goal.read ? `${goal.met}/${goal.total} checks met` : 'checks not read') : ''
  const body = card(parent, ui_constants.GOAL_CARD_NAME, 'Goal', right)
  const inner = ui_constants.LEFT_COLUMN_WIDTH - 2 * ui_constants.SECTION_PADDING
  wrapped(body, goal.summary, inner, 'bold_label')
  if (goal.total === 0) {
    if (goal.note.length > 0) wrapped(body, goal.note, inner).style.font_color = ui_constants.TONE_COLORS.muted
    return
  }
  const bar = body.add({ type: 'progressbar', value: goal.met / goal.total }) as ProgressBarGuiElement
  bar.style.horizontally_stretchable = true
  const table = body.add({ type: 'table', column_count: 3 })
  table.style.horizontal_spacing = 8
  table.style.vertical_spacing = 4
  for (const check of goal.checks) {
    table.add({ type: 'sprite', sprite: ui_constants.TONE_SPRITES[check.met ? 'good' : 'muted'], style: 'status_image', tooltip: check.met ? 'met' : 'not yet' })
    wrapped(table, check.text, inner - ui_constants.GOAL_PROGRESS_WIDTH - 40)
    const progress = table.add({ type: 'label', caption: check.progress, style: 'semibold_label' })
    progress.style.minimal_width = ui_constants.GOAL_PROGRESS_WIDTH
    progress.style.horizontal_align = 'right'
    progress.style.font_color = ui_constants.TONE_COLORS[check.met ? 'good' : 'muted']
  }
}

/**
 * The step being worked on now, the slice's progress, what comes next, and
 * anything holding it (paused, blocked). Replaces the old Status rows GOAL,
 * STEP and LAST, which repeated the plan list.
 */
export function render_now_card(parent: LuaGuiElement, now: ConsoleNowCard) {
  const body = card(parent, ui_constants.NOW_CARD_NAME, now.heading, '')
  const inner = ui_constants.LEFT_COLUMN_WIDTH - 2 * ui_constants.SECTION_PADDING
  const step = wrapped(body, now.step, inner, 'bold_label')
  step.style.font_color = ui_constants.TONE_COLORS[now.step_tone]
  if (now.show_progress) {
    const bar = body.add({ type: 'progressbar', value: now.progress }) as ProgressBarGuiElement
    bar.style.horizontally_stretchable = true
  }
  if (now.next.length > 0) wrapped(body, now.next, inner).style.font_color = ui_constants.TONE_COLORS.muted
  for (const line of now.attention) wrapped(body, line.caption, inner, 'semibold_label').style.font_color = ui_constants.TONE_COLORS[line.tone]
  if (now.last.length > 0) wrapped(body, now.last, inner).style.font_color = ui_constants.TONE_COLORS[now.last_tone]
}

export function console_tab_of(value: unknown): ui_constants.ConsoleTab | undefined {
  return value === 'now' || value === 'plan' || value === 'activity' ? value : undefined
}

/**
 * The tab strip and one empty page per tab, in the left column. Pages are
 * filled by the caller and never rebuilt; switching tabs only flips .visible,
 * which is what keeps each page's scroll-panes where the player left them.
 */
export function render_console_tabs(parent: LuaGuiElement, selected: ui_constants.ConsoleTab) {
  const tabs = ui_constants.CONSOLE_TABS
  const bar = parent.add({ type: 'flow', name: tabs.bar, direction: 'horizontal' })
  bar.style.horizontal_spacing = tabs.spacing
  const width = math.floor((ui_constants.LEFT_COLUMN_WIDTH - (tabs.order.length - 1) * tabs.spacing) / tabs.order.length)
  for (const tab of tabs.order) {
    const button = bar.add({ type: 'button', caption: tabs.captions[tab], tooltip: tabs.tooltips[tab], tags: { [tabs.tag]: tab } }) as ButtonGuiElement
    button.style.width = width
    button.style.height = ui_constants.COMPACT_BUTTON_HEIGHT
  }
  const pages = {} as Record<ui_constants.ConsoleTab, LuaGuiElement>
  for (const tab of tabs.order) {
    const page = parent.add({ type: 'flow', name: tabs.pages[tab], direction: 'vertical' })
    page.style.width = ui_constants.LEFT_COLUMN_WIDTH
    page.style.vertical_spacing = ui_constants.COLUMN_SPACING
    pages[tab] = page
  }
  apply_console_tab(parent, selected)
  return pages
}

/** The page for a tab, or undefined when the console predates the tabs. */
export function console_tab_page(parent: LuaGuiElement, tab: ui_constants.ConsoleTab) {
  const page = parent[ui_constants.CONSOLE_TABS.pages[tab]]
  return page?.valid ? page : undefined
}

/**
 * Show the selected page and mark its button. Idempotent, so the routine
 * refresh can call it; captions let a tab carry a count (ACTIVITY · 3 new).
 */
export function apply_console_tab(parent: LuaGuiElement, selected: ui_constants.ConsoleTab, captions?: Partial<Record<ui_constants.ConsoleTab, string>>) {
  const tabs = ui_constants.CONSOLE_TABS
  const bar = parent[tabs.bar]
  if (!bar?.valid) return false
  for (const button of bar.children) {
    const tab = console_tab_of(button.tags[tabs.tag])
    if (tab === undefined) continue
    ;(button as ButtonGuiElement).toggled = tab === selected
    const caption = captions?.[tab] ?? tabs.captions[tab]
    if (button.caption !== caption) button.caption = caption
  }
  for (const tab of tabs.order) {
    const page = console_tab_page(parent, tab)
    if (page === undefined) return false
    page.visible = tab === selected
  }
  return true
}
