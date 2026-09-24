import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('SGLuna debug layout', () => {
  it('keeps context and errors full width while splitting dense diagnostics into three columns', () => {
    const source = readFileSync(new URL('./task_board_debug_render.ts', import.meta.url), 'utf8')

    expect(source).toContain('const DEBUG_COLUMN_WIDTH')
    expect(source).toContain("caption: 'LLM / Provider'")
    expect(source).toContain("caption: 'Jev / Planning'")
    expect(source).toContain("caption: 'Step / Runtime'")
    expect(source).toContain('(DEBUG_BODY_INNER_WIDTH - 2 * DEBUG_COLUMN_GAP) / 3')
    expect(source).toContain("add_row(overview, 'AI reply'")
    expect(source).toContain("add_compact_row(provider_table, 'Tokens · request cumulative'")
    expect(source).toContain('add_debug_decision_rows(decision_table, debug)')
    expect(source).toContain("add_compact_row(table, 'Jev health'")
    expect(source).toContain("add_compact_row(table, 'Jev last fallback'")
    expect(source).toContain("add_compact_row(table, 'Jev scope review'")
    expect(source).toContain("add_compact_row(table, 'Scope review packet'")
    expect(source).toContain("add_compact_row(table, 'Scope review failure'")
    expect(source).toContain('add_debug_step_rows(runtime_table, debug)')
    expect(source).toContain("add_compact_row(runtime_table, 'Response id'")
    expect(source).toContain("add_compact_row(runtime_table, 'Response bytes · tools'")
    expect(source).toContain("add_compact_row(runtime_table, 'Content shape'")
    expect(source).toContain("add_compact_row(runtime_table, 'Structured content'")
    expect(source).toContain("add_compact_row(runtime_table, 'Structured error'")
    expect(source).not.toContain('content_preview')
    expect(source).toContain("add_row(errors, 'Decision error'")
    expect(source).toContain("add_row(errors, 'Last error'")
    expect(source).toContain('build_debug_activity(root)')
  })
})
