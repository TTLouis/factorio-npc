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
    expect(consoleSource).toContain("create_section(parent, 'Activity'")
    // NOW holds the cards and the conversation, PLAN the tracker, ACTIVITY the
    // feed; the prompt and the action row stay under the tabs.
    expect(consoleSource).toMatch(/debug_ui\.render_ai_reply\(dynamic,[\s\S]*render_tracker\(pages\.plan, board\); render_activity_section\(pages\.activity, board, player\)[\s\S]*render_prompt\(left, player\)[\s\S]*console_ui\.render_action_row\(left,/)
    expect(consoleSource).not.toContain("create_section(parent, 'Controls'")
    expect(consoleSource).toContain("console_ui.render_console_titlebar(root, 'SGLuna NPC Console', console_window_buttons(player), console_title_status(")
    // A blocked plan is a full-width banner above the tabs, so it is seen
    // whichever tab is open; the Goal and Now cards open the NOW tab.
    expect(consoleSource).toMatch(/name: CONSOLE_TABS\.banner[\s\S]*console_ui\.render_console_tabs\(left,/)
    // Each card lives in its own slot and redraws only when its content changes.
    expect(consoleSource).toMatch(/refresh_slot\(banner,[^\n]*render_blocked\(slot, player, board\)\)\n[^\n]*NOW_GOAL_SLOT_NAME\), goal_signature, slot => console_ui\.render_goal_card\(slot, goal\)\)\n[^\n]*NOW_CARD_SLOT_NAME\),[^\n]*console_ui\.render_now_card\(slot, now_card\)\)\n[^\n]*refresh_slot\(plan, goal_signature, slot => console_ui\.render_goal_card\(slot, goal\)\)/)
    const prompt = consoleSource.split('function render_prompt(')[1]?.split('function selected_console_tab(')[0] ?? ''
    expect(prompt).toContain("caption: 'Prompt SGLuna'")
    expect(prompt).not.toContain('NEW_TASK_BUTTON_NAME')
  })

  it('renders one full-width Roadmap tree with the active plan nested under its node, not two side-by-side lists', () => {
    expect(consoleSource).toContain("caption: 'Roadmap'")
    expect(consoleSource).toContain('tracker_tree_width: LEFT_COLUMN_WIDTH - 2 * SECTION_PADDING')
    expect(consoleSource).toContain("name: TRACKER.tree, direction: 'vertical'")
    expect(consoleSource).toContain("name: TRACKER.tree_rows, direction: 'vertical'")
    expect(consoleSource).toContain('refresh_tree(tree_body, nodes, board)')
    // The old competing panels, their widths and their refreshers are gone.
    for (const retired of ["caption: 'Roadmap Shelf'", "caption: 'Active Plan'", 'tracker_shelf_width', 'tracker_plan_width', 'tracker_column_gap', 'TRACKER.workspace', 'TRACKER.shelf', 'TRACKER.plan_column', 'refresh_shelf(', 'refresh_steps(']) expect(consoleSource, retired).not.toContain(retired)
    expect(consoleSource).toContain("Roadmap nodes; the active plan's steps sit under the node they build.")
  })

  it('keeps Plan Tracker execution after retiring the Project Board renderer', () => {
    expect(consoleSource).not.toContain("create_section(parent, 'Project Board'")
    expect(consoleSource).not.toContain('render_project_board(parent, board)')
    expect(consoleSource).toContain("create_section(parent, 'Plan Tracker'")
    expect(consoleSource).toMatch(/build_left_dynamic\(banner, dynamic, plan_dynamic,[\s\S]*render_tracker\(pages\.plan, board\)/)
  })

  it('shows the goal checks, the current step, what comes next and the last result on the Goal and Now cards', () => {
    expect(consoleSource).not.toContain("create_section(parent, 'Status'")
    expect(consoleSource).toContain('checks met')
    expect(consoleSource).toContain('heading: `Now · step ${index + 1} of ${board.total_steps} · ${board.completed_count} verified`')
    expect(consoleSource).toContain("`Next: ${upcoming.join(' · ')}")
    expect(consoleSource).toContain('`Last: ${text(last.caption, 140)}`')
  })

  it('gives conversation more room, moves execution activity to Debug, and makes Projects taller', () => {
    expect(debugSource).toContain('const CONVERSATION_HEIGHT = 300')
    expect(debugSource).toContain("caption: 'Execution Activity'")
    expect(projectsSource).toContain('const PROJECTS_HEIGHT = 780')
    expect(projectsSource).toContain("caption: 'Task Conversation'")
    expect(projectsSource).toContain('step_scroll.style.maximal_height = 260')
  })
})
