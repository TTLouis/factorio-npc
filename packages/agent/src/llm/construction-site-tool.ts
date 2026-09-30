import { createLogg } from '@guiiai/logg'
import { v2FactorioConsoleCommandRawPost } from 'factorio-rcon-api-client'
import { z } from 'zod'

const logger = createLogg('construction-site-tool').useGlobalConfig()

const positionSchema = z.object({
  x: z.number().finite().min(-1000000).max(1000000),
  y: z.number().finite().min(-1000000).max(1000000),
}).strict()

export const constructionSiteSchema = z.object({
  width: z.number().int().min(2).max(32),
  height: z.number().int().min(2).max(32),
  anchor_unit_number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  position: positionSchema.optional(),
  search_radius: z.number().int().min(2).max(64).optional(),
  max_candidates: z.number().int().min(1).max(8).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.anchor_unit_number !== undefined && value.position !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provide anchor_unit_number or position, not both' })
  }
})

export function renderConstructionSiteRequest(raw: unknown) {
  const request = constructionSiteSchema.parse(raw)
  const fields = [
    `width=${request.width}`,
    `height=${request.height}`,
  ]
  if (request.anchor_unit_number !== undefined) fields.push(`anchor_unit_number=${request.anchor_unit_number}`)
  if (request.position !== undefined) fields.push(`position={x=${request.position.x},y=${request.position.y}}`)
  if (request.search_radius !== undefined) fields.push(`search_radius=${request.search_radius}`)
  if (request.max_candidates !== undefined) fields.push(`max_candidates=${request.max_candidates}`)
  return `{${fields.join(',')}}`
}

export const findConstructionSitesTool = {
  name: 'findConstructionSites',
  description: 'Find a small bounded set of clear rectangular construction envelopes on SGLuna\'s current surface. The model chooses width/height and anchor; the tool only reports deterministic free-site candidates and aggregate rejection counts. A site is not a machine layout or construction approval: choose exact placements separately and validateConstructionPlan before execution.',
  schema: constructionSiteSchema,
  fn: async ({ parameters }: { parameters: unknown }) => {
    const request = constructionSiteSchema.parse(parameters)
    const rendered = renderConstructionSiteRequest(request)
    const input = `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning", "find_construction_sites", ${rendered})))`
    const response = await v2FactorioConsoleCommandRawPost({ body: { input } })
    logger.withFields({ output: response.data.output, width: request.width, height: request.height }).debug('Construction site candidates')
    return response.data.output
  },
}
