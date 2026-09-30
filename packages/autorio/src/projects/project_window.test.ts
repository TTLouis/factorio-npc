import { beforeEach, describe, expect, it } from 'vitest'
import {
  export_project,
  handle_project_export_click,
  project_by_id,
  project_export_payload,
  project_export_relative_directory,
  project_history,
  projects_ui_is_open,
  record_project_snapshot,
  select_project,
  selected_project_id,
  toggle_projects_ui,
} from './project_window'

declare const globalThis: any

beforeEach(() => {
  globalThis.storage = {}
  globalThis.math = Math
  globalThis.helpers = {
    table_to_json: (value: unknown) => JSON.stringify(value),
    write_file: () => {},
  }
})

function snapshot(goal_id: string, objective: string, activity: any[] = []) {
  return {
    goal_id,
    objective,
    response: '',
    status: 'active',
    blocker: '',
    pause_reason: '',
    completed_count: 1,
    total_steps: 3,
    active_index: 1,
    steps: [
      { id: 'observe', description: 'Observe the area', status: 'completed' },
      { id: 'build', description: 'Build the line', status: 'active' },
    ],
    activity,
  }
}

describe('project GUI literal-text boundary', () => {
  it('keeps archived player/model text out of rich-text-capable list items and uses literal labels for details', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./project_window.ts', import.meta.url), 'utf8')
    expect(source).toContain("import * as gui_text from '../task_board_gui_text'")
    expect(source).toContain('items.push(`Task ${index + 1} · ${project.completed_count}/${project.total_steps}`)')
    expect(source).not.toContain('items.push(project.name)')
    expect(source).toContain('gui_text.literal_gui_text(row.add(')
    expect(source).toContain('gui_text.literal_gui_text(parent.add(')
    expect(source).toContain('gui_text.literal_gui_text(conversation_flow.add(')
    expect(source).toContain('gui_text.literal_gui_text(step_flow.add(')
  })

  it('preserves archived rich-text-looking content in durable data instead of mutating it for presentation', () => {
    const rich = '[item=iron-plate] [color=red]hello[/color] [ ]] 普通中文 English'
    record_project_snapshot({
      ...snapshot('goal-rich', rich, [{ id: 'a', kind: 'result', text: rich }]),
      response: rich,
      blocker: rich,
      conversation: [{ id: 'm1', role: 'assistant', sender: rich, text: rich }],
      steps: [{ id: 's1', description: rich, status: 'active' }],
    }, 60)
    const project = project_by_id('goal-rich')!
    expect(project.objective).toBe(rich)
    expect(project.response).toBe(rich)
    expect(project.blocker).toBe(rich)
    expect(project.activity[0].text).toBe(rich)
    expect(project.conversation[0].text).toBe(rich)
    expect(project.steps[0].description).toBe(rich)
  })
})
describe('project activity filters', () => {
  it('filters the Projects feed with its own toggles, routed by the console click handler', async () => {
    const { readFileSync } = await import('node:fs')
    const window_source = readFileSync(new URL('./project_window.ts', import.meta.url), 'utf8')
    const console_source = readFileSync(new URL('../task_board_ui.ts', import.meta.url), 'utf8')
    expect(window_source).toContain("tags: { sgluna_activity_filter: flag, sgluna_activity_surface: 'projects' }")
    expect(window_source).toContain("activity_state.activity_filter_mask(player_index, 'projects')")
    expect(window_source).toContain('activity_state.activity_matches_mask(entry.kind as TaskBoardUiActivity[\'kind\'], mask)')
    // Both panes scroll only under the shared LIVE state, and only for new rows.
    expect(window_source).toContain('const live = activity_state.activity_view(player_index).live')
    expect(window_source).toContain('if (live && (force_activity_latest || mask_changed || appended > 0)')
    expect(window_source).toContain('if (live && conversation_lines.length > 0 && (force_activity_latest || conversation_lines.length > previous_conversation_count)) (conversation_scroll as ScrollPaneGuiElement).scroll_to_bottom()')
    expect(console_source).toContain("element.tags?.sgluna_activity_surface === 'projects') { activity_state.toggle_activity_filter(player.index, filter_flag, 'projects'); project_ui.render_projects_popout(player, true, storage.sgluna_task_board_ui?.goal_id ?? ''); return }")
  })
})

describe('project history model', () => {
  it('ignores plan-less live snapshots without a durable goal id', () => {
    expect(record_project_snapshot(snapshot('', 'thinking'), 60)).toBe(false)
    expect(project_history()).toEqual([])
  })

  it('upserts one durable project per goal and keeps newest semantic update first', () => {
    record_project_snapshot(snapshot('goal-a', 'Build power'), 60)
    record_project_snapshot(snapshot('goal-b', 'Build green circuits'), 120)
    record_project_snapshot({ ...snapshot('goal-a', 'Build power'), status: 'completed', completed_count: 3 }, 180)

    expect(project_history().map(project => project.id)).toEqual(['goal-a', 'goal-b'])
    expect(project_by_id('goal-a')?.status).toBe('completed')
    expect(project_by_id('goal-a')?.created_tick).toBe(60)
    expect(project_by_id('goal-a')?.updated_tick).toBe(180)
  })

  it('treats an unchanged heartbeat as a no-op', () => {
    expect(record_project_snapshot(snapshot('goal-a', 'Build power'), 60)).toBe(true)
    expect(record_project_snapshot(snapshot('goal-a', 'Build power'), 120)).toBe(false)
    expect(project_by_id('goal-a')?.updated_tick).toBe(60)
  })

  it('keeps completed projects frozen until their content actually changes', () => {
    const completed = { ...snapshot('goal-a', 'Build power'), status: 'completed', completed_count: 3, active_index: 2 }
    record_project_snapshot(completed, 60)
    record_project_snapshot(snapshot('goal-b', 'Build circuits'), 120)

    expect(record_project_snapshot(completed, 180)).toBe(false)
    expect(project_by_id('goal-a')?.updated_tick).toBe(60)
    expect(project_history().map(project => project.id)).toEqual(['goal-b', 'goal-a'])

    const changed = {
      ...completed,
      activity: [{ id: 'done', kind: 'result', text: 'Power build verified', timestamp: '00:03:00' }],
    }
    expect(record_project_snapshot(changed, 240)).toBe(true)
    expect(project_by_id('goal-a')?.updated_tick).toBe(240)
    expect(project_history().map(project => project.id)).toEqual(['goal-a', 'goal-b'])
  })

  it('merges retained activity without duplicating the same event', () => {
    record_project_snapshot(snapshot('goal-a', 'Build power', [
      { id: 'request', kind: 'observation', text: 'Louis: build power', timestamp: '00:01:00' },
    ]), 60)
    record_project_snapshot(snapshot('goal-a', 'Build power', [
      { id: 'request', kind: 'observation', text: 'Louis: build power', timestamp: '00:01:00' },
      { id: 'reply', kind: 'decision', text: 'I will build power.', timestamp: '00:01:05' },
    ]), 120)

    expect(project_by_id('goal-a')?.activity).toHaveLength(2)
  })

  it('tracks project window open state and stable per-player selection', () => {
    record_project_snapshot(snapshot('goal-a', 'Build power'), 60)
    record_project_snapshot(snapshot('goal-b', 'Build circuits'), 120)

    expect(projects_ui_is_open(1)).toBe(false)
    expect(toggle_projects_ui(1)).toBe(true)
    expect(projects_ui_is_open(1)).toBe(true)
    expect(selected_project_id(1, 'goal-a')).toBe('goal-a')
    expect(select_project(1, 'goal-b')).toBe(true)
    expect(selected_project_id(1, 'goal-a')).toBe('goal-b')
  })
})

describe('old task export', () => {
  it('exports the selected archived task as structured JSON plus an agent-readable markdown companion', () => {
    const conversation = [
      { id: 'u1', role: 'user', sender: 'TTLouis', text: 'Build power and smelting' },
      { id: 'a1', role: 'assistant', sender: 'SGLuna', text: 'I will build power first.' },
    ]
    const activity = [
      { id: 'receipt-1', kind: 'result', text: 'Autorio batch 1 completed', timestamp: '00:01:00' },
    ]
    record_project_snapshot({
      ...snapshot('goal-export', 'Build power and smelting', activity),
      response: 'I will build power first.',
      blocker: 'waiting_for_iron',
      conversation,
    }, 120)

    const project = project_by_id('goal-export')!
    const payload = project_export_payload(project)
    expect(payload.schema_version).toBe(1)
    expect(payload.kind).toBe('sgluna_old_task_export')
    expect(payload.goal.id).toBe('goal-export')
    expect(payload.goal.objective).toBe('Build power and smelting')
    expect(payload.conversation.map(message => message.text)).toEqual([
      'Build power and smelting',
      'I will build power first.',
    ])
    expect(payload.activity[0].text).toBe('Autorio batch 1 completed')
    expect(project_export_relative_directory(project)).toBe('sgluna-old-tasks/goal-export')

    const writes: Array<{ path: string, content: string, append: boolean }> = []
    globalThis.helpers.write_file = (path: string, content: string, append: boolean) => writes.push({ path, content, append })
    const result = export_project('goal-export')
    expect(result.relative_path).toBe('script-output/sgluna-old-tasks/goal-export')
    expect(writes.map(write => write.path)).toEqual([
      'sgluna-old-tasks/goal-export/task.json',
      'sgluna-old-tasks/goal-export/TASK.md',
    ])
    expect(JSON.parse(writes[0].content).conversation).toHaveLength(2)
    expect(writes[1].content).toContain('## Conversation')
    expect(writes[1].content).toContain('TTLouis (user)')
    expect(writes.every(write => write.append === false)).toBe(true)
  })

  it('routes EXPORT TASK through the selected Old Tasks project and reports the exported path', async () => {
    record_project_snapshot(snapshot('goal-a', 'Build power'), 60)
    select_project(1, 'goal-a')
    const messages: string[] = []
    const writes: string[] = []
    globalThis.helpers.write_file = (path: string) => writes.push(path)
    const player = { index: 1, print: (message: string) => messages.push(message) } as any

    expect(handle_project_export_click(player, 'not-export')).toBe(false)
    expect(handle_project_export_click(player, 'sgluna_task_board_project_export')).toBe(true)
    expect(writes).toEqual([
      'sgluna-old-tasks/goal-a/task.json',
      'sgluna-old-tasks/goal-a/TASK.md',
    ])
    expect(messages[0]).toContain('script-output/sgluna-old-tasks/goal-a/task.json and TASK.md')

    const { readFileSync } = await import('node:fs')
    const window_source = readFileSync(new URL('./project_window.ts', import.meta.url), 'utf8')
    const console_source = readFileSync(new URL('../task_board_ui.ts', import.meta.url), 'utf8')
    expect(window_source).toContain("caption: 'EXPORT TASK'")
    expect(window_source).toContain('task.json plus a readable TASK.md')
    expect(console_source).toContain('project_ui.handle_project_export_click(player, element.name')
  })
})

describe('project conversation archive', () => {
  it('stores the explicit task conversation instead of reconstructing only the recent activity tail', () => {
    const conversation = Array.from({ length: 8 }, (_, index) => ({
      id: `message_${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      sender: index % 2 === 0 ? 'TTLouis' : 'SGLuna',
      text: `message ${index + 1}`,
    }))
    record_project_snapshot({ ...snapshot('goal-a', 'Build power'), conversation }, 60)
    expect(project_by_id('goal-a')?.conversation.map(message => message.text)).toEqual([
      'message 1', 'message 2', 'message 3', 'message 4',
      'message 5', 'message 6', 'message 7', 'message 8',
    ])
  })
})
