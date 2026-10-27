import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  remote: vi.fn(),
}))

vi.mock('./map_construction', () => ({
  execute_prepared_remote_construction_plan: mocks.remote,
  is_prepared_remote_construction_plan: () => false,
}))

import { execute_validated_construction_plan } from './construction_execution'

describe('validated construction execution routing', () => {
  beforeEach(() => {
    mocks.remote.mockReset()
    ;(globalThis as any).storage = {}
  })

  it('executes a prepared remote ghost validation through the existing construction operation', () => {
    mocks.remote.mockReturnValue([true, 'Remote ghost staged; world completion is pending_robot_fulfillment'])
    const actor = { is_valid: true } as unknown as ControlledActor
    const basic = {} as any
    const manager = {} as any

    expect(execute_validated_construction_plan(actor, 7, 1, basic, manager)).toEqual([
      true,
      'Remote ghost staged; world completion is pending_robot_fulfillment',
    ])
    expect(mocks.remote).toHaveBeenCalledWith(actor, 7, 1)
  })

  it('falls through to the existing local validation path when the id is not remote', () => {
    mocks.remote.mockReturnValue(undefined)
    const actor = { is_valid: true } as unknown as ControlledActor

    expect(execute_validated_construction_plan(actor, 7, 1, {} as any, {} as any)).toEqual([
      false,
      'validated construction plan is unavailable or superseded',
    ])
  })
})
