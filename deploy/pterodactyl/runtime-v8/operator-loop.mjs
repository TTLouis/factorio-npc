// Pursuit-mode operator loop: one model pursues the goal through the shared
// operator tool surface. The loop owns transport, budgets and context rotation
// only. It never decides success: the supervisor's native acceptance does.
import { NOTEBOOK_POLICY, notebookToolDefinitions, validateNotebookTool } from './agent-notebook.mjs'
import { toolResult } from './operator-tool-surface.mjs'

export const OPERATOR_LOOP_DEFAULTS = Object.freeze({
  maxRequests: 400,
  maxToolCalls: 2000,
  maxTotalTokens: 50000000,
  // Rotate before the provider's history cap (50 messages) and before the
  // prompt grows past the model's useful context.
  rotateAtMessages: 44,
  rotateAtPromptTokens: 150000,
  maxToolCallsPerResponse: 8,
})

const SUBMIT = 'factorio_submit'

export function createOperatorState() {
  return { schema: 1, requests: 0, tool_calls: 0, rotations: 0, submits: 0, prompt_tokens: 0, output_tokens: 0 }
}

function validState(state) {
  return state && state.schema === 1 && ['requests', 'tool_calls', 'rotations', 'submits', 'prompt_tokens', 'output_tokens']
    .every(key => Number.isSafeInteger(state[key]) && state[key] >= 0)
}

/**
 * Notebook adapter over AgentNotebookStore: stage, durably persist the staged
 * snapshot, then commit. A persist failure leaves the store unchanged.
 */
export function storeNotebook({ store, world, npc, goal, persist }) {
  return {
    async read(scope) { return store.read(world, npc, goal, scope) },
    async write(scope, expectedRevision, text) {
      const staged = store.stage(world, npc, goal, scope, expectedRevision, text)
      staged.check()
      const snapshot = staged.snapshot()
      await persist(snapshot)
      staged.commit(snapshot)
      return { scope, revision: expectedRevision + 1, acknowledged: true }
    },
  }
}

function notebookSection(label, note) {
  return `[${label} notebook, revision ${note.revision}]\n${note.text || '(empty)'}`
}

async function seedMessages({ brief, notebook, tools, rotation, note }) {
  const [goalNote, persistentNote, context] = await Promise.all([
    notebook.read('goal'), notebook.read('persistent'), tools.call('factorio_context', {}),
  ])
  const parts = [
    rotation > 0
      ? `[CONTEXT ROTATION ${rotation}] The previous conversation ended to keep context bounded. Gameplay continues: outstanding operations, request ids and native state are unchanged. Re-read receipts for any operation you had not reconciled before submitting new work.`
      : '[START] Begin the goal below.',
    `[NOTEBOOK POLICY] ${NOTEBOOK_POLICY}`,
    notebookSection('Goal', goalNote),
    notebookSection('Persistent', persistentNote),
    `[CURRENT CONTEXT from factorio_context]\n${context.content[0].text}`,
    ...(typeof note === 'string' && note ? [`[SUPERVISOR] ${note}`] : []),
  ]
  // The brief stays a fixed first message so it remains a cacheable prefix.
  return [{ role: 'system', content: brief }, { role: 'user', content: parts.join('\n\n') }]
}

function parseArguments(raw) {
  if (raw === undefined || raw === '') return {}
  if (typeof raw !== 'string') return raw
  return JSON.parse(raw)
}

function refusal(code, message) {
  return toolResult({ code, message, effect: 'not_happened', journal_slot_used: false }, true)
}

// Evidence keeps arguments as parsed JSON; unparseable text stays verbatim.
function loggedArguments(raw) {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) }
  catch { return raw }
}

/**
 * Run the operator until it yields (a reply with no tool calls), a budget is
 * exhausted, the signal aborts or the provider fails. `state` is the caller's
 * persisted counter object: it is mutated in place and never reset, so budgets
 * survive rotation and restart. `complete({ messages, tools, signal })` returns
 * `{ message: { content, tool_calls }, usage }` in OpenAI-compatible shape.
 */
export async function runOperatorLoop({ complete, tools, notebook, brief, state, options = {}, signal, onEvent = () => {}, saveState = async () => {}, afterResponse, seedNote }) {
  if (typeof complete !== 'function' || typeof tools?.call !== 'function' || typeof notebook?.read !== 'function'
    || typeof brief !== 'string' || brief.length === 0 || !validState(state)) throw new TypeError('invalid operator loop configuration')
  const limits = { ...OPERATOR_LOOP_DEFAULTS, ...options }
  const definitions = [...tools.definitions, ...notebookToolDefinitions]
  const emit = (type, detail = {}) => onEvent({ type, ...detail, requests: state.requests, rotations: state.rotations })
  let messages = await seedMessages({ brief, notebook, tools, rotation: state.rotations, note: seedNote })
  let lastPromptTokens = 0

  for (;;) {
    if (signal?.aborted) return { stop: 'aborted', state }
    if (state.requests >= limits.maxRequests) { emit('budget_exhausted', { budget: 'requests' }); return { stop: 'request_budget_exhausted', state } }
    if (state.tool_calls >= limits.maxToolCalls) { emit('budget_exhausted', { budget: 'tool_calls' }); return { stop: 'tool_call_budget_exhausted', state } }
    if (state.prompt_tokens + state.output_tokens >= limits.maxTotalTokens) { emit('budget_exhausted', { budget: 'tokens' }); return { stop: 'token_budget_exhausted', state } }
    if (messages.length >= limits.rotateAtMessages || lastPromptTokens >= limits.rotateAtPromptTokens) {
      state.rotations++
      await saveState(state)
      emit('context_rotated', { messages: messages.length, prompt_tokens: lastPromptTokens })
      messages = await seedMessages({ brief, notebook, tools, rotation: state.rotations })
      lastPromptTokens = 0
    }

    state.requests++
    await saveState(state)
    emit('provider_request', { messages, tools: definitions })
    let reply
    try { reply = await complete({ messages, tools: definitions, signal }) }
    catch (cause) {
      if (signal?.aborted) return { stop: 'aborted', state }
      emit('provider_error', { code: typeof cause?.code === 'string' ? cause.code : 'provider_error' })
      return { stop: 'provider_error', state }
    }
    const usage = reply?.usage ?? {}
    lastPromptTokens = Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens : 0
    state.prompt_tokens += lastPromptTokens
    state.output_tokens += Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens : 0
    const message = reply?.message ?? {}
    emit('provider_response', { message, usage, provider: reply?.provider })
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    messages.push({ role: 'assistant', content: message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) })
    if (calls.length === 0) {
      await saveState(state)
      emit('operator_yield', { content: typeof message.content === 'string' ? message.content.slice(0, 2000) : '' })
      return { stop: 'operator_yield', state, content: message.content ?? '' }
    }

    let submitted = false
    const outcomes = []
    for (const [index, call] of calls.entries()) {
      if (signal?.aborted) return { stop: 'aborted', state }
      const name = call?.function?.name
      let result
      if (state.tool_calls >= limits.maxToolCalls) {
        result = refusal('tool_call_budget_exhausted', 'The durable tool call allowance is exhausted.')
      }
      else if (index >= limits.maxToolCallsPerResponse) {
        result = refusal('too_many_tool_calls', `At most ${limits.maxToolCallsPerResponse} tool calls per response; this one was not run.`)
      }
      else {
        let args
        try { args = parseArguments(call?.function?.arguments) }
        catch { args = undefined }
        if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) {
          result = refusal('invalid_tool_arguments', 'Tool arguments must be one JSON object.')
        }
        else if (name === 'readNotebook' || name === 'updateNotebook') {
          result = await notebookCall(notebook, name, args)
        }
        else if (name === SUBMIT && submitted) {
          // One outstanding world operation per response: read its receipt first.
          result = refusal('one_submit_per_response', 'Only one factorio_submit per response. Read the first receipt, then submit the next operation.')
        }
        else {
          if (name === SUBMIT) { submitted = true; state.submits++ }
          result = await tools.call(name, args)
        }
        state.tool_calls++
      }
      emit('tool_result', { tool: name, tool_call_id: call?.id, arguments: loggedArguments(call?.function?.arguments),
        result, is_error: result.isError, code: result.isError ? result.structuredContent?.code : undefined })
      outcomes.push({ tool: name, result })
      messages.push({ role: 'tool', tool_call_id: call?.id, content: result.content[0].text })
    }
    await saveState(state)
    if (typeof afterResponse === 'function') {
      const stop = await afterResponse({ state, outcomes })
      if (typeof stop === 'string') { await saveState(state); emit('supervisor_stop', { reason: stop }); return { stop, state } }
    }
  }
}

async function notebookCall(notebook, name, args) {
  try {
    validateNotebookTool(name, args)
    if (name === 'readNotebook') return toolResult(await notebook.read(args.scope))
    return toolResult(await notebook.write(args.scope, args.expectedRevision, args.text))
  }
  catch (cause) {
    const code = typeof cause?.code === 'string' && /^[a-z_]{1,80}$/.test(cause.code) ? cause.code : 'notebook_error'
    return toolResult({ code, message: 'Notebook call refused; read the notebook again before retrying.' }, true)
  }
}
