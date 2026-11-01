import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { refusal_class_by_code, refusal_class_of, REFUSAL_CLASSES, with_refusal_class } from './refusal_classes'

// Completeness by construction. `autorio_preflight.operation` can only refuse with a code that some function below writes down
// as a literal, so scanning exactly those functions finds every code the harness can ever receive from the mod. The file/function
// list is explicit on purpose: a new module that produces preflight refusals must be added here, and the test then fails until
// each of its codes has a class in refusal_classes.ts. A code in the registry that no producer writes fails the other way.
//
// What the scan recognises (all other string literals in these functions are ignored):
//   reject('code'                 the local reject helpers of control.ts, navigation_position_preflight.ts, research_preflight.ts
//   code: 'a' | 'b'               result objects (placement, bootstrap, transfer, candidates) and their TypeScript unions
//   return 'code'                 research_error(), whose result research_preflight.ts forwards as `reject(code, ...)`
//   type XCode = 'a' | 'b'        the transfer code unions that `transfer_preflight_facts` returns as `code`
// Codes produced through a variable (reject(facts.code), reject(code)) are covered by the literals that feed the variable.
interface Producer { file: string, fn?: string, returns?: boolean, types?: string[] }
const PRODUCERS: Producer[] = [
  { file: 'control.ts', fn: 'operation_preflight' },
  { file: 'navigation_position_preflight.ts' },
  { file: 'placement_preflight.ts' },
  { file: 'placement_item.ts' },
  { file: 'construction_execution.ts', fn: 'construction_plan_preflight' },
  { file: 'placement_candidates.ts', fn: 'placement_candidate_preflight' },
  { file: 'research_preflight.ts' },
  { file: 'research.ts', fn: 'research_error', returns: true },
  { file: 'transfer_preflight.ts', types: ['TransferItemRefusalCode', 'TransferPreflightCode'] },
  { file: 'bootstrap_planning.ts', fn: 'requires_machine_result' },
  { file: 'bootstrap_planning.ts', fn: 'craft_bootstrap_preflight_for_actor' },
]

function source(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
}

function region(text: string, fn: string): string {
  const start = text.search(new RegExp(`^(?:export )?function ${fn}\\b`, 'm'))
  if (start < 0) throw new Error(`function ${fn} not found`)
  const end = text.indexOf('\n}\n', start)
  return text.slice(start, end < 0 ? undefined : end + 2)
}

function quoted(text: string): string[] {
  return [...text.matchAll(/'([a-z][a-z0-9_]*)'/g)].map(match => match[1])
}

function scan(producer: Producer): string[] {
  const text = source(producer.file)
  const body = producer.fn ? region(text, producer.fn) : text
  const codes: string[] = []
  for (const match of body.matchAll(/\breject\(\s*'([a-z][a-z0-9_]*)'/g)) codes.push(match[1])
  for (const match of body.matchAll(/\bcode\??:\s*((?:'[a-z][a-z0-9_]*'\s*\|?\s*)+)/g)) codes.push(...quoted(match[1]))
  if (producer.returns) for (const match of body.matchAll(/\breturn '([a-z][a-z0-9_]*)'/g)) codes.push(match[1])
  for (const type of producer.types ?? []) {
    const declaration = body.match(new RegExp(`type ${type}\\s*=\\s*([^\\n]+)`))
    if (!declaration) throw new Error(`type ${type} not found in ${producer.file}`)
    codes.push(...quoted(declaration[1]))
  }
  return codes
}

describe('refusal class registry', () => {
  it('uses a closed set of classes and gives every code one of them', () => {
    expect([...REFUSAL_CLASSES]).toEqual(['argument', 'authority', 'prerequisite', 'world'])
    for (const [code, refusal_class] of Object.entries(refusal_class_by_code)) {
      expect(REFUSAL_CLASSES, code).toContain(refusal_class)
    }
  })

  it('finds each producer and a code in each of them (the scan itself is not silently empty)', () => {
    for (const producer of PRODUCERS) {
      expect(scan(producer).length, `${producer.file} ${producer.fn ?? ''}`).toBeGreaterThan(0)
    }
  })

  it('has a class for every code a preflight producer writes, and no class for a code nothing produces', () => {
    const produced = new Set<string>()
    for (const producer of PRODUCERS) for (const code of scan(producer)) produced.add(code)

    const registered = new Set(Object.keys(refusal_class_by_code))
    expect([...produced].filter(code => !registered.has(code)).sort(), 'produced but unclassified').toEqual([])
    expect([...registered].filter(code => !produced.has(code)).sort(), 'classified but never produced').toEqual([])
  })

  it('keeps the owner-pending "nothing found in radius" family on the world path', () => {
    for (const code of ['resource_source_not_found', 'navigation_target_not_found', 'natural_harvest_source_not_found',
      'resource_source_insufficient', 'supply_destination_conflict', 'player_unavailable']) {
      expect(refusal_class_of(code), code).toBe('world')
    }
  })
})

describe('with_refusal_class', () => {
  it('attaches the registered class to a refusal and keeps every other field', () => {
    expect(with_refusal_class({ ok: false, code: 'unknown_prototype', operation: 'place_entity', identity: 'x' }))
      .toEqual({ ok: false, code: 'unknown_prototype', operation: 'place_entity', identity: 'x', refusal_class: 'argument' })
    expect(with_refusal_class({ ok: false, code: 'force_busy' })).toMatchObject({ refusal_class: 'prerequisite' })
    expect(with_refusal_class({ ok: false, code: 'stale_exact_target' })).toMatchObject({ refusal_class: 'world' })
  })

  it('leaves accepted results, unknown codes and an already-declared class alone', () => {
    const accepted = { ok: true, operation: 'craft_item' }
    expect(with_refusal_class(accepted)).toBe(accepted)
    const unknown = { ok: false, code: 'a_code_nobody_registered' }
    expect(with_refusal_class(unknown)).toBe(unknown)
    expect(with_refusal_class(unknown)).not.toHaveProperty('refusal_class')
    const declared = { ok: false, code: 'unknown_prototype', refusal_class: 'authority' }
    expect(with_refusal_class(declared)).toBe(declared)
    expect(refusal_class_of(undefined)).toBeUndefined()
  })
})
