import type { LuaGuiElement } from 'factorio:runtime'

/**
 * Marks external/player/model/runtime text as literal GUI text.
 *
 * Factorio owns the parser: labels and text boxes expose rich_text_setting, so
 * use that supported boundary instead of rewriting brackets or trying to parse
 * rich text ourselves.
 */
export function literal_gui_text(element: LuaGuiElement) {
  element.style.rich_text_setting = defines.rich_text_setting.disabled
  return element
}

/**
 * Documents the opposite trust boundary for markup authored by this mod.
 * Callers must not pass player/model/runtime text through this helper.
 */
export function trusted_rich_text(value: string) { return value }
