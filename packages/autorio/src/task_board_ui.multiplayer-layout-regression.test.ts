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


describe('task board multiplayer layout regression', () => {
  it('keeps synchronized GUI sizing independent from client display settings', () => {
    const source = taskBoardUiSource()
    const runtimeHeight = source.split('function player_gui_height(')[1]?.split('\n}\n\nfunction preview_position_caption')[0] ?? ''

    expect(source).toContain('synced_gui_height: 1080,')
    expect(runtimeHeight).toContain('return CONSOLE_LAYOUT.synced_gui_height')
    expect(runtimeHeight).not.toContain('display_resolution')
    expect(runtimeHeight).not.toContain('display_scale')
    expect(source).not.toContain('player.display_resolution')
    expect(source).not.toContain('player.display_scale')
  })

  it('accepts console button and field events only from the event player while the console is open', () => {
    const source = taskBoardUiSource()
    const click = source.split('script.on_event(defines.events.on_gui_click,')[1]?.split('script.on_event(defines.events.on_gui_text_changed,')[0] ?? ''
    expect(click).toContain('element.player_index !== event.player_index')
    expect(click).toContain('if (!task_board_ui_is_open(player.index)) return')
    const text = source.split('script.on_event(defines.events.on_gui_text_changed,')[1] ?? ''
    expect(text).toContain('element.player_index !== event.player_index')
    expect(text).toContain('!task_board_ui_is_open(event.player_index)')
    expect(source).not.toContain('player.display_resolution')
    expect(source).not.toContain('player.display_scale')
  })
})
