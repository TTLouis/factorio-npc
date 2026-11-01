import { createLogg } from '@guiiai/logg'
import { v2FactorioConsoleCommandRawPost } from 'factorio-rcon-api-client'
import { z } from 'zod'
import { factorioNameSchema, renderLuaString } from './operations'

const logger = createLogg('production-planning-tool').useGlobalConfig()

const targetSchema = z.object({
  type: z.enum(['item', 'fluid']),
  name: factorioNameSchema,
  rate_per_second: z.number().positive().max(1_000_000_000),
}).strict()

const machineSelectionSchema = z.object({
  recipe_name: factorioNameSchema,
  machine_name: factorioNameSchema,
}).strict()

export const solveProductionSchema = z.object({
  calculation_id: factorioNameSchema,
  target: targetSchema,
  included_recipe_names: z.array(factorioNameSchema).max(64).optional(),
  machine_selections: z.array(machineSelectionSchema).max(64).optional(),
}).strict()

function luaStringArray(values: string[]) {
  return `{${values.map(renderLuaString).join(',')}}`
}

export function renderProductionSolveRequest(raw: unknown) {
  const request = solveProductionSchema.parse(raw)
  const fields = [
    `calculation_id=${renderLuaString(request.calculation_id)}`,
    `target={type=${renderLuaString(request.target.type)},name=${renderLuaString(request.target.name)},rate_per_second=${request.target.rate_per_second}}`,
  ]
  if (request.included_recipe_names !== undefined) {
    fields.push(`included_recipe_names=${luaStringArray(request.included_recipe_names)}`)
  }
  if (request.machine_selections !== undefined) {
    const selections = request.machine_selections.map(selection => `{recipe_name=${renderLuaString(selection.recipe_name)},machine_name=${renderLuaString(selection.machine_name)}}`)
    fields.push(`machine_selections={${selections.join(',')}}`)
  }
  return `{${fields.join(',')}}`
}

export const solveProductionTool = {
  name: 'solveProduction',
  description: 'Deterministically solve a bounded production target from live enabled Factorio recipes. Returns exact recipe/external-input rates, optional explicit machine sizing, bounded alternative recipe routes, and compact topology strategy candidates. Route/topology candidate ordering is canonical, not a ranking: the model chooses among them. Topology candidates are not executable layouts and their requires_validation fields remain blockers until the matching transport/adjacency checks are satisfied.',
  schema: solveProductionSchema,
  fn: async ({ parameters }: { parameters: unknown }) => {
    const request = solveProductionSchema.parse(parameters)
    const rendered = renderProductionSolveRequest(request)
    const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning", "solve", ${rendered})))`
    const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
    logger.withFields({ output: response.data.output, calculation_id: request.calculation_id }).debug('Production solve')
    return response.data.output
  },
}
