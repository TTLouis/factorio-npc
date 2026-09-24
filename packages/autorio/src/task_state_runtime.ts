import { TaskStates } from './types'

type NonIdleTaskState = Exclude<TaskStates, TaskStates.IDLE>

export const SUPPORTED_RUNTIME_TASK_STATES = [
  TaskStates.WALKING_TO_ENTITY,
  TaskStates.WALKING_DIRECT,
  TaskStates.MINING,
  TaskStates.HARVESTING,
  TaskStates.CLEARING_AREA,
  TaskStates.PLACING,
  TaskStates.ROTATING,
  TaskStates.MOVING_ITEMS,
  TaskStates.SETTING_RECIPE,
  TaskStates.LAUNCHING_ROCKET,
  TaskStates.CRAFTING,
  TaskStates.RESEARCHING,
  TaskStates.ATTACKING,
  TaskStates.WAITING,
] as const satisfies readonly NonIdleTaskState[]

export type RuntimeTaskState = (typeof SUPPORTED_RUNTIME_TASK_STATES)[number]

type MissingRuntimeTaskState = Exclude<NonIdleTaskState, RuntimeTaskState>
type ExtraRuntimeTaskState = Exclude<RuntimeTaskState, NonIdleTaskState>

export const RUNTIME_TASK_STATE_CONTRACT_COMPLETE:
  [MissingRuntimeTaskState, ExtraRuntimeTaskState] extends [never, never] ? true : never = true

export function is_runtime_task_state(state: unknown): state is RuntimeTaskState {
  for (const supported_state of SUPPORTED_RUNTIME_TASK_STATES) {
    if (state === supported_state) return true
  }
  return false
}

export function unsupported_task_state_reason(state: unknown) {
  return `unsupported_task_state:${state}`
}
