export const TICK_SPRINT = Object.freeze({ version: 'tick-sprint-v1', speed: 4, burstTicks: 600,
  episodeTicks: 3600, maxEpisodes: 1024, pollMs: 500, watchdogMs: 100, restoreAfterMs: 2000, wallMs: 3000, maxControlReadsPerMinute: 1200 })

export function sprintSpeedValid(snapshot, { profile = 'normal', runId, sourceSha, now = Date.now() } = {}) {
  const guard = snapshot?.sprint_guard
  const lease = guard?.lease
  const configured = guard?.version === TICK_SPRINT.version && guard.phase === 'construction' && !guard.fault
    && guard.binding?.profile === profile && guard.binding?.run_id === runId && guard.binding?.source_sha === sourceSha
  if (snapshot?.speed === 1) return profile === 'normal' || configured && guard.speed === 1 && !lease
  return profile === 'accelerated' && snapshot?.speed === TICK_SPRINT.speed && guard?.speed === TICK_SPRINT.speed
    && guard.version === TICK_SPRINT.version && guard.phase === 'construction' && !guard.fault && guard.binding?.profile === profile
    && guard.binding?.run_id === runId && guard.binding?.source_sha === sourceSha
    && lease?.run_id === runId && lease?.source_sha === sourceSha && lease?.profile === profile
    && lease.actor_id === snapshot.actor_id && lease.epoch === snapshot.epoch
    && lease.goal_id === snapshot.goal_id && lease.plan_id === snapshot.plan_id
    && lease.plan_version === snapshot.plan_version && lease.board_step_id === snapshot.board_step_id
    && typeof lease.lease_id === 'string' && lease.lease_id.length > 0
    && lease.episode_id === lease.batch_ref && lease.batch_ref === snapshot.active_batch_ref
    && Number.isSafeInteger(lease.start_tick) && lease.end_tick === lease.start_tick + TICK_SPRINT.burstTicks
    && snapshot.tick >= lease.start_tick && snapshot.tick < lease.end_tick
    && lease.wall_deadline_ms === lease.wall_started_ms + TICK_SPRINT.wallMs
    && now >= lease.wall_started_ms && now < lease.wall_deadline_ms
}

export function summarizeTickSprints(rows) {
  const uniqueRows = [...new Map((rows ?? []).filter(row => row.event?.startsWith('sprint.')).map(row => [JSON.stringify(row), row])).values()]
  const leases = new Map(); const polling = new Map()
  for (const row of uniqueRows) {
    const event = row.event; const data = row.data ?? {}
    if (!event?.startsWith('sprint.')) continue
    if (data.polling_instance_id && data.native_reads_by_lane) {
      const counts = polling.get(data.polling_instance_id) ?? {}
      for (const [lane, count] of Object.entries(data.native_reads_by_lane)) counts[lane] = Math.max(counts[lane] ?? 0, count)
      polling.set(data.polling_instance_id, counts)
    }
    if (!data.lease_id) continue
    const lease = leases.get(data.lease_id) ?? { lease_id: data.lease_id }
    if (event === 'sprint.started') Object.assign(lease, { started: data })
    if (event === 'sprint.restored') Object.assign(lease, { restored: data })
    if (event === 'sprint.refused') Object.assign(lease, { refused: data })
    leases.set(data.lease_id, lease)
  }
  const started = [...leases.values()].filter(row => row.started)
  const restored = started.filter(row => row.restored)
  const ticks = restored.reduce((sum, row) => sum + (row.restored.actual_ticks ?? 0), 0)
  const wall = restored.map(row => row.restored.host_observed_lease_wall_ms).filter(Number.isFinite)
  const complete = restored.length === started.length && restored.every(row => Number.isFinite(row.restored.actual_ticks))
  const checksComplete = restored.length === started.length && restored.every(row => Number.isFinite(row.restored.native_checks))
  const reads = {}
  for (const lanes of polling.values()) for (const [lane, count] of Object.entries(lanes)) reads[lane] = (reads[lane] ?? 0) + count
  return { profile: 'accelerated', burst_count: started.length, restored_count: restored.length,
    unconfirmed_restorations: started.length - restored.length, telemetry_complete: complete && checksComplete,
    actual_sprint_ticks: complete ? ticks : null, known_restored_sprint_ticks: ticks,
    measured_sprint_wall_ms: null, host_observed_lease_wall_ms: complete && wall.length === restored.length ? wall.reduce((sum, value) => sum + value, 0) : null,
    estimated_1x_equivalent_ms: complete ? ticks / 60 * 1000 : null, estimated_saving_lower_bound_ms: complete && wall.length === restored.length ? ticks / 60 * 1000 - wall.reduce((sum, value) => sum + value, 0) : null,
    saving_is_estimated_not_measured_comparison: true, harness_native_reads_by_lane: reads,
    native_tick_guard_checks: checksComplete ? restored.reduce((sum, row) => sum + row.restored.native_checks, 0) : null,
    known_restored_native_tick_guard_checks: restored.reduce((sum, row) => sum + (row.restored.native_checks ?? 0), 0),
    faults: uniqueRows.filter(row => row.event === 'sprint.fault').length,
    refusals: uniqueRows.filter(row => row.event === 'sprint.refused').length, leases: [...leases.values()] }
}
