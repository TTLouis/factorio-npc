import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

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


describe('NPC console information architecture', () => {
  const consoleSource = taskBoardUiSource()
  const debugSource = taskBoardDebugSource()
  const projectsSource = readFileSync(new URL('./projects/project_window.ts', import.meta.url), 'utf8')

  it('puts window buttons in the title bar and the actions in one row under the prompt', () => {
    expect(consoleSource).toContain("create_section(parent, 'Plan Tracker'")
    expect(consoleSource).toContain('activity_header.visible = false')
    expect(consoleSource).toContain('activity_scroll.visible = false')
    expect(consoleSource).toMatch(/render_tracker\(left, board, player\); debug_ui\.render_ai_reply\(dynamic,[\s\S]*render_prompt\(left, player\); console_ui\.render_action_row\(left,/)
    expect(consoleSource).not.toContain("create_section(parent, 'Controls'")
    expect(consoleSource).toContain("console_ui.render_console_titlebar(root, 'SGLuna NPC Console', console_window_buttons(player))")
    // A blocked plan is a full-width banner above everything else.
    expect(consoleSource).toMatch(/render_blocked\(parent, player, board\); render_status_panel\(parent,/)
    const prompt = consoleSource.split('function render_prompt(')[1]?.split('function render_titlebar(')[0] ?? ''
    expect(prompt).toContain("caption: 'Prompt SGLuna'")
    expect(prompt).not.toContain('NEW_TASK_BUTTON_NAME')
  })

  it('keeps the Roadmap Shelf in the left third and executable Plan Tracker slice in the right two thirds', () => {
    expect(consoleSource).toContain("caption: 'Roadmap Shelf'")
    expect(consoleSource).toContain('tracker_shelf_width: 200')
    expect(consoleSource).toContain('tracker_plan_width: LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING - 12 - 200')
    expect(consoleSource).toContain("name: TRACKER.workspace, direction: 'horizontal'")
    expect(consoleSource).toContain("name: TRACKER.shelf, direction: 'vertical'")
    expect(consoleSource).toContain("name: TRACKER.plan_column, direction: 'vertical'")
    expect(consoleSource).toContain('refresh_shelf(shelf, shelf_nodes, tracker_heights.steps)')
  })

  it('keeps Plan Tracker execution after retiring the Project Board renderer', () => {
    expect(consoleSource).not.toContain("create_section(parent, 'Project Board'")
    expect(consoleSource).not.toContain('render_project_board(parent, board)')
    expect(consoleSource).toContain("create_section(parent, 'Plan Tracker'")
    expect(consoleSource).toMatch(/build_left_dynamic\(dynamic,[\s\S]*render_tracker\(left, board, player\)/)
  })

  it('promotes current step and last meaningful result into Status', () => {
    expect(consoleSource).toContain("add_key_value(table, 'STEP'")
    expect(consoleSource).toContain("add_key_value(table, 'LAST'")
  })

  it('gives conversation more room, moves execution activity to Debug, and makes Projects taller', () => {
    expect(debugSource).toContain('const CONVERSATION_HEIGHT = 300')
    expect(debugSource).toContain("caption: 'Execution Activity'")
    expect(projectsSource).toContain('const PROJECTS_HEIGHT = 780')
    expect(projectsSource).toContain("caption: 'Task Conversation'")
    expect(projectsSource).toContain('step_scroll.style.maximal_height = 260')
  })
})
