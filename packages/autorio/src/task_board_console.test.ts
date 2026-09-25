import { describe, expect, it } from 'vitest'
import * as console_ui from './task_board_console'
import { sanitize_task_board_ui_snapshot } from './task_board_ui'

// A minimal stand-in for LuaGuiElement: add() records children, and named
// children are reachable by index the way Factorio exposes them.
interface FakeElement {
  [key: string]: any
  type: string
  name?: string
  caption?: string
  value?: number
  sprite?: string
  children: FakeElement[]
  style: Record<string, unknown>
  add: (spec: Record<string, unknown>) => FakeElement
}

function element(spec: Record<string, unknown> = { type: 'flow' }): FakeElement {
  const node: FakeElement = {
    ...spec,
    type: String(spec.type),
    valid: true,
    children: [],
    style: {},
    add(child: Record<string, unknown>) {
      const created = element(child)
      node.children.push(created)
      if (typeof child.name === 'string') node[child.name] = created
      return created
    },
    destroy() { node.valid = false },
  }
  return node
}

function captions(root: FakeElement): string[] {
  const out: string[] = []
  const walk = (node: FakeElement) => {
    if (node.type === 'label' && typeof node.caption === 'string') out.push(node.caption)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return out
}

function find(root: FakeElement, match: (node: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = []
  const walk = (node: FakeElement) => {
    if (match(node)) out.push(node)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return out
}

describe('console Goal and Now cards', () => {
  it('shows each goal check with its progress and how many are met', () => {
    const parent = element()
    console_ui.render_goal_card(parent as any, {
      summary: 'Launch a rocket from this save.',
      note: '',
      read: true,
      met: 1,
      total: 2,
      checks: [
        { text: 'research "rocket-silo" is completed', met: true, progress: 'done' },
        { text: '1 rocket launched from now on', met: false, progress: '0/1' },
      ],
    })
    const text = captions(parent)
    expect(text).toContain('Goal')
    expect(text).toContain('1/2 checks met')
    expect(text).toContain('Launch a rocket from this save.')
    expect(text).toContain('research "rocket-silo" is completed')
    expect(text).toContain('0/1')
    expect(find(parent, node => node.type === 'progressbar')[0].value).toBe(0.5)
    expect(find(parent, node => node.type === 'sprite').map(node => node.sprite)).toEqual(['utility/status_working', 'utility/status_inactive'])
  })

  it('says the checks were not read instead of reporting 0 met', () => {
    const parent = element()
    console_ui.render_goal_card(parent as any, { summary: 'Launch a rocket.', note: '', read: false, met: 0, total: 1, checks: [{ text: '1 rocket launched from now on', met: false, progress: 'not read' }] })
    expect(captions(parent)).toContain('checks not read')
    expect(captions(parent)).not.toContain('0/1 checks met')
  })

  it('shows a note instead of an empty check list before the goal is defined', () => {
    const parent = element()
    console_ui.render_goal_card(parent as any, { summary: 'No active goal.', note: 'Tell AIRI what to do in the prompt below.', read: false, met: 0, total: 0, checks: [] })
    expect(captions(parent)).toEqual(['Goal', 'No active goal.', 'Tell AIRI what to do in the prompt below.'])
    expect(find(parent, node => node.type === 'progressbar')).toEqual([])
  })

  it('shows the current step, slice progress, what is next and what is holding it', () => {
    const parent = element()
    console_ui.render_now_card(parent as any, {
      heading: 'Now · step 3 of 6 · 2 verified',
      step: 'Supply the silo with 500 low density structure',
      step_tone: 'info',
      progress: 2 / 6,
      show_progress: true,
      next: 'Next: Supply the silo with 500 rocket fuel · Supply the silo with 500 processing units · +1 more',
      attention: [{ caption: 'Paused: waiting for you', tone: 'warn' }],
      last: 'Last: Inserted 40 low-density-structure into rocket-silo',
      last_tone: 'good',
    })
    expect(captions(parent)).toEqual([
      'Now · step 3 of 6 · 2 verified',
      'Supply the silo with 500 low density structure',
      'Next: Supply the silo with 500 rocket fuel · Supply the silo with 500 processing units · +1 more',
      'Paused: waiting for you',
      'Last: Inserted 40 low-density-structure into rocket-silo',
    ])
  })
})
describe('goal block of the UI snapshot', () => {
  const base = { steps: [], activity: [] }

  it('keeps at most six checks and recounts met itself', () => {
    const checks = Array.from({ length: 9 }, (_, index) => ({ text: `check ${index}`, met: index < 3, progress: 'x' }))
    const snapshot = sanitize_task_board_ui_snapshot({ ...base, goal: { summary: 'Launch a rocket.', defined: true, read: true, met: 99, total: 99, checks } })
    expect(snapshot?.goal?.checks).toHaveLength(6)
    expect(snapshot?.goal?.total).toBe(6)
    expect(snapshot?.goal?.met).toBe(3)
  })

  it('drops a goal block without a summary and treats missing checks as undefined', () => {
    expect(sanitize_task_board_ui_snapshot({ ...base, goal: { summary: '', checks: [] } })?.goal).toBeUndefined()
    expect(sanitize_task_board_ui_snapshot({ ...base, goal: 'launch' })?.goal).toBeUndefined()
    const bare = sanitize_task_board_ui_snapshot({ ...base, goal: { summary: 'Follow me.', defined: true } })?.goal
    expect(bare).toEqual({ summary: 'Follow me.', defined: false, read: false, met: 0, total: 0, checks: [] })
  })
})

describe('console tabs', () => {
  const pages = (parent: FakeElement) => ['now', 'plan', 'activity'].map(tab => parent[`airi_task_board_tab_${tab}`] as FakeElement)
  const buttons = (parent: FakeElement) => (parent.airi_task_board_tab_bar as FakeElement).children

  it('builds a button and a page per tab and shows only the selected page', () => {
    const parent = element()
    const built = console_ui.render_console_tabs(parent as any, 'plan')
    expect(buttons(parent).map(button => button.caption)).toEqual(['NOW', 'PLAN', 'ACTIVITY'])
    expect(buttons(parent).map(button => button.toggled)).toEqual([false, true, false])
    expect(pages(parent).map(page => page.visible)).toEqual([false, true, false])
    expect(built.activity).toBe(parent.airi_task_board_tab_activity)
  })

  it('switches tabs by visibility alone, so page contents survive', () => {
    const parent = element()
    const built = console_ui.render_console_tabs(parent as any, 'now')
    const feed = (built.activity as unknown as FakeElement).add({ type: 'scroll-pane', name: 'feed' })
    expect(console_ui.apply_console_tab(parent as any, 'activity')).toBe(true)
    expect(pages(parent).map(page => page.visible)).toEqual([false, false, true])
    expect(buttons(parent).map(button => button.toggled)).toEqual([false, false, true])
    expect(feed.valid).toBe(true)
    expect(parent.airi_task_board_tab_activity.feed).toBe(feed)
  })

  it('reports a console without tabs so the caller rebuilds it', () => {
    expect(console_ui.apply_console_tab(element() as any, 'now')).toBe(false)
  })

  it('accepts only known tab names from tags or storage', () => {
    expect(console_ui.console_tab_of('activity')).toBe('activity')
    expect(console_ui.console_tab_of('debug')).toBeUndefined()
    expect(console_ui.console_tab_of(2)).toBeUndefined()
  })
})
