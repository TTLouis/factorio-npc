// MW2 durable task ledger (docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md section 3).
//
// A ledger of ACCEPTED tasks that are not the one running now: tasks that were interrupted (displaced by another
// task, a blocker, a pause, ...) or accepted and not yet started. It is NOT the Roadmap Shelf: a shelf node is
// non-executable intent, a ledger task is a player-accepted piece of work with a requested result, verified progress
// and, when it was running, the committed plan it stopped in. The two never feed each other.
//
// This module is pure bookkeeping over plain data: constants, sanitizers, list operations, selectors and
// persistence. It performs no I/O, never reads a clock and has no import of the planning reducer, so
// planning-state.mjs (the one transition authority) can import it. The reducer builds records from its own state;
// nothing here advances plan progress or grants authority.
//
// Persistence: the ledger rides in the planning state as `task_ledger` (serialized only when it holds something) and,
// like the MW1 world facts, survives goal teardown, restage, slice changes and a supervisor restart.

export const TASK_LEDGER_VERSION = 1

export const TASK_STATUS = Object.freeze({
  // Accepted and never started (no verified progress to preserve).
  PENDING: 'pending',
  // Was the running task; stopped before it finished. Holds a checkpoint of the plan and verified progress.
  INTERRUPTED: 'interrupted',
})

// Terminal states live in the bounded `closed` history, so a closed task can be explained but never acted on.
export const TASK_CLOSE = Object.freeze({
  RESUMED: 'resumed',
  CANCELLED: 'cancelled',
  EVICTED: 'evicted',
})

export const TASK_INTERRUPTION = Object.freeze({
  NEW_GOAL: 'new_goal',
  PLAYER_STEERING: 'player_steering',
  BLOCKER: 'blocker',
  PAUSE: 'pause',
  ACTOR_DEATH: 'actor_death',
  ACTOR_REPLACED: 'actor_replaced',
  RESTART: 'restart',
})
const TASK_INTERRUPTIONS = Object.freeze(Object.values(TASK_INTERRUPTION))

// What state the task was in when it was displaced. A paused or blocked task is kept, never auto-resumed.
export const TASK_STATE_AT_INTERRUPTION = Object.freeze({ ACTIVE: 'active', PAUSED: 'paused', BLOCKED: 'blocked' })
const STATES_AT_INTERRUPTION = Object.freeze(Object.values(TASK_STATE_AT_INTERRUPTION))

// Why a ledger operation changed nothing. Named so a trace and a test can assert them.
export const TASK_LEDGER_REFUSAL = Object.freeze({
  UNAUTHORIZED_SOURCE: 'unauthorized_source',
  NO_ACTIVE_TASK: 'no_active_task',
  ALREADY_RECORDED: 'already_recorded',
  INVALID_TASK: 'invalid_task',
  TASK_NOT_FOUND: 'task_not_found',
  TASK_NOT_RESUMABLE: 'task_not_resumable',
  ANOTHER_TASK_ACTIVE: 'another_task_active',
  CHECKPOINT_UNRESTORABLE: 'checkpoint_unrestorable',
  NOTHING_TO_RESUME: 'nothing_to_resume',
})

export const TASK_LEDGER_LIMITS = Object.freeze({
  open: 8,
  closed: 16,
  objective: 1000,
  owner: 128,
  detail: 300,
  ref: 200,
  receiptRefs: 24,
  completedSteps: 64,
  doneWhen: 6,
  // The checkpoint is a bounded copy of the stopped task's planning and board state. Past this size it is dropped and
  // the task is kept without it (listed, but resumable only as a fresh request).
  checkpointChars: 300_000,
  checkpointPlans: 4,
  checkpointLog: 32,
})

// Owner answer 2026-09-30: a suspended or blocked task that has waited 15 game-minutes is resurfaced. MW2 only
// records the data and orders by it; the MW3 scheduler is what acts. One game minute is 3600 ticks (60 ticks/s).
export const TASK_AGING = Object.freeze({
  resurfaceGameMinutes: 15,
  resurfaceGameTicks: 15 * 60 * 60,
})

// --- small pure helpers ----------------------------------------------------

function text(value, max = 500) {
  const cleaned = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max)
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : undefined
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value, { max = 32, maxLength = 160 } = {}) {
  if (!Array.isArray(value)) return []
  return value.map(item => text(item, maxLength)).filter(Boolean).slice(0, max)
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function taskIdFor(goalId) {
  return `task:${text(goalId, 120)}`
}

// --- records ----------------------------------------------------------------

export function createEmptyTaskLedger() {
  return { version: TASK_LEDGER_VERSION, sequence: 0, tasks: [], closed: [] }
}

export function taskLedgerOf(state) {
  return isRecord(state?.task_ledger) ? state.task_ledger : createEmptyTaskLedger()
}

export function taskLedgerHasContent(ledger) {
  return Boolean(ledger) && (ledger.sequence > 0 || ledger.tasks.length > 0 || ledger.closed.length > 0)
}

/** What survives a new goal, a completed task's teardown and a restart. Everything: the ledger is not goal-scoped. */
export function carryTaskLedger(ledger) {
  return taskLedgerHasContent(ledger) ? ledger : undefined
}

function sanitizeDestination(raw) {
  if (typeof raw === 'string') {
    const description = text(raw, TASK_LEDGER_LIMITS.detail)
    return description ? { description, position: null, entity: null } : null
  }
  if (!isRecord(raw)) return null
  const description = text(raw.description, TASK_LEDGER_LIMITS.detail)
  const position = isRecord(raw.position) && Number.isFinite(raw.position.x) && Number.isFinite(raw.position.y)
    ? { x: raw.position.x, y: raw.position.y }
    : null
  const entity = isRecord(raw.entity)
    ? {
        name: text(raw.entity.name, 120) || null,
        unit_number: Number.isSafeInteger(raw.entity.unit_number) ? raw.entity.unit_number : null,
      }
    : null
  if (!description && !position && !entity) return null
  return { description: description || null, position, entity }
}

function sanitizeRequestedResult(raw) {
  if (!isRecord(raw)) return null
  return {
    objective: text(raw.objective, TASK_LEDGER_LIMITS.objective),
    result_key: text(raw.result_key, TASK_LEDGER_LIMITS.ref) || null,
    done_when: (Array.isArray(raw.done_when) ? raw.done_when : [])
      .slice(0, TASK_LEDGER_LIMITS.doneWhen)
      .filter(isRecord)
      .map(item => cloneJson(item)),
    destination: sanitizeDestination(raw.destination),
  }
}

function sanitizeAuthorizationLink(raw) {
  if (!isRecord(raw)) return null
  const grantId = text(raw.grant_id, TASK_LEDGER_LIMITS.ref)
  if (!grantId || !Number.isSafeInteger(raw.grant_revision)) return null
  return {
    grant_id: grantId,
    grant_revision: raw.grant_revision,
    mandate_kind: text(raw.mandate_kind, 40),
    mandate_id: text(raw.mandate_id, 120),
    grant_status: text(raw.grant_status, 20) || 'active',
  }
}

function sanitizeProgress(raw) {
  if (!isRecord(raw)) return null
  const index = Number.isSafeInteger(raw.active_step_index) && raw.active_step_index >= 0 ? raw.active_step_index : 0
  return {
    plan_id: text(raw.plan_id, TASK_LEDGER_LIMITS.ref) || null,
    plan_version: Number.isSafeInteger(raw.plan_version) ? raw.plan_version : null,
    plan_status: text(raw.plan_status, 30) || null,
    active_step_index: index,
    active_step_id: text(raw.active_step_id, TASK_LEDGER_LIMITS.ref) || null,
    steps_total: Number.isSafeInteger(raw.steps_total) && raw.steps_total >= 0 ? raw.steps_total : 0,
    steps_completed: Number.isSafeInteger(raw.steps_completed) && raw.steps_completed >= 0 ? raw.steps_completed : 0,
    completed_step_ids: stringList(raw.completed_step_ids, { max: TASK_LEDGER_LIMITS.completedSteps, maxLength: TASK_LEDGER_LIMITS.ref }),
    receipt_refs: stringList(raw.receipt_refs, { max: TASK_LEDGER_LIMITS.receiptRefs, maxLength: TASK_LEDGER_LIMITS.ref }),
    // Fingerprint of the verified progress: a changed marker is "newly verified progress" for stagnation accounting.
    progress_marker: text(raw.progress_marker, 40) || null,
  }
}

function sanitizeInterruption(raw) {
  if (!isRecord(raw)) return null
  const reason = TASK_INTERRUPTIONS.includes(raw.reason_code) ? raw.reason_code : undefined
  if (!reason) return null
  const by = isRecord(raw.interrupted_by) ? raw.interrupted_by : {}
  const actor = isRecord(raw.actor)
    && (Number.isSafeInteger(raw.actor.actor_id) || Number.isSafeInteger(raw.actor.epoch))
    ? {
        actor_id: Number.isSafeInteger(raw.actor.actor_id) ? raw.actor.actor_id : null,
        epoch: Number.isSafeInteger(raw.actor.epoch) ? raw.actor.epoch : null,
      }
    : null
  return {
    reason_code: reason,
    detail: text(raw.detail, TASK_LEDGER_LIMITS.detail),
    state_at_interruption: STATES_AT_INTERRUPTION.includes(raw.state_at_interruption)
      ? raw.state_at_interruption
      : TASK_STATE_AT_INTERRUPTION.ACTIVE,
    interrupted_by: {
      kind: text(by.kind, 40) || null,
      goal_id: text(by.goal_id, 120) || null,
      sender: text(by.sender, TASK_LEDGER_LIMITS.owner) || null,
    },
    request_id: text(raw.request_id, 120) || null,
    at: finiteNumber(raw.at) ?? 0,
    game_tick: Number.isSafeInteger(raw.game_tick) && raw.game_tick >= 0 ? raw.game_tick : null,
    actor,
  }
}

// The checkpoint is opaque to the ledger: `planning` is a serialized planning state (restored through the reducer's
// own sanitizers on resume), `legacy` the compatibility Task Board record. Only its shape and size are checked here.
function sanitizeCheckpoint(raw) {
  if (!isRecord(raw)) return null
  const planning = isRecord(raw.planning) ? raw.planning : null
  const legacy = isRecord(raw.legacy) ? raw.legacy : null
  if (!planning) return null
  let size = 0
  try { size = JSON.stringify({ planning, legacy }).length }
  catch { return null }
  if (size > TASK_LEDGER_LIMITS.checkpointChars) return null
  return { planning: cloneJson(planning), legacy: cloneJson(legacy) ?? null }
}

/** Sanitize one open ledger task. Returns undefined when it is not a usable record. */
export function sanitizeTask(raw) {
  if (!isRecord(raw)) return undefined
  const goalId = text(raw.goal_id, 120)
  const objective = text(raw.objective, TASK_LEDGER_LIMITS.objective)
  const status = Object.values(TASK_STATUS).includes(raw.status) ? raw.status : undefined
  if (!goalId || !objective || !status) return undefined
  const interruption = sanitizeInterruption(raw.interruption)
  const checkpoint = sanitizeCheckpoint(raw.checkpoint)
  // An interrupted task without its interruption record is not trustworthy; a pending one carries none.
  if (status === TASK_STATUS.INTERRUPTED && !interruption) return undefined
  const mandateKind = text(raw.mandate_kind, 40) || null
  return {
    task_id: text(raw.task_id, 130) || taskIdFor(goalId),
    goal_id: goalId,
    owner: text(raw.owner, TASK_LEDGER_LIMITS.owner) || 'unknown',
    objective,
    status,
    // A standing Auto mandate is the campaign, not a temporary request: it is never auto-resumed as one.
    mandate_kind: mandateKind,
    temporary: mandateKind !== 'standing_auto',
    requested_result: sanitizeRequestedResult(raw.requested_result) ?? { objective, result_key: null, done_when: [], destination: null },
    authorization: sanitizeAuthorizationLink(raw.authorization),
    progress: sanitizeProgress(raw.progress),
    interruption,
    checkpoint,
    checkpoint_dropped: raw.checkpoint_dropped === true || (Boolean(raw.checkpoint) && !checkpoint),
    sequence: Number.isSafeInteger(raw.sequence) ? raw.sequence : 0,
    recorded_at: finiteNumber(raw.recorded_at) ?? 0,
    updated_at: finiteNumber(raw.updated_at) ?? finiteNumber(raw.recorded_at) ?? 0,
  }
}

function sanitizeClosed(raw) {
  if (!isRecord(raw)) return undefined
  const taskId = text(raw.task_id, 130)
  const status = Object.values(TASK_CLOSE).includes(raw.status) ? raw.status : undefined
  if (!taskId || !status) return undefined
  return {
    task_id: taskId,
    goal_id: text(raw.goal_id, 120),
    status,
    reason: text(raw.reason, TASK_LEDGER_LIMITS.detail) || null,
    request_id: text(raw.request_id, 120) || null,
    at: finiteNumber(raw.at) ?? 0,
  }
}

// --- list operations (pure; the reducer decides when) ------------------------

export function findTask(ledger, taskId) {
  const id = text(taskId, 130)
  return ledger.tasks.find(task => task.task_id === id)
}

function boundClosed(closed) {
  return closed.slice(-TASK_LEDGER_LIMITS.closed)
}

/**
 * Add an open task. When the ledger is full the OLDEST open task is evicted and recorded as such, so a full ledger is
 * visible, not a silent drop. Returns the new ledger plus whatever was evicted.
 */
export function addTask(ledger, task, { now, requestId } = {}) {
  let tasks = [...ledger.tasks]
  const evicted = []
  while (tasks.length >= TASK_LEDGER_LIMITS.open) {
    const oldest = [...tasks].sort((left, right) => left.sequence - right.sequence)[0]
    tasks = tasks.filter(item => item.task_id !== oldest.task_id)
    evicted.push(oldest)
  }
  const sequence = ledger.sequence + 1
  const added = { ...task, sequence }
  return {
    evicted,
    task: added,
    ledger: {
      ...ledger,
      sequence,
      tasks: [...tasks, added],
      closed: boundClosed([
        ...ledger.closed,
        ...evicted.map(item => ({
          task_id: item.task_id,
          goal_id: item.goal_id,
          status: TASK_CLOSE.EVICTED,
          reason: 'ledger_full',
          request_id: text(requestId, 120) || null,
          at: now ?? 0,
        })),
      ]),
    },
  }
}

export function closeTask(ledger, taskId, { status, reason, requestId, now } = {}) {
  const task = findTask(ledger, taskId)
  if (!task || !Object.values(TASK_CLOSE).includes(status)) return { ledger, task: undefined }
  return {
    task,
    ledger: {
      ...ledger,
      sequence: ledger.sequence + 1,
      tasks: ledger.tasks.filter(item => item.task_id !== task.task_id),
      closed: boundClosed([...ledger.closed, {
        task_id: task.task_id,
        goal_id: task.goal_id,
        status,
        reason: text(reason, TASK_LEDGER_LIMITS.detail) || null,
        request_id: text(requestId, 120) || null,
        at: now ?? 0,
      }]),
    },
  }
}

// --- selectors ---------------------------------------------------------------

/**
 * Aging data for one task (owner answer: 15 game-minutes). Uses game ticks when both ends are known and falls back to
 * wall-clock milliseconds otherwise, and says which clock it used. Pure data: nothing here resurfaces anything.
 */
export function taskAging(task, { now, gameTick } = {}) {
  const startedTick = task?.interruption?.game_tick
  const startedAt = task?.interruption?.at ?? task?.recorded_at ?? 0
  if (Number.isSafeInteger(startedTick) && Number.isSafeInteger(gameTick)) {
    const waited = Math.max(0, gameTick - startedTick)
    return { clock: 'game_ticks', waited, threshold: TASK_AGING.resurfaceGameTicks, due: waited >= TASK_AGING.resurfaceGameTicks }
  }
  const waited = Number.isFinite(now) ? Math.max(0, now - startedAt) : 0
  const threshold = TASK_AGING.resurfaceGameMinutes * 60 * 1000
  return { clock: 'wall_ms', waited, threshold, due: Number.isFinite(now) && waited >= threshold }
}

/**
 * A task the harness may resume without asking: it was running (not paused by a player, not blocked), and it still
 * holds the checkpoint to resume from. A pending task has nothing to lose and is always runnable.
 */
export function taskRunnable(task) {
  if (!task) return { runnable: false, reason: TASK_LEDGER_REFUSAL.TASK_NOT_FOUND }
  if (task.status === TASK_STATUS.PENDING) return { runnable: true, reason: null }
  if (task.interruption?.state_at_interruption !== TASK_STATE_AT_INTERRUPTION.ACTIVE) {
    return { runnable: false, reason: `interrupted_while_${task.interruption?.state_at_interruption ?? 'unknown'}` }
  }
  if (!task.checkpoint) return { runnable: false, reason: TASK_LEDGER_REFUSAL.CHECKPOINT_UNRESTORABLE }
  return { runnable: true, reason: null }
}

/**
 * The most recently recorded runnable temporary task, or undefined (the "resume the most recent interrupted
 * temporary task" rule of design section 3). Ordering input only; MW3 owns the scheduling policy.
 */
export function mostRecentResumable(ledger) {
  return [...(ledger?.tasks ?? [])]
    .filter(task => task.temporary && task.status === TASK_STATUS.INTERRUPTED && taskRunnable(task).runnable)
    .sort((left, right) => right.sequence - left.sequence)[0]
}

/** A read-only list for traces and the UI: resume order first, with aging and runnable data. */
export function taskLedgerView(ledger, { now, gameTick } = {}) {
  return [...(ledger?.tasks ?? [])]
    .sort((left, right) => right.sequence - left.sequence)
    .map((task, order) => ({
      task_id: task.task_id,
      goal_id: task.goal_id,
      objective: task.objective,
      status: task.status,
      temporary: task.temporary,
      resume_order: order + 1,
      reason_code: task.interruption?.reason_code ?? null,
      state_at_interruption: task.interruption?.state_at_interruption ?? null,
      progress: task.progress
        ? { steps_completed: task.progress.steps_completed, steps_total: task.progress.steps_total, active_step_index: task.progress.active_step_index }
        : null,
      destination: task.requested_result?.destination ?? null,
      authorization: task.authorization ? { grant_id: task.authorization.grant_id, grant_revision: task.authorization.grant_revision } : null,
      aging: taskAging(task, { now, gameTick }),
      ...taskRunnable(task),
    }))
}

// --- persistence -------------------------------------------------------------

export function serializeTaskLedger(ledger) {
  return cloneJson(ledger ?? createEmptyTaskLedger())
}

export function restoreTaskLedger(raw) {
  if (!isRecord(raw)) return undefined
  const tasks = []
  const seen = new Set()
  for (const item of (Array.isArray(raw.tasks) ? raw.tasks : []).slice(0, TASK_LEDGER_LIMITS.open)) {
    const task = sanitizeTask(item)
    if (!task || seen.has(task.task_id)) continue
    seen.add(task.task_id)
    tasks.push(task)
  }
  const closed = boundClosed((Array.isArray(raw.closed) ? raw.closed : []).map(sanitizeClosed).filter(Boolean))
  const sequence = Math.max(
    Number.isSafeInteger(raw.sequence) ? raw.sequence : 0,
    ...tasks.map(task => task.sequence),
  )
  const ledger = { version: TASK_LEDGER_VERSION, sequence, tasks, closed }
  return taskLedgerHasContent(ledger) ? ledger : undefined
}
