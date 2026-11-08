// Select a lifecycle, never a different world implementation.
export const HARNESS_MODES = Object.freeze(['external', 'plan', 'pursuit'])

function invalid(code) {
  return Object.assign(new Error(code), { code, publicMessage: code })
}

export function resolveHarnessMode({ mode, env = process.env, defaultMode = 'external' } = {}) {
  const configured = env.SGLUNA_HARNESS_MODE
  for (const value of [mode, configured, defaultMode]) {
    if (value !== undefined && !HARNESS_MODES.includes(value)) throw invalid('invalid_harness_mode')
  }
  if (mode !== undefined && configured !== undefined && mode !== configured) throw invalid('conflicting_harness_mode')
  return mode ?? configured ?? defaultMode
}

// Legacy entrypoints retain their old default without ignoring a different
// requested lifecycle. Switching an active controller is never implicit.
export function requireHarnessMode(expected, env = process.env) {
  return resolveHarnessMode({ mode: expected, env, defaultMode: expected })
}
