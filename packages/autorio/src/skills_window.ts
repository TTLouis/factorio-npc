import type { DropDownGuiElement, FrameGuiElement, LuaGuiElement, LuaPlayer, TextBoxGuiElement, TextFieldGuiElement } from 'factorio:runtime'
import type { SkillDefinition, SkillStatus } from './skills'

import * as gui_text from './task_board_gui_text'
import * as ui_constants from './task_board_ui_constants'
import * as learning from './learning_pipeline'
import * as skills from './skills'

// The skills window works like Old tasks: a list on the left, the selected
// skill's detail on the right. Each part is rebuilt only when its own data
// changes, so a refresh never interrupts a drag, a click or typing in the
// edit fields. Nothing here writes game state while drawing: selection and edit
// state change only in GUI event handlers, which run the same on every peer.

export const SKILLS_WINDOW = {
  root: ui_constants.SKILLS_ROOT_NAME,
  body: ui_constants.SKILLS_BODY_NAME,
  close: ui_constants.SKILLS_CLOSE_BUTTON_NAME,
  learning: 'airi_skills_learning',
  columns: 'airi_skills_columns',
  list_frame: 'airi_skills_list_frame',
  list_count: 'airi_skills_list_count',
  list: 'airi_skills_list',
  detail_frame: 'airi_skills_detail_frame',
  detail_header: 'airi_skills_detail_header',
  detail_title: 'airi_skills_detail_title',
  detail_scroll: 'airi_skills_detail_scroll',
  detail_flow: 'airi_skills_detail_flow',
  edit: 'airi_skills_edit',
  export: 'airi_skills_export',
  edit_name: 'airi_skills_edit_name',
  edit_summary: 'airi_skills_edit_summary',
  edit_status: 'airi_skills_edit_status',
  save: 'airi_skills_save',
  cancel: 'airi_skills_cancel',
  edit_error: 'airi_skills_edit_error',
  title: ui_constants.SKILLS_POPOUT_TITLE,
  list_width: 260,
  detail_width: 560,
  height: 440,
  // A player may set these; `verified` only comes from the runtime verifier.
  edit_statuses: ['observed', 'candidate', 'deprecated'] as SkillStatus[],
}

interface SkillsWindowState { selected: Record<number, string>, editing: Record<number, string>, errors: Record<number, string> }
declare const storage: { airi_skills_window?: SkillsWindowState }

function window_state(): SkillsWindowState | undefined { return storage.airi_skills_window }
function ensure_window_state() {
  if (storage.airi_skills_window === undefined) storage.airi_skills_window = { selected: {}, editing: {}, errors: {} }
  return storage.airi_skills_window
}

/** The selected skill id, falling back to the first skill. Read-only. */
export function selected_skill_id(player_index: number, list: SkillDefinition[] = skills.list_skill_definitions()) {
  const stored = window_state()?.selected[player_index]
  if (stored !== undefined && list.some(skill => skill.id === stored)) return stored
  return list.length > 0 ? list[0].id : ''
}
export function editing_skill_id(player_index: number) { return window_state()?.editing[player_index] ?? '' }
function edit_error(player_index: number) { return window_state()?.errors[player_index] ?? '' }

function skill_list_caption(skill: SkillDefinition) { return `${skill.name} · ${skill.status} r${skill.revision}` }

function flow_text(flows: SkillDefinition['inputs']) {
  return flows.map(flow => `${flow.item}${flow.amount !== undefined ? ` x${flow.amount}` : ''}${flow.role !== undefined ? ` (${flow.role})` : ''}`).join(', ')
}

/** Detail rows, in reading order. Every field the LLM reads through getSkillDetails is shown. */
export function skill_detail_rows(skill: SkillDefinition): Array<[string, string]> {
  const summary = skills.skill_ui_summary(skill)
  const rows: Array<[string, string]> = [
    ['ID', skill.id],
    ['KIND', `${skill.kind} · stage ${skill.stage} · ${skill.status} · revision ${skill.revision}`],
    ['SOURCE', `${skill.source.kind}${skill.source.evidence_refs.length > 0 ? ` · ${skill.source.evidence_refs.join(', ')}` : ''}`],
    ['SUMMARY', skill.summary],
    ['INPUTS', flow_text(skill.inputs)],
    ['OUTPUTS', flow_text(skill.outputs)],
    ['NEEDS', skill.preconditions.map(value => `${value.kind} ${value.subject}: ${value.description}`).join('\n')],
    ['MACHINES', skill.topology.nodes.map(node => `${node.id}: ${node.role}${node.entity_name !== undefined ? ` (${node.entity_name}${node.recipe !== undefined ? `, ${node.recipe}` : ''})` : ''}`).join('\n')],
    ['LINKS', skill.topology.relations.map(relation => `${relation.kind}${relation.from !== undefined || relation.to !== undefined ? ` ${relation.from ?? '?'} → ${relation.to ?? '?'}` : ''}${relation.description !== undefined ? ` — ${relation.description}` : ''}`).join('\n')],
    ['RULES', skill.constraints.map(constraint => `${constraint.kind}: ${constraint.description} [${constraint.validation}]`).join('\n')],
    ['PARAMS', skill.parameters.map(parameter => `${parameter.name}${parameter.required ? '' : ' (optional)'}: ${parameter.description}`).join('\n')],
    ['CHECKED', summary.verification],
    ['FAILS', skill.known_failure_modes.join('\n')],
    ['CONFIDENCE', `${skill.confidence.level}${skill.confidence.basis.length > 0 ? ` · ${skill.confidence.basis.join(' ')}` : ''}`],
    ['EXAMPLES', skill.examples.map(example => `${example.summary}${example.notes !== undefined ? ` — ${example.notes}` : ''}`).join('\n')],
  ]
  return rows.filter(([, value]) => value.length > 0)
}

/**
 * The player's edit as a new revision. Editing a verified skill makes it a
 * candidate again: only the runtime verifier may mark a skill verified.
 */
export function edited_skill_revision(skill: SkillDefinition, edit: { name: string, summary: string, status: SkillStatus }, editor: string, tick: number) {
  if (edit.status === 'verified') throw new Error('only the runtime verifier can mark a skill verified')
  const stage = skill.stage === 'verified_skill' && edit.status !== 'deprecated' ? (edit.status === 'observed' ? 'example' : 'executable_candidate') : skill.stage
  return skills.put_untrusted_skill_definition({
    ...skill,
    revision: skill.revision + 1,
    name: edit.name,
    summary: edit.summary,
    status: edit.status,
    stage,
    source: { ...skill.source, evidence_refs: [...skill.source.evidence_refs, `player-edit:${editor}@${tick}`] },
  })
}

function render_titlebar(root: FrameGuiElement) {
  const titlebar = root.add({ type: 'flow', direction: 'horizontal' }); titlebar.style.horizontally_stretchable = true; titlebar.style.horizontal_spacing = 8; titlebar.drag_target = root
  titlebar.add({ type: 'label', caption: SKILLS_WINDOW.title, style: 'frame_title', ignored_by_interaction: true })
  const dragger = titlebar.add({ type: 'empty-widget', style: 'draggable_space_header', ignored_by_interaction: true }); dragger.style.horizontally_stretchable = true; dragger.style.height = 24
  titlebar.add({ type: 'sprite-button', name: SKILLS_WINDOW.close, sprite: 'utility/close', style: 'frame_action_button', tooltip: `Close ${SKILLS_WINDOW.title}` })
}

function learning_signature() { return `${learning.learning_status_signature()}|${skills.factory_learning_signature()}` }

/** Learning status, LEARN AREA and the latest area analysis. Rebuilt only when that data changes. */
function refresh_learning(section: LuaGuiElement) {
  const signature = learning_signature()
  if (section.tags.signature === signature) return
  section.clear()
  learning.render_learning_status(section)
  const actions = section.add({ type: 'flow', direction: 'horizontal' }); actions.style.horizontally_stretchable = true
  skills.render_learn_area_button(actions)
  skills.render_factory_learning(section)
  section.tags = { signature }
}

function refresh_list(frame: LuaGuiElement, list: SkillDefinition[], selected_id: string) {
  const count = frame[SKILLS_WINDOW.list_count]
  const box = frame[SKILLS_WINDOW.list] as any
  if (!count?.valid || !box?.valid) return false
  const caption = `${list.length}`
  if (count.caption !== caption) count.caption = caption
  const items = list.map(skill_list_caption)
  const ids = list.map(skill => skill.id)
  const signature = ids.map((id, index) => `${id}=${items[index]}`).join('|')
  if (box.tags.signature !== signature) { box.items = items; box.tags = { signature, ids } }
  let selected_index = 0
  for (let index = 0; index < ids.length; index++) if (ids[index] === selected_id) selected_index = index + 1
  if (box.selected_index !== selected_index) box.selected_index = selected_index
  return true
}

function add_detail_row(parent: LuaGuiElement, key: string, value: string) {
  const row = parent.add({ type: 'flow', direction: 'horizontal' }); row.style.horizontal_spacing = 8
  const label = row.add({ type: 'label', caption: key, style: 'semibold_label' }); label.style.minimal_width = 88
  const content = gui_text.literal_gui_text(row.add({ type: 'label', caption: value })); content.style.single_line = false; content.style.maximal_width = SKILLS_WINDOW.detail_width - 130
}

function render_edit_form(parent: LuaGuiElement, skill: SkillDefinition, error: string) {
  parent.add({ type: 'label', caption: 'NAME', style: 'semibold_label' })
  const name = parent.add({ type: 'textfield', name: SKILLS_WINDOW.edit_name, text: skill.name }); name.style.width = SKILLS_WINDOW.detail_width - 40
  parent.add({ type: 'label', caption: 'SUMMARY', style: 'semibold_label' })
  const summary = parent.add({ type: 'text-box', name: SKILLS_WINDOW.edit_summary, text: skill.summary }); summary.style.width = SKILLS_WINDOW.detail_width - 40; summary.style.height = 140; (summary as TextBoxGuiElement).word_wrap = true
  parent.add({ type: 'label', caption: 'STATUS', style: 'semibold_label' })
  const current = SKILLS_WINDOW.edit_statuses.indexOf(skill.status)
  parent.add({ type: 'drop-down', name: SKILLS_WINDOW.edit_status, items: SKILLS_WINDOW.edit_statuses, selected_index: current >= 0 ? current + 1 : 2 })
  if (skill.status === 'verified') {
    const note = parent.add({ type: 'label', caption: 'Saving a verified skill makes it a candidate again. The runtime verifier must check it before it counts as verified.', style: 'grey_label' }); note.style.single_line = false; note.style.maximal_width = SKILLS_WINDOW.detail_width - 40
  }
  const buttons = parent.add({ type: 'flow', direction: 'horizontal' }); buttons.style.horizontal_spacing = 8
  buttons.add({ type: 'button', name: SKILLS_WINDOW.save, caption: 'SAVE', style: 'confirm_button', tooltip: 'Save as a new revision of this skill.' })
  buttons.add({ type: 'button', name: SKILLS_WINDOW.cancel, caption: 'CANCEL', style: 'back_button' })
  // Always present, so a refused save only changes this caption and the
  // player's typed text stays where it is.
  const label = gui_text.literal_gui_text(parent.add({ type: 'label', name: SKILLS_WINDOW.edit_error, caption: error })); label.style.font_color = { r: 1, g: 0.4, b: 0.4 }; label.style.single_line = false; label.style.maximal_width = SKILLS_WINDOW.detail_width - 40
}

/** The detail pane is rebuilt only when the skill, its revision or the edit mode changes. */
function refresh_detail(frame: LuaGuiElement, skill: SkillDefinition | undefined, editing: boolean, error: string) {
  const header = frame[SKILLS_WINDOW.detail_header]
  const scroll = frame[SKILLS_WINDOW.detail_scroll]
  const flow = scroll?.valid ? scroll[SKILLS_WINDOW.detail_flow] : undefined
  const title = header?.valid ? header[SKILLS_WINDOW.detail_title] : undefined
  const edit = header?.valid ? header[SKILLS_WINDOW.edit] : undefined
  const export_button = header?.valid ? header[SKILLS_WINDOW.export] : undefined
  if (!flow?.valid || !title?.valid || !edit?.valid || !export_button?.valid) return false
  const caption = skill?.name ?? 'Skill Detail'
  if (title.caption !== caption) title.caption = caption
  const enabled = skill !== undefined && !editing
  if (edit.enabled !== enabled) edit.enabled = enabled
  if (export_button.enabled !== enabled) export_button.enabled = enabled
  const signature = skill === undefined ? '' : `${skill.id}#${skill.revision}#${editing ? 'edit' : 'view'}`
  if (flow.tags.signature === signature) {
    const error_label = editing ? flow[SKILLS_WINDOW.edit_error] : undefined
    if (error_label?.valid && error_label.caption !== error) error_label.caption = error
    return true
  }
  flow.clear()
  if (skill === undefined) flow.add({ type: 'label', caption: 'No skills yet. Use LEARN AREA, or let SGLuna learn from finished goals.' })
  else if (editing) render_edit_form(flow, skill, error)
  else for (const [key, value] of skill_detail_rows(skill)) add_detail_row(flow, key, value)
  flow.tags = { signature }
  return true
}

function build_columns(body: LuaGuiElement) {
  const columns = body.add({ type: 'flow', name: SKILLS_WINDOW.columns, direction: 'horizontal' }); columns.style.horizontal_spacing = 12; columns.style.vertical_align = 'top'
  const list_frame = columns.add({ type: 'frame', name: SKILLS_WINDOW.list_frame, direction: 'vertical', style: 'inside_shallow_frame' }); list_frame.style.width = SKILLS_WINDOW.list_width; list_frame.style.height = SKILLS_WINDOW.height
  const list_header = list_frame.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' }); list_header.style.horizontally_stretchable = true
  list_header.add({ type: 'label', caption: 'SKILLS', style: 'subheader_caption_label' })
  const list_spacer = list_header.add({ type: 'empty-widget' }); list_spacer.style.horizontally_stretchable = true
  list_frame.add({ type: 'label', name: SKILLS_WINDOW.list_count, caption: '', style: 'grey_label' })
  const box = list_frame.add({ type: 'list-box', name: SKILLS_WINDOW.list, items: [], tags: { signature: '', ids: [] } }); box.style.horizontally_stretchable = true; box.style.vertically_stretchable = true; box.style.maximal_height = SKILLS_WINDOW.height - 60
  const detail_frame = columns.add({ type: 'frame', name: SKILLS_WINDOW.detail_frame, direction: 'vertical', style: 'inside_shallow_frame' }); detail_frame.style.width = SKILLS_WINDOW.detail_width; detail_frame.style.height = SKILLS_WINDOW.height
  const header = detail_frame.add({ type: 'frame', name: SKILLS_WINDOW.detail_header, direction: 'horizontal', style: 'subheader_frame' }); header.style.horizontally_stretchable = true; header.style.vertical_align = 'center'
  header.add({ type: 'label', name: SKILLS_WINDOW.detail_title, caption: 'Skill Detail', style: 'subheader_caption_label' })
  const spacer = header.add({ type: 'empty-widget' }); spacer.style.horizontally_stretchable = true
  header.add({ type: 'button', name: SKILLS_WINDOW.edit, caption: 'EDIT', tooltip: 'Edit the name, summary or status. Saving makes a new revision.' })
  header.add({ type: 'button', name: SKILLS_WINDOW.export, caption: 'EXPORT', style: 'confirm_button', tooltip: 'Export skill.json and SKILL.md under script-output/sgluna-skills.' })
  const scroll = detail_frame.add({ type: 'scroll-pane', name: SKILLS_WINDOW.detail_scroll, horizontal_scroll_policy: 'never' }); scroll.style.horizontally_stretchable = true; scroll.style.vertically_stretchable = true; scroll.style.padding = 8
  const flow = scroll.add({ type: 'flow', name: SKILLS_WINDOW.detail_flow, direction: 'vertical', tags: { signature: '-' } }); flow.style.vertical_spacing = 6
}

function destroy_window(player: LuaPlayer) {
  const existing = player.gui.screen[SKILLS_WINDOW.root]
  const location = existing?.valid ? existing.location : undefined
  if (existing?.valid) existing.destroy()
  return location
}

function window_parts(player: LuaPlayer) {
  const root = player.gui.screen[SKILLS_WINDOW.root]
  const body = root?.valid ? root[SKILLS_WINDOW.body] : undefined
  const learning_section = body?.valid ? body[SKILLS_WINDOW.learning] : undefined
  const columns = body?.valid ? body[SKILLS_WINDOW.columns] : undefined
  const list_frame = columns?.valid ? columns[SKILLS_WINDOW.list_frame] : undefined
  const detail_frame = columns?.valid ? columns[SKILLS_WINDOW.detail_frame] : undefined
  if (!learning_section?.valid || !list_frame?.valid || !detail_frame?.valid) return undefined
  return { learning_section, list_frame, detail_frame }
}

function build_window(player: LuaPlayer) {
  const previous_location = destroy_window(player)
  const root = player.gui.screen.add({ type: 'frame', name: SKILLS_WINDOW.root, direction: 'vertical' }) as FrameGuiElement
  if (previous_location !== undefined) root.location = previous_location
  else root.auto_center = true
  render_titlebar(root)
  const body = root.add({ type: 'flow', name: SKILLS_WINDOW.body, direction: 'vertical' }); body.style.vertical_spacing = 8
  const learning_section = body.add({ type: 'flow', name: SKILLS_WINDOW.learning, direction: 'vertical', tags: { signature: '' } }); learning_section.style.horizontally_stretchable = true; learning_section.style.vertical_spacing = 6
  build_columns(body)
  root.bring_to_front()
}

/** Open, refresh or close the window. A refresh with nothing new changes nothing on screen. */
export function render_skills_window(player: LuaPlayer, open: boolean) {
  if (!open) { destroy_window(player); return }
  let parts = window_parts(player)
  if (parts === undefined) { build_window(player); parts = window_parts(player) }
  if (parts === undefined) return
  refresh_learning(parts.learning_section)
  const list = skills.list_skill_definitions()
  const selected_id = selected_skill_id(player.index, list)
  refresh_list(parts.list_frame, list, selected_id)
  const skill = list.find(value => value.id === selected_id)
  refresh_detail(parts.detail_frame, skill, skill !== undefined && editing_skill_id(player.index) === skill.id, edit_error(player.index))
}

export function close_skills_window(player: LuaPlayer) { destroy_window(player) }

function find_descendant(element: LuaGuiElement | undefined, name: string): LuaGuiElement | undefined {
  if (element === undefined || !element.valid) return undefined
  if (element.name === name) return element
  for (const child of element.children) {
    const hit = find_descendant(child, name)
    if (hit !== undefined) return hit
  }
  return undefined
}

function save_edit(player: LuaPlayer) {
  const state = ensure_window_state()
  const id = state.editing[player.index]
  const skill = id !== undefined ? skills.get_skill_definition(id) : undefined
  if (skill === undefined) { delete state.editing[player.index]; delete state.errors[player.index]; return }
  const root = player.gui.screen[SKILLS_WINDOW.root]
  const name = find_descendant(root, SKILLS_WINDOW.edit_name) as TextFieldGuiElement | undefined
  const summary = find_descendant(root, SKILLS_WINDOW.edit_summary) as TextBoxGuiElement | undefined
  const status = find_descendant(root, SKILLS_WINDOW.edit_status) as DropDownGuiElement | undefined
  if (name === undefined || summary === undefined || status === undefined) return
  const chosen = SKILLS_WINDOW.edit_statuses[status.selected_index - 1] ?? 'candidate'
  try {
    const saved = edited_skill_revision(skill, { name: name.text, summary: summary.text, status: chosen }, player.name, game.tick)
    delete state.editing[player.index]; delete state.errors[player.index]
    player.print(`[SGLuna] Saved skill ${saved.id} revision ${saved.revision}.`)
  }
  catch (error) {
    // Keep the form open with the player's text; show why it was refused.
    state.errors[player.index] = `Not saved: ${error instanceof Error ? error.message : 'invalid skill'}`
  }
}

/** Handle a click inside the skills window. Returns true when it was one. */
export function handle_skills_window_click(player: LuaPlayer, element_name: string) {
  const names = SKILLS_WINDOW
  if (element_name === names.edit) {
    const id = selected_skill_id(player.index)
    if (id.length > 0) { const state = ensure_window_state(); state.editing[player.index] = id; delete state.errors[player.index] }
  }
  else if (element_name === names.cancel) { const state = ensure_window_state(); delete state.editing[player.index]; delete state.errors[player.index] }
  else if (element_name === names.save) save_edit(player)
  else if (element_name === names.export) {
    const id = selected_skill_id(player.index)
    if (id.length > 0) skills.handle_skill_export_click(player, skills.skill_export_button_name(id))
  }
  else return false
  render_skills_window(player, true)
  return true
}

/** Handle a list-box selection. Returns true when it was the skills list. */
export function handle_skills_window_selection(player: LuaPlayer, element: LuaGuiElement) {
  if (element.name !== SKILLS_WINDOW.list) return false
  const ids = element.tags.ids as string[] | undefined
  const index = (element as any).selected_index - 1
  if (ids === undefined || index < 0 || index >= ids.length) return true
  const state = ensure_window_state()
  state.selected[player.index] = ids[index]
  // Moving to another skill leaves an unsaved edit behind.
  delete state.editing[player.index]; delete state.errors[player.index]
  render_skills_window(player, true)
  return true
}
