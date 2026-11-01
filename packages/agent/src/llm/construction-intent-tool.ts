import { v2FactorioConsoleCommandRawPost } from 'factorio-rcon-api-client'
import { z } from 'zod'
import { factorioNameSchema, renderLuaString } from './operations'

const constructionIntentSchema = z.object({
  surface_index: z.number().int().min(1).max(4294967295).optional(),
  x: z.number().min(-1000000).max(1000000),
  y: z.number().min(-1000000).max(1000000),
  entity_name: factorioNameSchema,
  direction: z.number().int().min(0).max(15).optional(),
  prepare_execution: z.boolean().default(false),
}).strict()

export const constructionIntentTool = {
  name: 'inspectConstructionIntent',
  description: 'Compact deterministic construction check: ghost placeability plus fixed/personal-roboport fulfillment. Set prepare_execution=true to reserve a validation token; this tool does not mutate the world. Execute the returned execute_construction_plan token only if you choose to stage the ghost.',
  schema: constructionIntentSchema,
  fn: async ({ parameters }: any) => {
    const parsed = constructionIntentSchema.parse(parameters ?? {})
    const surface = parsed.surface_index === undefined ? 'nil' : String(parsed.surface_index)
    const direction = parsed.direction === undefined ? 'nil' : String(parsed.direction)
    const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_map_construction", "intent", ${surface}, ${parsed.x}, ${parsed.y}, ${renderLuaString(parsed.entity_name)}, ${direction}, ${parsed.prepare_execution})))`
    const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
    return response.data.output
  },
}
