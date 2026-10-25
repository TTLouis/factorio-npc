export const OPERATOR_REASONS = Object.freeze(['canceled_after_peer_verified_success', 'owner_canceled', 'pair_supervisor_failure', 'weekly_remaining_floor_reached', 'shared_quota_evidence_unavailable', 'shared_quota_evidence_stale'])
export function operatorStopReason(request, { runId, goalId, actorId }) {
  if (!request) return null
  if (request.runId !== runId || request.goalId !== goalId || request.actorId !== actorId || !OPERATOR_REASONS.includes(request.reason)) throw Error('Operator stop request identity/reason mismatch')
  if (request.reason === 'canceled_after_peer_verified_success' && (!request.peerRunId || request.peerRunId === runId || !/^[a-f0-9]{64}$/.test(request.peerAcceptanceSha256 ?? ''))) throw Error('Peer acceptance evidence required')
  return request.reason
}
