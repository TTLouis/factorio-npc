import { describe, expect, it } from 'vitest'
import spatialPlacementPrompt from './spatial-placement-prompt.md?raw'

describe('spatial placement prompt contract', () => {
  it('requires runtime-derived spatial semantics and candidate execution', () => {
    expect(spatialPlacementPrompt).toContain('capability-driven from the current game instance')
    expect(spatialPlacementPrompt).toContain('spatial.mining')
    expect(spatialPlacementPrompt).toContain('resource_coverage')
    expect(spatialPlacementPrompt).toContain('getPlacementCandidates')
    expect(spatialPlacementPrompt).toContain('target_resource')
    expect(spatialPlacementPrompt).toContain('fluid_ports')
    expect(spatialPlacementPrompt).toContain('surface.can_place_entity')
    expect(spatialPlacementPrompt).toContain('modded entities')
    expect(spatialPlacementPrompt).toContain('place_candidate')
    expect(spatialPlacementPrompt).toContain('Do not copy the candidate\'s coordinates back into `place_entity`')
    expect(spatialPlacementPrompt).toContain('A nearby entity is not proof of a working logistics connection')
  })
})
