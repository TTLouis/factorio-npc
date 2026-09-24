import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { step_caption, task_board_game_time, task_board_gui_height, task_board_preview_min_height, task_board_tracker_heights } from './task_board_ui'

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


describe('SGLuna NPC console compact tracker layout', () => {
  it('formats deterministic Factorio game time for tracker activity', () => {
    expect(task_board_game_time(0)).toBe('00:00:00')
    expect(task_board_game_time(60)).toBe('00:00:01')
    expect(task_board_game_time(3661 * 60)).toBe('01:01:01')
  })

  it('keeps prompt SGLuna on the left half and gives the world preview a zoomable camera', () => {
    const source = taskBoardUiSource()
    expect(source).toContain('section.style.width = LEFT_COLUMN_WIDTH')
    expect(source).toContain('field.style.width = PROMPT_FIELD_WIDTH')

    expect(source).toContain('const PREVIEW_CAMERA_WIDTH = PREVIEW_COLUMN_WIDTH - 2 * SECTION_PADDING')
    expect(source).toContain('camera.style.width = PREVIEW_CAMERA_WIDTH')
    expect(source).toContain('camera.style.minimal_height = preview_min_height')
    expect(source).toContain('camera.style.vertically_stretchable = true')
    expect(source).not.toContain('1:1')
    expect(source).toContain('return `X ${math.floor(preview.position.x)} · Y ${math.floor(preview.position.y)}`')
    expect(source).toContain('name: PREVIEW_ZOOM_SLIDER_NAME')
    expect(source).toContain('minimum_value: PREVIEW_ZOOM_MIN')
    expect(source).toContain('maximum_value: PREVIEW_ZOOM_MAX')
    expect(source).toContain('value_step: PREVIEW_ZOOM_STEP')
  })

  it('sizes the console from the player display while keeping the main tracker plan-only', () => {
    expect(task_board_gui_height(2160, 2)).toBe(1080)
    expect(task_board_gui_height(1080, 1)).toBe(1080)
    expect(task_board_gui_height(1080, 0)).toBe(1080)

    const small = task_board_tracker_heights(720)
    expect(small).toEqual({ steps: 150, activity: 0 })

    const tall = task_board_tracker_heights(1440)
    expect(tall).toEqual({ steps: 270, activity: 0 })

    const huge = task_board_tracker_heights(4320)
    expect(huge).toEqual({ steps: 270, activity: 0 })

    expect(task_board_preview_min_height(720)).toBe(360)
    expect(task_board_preview_min_height(1440)).toBe(720)
    expect(task_board_preview_min_height(4320)).toBe(900)
  })

  it('sizes the shared Shelf / plan workspace from the larger visible planning list and leaves execution activity to Debug', () => {
    const source = taskBoardUiSource()
    expect(source).toContain('fixed_height: 560,')
    expect(source).not.toContain('const CONSOLE_FIXED_HEIGHT')
    expect(source).toContain('const row_count = board === undefined ? 0 : math.max(board.steps.length, shelf_nodes.length)')
    expect(source).toContain('task_board_tracker_heights(player_gui_height(player), math.min(row_count, MAX_STEPS))')
    expect(source).toContain('tracker_shelf_width: 200')
    expect(source).toContain('tracker_plan_width: LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - 12 - 200')

    const short_plan = task_board_tracker_heights(1286, 6)
    const long_plan = task_board_tracker_heights(1286, 24)
    expect(short_plan).toEqual({ steps: 180, activity: 0 })
    expect(long_plan).toEqual({ steps: 270, activity: 0 })
    expect(short_plan.steps).toBeLessThan(long_plan.steps)

    expect(task_board_tracker_heights(1286, 1)).toEqual({ steps: 120, activity: 0 })
    expect(task_board_tracker_heights(1286, 0)).toEqual({ steps: 0, activity: 0 })
  })

  it('spends the whole left column on the panel that wraps text and moves window buttons to the title bar', () => {
    const source = taskBoardUiSource()
    expect(source).not.toContain('CONTROLS_SECTION_WIDTH')
    expect(source).toContain('const STATUS_SECTION_WIDTH = LEFT_COLUMN_WIDTH')
    expect(source).toContain('const STATUS_VALUE_WIDTH = STATUS_SECTION_WIDTH - 2 * SECTION_PADDING - KEY_COLUMN_WIDTH - 12')
    expect(source).toContain('issue.style.maximal_width = LEFT_COLUMN_WIDTH')
    expect(source).not.toContain('HALF_SECTION_WIDTH')
    expect(source).not.toContain('HALF_VALUE_WIDTH')
    // Learn, Old tasks and Debug are icon buttons beside Close, and show
    // whether their window is open.
    expect(source).toContain("{ name: SKILLS_BUTTON_NAME, icon: 'learn', open: skills_open")
    expect(source).toContain("{ name: project_ui.PROJECTS_BUTTON_NAME, icon: 'history', open: projects_open")
    expect(source).toContain("{ name: debug_ui.DEBUG_BUTTON_NAME, icon: 'debug', open: debug_open")
    expect(source).toContain("style: 'frame_action_button',\n      tooltip: button.tooltip")
    expect(source).toContain('element.toggled = button.open')
  })

  it('declares both variants of every title-bar icon the console draws', () => {
    const data = readFileSync(new URL('../data.lua', import.meta.url), 'utf8')
    const chrome = readFileSync(new URL('./task_board_console.ts', import.meta.url), 'utf8')
    expect(data).toContain('for _, name in ipairs({"learn", "history", "debug"}) do')
    expect(data).toContain('for _, variant in ipairs({"white", "black"}) do')
    for (const icon of ['learn', 'history', 'debug']) {
      expect(chrome).toContain(`'${icon}'`)
      for (const variant of ['white', 'black']) {
        expect(existsSync(new URL(`../graphics/icons/console/${icon}-${variant}.png`, import.meta.url))).toBe(true)
      }
    }
  })

  it('does not print the plan step number twice when the plan numbers itself', () => {
    expect(step_caption('1. Craft iron gear wheels')).toBe('Craft iron gear wheels')
    expect(step_caption('12) Connect the boiler')).toBe('Connect the boiler')
    expect(step_caption('Craft 1. iron gear wheels')).toBe('Craft 1. iron gear wheels')
    expect(step_caption('2026 was the year')).toBe('2026 was the year')
    expect(step_caption('Place 4 boilers')).toBe('Place 4 boilers')
    expect(step_caption('3.')).toBe('3.')
    expect(step_caption('')).toBe('')
  })

  it('puts PAUSE, FOLLOW and … in one fixed-width row and keeps NEW TASK and TERMINATE behind …', () => {
    const source = taskBoardUiSource()
    expect(source).toContain('const PAUSE_BUTTON_WIDTH = LEFT_COLUMN_WIDTH - FOLLOW_BUTTON_WIDTH - MORE_BUTTON_WIDTH - 2 * COMPACT_BUTTON_SPACING')
    expect(source).toContain('function action_button(element: LuaGuiElement, width: number)')
    expect(source).not.toContain('COMPACT_TASK_BUTTON_WIDTH')
    expect(source).not.toContain('COMPACT_ACTION_BUTTON_WIDTH')
    const row = source.split('export function render_action_row(')[1] ?? ''
    // The destructive pair is only drawn inside the open menu.
    expect(row.indexOf('if (state.more_open) {')).toBeLessThan(row.indexOf('name: NEW_TASK_BUTTON_NAME'))
    expect(row.indexOf('name: TERMINATE_BUTTON_NAME')).toBeLessThan(row.indexOf("const row = actions.add({ type: 'flow', direction: 'horizontal' })"))
    expect(row).toContain('name: PAUSE_BUTTON_NAME')
    expect(row).toContain('name: FOLLOW_BUTTON_NAME')
    expect(row).toContain('name: MORE_BUTTON_NAME')

    expect(source).toContain('pause.enabled = state.pause_enabled')
    expect(source).toContain('terminate.enabled = state.terminate_enabled')
    expect(source).toContain('pause_enabled: pending === undefined')
    expect(source).toContain('terminate_enabled: pending === undefined')
    // An armed TERMINATE keeps the menu open for its confirming click.
    expect(source).toContain('more_open: storage.airi_task_board_more_open?.[player.index] === true || armed')

    expect(source).toContain('follow_caption: debug_ui.follow_button_caption(follow?.active === true)')
    expect(source).toContain("return follow?.active ? 'Click to stop following. A goal paused by Follow will automatically resume.'")
    expect(source).not.toContain('Distance: ${math.floor(follow.current_distance * 10) / 10} tiles')
    expect(source).toContain('if (state.follow_issue.length > 0)')
  })

  it('keeps the large inventory beside a wanted/equipped sidebar below the world preview', () => {
    const source = taskBoardUiSource()
    const build_columns = source.split('function build_columns(')[1]?.split('function refresh_columns(')[0] ?? ''
    const preview_index = build_columns.indexOf('render_world_preview(right, runtime, player)')
    const resources_index = build_columns.indexOf("right.add({ type: 'flow', name: RIGHT_RESOURCES_NAME, direction: 'horizontal' })")
    expect(preview_index).toBeGreaterThanOrEqual(0)
    expect(resources_index).toBeGreaterThan(preview_index)
    expect(build_columns).toContain('render_inventory(resources, runtime, player)')
    expect(build_columns).toContain('render_resource_sidebar(resources, board, runtime, player)')

    const sidebar = source.split('function render_resource_sidebar(')[1]?.split('function render_prompt(')[0] ?? ''
    const wanted_index = sidebar.indexOf('render_wanted_items(sidebar, board, player)')
    const equipped_index = sidebar.indexOf("create_section(sidebar, 'Equipped'")
    expect(wanted_index).toBeGreaterThanOrEqual(0)
    expect(equipped_index).toBeGreaterThan(wanted_index)
    expect(sidebar).toContain("add_equipped_row('GUN', runtime.guns)")
    expect(sidebar).toContain("add_equipped_row('AMMO', runtime.ammo)")
    expect(source).toContain('defines.inventory.character_guns')
    expect(source).toContain('defines.inventory.character_ammo')

    const left_dynamic = source.split('function build_left_dynamic(')[1]?.split('function build_columns(')[0] ?? ''
    expect(left_dynamic).not.toContain('render_inventory(')
    expect(left_dynamic).not.toContain('render_wanted_items(')
    expect(left_dynamic).not.toContain("create_section(sidebar, 'Equipped'")
  })

  it('refreshes the world preview in place so dragging zoom is never cancelled', () => {
    const source = taskBoardUiSource()
    expect(source).toContain('function refresh_world_preview(')
    expect(source).toContain('const resources = right[RIGHT_RESOURCES_NAME]')
    expect(source).toContain('if (!refresh_world_preview(right, runtime, player) || !resources?.valid) {')
    expect(source).toContain('resources.clear(); render_inventory(resources, runtime, player); render_resource_sidebar(resources, board, runtime, player)')

    const refresh_body = source.split('function refresh_world_preview(')[1]?.split('function render_world_preview(')[0] ?? ''
    expect(refresh_body).toContain('camera.position = preview.position')
    expect(refresh_body).toContain('position.caption = preview_position_caption(preview)')
    expect(refresh_body).not.toContain('slider_value')
    expect(refresh_body).not.toContain('PREVIEW_ZOOM_SLIDER_NAME')
    expect(refresh_body).not.toContain('.clear()')
  })

  it('uses compact controls with a Shelf + active-plan tracker and keeps current-task timestamped activity as retained history', () => {
    const source = taskBoardUiSource()
    expect(source).toContain('function action_button(')
    expect(source).toContain("'Plan Tracker'")
    expect(source).toContain('function render_tracker(')
    expect(source).toMatch(/render_tracker\([\w.]+, board[,)]/)
    expect(source).toContain("create_section(parent, 'Activity'")
    expect(source).toContain('const previous = storage.airi_task_board_ui')
    expect(source).toContain('const changed_task = activity_state.bind_activity_context(next.conversation_id, next.goal_id)')
    expect(source).toContain('stamp_activity_times(next, changed_task ? undefined : previous, game.tick)')
    expect(source).toContain("caption: entry.timestamp ?? '--:--:--'")
    expect(source).not.toContain('render_steps(left, board)')
    expect(source).not.toContain('render_activity(left, board)')

    const debug_source = taskBoardDebugSource()
    expect(debug_source).toContain("caption: 'Execution Activity'")
    expect(debug_source).toContain('activity_state.activity_history()')
  })

  // Conversation has always carried its LIVE control in its subheader. The
  // execution feed has its own ACTIVITY tab with its controls in the same
  // place; the tracker no longer carries a hidden copy. Debug keeps its feed.
  it('gives the execution feed its own section with its controls in the subheader', () => {
    const source = taskBoardUiSource()
    const tracker = source.split('function render_tracker(')[1]?.split('function refresh_tracker(')[0] ?? ''
    expect(tracker).not.toContain('activity_header')
    const feed = source.split('function render_activity_section(')[1]?.split('function refresh_activity_section(')[0] ?? ''
    expect(feed).toContain('const activity_header = header.add(')
    expect(feed).not.toContain('const activity_header = body.add(')
    expect(feed).toContain('activity_state.style_feed_button(')
    expect(source).toContain('const activity_header = header?.valid ? header[TRACKER.activity_header] : undefined')
    expect(source).not.toContain('activity_header.visible = false')

    const debug_source = taskBoardDebugSource()
    expect(debug_source).toContain('activity_state.style_feed_button(header.add(')
    expect(debug_source).toContain("caption: 'Execution Activity'")
    expect(debug_source).not.toContain("style: 'mini_button'")

    const projects = readFileSync(new URL('./projects/project_window.ts', import.meta.url), 'utf8')
    expect(projects).toContain('activity_state.style_feed_button(parent.add(')
    expect(projects).not.toContain("button.style.font = 'default-small-semibold'")
  })

  // The button is a live readout of which model is answering, not a static icon.
  it('dresses the mod-GUI button with the current provider avatar', () => {
    const source = taskBoardUiSource()
    expect(source).toContain('button.sprite = provider_ui.provider_button_sprite(player.index, BUTTON_SPRITE)')
    expect(source).toContain("button.tooltip = provider_ui.provider_button_tooltip('SGLuna NPC Console')")
    expect(source).toContain('provider_ui.remember_provider_model(stamped.debug?.provider_model)')

    expect(source).toContain('provider_ui.roll_provider_avatar(player.index, game.tick)')
    expect(source).toContain("const BUTTON_SPRITE: SpritePath = 'entity/character'")
    expect(source).not.toContain("const BUTTON_SPRITE: SpritePath = 'item/logistic-robot'")
  })

  // The avatars are prototypes, so the data stage has to declare every variant
  // the control stage can resolve to. A count that drifts leaves a blank button
  // for whichever players rolled the missing one, which is the kind of bug that
  // only shows up for some players on some sessions.
  it('declares every avatar variant the resolver can pick', () => {
    const data_stage = readFileSync(new URL('../data.lua', import.meta.url), 'utf8')
    const provider_source = readFileSync(new URL('./task_board_provider.ts', import.meta.url), 'utf8')

    const declared = new Map<string, number>()
    for (const [, id, count] of data_stage.matchAll(/\{"(\w+)", (\d+)\}/g)) declared.set(id, Number(count))
    const resolved = new Map<string, number>()
    for (const [, id, count] of provider_source.matchAll(/id: '(\w+)',[^}]*?variants: (\d+)/g)) resolved.set(id, Number(count))

    expect(resolved.size).toBe(5)
    expect([...declared.entries()].sort()).toEqual([...resolved.entries()].sort())
    expect(data_stage).toContain('"__autorio__/graphics/icons/provider/" .. id .. ".png"')
    expect(data_stage).toContain('local provider_avatar_source_size = 128')
    expect(data_stage).toContain('local provider_avatar_gui_size = 40')
    expect(data_stage).toContain('scale = provider_avatar_gui_size / provider_avatar_source_size')
    expect(data_stage).not.toContain('scale = 0.25')
  })

  it('keeps avatar optical corrections in asset metadata instead of runtime UI branches', () => {
    const importer = readFileSync(new URL('../scripts/import_provider_icon.py', import.meta.url), 'utf8')
    const manifest = JSON.parse(readFileSync(new URL('../scripts/provider_icon_optical.json', import.meta.url), 'utf8')) as { avatars: Record<string, { scale?: number }> }
    const ui = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
    const provider = readFileSync(new URL('./task_board_provider.ts', import.meta.url), 'utf8')

    expect(importer).toContain('OPTICAL_ADJUSTMENTS_PATH')
    expect(importer).toContain('load_optical_adjustments')
    expect(importer).toContain('--no-optical-adjustment')
    expect(Object.keys(manifest.avatars).sort()).toEqual(['claude-2', 'deepseek-2', 'gemini-1'])
    expect(manifest.avatars['claude-2']?.scale).toBe(1.1)
    expect(manifest.avatars['deepseek-2']?.scale).toBe(1.1)
    expect(manifest.avatars['gemini-1']?.scale).toBe(1.1)

    for (const avatar of Object.keys(manifest.avatars)) {
      expect(ui).not.toContain(avatar)
      expect(provider).not.toContain(avatar)
    }
  })
})
