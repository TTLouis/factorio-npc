import { createLogg } from '@guiiai/logg'
import { v2FactorioConsoleCommandRawPost } from 'factorio-rcon-api-client'
import { z } from 'zod'
import { factorioNameSchema, renderLuaString } from './operations'

const logger = createLogg('production-scope-tool').useGlobalConfig()

const targetSchema = z.object({
  type: z.enum(['item', 'fluid']),
  name: factorioNameSchema,
}).strict()

export const productionScopeSchema = z.object({
  calculation_id: factorioNameSchema,
  target: targetSchema,
  max_depth: z.number().int().min(0).max(6).optional(),
  max_materials: z.number().int().min(1).max(32).optional(),
}).strict()

export function renderProductionScopeRequest(raw: unknown) {
  const request = productionScopeSchema.parse(raw)
  const fields = [
    `calculation_id=${renderLuaString(request.calculation_id)}`,
    `target={type=${renderLuaString(request.target.type)},name=${renderLuaString(request.target.name)}}`,
  ]
  if (request.max_depth !== undefined) fields.push(`max_depth=${request.max_depth}`)
  if (request.max_materials !== undefined) fields.push(`max_materials=${request.max_materials}`)
  return `{${fields.join(',')}}`
}

export const getProductionScopeTool = {
  name: 'getProductionScope',
  description: 'Read bounded current-surface observed production, consumption, and net flow for one target and its relevant upstream materials over 1m and 10m windows. Use this before solveProduction when the user did not specify a production rate. This tool returns facts only and never recommends or selects target_rate; the model must choose the intended scope. If the user already gave an explicit rate/scope, skip this extra observation.',
  schema: productionScopeSchema,
  fn: async ({ parameters }: { parameters: unknown }) => {
    const request = productionScopeSchema.parse(parameters)
    const rendered = renderProductionScopeRequest(request)
    const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning", "scope_context", ${rendered})))`
    const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
    logger.withFields({ output: response.data.output, calculation_id: request.calculation_id }).debug('Production scope context')
    return response.data.output
  },
}
