import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function taskBoardUiSource() {
  const main = readFileSync(new URL('./task_board_ui.ts', import.meta.url), 'utf8')
  const constants = readFileSync(new URL('./task_board_ui_constants.ts', import.meta.url), 'utf8')
  // UI constants moved into a namespace to preserve Factorio Lua local headroom.
  // Normalize that namespace for source-architecture assertions while retaining
  // the constants module so declaration/geometry checks still test real code.
  return `${main.replaceAll('ui_constants.', '')}\n${constants}`.replace(/\r\n/g, '\n')
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

  it('keeps operational controls in the top row and puts New Task with Prompt SGLuna', () => {
    expect(consoleSource).toContain("create_section(parent, 'Plan Tracker'")
    expect(consoleSource).toContain('activity_header.visible = false')
    expect(consoleSource).toContain('activity_scroll.visible = false')
    expect(consoleSource).toMatch(/render_tracker\(left, board, player\); debug_ui\.render_ai_reply\(dynamic,[\s\S]*render_prompt\(left, player\)/)
    expect(consoleSource).toContain("create_section(parent, 'Controls', CONTROLS_SECTION_WIDTH")
    const controls = consoleSource.split('function render_controls_panel(')[1]?.split('export function task_board_gui_height(')[0] ?? ''
    const prompt = consoleSource.split('function render_prompt(')[1]?.split('function render_titlebar(')[0] ?? ''
    expect(controls).not.toContain('NEW_TASK_BUTTON_NAME')
    expect(prompt).toContain("caption: 'Prompt SGLuna'")
    expect(prompt).toContain('NEW_TASK_BUTTON_NAME')
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
