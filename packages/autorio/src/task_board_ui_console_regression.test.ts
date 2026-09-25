import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { task_board_resource_rows, task_board_wanted_rows } from './task_board_ui'

function taskBoardUiSource() {
  const main = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
  const constants = readFileSync(new URL('./task_board_ui_constants.ts', import.meta.url), 'utf8')
  // The console's chrome (title bar, blocked banner, action row) lives in its
  // own module for Lua local headroom; it is part of the same console.
  const chrome = readFileSync(new URL('./task_board_console.ts', import.meta.url), 'utf8')
  // UI constants moved into a namespace to preserve Factorio Lua local headroom.
  // Normalize that namespace for source-architecture assertions while retaining
  // the constants module so declaration/geometry checks still test real code.
  return `${main.replaceAll('ui_constants.', '')}\n${chrome.replaceAll('ui_constants.', '')}\n${constants}`.replace(/\r\n/g, '\n')
}

function taskBoardDebugSource() {
  return [
    readFileSync(new URL('./task_board_debug.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./task_board_debug_render.ts', import.meta.url), 'utf8'),
  ].join('\n').replace(/\r\n/g, '\n')
}


describe('SGLuna NPC console layout regressions', () => {
  const source = taskBoardUiSource()
  const debug_source = taskBoardDebugSource()

  it('keeps a useful inventory viewport across display sizes while reserving sidebar room for equipment', () => {
    expect(task_board_resource_rows(720)).toBe(5)
    expect(task_board_resource_rows(1080)).toBe(6)
    expect(task_board_resource_rows(1440)).toBe(8)
    expect(task_board_wanted_rows(720)).toBe(1)
    expect(task_board_wanted_rows(1080)).toBe(2)
    expect(task_board_wanted_rows(1440)).toBe(4)
    // Ten columns times the tallest viewport is exactly a default Factorio
    // character inventory, so the cap no longer cuts the grid short.
    expect(source).toContain('const MAX_INVENTORY_ITEMS = 80')
    expect(source).toContain('const RESOURCE_LAYOUT = {')
    expect(source).toContain('inventory_slot_columns: 10')
    expect(source).toContain('wanted_slot_columns: 5')
    expect(source).toContain('equipped_slot_columns: 3')
    // Each pane is exactly its own grid wide, so no empty frame is drawn to the
    // right of the last slot and the resource row spends its full width on slots.
    expect(source).toContain('inventory_section_width: 10 * 40 + 12 + 2 * SECTION_PADDING')
    expect(source).toContain('wanted_section_width: PREVIEW_COLUMN_WIDTH - COLUMN_SPACING - (10 * 40 + 12 + 2 * SECTION_PADDING)')
    expect(source).toContain("add_slot_grid(body, runtime.inventory.map")
    expect(source).toContain("task_board_resource_rows(player_gui_height(player)), RESOURCE_LAYOUT.inventory_slot_columns")
    expect(source).toContain("task_board_wanted_rows(player_gui_height(player)), RESOURCE_LAYOUT.wanted_slot_columns")
    expect(source).toContain("create_section(sidebar, 'Equipped', RESOURCE_LAYOUT.wanted_section_width")
  })

  it('packs resource constants and equipment helpers to preserve Factorio Lua local headroom', () => {
    expect(source).not.toContain('const SLOT_SIZE =')
    expect(source).not.toContain('const INVENTORY_SLOT_COLUMNS =')
    expect(source).not.toContain('const EQUIPPED_SLOT_COLUMNS =')
    expect(source).not.toContain('function inventory_items(')
    expect(source).not.toContain('function add_equipped_row(')
    expect(source).not.toContain('function render_equipped(')
    expect(source).toContain('const inventory_items = (source: LuaInventory | undefined)')
    expect(source).toContain('const add_equipped_row = (caption: string, items: TaskBoardUiItem[]) =>')
    // The console height numbers are packed the same way, for the same reason.
    expect(source).toContain('const CONSOLE_LAYOUT = {')
    expect(source).not.toContain('const CONSOLE_SCREEN_FRACTION =')
    expect(source).not.toContain('const TRACKER_LIST_MIN_TOTAL =')
    expect(source).not.toContain('const TRACKER_STEPS_SHARE =')
    expect(source).not.toContain('const PREVIEW_CAMERA_MIN_HEIGHT =')
  })

  it('keeps Debug Execution Activity alive across diagnostics refreshes and follows the newest event safely', () => {
    const fill_debug = debug_source.split('function fill_debug_body(')[1]?.split('function build_debug_activity(')[0] ?? ''
    expect(fill_debug).toContain('body.clear()')
    expect(fill_debug).not.toContain('Execution Activity')
    const refresh = debug_source.split('function refresh_debug_activity(')[1]?.split('function build_debug_popout(')[0] ?? ''
    expect(refresh).toContain('activity_state.activity_rows_diff(shown, keys)')
    expect(refresh).toContain('if (force || view.follow)')
    expect(refresh).not.toContain('view.hover')
    expect(refresh).toContain('(scroll as ScrollPaneGuiElement).scroll_to_bottom()')
    expect(refresh).not.toContain('scroll.clear()')
    expect(debug_source).toContain("name: DEBUG_ACTIVITY_SCROLL_NAME")
    expect(debug_source).toContain("vertical_scroll_policy: 'auto-and-reserve-space'")
    expect(source).toContain('debug_ui.toggle_debug_activity_follow(player.index)')
    expect(source).not.toContain('debug_ui.set_debug_activity_hover')
    expect(debug_source).not.toContain('set_debug_activity_hover')
  })

  it('keeps Current Task Conversation explicitly scrollable without rebuilding its pane', () => {
    expect(debug_source).toContain("vertical_scroll_policy: 'auto-and-reserve-space'")
    expect(debug_source).toContain('scroll.style.maximal_height = CONVERSATION_HEIGHT')
    expect(debug_source).toContain("name: CONVERSATION.scroll")
    expect(debug_source).toContain('if (created || !previous_follow || appended > 0) (scroll as ScrollPaneGuiElement).scroll_to_bottom()')
    expect(debug_source).toContain('if (view.follow) {')
    expect(debug_source).toContain('if (view.follow || created) {')
    expect(debug_source).toContain('const displayed_keys = view.follow || created ? keys : shown')
  })

  it('makes the top-left SGLuna mod-GUI button easier to see without changing its standard slot style', () => {
    const ensure_button = source.split('function ensure_button(')[1]?.split('function destroy_panel(')[0] ?? ''
    expect(ensure_button).toContain("style: 'slot_button'")
    expect(ensure_button).toContain('button.style.width = 48')
    expect(ensure_button).toContain('button.style.height = 48')
    expect(ensure_button).toContain('button.style.minimal_width = 48')
    expect(ensure_button).toContain('button.style.maximal_width = 48')
  })

  it('locks control and prompt widths instead of shrinking to their captions', () => {
    expect(source).toContain('element.style.minimal_width = width')
    expect(source).toContain('element.style.maximal_width = width')
    expect(source).toContain('field.style.minimal_width = PROMPT_FIELD_WIDTH')
    expect(source).toContain('field.style.maximal_width = PROMPT_FIELD_WIDTH')
    expect(source).toContain('send.style.maximal_width = PROMPT_SEND_WIDTH')
  })

  it('turns pause into a resumable unpause control without discarding the prompt draft', () => {
    expect(source).toContain("pending?.action === 'resume' ? 'RESUMING...' : paused ? 'RESUME' : 'PAUSE'")
    expect(source).toContain("const action: TaskBoardUiLifecycleAction = storage.airi_task_board_ui?.status === 'paused' ? 'resume' : 'pause'")
    expect(source).toContain("if (action === 'resume') emit_resume(player)")
    expect(source).toContain('pause_enabled: pending === undefined')
    expect(source).toContain('terminate_enabled: pending === undefined')
    expect(source).toContain("text: 'continue'")
    const resumeBody = source.split('function emit_resume(')[1]?.split('function emit_prompt(')[0] ?? ''
    expect(resumeBody).not.toContain('set_prompt_draft')
  })

  it('filters recent activity with toggle buttons, since a drop-down can only hold one selection', () => {
    expect(source).not.toContain("type: 'drop-down'")
    // The console owns the one list-box selection handler (Old tasks and Skills);
    // the activity filters never go through it.
    expect(source).toContain('if (!project_ui.handle_project_selection(player, element)) skills_ui.handle_skills_window_selection(player, element)')
    expect(source).toContain("tags: { airi_activity_filter: activity_state.ACTIVITY_FILTER_ALL }")
    expect(source).toContain('tags: { airi_activity_filter: filter.flag }')
    expect(source).toContain('(button as ButtonGuiElement).toggled = activity_state.activity_filter_selected(mask, flag)')
    expect(source).toContain('activity_state.toggle_activity_filter(player.index, filter_flag)')
    expect(source).not.toContain("'bottom-third'")
  })

  it('keeps the tracker scroll-panes alive across refreshes so the player keeps their place', () => {
    const refresh_columns = source.split('function refresh_columns(')[1]?.split('function build_panel(')[0] ?? ''
    // The tracker and the feed are refreshed in place before the rest of the
    // left column is rebuilt, and are never inside what gets cleared.
    expect(refresh_columns).toContain('if (!refresh_tracker(plan, board, player) || !refresh_activity_section(activity, board, player)) return false')
    expect(refresh_columns.indexOf('refresh_tracker(plan')).toBeLessThan(refresh_columns.indexOf('build_left_dynamic('))
    // Switching tabs only flips visibility; it never rebuilds a page.
    expect(refresh_columns).toContain('console_ui.apply_console_tab(left, selected_console_tab(player))')
    expect(refresh_columns).not.toContain('plan.clear()')
    expect(refresh_columns).not.toContain('activity.clear()')
    const left_dynamic = source.split('function build_left_dynamic(')[1]?.split('function build_columns(')[0] ?? ''
    expect(left_dynamic).not.toContain('render_tracker(')

    const refresh_activity = source.split('function refresh_activity(')[1]?.split('function activity_scroll_of(')[0] ?? ''
    // Rows are appended and trimmed; the pane itself is never cleared...
    expect(refresh_activity).toContain('activity_state.activity_row_diff(shown_heads, shown_tails, rows)')
    expect(refresh_activity).not.toContain('scroll.clear()')
    // ...and it only moves when the follow state says so.
    expect(refresh_activity).toContain('if (activity_state.activity_should_scroll(view, appended, last_key)) (scroll as ScrollPaneGuiElement).scroll_to_bottom()')
    expect(refresh_activity.split('scroll_to_bottom()').length).toBe(2)

    const refresh_steps = source.split('function refresh_steps(')[1]?.split('function refresh_activity(')[0] ?? ''
    expect(refresh_steps).toContain('if (steps_table.tags.signature !== signature)')
    expect(refresh_steps).toContain('previous_active !== active_index')
  })

  it('keeps the prompt and resource controls mounted during unchanged refreshes', () => {
    const refresh = source.split('function refresh_columns(')[1]?.split('function build_panel(')[0] ?? ''
    // Cards redraw one at a time, each gated by its own signature.
    expect(refresh).toContain('build_left_dynamic(banner, dynamic, plan_dynamic, player, board)')
    expect(source).toContain('if (slot.tags.signature === signature) return')
    expect(refresh).toContain('if (resources.tags.signature !== resource_signature) { resources.clear();')
    expect(refresh).toContain('if (!actions?.valid || actions.tags.signature !== action_signature)')
    expect(refresh).not.toContain('render_prompt(')
    const preview = source.split('function refresh_world_preview(')[1]?.split('function render_world_preview(')[0] ?? ''
    expect(preview).toContain('if (preview === undefined) return body?.valid === true')
    expect(preview).toContain('camera.entity !== preview.entity')
  })

  it('pauses live follow when the reader scrolls up in Activity or Conversation', () => {
    // Factorio gives Lua no scroll offset and no scroll event, so the wheel is
    // the signal, declared as listen-only inputs in the data stage.
    const data = readFileSync(new URL('../data.lua', import.meta.url), 'utf8')
    expect(data).toContain('name = "airi-task-board-activity-scroll-up"')
    expect(data).toContain('key_sequence = "mouse-wheel-up"')
    expect(data).toContain('name = "airi-task-board-activity-scroll-down"')
    expect(data).toContain('key_sequence = "mouse-wheel-down"')
    // Listen-only: the wheel must still scroll the feed and zoom the map.
    expect(data.split('    consuming = "none",').length).toBe(3)
    expect(source).toContain("scroll_up_input: 'airi-task-board-activity-scroll-up'")
    expect(source).toContain("scroll_down_input: 'airi-task-board-activity-scroll-down'")
    expect(source).toContain('script.on_event(TRACKER.scroll_up_input, on_activity_wheel)')
    expect(source).not.toContain('script.on_event(TRACKER.scroll_down_input, on_activity_wheel)')
    expect(source).toContain('element.name !== debug_ui.CONVERSATION_SCROLL_NAME')
    expect(source).toContain('activity_state.stop_activity_follow(player.index, last_shown_activity_key(activity_scroll_of(player)))')
    expect(source).toContain('element.name === TRACKER.live || element.name === debug_ui.CONVERSATION_STATE_NAME')
    expect(debug_source).toContain("CONVERSATION_STATE_NAME = 'airi_task_board_conversation_live'")
    expect(debug_source).toContain("CONVERSATION_SCROLL_NAME = 'airi_task_board_conversation_scroll'")
    expect(source).toContain('if (activity_state.activity_view(player.index).follow) activity_state.reset_activity_view(player.index)')
    const build_panel = source.split('function build_panel(')[1]?.split('function render_panel(')[0] ?? ''
    expect(build_panel).not.toContain('reset_activity_view')

    // Hover is deliberately not state. Rows still ignore interaction so the
    // ordinary wheel reaches the pane, while only synchronized wheel input pauses follow.
    expect(source).not.toContain('raise_hover_events')
    expect(source).not.toContain('defines.events.on_gui_hover')
    expect(source).not.toContain('defines.events.on_gui_leave')
    expect(source).not.toContain('set_activity_hover')
    expect(source).toContain("column_count: 3, ignored_by_interaction: true")

    // One indicator doubles as the follow switch.
    expect(source).toContain("const state = view.follow ? 'LIVE' : unseen.count > 0 ? `${unseen.count}${unseen.overflow ? '+' : ''} NEW` : 'PAUSED'")
    expect(source).toContain('activity_state.resume_activity_follow(player.index, last_shown_activity_key(scroll))')
    // A brand-new console starts out following.
    expect(source).toContain('activity_state.reset_activity_view(player.index)')
  })
})
describe('old tasks and New Task conversation integration', () => {
  const source = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
  const projects = readFileSync(new URL('./projects/project_window.ts', import.meta.url), 'utf8')

  it('renders an independent old-task history button and explicit lifecycle acknowledgement route', () => {
    expect(source).toContain("{ name: project_ui.PROJECTS_BUTTON_NAME, icon: 'history'")
    expect(projects).toContain("PROJECTS_BUTTON_NAME = 'airi_task_board_projects'")
    expect(projects).toContain("PROJECTS_CLOSE_BUTTON_NAME = 'airi_task_board_projects_close'")
    expect(source).toContain("ack_lifecycle: (player_index: unknown, action: unknown)")
  })

  it('tombstones and clears the current conversation binding before queueing New Task', () => {
    const handler = source.split('function handle_control_click(')[1]?.split('\n}\n\nexport function create_task_board_ui_remote_interface')[0] ?? ''
    expect(handler).toContain("debug_ui.suppress_snapshot(storage.airi_task_board_ui); debug_ui.reset_task_conversation(); activity_state.clear_activity_history(); emit_control(player, 'new_task')")
  })
})
