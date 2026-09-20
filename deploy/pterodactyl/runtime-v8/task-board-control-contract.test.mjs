import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { parseUiControlLine } from './supervisor.mjs'

const autorioTaskBoardUrl = new URL('../../../packages/autorio/src/task_board_ui.ts', import.meta.url)

function declaredControlActions(source) {
  const match = source.match(/type TaskBoardUiControlAction = ([^\n]+)/)
  assert.ok(match, 'TaskBoardUiControlAction declaration is missing')
  return [...match[1].matchAll(/'([^']+)'/g)].map(entry => entry[1])
}

function uiControlLine(action) {
  return `[AIRI_UI_CONTROL] ${JSON.stringify({
    version: 1,
    action,
    player_index: 1,
    player_name: 'ContractTester',
    tick: 123,
  })}`
}

test('runtime accepts every Task Board control action declared by Autorio', async () => {
  const source = await readFile(autorioTaskBoardUrl, 'utf8')
  const actions = declaredControlActions(source)

  assert.deepEqual(actions, ['pause', 'terminate', 'follow', 'stop_follow', 'new_task', 'keep_paused', 'revise', 'cancel'])
  for (const action of actions) {
    assert.equal(parseUiControlLine(uiControlLine(action))?.action, action, `runtime rejected Autorio control action: ${action}`)
  }
})
