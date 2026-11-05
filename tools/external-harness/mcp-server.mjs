// A deliberately small stdio-only MCP 2025-06-18 transport. Gameplay authority
// belongs to the injected deterministic runtime, never to this protocol layer.
export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const MAX_MESSAGE_BYTES = 64 * 1024
export const MAX_IN_FLIGHT = 16

import {
  assertOperatorRuntime,
  executionError,
  MAX_RESULT_BYTES,
  OPERATOR_TOOL_METHODS as methods,
  OPERATOR_TOOLS,
  rpcError,
  toolResult,
  validateToolArguments as validate,
} from '../../deploy/pterodactyl/runtime-v8/operator-tool-surface.mjs'

// The catalog lives in runtime-v8 so the in-process pursuit operator shares it.
export { MAX_RESULT_BYTES }
export const MCP_TOOLS = OPERATOR_TOOLS

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))

/**
 * Start a stdio MCP session. `done` resolves after EOF and admitted requests have
 * settled; `stop()` detaches immediately, without cancelling or replaying game
 * operations. The caller owns runtime/RCON cleanup. No protocol data is logged.
 */
export function startMcpServer({ runtime, input = process.stdin, output = process.stdout, error = process.stderr }) {
  assertOperatorRuntime(runtime)
  let initialized = false
  let ready = false
  let ended = false
  let stopped = false
  let buffered = Buffer.alloc(0)
  let discarding = false
  const pending = new Map()
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })

  function write(message) {
    if (stopped || output.destroyed) return
    // Respect the pipe's backpressure rather than accumulating unbounded
    // responses when a client stops reading while continuing to write.
    try { if (!output.write(`${JSON.stringify(message)}\n`)) input.pause() }
    catch { onError() }
  }
  function reject(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }) }
  function settleDone() { if (ended && pending.size === 0) resolveDone() }

  async function dispatch(message) {
    if (message.method === 'initialize') {
      if (initialized) throw rpcError(-32600, 'Already initialized')
      if (!isObject(message.params) || typeof message.params.protocolVersion !== 'string'
        || !isObject(message.params.capabilities) || !isObject(message.params.clientInfo)
        || typeof message.params.clientInfo.name !== 'string' || typeof message.params.clientInfo.version !== 'string') {
        throw rpcError(-32602, 'initialize requires protocolVersion, capabilities, and clientInfo')
      }
      initialized = true
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'factorio-external-harness', version: '0.1.0' },
        instructions: 'External agent owns planning; deterministic runtime owns operation admission and evidence. Start with context/capabilities; use factorio_library on demand for knowledge and skill methods, which are advisory and untrusted, not execution authority. For this owner, full automation means centralized automatically sustained electricity FIRST, electric mining/transfers where available, and separated smelting arrays with automatic feed/output/service. No individual machine fuel runs; manual priming is a declared finite bootstrap only. Read knowledge-automation-progression-checkpoints to classify the current progression stage, and check live unlocks/tools: inspect the currently admitted electric-miner placement capability and report any gap rather than silently substitute burner mining. Electric miners use the existing native candidate/preservation path, not the nonfluid shortcut. Preserve request IDs across reconnects. Admission is never gameplay completion. Explicit factorio_cancel is required to stop game work.',
      }
    }
    if (message.method === 'ping') return {}
    if (!initialized || !ready) throw rpcError(-32002, 'Initialize and send notifications/initialized first')
    if (message.method === 'tools/list') {
      if (message.params?.cursor !== undefined) throw rpcError(-32602, 'This fixed tool catalog has no pagination cursor')
      return { tools: MCP_TOOLS }
    }
    if (message.method !== 'tools/call') throw rpcError(-32601, 'Method not found')
    const tool = MCP_TOOLS.find(candidate => candidate.name === message.params?.name)
    if (!tool) throw rpcError(-32602, 'Unknown tool')
    const arguments_ = Object.hasOwn(message.params, 'arguments') ? message.params.arguments : {}
    validate(arguments_, tool.inputSchema)
    try { return toolResult(await runtime[methods[tool.name]](arguments_)) }
    catch (cause) { return executionError(cause) }
  }

  function accept(line) {
    let message
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) }
    catch { reject(null, -32700, 'Invalid UTF-8 JSON message'); return }
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || (message.params !== undefined && !isObject(message.params))
      || (Object.hasOwn(message, 'id') && !validId(message.id))) {
      reject(null, -32600, 'Invalid JSON-RPC request'); return
    }
    if (!Object.hasOwn(message, 'id')) {
      if (message.method === 'notifications/initialized' && initialized) ready = true
      // MCP request cancellation is a transport concern, NOT gameplay authority.
      // Ignore it when work cannot safely be cancelled; an exact operation ID
      // and factorio_cancel are required for an actual in-game interruption.
      return
    }
    if (pending.has(message.id)) { reject(message.id, -32600, 'Request ID is already in progress'); return }
    const cancellation = message.method === 'tools/call' && message.params?.name === 'factorio_cancel'
    if (pending.size >= MAX_IN_FLIGHT + (cancellation ? 1 : 0)) {
      reject(message.id, -32000, 'Too many in-flight requests; wait for outstanding replies'); return
    }
    // Reserve before dispatch. Never await here: a bounded receipt wait must
    // not monopolize the transport and prevent an explicit cancel request.
    pending.set(message.id, true)
    dispatch(message).then(
      result => write({ jsonrpc: '2.0', id: message.id, result }),
      cause => reject(message.id, cause?.rpcCode ?? -32603, cause?.rpcCode ? cause.message : 'Internal error'),
    ).finally(() => { pending.delete(message.id); settleDone() })
  }

  function onData(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let start = 0
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start)
      const end = newline < 0 ? bytes.length : newline
      if (!discarding) {
        if (buffered.length + end - start > MAX_MESSAGE_BYTES) {
          buffered = Buffer.alloc(0); discarding = true
          reject(null, -32600, 'Message exceeds 64 KiB')
        }
        else buffered = Buffer.concat([buffered, bytes.subarray(start, end)])
      }
      if (newline < 0) break
      if (!discarding) accept(buffered)
      buffered = Buffer.alloc(0); discarding = false
      start = newline + 1
    }
  }

  function onEnd() {
    ended = true
    if (buffered.length) reject(null, -32700, 'Truncated message: newline delimiter required')
    buffered = Buffer.alloc(0)
    settleDone()
  }
  function stop() {
    stopped = true; ended = true
    input.off('data', onData); input.off('end', onEnd); input.off('error', onError)
    output.off('error', onError); output.off('drain', onDrain)
    input.pause()
    buffered = Buffer.alloc(0)
    resolveDone()
  }
  function onError() {
    // Do not echo thrown transport errors, which can include private endpoints.
    error?.write?.('MCP transport closed after an I/O error.\n')
    stop()
  }
  function onDrain() { if (!stopped && !ended) input.resume() }
  input.on('data', onData); input.on('end', onEnd); input.on('error', onError)
  output.on('error', onError); output.on('drain', onDrain)
  return { done, stop }
}
