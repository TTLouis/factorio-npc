#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MCP_PROTOCOL_VERSION } from './mcp-server.mjs'

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
// The server can wait 30 seconds for an exact receipt. Include bounded margin
// for transport/scheduling rather than severing that ordinary operation early.
export const DEFAULT_REQUEST_TIMEOUT_MS = 45000
const fail = code => Object.assign(new Error(code), { code })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// One short-lived, exclusive stdio connection. Never logs environment, child
// stderr or a failed child's arguments; those can contain private host data.
export async function withMcpClient(action, { command = process.execPath, args = [cli], env = process.env, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let sequence = 0
  let buffer = ''
  let failure
  let exited = false
  let primaryError
  let cleanupCode
  let result
  const exit = new Promise(resolve => {
    child.once('error', () => { exited = true; stop(fail('mcp_start_failed')); resolve(null) })
    child.once('close', code => { exited = true; stop(fail('mcp_exited')); resolve(code) })
  })
  function stop(error) {
    failure ??= error
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    pending.clear()
  }
  child.stderr.resume()
  child.stdin.on('error', () => stop(fail('mcp_input_failed')))
  child.stdout.on('error', () => stop(fail('mcp_output_failed')))
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 1024 * 1024) { stop(fail('mcp_reply_too_large')); child.kill(); return }
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n')
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let message
      try { message = JSON.parse(line) }
      catch { stop(fail('mcp_reply_invalid')); child.kill(); return }
      if (!object(message) || message.jsonrpc !== '2.0' || !pending.has(message.id)
        || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) {
        stop(fail('mcp_reply_invalid')); child.kill(); return
      }
      const entry = pending.get(message.id)
      pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message)
    }
  })
  function request(method, params = {}) {
    if (failure) return Promise.reject(failure)
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(fail('mcp_request_timeout')) }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  try {
    const initialized = await request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'factorio-local-process-adapter', version: '0.1.0' } })
    if (initialized.error || initialized.result?.protocolVersion !== MCP_PROTOCOL_VERSION) throw fail('mcp_initialize_failed')
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    result = await action({ request, initialize: initialized })
  }
  catch (error) { primaryError = error }
  finally {
    child.stdin.end()
    let timer
    const code = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 3000) })])
    clearTimeout(timer)
    if (code === 'timeout') {
      child.kill()
      await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 1000) })])
      clearTimeout(timer)
      if (!exited) {
        child.kill('SIGKILL')
        await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 1000) })])
        clearTimeout(timer)
      }
    }
    cleanupCode = !exited ? 'mcp_cleanup_unverified' : code === 'timeout' ? 'mcp_close_timeout'
      : code !== 0 ? 'mcp_child_failed' : buffer.trim() ? 'mcp_reply_truncated' : undefined
  }
  if (primaryError) {
    if (cleanupCode) primaryError.cleanupCode = cleanupCode
    throw primaryError
  }
  if (cleanupCode) throw fail(cleanupCode)
  return result
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node tools/external-harness/mcp-call.mjs --list | --call TOOL --arguments JSON\nUses the same private environment as cli.mjs. Returns the complete MCP JSON-RPC envelope. Never binds or retries gameplay.\n')
    return
  }
  let method
  let params
  if (args.length === 1 && args[0] === '--list') { method = 'tools/list'; params = {} }
  else if (args.length === 4 && args[0] === '--call' && args[2] === '--arguments') {
    let arguments_
    try { arguments_ = JSON.parse(args[3]) } catch { throw fail('invalid_arguments_json') }
    if (!object(arguments_)) throw fail('invalid_arguments_json')
    method = 'tools/call'; params = { name: args[1], arguments: arguments_ }
  }
  else throw fail('invalid_adapter_arguments')
  const result = await withMcpClient(client => client.request(method, params))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.error || result.result?.isError) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'mcp_adapter_failed'
    process.stderr.write(`Local MCP adapter stopped: ${code}. No automatic gameplay replay was attempted.\n`)
    process.exitCode = 1
  })
}
