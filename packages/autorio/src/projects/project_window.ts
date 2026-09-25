import type { ButtonGuiElement, FrameGuiElement, LuaGuiElement, LuaPlayer, ScrollPaneGuiElement } from 'factorio:runtime'
import type { TaskBoardUiActivity } from '../task_board_ui'

import * as activity_state from '../task_board_activity'
import * as gui_text from '../task_board_gui_text'

// Projects owns stable, independent button ids. It must never borrow Debug's
// close route: doing so made the old-task entry disappear or toggle unexpectedly
// whenever the main console/debug window was rebuilt.
export const PROJECTS_BUTTON_NAME = 'airi_task_board_projects'
export const PROJECTS_CLOSE_BUTTON_NAME = 'airi_task_board_projects_close'
export const PROJECT_EXPORT_BUTTON_NAME = 'airi_task_board_project_export'
export const PROJECT_LIST_NAME = 'airi_task_board_project_list'

const ROOT_NAME = 'airi_task_board_projects_panel'
const BODY_NAME = 'airi_task_board_projects_body'
const COLUMNS_NAME = 'airi_task_board_projects_columns'
const LIST_FRAME_NAME = 'airi_task_board_projects_list_frame'
const DETAIL_FRAME_NAME = 'airi_task_board_projects_detail_frame'
const DETAIL_BODY_NAME = 'airi_task_board_projects_detail_body'
const DETAIL_META_NAME = 'airi_task_board_projects_detail_meta'
const DETAIL_STEPS_SCROLL_NAME = 'airi_task_board_projects_steps_scroll'
const DETAIL_STEPS_FLOW_NAME = 'airi_task_board_projects_steps_flow'
const DETAIL_CONVERSATION_SCROLL_NAME = 'airi_task_board_projects_conversation_scroll'
const DETAIL_CONVERSATION_FLOW_NAME = 'airi_task_board_projects_conversation_flow'
const DETAIL_ACTIVITY_HEADER_NAME = 'airi_task_board_projects_activity_header'
const DETAIL_ACTIVITY_FILTERS_NAME = 'airi_task_board_projects_activity_filters'
const DETAIL_ACTIVITY_COUNT_NAME = 'airi_task_board_projects_activity_count'
const DETAIL_ACTIVITY_SCROLL_NAME = 'airi_task_board_projects_activity_scroll'
const DETAIL_ACTIVITY_FLOW_NAME = 'airi_task_board_projects_activity_flow'
const PROJECTS_WIDTH = 900
const PROJECTS_HEIGHT = 780
const PROJECT_LIST_WIDTH = 250
const PROJECT_DETAIL_WIDTH = PROJECTS_WIDTH - PROJECT_LIST_WIDTH - 12
const MAX_PROJECTS = 64
const MAX_ACTIVITY = 160
const MAX_ACTIVITY_VISIBLE = 48
const MAX_STEPS = 48
const MAX_TEXT = 2000

export interface ProjectHistoryStep {
  id: string
  description: string
  status: string
}

export interface ProjectHistoryActivity {
  id?: string
  kind: string
  text: string
  timestamp?: string
}

export interface ProjectHistoryConversationMessage {
  id: string
  role: 'user' | 'assistant'
  sender: string
  text: string
}

export interface ProjectHistoryRecord {
  id: string
  name: string
  objective: string
  status: string
  response: string
  blocker: string
  pause_reason: string
  completed_count: number
  total_steps: number
  active_index: number
  steps: ProjectHistoryStep[]
  activity: ProjectHistoryActivity[]
  conversation: ProjectHistoryConversationMessage[]
  created_tick: number
  updated_tick: number
}

export interface ProjectExportPayload {
  schema_version: 1
  kind: 'airi_old_task_export'
  goal: {
    id: string
    name: string
    objective: string
    status: string
    response: string
    blocker: string
    pause_reason: string
    completed_count: number
    total_steps: number
    active_index: number
    created_tick: number
    updated_tick: number
  }
  steps: ProjectHistoryStep[]
  conversation: ProjectHistoryConversationMessage[]
  activity: ProjectHistoryActivity[]
}

export interface ProjectExportResult {
  project_id: string
  relative_path: string
}

declare const storage: {
  airi_task_board_projects?: Record<string, ProjectHistoryRecord>
  airi_task_board_project_order?: string[]
  airi_task_board_projects_open?: Record<number, boolean>
  airi_task_board_project_selected?: Record<number, string>
}

function clean_text(value: unknown, max = MAX_TEXT) {
  let clean = String(value ?? '').split('\r').join(' ').split('\n').join(' ').split('\t').join(' ').trim()
  while (clean.includes('  ')) clean = clean.split('  ').join(' ')
  return clean.length <= max ? clean : `${clean.slice(0, math.max(0, max - 1))}…`
}

function integer(value: unknown) {
  return typeof value === 'number' && value >= 0 && value === math.floor(value) ? value : 0
}

function ensure_records() {
  if (storage.airi_task_board_projects === undefined) storage.airi_task_board_projects = {}
  return storage.airi_task_board_projects
}

function ensure_order() {
  if (storage.airi_task_board_project_order === undefined) storage.airi_task_board_project_order = []
  return storage.airi_task_board_project_order
}

function ensure_open() {
  if (storage.airi_task_board_projects_open === undefined) storage.airi_task_board_projects_open = {}
  return storage.airi_task_board_projects_open
}

function ensure_selected() {
  if (storage.airi_task_board_project_selected === undefined) storage.airi_task_board_project_selected = {}
  return storage.airi_task_board_project_selected
}

function activity_key(entry: ProjectHistoryActivity) {
  if (entry.id !== undefined && entry.id.length > 0) return `id:${entry.id}`
  return `${entry.kind}|${entry.timestamp ?? ''}|${entry.text}`
}

function sanitize_steps(value: any): ProjectHistoryStep[] {
  const raw = Array.isArray(value) ? value as any[] : []
  const steps: ProjectHistoryStep[] = []
  for (let index = 0; index < raw.length && steps.length < MAX_STEPS; index++) {
    const description = clean_text(raw[index]?.description, 800)
    if (description.length === 0) continue
    steps.push({
      id: clean_text(raw[index]?.id || `step_${index + 1}`, 100),
      description,
      status: clean_text(raw[index]?.status, 40),
    })
  }
  return steps
}

function sanitize_conversation(value: any): ProjectHistoryConversationMessage[] {
  const raw = Array.isArray(value) ? value as any[] : []
  const messages: ProjectHistoryConversationMessage[] = []
  for (let index = 0; index < raw.length && messages.length < 96; index++) {
    const role = raw[index]?.role === 'assistant' ? 'assistant' : raw[index]?.role === 'user' ? 'user' : undefined
    const text = clean_text(raw[index]?.text, 2000)
    if (role === undefined || text.length === 0) continue
    messages.push({
      id: clean_text(raw[index]?.id || `message_${index + 1}`, 120),
      role,
      sender: clean_text(raw[index]?.sender || (role === 'assistant' ? 'AIRI' : 'Player'), 128),
      text,
    })
  }
  return messages
}

function merge_activity(previous: ProjectHistoryActivity[], value: any): ProjectHistoryActivity[] {
  const result = previous.slice(0, MAX_ACTIVITY)
  const seen: Record<string, boolean> = {}
  for (const entry of result) seen[activity_key(entry)] = true
  const raw = Array.isArray(value) ? value as any[] : []
  for (const source of raw) {
    const text = clean_text(source?.text, 1200)
    if (text.length === 0) continue
    const entry: ProjectHistoryActivity = { kind: clean_text(source?.kind, 40), text }
    const id = clean_text(source?.id, 120)
    const timestamp = clean_text(source?.timestamp, 20)
    if (id.length > 0) entry.id = id
    if (timestamp.length > 0) entry.timestamp = timestamp
    const key = activity_key(entry)
    if (seen[key]) continue
    result.push(entry)
    seen[key] = true
    while (result.length > MAX_ACTIVITY) result.shift()
  }
  return result
}

function project_name(objective: string, goal_id: string) {
  if (objective.length === 0) return goal_id
  return objective.length <= 56 ? objective : `${objective.slice(0, 55)}…`
}

function same_steps(left: ProjectHistoryStep[], right: ProjectHistoryStep[]) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index].id !== right[index].id || left[index].description !== right[index].description || left[index].status !== right[index].status) return false
  }
  return true
}

function same_activity(left: ProjectHistoryActivity[], right: ProjectHistoryActivity[]) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (activity_key(left[index]) !== activity_key(right[index])) return false
  }
  return true
}

function same_conversation(left: ProjectHistoryConversationMessage[], right: ProjectHistoryConversationMessage[]) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index].id !== right[index].id || left[index].role !== right[index].role || left[index].sender !== right[index].sender || left[index].text !== right[index].text) return false
  }
  return true
}

function same_project_content(previous: ProjectHistoryRecord, next: ProjectHistoryRecord) {
  return previous.name === next.name
    && previous.objective === next.objective
    && previous.status === next.status
    && previous.response === next.response
    && previous.blocker === next.blocker
    && previous.pause_reason === next.pause_reason
    && previous.completed_count === next.completed_count
    && previous.total_steps === next.total_steps
    && previous.active_index === next.active_index
    && same_steps(previous.steps, next.steps)
    && same_activity(previous.activity, next.activity)
    && same_conversation(previous.conversation ?? [], next.conversation ?? [])
}

/**
 * Durable goals are the first useful project boundary we have today. Keeping
 * the archive behind a ProjectHistoryRecord makes the UI useful immediately,
 * while leaving room for a later Project -> Tasks layer without changing the
 * main Task Board or the runtime heartbeat schema.
 *
 * A heartbeat is not a project update. Only semantic changes advance
 * `updated_tick` or move the project to the top of history. This matters most
 * for completed projects: once finished they remain visually stable instead of
 * being rebuilt once per console refresh and stealing the reader's scroll.
 */
export function record_project_snapshot(board: any, tick: number) {
  const goal_id = clean_text(board?.goal_id, 100)
  if (goal_id.length === 0) return false
  const records = ensure_records()
  const order = ensure_order()
  const previous = records[goal_id]
  const objective = clean_text(board?.objective, 1000)
  const record: ProjectHistoryRecord = {
    id: goal_id,
    name: project_name(objective, goal_id),
    objective,
    status: clean_text(board?.status, 40) || 'active',
    response: clean_text(board?.response, MAX_TEXT),
    blocker: clean_text(board?.blocker, 1000),
    pause_reason: clean_text(board?.pause_reason, 500),
    completed_count: integer(board?.completed_count),
    total_steps: integer(board?.total_steps),
    active_index: integer(board?.active_index),
    steps: sanitize_steps(board?.steps),
    activity: merge_activity(previous?.activity ?? [], board?.activity),
    conversation: sanitize_conversation(board?.conversation),
    created_tick: previous?.created_tick ?? tick,
    updated_tick: tick,
  }
  if (previous !== undefined && same_project_content(previous, record)) return false
  records[goal_id] = record

  for (let index = order.length - 1; index >= 0; index--) {
    if (order[index] === goal_id) order.splice(index, 1)
  }
  order.push(goal_id)
  while (order.length > MAX_PROJECTS) {
    const oldest = order.shift()
    if (oldest !== undefined) delete records[oldest]
  }
  return true
}

export function project_history() {
  const records = ensure_records()
  const order = ensure_order()
  const result: ProjectHistoryRecord[] = []
  for (let index = order.length - 1; index >= 0; index--) {
    const record = records[order[index]]
    if (record !== undefined) result.push(record)
  }
  return result
}

export function project_by_id(project_id: string) {
  return ensure_records()[project_id]
}

export function projects_ui_is_open(player_index: number) {
  return storage.airi_task_board_projects_open?.[player_index] === true
}

export function toggle_projects_ui(player_index: number) {
  const next = !projects_ui_is_open(player_index)
  ensure_open()[player_index] = next
  return next
}

export function close_projects_ui(player_index: number) {
  ensure_open()[player_index] = false
}

export function select_project(player_index: number, project_id: string) {
  if (project_by_id(project_id) === undefined) return false
  ensure_selected()[player_index] = project_id
  return true
}

export function selected_project_id(player_index: number, current_goal_id = '') {
  const selected = storage.airi_task_board_project_selected?.[player_index]
  if (selected !== undefined && project_by_id(selected) !== undefined) return selected
  if (current_goal_id.length > 0 && project_by_id(current_goal_id) !== undefined) return current_goal_id
  const history = project_history()
  return history.length > 0 ? history[0].id : ''
}

function project_export_path_component(value: string) {
  let safe = clean_text(value, 100)
  for (const token of ['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' ']) safe = safe.split(token).join('_')
  while (safe.includes('..')) safe = safe.split('..').join('_')
  return safe.length > 0 ? safe : 'task'
}

export function project_export_payload(project: ProjectHistoryRecord): ProjectExportPayload {
  return {
    schema_version: 1,
    kind: 'airi_old_task_export',
    goal: {
      id: project.id,
      name: project.name,
      objective: project.objective,
      status: project.status,
      response: project.response,
      blocker: project.blocker,
      pause_reason: project.pause_reason,
      completed_count: project.completed_count,
      total_steps: project.total_steps,
      active_index: project.active_index,
      created_tick: project.created_tick,
      updated_tick: project.updated_tick,
    },
    steps: project.steps.map(step => ({ ...step })),
    conversation: (project.conversation ?? []).map(message => ({ ...message })),
    activity: project.activity.map(entry => ({ ...entry })),
  }
}

export function serialize_project_export_json(project: ProjectHistoryRecord) {
  return `${helpers.table_to_json(project_export_payload(project))}\n`
}

function project_export_markdown(project: ProjectHistoryRecord) {
  const lines: string[] = [
    `# ${project.name}`,
    '',
    '> SGLuna Old Task export. This contains player-facing task history only; it does not include hidden model reasoning or private model memory.',
    '',
    '## Task',
    '',
    `- Goal ID: ${project.id}`,
    `- Status: ${project.status}`,
    `- Progress: ${project.completed_count}/${project.total_steps}`,
    `- Active step index: ${project.active_index}`,
    `- Created tick: ${project.created_tick}`,
    `- Updated tick: ${project.updated_tick}`,
    '',
    '## Objective',
    '',
    project.objective || 'No objective retained.',
  ]
  if (project.response.length > 0) lines.push('', '## Latest SGLuna Response', '', project.response)
  if (project.blocker.length > 0) lines.push('', '## Blocker', '', project.blocker)
  if (project.pause_reason.length > 0) lines.push('', '## Pause Reason', '', project.pause_reason)

  lines.push('', '## Steps', '')
  if (project.steps.length === 0) lines.push('- No durable steps retained.')
  else {
    for (let index = 0; index < project.steps.length; index++) {
      const step = project.steps[index]
      lines.push(`- ${index + 1}. [${step.status.toUpperCase()}] ${step.description}`)
    }
  }

  lines.push('', '## Conversation', '')
  if ((project.conversation ?? []).length === 0) lines.push('- No explicit player/agent conversation retained.')
  else {
    for (const message of project.conversation) {
      lines.push(`- **${message.sender} (${message.role})**: ${message.text}`)
    }
  }

  lines.push('', '## Activity / Evidence', '')
  if (project.activity.length === 0) lines.push('- No retained activity.')
  else {
    for (const entry of project.activity) {
      const timestamp = entry.timestamp ? `${entry.timestamp} · ` : ''
      lines.push(`- ${timestamp}${entry.kind.toUpperCase()} · ${entry.text}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

export function project_export_relative_directory(project: Pick<ProjectHistoryRecord, 'id'>) {
  return `sgluna-old-tasks/${project_export_path_component(project.id)}`
}

export function export_project(project_id: string): ProjectExportResult {
  const project = project_by_id(project_id)
  if (project === undefined) throw new Error(`unknown old task: ${project_id}`)
  const directory = project_export_relative_directory(project)
  helpers.write_file(`${directory}/task.json`, serialize_project_export_json(project), false)
  helpers.write_file(`${directory}/TASK.md`, project_export_markdown(project), false)
  return { project_id: project.id, relative_path: `script-output/${directory}` }
}

export function handle_project_export_click(player: LuaPlayer, element_name: string, current_goal_id = '') {
  if (element_name !== PROJECT_EXPORT_BUTTON_NAME) return false
  const project_id = selected_project_id(player.index, current_goal_id)
  if (project_id.length === 0) {
    player.print('[SGLuna] Old Task export failed: no task is selected.')
    return true
  }
  try {
    const result = export_project(project_id)
    player.print(`[SGLuna] Exported old task ${project_id}: ${result.relative_path}/task.json and TASK.md`)
  }
  catch (error) {
    player.print(`[SGLuna] Old Task export failed: ${error instanceof Error ? error.message : 'invalid task'}`)
  }
  return true
}

function destroy_projects_popout(player: LuaPlayer) {
  const existing = player.gui.screen[ROOT_NAME]
  const location = existing?.valid ? existing.location : undefined
  if (existing?.valid) existing.destroy()
  return location
}

function render_titlebar(root: FrameGuiElement) {
  const titlebar = root.add({ type: 'flow', direction: 'horizontal' })
  titlebar.style.horizontally_stretchable = true
  titlebar.style.horizontal_spacing = 8
  titlebar.drag_target = root
  titlebar.add({ type: 'label', caption: 'Projects', style: 'frame_title', ignored_by_interaction: true })
  const dragger = titlebar.add({ type: 'empty-widget', style: 'draggable_space_header', ignored_by_interaction: true })
  dragger.style.horizontally_stretchable = true
  dragger.style.height = 24
  titlebar.add({ type: 'sprite-button', name: PROJECTS_CLOSE_BUTTON_NAME, sprite: 'utility/close', style: 'frame_action_button', tooltip: 'Close Projects' })
}

function project_list_values(selected_id: string) {
  const history = project_history()
  const items: string[] = []
  const ids: string[] = []
  let selected_index = 0
  for (let index = 0; index < history.length; index++) {
    const project = history[index]
    items.push(`Task ${index + 1} · ${project.completed_count}/${project.total_steps}`)
    ids.push(project.id)
    if (project.id === selected_id) selected_index = index + 1
  }
  return { history, items, ids, selected_index }
}

function render_project_list(parent: LuaGuiElement, selected_id: string) {
  const frame = parent.add({ type: 'frame', name: LIST_FRAME_NAME, direction: 'vertical', style: 'inside_shallow_frame' })
  frame.style.width = PROJECT_LIST_WIDTH
  frame.style.height = PROJECTS_HEIGHT
  frame.style.vertically_stretchable = true
  const header = frame.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.add({ type: 'label', caption: 'PROJECTS', style: 'subheader_caption_label' })
  const values = project_list_values(selected_id)
  if (values.history.length === 0) {
    const empty = frame.add({ type: 'label', caption: 'No durable SGLuna projects recorded yet.' })
    empty.style.single_line = false
    empty.style.maximal_width = PROJECT_LIST_WIDTH - 16
    return
  }
  const list = frame.add({
    type: 'list-box',
    name: PROJECT_LIST_NAME,
    items: values.items,
    selected_index: values.selected_index,
    tags: { airi_project_ids: values.ids },
  }) as any
  // Stretch into the frame instead of reserving the old 20 px strip on the
  // right. The selected-row highlight now reaches the usable panel edge.
  list.style.horizontally_stretchable = true
  list.style.vertically_stretchable = true
  list.style.minimal_width = PROJECT_LIST_WIDTH - 8
  list.style.maximal_height = PROJECTS_HEIGHT - 40
}

function refresh_project_list(frame: LuaGuiElement, selected_id: string) {
  const list = frame[PROJECT_LIST_NAME] as any
  if (!list?.valid) return false
  const values = project_list_values(selected_id)
  list.items = values.items
  list.tags = { airi_project_ids: values.ids }
  list.selected_index = values.selected_index
  return true
}

function add_detail_row(parent: LuaGuiElement, key: string, value: string) {
  const row = parent.add({ type: 'flow', direction: 'horizontal' })
  row.style.horizontal_spacing = 8
  const label = row.add({ type: 'label', caption: key, style: 'semibold_label' })
  label.style.minimal_width = 82
  const content = gui_text.literal_gui_text(row.add({ type: 'label', caption: value.length > 0 ? value : '—' }))
  content.style.single_line = false
  content.style.maximal_width = PROJECT_DETAIL_WIDTH - 120
}

function step_signature(project: ProjectHistoryRecord) {
  let signature = `${project.id}|${project.total_steps}|${project.active_index}`
  for (const step of project.steps) signature = `${signature}|${step.id}:${step.status}:${step.description}`
  return signature
}

function activity_rows_diff(shown: string[], wanted: string[]) {
  for (let overlap = math.min(shown.length, wanted.length); overlap >= 0; overlap--) {
    if (overlap === 0 && shown.length > 0) return undefined
    let matches = true
    for (let index = 0; index < overlap; index++) {
      if (shown[shown.length - overlap + index] !== wanted[index]) { matches = false; break }
    }
    if (matches) return { drop: shown.length - overlap, append: wanted.length - overlap }
  }
  return undefined
}

function add_activity_line(parent: LuaGuiElement, entry: ProjectHistoryActivity) {
  const prefix = entry.timestamp !== undefined ? `${entry.timestamp} · ` : ''
  const line = gui_text.literal_gui_text(parent.add({ type: 'label', caption: `${prefix}${entry.kind.toUpperCase()} · ${entry.text}` }))
  line.style.single_line = false
  line.style.maximal_width = PROJECT_DETAIL_WIDTH - 60
}

function add_filter_button(parent: LuaGuiElement, caption: string, tooltip: string, flag: number) {
  activity_state.style_feed_button(parent.add({ type: 'button', caption, tooltip, tags: { airi_activity_filter: flag, airi_activity_surface: 'projects' } }))
}

function render_project_detail_skeleton(parent: LuaGuiElement, project: ProjectHistoryRecord | undefined) {
  const frame = parent.add({ type: 'frame', name: DETAIL_FRAME_NAME, direction: 'vertical', style: 'inside_shallow_frame' })
  frame.style.width = PROJECT_DETAIL_WIDTH
  frame.style.height = PROJECTS_HEIGHT
  frame.style.vertically_stretchable = true
  const header = frame.add({ type: 'frame', direction: 'horizontal', style: 'subheader_frame' })
  header.style.horizontally_stretchable = true
  header.add({ type: 'label', caption: 'Project Detail', style: 'subheader_caption_label' })
  const header_spacer = header.add({ type: 'empty-widget' })
  header_spacer.style.horizontally_stretchable = true
  const export_button = header.add({
    type: 'button',
    name: PROJECT_EXPORT_BUTTON_NAME,
    caption: 'EXPORT TASK',
    style: 'confirm_button',
    tooltip: 'Export this archived task as task.json plus a readable TASK.md under script-output/sgluna-old-tasks for analysis by another agent.',
  })
  export_button.enabled = project !== undefined
  const body = frame.add({ type: 'flow', name: DETAIL_BODY_NAME, direction: 'vertical' })
  body.style.padding = 10
  body.style.vertical_spacing = 6
  body.style.horizontally_stretchable = true
  body.style.vertically_stretchable = true
  body.tags = { project_id: project?.id ?? '' }

  const meta = body.add({ type: 'flow', name: DETAIL_META_NAME, direction: 'vertical' })
  meta.style.horizontally_stretchable = true
  meta.style.vertical_spacing = 6
  body.add({ type: 'line' })
  body.add({ type: 'label', caption: 'Tasks / Steps', style: 'semibold_label' })
  const step_scroll = body.add({ type: 'scroll-pane', name: DETAIL_STEPS_SCROLL_NAME, horizontal_scroll_policy: 'never' })
  step_scroll.style.maximal_height = 260
  step_scroll.style.width = PROJECT_DETAIL_WIDTH - 30
  const step_flow = step_scroll.add({ type: 'flow', name: DETAIL_STEPS_FLOW_NAME, direction: 'vertical', tags: { signature: '' } })
  step_flow.style.horizontally_stretchable = true
  step_flow.style.vertical_spacing = 2

  body.add({ type: 'label', caption: 'Task Conversation', style: 'semibold_label' })
  const conversation_scroll = body.add({ type: 'scroll-pane', name: DETAIL_CONVERSATION_SCROLL_NAME, horizontal_scroll_policy: 'never' })
  conversation_scroll.style.width = PROJECT_DETAIL_WIDTH - 30
  conversation_scroll.style.maximal_height = 220
  const conversation_flow = conversation_scroll.add({ type: 'flow', name: DETAIL_CONVERSATION_FLOW_NAME, direction: 'vertical' })
  conversation_flow.style.horizontally_stretchable = true
  conversation_flow.style.vertical_spacing = 3

  // Activity / Evidence is secondary diagnostic history.
  const activity_header = body.add({ type: 'flow', name: DETAIL_ACTIVITY_HEADER_NAME, direction: 'horizontal' })
  activity_header.style.horizontally_stretchable = true
  activity_header.style.vertical_align = 'center'
  activity_header.style.horizontal_spacing = 8
  activity_header.style.width = PROJECT_DETAIL_WIDTH - 30
  activity_header.add({ type: 'label', caption: 'Activity / Evidence', style: 'semibold_label' })
  const filler = activity_header.add({ type: 'empty-widget' })
  filler.style.horizontally_stretchable = true
  const filters = activity_header.add({ type: 'flow', name: DETAIL_ACTIVITY_FILTERS_NAME, direction: 'horizontal' })
  filters.style.horizontal_spacing = 2
  add_filter_button(filters, 'ALL', 'Show every kind of activity', activity_state.ACTIVITY_FILTER_ALL)
  for (const filter of activity_state.ACTIVITY_FILTERS) add_filter_button(filters, filter.caption, `${filter.tooltip}. Click to show or hide; several can be on at once.`, filter.flag)
  activity_header.add({ type: 'label', name: DETAIL_ACTIVITY_COUNT_NAME, caption: '', style: 'semibold_label' })
  const activity_scroll = body.add({ type: 'scroll-pane', name: DETAIL_ACTIVITY_SCROLL_NAME, horizontal_scroll_policy: 'never' })
  activity_scroll.style.width = PROJECT_DETAIL_WIDTH - 30
  activity_scroll.style.vertically_stretchable = true
  activity_scroll.style.minimal_height = 140
  const activity_flow = activity_scroll.add({ type: 'flow', name: DETAIL_ACTIVITY_FLOW_NAME, direction: 'vertical', tags: { keys: [] } })
  activity_flow.style.horizontally_stretchable = true
  activity_flow.style.vertical_spacing = 2
}

function refresh_project_detail(frame: LuaGuiElement, project: ProjectHistoryRecord | undefined, player_index: number, force_activity_latest = false) {
  const body = frame[DETAIL_BODY_NAME]
  if (!body?.valid) return false
  const current_id = String(body.tags.project_id ?? '')
  const next_id = project?.id ?? ''
  if (current_id !== next_id) return false
  const meta = body[DETAIL_META_NAME]
  const step_scroll = body[DETAIL_STEPS_SCROLL_NAME]
  const conversation_scroll = body[DETAIL_CONVERSATION_SCROLL_NAME]
  const activity_scroll = body[DETAIL_ACTIVITY_SCROLL_NAME]
  const activity_header = body[DETAIL_ACTIVITY_HEADER_NAME]
  const step_flow = step_scroll?.valid ? step_scroll[DETAIL_STEPS_FLOW_NAME] : undefined
  const conversation_flow = conversation_scroll?.valid ? conversation_scroll[DETAIL_CONVERSATION_FLOW_NAME] : undefined
  const activity_flow = activity_scroll?.valid ? activity_scroll[DETAIL_ACTIVITY_FLOW_NAME] : undefined
  if (!meta?.valid || !step_scroll?.valid || !conversation_scroll?.valid || !activity_scroll?.valid || !activity_header?.valid || !step_flow?.valid || !conversation_flow?.valid || !activity_flow?.valid) return false
  const mask = activity_state.activity_filter_mask(player_index, 'projects')
  const filters = activity_header[DETAIL_ACTIVITY_FILTERS_NAME]
  if (filters?.valid) {
    for (const button of filters.children) {
      const flag = button.tags.airi_activity_filter
      if (typeof flag === 'number') (button as ButtonGuiElement).toggled = activity_state.activity_filter_selected(mask, flag)
    }
  }
  const count = activity_header[DETAIL_ACTIVITY_COUNT_NAME]

  if (project === undefined) {
    meta.clear()
    meta.tags = { signature: '' }
    meta.add({ type: 'label', caption: 'Select a project from the left.' })
    step_flow.clear()
    conversation_flow.clear()
    activity_flow.clear()
    step_flow.tags = { signature: '' }
    conversation_flow.tags = { signature: '' }
    activity_flow.tags = { keys: [], mask }
    if (count?.valid) count.caption = ''
    return true
  }
  // Meta rows and the conversation are redrawn only when their text changes,
  // so a routine refresh leaves the window alone.
  const meta_rows: Array<[string, string]> = [['GOAL', project.objective], ['STATUS', project.status.toUpperCase()], ['PROGRESS', `${project.completed_count}/${project.total_steps}`]]
  if (project.blocker.length > 0) meta_rows.push(['BLOCKER', project.blocker])
  if (project.pause_reason.length > 0) meta_rows.push(['PAUSED', project.pause_reason])
  const meta_signature = helpers.table_to_json(meta_rows)
  if (meta.tags.signature !== meta_signature) {
    meta.clear()
    for (const [key, value] of meta_rows) add_detail_row(meta, key, value)
    meta.tags = { signature: meta_signature }
  }
  const conversation_lines: string[] = []
  if ((project.conversation ?? []).length > 0) {
    for (const message of project.conversation) {
      const text = clean_text(message.text, 2000)
      if (text.length === 0) continue
      const sender = clean_text(message.sender || (message.role === 'assistant' ? 'AIRI' : 'Player'), 128)
      conversation_lines.push(`${sender} · ${text}`)
    }
  }
  else {
    for (const entry of project.activity) {
      const text = clean_text(entry.text, 1200)
      if (entry.kind === 'decision' && text.length > 0) { conversation_lines.push(`AIRI · ${text}`); continue }
      if (entry.kind !== 'observation' || !String(entry.id ?? '').startsWith('live_')) continue
      const separator = text.indexOf(': ')
      if (separator < 1 || text.startsWith('Tool ')) continue
      conversation_lines.push(`${text.substring(0, separator)} · ${text.substring(separator + 2)}`)
    }
    if (project.response.length > 0) {
      const duplicate = project.activity.some(entry => entry.kind === 'decision' && clean_text(entry.text, 1200) === project.response)
      if (!duplicate) conversation_lines.push(`AIRI · ${project.response}`)
    }
  }
  const conversation_signature = helpers.table_to_json(conversation_lines)
  if (conversation_flow.tags.signature !== conversation_signature || conversation_flow.children.length === 0) {
    conversation_flow.clear()
    for (const caption of conversation_lines) {
      const line = gui_text.literal_gui_text(conversation_flow.add({ type: 'label', caption }))
      line.style.single_line = false
      line.style.maximal_width = PROJECT_DETAIL_WIDTH - 60
    }
    if (conversation_lines.length === 0) conversation_flow.add({ type: 'label', caption: 'No player/agent conversation retained for this project.' })
    conversation_flow.tags = { signature: conversation_signature }
  }

  const signature = step_signature(project)
  if (step_flow.tags.signature !== signature) {
    step_flow.clear()
    if (project.steps.length === 0) step_flow.add({ type: 'label', caption: 'No durable steps recorded.' })
    else {
      for (let index = 0; index < project.steps.length; index++) {
        const step = project.steps[index]
        const line = gui_text.literal_gui_text(step_flow.add({ type: 'label', caption: `${index + 1}. [${step.status.toUpperCase()}] ${step.description}` }))
        line.style.single_line = false
        line.style.maximal_width = PROJECT_DETAIL_WIDTH - 60
      }
    }
    step_flow.tags = { signature }
  }

  const matching: ProjectHistoryActivity[] = []
  for (const entry of project.activity) {
    if (activity_state.activity_matches_mask(entry.kind as TaskBoardUiActivity['kind'], mask)) matching.push(entry)
  }
  const start = math.max(0, matching.length - MAX_ACTIVITY_VISIBLE)
  const entries = matching.slice(start)
  const keys = entries.map(activity_key)
  const shown = (activity_flow.tags.keys ?? []) as string[]
  // A new selection shows a different set of rows, so start from its newest.
  const mask_changed = activity_flow.tags.mask !== mask
  const diff = activity_rows_diff(shown, keys)
  // Nothing shown can still mean the placeholder label is there; rebuild so it
  // does not stay above the first real rows.
  if (diff === undefined || shown.length === 0) {
    activity_flow.clear()
    for (const entry of entries) add_activity_line(activity_flow, entry)
  }
  else {
    for (let index = 0; index < diff.drop; index++) {
      const first = activity_flow.children[0]
      if (first?.valid) first.destroy()
    }
    for (let index = entries.length - diff.append; index < entries.length; index++) add_activity_line(activity_flow, entries[index])
  }
  activity_flow.tags = { keys, mask }
  if (entries.length === 0 && activity_flow.children.length === 0) {
    const caption = project.activity.length === 0 ? 'No retained activity recorded for this project.' : mask === 0 ? 'No activity categories selected.' : 'No activity for this project matches this filter.'
    activity_flow.add({ type: 'label', caption })
  }
  if (count?.valid) count.caption = mask === activity_state.ACTIVITY_FILTER_ALL ? `${project.activity.length} events` : `${matching.length}/${project.activity.length}`
  if ((force_activity_latest || mask_changed) && entries.length > 0) (activity_scroll as ScrollPaneGuiElement).scroll_to_bottom()
  return true
}

function build_projects_body(body: LuaGuiElement, player: LuaPlayer, current_goal_id: string) {
  const selected_id = selected_project_id(player.index, current_goal_id)
  const selected = selected_id.length > 0 ? project_by_id(selected_id) : undefined
  const columns = body.add({ type: 'flow', name: COLUMNS_NAME, direction: 'horizontal' })
  columns.style.horizontal_spacing = 12
  columns.style.height = PROJECTS_HEIGHT
  columns.style.vertical_align = 'top'
  render_project_list(columns, selected_id)
  render_project_detail_skeleton(columns, selected)
  const detail = columns[DETAIL_FRAME_NAME]
  if (detail?.valid) refresh_project_detail(detail, selected, player.index, true)
}

function build_projects_popout(player: LuaPlayer, current_goal_id: string) {
  const previous_location = destroy_projects_popout(player)
  const root = player.gui.screen.add({ type: 'frame', name: ROOT_NAME, direction: 'vertical' }) as FrameGuiElement
  if (previous_location !== undefined) root.location = previous_location
  else root.auto_center = true
  render_titlebar(root)
  const body = root.add({ type: 'flow', name: BODY_NAME, direction: 'vertical' })
  body.style.width = PROJECTS_WIDTH
  body.style.height = PROJECTS_HEIGHT
  build_projects_body(body, player, current_goal_id)
  root.bring_to_front()
}

export function render_projects_popout(player: LuaPlayer, task_board_open: boolean, current_goal_id = '') {
  if (!task_board_open || !projects_ui_is_open(player.index)) {
    destroy_projects_popout(player)
    return
  }
  const root = player.gui.screen[ROOT_NAME]
  const body = root?.valid ? root[BODY_NAME] : undefined
  const columns = body?.valid ? body[COLUMNS_NAME] : undefined
  const list_frame = columns?.valid ? columns[LIST_FRAME_NAME] : undefined
  const detail_frame = columns?.valid ? columns[DETAIL_FRAME_NAME] : undefined
  if (!body?.valid || !columns?.valid || !list_frame?.valid || !detail_frame?.valid) {
    build_projects_popout(player, current_goal_id)
    return
  }

  const selected_id = selected_project_id(player.index, current_goal_id)
  const selected = selected_id.length > 0 ? project_by_id(selected_id) : undefined
  refresh_project_list(list_frame, selected_id)
  const current_detail_id = String(detail_frame[DETAIL_BODY_NAME]?.tags.project_id ?? '')
  if (current_detail_id !== selected_id) {
    detail_frame.destroy()
    render_project_detail_skeleton(columns, selected)
    const rebuilt = columns[DETAIL_FRAME_NAME]
    if (rebuilt?.valid) refresh_project_detail(rebuilt, selected, player.index, true)
    return
  }
  // Routine heartbeats now update labels/rows in place. Scroll panes survive,
  // so reading an older completed project no longer jumps back to the top.
  refresh_project_detail(detail_frame, selected, player.index)
}

export function handle_project_selection(player: LuaPlayer, element: any) {
  if (element.name !== PROJECT_LIST_NAME) return false
  const ids = element.tags?.airi_project_ids as string[] | undefined
  const index = typeof element.selected_index === 'number' ? element.selected_index - 1 : -1
  if (ids === undefined || index < 0 || index >= ids.length) return true
  select_project(player.index, ids[index])
  render_projects_popout(player, true, ids[index])
  return true
}
