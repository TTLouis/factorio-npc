// Test-only two-model bridge. Uses the production Session model resolver with
// scripted providers; never imports a live transport or credentials.
import { configuration, Session } from './supervisor.mjs'
import { recoveryWorld } from './recovery-loop-fixtures.mjs'

export const PLANNER_MODEL = 'gpt-6.1-sol'
export const EXECUTOR_MODEL = 'gpt-6-luna'
export function delegatedRecoveryWorld(options) {
  const requests = []
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, {
    SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only-not-a-real-key',
    OPENAI_API_BASEURL: 'https://provider.example.test/v1', AI_API_METHOD: 'local',
    OPENAI_MODEL: `${PLANNER_MODEL},${EXECUTOR_MODEL}`,
  })
  bridge.provider = async (request, messages, context) => {
    requests.push({ model: request.model, role: context?.role ?? 'planner', handoff_id: context?.handoffId })
    return options.model.provide(messages, context)
  }
  const world = recoveryWorld({ ...options, agentRoleConfig: bridge.config,
    roleProvider: (messages, context) => bridge.roleProvider(messages, context),
  })
  return { ...world, modelRequests: requests }
}
