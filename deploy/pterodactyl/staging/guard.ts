type ActorMode = 'player' | 'npc'
type Store = {
  sgluna_deployment_session?: string
  sgluna_deployment_mode?: ActorMode
  sgluna_deployment_actor_id?: number
  sgluna_deployment_actor_kind?: string
  sgluna_deployment_epoch?: number
}

declare const storage: Store

function state(): Store {
  return storage as unknown as Store
}

function actor_status() {
  return remote.call('autorio_actor', 'status') as {
    mode?: ActorMode
    actor?: {
      actor_id?: number
      kind?: string
      valid?: boolean
      has_character?: boolean
      name?: string
      npc_id?: string
    }
    connected_players?: number
  }
}

function operation_status() {
  return remote.call('autorio_operations', 'status') as {
    task_state?: string
    queue_empty?: boolean
    queue_length?: number
  }
}

function current_matches_session() {
  const data = state()
  if (!data.sgluna_deployment_session || !data.sgluna_deployment_mode || data.sgluna_deployment_actor_id === undefined || !data.sgluna_deployment_actor_kind) return false
  const status = actor_status()
  const actor = status.actor
  if (!actor || actor.valid !== true || actor.has_character !== true) return false
  if (status.mode !== data.sgluna_deployment_mode || actor.actor_id !== data.sgluna_deployment_actor_id || actor.kind !== data.sgluna_deployment_actor_kind) return false
  if (data.sgluna_deployment_mode === 'npc') return actor.kind === 'standalone_character'
  return actor.kind === 'connected_player'
}

function cancel_tasks() {
  const operations = remote.interfaces.autorio_operations
  if (operations !== undefined) {
    // Persistent modes are runtime state, not queued tasks. Disable follow first
    // so a later idle tick cannot silently re-admit player navigation after the
    // deployment/task cancellation has completed. Keep the guard compatible
    // with older/minimal Autorio interfaces that do not expose follow yet.
    if (operations.stop_follow_player !== undefined) remote.call('autorio_operations', 'stop_follow_player')
    remote.call('autorio_operations', 'cancel_all_tasks')
  }
}

remote.add_interface('sgluna_deployment', {
  configure: (mode: ActorMode, session: string) => {
    if ((mode !== 'npc' && mode !== 'player') || session === '') return false

    cancel_tasks()
    const changed = remote.call('autorio_actor', 'set_mode', mode) as [boolean, unknown]
    if (!changed || changed[0] !== true) return false

    const status = actor_status()
    const actor = status.actor
    if (!actor || status.mode !== mode || actor.valid !== true || actor.has_character !== true || actor.actor_id === undefined) return false
    if (mode === 'npc' && actor.kind !== 'standalone_character') return false
    if (mode === 'player' && actor.kind !== 'connected_player') return false

    const data = state()
    data.sgluna_deployment_mode = mode
    data.sgluna_deployment_session = session
    data.sgluna_deployment_actor_id = actor.actor_id
    data.sgluna_deployment_actor_kind = actor.kind
    data.sgluna_deployment_epoch = (data.sgluna_deployment_epoch ?? 0) + 1
    return session
  },
  status: () => {
    const actor = actor_status()
    const tasks = operation_status()
    return {
      revision: 'sgluna-deploy-v8-npc-staging',
      session: state().sgluna_deployment_session ?? '',
      mode: state().sgluna_deployment_mode,
      actor_id: actor.actor?.actor_id,
      actor_kind: actor.actor?.kind,
      actor_name: actor.actor?.name,
      npc_id: actor.actor?.npc_id,
      connected_players: actor.connected_players ?? 0,
      allowed: current_matches_session(),
      idle: tasks.task_state === 'idle' && tasks.queue_empty === true && tasks.queue_length === 0,
      epoch: state().sgluna_deployment_epoch ?? 0,
      tools: remote.interfaces.autorio_tools !== undefined,
      operations: remote.interfaces.autorio_operations !== undefined,
      actor_interface: remote.interfaces.autorio_actor !== undefined,
    }
  },
  authorize: (epoch: number) => current_matches_session() && epoch === (state().sgluna_deployment_epoch ?? 0),
  cancel: () => {
    cancel_tasks()
    state().sgluna_deployment_epoch = (state().sgluna_deployment_epoch ?? 0) + 1
    return true
  },
  disable: () => {
    cancel_tasks()
    state().sgluna_deployment_session = ''
    state().sgluna_deployment_epoch = (state().sgluna_deployment_epoch ?? 0) + 1
    return true
  },
})
