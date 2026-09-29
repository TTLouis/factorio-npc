// Player-felt responsiveness (work plan item 2.10).
//
// (a) One quick chat acknowledgement per player request, before the planner
//     has spoken. It is built from the player's own words and the interaction
//     route only, so it needs no model call and works with no Jev key (the
//     deterministic route). It states what the NPC will do, never what it has
//     done: no world claim and no completion claim.
// (b) Two per-request metrics, read from the behavior trace: time to the first
//     chat line the player saw, and time to the first admitted action
//     (operations.ack). The same tracker feeds the Debug window (live) and the
//     run record (think-time-report.mjs, offline).
//
// The acknowledgement is deliberately a small reusable function: a later owner
// item (U2, progress lines) builds on `acknowledgementLine` and the once-per-
// request guard, not on this file's wiring.

export const ACK_EVENT = 'chat.acknowledged'
export const ACK_EXCERPT_CHARS = 90

// Routes whose request goes on to a planner round. Every other route answers
// at once from durable state (status, chat-only, cancel, an amendment staged
// for the running batch), so an acknowledgement would only double the reply.
export const ACK_INTENTS = Object.freeze(['new_goal', 'amend_current', 'continue_current'])

// Factorio chat renders [color=...] and [item=...] rich text; the player's own
// words are echoed as plain text.
function excerpt(text, max = ACK_EXCERPT_CHARS) {
  if (typeof text !== 'string') return ''
  const clean = text
    .replace(/\[\/?[a-z-]+(?:=[^\]]*)?\]/gi, ' ')
    // Controls (C0/C1), bidi and zero-width format characters never reach chat.
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/"/g, '\'')
    .trim()
  const points = Array.from(clean)
  return points.length <= max ? clean : `${points.slice(0, max - 3).join('').trimEnd()}...`
}

// The acknowledgement text, or '' when this route does not get one. Pure.
export function acknowledgementLine({ text, intent } = {}) {
  if (!ACK_INTENTS.includes(intent)) return ''
  const words = excerpt(text)
  if (intent === 'continue_current') {
    return 'Heard you. I will pick the current goal back up and check the world before I act.'
  }
  if (!words) return ''
  if (intent === 'amend_current') {
    return `Heard you. I will adjust the current goal: "${words}". I will confirm once the change is planned.`
  }
  return `Heard you. I will start on: "${words}". I will share the plan once it is worked out.`
}

// At most one acknowledgement per request, only for a player's chat or UI
// prompt. Supervisor recovery runs (auto-resume, actor replacement, runtime
// restart, condition wake-ups) never reach `request()`, and `origin` guards a
// future caller that does.
export class ChatAcknowledger {
  constructor({ now = Date.now, remember = 64 } = {}) {
    this.now = now
    this.remember = remember
    this.acknowledged = []
  }

  // Returns the chat.acknowledged payload, or undefined when nothing should be
  // said (wrong origin, no planner-bound route, already acknowledged).
  acknowledge({ requestId, text, intent, origin = 'chat', startedAt } = {}) {
    if (typeof requestId !== 'string' || !requestId) return undefined
    if (origin !== 'chat') return undefined
    if (this.acknowledged.includes(requestId)) return undefined
    const line = acknowledgementLine({ text, intent })
    if (!line) return undefined
    this.acknowledged.push(requestId)
    if (this.acknowledged.length > this.remember) this.acknowledged.shift()
    return {
      chat_message: line,
      interaction_intent: intent,
      // From the moment the request reached the loop, including the Jev route
      // call, to this line.
      latency_ms: Number.isFinite(startedAt) ? Math.max(0, this.now() - startedAt) : undefined,
      source: 'goal_text_and_route',
      world_claim: false,
    }
  }
}

// A chat line the player saw for this request, from the event that printed it.
function chatLineOf(event, data) {
  if (event === ACK_EVENT) return { source: 'acknowledgement' }
  if (event === 'goal.defined') return { source: 'goal_understanding' }
  if ((event === 'plan.accepted' || event === 'request.completed' || event === 'request.failed')
    && typeof data?.chat_message === 'string' && data.chat_message.trim().length > 0) {
    return { source: event }
  }
  return undefined
}

function round1(ms) {
  return Number.isFinite(ms) ? Math.round(ms) : undefined
}

// Per-request first-chat and first-action timing. Time zero is the moment the
// request reached the loop: `request.received` carries `intake_ms`, the time
// the route classification took before the request id existed.
export class ResponsivenessTracker {
  constructor({ remember = 32 } = {}) {
    this.remember = remember
    this.requests = new Map()
    this.lastRequestId = undefined
  }

  observe(event, data = {}, { requestId, ts } = {}) {
    if (typeof requestId !== 'string' || !requestId || !Number.isFinite(ts)) return
    if (event === 'request.received') {
      this.requests.set(requestId, {
        request_id: requestId,
        received_ts: ts,
        intake_ms: Number.isFinite(data?.intake_ms) && data.intake_ms >= 0 ? data.intake_ms : 0,
      })
      this.lastRequestId = requestId
      while (this.requests.size > this.remember) this.requests.delete(this.requests.keys().next().value)
      return
    }
    const request = this.requests.get(requestId)
    if (!request) return
    const since = ts - request.received_ts + request.intake_ms
    const chat = chatLineOf(event, data)
    if (chat) {
      if (request.first_chat_ms === undefined) {
        request.first_chat_ms = round1(since)
        request.first_chat_source = chat.source
      }
      // The first line the planner side spoke, kept apart so the report shows
      // what the acknowledgement saved.
      if (chat.source !== 'acknowledgement' && request.first_planner_chat_ms === undefined) request.first_planner_chat_ms = round1(since)
    }
    if (event === ACK_EVENT && request.acknowledged_ms === undefined) {
      request.acknowledged_ms = Number.isFinite(data?.latency_ms) ? round1(data.latency_ms) : round1(since)
    }
    if (event === 'operations.ack' && request.first_action_ms === undefined) request.first_action_ms = round1(since)
  }

  snapshot(requestId = this.lastRequestId) {
    const request = this.requests.get(requestId)
    if (!request) return undefined
    return {
      request_id: request.request_id,
      first_chat_ms: request.first_chat_ms,
      first_chat_source: request.first_chat_source,
      acknowledged_ms: request.acknowledged_ms,
      first_planner_chat_ms: request.first_planner_chat_ms,
      first_action_ms: request.first_action_ms,
    }
  }

  // Ready-to-show Debug window text.
  debugText(requestId = this.lastRequestId) {
    const view = this.snapshot(requestId)
    return view ? responsivenessText(view) : ''
  }
}

function span(ms) {
  if (!Number.isFinite(ms)) return 'none yet'
  return ms < 90_000 ? `${(Math.round(ms / 100) / 10).toFixed(1)} s` : `${(Math.round(ms / 6000) / 10).toFixed(1)} min`
}

export function responsivenessText(view) {
  const chat = view.first_chat_source === 'acknowledgement' ? ' (acknowledged)' : view.first_chat_source ? ' (planner reply)' : ''
  return `first chat ${span(view.first_chat_ms)}${chat} · first action ${span(view.first_action_ms)}`
}

// Offline: the same numbers from behavior-trace rows ({ ts, request_id, event,
// data }), for the run record.
export function responsivenessByRequest(rows) {
  const tracker = new ResponsivenessTracker({ remember: Number.MAX_SAFE_INTEGER })
  for (const row of Array.isArray(rows) ? rows : []) {
    const ts = typeof row?.ts === 'string' ? Date.parse(row.ts) : undefined
    if (!Number.isFinite(ts)) continue
    tracker.observe(row.event, row.data && typeof row.data === 'object' ? row.data : {}, { requestId: row.request_id, ts })
  }
  return new Map([...tracker.requests.keys()].map(id => [id, tracker.snapshot(id)]))
}
