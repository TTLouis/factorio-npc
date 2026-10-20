import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONVERSATION_SWAP_SITES,
  LOOP_STATE_FIELDS,
  LOOP_STATE_SOURCES,
  STATE_SCOPES,
  conversationResetMatrix,
  countsByScope,
  findMethodBody,
  readLoopSources,
  scanLoopFields,
  stripCommentsAndStrings,
} from './state-scopes.mjs'

const sources = readLoopSources()
const scanned = scanLoopFields(sources)

test('every field assigned on the loop is declared in LOOP_STATE_FIELDS', () => {
  const missing = []
  for (const [owner, names] of Object.entries(scanned)) {
    for (const name of names) if (!Object.hasOwn(LOOP_STATE_FIELDS, name)) missing.push(`${name} (${owner})`)
  }
  assert.deepEqual(missing, [], `fields without a scope: ${missing.join(', ')}; declare its scope in state-scopes.mjs`)
})

test('every registry key is still assigned in its owner source', () => {
  const stale = []
  for (const [name, entry] of Object.entries(LOOP_STATE_FIELDS)) {
    if (!Object.hasOwn(LOOP_STATE_SOURCES, entry.owner)) stale.push(`${name}: unknown owner ${entry.owner}`)
    else if (!scanned[entry.owner].has(name)) stale.push(`${name}: not assigned in ${entry.owner}`)
  }
  assert.deepEqual(stale, [], `stale registry entries: ${stale.join('; ')}`)
})

test('registry entries are well formed', () => {
  for (const [name, entry] of Object.entries(LOOP_STATE_FIELDS)) {
    assert.ok(STATE_SCOPES.includes(entry.scope), `${name}: unknown scope ${entry.scope}`)
    assert.equal(typeof entry.model_visible, 'boolean', `${name}: model_visible must be boolean`)
    assert.equal(typeof entry.note, 'string', `${name}: note must be a string`)
    assert.ok(entry.note.trim().length > 0, `${name}: note must not be empty`)
  }
  assert.ok(Object.isFrozen(STATE_SCOPES) && Object.isFrozen(LOOP_STATE_FIELDS))
})

test('every conversation swap site exists in its owner source', () => {
  const stripped = Object.fromEntries(Object.entries(sources).map(([owner, text]) => [owner, stripCommentsAndStrings(text)]))
  const absent = CONVERSATION_SWAP_SITES.filter(site => stripped[site.owner] === undefined
    || findMethodBody(stripped[site.owner], site.site, { owner: site.owner, fn: site.fn === true }) === null)
  assert.deepEqual(absent.map(site => `${site.owner}#${site.site}`), [])
  for (const required of ['restageContext', 'returnControlToPlanner', 'refreshPlanningReasoningEpoch', 'prepareContinuationContext', 'completed', 'applyStartRestage', 'recoverPlanRoute', 'compactWorkingContext', 'reset']) {
    assert.ok(CONVERSATION_SWAP_SITES.some(site => site.site === required), `missing swap site ${required}`)
  }
})

test('the swap sites assign or swap the conversation (the method bodies prove it)', () => {
  // A listed site must really touch the conversation, or the list drifted from the code.
  const stripped = Object.fromEntries(Object.entries(sources).map(([owner, text]) => [owner, stripCommentsAndStrings(text)]))
  const touches = /\b(?:this|agent)\.(?:messages|baseMessages)\b|agentContext\.(?:commitRestage|resumePlanner|beginLineage)\(|replaceConversation\(|prepareContinuationContext\(|super\.reset\(\)|restageInTurn\(|restageBetweenTurns\(/
  for (const site of CONVERSATION_SWAP_SITES) {
    const body = findMethodBody(stripped[site.owner], site.site, { owner: site.owner, fn: site.fn === true })
    assert.match(body, touches, `${site.owner}#${site.site} does not touch the conversation`)
  }
})

test('conversation reset matrix: one row per swap site (report, not a gate)', (t) => {
  const rows = conversationResetMatrix(sources)
  assert.equal(rows.length, CONVERSATION_SWAP_SITES.length)
  for (const row of rows) {
    assert.equal(row.error, undefined, `${row.owner}#${row.site}: ${row.error}`)
    assert.ok(Array.isArray(row.resets) && Array.isArray(row.missing))
    assert.equal(row.resets.length + row.missing.length, new Set([...row.resets, ...row.missing]).size)
  }
  const restage = rows.find(row => row.site === 'restageContext')
  assert.ok(restage.resets.includes('messages') && restage.resets.includes('toolCache'), 'restageContext swaps messages and clears toolCache')
  const counts = countsByScope()
  t.diagnostic(`fields by scope: ${STATE_SCOPES.map(scope => `${scope}=${counts[scope].total}`).join(' ')}`)
  for (const row of rows) {
    if (row.missing_model_visible.length > 0) t.diagnostic(`${row.owner}#${row.site} (${row.kind}) leaves model-visible state: ${row.missing_model_visible.join(', ')}`)
  }
})

test('scanLoopFields ignores strings, other classes and counts compound assignments', () => {
  const snippet = [
    'class Other {',
    '  constructor() { this.otherField = 1 }',
    '}',
    'export class NpcAgentLoop extends Base {',
    '  constructor() {',
    '    this.a = 1',
    '    this.note = "this.inString = 1"',
    '    this.tpl = `this.inTemplate = ${this.fromExpr = 2} text`', // eslint-disable-line no-template-curly-in-string
    '    // this.inComment = 1',
    '  }',
    '  tick() {',
    '    this.b ??= new Map()',
    '    this.c ||= []',
    '    this.d += 1',
    '    this.count++',
    '    --this.left',
    '    if (this.a == 2 || this.a === 3) return',
    '    const same = () => this.a',
    '  }',
    '}',
    'function later() { this.afterClass = 1 }',
  ].join('\n')
  const found = scanLoopFields({ 'runtime-v8/npc-agent-loop': snippet })['runtime-v8/npc-agent-loop']
  assert.deepEqual([...found].sort(), ['a', 'b', 'c', 'count', 'd', 'fromExpr', 'left', 'note', 'tpl'])
})

test('scanLoopFields does not read a postfix ++ at a line end as a prefix of the next line', () => {
  const snippet = 'class NpcAgentLoop {\n  go() {\n    this.n++\n    this.next()\n  }\n}\n'
  assert.deepEqual([...scanLoopFields({ 'runtime-v8/npc-agent-loop': snippet })['runtime-v8/npc-agent-loop']], ['n'])
})

test('external owners are scanned by receiver over the whole file', () => {
  const adapter = 'function ensure(loop) {\n  loop.cache ??= new Map()\n  other.skip = 1\n}\nproto.request = function () { this.reset = 1 }\n'
  const found = scanLoopFields({ 'runtime-v8/supervisor-adapter': adapter })['runtime-v8/supervisor-adapter']
  assert.deepEqual([...found].sort(), ['cache', 'reset'])
})

test('findMethodBody resolves a method body by brace matching', () => {
  const text = stripCommentsAndStrings('class NpcAgentLoop {\n  async run({ a, b } = {}) {\n    if (a) { this.x = 1 }\n    return "}"\n  }\n  other() { this.y = 2 }\n}\n')
  const body = findMethodBody(text, 'run', { owner: 'runtime-v8/npc-agent-loop' })
  assert.match(body, /this\.x = 1/)
  assert.doesNotMatch(body, /this\.y/)
})

test('reset matrix: a restage wrapper credits delegated resets, and the refused path is reported apart', () => {
  const rows = conversationResetMatrix(sources)
  const start = rows.find(row => row.site === 'applyStartRestage')
  assert.ok(start.delegated.includes('toolCache'), 'applyStartRestage reaches restageContext, which clears toolCache')
  assert.ok(start.missing_if_restage_refused.includes('toolCache'), 'a refused restage keeps the old toolCache')
  const prefix = rows.find(row => row.site === 'runGuardedTurn')
  assert.ok(!prefix.resets.includes('toolCache'), 'the failure-path reset() of runGuardedTurn is not a prefix-rewrite reset')
})

test('conversationResetMatrix resolves helpers one level deep and ignores ??= initialisation', () => {
  const registry = {
    cache: { scope: 'conversation', model_visible: true, owner: 'runtime-v8/npc-agent-loop', note: 'x' },
    seen: { scope: 'conversation', model_visible: true, owner: 'runtime-v8/npc-agent-loop', note: 'x' },
    phase: { scope: 'decision', model_visible: true, owner: 'runtime-v8/npc-agent-loop', note: 'x' },
    quiet: { scope: 'decision', model_visible: false, owner: 'runtime-v8/npc-agent-loop', note: 'x' },
    other: { scope: 'request', model_visible: true, owner: 'runtime-v8/npc-agent-loop', note: 'x' },
  }
  const source = [
    'class NpcAgentLoop {',
    '  swap() {',
    '    this.cache.clear()',
    '    this.seen ??= new Set()',
    '    this.clearPhase()',
    '    this.other = 0',
    '  }',
    '  clearPhase() { this.phase = false }',
    '}',
  ].join('\n')
  const [row] = conversationResetMatrix({ 'runtime-v8/npc-agent-loop': source }, registry, [{ site: 'swap', owner: 'runtime-v8/npc-agent-loop', kind: 'test' }])
  assert.deepEqual(row.resets, ['cache', 'phase'])
  assert.deepEqual(row.missing, ['seen', 'quiet'])
  assert.deepEqual(row.missing_model_visible, ['seen'])
})
