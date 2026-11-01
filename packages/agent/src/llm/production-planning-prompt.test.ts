import { describe, expect, it } from 'vitest'
import prompt from './production-planning-prompt.md?raw'

describe('production planning prompt contract', () => {
  it('requires deterministic solving and forbids unvalidated transport throughput guesses', () => {
    expect(prompt).toContain('Use `solveProduction` for production-rate planning')
    expect(prompt).toContain('Do not replace a rejected deterministic result with guessed arithmetic')
    expect(prompt).toContain('Use `getTransportCapacity` when a production design depends on belt transport')
    expect(prompt).toContain('stacked-belt result is only the belt\'s transport ceiling')
    expect(prompt).toContain('prefer `kind: "inserter_instance"` with its exact Factorio `unit_number`')
    expect(prompt).toContain('Both inserter forms deliberately keep `transfer_rate.validated` false')
    expect(prompt).toContain('Never turn hand size, target pickup count, rotation speed, or extension speed into a guessed fixed throughput')
  })

  it('uses deterministic construction geometry instead of remembered footprint guesses', () => {
    expect(prompt).toContain('## Construction geometry harness')
    expect(prompt).toContain('`physical_footprint` separately from any `working_area`')
    expect(prompt).toContain('Do not confuse `physical_footprint`/`collision_box` with a mining drill\'s `working_area.mining.radius`')
    expect(prompt).toContain('prefer `validateConstructionPlan` before issuing placement operations')
    expect(prompt).toContain('A `PLANNED_COLLISION` response includes geometry for both conflicting placements')
    expect(prompt).toContain('A `WORLD_COLLISION` response includes the rejected placement geometry plus a bounded spatial context')
    expect(prompt).toContain('successful construction validation returns `placement_geometry`')
  })

  it('gives the latest human steering precedence over stale remaining-plan intent', () => {
    expect(prompt).toContain('## User steering and decision priority')
    expect(prompt).toContain('latest direct human instruction is authoritative for pending intent')
    expect(prompt).toContain('refine, reorder, replace, or drop the remaining work')
    expect(prompt).toContain('Preserve verified completed evidence')
    expect(prompt).toContain('never let an older durable objective or stale plan text override the latest human steering')
    expect(prompt).toContain('A bare `continue`/`resume`/`继续` means resume the existing durable goal')
    expect(prompt).toContain('User steering changes future decisions; it does not rewrite history')
    expect(prompt).toContain('Never claim a world-changing action succeeded from intent alone')
  })

  it('treats model turns as observation boundaries and keeps deterministic micro-recovery in runtime', () => {
    expect(prompt).toContain('Treat a model turn as an observation/decision boundary, not as an operation boundary')
    expect(prompt).toContain('next 2-4 operations are already fully parameterized')
    expect(prompt).toContain('finish that local group before leaving')
    expect(prompt).toContain('locality preference, not a route solver')
    expect(prompt).toContain('never invent coordinates or identities')
    expect(prompt).toContain('Do not insert `wait` between finite Autorio operations merely to let them finish')
    expect(prompt).toContain('do not walk SGLuna onto the build coordinate')
    expect(prompt).toContain('runtime approaches only as close as required and may step SGLuna aside')
    expect(prompt).toContain('`placing:not_placeable` failure means that attempted placement did not create an entity')
  })
})
