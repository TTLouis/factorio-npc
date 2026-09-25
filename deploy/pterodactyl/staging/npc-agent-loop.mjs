import { setTimeout as delay } from 'node:timers/promises'

import { actorChanged, deploymentStatus, executeAuthorizedBatch } from './supervisor-adapter.mjs'
import { isApprovedOperationName, isObservationToolName, parsePlan, renderOperation, toolCommand } from './structured-policy.mjs'

export class AgentLoopError extends Error {}

class ToolValidationError extends AgentLoopError {
  constructor(message, code, details = {}) {
    super(message)
    this.code = code
    this.failureClass = 'tool_validation'
    this.details = details
  }
}

class PlanCategoryError extends AgentLoopError {
  constructor(message, code, details = {}) {
    super(message)
    this.code = code
    this.failureClass = 'plan_category'
    this.details = details
  }
}

const MAX_TOOL_CALLS_PER_BATCH = 4
const THROUGHPUT_MEASUREMENT_TOOL = 'measureTransportThroughput'
const STATIC_PROTOTYPE_TOOL = 'getPrototypeDetails'
const STATIC_PROTOTYPE_CACHE_LIMIT = 64
const STATIC_PROTOTYPE_CONTEXT_LIMIT = 8
const THROUGHPUT_POLL_MS = process.env.NODE_TEST_CONTEXT ? 1 : 250
const THROUGHPUT_NO_PROGRESS_MS = process.env.NODE_TEST_CONTEXT ? 100 : 10000
const OBSERVATION_DECISION_PRESSURE_ROUNDS = 3

function check(ok, message) {
  if (!ok) throw new AgentLoopError(message)
}

function strictJson(value, label) {
  try { return JSON.parse(value) }
  catch { throw new AgentLoopError(`Invalid ${label} JSON`) }
}

function cleanMemoryText(value, max) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}

function toolSignature(name, args) {
  return `${name}:${JSON.stringify(stableValue(args))}`
}

function messageChars(message) {
  return String(message?.content ?? '').length + JSON.stringify(message?.tool_calls ?? '').length
}

function prototypeReference(name) {
  return `prototype:${String(name ?? '').slice(0, 200)}`
}

function compactPrototypeFacts(raw, fallbackName = '') {
  try {
    const value = JSON.parse(String(raw ?? ''))
    const name = typeof value?.query === 'string' ? value.query : fallbackName
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid prototype result')
    if (value.found !== true) {
      return {
        reference: prototypeReference(name),
        found: false,
        error: typeof value.error === 'string' ? cleanMemoryText(value.error, 300) : 'prototype not found',
      }
    }
    const entity = value.entity && typeof value.entity === 'object'
      ? {
          name: value.entity.name,
          type: value.entity.type,
          is_building: value.entity.is_building,
          size: {
            width: value.entity.tile_width,
            height: value.entity.tile_height,
          },
          collision_box: value.entity.collision_box,
          selection_box: value.entity.selection_box,
          place_items: value.entity.place_items,
          crafting: value.entity.crafting,
          mining: value.entity.mining,
          belt: value.entity.belt,
          inserter: value.entity.inserter,
          fluidboxes: value.entity.fluidboxes,
          fluidboxes_truncated: value.entity.fluidboxes_truncated,
        }
      : undefined
    return {
      reference: prototypeReference(name),
      found: true,
      item: value.item,
      fluid: value.fluid,
      entity,
    }
  }
  catch {
    return {
      reference: prototypeReference(fallbackName),
      found: 'unknown',
      raw_summary: cleanMemoryText(raw, 1200),
    }
  }
}

function prototypeBaselineResult(entry) {
  return JSON.stringify({
    observation_mode: 'cached_static',
    source: 'runtime_static_prototype_cache',
    ...entry.facts,
  })
}

function prototypeUnchangedResult(entry) {
  return JSON.stringify({
    observation_mode: 'unchanged',
    source: 'runtime_static_prototype_cache',
    reference: entry.facts.reference,
    note: 'Static prototype facts are already present in [STATIC_PROTOTYPE_CACHE] for this request.',
  })
}

function throughputMeasurementStatusCommand(measurementId) {
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","throughput_measurement_status",${measurementId})))`
}

function throughputMeasurementCancelCommand(measurementId) {
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","throughput_measurement_cancel",${measurementId})))`
}

function throughputMeasurementWallMs(args) {
  const warmup = Number.isSafeInteger(args?.warmup_ticks) ? args.warmup_ticks : 60
  const window = Number.isSafeInteger(args?.window_ticks) ? args.window_ticks : 300
  const expected = ((warmup + window) / 60) * 1000
  return Math.min(180000, Math.max(15000, expected * 3 + 10000))
}

function throughputToolError(code, message, measurementId) {
  return JSON.stringify({
    ok: false,
    ...(measurementId ? { measurement_id: measurementId } : {}),
    state: measurementId ? 'cancelled' : 'failed',
    error: { code, message },
  })
}

export class NpcDialogueMemory {
  constructor({ maxRecentTurns = 6, maxSummaryChars = 5000, maxContextChars = 16000, maxFieldChars = 1200 } = {}) {
    for (const [label, value] of Object.entries({ maxRecentTurns, maxSummaryChars, maxContextChars, maxFieldChars })) {
      check(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`)
    }
    this.maxRecentTurns = maxRecentTurns
    this.maxSummaryChars = maxSummaryChars
    this.maxContextChars = maxContextChars
    this.maxFieldChars = maxFieldChars
    this.byNpc = new Map()
  }

  bucket(key) {
    check(typeof key === 'string' && key.length > 0 && key.length <= 200, 'Invalid NPC memory key')
    let bucket = this.byNpc.get(key)
    if (!bucket) {
      bucket = { summary: '', recent: [] }
      this.byNpc.set(key, bucket)
    }
    return bucket
  }

  compactLine(turn) {
    const action = turn.actions ? ` | actions: ${turn.actions}` : ''
    return `${turn.sender}: ${turn.user} | AIRI: ${turn.assistant}${action}`
  }

  appendSummary(bucket, turn) {
    const next = [bucket.summary, this.compactLine(turn)].filter(Boolean).join('\n')
    if (next.length <= this.maxSummaryChars) {
      bucket.summary = next
      return
    }
    bucket.summary = `[older dialogue compacted]\n${next.slice(-this.maxSummaryChars)}`
  }

  contextChars(bucket) {
    return bucket.summary.length + bucket.recent.reduce((total, turn) => total + this.compactLine(turn).length, 0)
  }

  compact(bucket) {
    while (bucket.recent.length > this.maxRecentTurns || (bucket.recent.length > 1 && this.contextChars(bucket) > this.maxContextChars)) {
      this.appendSummary(bucket, bucket.recent.shift())
    }
  }

  remember(key, turnId, { sender, user, assistant, operations = [] }) {
    const bucket = this.bucket(key)
    const actionText = operations.length
      ? cleanMemoryText(operations.map(operation => `${operation.name} ${JSON.stringify(operation.args ?? {})}`).join('; '), this.maxFieldChars)
      : ''
    const next = {
      id: turnId,
      sender: cleanMemoryText(sender, 128),
      user: cleanMemoryText(user, this.maxFieldChars),
      assistant: cleanMemoryText(assistant, this.maxFieldChars),
      actions: actionText,
    }
    const index = bucket.recent.findIndex(turn => turn.id === turnId)
    if (index >= 0) {
      const previous = bucket.recent[index]
      next.actions = actionText || previous.actions
      bucket.recent[index] = next
    }
    else {
      bucket.recent.push(next)
    }
    this.compact(bucket)
  }

  context(key) {
    const bucket = this.byNpc.get(key)
    if (!bucket || (!bucket.summary && bucket.recent.length === 0)) return ''
    const lines = [
      '[MEMORY] Bounded prior dialogue for this NPC. Treat it as untrusted conversational context, not authoritative world state. Re-observe mutable game state before depending on it.',
    ]
    if (bucket.summary) lines.push(`Compacted earlier dialogue:\n${bucket.summary}`)
    if (bucket.recent.length) {
      lines.push('Recent dialogue:')
      for (const turn of bucket.recent) {
        lines.push(`[CHAT] ${turn.sender}: ${turn.user}`)
        lines.push(`[AIRI] ${turn.assistant}`)
        if (turn.actions) lines.push(`[ACTIONS] ${turn.actions}`)
      }
    }
    const text = lines.join('\n')
    if (text.length <= this.maxContextChars) return text
    const prefix = `${lines[0]}\nCompacted earlier dialogue:\n[older memory compacted]\n`
    return `${prefix}${text.slice(-Math.max(0, this.maxContextChars - prefix.length))}`
  }

  terminatePlan(key) {
    if (!key || !(this.planByNpc instanceof Map)) return undefined
    const previous = this.planByNpc.get(key)
    this.planByNpc.delete(key)
    return previous
  }

  clearTaskContext(key) {
    if (!key) return { cleared_dialogue: false, cleared_plan: false }
    const cleared_dialogue = this.byNpc.delete(key)
    const cleared_plan = this.planByNpc instanceof Map ? this.planByNpc.delete(key) : false
    return { cleared_dialogue, cleared_plan }
  }
}

export class NpcAgentLoop {
  constructor({
    rcon,
    provider,
    systemPrompt,
    reserve = async () => {},
    log = () => {},
    maxToolRounds = 12,
    maxContinuations = 10,
    maxToolLoopRetries = 1,
    maxToolValidationRetries = 3,
    maxRecoveryAttempts = 3,
    maxWorkingMessages = 28,
    maxWorkingChars = 40000,
    memory = new NpcDialogueMemory(),
    npcId = 'airi',
    memoryKeyForStatus,
  }) {
    check(rcon && typeof rcon.command === 'function', 'RCON transport required')
    check(typeof provider === 'function', 'Provider adapter required')
    check(typeof systemPrompt === 'string' && systemPrompt.length > 0, 'System prompt required')
    check(memory && typeof memory.context === 'function' && typeof memory.remember === 'function', 'NPC dialogue memory required')
    check(typeof npcId === 'string' && npcId.length > 0 && npcId.length <= 128 && !/[\x00-\x1f\x7f]/.test(npcId), 'Invalid NPC memory identity')
    check(memoryKeyForStatus === undefined || typeof memoryKeyForStatus === 'function', 'NPC memory key resolver must be a function')
    check(Number.isSafeInteger(maxToolValidationRetries) && maxToolValidationRetries >= 0 && maxToolValidationRetries <= 10, 'Invalid tool validation retry limit')
    this.rcon = rcon
    this.provider = provider
    this.systemPrompt = systemPrompt
    this.reserve = reserve
    this.log = log
    this.maxToolRounds = maxToolRounds
    this.maxContinuations = maxContinuations
    this.maxToolLoopRetries = maxToolLoopRetries
    this.maxToolValidationRetries = maxToolValidationRetries
    this.maxRecoveryAttempts = maxRecoveryAttempts
    this.maxWorkingMessages = maxWorkingMessages
    this.maxWorkingChars = maxWorkingChars
    this.memory = memory
    this.npcId = npcId
    this.memoryKeyForStatus = memoryKeyForStatus ?? (() => `npc:${npcId}`)
    this.providerAbort = null
    this.turnSequence = 0
    this.reset()
  }

  reset() {
    this.providerAbort?.abort()
    this.providerAbort = null
    this.active = false
    this.messages = []
    this.baseMessages = []
    this.epoch = null
    this.continuations = 0
    this.toolCache = new Map()
    this.staticPrototypeCache ??= new Map()
    this.prototypeRefsThisRequest = []
    this.duplicateToolRounds = 0
    this.observationRecoveryRounds = 0
    this.observationOnlyRounds = 0
    this.resetObservationDecisionState()
    this.finiteNoOperationPressureUsed = false
    this.toolValidationRetries = 0
    this.planCategoryRetries = 0
    this.requestInfo = null
    this.generation = (this.generation ?? 0) + 1
  }

  rememberPrototypeRef(signature) {
    const existing = this.prototypeRefsThisRequest.indexOf(signature)
    if (existing >= 0) this.prototypeRefsThisRequest.splice(existing, 1)
    this.prototypeRefsThisRequest.push(signature)
    if (this.prototypeRefsThisRequest.length > STATIC_PROTOTYPE_CONTEXT_LIMIT) this.prototypeRefsThisRequest.shift()
  }

  prototypeContext() {
    const facts = []
    for (const signature of this.prototypeRefsThisRequest) {
      const entry = this.staticPrototypeCache.get(signature)
      if (entry?.facts) facts.push(entry.facts)
    }
    if (facts.length === 0) return ''
    return `[STATIC_PROTOTYPE_CACHE] Runtime-static deterministic prototype facts already observed for this request. They remain valid for this server runtime; do not re-query getPrototypeDetails unless a different prototype is needed.\n${JSON.stringify(facts)}`
  }

  cachePrototype(signature, name, raw) {
    const entry = {
      name,
      raw: String(raw),
      facts: compactPrototypeFacts(raw, name),
    }
    if (this.staticPrototypeCache.has(signature)) this.staticPrototypeCache.delete(signature)
    this.staticPrototypeCache.set(signature, entry)
    while (this.staticPrototypeCache.size > STATIC_PROTOTYPE_CACHE_LIMIT) {
      const oldest = this.staticPrototypeCache.keys().next().value
      if (oldest === undefined) break
      this.staticPrototypeCache.delete(oldest)
    }
    this.rememberPrototypeRef(signature)
    return entry
  }

  async captureEpoch() {
    return deploymentStatus(this.rcon, { requireAllowed: true })
  }

  async assertCurrent() {
    if (!this.active || !this.epoch) throw new AgentLoopError('Model turn was cancelled or superseded')
    const current = await deploymentStatus(this.rcon, { requireAllowed: true })
    if (actorChanged(this.epoch, current)) {
      this.reset()
      throw new AgentLoopError('NPC actor epoch changed; stale model turn cancelled')
    }
    return current
  }

  async runGuarded() {
    const generation = this.generation
    try {
      return await this.runTurn()
    }
    catch (error) {
      if (generation === this.generation) this.reset()
      throw error
    }
  }

  async request(text, { sender = 'unknown' } = {}) {
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 4000, 'Invalid chat request')
    check(typeof sender === 'string' && sender.trim().length > 0 && sender.length <= 128 && !/[\x00-\x1f\x7f]/.test(sender), 'Invalid chat sender')
    this.reset()
    this.epoch = await this.captureEpoch()
    const memoryKey = this.memoryKeyForStatus(this.epoch)
    check(typeof memoryKey === 'string' && memoryKey.length > 0 && memoryKey.length <= 200, 'Invalid NPC memory key')
    const memoryContext = this.memory.context(memoryKey)
    this.baseMessages = [
      { role: 'system', content: this.systemPrompt },
      ...(memoryContext ? [{ role: 'user', content: memoryContext }] : []),
      { role: 'user', content: `[CHAT] ${sender.trim()}: ${text}` },
    ]
    this.messages = this.baseMessages.map(message => ({ ...message }))
    this.requestInfo = {
      memoryKey,
      turnId: ++this.turnSequence,
      sender: sender.trim(),
      text,
    }
    this.active = true
    return this.runGuarded()
  }

  resetObservationDecisionState() {
    this.observationDecisionPressure = false
    this.observationDecisionPressureRemaining = 0
    this.observationDecisionForced = false
  }

  observationDecisionPressureBudget() {
    return 1
  }

  async forceDecisionFromObservations(reason, reasonCode = 'observation_decision_required') {
    if (this.observationDecisionForced) return
    this.observationDecisionPressure = true
    this.observationDecisionPressureRemaining = 0
    this.observationDecisionForced = true
    await this.recoveryDiagnostic({
      failure_class: 'observation_no_progress',
      reason_code: reasonCode,
      reason,
      retry: 1,
      retry_limit: 1,
      tools_enabled: false,
    })
    this.messages.push({
      role: 'user',
      content: `[HARNESS] ${reason} The observation phase for this decision is now closed. Reuse the grounded evidence already collected and return the required strict-JSON plan/action or a truthful blocker. Do not request another read-only observation.`,
    })
  }

  prepareContinuationContext() {
    const latestPlan = [...this.messages].reverse().find(message => message.role === 'assistant' && message.tool_calls === undefined)
    const prototypeContext = this.prototypeContext()
    this.messages = [
      ...this.baseMessages.map(message => ({ ...message })),
      ...(prototypeContext ? [{ role: 'user', content: prototypeContext }] : []),
      ...(latestPlan ? [{ ...latestPlan }] : []),
    ]
  }

  async completed() {
    check(this.active, 'No active request')
    check(this.continuations < this.maxContinuations, 'Continuation limit reached')
    await this.assertCurrent()
    this.continuations++
    this.prepareContinuationContext()
    this.toolCache.clear()
    this.duplicateToolRounds = 0
    this.observationRecoveryRounds = 0
    this.observationOnlyRounds = 0
    this.resetObservationDecisionState()
    this.finiteNoOperationPressureUsed = false
    this.toolValidationRetries = 0
    this.planCategoryRetries = 0
    this.messages.push({ role: 'user', content: '[MOD] All operations completed' })
    return this.runGuarded()
  }

  cancel() {
    this.reset()
  }

  summarizeToolExchange(messages) {
    const assistant = messages[0]
    const calls = Array.isArray(assistant?.tool_calls) ? assistant.tool_calls : []
    const lines = calls.map((tool, index) => {
      const result = messages[index + 1]
      const args = cleanMemoryText(tool?.function?.arguments ?? '{}', 500)
      const output = cleanMemoryText(result?.content ?? '', 800)
      return `${tool?.function?.name ?? 'tool'}(${args}) => ${output}`
    })
    return cleanMemoryText(lines.join(' | '), 4000)
  }

  compactWorkingContext() {
    const overBudget = () => this.messages.length > this.maxWorkingMessages
      || this.messages.reduce((total, message) => total + messageChars(message), 0) > this.maxWorkingChars

    while (overBudget()) {
      const start = this.messages.findIndex((message, index) => index >= this.baseMessages.length && message.role === 'assistant' && Array.isArray(message.tool_calls))
      if (start < 0) break
      let end = start + 1
      while (end < this.messages.length && this.messages[end].role === 'tool') end++
      const removed = this.messages.splice(start, end - start)
      const summary = this.summarizeToolExchange(removed)
      const previous = this.messages[start - 1]
      if (previous?.role === 'user' && typeof previous.content === 'string' && previous.content.startsWith('[OBSERVATIONS COMPACTED]')) {
        previous.content = cleanMemoryText(`${previous.content}\n${summary}`, 12000)
      }
      else {
        this.messages.splice(start, 0, { role: 'user', content: `[OBSERVATIONS COMPACTED] ${summary}` })
      }
    }
  }

  providerMessages() {
    this.compactWorkingContext()
    return this.messages.map(item => ({ ...item }))
  }

  async callProvider(current, generation, { round, allowTools = true, recoveryAttempt = 0 }) {
    await this.reserve({ epoch: current.epoch, actorId: current.actor_id })
    check(generation === this.generation && this.active && this.epoch, 'Model turn was cancelled or superseded')
    await this.assertCurrent()

    const controller = new AbortController()
    this.providerAbort = controller
    let message
    try {
      message = await this.provider(this.providerMessages(), {
        epoch: current.epoch,
        actorId: current.actor_id,
        round,
        allowTools,
        recoveryAttempt,
        signal: controller.signal,
      })
    }
    finally {
      if (this.providerAbort === controller) this.providerAbort = null
    }
    check(generation === this.generation && this.active, 'Model turn was cancelled or superseded')
    await this.assertCurrent()
    check(message && typeof message === 'object', 'Provider returned no message')
    return message
  }

  isObservationToolName(name) {
    return isObservationToolName(name)
  }

  observationToolCommand(name, args) {
    return toolCommand(name, args)
  }

  parsePlanMessage(message) {
    check(message.tool_calls === undefined, 'Provider attempted a tool call while tools were disabled')
    check(typeof message.content === 'string', 'Provider message has no strict JSON content')
    const raw = strictJson(message.content, 'provider content')
    const misplaced = Array.isArray(raw?.operations)
      ? raw.operations.find(operation => this.isObservationToolName(operation?.name))
      : undefined
    if (misplaced) {
      throw new PlanCategoryError(
        `${misplaced.name} is an observation/planning tool, not an approved world-mutation operation. Call it as a tool instead of placing it in the strict-JSON operations array.`,
        'observation_tool_as_operation',
        { tool_name: misplaced.name },
      )
    }
    return parsePlan(raw)
  }

  async commitPlan(plan) {
    const commands = plan.operations.map(renderOperation)
    const before = await this.assertCurrent()
    if (commands.length > 0) {
      await executeAuthorizedBatch(this.rcon, before.epoch, commands)
      await this.assertCurrent()
    }

    this.messages.push({ role: 'assistant', content: JSON.stringify(plan) })
    if (this.requestInfo) {
      this.memory.remember(this.requestInfo.memoryKey, this.requestInfo.turnId, {
        sender: this.requestInfo.sender,
        user: this.requestInfo.text,
        assistant: plan.chatMessage,
        operations: plan.operations,
      })
    }
    if (commands.length === 0) this.active = false
    return {
      chatMessage: plan.chatMessage,
      plan: plan.plan,
      currentStep: plan.currentStep,
      operations: plan.operations,
      epoch: before.epoch,
      actorId: before.actor_id,
    }
  }

  async recoverPlan(generation, reason, roundBase) {
    let lastError = reason instanceof Error ? reason : new AgentLoopError(String(reason))
    this.messages.push({
      role: 'user',
      content: `[HARNESS] ${lastError.message}. Stop observing and return one valid strict-JSON plan using the state already collected, or report a blocker with an empty operations array. Tool calls are disabled for recovery.`,
    })

    for (let attempt = 1; attempt <= this.maxRecoveryAttempts; attempt++) {
      const current = await this.assertCurrent()
      const message = await this.callProvider(current, generation, {
        round: roundBase + attempt - 1,
        allowTools: false,
        recoveryAttempt: attempt,
      })
      let plan
      try {
        plan = this.parsePlanMessage(message)
      }
      catch (error) {
        lastError = error
        if (typeof message.content === 'string') this.messages.push({ role: 'assistant', content: cleanMemoryText(message.content, 4000) })
        if (attempt < this.maxRecoveryAttempts) {
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Recovery attempt ${attempt} was invalid: ${error instanceof Error ? error.message : String(error)}. Retry with strict JSON only and no tool calls.`,
          })
        }
        continue
      }
      return this.commitPlan(plan)
    }

    throw new AgentLoopError(`Provider response recovery exhausted after ${this.maxRecoveryAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  prepareToolBatch(message) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length < 1) {
      throw new ToolValidationError('Invalid tool call batch', 'invalid_tool_batch')
    }
    if (message.tool_calls.length > MAX_TOOL_CALLS_PER_BATCH) {
      throw new ToolValidationError(
        `Tool call batch exceeds the maximum of ${MAX_TOOL_CALLS_PER_BATCH}`,
        'tool_batch_too_large',
        { observed_count: message.tool_calls.length, maximum: MAX_TOOL_CALLS_PER_BATCH },
      )
    }
    const prepared = message.tool_calls.map((tool) => {
      check(tool && tool.type === 'function' && typeof tool.id === 'string' && tool.id.length >= 1 && tool.id.length <= 200, 'Invalid tool call')
      check(tool.function && typeof tool.function.name === 'string' && typeof tool.function.arguments === 'string', 'Invalid tool function')
      const args = strictJson(tool.function.arguments, 'tool arguments')
      if (isApprovedOperationName(tool.function.name)) {
        throw new ToolValidationError(
          `${tool.function.name} is an approved world-mutation operation, not an observation tool. Return it in the strict-JSON operations array instead of calling it as a tool.`,
          'operation_called_as_tool',
          { operation_name: tool.function.name },
        )
      }
      const command = this.observationToolCommand(tool.function.name, args)
      return {
        tool,
        args,
        command,
        signature: toolSignature(tool.function.name, args),
      }
    })
    const throughputMeasurements = prepared.filter(entry => entry.tool.function.name === THROUGHPUT_MEASUREMENT_TOOL)
    check(
      throughputMeasurements.length === 0 || (throughputMeasurements.length === 1 && prepared.length === 1),
      'measureTransportThroughput must be called alone because it owns a bounded multi-tick observation window',
    )
    return prepared
  }

  async cancelThroughputMeasurement(measurementId) {
    try { await this.rcon.command(throughputMeasurementCancelCommand(measurementId)) }
    catch {}
  }

  async runThroughputMeasurement(entry) {
    await this.assertCurrent()
    let startRaw
    try { startRaw = String(await this.rcon.command(entry.command)).slice(0, 16000) }
    catch (error) {
      return throughputToolError('MEASUREMENT_RCON_ERROR', error instanceof Error ? error.message : String(error))
    }
    await this.assertCurrent()

    let start
    try { start = JSON.parse(startRaw) }
    catch { return throughputToolError('MEASUREMENT_PROTOCOL_ERROR', 'Invalid throughput measurement start JSON') }
    if (start?.ok !== true || start?.state !== 'running') return startRaw
    if (!Number.isSafeInteger(start.measurement_id) || start.measurement_id < 1) {
      return throughputToolError('MEASUREMENT_PROTOCOL_ERROR', 'Measurement start returned an invalid id')
    }

    const measurementId = start.measurement_id
    const deadline = Date.now() + throughputMeasurementWallMs(entry.args)
    let lastTick = Number.isFinite(start.started_tick) ? start.started_tick : undefined
    let lastProgressAt = Date.now()

    try {
      while (Date.now() <= deadline) {
        await delay(THROUGHPUT_POLL_MS)
        await this.assertCurrent()
        let raw
        try { raw = String(await this.rcon.command(throughputMeasurementStatusCommand(measurementId))).slice(0, 16000) }
        catch (error) {
          await this.cancelThroughputMeasurement(measurementId)
          return throughputToolError('MEASUREMENT_RCON_ERROR', error instanceof Error ? error.message : String(error), measurementId)
        }
        await this.assertCurrent()

        let status
        try { status = JSON.parse(raw) }
        catch {
          await this.cancelThroughputMeasurement(measurementId)
          return throughputToolError('MEASUREMENT_PROTOCOL_ERROR', 'Invalid throughput measurement status JSON', measurementId)
        }
        if (status?.state !== 'running') return raw

        if (Number.isFinite(status.current_tick) && (lastTick === undefined || status.current_tick > lastTick)) {
          lastTick = status.current_tick
          lastProgressAt = Date.now()
        }
        if (Date.now() - lastProgressAt > THROUGHPUT_NO_PROGRESS_MS) {
          await this.cancelThroughputMeasurement(measurementId)
          return throughputToolError('MEASUREMENT_CLOCK_STALLED', 'Factorio simulation tick did not advance while measuring throughput', measurementId)
        }
      }

      await this.cancelThroughputMeasurement(measurementId)
      return throughputToolError('MEASUREMENT_WALL_TIMEOUT', 'Throughput measurement exceeded its bounded wall-clock budget', measurementId)
    }
    catch (error) {
      await this.cancelThroughputMeasurement(measurementId)
      throw error
    }
  }

  async handleToolBatch(message, prepared = this.prepareToolBatch(message)) {
    this.messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls })
    let duplicateThisRound = false

    for (const entry of prepared) {
      const cached = this.toolCache.get(entry.signature)
      let output

      if (cached !== undefined) {
        duplicateThisRound = true
        output = `[HARNESS] Duplicate observation suppressed. Reuse this cached result and act or report a blocker instead of repeating the same tool call.\n${cached}`
      }
      else if (entry.tool.function.name === STATIC_PROTOTYPE_TOOL) {
        const staticEntry = this.staticPrototypeCache.get(entry.signature)
        if (staticEntry) {
          const alreadyReferenced = this.prototypeRefsThisRequest.includes(entry.signature)
          this.rememberPrototypeRef(entry.signature)
          output = alreadyReferenced ? prototypeUnchangedResult(staticEntry) : prototypeBaselineResult(staticEntry)
          this.toolCache.set(entry.signature, output)
        }
        else {
          await this.assertCurrent()
          output = String(await this.rcon.command(entry.command)).slice(0, 12000)
          await this.assertCurrent()
          this.toolCache.set(entry.signature, output)
          this.cachePrototype(entry.signature, entry.args?.name, output)
        }
      }
      else {
        if (entry.tool.function.name === THROUGHPUT_MEASUREMENT_TOOL) {
          output = await this.runThroughputMeasurement(entry)
        }
        else {
          await this.assertCurrent()
          output = String(await this.rcon.command(entry.command)).slice(0, 12000)
          await this.assertCurrent()
        }
        this.toolCache.set(entry.signature, output)
      }
      this.messages.push({ role: 'tool', tool_call_id: entry.tool.id, content: String(output).slice(0, 16000) })
    }

    if (duplicateThisRound) this.duplicateToolRounds++
    else {
      this.duplicateToolRounds = 0
      this.observationRecoveryRounds = 0
    }
    this.observationOnlyRounds++
    this.compactWorkingContext()
  }

  async recoveryDiagnostic(_details) {}

  finiteNoOperationPressure(_plan) {
    return ''
  }

  async blockedWithoutMutation(reason, failureClass = 'harness_blocker') {
    const current = await this.assertCurrent()
    this.active = false
    return {
      chatMessage: `Blocked before mutation: ${cleanMemoryText(reason, 800)}`,
      plan: [],
      currentStep: 0,
      operations: [],
      epoch: current.epoch,
      actorId: current.actor_id,
      blocked: true,
      blocker: { class: failureClass, reason: cleanMemoryText(reason, 1200) },
    }
  }

  async runTurn() {
    const generation = this.generation
    for (let round = 0; round < this.maxToolRounds; round++) {
      const current = await this.assertCurrent()
      const message = await this.callProvider(current, generation, {
        round,
        allowTools: this.observationDecisionForced !== true,
      })

      if (message.tool_calls !== undefined && this.observationDecisionForced) {
        this.toolValidationRetries++
        await this.recoveryDiagnostic({
          failure_class: 'tool_validation',
          reason_code: 'observation_phase_closed',
          reason: 'Provider returned observation tools after the runtime closed the observation phase for this decision.',
          retry: this.toolValidationRetries,
          retry_limit: this.maxToolValidationRetries,
          tools_enabled: false,
        })
        if (this.toolValidationRetries > this.maxToolValidationRetries) {
          return this.blockedWithoutMutation(
            'Provider repeatedly requested observation tools after the runtime closed the observation phase. Grounded evidence was preserved.',
            'tool_validation',
          )
        }
        this.messages.push({
          role: 'user',
          content: `[HARNESS] Observation phase is closed for this decision (${this.toolValidationRetries}/${this.maxToolValidationRetries}). Tools are disabled. Reuse the grounded evidence already collected and return strict JSON with the next executable action or a truthful blocker.`,
        })
        continue
      }

      if (message.tool_calls !== undefined) {
        let prepared
        try {
          prepared = this.prepareToolBatch(message)
        }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          const code = typeof error?.code === 'string' ? error.code : 'invalid_tool_call'
          this.toolValidationRetries++
          await this.recoveryDiagnostic({
            failure_class: 'tool_validation',
            reason_code: code,
            reason,
            retry: this.toolValidationRetries,
            retry_limit: this.maxToolValidationRetries,
            tools_enabled: true,
            ...(error?.details && typeof error.details === 'object' ? error.details : {}),
          })
          if (this.toolValidationRetries > this.maxToolValidationRetries) {
            return this.blockedWithoutMutation(
              `Tool validation failed repeatedly (${code}): ${reason}. Deterministic observations collected earlier were preserved.`,
              'tool_validation',
            )
          }
          const instruction = code === 'tool_batch_too_large'
            ? `The runtime allows at most ${MAX_TOOL_CALLS_PER_BATCH} observation tool calls in one provider turn. Keep the observations already collected, choose the smallest necessary subset, and retry with no more than ${MAX_TOOL_CALLS_PER_BATCH} tool calls. Tools remain enabled; do not emit a world mutation merely to recover from this formatting error.`
            : 'Retry using only an approved observation tool name and strict JSON arguments matching its schema. Tools remain enabled; do not repeat the rejected payload.'
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Tool-validation failure (${this.toolValidationRetries}/${this.maxToolValidationRetries}; ${code}): ${reason}. ${instruction}`,
          })
          continue
        }
        this.toolValidationRetries = 0
        if (this.observationDecisionPressure && prepared.length > this.observationDecisionPressureRemaining) {
          await this.forceDecisionFromObservations(
            `Observation decision pressure had ${this.observationDecisionPressureRemaining} targeted observation call(s) remaining, but the provider requested ${prepared.length}.`,
            'observation_decision_budget_exhausted',
          )
          continue
        }
        await this.handleToolBatch(message, prepared)
        if (this.observationDecisionForced) continue
        if (this.duplicateToolRounds >= this.maxToolLoopRetries && this.duplicateToolRounds > 0) {
          const reason = `Repeated tool observation loop after ${this.duplicateToolRounds} no-progress round${this.duplicateToolRounds === 1 ? '' : 's'}`
          this.observationRecoveryRounds++
          await this.recoveryDiagnostic({
            failure_class: 'observation_no_progress',
            reason_code: 'duplicate_observation',
            reason,
            retry: this.observationRecoveryRounds,
            retry_limit: this.maxToolLoopRetries + 1,
            tools_enabled: true,
          })
          if (this.duplicateToolRounds > this.maxToolLoopRetries) {
            return this.recoverPlan(
              generation,
              new AgentLoopError(`${reason}. Observation retries are exhausted. Reuse the deterministic observations already collected and make the next decision from that evidence. Return one valid strict-JSON plan with the next executable action when the evidence supports it, or a truthful blocker with no mutation when a required fact is still missing.`),
              round + 1,
            )
          }
          this.messages.push({
            role: 'user',
            content: `[HARNESS] ${reason}. The duplicate result was suppressed and earlier deterministic observations remain available. Tools stay enabled only for a specific missing fact: do not switch to a different read-only observation merely to avoid the duplicate guard. If the existing evidence already identifies a safe executable next action, return a strict-JSON plan now; otherwise make one targeted observation for the exact missing fact or report a truthful blocker. Do not guess an unobserved Factorio identity and do not force a mutation just to make progress.`,
          })
        }
        if (this.observationDecisionPressure) {
          this.observationDecisionPressureRemaining = Math.max(0, this.observationDecisionPressureRemaining - prepared.length)
          if (this.observationDecisionPressureRemaining <= 0) {
            await this.forceDecisionFromObservations(
              'The targeted observation budget allowed by decision pressure is complete.',
              'observation_decision_budget_complete',
            )
            continue
          }
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Decision-pressure observation budget: ${this.observationDecisionPressureRemaining} targeted observation call(s) remain. Reuse existing evidence first; spend another observation only on a fact still required to choose or parameterize the next action.`,
          })
        }
        else if (this.observationOnlyRounds >= OBSERVATION_DECISION_PRESSURE_ROUNDS) {
          const allowance = Math.max(0, Math.min(8, Math.trunc(this.observationDecisionPressureBudget())))
          this.observationDecisionPressure = true
          this.observationDecisionPressureRemaining = allowance
          await this.recoveryDiagnostic({
            failure_class: 'observation_no_progress',
            reason_code: 'observation_decision_pressure',
            reason: `Consecutive observation-only rounds reached ${this.observationOnlyRounds}; targeted allowance ${allowance}`,
            retry: 1,
            retry_limit: Math.max(1, allowance),
            tools_enabled: allowance > 0,
          })
          if (allowance <= 0) {
            await this.forceDecisionFromObservations(
              'Observation decision pressure permits no additional observations for this decision.',
              'observation_decision_budget_zero',
            )
            continue
          }
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Decision pressure after ${this.observationOnlyRounds} consecutive observation-only rounds. If the live evidence already parameterizes a safe executable next action, return one strict-JSON plan now. Otherwise you may spend up to ${allowance} additional targeted observation call(s), only on facts still required for this decision. Do not switch among unrelated read-only tools merely to defer the decision.`,
          })
        }
        continue
      }

      let plan
      try {
        plan = this.parsePlanMessage(message)
      }
      catch (error) {
        if (error?.failureClass === 'plan_category') {
          this.planCategoryRetries++
          const reason = error instanceof Error ? error.message : String(error)
          await this.recoveryDiagnostic({
            failure_class: 'plan_category',
            reason_code: error.code,
            reason,
            retry: this.planCategoryRetries,
            retry_limit: this.maxToolValidationRetries,
            tools_enabled: true,
            ...(error?.details && typeof error.details === 'object' ? error.details : {}),
          })
          if (error?.details?.deterministic_no_retry === true) {
            return this.blockedWithoutMutation(
              `${reason} The harness stopped this request without changing canonical task state because repeating the same deterministically invalid repair cannot create a live exact-entity binding.`,
              'plan_category',
            )
          }
          if (this.planCategoryRetries > this.maxToolValidationRetries) {
            return this.blockedWithoutMutation(error?.details?.tool_name !== undefined
              ? `Provider repeatedly placed an observation tool in operations (${error.details.tool_name}).`
              : `Provider repeatedly returned a plan the harness refused (${error.code ?? 'plan_category'}): ${reason}`, 'plan_category')
          }
          this.messages.push({ role: 'assistant', content: cleanMemoryText(message.content, 4000) })
          const toolInstruction = this.observationDecisionForced
            ? 'Tools remain disabled because the observation phase for this decision is closed. Reuse the evidence already collected and return a corrected strict-JSON plan or truthful blocker.'
            : 'Tools remain enabled. Preserve the observations and canonical Task Board already collected. Use the supplied correction exactly: issue one required observation tool call when a fact is missing, otherwise return a strict-JSON plan containing only safe approved world-mutation operations.'
          this.messages.push({
            role: 'user',
            content: `[HARNESS] Plan/tool category or targeting error (${this.planCategoryRetries}/${this.maxToolValidationRetries}; ${error.code}): ${reason} ${toolInstruction} Do not bypass an observed exact identity with an ambiguous name-based mutation.`,
          })
          continue
        }
        return this.recoverPlan(generation, error, round + 1)
      }
      this.planCategoryRetries = 0
      const finitePressure = this.finiteNoOperationPressure(plan)
      if (finitePressure && !this.finiteNoOperationPressureUsed) {
        this.finiteNoOperationPressureUsed = true
        await this.recoveryDiagnostic({
          failure_class: 'finite_goal_no_operation',
          reason_code: 'finite_goal_continuation_pressure',
          reason: cleanMemoryText(finitePressure, 1200),
          retry: 1,
          retry_limit: 1,
          tools_enabled: true,
        })
        this.messages.push({ role: 'user', content: `[HARNESS] ${finitePressure}` })
        continue
      }
      return this.commitPlan(plan)
    }

    return this.recoverPlan(
      generation,
      new AgentLoopError(`Tool observation budget reached after ${this.maxToolRounds} rounds`),
      this.maxToolRounds,
    )
  }
}
