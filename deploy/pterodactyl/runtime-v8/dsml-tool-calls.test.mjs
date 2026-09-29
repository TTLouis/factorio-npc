import assert from 'node:assert/strict'
import test from 'node:test'

import { DSML_MAX_CALLS, DSML_MAX_CHARS, parseDsmlToolCalls } from './dsml-tool-calls.mjs'

const O = '<｜｜DSML｜｜ '
const C = '</｜｜DSML｜｜ '

// The shape recorded live (2026-09-29, flash on a tools-off round).
const LIVE = [
  `${O}calls>`,
  `${O}invoke name="supply_entity">`,
  `${O}parameter name="unit_number" string="false">22${C}parameter>`,
  `${O}parameter name="items" string="false">[{"item_name": "wood", "count": 15}]${C}parameter>`,
  `${C}invoke>`,
  `${O}invoke name="gather_resource">`,
  `${O}parameter name="resource_name" string="true">coal${C}parameter>`,
  `${O}parameter name="count" string="false">20${C}parameter>`,
  `${C}invoke>`,
  `${C}calls>`,
].join('\n')

test('parses the live sample: JSON for string=false, plain strings otherwise', () => {
  const parsed = parseDsmlToolCalls(`Recovering.\n${LIVE}`)
  assert.equal(parsed.content, 'Recovering.')
  assert.deepEqual(parsed.calls, [
    { name: 'supply_entity', args: { unit_number: 22, items: [{ item_name: 'wood', count: 15 }] } },
    { name: 'gather_resource', args: { resource_name: 'coal', count: 20 } },
  ])
})

test('accepts an invoke without parameters and a parameter without a string attribute (string)', () => {
  const parsed = parseDsmlToolCalls(`${O}calls>${O}invoke name="getInventoryItems">${C}invoke>${C}calls>`)
  assert.deepEqual(parsed.calls, [{ name: 'getInventoryItems', args: {} }])
  const text = parseDsmlToolCalls(`${O}calls>${O}invoke name="a">${O}parameter name="k">v${C}parameter>${C}invoke>${C}calls>`)
  assert.deepEqual(text.calls[0].args, { k: 'v' })
})

test('rejects malformed structure instead of repairing it', () => {
  const bad = [
    'no markup at all',
    LIVE.replace(`${C}calls>`, ''),
    LIVE.replace(`${C}invoke>`, ''),
    LIVE.replace('[{"item_name": "wood", "count": 15}]', '[{"item_name": '),
    LIVE.replace('name="unit_number"', 'nam="unit_number"'),
    LIVE.replace(`${O}invoke name="gather_resource">`, `stray words${O}invoke name="gather_resource">`),
    `${O}calls>${O}invoke name="a">${O}parameter name="k">1${C}invoke>${C}calls>`,
    `${O}calls>${C}calls>`,
    `${O}calls>${O}invoke name="a b">${C}invoke>${C}calls>`,
    `${O}calls>${O}invoke name="a">${O}parameter name="__proto__" string="false">{}${C}parameter>${C}invoke>${C}calls>`,
    `${O}calls>${O}invoke name="a">${O}parameter name="k">1${C}parameter>${O}parameter name="k">2${C}parameter>${C}invoke>${C}calls>`,
    `${O}calls>${O}calls>${C}calls>`,
  ]
  for (const text of bad) assert.equal(parseDsmlToolCalls(text), undefined, text.slice(0, 60))
})

test('is bounded: total size, call count, parameter count', () => {
  assert.equal(parseDsmlToolCalls(`${LIVE}${' '.repeat(DSML_MAX_CHARS)}`), undefined)
  const many = n => `${O}calls>${Array.from({ length: n }, () => `${O}invoke name="a">${C}invoke>`).join('')}${C}calls>`
  assert.equal(parseDsmlToolCalls(many(DSML_MAX_CALLS)).calls.length, DSML_MAX_CALLS)
  assert.equal(parseDsmlToolCalls(many(DSML_MAX_CALLS + 1)), undefined)
  const params = n => `${O}calls>${O}invoke name="a">${Array.from({ length: n }, (_, i) => `${O}parameter name="k${i}">x${C}parameter>`).join('')}${C}invoke>${C}calls>`
  assert.ok(parseDsmlToolCalls(params(32)))
  assert.equal(parseDsmlToolCalls(params(33)), undefined)
})

test('does not execute anything: values are data', () => {
  const parsed = parseDsmlToolCalls(`${O}calls>${O}invoke name="a">${O}parameter name="k" string="false">"process.exit(1)"${C}parameter>${C}invoke>${C}calls>`)
  assert.equal(parsed.calls[0].args.k, 'process.exit(1)')
  assert.equal(parseDsmlToolCalls(`${O}calls>${O}invoke name="a">${O}parameter name="k" string="false">process.exit(1)${C}parameter>${C}invoke>${C}calls>`), undefined)
})

test('the pipe-and-spacing variants the model has emitted still parse', () => {
  const text = '<|DSML|calls><|DSML|invoke name="a"><|DSML|parameter name="k" string="false">1</|DSML|parameter></|DSML|invoke></|DSML|calls>'
  assert.deepEqual(parseDsmlToolCalls(text).calls, [{ name: 'a', args: { k: 1 } }])
})
