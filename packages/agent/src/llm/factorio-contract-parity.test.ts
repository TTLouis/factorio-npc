import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import contract from '../../../../contracts/factorio-tool-contract.json'
import { agentTools } from './tool-set'

const operationsPath = fileURLToPath(new URL('./operations.ts', import.meta.url))
const operationsSource = readFileSync(operationsPath, 'utf8')

type ContractSurface = 'ordinary-agent' | 'pterodactyl-runtime-v8'
type OperationContract = { surfaces: ContractSurface[], pterodactyl_layer: 'staging-base' | 'runtime-v8-extension' }
type ToolContract = { remote: string[], category: string, surfaces: ContractSurface[], surface_policy: 'shared' | 'runtime-v8-only' | 'ordinary-agent-only' }
const operationContract = contract.operations as Record<string, OperationContract>
const toolContract = contract.tools as Record<string, ToolContract>

function agentOperationNames() {
  const union = operationsSource.match(/export const structuredOperationSchema = z\.discriminatedUnion\('name', \[([\s\S]*?)\n\]\)/)?.[1]
  if (!union) throw new Error('structuredOperationSchema union must remain discoverable')
  return [...union.matchAll(/name: z\.literal\('([^']+)'\)/g)].map(match => match[1]).sort()
}

function namesForSurface(definitions: Record<string, { surfaces: ContractSurface[] }>, surface: ContractSurface) {
  return Object.entries(definitions)
    .filter(([, definition]) => definition.surfaces.includes(surface))
    .map(([name]) => name)
    .sort()
}

function toolsWithPolicy(policy: ToolContract['surface_policy']) {
  return Object.entries(toolContract)
    .filter(([, definition]) => definition.surface_policy === policy)
    .map(([name]) => name)
    .sort()
}

describe('canonical Factorio provider contract parity', () => {
  it('keeps ordinary-agent structured operations exactly aligned with declared surfaces', () => {
    expect(agentOperationNames()).toEqual(namesForSurface(operationContract, 'ordinary-agent'))
  })

  it('documents intentional runtime-v8-only structured operations instead of pretending full symmetry', () => {
    expect(Object.entries(operationContract)
      .filter(([, definition]) => !definition.surfaces.includes('ordinary-agent'))
      .map(([name]) => name)
      .sort()).toEqual(['execute_construction_plan', 'gather_resource', 'launch_rocket', 'supply_entity'])
  })

  it('keeps the complete ordinary-agent tool surface aligned with the manifest', () => {
    expect(agentTools.map(tool => tool.name).sort()).toEqual(namesForSurface(toolContract, 'ordinary-agent'))
  })

  it('records current runtime-v8-only tools as intentional surface differences', () => {
    expect(toolsWithPolicy('runtime-v8-only')).toEqual([
      'estimateProductionTime',
      'findSkills',
      'getLocalSpatialObservation',
      'getMiningDetails',
      'getResearchPath',
      'getResearchRequest',
      'getSkillDetails',
      'measureTransportThroughput',
      'planPlacement',
      'validateConstructionPlan',
    ])
    expect(toolsWithPolicy('ordinary-agent-only')).toEqual([])
  })

  it('recognizes capabilities that became shared after the cleanup branch was cut', () => {
    expect(toolContract.getPlacementCandidates?.surface_policy).toBe('shared')
    expect(toolContract.findConstructionSites?.surface_policy).toBe('shared')
    expect(toolContract.getPlacementCandidates?.surfaces.sort()).toEqual(['ordinary-agent', 'pterodactyl-runtime-v8'])
    expect(toolContract.findConstructionSites?.surfaces.sort()).toEqual(['ordinary-agent', 'pterodactyl-runtime-v8'])
  })

  it('keeps canonical planning remote mappings explicit', () => {
    expect(toolContract.getPlacementCandidates?.remote).toEqual(['autorio_tools', 'get_placement_candidates'])
    expect(toolContract.getProductionScope?.remote).toEqual(['autorio_planning', 'scope_context'])
    expect(toolContract.solveProduction?.remote).toEqual(['autorio_planning', 'solve'])
    expect(toolContract.getTransportCapacity?.remote).toEqual(['autorio_planning', 'capacity'])
    expect(toolContract.findConstructionSites?.remote).toEqual(['autorio_planning', 'find_construction_sites'])
    expect(toolContract.inspectConstructionIntent?.remote).toEqual(['autorio_map_construction', 'intent'])
  })

  it('keeps shared hard limits explicit for every adapter', () => {
    expect(contract.limits).toMatchObject({
      factorio_name_max_length: 200,
      operation_batch_max: 16,
      task_count_max: 1000,
      transfer_count_max: 100000,
      search_radius_max: 4096,
      combat_search_radius_max: 256,
      follow_distance_max: 64,
      equipment_slot_max: 64,
      placement_coordinate_abs_max: 1000000,
      placement_direction_max: 15,
      production_rate_max: 1000000000,
      wait_ticks_max: 360000,
    })
  })
})
