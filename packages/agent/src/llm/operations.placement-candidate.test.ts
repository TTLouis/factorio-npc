import { describe, expect, it } from 'vitest'
import { parseStructuredOperations, renderStructuredOperation } from './operations'

describe('placement candidate operation', () => {
  it('accepts bounded generated candidate identities and renders exact execution', () => {
    const [operation] = parseStructuredOperations([{
      name: 'place_candidate',
      args: {
        candidate_set_id: 'placement-12',
        candidate_id: 'candidate-3',
      },
    }])

    expect(operation.name).toBe('place_candidate')
    expect(renderStructuredOperation(operation)).toBe(
      "remote.call('autorio_operations', 'place_candidate', 'placement-12', 'candidate-3')",
    )
  })

  it('rejects arbitrary candidate identifiers', () => {
    expect(() => parseStructuredOperations([{
      name: 'place_candidate',
      args: {
        candidate_set_id: "placement-1'); game.reset_time_played(); --",
        candidate_id: 'candidate-1',
      },
    }])).toThrow()

    expect(() => parseStructuredOperations([{
      name: 'place_candidate',
      args: {
        candidate_set_id: 'placement-1',
        candidate_id: 'mine-here',
      },
    }])).toThrow()
  })
})
