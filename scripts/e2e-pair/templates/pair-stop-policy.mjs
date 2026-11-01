export const OPERATOR_REASONS = Object.freeze(['canceled_after_peer_verified_success', 'owner_canceled', 'pair_supervisor_failure', 'weekly_remaining_floor_reached', 'shared_quota_evidence_unavailable', 'shared_quota_evidence_stale'])
export function operatorStopReason(request, { runId, goalId, actorId, source, epoch, launchControlId }) {
  if (!request) return null
  const launch=request.scope==='launch'||request.scope==='prelaunch'
  if (request.runId !== runId || request.actorId !== actorId || !OPERATOR_REASONS.includes(request.reason) ||
      (!launch&&request.goalId!==goalId) || (launch&&(request.source!==source||request.epoch!==epoch)) ||
      (request.source!=null&&source!=null&&request.source!==source) || (request.epoch!=null&&epoch!=null&&request.epoch!==epoch) ||
      (request.scope==='launch'&&request.launchControlId!==launchControlId)) throw Error('Operator stop request identity/reason mismatch')
  if (request.reason === 'canceled_after_peer_verified_success' && (!request.peerRunId || request.peerRunId === runId || !/^[a-f0-9]{64}$/.test(request.peerAcceptanceSha256 ?? ''))) throw Error('Peer acceptance evidence required')
  return request.reason
}
