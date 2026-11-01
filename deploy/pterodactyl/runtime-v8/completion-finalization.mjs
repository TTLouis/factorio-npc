/** The canonical goal, not a completed slice projection, owns task retirement. */
export function completionFinalizationDecision(memory, key, result) {
  const goal = memory?.planningState?.(key)?.goal
  const resultId = result?.goalId ?? result?.taskBoard?.goal_id
  if (goal) {
    if (resultId !== goal.goal_id) return { allowed: false, reason: 'completion_goal_id_mismatch', goal_id: goal.goal_id }
    if (result?.taskBoard?.goal_id && result.taskBoard.goal_id !== goal.goal_id) return { allowed: false, reason: 'completion_board_goal_id_mismatch', goal_id: goal.goal_id }
    if (goal.status !== 'completed') return { allowed: false, reason: 'canonical_goal_not_completed', goal_id: goal.goal_id }
    if (result?.goalStatus && result.goalStatus !== 'completed') return { allowed: false, reason: 'completion_result_status_mismatch', goal_id: goal.goal_id }
    return { allowed: true, reason: 'canonical_goal_completed', goal_id: goal.goal_id }
  }
  return { allowed: result?.goalStatus === 'completed' || result?.taskBoard?.status === 'completed', reason: 'legacy_completion_without_canonical_goal' }
}
