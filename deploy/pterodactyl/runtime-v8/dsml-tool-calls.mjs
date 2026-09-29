// Strict, bounded parser for DeepSeek's native tool-call markup when it leaks
// into `content` (live: `<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="x">
// <｜｜DSML｜｜ parameter name="k" string="false">...`). Only the calls ->
// invoke -> parameter structure is accepted; parameter values are JSON when
// string="false" and plain strings otherwise. No eval, no lenient repair:
// anything that is not exactly that structure returns undefined so the caller
// falls back to its normal format recovery.

export const DSML_MAX_CHARS = 65536
export const DSML_MAX_CALLS = 16
export const DSML_MAX_PARAMETERS = 32

const NAME = /^[A-Za-z_][\w.-]{0,63}$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// group 1: closing slash, 2: tag kind, 3: attribute text
const TAG = /<(\s*\/)?\s*[｜|]{1,4}\s*DSML\s*[｜|]{1,4}\s*(calls|invoke|parameter)([^<>]*)>/g
const INVOKE_ATTRS = /^\s+name="([^"]*)"\s*$/
const PARAMETER_ATTRS = /^\s+name="([^"]*)"(?:\s+string="(true|false)")?\s*$/

function isBlank(text) {
  return text.trim() === ''
}

/**
 * @param {unknown} content
 * @param {{ maxChars?: number, maxCalls?: number, maxParameters?: number }} [limits]
 * @returns {{ content: string, calls: Array<{ name: string, args: Record<string, unknown> }> } | undefined}
 *   `content` is the text before the calls block, trimmed.
 */
export function parseDsmlToolCalls(content, limits = {}) {
  const maxChars = limits.maxChars ?? DSML_MAX_CHARS
  const maxCalls = limits.maxCalls ?? DSML_MAX_CALLS
  const maxParameters = limits.maxParameters ?? DSML_MAX_PARAMETERS
  if (typeof content !== 'string' || content.length === 0 || content.length > maxChars) return undefined

  const tags = [...content.matchAll(new RegExp(TAG.source, 'g'))]
  if (tags.length < 2) return undefined
  const first = tags[0]
  if (first[1] !== undefined || first[2] !== 'calls' || !isBlank(first[3])) return undefined

  const calls = []
  let state = 'calls' // calls | invoke | parameter | done
  let invoke
  let parameter
  let cursor = first.index + first[0].length
  let end = -1

  for (let index = 1; index < tags.length; index++) {
    const tag = tags[index]
    const closing = tag[1] !== undefined
    const kind = tag[2]
    const between = content.slice(cursor, tag.index)
    const tagEnd = tag.index + tag[0].length

    if (state === 'parameter') {
      if (!closing || kind !== 'parameter') return undefined
      if (!isBlank(tag[3])) return undefined
      let value
      if (parameter.isString === 'false') {
        try { value = JSON.parse(between.trim()) }
        catch { return undefined }
      }
      else {
        value = between
      }
      invoke.args[parameter.key] = value
      state = 'invoke'
    }
    else if (state === 'invoke') {
      if (!isBlank(between)) return undefined
      if (closing) {
        if (kind !== 'invoke' || !isBlank(tag[3])) return undefined
        calls.push(invoke)
        invoke = undefined
        state = 'calls'
        if (calls.length > maxCalls) return undefined
      }
      else {
        if (kind !== 'parameter') return undefined
        const attrs = PARAMETER_ATTRS.exec(tag[3])
        if (!attrs || !NAME.test(attrs[1]) || FORBIDDEN_KEYS.has(attrs[1])) return undefined
        if (Object.hasOwn(invoke.args, attrs[1])) return undefined
        if (Object.keys(invoke.args).length >= maxParameters) return undefined
        parameter = { key: attrs[1], isString: attrs[2] }
        state = 'parameter'
      }
    }
    else if (state === 'calls') {
      if (!isBlank(between)) return undefined
      if (closing) {
        if (kind !== 'calls' || !isBlank(tag[3])) return undefined
        // Anything after the closing calls tag is deliberately discarded.
        state = 'done'
        end = tagEnd
        break
      }
      if (kind !== 'invoke') return undefined
      const attrs = INVOKE_ATTRS.exec(tag[3])
      if (!attrs || !NAME.test(attrs[1])) return undefined
      invoke = { name: attrs[1], args: Object.create(null) }
      state = 'invoke'
    }
    cursor = tagEnd
  }

  if (state !== 'done' || end < 0 || calls.length === 0) return undefined
  return {
    content: content.slice(0, first.index).trim(),
    calls: calls.map(call => ({ name: call.name, args: { ...call.args } })),
  }
}
