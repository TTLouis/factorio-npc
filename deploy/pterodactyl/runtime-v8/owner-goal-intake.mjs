import { sanitizeGoalDefinition } from './goal-definition.mjs'

const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
export function sanitizeOwnerGoal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !['goalId', 'acceptanceKey', 'sender', 'text', 'definition'].includes(key))
    || typeof raw.goalId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(raw.goalId)
    || raw.acceptanceKey !== raw.goalId || typeof raw.sender !== 'string' || !raw.sender.trim() || raw.sender.length > 128
    || typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 1000 || /\0/.test(raw.text)) throw new Error('invalid_owner_goal_intake')
  const definition = sanitizeGoalDefinition(raw.definition)
  if (definition.scope !== 'finite' || definition.done_when.length !== 1 || definition.done_when[0].kind !== 'machine_output_delivered') {
    throw new Error('owner_goal_requires_finite_machine_delivery')
  }
  return freeze({ goalId: raw.goalId, acceptanceKey: raw.acceptanceKey, sender: raw.sender, text: raw.text, definition })
}

export function ownerGoalRecordMatches(goal, spec) {
  return goal?.goal_id === spec.goalId && goal.status === 'active' && goal.owner === spec.sender && goal.objective === spec.text
    && goal.definition?.source === 'user' && JSON.stringify(sanitizeGoalDefinition(goal.definition)) === JSON.stringify(spec.definition)
}

export function sameOwnerGoalConditions(left, right) {
  const conditions = definition => ({ scope: definition.scope, done_when: definition.done_when.map(({ id, ...condition }) => condition) })
  return JSON.stringify(conditions(left)) === JSON.stringify(conditions(right))
}
