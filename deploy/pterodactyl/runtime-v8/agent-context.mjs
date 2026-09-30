// Agent context and the restage seam (delegation plan U4, design note sections
// 4 and 10).
//
// One AgentContext per NpcAgentLoop: it holds the conversation the loop is
// running (`messages`, `baseMessages`), the role that conversation runs as, the
// `handoff_id` that names it, per-conversation counters and the size counter the
// restage policy reads. Exactly one conversation is active at a time. A restage
// swaps that conversation for a fresh one built from a handoff packet and gives
// it a new `handoff_id`; anything still in flight for the old id is stale.
//
// Pure: no I/O, no clock. The loop owns the effects (reducer dispatch, trace
// rows, counter resets outside this object); see NpcAgentLoop.restageContext.
//
// Byte-identical default. `role` and `handoff_id` appear on provider trace rows
// and `role` on the provider context ONLY once the current conversation lineage
// has restaged at least once (`delegationActive`). A run that never restages
// writes exactly the rows and sends exactly the requests it did before this
// module existed. A lineage is one chat request's conversation; the loop starts
// a new lineage on every reset, so a new request is unrestaged again. The
// initial conversation's handoff id (`ho_initial_<n>`) exists so a reply that
// outlives a restage can be recognised and dropped; it is written to a row only
// for such a stale reply. A reply that outlives a reset (a new lineage) is left
// to the loop's generation check, as before.

import { AGENT_ROLES, PLANNER_ROLE, resolveAgentRole } from './agent-roles.mjs'
import { CONTEXT_RESTAGE_CHECKPOINTS } from './planning-state.mjs'
import { contextSizeState, observeContextSize } from './restage-policy.mjs'

export const INITIAL_HANDOFF_PREFIX = 'ho_initial_'
// Same message the loop's other cancellation paths use, so the existing
// /cancelled|superseded/ handling treats a dropped stale reply as a cancelled
// turn, never as a provider failure.
export const STALE_REPLY_MESSAGE = 'Model turn was cancelled or superseded'
export const STALE_REPLY_ERROR_CODE = 'stale_handoff_reply'
export const STALE_REPLY_REASON = 'handoff_superseded'

function finiteNonNegative(value) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

// Same formula as the loop's and the base loop's messageChars.
export function messageChars(message) {
  return String(message?.content ?? '').length + JSON.stringify(message?.tool_calls ?? '').length
}

export function conversationChars(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => total + messageChars(message), 0)
}

function freshCounters() {
  return { requests: 0, replies: 0, input_tokens: 0, output_units: 0, last_input_tokens: 0 }
}

function copyMessages(messages) {
  return messages.map(message => ({ ...message }))
}

function leadingSystemMessages(messages) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'system') break
    out.push(message)
  }
  return out
}

export class AgentContext {
  /**
   * @param {object} [options]
   * @param {object} [options.config] provider config (`models`, `base`, ...); only used to name `model`
   * @param {'planner'|'executor'} [options.role]
   */
  constructor({ config, role = PLANNER_ROLE } = {}) {
    this.config = config
    this.messages = []
    this.baseMessages = []
    this.lineageSequence = 0
    this.beginLineage(role)
  }

  /**
   * Start a fresh conversation lineage (a chat request begins from scratch).
   * Nothing has restaged; delegation attribution is off until the first
   * restage. The handoff id changes so a reply still in flight for the
   * previous lineage is stale.
   */
  beginLineage(role = this.role ?? PLANNER_ROLE) {
    if (!AGENT_ROLES.includes(role)) throw new RangeError(`agent role must be one of ${AGENT_ROLES.join(', ')}`)
    this.role = role
    this.handoffId = `${INITIAL_HANDOFF_PREFIX}${++this.lineageSequence}`
    this.restageCount = 0
    this.resetCounters()
  }

  resetCounters() {
    this.counters = freshCounters()
    this.size = contextSizeState()
    this.requestCharsHighWater = 0
  }

  /** Model the current role runs on (agent-roles.mjs); undefined without a provider config. */
  get model() {
    return this.config ? resolveAgentRole(this.config, this.role).model : undefined
  }

  get delegationActive() {
    return this.restageCount > 0
  }

  /**
   * Restage-policy size counter, in tokens: monotonic since the last restage;
   * the larger of provider-reported input tokens of any request and chars/4 of
   * the growth seen so far (so it is meaningful before the first reply).
   */
  get sizeTokens() {
    return this.size.tokens
  }

  // --- requests and replies -------------------------------------------------------------

  /**
   * Call before a provider request. `requestChars` is the size of the messages
   * about to be sent. Returns the attribution to hold for that request; hand it
   * back to isStale / traceFields / observeReply.
   */
  beginRequest(requestChars) {
    const chars = finiteNonNegative(requestChars)
    const grown = Math.max(0, chars - this.requestCharsHighWater)
    this.requestCharsHighWater = Math.max(this.requestCharsHighWater, chars)
    this.size = observeContextSize(this.size, { appendedChars: grown })
    this.counters.requests += 1
    return Object.freeze({ role: this.role, handoffId: this.handoffId, lineage: this.lineageSequence, delegated: this.delegationActive })
  }

  /**
   * True when a restage has replaced the request's conversation since it was
   * sent. A reply that outlives a whole lineage (the loop was reset for a new
   * request) is not judged here: the loop's generation check already fails it,
   * exactly as before restaging existed.
   */
  isStale(attribution) {
    return !!attribution && attribution.lineage === this.lineageSequence && attribution.handoffId !== this.handoffId
  }

  /**
   * Record a reply for the active conversation. A stale reply is not counted
   * (its cost is the loop's request-wide usage, not this conversation's).
   * @returns {boolean} whether the reply was counted
   */
  observeReply(attribution, usage) {
    if (!attribution || attribution.lineage !== this.lineageSequence || attribution.handoffId !== this.handoffId) return false
    const input = finiteNonNegative(usage?.input_units)
    this.size = observeContextSize(this.size, { providerInputTokens: input })
    this.counters.replies += 1
    this.counters.input_tokens += input
    this.counters.output_units += finiteNonNegative(usage?.output_units)
    if (input > 0) this.counters.last_input_tokens = input
    return true
  }

  /**
   * `data.role` / `data.handoff_id` for a provider request/response/error row:
   * both or neither. Present once delegation is active for the request, and
   * always on a stale reply (so the drop row can be paired with it).
   */
  traceFields(attribution) {
    if (!attribution) return {}
    if (!attribution.delegated && !this.isStale(attribution)) return {}
    return { role: attribution.role, handoff_id: attribution.handoffId }
  }

  /** Extra fields for the provider call's context object; empty until delegation is active. */
  providerContextFields(attribution) {
    return attribution?.delegated ? { role: attribution.role } : {}
  }

  /** `context.stale_reply_dropped` row data, exactly as DELEGATION_TRACE_ROWS specifies. */
  staleReplyRow(attribution) {
    return {
      role: attribution.role,
      handoff_id: attribution.handoffId,
      active_handoff_id: this.handoffId,
      reason: STALE_REPLY_REASON,
    }
  }

  // --- restage --------------------------------------------------------------------------

  /**
   * Validate a restage without changing anything. Returns the normalized
   * arguments for commitRestage; throws RangeError/TypeError on a packet that
   * does not fit (so the loop can refuse before it touches the reducer).
   */
  prepareRestage({ checkpoint, reason, packet, role, prefixMessages } = {}) {
    if (!CONTEXT_RESTAGE_CHECKPOINTS.includes(checkpoint)) throw new RangeError(`restage checkpoint must be one of ${CONTEXT_RESTAGE_CHECKPOINTS.join(', ')}`)
    if (!packet || typeof packet !== 'object') throw new TypeError('restage needs a handoff packet')
    for (const field of ['stableText', 'volatileText', 'handoff_id']) {
      if (typeof packet[field] !== 'string' || packet[field].length === 0) throw new TypeError(`restage packet is missing ${field}`)
    }
    const eventRole = packet.event?.role
    const nextRole = role ?? eventRole ?? this.role
    if (!AGENT_ROLES.includes(nextRole)) throw new RangeError(`agent role must be one of ${AGENT_ROLES.join(', ')}`)
    if (eventRole && eventRole !== nextRole) throw new RangeError(`restage role ${nextRole} does not match the packet's role ${eventRole}`)
    if (packet.event?.checkpoint && packet.event.checkpoint !== checkpoint) {
      throw new RangeError(`restage checkpoint ${checkpoint} does not match the packet's checkpoint ${packet.event.checkpoint}`)
    }
    if (packet.handoff_id === this.handoffId) throw new RangeError('restage packet is already the active conversation')
    const prefix = prefixMessages ?? leadingSystemMessages(this.baseMessages.length > 0 ? this.baseMessages : this.messages)
    if (!Array.isArray(prefix)) throw new TypeError('restage prefixMessages must be an array')
    return { checkpoint, reason: typeof reason === 'string' ? reason : (packet.event?.reason ?? ''), packet, role: nextRole, prefix }
  }

  /**
   * Swap in the fresh conversation: system + tools prefix unchanged, then the
   * packet's stable block, then its volatile block. Counters and the size
   * counter reset, the handoff id becomes the packet's, the role becomes the
   * packet's role. Anything in flight for the previous conversation is stale
   * from this call on.
   *
   * @returns {object} what changed, for the caller's trace row
   */
  commitRestage(prepared) {
    const { checkpoint, reason, packet, role, prefix } = prepared
    const previous = {
      role: this.role,
      handoff_id: this.handoffId,
      restage_count: this.restageCount,
      message_count: this.messages.length,
      chars: conversationChars(this.messages),
      size_tokens: this.sizeTokens,
      counters: { ...this.counters },
    }
    this.baseMessages = [
      ...copyMessages(prefix),
      { role: 'user', content: packet.stableText },
      { role: 'user', content: packet.volatileText },
    ]
    this.messages = copyMessages(this.baseMessages)
    this.role = role
    this.handoffId = packet.handoff_id
    this.restageCount += 1
    this.resetCounters()
    return {
      role,
      checkpoint,
      reason,
      handoff_id: packet.handoff_id,
      packet_hash: packet.hash,
      packet_chars: packet.chars,
      packet_estimated_tokens: packet.estimated_tokens,
      previous_context_chars: previous.chars,
      previous,
    }
  }

  /** prepareRestage + commitRestage. */
  restage(args) {
    return this.commitRestage(this.prepareRestage(args))
  }
}

/**
 * `context.restaged` row data, exactly as DELEGATION_TRACE_ROWS specifies.
 * `plan_id` / `step_id` are the active plan and step at the restage;
 * `soft_limit_tokens` is the restage-policy limit that applied, when known.
 * Undefined fields are omitted.
 */
export function contextRestagedRow(result, { planId, stepId, softLimitTokens } = {}) {
  const row = {
    role: result.role,
    checkpoint: result.checkpoint,
    handoff_id: result.handoff_id,
    packet_hash: result.packet_hash,
    packet_chars: result.packet_chars,
    packet_estimated_tokens: result.packet_estimated_tokens,
    previous_context_chars: result.previous_context_chars,
    reason: result.reason,
    plan_id: planId,
    step_id: stepId,
    soft_limit_tokens: softLimitTokens,
  }
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))
}
