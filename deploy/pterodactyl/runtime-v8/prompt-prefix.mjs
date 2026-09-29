// Prompt prefix layout (work plan item 2.9).
//
// Provider prompt caches reuse the longest identical prefix of the previous
// request. The layout rule, for every role and every provider:
//
//   [tools][system][request context ...][stored history ...] | [TAIL]
//                                                              ^ declared breakpoint
//
// - The tool block and the system message come first and are identical across
//   rounds and across agents of the same role. Closing tools for a round does
//   NOT remove the tool block on providers that honour tool_choice "none"
//   (see provider-base.mjs, `tools_kept_when_closed`); removing it changed the
//   prefix from its first token and cost the recovery rounds of the steam run
//   about half of their cache hit (0% and 53%; the round before hit 91%).
// - Everything the harness recomputes per round is TAIL: the steering
//   context, the skill offers block, and the trailing [MOD]/[HARNESS]
//   instruction the round answers. None of it is stored in the working
//   history, so the next round's prompt starts with the previous round's
//   stable region unchanged.
// - Dynamic blocks are never put in front of stored history. (Loaded skill
//   context is the one deliberate exception: it lives for a whole logical
//   task, so in the fixed prefix it is cached across many rounds and requests
//   and changes only when a skill is loaded.)
// - Compaction folds older tool exchanges into one growing
//   "[OBSERVATIONS COMPACTED]" message. It only appends to that digest, so the
//   prompt up to the digest's previous end is still shared; the round pays for
//   the newest exchange, not for the whole history.
//
// Anthropic models reuse a prefix only up to an explicit breakpoint; the
// breakpoints go where the stable prefix ends (the system message, and the
// end of the request context). Other providers cache automatically and use
// the same layout without markers.

import { createHash } from 'node:crypto'

// Blocks the harness recomputes for every round and never stores in the
// working history: skill offers, the decision envelope and planning outline
// guidance (npc-agent-loop.mjs callProvider), and steering (provider-base.mjs).
export const TAIL_MARKERS = Object.freeze(['[SKILL_OFFERS]', '[DECISION_ENVELOPE]', '[PLANNING_LOD]', '[STEERING]'])
// The tail blocks that round-type detection looks past. The decision envelope
// and outline guidance were always the "last user message" and stay so.
const DETECTION_SKIPPED_MARKERS = Object.freeze(['[SKILL_OFFERS]', '[STEERING]'])
const TERMINAL_MARKERS = Object.freeze(['[MOD]', '[HARNESS]'])
const DIGEST_MARKER = '[OBSERVATIONS COMPACTED]'

function textOf(message) {
  return typeof message?.content === 'string' ? message.content : ''
}

export function isTailBlock(message) {
  return message?.role === 'user' && TAIL_MARKERS.some(marker => textOf(message).startsWith(marker))
}

// The instruction the round answers ([MOD] receipt, [HARNESS] pressure). It
// stays last, so tail blocks are placed just before it.
export function isTerminalInstruction(message) {
  return message?.role === 'user' && TERMINAL_MARKERS.some(marker => textOf(message).startsWith(marker))
}

// A copy of `messages` with `block` (a user message) in the tail: before a
// trailing terminal instruction, else last.
export function insertTailBlock(messages, block) {
  const output = Array.isArray(messages) ? [...messages] : []
  if (!block) return output
  if (isTerminalInstruction(output.at(-1))) output.splice(output.length - 1, 0, block)
  else output.push(block)
  return output
}

// The last user message that is part of the request, looking past the skill
// offers and steering blocks. Round-type detection (a batch-completion
// continuation, for instance) must not change because one of them moved to
// the tail.
export function lastUserOutsideTail(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'user' && !DETECTION_SKIPPED_MARKERS.some(marker => textOf(message).startsWith(marker))) return message
  }
  return undefined
}

// Index where the tail starts: the first tail block, else the trailing
// terminal instruction (tail blocks go in front of it), else the end.
export function tailStart(messages) {
  if (!Array.isArray(messages)) return 0
  const first = messages.findIndex(isTailBlock)
  if (first >= 0) return first
  return isTerminalInstruction(messages.at(-1)) ? messages.length - 1 : messages.length
}

// The request-stable region: the system message and the user context that
// precedes the first model turn or working marker.
function requestContextEnd(messages, end) {
  let last = -1
  for (let index = 0; index < end; index++) {
    const message = messages[index]
    const workingMarker = message?.role === 'user' && (textOf(message).startsWith(DIGEST_MARKER) || isTerminalInstruction(message))
    if ((message?.role === 'system' || message?.role === 'user') && !workingMarker) last = index
    else break
  }
  return last
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 12)
}

function canonical(message) {
  return JSON.stringify([message?.role, message?.content ?? null, message?.tool_calls ?? null, message?.tool_call_id ?? null])
}

// Where the layout puts the tail and the breakpoints for one prompt, with
// short hashes of each region so a trace can show what changed. `tools` is the
// tool array sent with the request (undefined or empty when none is sent).
export function promptLayout(messages, { tools } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const tail = tailStart(list)
  const system = list.findIndex(message => message?.role === 'system')
  const contextEnd = requestContextEnd(list, tail)
  const stable = list.slice(0, tail)
  return {
    stable_messages: tail,
    tail_messages: list.length - tail,
    tail_markers: list.slice(tail).flatMap(message => TAIL_MARKERS.filter(marker => isTailBlock(message) && textOf(message).startsWith(marker))),
    system_index: system,
    request_context_end: contextEnd,
    tools_key: Array.isArray(tools) && tools.length > 0 ? hash(tools) : 'none',
    system_key: system >= 0 ? hash(canonical(list[system])) : 'none',
    context_key: contextEnd >= 0 ? hash(list.slice(0, contextEnd + 1).map(canonical)) : 'none',
    prefix_key: hash([Array.isArray(tools) && tools.length > 0 ? hash(tools) : 'none', ...stable.map(canonical)]),
  }
}

// Explicit cache breakpoints for providers that only cache at markers
// (Anthropic): the end of the system message (the tool block and system
// message are the role-stable prefix) and the end of the request context.
export function cacheBreakpointIndexes(messages) {
  const layout = promptLayout(messages)
  const wanted = [layout.system_index, layout.request_context_end]
  return [...new Set(wanted)]
    .filter(index => index >= 0 && (messages[index]?.role === 'system' || messages[index]?.role === 'user') && typeof messages[index].content === 'string' && messages[index].content.trim())
    .sort((a, b) => a - b)
}

export function sharedPrefixMessages(previous, next) {
  const limit = Math.min(previous?.length ?? 0, next?.length ?? 0)
  let index = 0
  while (index < limit && canonical(previous[index]) === canonical(next[index])) index++
  return index
}

// Why a round's prompt stopped matching the previous round's. `previous` and
// `next` are { messages, tools }.
//   tail_only           the shared prefix reaches the previous round's tail (the
//                       only change is the new content: what the layout wants)
//   compaction          the previous exchange was folded into the digest
//   continuation_reset  a new continuation started from the request context
//                       (the loop drops the working history on purpose)
//   role_switch         another role's system message and tool block (compact
//                       completion <-> full planner)
//   tools_removed       one round sent a tool block and the other none (a
//                       defect: the prefix breaks from its first token)
//   tools_changed       the tool block differs under the same system message
//   tail_reorder        a tail block moved
//   history_rewrite     stored history changed before the tail (a defect)
export function classifyPrefixBreak(previous, next) {
  const before = previous?.messages ?? []
  const after = next?.messages ?? []
  const shared = sharedPrefixMessages(before, after)
  const previousTail = tailStart(before)
  const base = { shared_messages: shared, previous_stable_messages: previousTail }
  const toolsBefore = Array.isArray(previous?.tools) && previous.tools.length > 0 ? hash(previous.tools) : 'none'
  const toolsAfter = Array.isArray(next?.tools) && next.tools.length > 0 ? hash(next.tools) : 'none'
  const systemBefore = before.find(message => message?.role === 'system')
  const systemAfter = after.find(message => message?.role === 'system')
  if ((toolsBefore === 'none') !== (toolsAfter === 'none') && before.length > 0 && after.length > 0) return { ...base, reason: 'tools_removed' }
  if (systemBefore && systemAfter && canonical(systemBefore) !== canonical(systemAfter)) return { ...base, reason: 'role_switch' }
  if (toolsBefore !== toolsAfter) return { ...base, reason: 'tools_changed' }
  if (shared >= previousTail) return { ...base, reason: 'tail_only' }
  const at = after[shared]
  // A fold at the digest's size cap leaves the digest unchanged and drops the
  // folded exchange, so the change shows up right after it.
  if (textOf(at).startsWith(DIGEST_MARKER) || textOf(before[shared]).startsWith(DIGEST_MARKER) || textOf(after[shared - 1]).startsWith(DIGEST_MARKER)) return { ...base, reason: 'compaction' }
  if (isTailBlock(at) || isTailBlock(before[shared]) || isTerminalInstruction(at) || isTerminalInstruction(before[shared])) return { ...base, reason: 'tail_reorder' }
  if (shared === requestContextEnd(before, previousTail) + 1) return { ...base, reason: 'continuation_reset' }
  return { ...base, reason: 'history_rewrite' }
}
