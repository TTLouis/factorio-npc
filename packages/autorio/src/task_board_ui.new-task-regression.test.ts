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


describe('task board New Task control regression', () => {
  it('renders New Task in the Prompt SGLuna heading and queues the server-authoritative action', () => {
    const source = taskBoardUiSource()
    const controls = source.split('function render_controls_panel(')[1]?.split('export function task_board_gui_height(')[0] ?? ''
    const prompt = source.split('function render_prompt(')[1]?.split('function render_titlebar(')[0] ?? ''
    const handler = source.split('function handle_control_click(')[1]?.split('\n}\n\nexport function create_task_board_ui_remote_interface')[0] ?? ''

    expect(source).toContain("const NEW_TASK_BUTTON_NAME = 'airi_task_board_new_task'")
    expect(source).toContain("type TaskBoardUiControlAction = 'pause' | 'terminate' | 'follow' | 'stop_follow' | 'new_task'")
    expect(controls).not.toContain("name: NEW_TASK_BUTTON_NAME, caption: 'NEW TASK'")
    expect(prompt).toContain("caption: 'Prompt SGLuna'")
    expect(prompt).toContain("name: NEW_TASK_BUTTON_NAME, caption: 'NEW TASK'")
    expect(prompt).toContain('header_spacer.style.horizontally_stretchable = true')
    expect(prompt).not.toContain('header.style.horizontal_spacing')
    expect(prompt).toContain('const pending = LIFECYCLE.current(player.index)')
    expect(prompt).toContain('new_task.enabled = pending === undefined')
    expect(handler).toContain('if (element_name === NEW_TASK_BUTTON_NAME)')
    expect(handler).toMatch(/NEW_TASK_BUTTON_NAME\)[^\n]*LIFECYCLE\.current\(player\.index\) !== undefined[^\n]*return true[^\n]*clear_terminate_confirmation\(player\.index\)[^\n]*debug_ui\.suppress_snapshot\(storage\.airi_task_board_ui\)[^\n]*debug_ui\.reset_task_conversation\(\)[^\n]*emit_control\(player, 'new_task'\)/)
    expect(handler).toContain("if (element_name === TERMINATE_BUTTON_NAME)")
    expect(handler).toMatch(/LIFECYCLE\.begin\(player\.index, 'terminate'\)[\s\S]*debug_ui\.suppress_snapshot\(storage\.airi_task_board_ui\)[\s\S]*debug_ui\.reset_task_conversation\(\)[\s\S]*emit_control\(player, 'terminate'\)/)
  })

  it('refreshes Current Task Conversation while the console stays open', () => {
    const source = taskBoardUiSource()
    const refresh = source.split('function refresh_columns(')[1]?.split('function build_panel(')[0] ?? ''

    expect(refresh).toContain('dynamic.clear(); build_left_dynamic(dynamic, player, board, synced_tick, runtime)')
    expect(refresh).toContain("debug_ui.render_ai_reply(dynamic, board?.response ?? '', LEFT_COLUMN_WIDTH)")
    expect(refresh.indexOf('debug_ui.render_ai_reply')).toBeGreaterThan(refresh.indexOf('build_left_dynamic'))
  })
})
