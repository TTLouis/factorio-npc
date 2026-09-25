import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  sanitize_task_board_ui_snapshot,
  task_board_activity_for_display,
  task_board_lifecycle_pending_expired,
  task_board_preview_zoom,
  task_board_skills_ui_is_open,
  task_board_sync_freshness,
  task_board_ui_is_open,
  task_board_ui_prompt_draft,
  task_board_ui_terminate_is_armed,
  toggle_task_board_skills_ui_open,
  toggle_task_board_ui_open,
  create_task_board_ui_remote_interface,
} from './task_board_ui'
import { BUTTON_NAME, PROMPT_FIELD_NAME, ROOT_NAME, SKILLS_BUTTON_NAME, SKILLS_ROOT_NAME } from './task_board_ui_constants'
import { get_handler } from './test-event-registry'
import { DEBUG_BUTTON_NAME } from './task_board_debug'
import { PROJECTS_BUTTON_NAME } from './projects/project_window'
import { SKILLS_WINDOW } from './skills_window'
import { ensure_basic_skill_definitions, get_skill_definition } from './skills'

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


beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('in-game task board UI projection', () => {
  it('keeps bounded canonical progress, activity, and wanted-item fields', () => {
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal_1',
      objective: 'Climb the technology tree',
      status: 'blocked',
      blocker: 'provider recovery exhausted',
      blocker_summary: 'AIRI could not get a usable provider response after retrying.',
      pause_reason: '',
      pause_summary: '',
      completed_count: 2,
      total_steps: 5,
      active_index: 2,
      steps: [
        { id: 'step_1', description: 'Find stone', status: 'completed' },
        { id: 'step_2', description: 'Mine stone', status: 'completed' },
        { id: 'step_3', description: 'Trigger steam power', status: 'blocked' },
        { id: 'step_4', description: 'Build power', status: 'pending' },
        { id: 'step_5', description: 'Start research', status: 'pending' },
      ],
      activity: [
        { kind: 'observation', text: 'No boiler in inventory.' },
        { kind: 'decision', text: 'Craft a boiler before continuing.' },
        { kind: 'action', text: 'craft_item boiler x1' },
      ],
      wanted_items: [
        { name: 'boiler', count: 1, reason: 'planned craft' },
        { name: 'pipe', count: 5, reason: 'steam connection' },
      ],
      shelf: [
        { id: 'node-smelting', intent: 'Establish smelting', why_it_matters: 'Feeds automation', status: 'ready_to_refine', depends_on: [], development_hint: 'vertical', linked: true },
        { id: 'node-science', intent: 'Unlock automation science', why_it_matters: 'Advances research', status: 'tentative', depends_on: ['node-smelting'], linked: false },
      ],
    })
    expect(board).toMatchObject({
      status: 'blocked',
      blocker: 'provider recovery exhausted',
      blocker_summary: 'AIRI could not get a usable provider response after retrying.',
      completed_count: 2,
      total_steps: 5,
      active_index: 2,
      steps: [{ id: 'step_1' }, { id: 'step_2' }, { id: 'step_3' }, { id: 'step_4' }, { id: 'step_5' }],
      activity: [
        { kind: 'observation', text: 'No boiler in inventory.' },
        { kind: 'decision', text: 'Craft a boiler before continuing.' },
        { kind: 'action', text: 'craft_item boiler x1' },
      ],
      wanted_items: [
        { name: 'boiler', count: 1 },
        { name: 'pipe', count: 5 },
      ],
      shelf: [
        { id: 'node-smelting', status: 'ready_to_refine', linked: true },
        { id: 'node-science', status: 'tentative', depends_on: ['node-smelting'], linked: false },
      ],
    })
  })

  it('preserves immutable plan identity and explicit blocked-choice state', () => {
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal_blocked',
      objective: 'Build early automation',
      plan: {
        plan_id: 'goal_blocked_p4',
        plan_version: 2,
        derived_from: 'goal_blocked_p1',
      },
      blocked: {
        reason: 'operation_preflight_failed:missing_dependency',
        summary: 'The committed route cannot satisfy a required dependency.',
        awaiting_choice: false,
        choice: 'revise',
      },
      status: 'blocked',
      blocker: 'operation_preflight_failed:missing_dependency',
      pause_reason: '',
      completed_count: 1,
      total_steps: 2,
      active_index: 1,
      steps: [
        { id: 'step_1', description: 'Gather stone', status: 'completed' },
        { id: 'step_2', description: 'Build furnace', status: 'blocked' },
      ],
      activity: [],
      wanted_items: [],
    })
    expect(board?.plan).toEqual({
      plan_id: 'goal_blocked_p4',
      plan_version: 2,
      derived_from: 'goal_blocked_p1',
    })
    expect(board?.blocked).toEqual({
      reason: 'operation_preflight_failed:missing_dependency',
      summary: 'The committed route cannot satisfy a required dependency.',
      awaiting_choice: false,
      choice: 'revise',
    })
  })

  it('ignores retired Project Board payload while preserving Plan Tracker steps', () => {
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal_rocket',
      objective: 'Launch a rocket',
      project: {
        kind: 'project_board_v1',
        project_id: 'goal_rocket',
        title: 'Launch a rocket',
        status: 'active',
        completed_milestones: [{ id: 'm0', title: 'Establish burner production', status: 'completed' }],
        current_milestone: { id: 'm1', title: 'Reach Automation', status: 'active', completion_summary: 'Automation is researched.' },
        next_milestones: [{ id: 'm2', title: 'Establish electric power', status: 'tentative' }],
        development_direction: 'vertical',
        transition_state: '',
      },
      status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 1, active_index: 0,
      steps: [{ id: 'step_1', description: 'Produce science packs for Automation', status: 'active' }],
      activity: [], wanted_items: [],
    })
    expect(board?.project).toBeUndefined()
    expect(board?.steps[0].description).toBe('Produce science packs for Automation')
  })

  it('bounds malformed optional UI detail fields instead of trusting them', () => {
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal', objective: 'test', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 1, active_index: 0,
      steps: [{ id: 'step_1', description: 'Test', status: 'active' }],
      activity: [{ kind: 'private-chain-of-thought', text: 'Visible summary only' }],
      wanted_items: [{ name: 'iron-plate', count: -50, reason: 'test' }],
    })
    expect(board?.activity).toEqual([{ kind: 'note', text: 'Visible summary only' }])
    expect(board?.wanted_items).toEqual([{ name: 'iron-plate', count: 1, reason: 'test' }])
  })

  it('keeps external Factorio rich-text syntax literal at the GUI boundary without mutating snapshot data', () => {
    const rich = '[item=iron-plate] [color=red]hello[/color] [ ]] 普通中文 English'
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal_rich', objective: rich, response: rich, status: 'active', blocker: rich, pause_reason: rich,
      completed_count: 0, total_steps: 1, active_index: 0,
      steps: [{ id: 'step_1', description: rich, status: 'active' }],
      activity: [{ kind: 'result', text: rich }],
      wanted_items: [{ name: 'iron-plate', count: 1, reason: rich }],
      conversation_id: 'conv_rich',
      conversation: [{ id: 'm1', role: 'assistant', sender: rich, text: rich }],
    })
    expect(board?.objective).toBe(rich)
    expect(board?.response).toBe(rich)
    expect(board?.steps[0].description).toBe(rich)
    expect(board?.activity[0].text).toBe(rich)
    expect(board?.wanted_items[0].reason).toBe(rich)
    expect(board?.conversation[0].text).toBe(rich)

    const source = taskBoardUiSource()
    const debug = readFileSync(new URL('./task_board_debug.ts', import.meta.url), 'utf8')
    const boundary = readFileSync(new URL('./task_board_gui_text.ts', import.meta.url), 'utf8')
    expect(boundary).toContain('defines.rich_text_setting.disabled')
    expect(source).toContain('literal_gui_text(')
    expect(debug).toContain('literal_gui_text(')
    expect(source).toContain('trusted_rich_text(')
    expect(source).toContain('[item=')
    expect(source).toContain('[img=')
    expect(source).not.toContain('— ${item.reason}')
  })
  it('rejects malformed snapshots instead of creating a second source of truth', () => {
    expect(sanitize_task_board_ui_snapshot(undefined)).toBeUndefined()
    expect(sanitize_task_board_ui_snapshot({ status: 'active' })).toBeUndefined()
  })

  it('labels canonical evidence as verified and keeps internal task codes diagnostic-only in the main console', () => {
    const source = taskBoardUiSource()
    const statusPanel = source.split('function last_result_line(')[1]?.split('function console_now_card(')[0] ?? ''
    const refreshSteps = source.split('function refresh_steps(')[1]?.split('function refresh_activity(')[0] ?? ''

    expect(source).toContain('${board.completed_count} verified')
    expect(source).not.toContain('${board.completed_count} done')
    expect(refreshSteps).toContain('task_condition_text(board.blocker_summary, board.blocker')
    expect(refreshSteps).not.toContain('tooltip: board.blocker')
    expect(refreshSteps).toContain("caption: step.status.toUpperCase()")
    expect(refreshSteps).toContain("if (step.status === 'completed' || step.status === 'pending') description.style.font_color = TONE_COLORS.muted")
    expect(statusPanel).toContain('entry.text === board.blocker || entry.text === board_blocker_text')
    expect(statusPanel).not.toContain('last_tooltip')
  })

  it('falls back to the canonical current step when an active task has no activity entries yet', () => {
    const board = sanitize_task_board_ui_snapshot({
      goal_id: 'goal_1', objective: 'Gather stone', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 2, active_index: 0,
      steps: [
        { id: 'step_1', description: 'Walk to stone patch', status: 'active' },
        { id: 'step_2', description: 'Mine stone', status: 'pending' },
      ],
      activity: [], wanted_items: [],
    })
    expect(task_board_activity_for_display(board)).toEqual([
      {
        kind: 'system',
        text: 'Current canonical step 1/2: Walk to stone patch (active). Waiting for the next auditable observation, action, or result.',
      },
    ])
  })

  it('keeps the task board window closed by default and toggles per player', () => {
    expect(task_board_ui_is_open(1)).toBe(false)
    expect(task_board_ui_is_open(2)).toBe(false)

    expect(toggle_task_board_ui_open(1)).toBe(true)
    expect(task_board_ui_is_open(1)).toBe(true)
    expect(task_board_ui_is_open(2)).toBe(false)

    expect(toggle_task_board_ui_open(1)).toBe(false)
    expect(task_board_ui_is_open(1)).toBe(false)
  })

  it('keeps terminate confirmation scoped to one player and a short tick window', () => {
    ;(globalThis as any).storage.airi_task_board_terminate_confirm_until = { 1: 600, 2: 0 }
    expect(task_board_ui_terminate_is_armed(1, 599)).toBe(true)
    expect(task_board_ui_terminate_is_armed(1, 601)).toBe(false)
    expect(task_board_ui_terminate_is_armed(2, 1)).toBe(false)
  })

  it('bounds lifecycle pending state so a lost ACK cannot brick controls forever', () => {
    expect(task_board_lifecycle_pending_expired(undefined, 100)).toBe(true)
    expect(task_board_lifecycle_pending_expired(100, 100 + 60 * 60 - 1)).toBe(false)
    expect(task_board_lifecycle_pending_expired(100, 100 + 60 * 60)).toBe(true)

    const source = taskBoardUiSource()
    expect(source).toContain('task_board_lifecycle_pending_expired(pending.started_tick, game.tick)')
    expect(source).toContain('started_tick: game.tick')
  })

  it('keeps unsent prompt drafts scoped per player', () => {
    ;(globalThis as any).storage.airi_task_board_prompt_draft = { 1: 'build power', 2: 'follow me' }
    expect(task_board_ui_prompt_draft(1)).toBe('build power')
    expect(task_board_ui_prompt_draft(2)).toBe('follow me')
    expect(task_board_ui_prompt_draft(3)).toBe('')
  })

  it('keeps preview zoom scoped per player without writing from render reads', () => {
    expect(task_board_preview_zoom(1)).toBe(0.75)
    expect((globalThis as any).storage).toEqual({})
    ;(globalThis as any).storage.airi_task_board_preview_zoom = { 1: 1.25, 2: 0.5 }
    expect(task_board_preview_zoom(1)).toBe(1.25)
    expect(task_board_preview_zoom(2)).toBe(0.5)
  })

  it('does not erase Factorio GUI element types before chained add calls', () => {
    const source = taskBoardUiSource()
    expect(source).not.toMatch(/const\s+\w+\s*:\s*any\s*=\s*player\.gui/)
    expect(source).not.toContain('const root: any')
    expect(source).toContain('as FrameGuiElement')
    expect(source).toContain("surface_index: LuaSurface['index']")
  })

  it('accepts plan-less live agent snapshots and bounds the agent phase', () => {
    const idle = sanitize_task_board_ui_snapshot({
      goal_id: '', objective: 'build power', status: 'idle', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 0, active_index: 0, steps: [], activity: [], wanted_items: [],
      agent: { phase: 'observing', detail: 'Checking getInventory' },
    })
    expect(idle).toMatchObject({ status: 'idle', steps: [], agent: { phase: 'observing', detail: 'Checking getInventory' } })
    expect(task_board_activity_for_display(idle)).toEqual([])

    const legacy = sanitize_task_board_ui_snapshot({
      goal_id: 'goal', objective: 'test', status: 'active', blocker: '', pause_reason: '',
      completed_count: 0, total_steps: 1, active_index: 0,
      steps: [{ id: 'step_1', description: 'Test', status: 'active' }],
      agent: { phase: 'plotting', detail: 'x' },
    })
    expect(legacy?.agent.phase).toBe('idle')
    expect(sanitize_task_board_ui_snapshot({ steps: [] })?.agent).toEqual({ phase: 'idle', detail: '' })
  })

  it('uses a vanilla square mod-gui button instead of a text button in gui.top', () => {
    const source = taskBoardUiSource()
    expect(source).toContain("const MOD_GUI_TOP_FRAME_NAME = 'mod_gui_top_frame'")
    expect(source).toContain("style: 'slot_window_frame'")
    expect(source).toContain("style: 'mod_gui_inside_deep_frame'")
    expect(source).toMatch(/type: 'sprite-button',\s+name: BUTTON_NAME,\s+sprite: BUTTON_SPRITE/)
    expect(source).toContain("const BUTTON_SPRITE: SpritePath = 'entity/character'")
    expect(source).toContain("style: 'slot_button'")
    expect(source).toContain('button.toggled = task_board_ui_is_open(player.index)')
    expect(source).not.toContain("caption: 'AIRI',")
  })

  it('uses a movable screen window with native Factorio title, section, and control styles', () => {
    const source = taskBoardUiSource()
    expect(source).toContain('player.gui.screen.add')
    expect(source).toContain("style: 'frame_title'")
    expect(source).toContain("style: 'draggable_space_header'")
    expect(source).toContain("style: 'frame_action_button'")
    expect(source).toContain("style: 'subheader_frame'")
    expect(source).toContain("style: 'inside_shallow_frame'")
    expect(source).toContain("style: 'dialog_button'")
    expect(source).toContain("style: 'red_button'")
    expect(source).toContain("style: state.follow_active ? 'confirm_button' : 'dialog_button'")
    expect(source).toContain("style: 'deep_slots_scroll_pane'")
    expect(source).toContain("type: 'progressbar'")
    expect(source).toContain('root.location = previous_location')
    expect(source).toContain('STATUS_SECTION_WIDTH')
    expect(source).not.toContain('TOP_SECTION_HEIGHT')
    expect(source).not.toContain('RESOURCE_SECTION_HEIGHT')
  })

  it('aligns the two columns, keeps section spacing uniform, and puts the actions under the prompt', () => {
    const source = taskBoardUiSource()
    expect(source).toContain('left.style.vertical_spacing = COLUMN_SPACING')
    expect(source).toContain('dynamic.style.vertical_spacing = COLUMN_SPACING')
    expect(source).toContain('resources.style.horizontal_spacing = COLUMN_SPACING')
    // Each card has its own slot, so one card changing leaves the others alone.
    expect(source).toContain('slot => console_ui.render_goal_card(slot, goal)')
    expect(source).toContain('slot => console_ui.render_now_card(slot, now_card)')
    expect(source).not.toContain('console_ui.render_latest_card(')
    // The old Controls grid is gone: window buttons are in the title bar and
    // PAUSE / FOLLOW / … sit in one row under the prompt.
    expect(source).not.toContain("create_section(parent, 'Controls'")
    expect(source).not.toContain('HALF_SECTION_WIDTH')
    expect(source).toContain('right.style.vertically_stretchable = true')
    expect(source).toMatch(/build_left_dynamic\(banner, dynamic, plan_dynamic,[\s\S]*render_prompt\(left, player\)[\s\S]*console_ui\.render_action_row\(left,[\s\S]*render_world_preview\(right, runtime, player\)/)
  })

  it('puts a native Factorio camera preview in the right column with an interactive zoom slider', () => {
    const source = taskBoardUiSource()
    expect(source).toContain("type: 'camera'")
    expect(source).toContain('position: preview.position')
    expect(source).toContain('surface_index: preview.surface_index')
    expect(source).toContain('camera.entity = preview.entity')
    expect(source).toContain('PREVIEW_COLUMN_WIDTH')
    expect(source).toContain("type: 'slider'")
    expect(source).toContain('name: PREVIEW_ZOOM_SLIDER_NAME')
    expect(source).toContain('defines.events.on_gui_value_changed')
    expect(source).toContain('camera.zoom = zoom')
    expect(source).toContain('CONSOLE_LAYOUT.preview_min_height')
  })

  it('makes preview coordinates a view-only button that uses the current runtime preview', () => {
    const source = taskBoardUiSource()
    expect(source).toContain("type: 'button', name: PREVIEW_POSITION_NAME")
    expect(source).toContain("style: 'mini_button_aligned_to_text_vertically'")
    expect(source).toContain("tooltip: 'Show NPC in remote view'")
    const focus = source.split('function focus_npc_preview(')[1]?.split('/**\n * Updates the preview')[0] ?? ''
    expect(focus).toContain('const preview = runtime_snapshot().preview')
    expect(focus).toContain('const surface = game.get_surface(preview.surface_index)')
    expect(focus).toContain('player.set_controller({ type: defines.controllers.remote, position: preview.position, surface })')
    expect(focus).not.toContain('preview_position_caption')
    expect(focus).not.toContain('enqueue_ui_input')
    expect(focus).not.toContain('emit_control')
    expect(focus).not.toContain('teleport')
    expect(source).toContain("if (element.name === PREVIEW_POSITION_NAME) { focus_npc_preview(player); return }")

    const refresh = source.split('function refresh_world_preview(')[1]?.split('function render_world_preview(')[0] ?? ''
    expect(refresh).toContain('const caption = preview_position_caption(preview)')
    expect(refresh).toContain('if (position.caption !== caption) position.caption = caption')
    expect(refresh).toContain('const zoom = task_board_preview_zoom(player.index)')
    expect(refresh).toContain('if (camera.zoom !== zoom) camera.zoom = zoom')
    expect(refresh).not.toContain('.clear()')
  })
  it('shows live mod task state and when SGLuna last synced', () => {
    const source = taskBoardUiSource()
    const control = readFileSync(new URL('./control.ts', import.meta.url), 'utf8')
    expect(source).toContain('storage.airi_task_board_ui_synced_tick = game.tick')
    expect(source).toContain('World task: ${world_task_summary(runtime.world_task)}')
    expect(source).toContain('Last sync: ${sync_summary(synced_tick)}')
    expect(control).toContain('set_task_board_world_task_provider(() => task_manager.get_status_snapshot())')
  })

  it('provides a direct SGLuna prompt field that preserves drafts and queues structured input', () => {
    const source = taskBoardUiSource()
    expect(source).toContain("type: 'textfield'")
    expect(source).toContain("name: PROMPT_FIELD_NAME")
    expect(source).toContain("name: PROMPT_SEND_BUTTON_NAME")
    expect(source).toContain("kind: 'prompt'")
    expect(source).toContain('enqueue_ui_input({')
    expect(source).toContain('defines.events.on_gui_text_changed')
    expect(source).toContain('defines.events.on_gui_confirmed')
  })

  it('refreshes live content without destroying the prompt field being typed into', () => {
    const source = taskBoardUiSource()
    // Only the one card whose content changed is cleared, never the column around the prompt.
    expect(source).toContain('if (slot.tags.signature === signature) return')
    expect(source).toContain('slot.clear(); build(slot); slot.tags = { signature }')
    expect(source).toContain('build_left_dynamic(banner, dynamic, plan_dynamic, player, board)')
    expect(source).toContain('right.clear()')
    expect(source).toContain('render_prompt(left, player)')
    expect(source).not.toMatch(/left\.clear\(\)/)
    expect(source).not.toContain('task_board_ui_prompt_draft(player.index).length === 0')
  })

  it('places the window before building content so it never opens in the corner', () => {
    const source = taskBoardUiSource()
    expect(source).toMatch(/root\.auto_center = true[\s\S]*console_ui\.render_console_titlebar\(root,/)
    expect(source).not.toContain('root.force_auto_center()')
  })

  it('does not create storage tables from the render path', () => {
    ;(globalThis as any).storage = {}
    expect(task_board_ui_is_open(1)).toBe(false)
    expect(task_board_ui_prompt_draft(1)).toBe('')
    expect(task_board_ui_terminate_is_armed(1, 10)).toBe(false)
    expect(task_board_preview_zoom(1)).toBe(0.75)
    expect((globalThis as any).storage).toEqual({})

    expect(toggle_task_board_ui_open(1)).toBe(true)
    expect((globalThis as any).storage.airi_task_board_ui_open).toEqual({ 1: true })
  })

  it('keeps rendering read-only so drawing the console cannot desync multiplayer', () => {
    const source = taskBoardUiSource()
    const controller = readFileSync(new URL('./actors/actor_controller.ts', import.meta.url), 'utf8')
    expect(source).toContain('peek_controlled_actor()')
    expect(source).not.toContain('get_controlled_actor()')
    expect(controller).toContain('export function peek_controlled_actor()')

    const skills = readFileSync(new URL('./skills.ts', import.meta.url), 'utf8')
    const learning = readFileSync(new URL('./factory_area_learning.ts', import.meta.url), 'utf8')
    expect(skills).toContain('return storage.airi_skill_definitions ?? {}')
    expect(skills).toContain('function store_dynamic_skill_definition')
    expect(skills).toContain('registry[skill.id] = skill')
    expect(skills).toContain('MAX_DYNAMIC_SKILL_DEFINITIONS')
    expect(learning).toContain('return storage.airi_factory_area_analyses ?? {}')
    expect(learning).toContain('return storage.airi_factory_area_order ?? []')
  })

  it('opens area learning in its own window instead of consuming console space', () => {
    const source = taskBoardUiSource()
    const skills = readFileSync(new URL('./skills.ts', import.meta.url), 'utf8')
    expect(source).toContain('name: SKILLS_BUTTON_NAME')
    // The skills window is its own module (like Old tasks): a skills list with a
    // detail pane, and area learning above it. Each part redraws only on change.
    const window = readFileSync(new URL('./skills_window.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('render_skill_export_section(left)')
    expect(source).toContain('skills_ui.render_skills_window(player, task_board_ui_is_open(player.index) && task_board_skills_ui_is_open(player.index))')
    expect(window).toContain('skills.render_learn_area_button(actions)')
    expect(window).toContain("type: 'list-box', name: SKILLS_WINDOW.list")
    expect(skills).toContain('export function render_learn_area_button(')

    expect(window).toContain('player.gui.screen.add')
    expect(window).toContain('titlebar.drag_target = root')
    expect(window).toContain('if (section.tags.signature === signature) return')
    expect(source).toMatch(/close_task_board_skills_ui\(player\.index\)[\s;]*skills_ui\.close_skills_window\(player\)/)
  })

  it('keeps the area learning window closed by default and scoped per player', () => {
    ;(globalThis as any).storage = {}
    expect(task_board_skills_ui_is_open(1)).toBe(false)
    expect((globalThis as any).storage).toEqual({})

    expect(toggle_task_board_skills_ui_open(1)).toBe(true)
    expect(task_board_skills_ui_is_open(1)).toBe(true)
    expect(task_board_skills_ui_is_open(2)).toBe(false)
    expect(toggle_task_board_skills_ui_open(1)).toBe(false)
    expect(task_board_skills_ui_is_open(1)).toBe(false)
  })

  it('treats a snapshot as current only while the runtime keeps answering', () => {
    expect(task_board_sync_freshness(undefined, 5000)).toBe('offline')
    expect(task_board_sync_freshness(4000, 4000)).toBe('live')
    expect(task_board_sync_freshness(4000, 4000 + 10 * 60)).toBe('live')
    expect(task_board_sync_freshness(4000, 4000 + 10 * 60 + 1)).toBe('stale')
    expect(task_board_sync_freshness(9000, 4000)).toBe('live')
  })

  it('stops presenting a stale snapshot as the current SGLuna state', () => {
    const source = taskBoardUiSource()
    expect(source).toContain("if (freshness === 'offline') return { tone: 'muted', caption: 'OFFLINE' }")
    expect(source).toContain("if (freshness === 'stale') return { tone: 'bad', caption: 'STALE' }")
    expect(source).toContain("? 'NOT CONNECTED'")
    expect(source).toContain('NO ANSWER — last seen ${agent_caption(phase)}')
    expect(source).toContain('polls unanswered')
  })

  it('asks the runtime for a snapshot over the drain the runtime already performs', () => {
    const source = taskBoardUiSource()
    expect(source).toContain("return { kind: 'poll', version: 1, tick: game.tick, debug: debug_ui.any_debug_ui_open() }")
    expect(source).toContain('const poll = poll_request()')
    expect(source).toContain('if (!any_console_open()) return undefined')
    expect(source).toContain('if (synced !== undefined && math.max(0, game.tick - synced) < POLL_REQUEST_TICKS) return undefined')
    expect(source).toContain('function enqueue_ui_input(input: TaskBoardUiInput)')
  })

  it('drains queued input before appending a poll so a request cannot evict player input', () => {
    ;(globalThis as any).game.tick = 100000
    ;(globalThis as any).game.connected_players = []
    const source = taskBoardUiSource()
    const drain = source.split('function drain_ui_inputs() {')[1]?.split('function task_board_ui_prompt_draft')[0] ?? ''
    expect(drain).toContain('storage.airi_task_board_ui_inputs = []')
    expect(drain.indexOf('storage.airi_task_board_ui_inputs = []')).toBeLessThan(drain.indexOf('drained.push(poll)'))
  })

  it('labels request-cumulative and latest completed round token usage separately', () => {
    const model = readFileSync(new URL('./task_board_debug.ts', import.meta.url), 'utf8')
    const render = readFileSync(new URL('./task_board_debug_render.ts', import.meta.url), 'utf8')
    expect(render).toContain("add_compact_row(provider_table, 'Tokens · request cumulative', tokens)")
    expect(render).toContain("add_compact_row(provider_table, 'Latest completed round', latest_round_tokens)")
    expect(model).toContain('latest_round_cached_input_units')
  })

  it('removes activity hover state and handlers while preserving scroll pause and explicit LIVE resume', () => {
    const source = taskBoardUiSource()
    const activity = readFileSync(new URL('./task_board_activity.ts', import.meta.url), 'utf8')
    const debug = readFileSync(new URL('./task_board_debug.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('defines.events.on_gui_hover')
    expect(source).not.toContain('defines.events.on_gui_leave')
    expect(activity).not.toContain('set_activity_hover')
    expect(activity).not.toContain('hover:')
    expect(debug).not.toContain('set_debug_activity_hover')
    expect(debug).not.toContain('view.hover')
    expect(debug).not.toContain('HOLD')
    expect(source).toContain('activity_state.stop_activity_follow(player.index, last_shown_activity_key(activity_scroll_of(player)))')
    expect(source).toContain('activity_state.resume_activity_follow(player.index, last_shown_activity_key(scroll))')
  })
  it('only emits fixed UI control actions instead of arbitrary console commands', () => {
    const source = taskBoardUiSource()
    expect(source).toContain("type TaskBoardUiControlAction = 'pause' | 'terminate' | 'follow' | 'stop_follow' | 'new_task'")
    expect(source).toContain("kind: 'control'")
    expect(source).toContain('drain_inputs: () => drain_ui_inputs()')
    expect(source).not.toContain('rcon.print')
  })
})


it('uses SGLuna for normal console branding while retaining AIRI actor identity internally', () => {
  const source = taskBoardUiSource()
  expect(source).toContain("caption: 'Prompt SGLuna'")
  expect(source).toContain("'SGLuna NPC Console'")
  expect(source).toContain('The console polls the SGLuna runtime')
  expect(source).toContain("runtime.actor_name || 'AIRI'")
  expect(source).not.toContain("tooltip: 'Send a prompt directly to AIRI")
})

// A small stand-in for Factorio's GUI tree. It counts every structural change
// (add, clear, destroy) so a test can prove that a refresh with nothing new to
// show leaves the console alone. Rebuilding while the player drags a window or
// types in the prompt is what made the console feel laggy and drop keystrokes.
interface GuiCounter { add: number, clear: number, destroy: number, log: string[] }
function fake_gui_element(counter: GuiCounter, player_index: number, spec: Record<string, any>, parent?: any): any {
  const children: any[] = []
  const props: Record<string, any> = { ...spec, tags: spec.tags ?? {} }
  let valid = true
  const style: Record<string, any> = {}
  const invalidate = (element: any) => { for (const child of element.children) invalidate(child); element.__invalidate() }
  const self: any = new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== 'string') return undefined
      switch (key) {
        case 'valid': return valid
        case 'children': return children.slice()
        case 'parent': return parent
        case 'style': return style
        case 'player_index': return player_index
        case '__invalidate': return () => { valid = false }
        case '__remove': return (child: any) => { const index = children.indexOf(child); if (index >= 0) children.splice(index, 1) }
        case 'add': return (child_spec: Record<string, any>) => {
          counter.add++; counter.log.push(`add ${child_spec.type}:${child_spec.name ?? ''}`)
          const child = fake_gui_element(counter, player_index, child_spec, self); children.push(child); return child
        }
        case 'clear': return () => { counter.clear++; counter.log.push(`clear ${props.name ?? props.type}`); for (const child of children.splice(0)) invalidate(child) }
        case 'destroy': return () => {
          counter.destroy++; counter.log.push(`destroy ${props.name ?? props.type}`); invalidate(self)
          if (parent !== undefined) parent.__remove(self)
        }
        case 'bring_to_front': case 'focus': case 'scroll_to_bottom': case 'scroll_to_top': case 'scroll_to_element': case 'select': case 'select_all': case 'force_auto_center': return () => {}
      }
      if (key in props) return props[key]
      return children.find(child => child.name === key)
    },
    set: (_target, key, value) => { props[key as string] = value; return true },
  })
  return self
}

describe('console refresh leaves unchanged sections alone', () => {
  function open_console() {
    const counter: GuiCounter = { add: 0, clear: 0, destroy: 0, log: [] }
    const root = (kind: string) => fake_gui_element(counter, 1, { type: 'flow', name: kind })
    const player: any = { index: 1, name: 'owner', valid: true, surface: { index: 1, valid: true }, position: { x: 0, y: 0 }, gui: { screen: root('screen'), top: root('top'), left: root('left') }, print: () => {}, set_controller: () => {}, get_main_inventory: () => ({ get_contents: () => [] }), get_inventory: () => ({ get_contents: () => [] }) }
    const g = globalThis as any
    const interfaces: Record<string, any> = {}
    let tick_handler: (() => void) | undefined
    const saved = { add_interface: g.remote.add_interface, on_nth_tick: g.script.on_nth_tick, players: g.game.connected_players, get_player: g.game.get_player }
    g.remote.add_interface = (name: string, fns: any) => { interfaces[name] = fns }
    g.script.on_nth_tick = (_tick: number, handler: () => void) => { tick_handler = handler }
    g.game.connected_players = [player]
    g.game.get_player = () => player
    create_task_board_ui_remote_interface()
    const restore = () => { g.remote.add_interface = saved.add_interface; g.script.on_nth_tick = saved.on_nth_tick; g.game.connected_players = saved.players; g.game.get_player = saved.get_player }
    const click = (name: string) => get_handler(g.defines.events.on_gui_click)({ player_index: 1, element: { valid: true, player_index: 1, name, tags: {} } })
    const reset = () => { counter.add = 0; counter.clear = 0; counter.destroy = 0; counter.log = [] }
    return { counter, player, board: interfaces.autorio_task_board, tick: () => tick_handler?.(), click, reset, restore }
  }
  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    goal_id: 'goal_ui', conversation_id: 'conv_ui', objective: 'Smelt iron plates', status: 'running', pause_reason: '', completed_count: 1, total_steps: 3, active_index: 1,
    steps: [{ id: 's1', description: 'Mine ore', status: 'completed' }, { id: 's2', description: 'Build furnace', status: 'active' }, { id: 's3', description: 'Smelt', status: 'pending' }],
    activity: [{ kind: 'action', text: 'mine iron-ore x10' }], wanted_items: [], response: 'Working on the furnace.',
    ...overrides,
  })
  const find = (element: any, name: string): any => element.name === name ? element : element.children.map((child: any) => find(child, name)).find((hit: any) => hit !== undefined)

  it('a periodic refresh with no new data adds, clears and destroys nothing', () => {
    const ui = open_console()
    try {
      ui.click(BUTTON_NAME); ui.click(SKILLS_BUTTON_NAME); ui.click(PROJECTS_BUTTON_NAME); ui.click(DEBUG_BUTTON_NAME)
      expect(ui.board.set_snapshot(snapshot())).toBe(true)
      ui.tick()
      ui.reset()
      ui.tick(); ui.tick()
      expect(ui.counter.log).toEqual([])
    }
    finally { ui.restore() }
  })

  it('a snapshot that repeats the last one changes nothing on screen', () => {
    const ui = open_console()
    try {
      ui.click(BUTTON_NAME); ui.click(SKILLS_BUTTON_NAME); ui.click(PROJECTS_BUTTON_NAME); ui.click(DEBUG_BUTTON_NAME)
      ui.board.set_snapshot(snapshot()); ui.tick()
      ui.reset()
      ui.board.set_snapshot(snapshot())
      expect(ui.counter.log).toEqual([])
    }
    finally { ui.restore() }
  })

  it('a click never rebuilds the window the button sits in', () => {
    const ui = open_console()
    try {
      ui.click(BUTTON_NAME); ui.board.set_snapshot(snapshot()); ui.tick()
      const window = ui.player.gui.screen[ROOT_NAME]
      ui.reset()
      ui.click(SKILLS_BUTTON_NAME); ui.click(PROJECTS_BUTTON_NAME); ui.click(DEBUG_BUTTON_NAME)
      ui.click(SKILLS_BUTTON_NAME); ui.click(PROJECTS_BUTTON_NAME); ui.click(DEBUG_BUTTON_NAME)
      expect(window.valid).toBe(true)
      expect(ui.counter.log.filter(line => line === `destroy ${ROOT_NAME}`)).toEqual([])
    }
    finally { ui.restore() }
  })

  it('skills window: select a skill, edit it, and a refused save keeps the typed text', () => {
    const ui = open_console()
    try {
      ensure_basic_skill_definitions()
      ui.click(BUTTON_NAME); ui.click(SKILLS_BUTTON_NAME); ui.board.set_snapshot(snapshot())
      const skills_root = ui.player.gui.screen[SKILLS_ROOT_NAME]
      const list = find(skills_root, SKILLS_WINDOW.list)
      const ids = list.tags.ids as string[]
      expect(ids.length).toBeGreaterThan(1)
      expect(list.selected_index).toBe(1)
      // Pick the second skill; the detail pane follows.
      list.selected_index = 2
      get_handler((globalThis as any).defines.events.on_gui_selection_state_changed)({ player_index: 1, element: list })
      const second = get_skill_definition(ids[1])!
      expect(find(skills_root, SKILLS_WINDOW.detail_title).caption).toBe(second.name)

      ui.click(SKILLS_WINDOW.edit)
      const name = find(skills_root, SKILLS_WINDOW.edit_name)
      expect(name.text).toBe(second.name)
      // An empty name is refused: the form stays, with the player's text and the reason.
      name.text = '   '
      ui.reset()
      ui.click(SKILLS_WINDOW.save)
      expect(name.valid).toBe(true)
      expect(name.text).toBe('   ')
      expect(find(skills_root, SKILLS_WINDOW.edit_error).caption).toContain('name must not be empty')
      expect(ui.counter.log.filter(line => line.startsWith('clear'))).toEqual([])
      expect(get_skill_definition(ids[1])).toEqual(second)

      name.text = 'My Renamed Skill'
      ui.click(SKILLS_WINDOW.save)
      const saved = get_skill_definition(ids[1])!
      expect(saved.name).toBe('My Renamed Skill')
      expect(saved.revision).toBe(second.revision + 1)
      expect(find(skills_root, SKILLS_WINDOW.edit_name)).toBeUndefined()
      expect(skills_root.valid).toBe(true)
    }
    finally { ui.restore() }
  })

  it('new data never replaces a window or the prompt', () => {
    const ui = open_console()
    try {
      ui.click(BUTTON_NAME); ui.click(SKILLS_BUTTON_NAME)
      ui.board.set_snapshot(snapshot()); ui.tick()
      const window = ui.player.gui.screen[ROOT_NAME]
      const skills = ui.player.gui.screen[SKILLS_ROOT_NAME]
      const prompt = find(window, PROMPT_FIELD_NAME)
      expect(prompt?.valid).toBe(true)
      ui.board.set_snapshot(snapshot({ status: 'blocked', blocker: 'missing_item', blocker_summary: 'No furnace.', active_index: 2, completed_count: 2, response: 'Blocked on the furnace.', activity: [{ kind: 'action', text: 'mine iron-ore x10' }, { kind: 'blocker', text: 'No furnace.' }] }))
      ui.tick()
      expect(window.valid).toBe(true)
      expect(skills.valid).toBe(true)
      expect(prompt.valid).toBe(true)
    }
    finally { ui.restore() }
  })
})
