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
function parseDsml(content, limits = {}) {
  const fail = reason => ({ reason })
  const maxChars = limits.maxChars ?? DSML_MAX_CHARS
  const maxCalls = limits.maxCalls ?? DSML_MAX_CALLS
  const maxParameters = limits.maxParameters ?? DSML_MAX_PARAMETERS
  if (typeof content !== 'string' || content.length === 0 || content.length > maxChars) return fail('content_empty_or_too_long')

  const tags = [...content.matchAll(new RegExp(TAG.source, 'g'))]
  if (tags.length < 2) return fail('too_few_tags')
  const first = tags[0]
  if (first[1] !== undefined || first[2] !== 'calls' || !isBlank(first[3])) return fail('does_not_open_with_calls_tag')

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
      if (!closing || kind !== 'parameter') return fail('parameter_not_closed')
      if (!isBlank(tag[3])) return fail('parameter_close_tag_has_attributes')
      let value
      if (parameter.isString === 'false') {
        try { value = JSON.parse(between.trim()) }
        catch { return fail('parameter_value_not_json') }
      }
      else {
        value = between
      }
      invoke.args[parameter.key] = value
      state = 'invoke'
    }
    else if (state === 'invoke') {
      if (!isBlank(between)) return fail('text_between_invoke_children')
      if (closing) {
        if (kind !== 'invoke' || !isBlank(tag[3])) return fail('invoke_closed_by_other_tag')
        calls.push(invoke)
        invoke = undefined
        state = 'calls'
        if (calls.length > maxCalls) return fail('too_many_calls')
      }
      else {
        // Live 2026-10-01 (OpenRouter, deepseek-v4-flash): the call's arguments written as
        // nested <invoke name="k">v</invoke> elements instead of parameter elements.
        if (kind !== 'parameter') return fail(kind === 'invoke' ? 'invoke_nested_in_invoke' : 'unexpected_tag_in_invoke')
        const attrs = PARAMETER_ATTRS.exec(tag[3])
        if (!attrs || !NAME.test(attrs[1]) || FORBIDDEN_KEYS.has(attrs[1])) return fail('parameter_attributes_invalid')
        if (Object.hasOwn(invoke.args, attrs[1])) return fail('parameter_duplicated')
        if (Object.keys(invoke.args).length >= maxParameters) return fail('too_many_parameters')
        parameter = { key: attrs[1], isString: attrs[2] }
        state = 'parameter'
      }
    }
    else if (state === 'calls') {
      if (!isBlank(between)) return fail('text_between_calls')
      if (closing) {
        if (kind !== 'calls' || !isBlank(tag[3])) return fail('calls_closed_by_other_tag')
        // Anything after the closing calls tag is deliberately discarded.
        state = 'done'
        end = tagEnd
        break
      }
      if (kind !== 'invoke') return fail('unexpected_tag_in_calls')
      const attrs = INVOKE_ATTRS.exec(tag[3])
      if (!attrs || !NAME.test(attrs[1])) return fail('invoke_attributes_invalid')
      invoke = { name: attrs[1], args: Object.create(null) }
      state = 'invoke'
    }
    cursor = tagEnd
  }

  if (state !== 'done' || end < 0 || calls.length === 0) return fail('calls_block_not_closed')
  return {
    content: content.slice(0, first.index).trim(),
    calls: calls.map(call => ({ name: call.name, args: { ...call.args } })),
  }
}

export function parseDsmlToolCalls(content, limits = {}) {
  const parsed = parseDsml(content, limits)
  return parsed.calls ? parsed : undefined
}

// Any DSML-prefixed tag at all, known or not (group 1: its name).
const ANY_DSML_TAG = /<\s*\/?\s*[｜|]{1,4}\s*DSML\s*[｜|]{1,4}\s*([A-Z_][\w.-]*)/gi
const KNOWN_TAGS = new Set(['calls', 'invoke', 'parameter'])

/**
 * Why markup that carries DSML tags did not parse, as a named code, or
 * undefined when the text has no DSML tags at all or does parse. Diagnosis
 * only: nothing is repaired or guessed from a malformed block. A tag name the
 * strict parser does not know (live 2026-10-01: a tool_calls container) is
 * named first, then the structural reason found when that one tag is read as
 * the calls container (for this diagnosis only), joined with a plus sign.
 */
export function diagnoseDsmlRejection(content) {
  if (typeof content !== 'string') return undefined
  const names = [...content.matchAll(ANY_DSML_TAG)].map(match => match[1])
  if (names.length === 0) return undefined
  const parsed = parseDsml(content)
  if (parsed.calls) return undefined
  const unknown = names.find(name => !KNOWN_TAGS.has(name))
  if (!unknown) return parsed.reason
  const named = `unrecognized_tag_${unknown}`
  if (unknown !== 'tool_calls') return named
  const asCalls = content.replace(/(DSML\s*[｜|]{1,4}\s*)tool_calls/g, '$1calls')
  const structural = parseDsml(asCalls)
  return !structural.calls && structural.reason ? `${named}+${structural.reason}` : named
}
