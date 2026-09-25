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


describe('task board New Task control regression', () => {
  it('renders New Task behind … beside Terminate and queues the server-authoritative action', () => {
    const source = taskBoardUiSource()
    const prompt = source.split('function render_prompt(')[1]?.split('function selected_console_tab(')[0] ?? ''
    const menu = source.split('export function render_action_row(')[1] ?? ''
    const handler = source.split('function handle_control_click(')[1]?.split('\n}\n\nexport function create_task_board_ui_remote_interface')[0] ?? ''

    expect(source).toContain("const NEW_TASK_BUTTON_NAME = 'airi_task_board_new_task'")
    expect(source).toContain("type TaskBoardUiControlAction = 'pause' | 'terminate' | 'follow' | 'stop_follow' | 'new_task'")
    expect(prompt).toContain("caption: 'Prompt SGLuna'")
    expect(prompt).not.toContain('NEW_TASK_BUTTON_NAME')
    expect(menu).toContain("name: NEW_TASK_BUTTON_NAME, caption: 'NEW TASK'")
    expect(menu).toContain("'Clears the goal and conversation. Skills and the world stay.'")
    expect(menu).toContain('new_task.enabled = state.new_task_enabled')
    expect(source).toContain('new_task_enabled: pending === undefined')
    expect(handler).toContain('if (element_name === NEW_TASK_BUTTON_NAME)')
    expect(handler).toMatch(/NEW_TASK_BUTTON_NAME\)[^\n]*LIFECYCLE\.current\(player\.index\) !== undefined[^\n]*return true[^\n]*clear_terminate_confirmation\(player\.index\)[^\n]*debug_ui\.suppress_snapshot\(storage\.airi_task_board_ui\)[^\n]*debug_ui\.reset_task_conversation\(\)[^\n]*activity_state\.clear_activity_history\(\)[^\n]*emit_control\(player, 'new_task'\)/)
    expect(handler).toContain("if (element_name === TERMINATE_BUTTON_NAME)")
    expect(handler).toMatch(/LIFECYCLE\.begin\(player\.index, 'terminate'\)[\s\S]*debug_ui\.suppress_snapshot\(storage\.airi_task_board_ui\)[\s\S]*debug_ui\.reset_task_conversation\(\)[\s\S]*activity_state\.clear_activity_history\(\)[\s\S]*emit_control\(player, 'terminate'\)/)
  })

  it('refreshes Current Task Conversation while the console stays open', () => {
    const source = taskBoardUiSource()
    const refresh = source.split('function refresh_columns(')[1]?.split('function build_panel(')[0] ?? ''

    // Each card redraws only when its own content changes (refresh_slot).
    expect(refresh).toContain('build_left_dynamic(banner, dynamic, plan_dynamic, player, board)')
    expect(refresh).toContain("debug_ui.render_ai_reply(dynamic, board?.response ?? '', LEFT_COLUMN_WIDTH)")
    expect(refresh.indexOf('debug_ui.render_ai_reply')).toBeGreaterThan(refresh.indexOf('build_left_dynamic'))
  })
})
