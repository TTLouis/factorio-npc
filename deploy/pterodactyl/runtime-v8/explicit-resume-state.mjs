export const EXPLICIT_RESUME_LIMIT = 2
export function restoreExplicitResume(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const strings = ['goal_id', 'plan_id', 'step_id', 'request_id', 'stage']
  if (strings.some(k => typeof raw[k] !== 'string' || !raw[k] || raw[k].length > 240)
    || !Number.isSafeInteger(raw.plan_version) || raw.plan_version < 1
    || !Number.isSafeInteger(raw.attempts) || raw.attempts < 1 || raw.attempts > EXPLICIT_RESUME_LIMIT
    || !Number.isSafeInteger(raw.pause_count) || raw.pause_count < 0
    || !Number.isFinite(raw.paused_at) || !Number.isFinite(raw.at)) return null
  return Object.fromEntries([...strings, 'plan_version', 'attempts', 'pause_count', 'paused_at', 'at'].map(k => [k, raw[k]]))
}
