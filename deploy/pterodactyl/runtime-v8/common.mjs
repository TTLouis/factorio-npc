import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

export class DeploymentError extends Error {}
export function check(ok, message) { if (!ok) throw new DeploymentError(message) }
export const nonce = () => crypto.randomBytes(16).toString('hex')

export async function stat(filename) {
  try { return await fsp.lstat(filename) }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

export async function directory(filename) {
  const current = await stat(filename)
  if (!current) await fsp.mkdir(filename, { recursive: true })
  else check(current.isDirectory() && !current.isSymbolicLink(), `Expected directory: ${filename}`)
  return filename
}

export async function regularFile(filename, { nonempty = true } = {}) {
  const current = await stat(filename)
  check(current?.isFile() && !current.isSymbolicLink(), `Expected regular file: ${filename}`)
  if (nonempty) check(current.size > 0, `Expected non-empty file: ${filename}`)
  return current
}

export async function atomicWrite(filename, contents, mode) {
  await directory(path.dirname(filename))
  const temp = `${filename}.tmp-${nonce()}`
  await fsp.writeFile(temp, contents, mode === undefined ? undefined : { mode })
  await fsp.rename(temp, filename)
}

export async function readJson(filename, fallback) {
  try { return JSON.parse(await fsp.readFile(filename, 'utf8')) }
  catch (error) {
    if (fallback !== undefined && error?.code === 'ENOENT') return fallback
    throw error
  }
}

export function safeInteger(value, label, min, max) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  check(Number.isSafeInteger(number) && number >= min && number <= max, `${label} must be an integer from ${min} to ${max}`)
  return number
}

export function cleanString(value, label, max = 256) {
  check(typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), `Invalid ${label}`)
  return value
}

export function parseChatPlayers(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '' || trimmed === '*') return { mode: 'all', names: [] }
  if (trimmed.toLowerCase() === 'none') return { mode: 'disabled', names: [] }
  const seen = new Set()
  const names = []
  for (const part of trimmed.split(',')) {
    const name = part.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return { mode: 'allowlist', names }
}

export function chatAuthorized(chatPlayers, sender) {
  if (!sender) return false
  if (chatPlayers.mode === 'all') return true
  if (chatPlayers.mode === 'disabled') return false
  return chatPlayers.names.includes(sender)
}

export function describeChatPlayers(chatPlayers) {
  return chatPlayers.mode === 'allowlist' ? `allowlist:${chatPlayers.names.length}` : chatPlayers.mode
}

export function describeRelease(manifest) {
  const release = typeof manifest?.releaseRevision === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(manifest.releaseRevision)
    ? manifest.releaseRevision
    : (typeof manifest?.revision === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(manifest.revision) ? manifest.revision : 'unknown')
  const source = typeof manifest?.source === 'string' && /^[a-f0-9]{40}$/.test(manifest.source)
    ? manifest.source.slice(0, 12)
    : 'unknown'
  return `Release revision=${release} source=${source}`
}

export function redact(values, text) {
  let output = String(text)
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 4) output = output.split(value).join('[REDACTED]')
  }
  return output
}

export async function freeTcpPort(excluded = []) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = net.createServer()
    server.unref()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise(resolve => server.close(resolve))
    if (port > 0 && !excluded.includes(port)) return port
  }
  throw new DeploymentError('Unable to reserve a local RCON port')
}

export async function withTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeploymentError(message)), timeoutMs)
  })
  try { return await Promise.race([promise, timeout]) }
  finally { clearTimeout(timer) }
}

export class Child {
  constructor(command, args, { cwd, env = process.env, log = () => {}, label = path.basename(command) } = {}) {
    this.label = label
    this.log = log
    this.input = null
    this.proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.proc.stdin.on('error', error => {
      if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_DESTROYED') {
        this.log(`${this.label} stdin forwarding failed: ${error instanceof Error ? error.message : error}`)
      }
    })
    this.result = null
    this.closed = new Promise(resolve => {
      this.proc.once('exit', (code, signal) => {
        this.detachInput()
        this.result = { code, signal }
        resolve(this.result)
      })
    })
    const consume = stream => {
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line) this.log(line)
        if (pending.length > 65536) { this.log(pending.slice(0, 65536)); pending = '' }
      })
      stream.on('end', () => { if (pending) this.log(pending) })
    }
    consume(this.proc.stdout)
    consume(this.proc.stderr)
  }

  alive() { return this.result === null && this.proc.exitCode === null && !this.proc.killed }

  attachInput(stream) {
    this.detachInput()
    check(stream && typeof stream.on === 'function' && typeof stream.off === 'function', 'Child input stream must support on/off listeners')
    const onData = chunk => {
      if (!this.alive() || !this.proc.stdin?.writable || this.proc.stdin.destroyed) return
      try {
        this.proc.stdin.write(chunk, error => {
          if (error && error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
            this.log(`${this.label} stdin forwarding failed: ${error.message}`)
          }
        })
      }
      catch (error) {
        if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_DESTROYED') {
          this.log(`${this.label} stdin forwarding failed: ${error instanceof Error ? error.message : error}`)
        }
      }
    }
    stream.on('data', onData)
    this.input = { stream, onData }
    return this
  }

  detachInput() {
    if (!this.input) return
    const { stream, onData } = this.input
    stream.off('data', onData)
    if (typeof stream.listenerCount === 'function' && stream.listenerCount('data') === 0 && typeof stream.pause === 'function') {
      stream.pause()
    }
    this.input = null
  }

  signal(signal) {
    if (!this.alive()) return false
    try {
      if (process.platform !== 'win32') process.kill(-this.proc.pid, signal)
      else this.proc.kill(signal)
      return true
    }
    catch { return false }
  }

  async stop(timeoutMs = 30000, signal = 'SIGTERM') {
    this.detachInput()
    if (!this.alive()) return { forced: false, result: await this.closed }
    this.signal(signal)
    try {
      const result = await withTimeout(this.closed, timeoutMs, `${this.label} stop timed out`)
      return { forced: false, result }
    }
    catch (error) {
      if (!(error instanceof DeploymentError) || error.message !== `${this.label} stop timed out`) throw error
      this.signal('SIGKILL')
      const forcedTimeoutMs = Math.min(timeoutMs, 5000)
      const result = await withTimeout(this.closed, forcedTimeoutMs, `${this.label} did not exit after SIGKILL`)
      return { forced: true, result }
    }
  }
}

function encodePacket(id, type, text) {
  const payload = Buffer.from(String(text), 'utf8')
  const packet = Buffer.alloc(payload.length + 14)
  packet.writeInt32LE(payload.length + 10, 0)
  packet.writeInt32LE(id, 4)
  packet.writeInt32LE(type, 8)
  payload.copy(packet, 12)
  packet.writeInt16LE(0, 12 + payload.length)
  return packet
}

function taskBoardUiRconCommand(text) {
  const command = String(text)
  return command.includes('remote.call("autorio_task_board"') || command.includes("remote.call('autorio_task_board'")
}

const UI_RCON_READY_COMMAND = '/silent-command rcon.print("AIRI_UI_RCON_READY")'

export class Rcon {
  constructor(port, password, timeout = 5000, { auxiliary = false, host = '127.0.0.1' } = {}) {
    this.port = port
    this.password = password
    this.timeout = timeout
    this.auxiliary = auxiliary
    this.host = host
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.sequence = 10
    this.pending = new Map()
    this.queue = Promise.resolve()
    this.uiRcon = null
    this.uiConnect = null
    this.closed = false
  }

  async connect() {
    check(!this.socket, 'RCON is already connected')
    this.closed = false
    const socket = net.createConnection({ host: this.host, port: this.port })
    this.socket = socket
    socket.on('data', chunk => this.receive(chunk))
    socket.on('error', error => this.failAll(error))
    socket.on('close', () => this.failAll(new DeploymentError('RCON socket closed')))
    await withTimeout(once(socket, 'connect'), this.timeout, 'Timed out connecting to RCON')
    const id = ++this.sequence
    const auth = this.request(id, 3, this.password, 2)
    socket.write(encodePacket(id, 3, this.password))
    await auth
    return this
  }

  close() {
    this.closed = true
    const uiRcon = this.uiRcon
    const uiConnect = this.uiConnect
    this.uiRcon = null
    this.uiConnect = null
    if (uiRcon) uiRcon.close()
    else if (uiConnect) uiConnect.then(lane => lane.close()).catch(() => {})

    const socket = this.socket
    this.socket = null
    if (socket) socket.destroy()
    this.failAll(new DeploymentError('RCON connection closed'))
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error instanceof Error ? error : new DeploymentError(String(error)))
    }
    this.pending.clear()
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0)
      if (size < 10 || size > 1024 * 1024) { this.close(); return }
      if (this.buffer.length < size + 4) return
      const packet = this.buffer.subarray(4, size + 4)
      this.buffer = this.buffer.subarray(size + 4)
      const id = packet.readInt32LE(0)
      const type = packet.readInt32LE(4)
      const body = packet.subarray(8, -2).toString('utf8')
      const pending = this.pending.get(id)
      if (!pending) continue
      if (id === -1 || (pending.expectedType !== undefined && type !== pending.expectedType)) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(new DeploymentError('RCON authentication or packet validation failed'))
        continue
      }
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.resolve(body)
    }
  }

  request(id, type, text, expectedType) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new DeploymentError('RCON request timed out'))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer, expectedType, type, text })
    })
  }

  async taskBoardLane() {
    check(!this.auxiliary, 'Auxiliary RCON cannot create another Task Board lane')
    check(this.socket && !this.socket.destroyed && !this.closed, 'RCON is not connected')

    if (this.uiRcon?.socket && !this.uiRcon.socket.destroyed) {
      this.uiRcon.timeout = this.timeout
      return this.uiRcon
    }
    if (this.uiRcon) {
      this.uiRcon.close()
      this.uiRcon = null
    }

    if (!this.uiConnect) {
      const lane = new Rcon(this.port, this.password, this.timeout, { auxiliary: true, host: this.host })
      this.uiConnect = (async () => {
        await lane.connect()
        let ready = String(await lane.command(UI_RCON_READY_COMMAND) ?? '').trim()
        // Factorio asks for the first Lua console command to be repeated exactly
        // before enabling it. Prime that confirmation on the dedicated UI socket
        // so a changing set_snapshot payload cannot get stuck behind the prompt.
        if (ready !== 'AIRI_UI_RCON_READY') ready = String(await lane.command(UI_RCON_READY_COMMAND) ?? '').trim()
        check(ready === 'AIRI_UI_RCON_READY', 'Task Board RCON handshake failed')
        if (this.closed || !this.socket || this.socket.destroyed) {
          lane.close()
          throw new DeploymentError('RCON is not connected')
        }
        lane.timeout = this.timeout
        this.uiRcon = lane
        return lane
      })().finally(() => {
        this.uiConnect = null
      })
    }
    return this.uiConnect
  }

  async taskBoardCommand(text) {
    const lane = await this.taskBoardLane()
    try {
      lane.timeout = this.timeout
      return await lane.command(text)
    }
    catch (error) {
      if (!lane.socket || lane.socket.destroyed) {
        if (this.uiRcon === lane) this.uiRcon = null
        lane.close()
      }
      throw error
    }
  }

  queuedCommand(text) {
    const command = this.queue.catch(() => {}).then(async () => {
      check(this.socket && !this.socket.destroyed, 'RCON is not connected')
      const id = ++this.sequence
      const response = this.request(id, 2, text, 0)
      this.socket.write(encodePacket(id, 2, text))
      return response
    })
    this.queue = command.catch(() => {})
    return command
  }

  command(text) {
    if (!this.auxiliary && taskBoardUiRconCommand(text)) return this.taskBoardCommand(text)
    return this.queuedCommand(text)
  }
}

export async function reserveBudget(filename, maximum, now = Date.now(), options = {}) {
  const budget = await readJson(filename, { since: now, count: 0 })
  check(Number.isSafeInteger(budget.since) && Number.isSafeInteger(budget.count) && budget.count >= 0, 'Invalid persisted provider budget')
  check(Number.isSafeInteger(maximum) && maximum >= 1, 'Invalid provider request budget maximum')
  const requestedReserve = Number.isSafeInteger(options.reservedSlots) ? Math.max(0, options.reservedSlots) : 0
  const reservedSlots = Math.min(requestedReserve, Math.max(0, maximum - 1))
  const emergency = options.emergency === true
  if (now - budget.since >= 3600000) { budget.since = now; budget.count = 0 }
  const limit = emergency ? maximum : maximum - reservedSlots
  check(
    budget.count < limit,
    emergency
      ? 'Hourly provider request budget reached, including recovery reserve'
      : reservedSlots > 0
        ? 'Hourly provider request budget reached; recovery reserve preserved'
        : 'Hourly provider request budget reached',
  )
  budget.count++
  await atomicWrite(filename, `${JSON.stringify(budget)}\n`)
  return budget.count
}

export async function hashFile(filename) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

export async function runProcess(command, args, { cwd, env = process.env, timeoutMs = 300000, label = path.basename(command), log = () => {} } = {}) {
  const child = new Child(command, args, { cwd, env, label, log })
  let result
  try { result = await withTimeout(child.closed, timeoutMs, `${label} timed out`) }
  catch (error) {
    await child.stop(5000, 'SIGTERM')
    throw error
  }
  check(result.code === 0, `${label} failed with exit code ${result.code ?? 'signal'}`)
  return result
}

const TASK_BOARD_MAX_STEPS = 30
const TASK_BOARD_MAX_EVENTS = 64
const TASK_BOARD_MAX_EVIDENCE = 32

function taskBoardText(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function normalizeTaskBoardStep(value) {
  return taskBoardText(value, 500).toLocaleLowerCase()
}

function boundedTaskBoardPlan(plan) {
  return Array.isArray(plan) ? plan.slice(0, TASK_BOARD_MAX_STEPS).map(step => taskBoardText(step, 500)).filter(Boolean) : []
}

function clampTaskBoardIndex(value, length) {
  if (length <= 0) return 0
  if (!Number.isSafeInteger(value)) return 0
  return Math.min(Math.max(value, 0), length - 1)
}

function taskBoardEvent(board, type, now, details = {}) {
  const events = [...(board.events ?? []), {
    seq: (board.event_sequence ?? 0) + 1,
    type,
    at: now,
    revision: board.revision,
    ...details,
  }].slice(-TASK_BOARD_MAX_EVENTS)
  return { ...board, event_sequence: (board.event_sequence ?? 0) + 1, events }
}

function taskBoardStepId(index) {
  return `step_${index + 1}`
}

function taskBoardStepStatus(index, activeIndex, boardStatus) {
  if (index < activeIndex || boardStatus === 'completed') return 'completed'
  if (index > activeIndex) return 'pending'
  if (boardStatus === 'blocked') return 'blocked'
  if (boardStatus === 'paused') return 'paused'
  return 'active'
}

function applyTaskBoardStatuses(board, activeIndex = board.active_index ?? 0) {
  const safeIndex = clampTaskBoardIndex(activeIndex, board.steps.length)
  const proposedIndex = clampTaskBoardIndex(board.proposed_focus_index, board.steps.length)
  return {
    ...board,
    active_index: safeIndex,
    active_step_id: board.status === 'completed' || board.steps.length === 0 ? undefined : board.steps[safeIndex]?.id,
    completed_count: board.status === 'completed' ? board.steps.length : safeIndex,
    proposed_focus_index: board.status === 'completed' || board.steps.length === 0 ? undefined : proposedIndex,
    proposed_focus_step_id: board.status === 'completed' || board.steps.length === 0 ? undefined : board.steps[proposedIndex]?.id,
    total_steps: board.steps.length,
    steps: board.steps.map((step, index) => ({ ...step, status: taskBoardStepStatus(index, safeIndex, board.status) })),
  }
}

export function createTaskBoard(plan, currentStep, { goalId = '', now = Date.now() } = {}) {
  const descriptions = boundedTaskBoardPlan(plan)
  const activeIndex = 0
  const proposedFocusIndex = clampTaskBoardIndex(currentStep, descriptions.length)
  let board = {
    kind: 'task_board_lite',
    goal_id: taskBoardText(goalId, 100),
    status: descriptions.length ? 'active' : 'completed',
    blocker: '',
    pause_reason: '',
    revision: 1,
    event_sequence: 0,
    active_index: activeIndex,
    active_step_id: undefined,
    proposed_focus_index: descriptions.length ? proposedFocusIndex : undefined,
    proposed_focus_step_id: undefined,
    completed_count: 0,
    total_steps: descriptions.length,
    steps: descriptions.map((description, index) => ({ id: taskBoardStepId(index), description, status: 'pending', revision: 1 })),
    evidence: [],
    events: [],
    created_at: now,
    updated_at: now,
  }
  board = applyTaskBoardStatuses(board, activeIndex)
  return taskBoardEvent(board, 'created', now, { active_step_id: board.active_step_id, total_steps: board.total_steps })
}

function findTaskBoardStep(board, description) {
  const target = normalizeTaskBoardStep(description)
  if (!target) return -1
  return board.steps.findIndex(step => normalizeTaskBoardStep(step.description) === target)
}

function taskBoardCompletedPrefixMatches(board, incoming) {
  const count = board.completed_count ?? 0
  if (count <= 0 || incoming.length < count) return false
  for (let index = 0; index < count; index++) {
    if (normalizeTaskBoardStep(board.steps[index]?.description) !== normalizeTaskBoardStep(incoming[index])) return false
  }
  return true
}

function replanTaskBoardRemaining(board, incoming, incomingIndex, now) {
  const completed = board.steps.slice(0, board.completed_count).map(step => ({ ...step, status: 'completed' }))
  const incomingIncludesCompletedPrefix = taskBoardCompletedPrefixMatches(board, incoming)
  const remainingDescriptions = incoming.slice(incomingIncludesCompletedPrefix ? board.completed_count : 0)
  if (remainingDescriptions.length === 0) return board

  // Step ids are semantic identities, not array positions. Reuse an unfinished
  // id only when the normalized step meaning is unchanged. A changed/new step
  // gets a revision-scoped id so evidence from the replaced step cannot alias
  // the new step just because both occupy the same plan index.
  const priorRemaining = board.steps.slice(board.completed_count)
  const usedStepIds = new Set(completed.map(step => step.id))
  const replanRevision = (Number.isSafeInteger(board.revision) ? board.revision : 0) + 1
  const remainingSteps = remainingDescriptions.map((description, offset) => {
    const reusable = priorRemaining.find(step =>
      !usedStepIds.has(step.id)
      && normalizeTaskBoardStep(step.description) === normalizeTaskBoardStep(description))
    const id = reusable?.id ?? `${taskBoardStepId(completed.length + offset)}_r${replanRevision}`
    usedStepIds.add(id)
    return {
      id,
      description,
      status: 'pending',
      revision: Number.isSafeInteger(reusable?.revision) ? reusable.revision : 1,
    }
  })
  const steps = [
    ...completed,
    ...remainingSteps,
  ].slice(0, TASK_BOARD_MAX_STEPS)
  const proposedDescription = incoming[incomingIndex]
  const proposedFocusIndex = proposedDescription === undefined
    ? completed.length
    : steps.findIndex(step => normalizeTaskBoardStep(step.description) === normalizeTaskBoardStep(proposedDescription))
  let next = {
    ...board,
    status: 'active',
    blocker: '',
    pause_reason: '',
    revision: board.revision + 1,
    steps,
    active_index: completed.length,
    proposed_focus_index: proposedFocusIndex >= 0 ? proposedFocusIndex : completed.length,
    updated_at: now,
  }
  next = applyTaskBoardStatuses(next, completed.length)
  return taskBoardEvent(next, 'replanned', now, { preserved_completed: completed.length, total_steps: next.total_steps })
}

export function reconcileTaskBoard(board, plan, currentStep, { now = Date.now(), allowReplan = false, authoritativeAdvance = false } = {}) {
  const incoming = boundedTaskBoardPlan(plan)
  if (!board || board.kind !== 'task_board_lite') return createTaskBoard(incoming, currentStep, { now })
  if (incoming.length === 0) return board

  const incomingIndex = clampTaskBoardIndex(currentStep, incoming.length)
  const incomingActive = incoming[incomingIndex]
  const matchedIndex = findTaskBoardStep(board, incomingActive)
  const currentIndex = board.active_index ?? 0
  const exactSamePlan = incoming.length === board.steps.length
    && incoming.every((description, index) => normalizeTaskBoardStep(description) === normalizeTaskBoardStep(board.steps[index]?.description))

  if (allowReplan && !exactSamePlan) {
    return replanTaskBoardRemaining(board, incoming, incomingIndex, now)
  }

  if (matchedIndex >= 0) {
    const proposedChanged = board.proposed_focus_index !== matchedIndex
    if (authoritativeAdvance && matchedIndex > currentIndex) {
      let next = {
        ...board,
        status: 'active',
        blocker: '',
        pause_reason: '',
        proposed_focus_index: matchedIndex,
        revision: board.revision + 1,
        updated_at: now,
      }
      next = applyTaskBoardStatuses(next, matchedIndex)
      return taskBoardEvent(next, 'advanced', now, { from_step: board.active_step_id, to_step: next.active_step_id })
    }
    if (proposedChanged) {
      let next = {
        ...board,
        proposed_focus_index: matchedIndex,
        revision: board.revision + 1,
        updated_at: now,
      }
      next = applyTaskBoardStatuses(next, currentIndex)
      return taskBoardEvent(next, 'focus_proposed', now, {
        active_step_id: next.active_step_id,
        proposed_focus_step_id: next.proposed_focus_step_id,
      })
    }
    if (matchedIndex >= currentIndex) return board
  }

  if (exactSamePlan && incomingIndex > currentIndex) {
    let next = {
      ...board,
      proposed_focus_index: incomingIndex,
      revision: board.revision + 1,
      updated_at: now,
    }
    if (authoritativeAdvance) {
      next = { ...next, status: 'active', blocker: '', pause_reason: '' }
      next = applyTaskBoardStatuses(next, incomingIndex)
      return taskBoardEvent(next, 'advanced', now, { from_step: board.active_step_id, to_step: next.active_step_id })
    }
    next = applyTaskBoardStatuses(next, currentIndex)
    return taskBoardEvent(next, 'focus_proposed', now, {
      active_step_id: next.active_step_id,
      proposed_focus_step_id: next.proposed_focus_step_id,
    })
  }

  if ((allowReplan || taskBoardCompletedPrefixMatches(board, incoming)) && incomingActive && normalizeTaskBoardStep(incomingActive) !== normalizeTaskBoardStep(board.steps[currentIndex]?.description)) {
    return replanTaskBoardRemaining(board, incoming, incomingIndex, now)
  }

  return board
}

export function setTaskBoardStatus(board, status, { blocker = '', pauseReason = '', now = Date.now() } = {}) {
  if (!board || board.kind !== 'task_board_lite') return board
  if (!['active', 'blocked', 'paused', 'completed'].includes(status)) return board
  if (board.status === status && board.blocker === blocker && board.pause_reason === pauseReason) return board
  let next = {
    ...board,
    status,
    blocker: taskBoardText(blocker, 500),
    pause_reason: taskBoardText(pauseReason, 300),
    revision: board.revision + 1,
    updated_at: now,
  }
  next = applyTaskBoardStatuses(next, next.active_index)
  return taskBoardEvent(next, status, now, { active_step_id: next.active_step_id })
}

export function addTaskBoardEvidence(board, { kind = 'operation_receipt', summary = '', ref = '', now = Date.now() } = {}) {
  if (!board || board.kind !== 'task_board_lite') return board
  const record = {
    id: `evidence_${(board.evidence_sequence ?? 0) + 1}`,
    kind: taskBoardText(kind, 64),
    summary: taskBoardText(summary, 1200),
    ref: taskBoardText(ref, 160),
    at: now,
    step_id: board.active_step_id,
  }
  const next = {
    ...board,
    evidence_sequence: (board.evidence_sequence ?? 0) + 1,
    evidence: [...(board.evidence ?? []), record].slice(-TASK_BOARD_MAX_EVIDENCE),
    revision: board.revision + 1,
    updated_at: now,
  }
  return taskBoardEvent(next, 'evidence', now, { evidence_id: record.id, step_id: record.step_id })
}

export function taskBoardProgress(board) {
  if (!board || board.kind !== 'task_board_lite') return undefined
  const active = board.steps[board.active_index ?? 0]
  return {
    status: board.status,
    completed: board.completed_count ?? 0,
    total: board.total_steps ?? board.steps.length,
    index: board.status === 'completed' ? board.steps.length : (board.active_index ?? 0) + 1,
    step_id: board.active_step_id,
    step: active?.description ?? '',
    proposed_focus_index: Number.isSafeInteger(board.proposed_focus_index) ? board.proposed_focus_index : board.active_index ?? 0,
    proposed_focus_step_id: board.proposed_focus_step_id,
    blocker: board.blocker ?? '',
    pause_reason: board.pause_reason ?? '',
    revision: board.revision,
  }
}

export function sanitizeTaskBoard(value, { fallbackPlan = [], fallbackCurrentStep = 0, goalId = '', now = Date.now() } = {}) {
  if (!value || value.kind !== 'task_board_lite' || !Array.isArray(value.steps)) {
    // Historical planner current_step is not grounded completion evidence.
    // Preserve it only as proposed focus when migrating a legacy plan; verified
    // canonical progress must come from a persisted Task Board and its evidence.
    return createTaskBoard(fallbackPlan, fallbackCurrentStep, { goalId, now })
  }
  const descriptions = value.steps.slice(0, TASK_BOARD_MAX_STEPS).map(step => taskBoardText(step?.description, 500)).filter(Boolean)
  let board = createTaskBoard(descriptions, value.active_index, { goalId: value.goal_id ?? goalId, now: Number.isFinite(value.created_at) ? value.created_at : now })
  const usedStepIds = new Set()
  board.steps = board.steps.map((step, index) => {
    const persistedId = taskBoardText(value.steps[index]?.id, 80)
    const id = persistedId && !usedStepIds.has(persistedId) ? persistedId : step.id
    usedStepIds.add(id)
    return {
      ...step,
      id,
      revision: Number.isSafeInteger(value.steps[index]?.revision) && value.steps[index].revision > 0
        ? value.steps[index].revision
        : step.revision,
    }
  })
  board = {
    ...board,
    status: ['active', 'blocked', 'paused', 'completed'].includes(value.status) ? value.status : board.status,
    blocker: taskBoardText(value.blocker, 500),
    pause_reason: taskBoardText(value.pause_reason, 300),
    proposed_focus_index: Number.isSafeInteger(value.proposed_focus_index)
      ? clampTaskBoardIndex(value.proposed_focus_index, descriptions.length)
      : clampTaskBoardIndex(value.active_index, descriptions.length),
    revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : board.revision,
    event_sequence: Number.isSafeInteger(value.event_sequence) && value.event_sequence >= 0 ? value.event_sequence : board.event_sequence,
    evidence_sequence: Number.isSafeInteger(value.evidence_sequence) && value.evidence_sequence >= 0 ? value.evidence_sequence : 0,
    evidence: (Array.isArray(value.evidence) ? value.evidence : []).slice(-TASK_BOARD_MAX_EVIDENCE).map(item => ({
      id: taskBoardText(item?.id, 80),
      kind: taskBoardText(item?.kind, 64),
      summary: taskBoardText(item?.summary, 1200),
      ref: taskBoardText(item?.ref, 160),
      at: Number.isFinite(item?.at) ? item.at : now,
      step_id: taskBoardText(item?.step_id, 80) || undefined,
    })),
    events: (Array.isArray(value.events) ? value.events : []).slice(-TASK_BOARD_MAX_EVENTS).map(item => ({
      seq: Number.isSafeInteger(item?.seq) ? item.seq : 0,
      type: taskBoardText(item?.type, 64),
      at: Number.isFinite(item?.at) ? item.at : now,
      revision: Number.isSafeInteger(item?.revision) ? item.revision : 0,
      active_step_id: taskBoardText(item?.active_step_id, 80) || undefined,
      total_steps: Number.isSafeInteger(item?.total_steps) ? item.total_steps : undefined,
      preserved_completed: Number.isSafeInteger(item?.preserved_completed) ? item.preserved_completed : undefined,
      from_step: taskBoardText(item?.from_step, 80) || undefined,
      to_step: taskBoardText(item?.to_step, 80) || undefined,
      evidence_id: taskBoardText(item?.evidence_id, 80) || undefined,
      step_id: taskBoardText(item?.step_id, 80) || undefined,
      proposed_focus_step_id: taskBoardText(item?.proposed_focus_step_id, 80) || undefined,
    })),
    created_at: Number.isFinite(value.created_at) ? value.created_at : now,
    updated_at: Number.isFinite(value.updated_at) ? value.updated_at : now,
  }
  return applyTaskBoardStatuses(board, value.active_index)
}
