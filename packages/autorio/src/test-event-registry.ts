// Backing store for the stubbed Factorio lifecycle registrations in test-setup.ts:
// control.ts registers real event handlers here at module load, and actor_controller
// registers its on_load handler here so tests can exercise save/load reconciliation.
export const event_handlers = new Map<unknown, (event: any) => void>()

let load_handler: (() => void) | undefined
let init_handler: (() => void) | undefined
let configuration_changed_handler: (() => void) | undefined

export function set_init_handler(handler: (() => void) | undefined) {
  init_handler = handler
}

export function set_configuration_changed_handler(handler: (() => void) | undefined) {
  configuration_changed_handler = handler
}

export function get_init_handler() {
  if (!init_handler) throw new Error('No on_init handler registered')
  return init_handler
}

export function get_configuration_changed_handler() {
  if (!configuration_changed_handler) throw new Error('No on_configuration_changed handler registered')
  return configuration_changed_handler
}

export function set_load_handler(handler: (() => void) | undefined) {
  load_handler = handler
}

export function get_load_handler() {
  if (!load_handler) {
    throw new Error('No on_load handler registered')
  }
  return load_handler
}

export function get_handler(event_key: unknown) {
  const handler = event_handlers.get(event_key)
  if (!handler) {
    throw new Error(`No handler registered for event key: ${String(event_key)}`)
  }
  return handler
}
