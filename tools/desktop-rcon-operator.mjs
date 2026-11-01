import { createServer } from 'node:http'

import { Rcon } from '../deploy/pterodactyl/runtime-v8/common.mjs'
import {
  isObservationToolName,
  parseOperation,
  renderOperation,
  renderOperationPreflight,
  toolCommand,
} from '../deploy/pterodactyl/runtime-v8/structured-policy.mjs'

const MAX_REQUEST_BYTES = 64 * 1024

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function parseJsonOutput(output) {
  try { return JSON.parse(output) }
  catch { return output }
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw fail(413, 'request_too_large', 'Request body exceeds 64 KiB')
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
    return value
  }
  catch (error) {
    if (error.status) throw error
    throw fail(400, 'invalid_json', error instanceof Error ? error.message : 'Invalid JSON')
  }
}

function writeJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`${JSON.stringify(body)}\n`)
}

function authorized(request, token) {
  return request.headers.authorization === `Bearer ${token}`
}

export function createDesktopOperator({ rcon, token }) {
  if (!rcon || typeof rcon.command !== 'function') throw new TypeError('rcon.command is required')
  if (typeof token !== 'string' || token.length < 16) throw new TypeError('DESKTOP_OPERATOR_TOKEN must be at least 16 characters')

  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        writeJson(response, 200, { ok: true, service: 'desktop-rcon-operator' })
        return
      }
      if (!authorized(request, token)) throw fail(401, 'unauthorized', 'A valid bearer token is required')
      if (request.method !== 'POST') throw fail(405, 'method_not_allowed', 'Use POST')

      const body = await readJson(request)
      if (request.url === '/observe') {
        if (!isObservationToolName(body.name)) throw fail(400, 'unapproved_observation', 'Observation tool is not approved')
        const output = await rcon.command(toolCommand(body.name, body.args ?? {}))
        writeJson(response, 200, { ok: true, name: body.name, output: parseJsonOutput(output) })
        return
      }
      if (request.url === '/operate') {
        const operation = parseOperation({ name: body.name, args: body.args ?? {} })
        const preflightCommand = renderOperationPreflight(operation)
        let preflight = null
        if (preflightCommand) {
          preflight = parseJsonOutput(await rcon.command(preflightCommand))
          if (!preflight || typeof preflight !== 'object' || preflight.ok !== true) {
            writeJson(response, 409, { ok: false, code: 'preflight_rejected', operation, preflight })
            return
          }
        }
        const output = await rcon.command(`/c ${renderOperation(operation)}`)
        writeJson(response, 202, { ok: true, operation, preflight, admission: parseJsonOutput(output) })
        return
      }
      throw fail(404, 'not_found', 'Unknown endpoint')
    }
    catch (error) {
      writeJson(response, error?.status ?? 500, { ok: false, code: error?.code ?? 'operator_error', error: error instanceof Error ? error.message : String(error) })
    }
  })
}

async function main() {
  const token = process.env.DESKTOP_OPERATOR_TOKEN ?? ''
  const password = process.env.SGLUNA_RCON_PASSWORD ?? ''
  const host = process.env.SGLUNA_RCON_HOST ?? '127.0.0.1'
  const port = Number.parseInt(process.env.SGLUNA_RCON_PORT ?? '27015', 10)
  const listenPort = Number.parseInt(process.env.DESKTOP_OPERATOR_PORT ?? '24181', 10)
  const listenHost = process.env.DESKTOP_OPERATOR_BIND ?? '127.0.0.1'
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SGLUNA_RCON_PORT must be a TCP port')
  if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('DESKTOP_OPERATOR_PORT must be a TCP port')
  if (listenHost !== '127.0.0.1' && listenHost !== '0.0.0.0') throw new Error('DESKTOP_OPERATOR_BIND must be 127.0.0.1 or 0.0.0.0')

  const rcon = new Rcon(port, password, 5000, { host })
  await rcon.connect()
  const server = createDesktopOperator({ rcon, token })
  server.listen(listenPort, listenHost, () => console.log(`Desktop operator listening on ${listenHost}:${listenPort}`))
  const stop = () => server.close(() => { rcon.close(); process.exit(0) })
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
