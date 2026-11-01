// Compact, exact summary of a technology's research trigger.
//
// Factorio 2.0 ResearchTrigger (lua-api.factorio.com/2.0.77/concepts/ResearchTrigger.html):
//   craft-item          item :: ItemIDFilter, count
//   mine-entity         entity :: string
//   craft-fluid         fluid :: string, amount
//   send-item-to-orbit  item :: ItemIDFilter
//   capture-spawner     entity :: string?
//   build-entity        entity :: EntityIDFilter
// ItemIDFilter / EntityIDFilter are tables {name, quality?, comparator?}, not
// strings. Copying only string fields dropped the item of steam-power's
// craft-item trigger, so the model read `{type='craft-item',count=50}` and
// treated it as lab research. Every name field is read in both forms.
type TriggerSummary = {
  type: string
  item?: string
  item_quality?: string
  count?: number
  entity?: string
  entity_quality?: string
  fluid?: string
  amount?: number
}

const NAME_FIELDS = ['item', 'entity', 'fluid'] as const
const NUMBER_FIELDS = ['count', 'amount'] as const

// A trigger id is a plain name or an ID filter table; quality only when the
// filter names one.
export function trigger_id(value: unknown): { name: string, quality?: string } | undefined {
  if (typeof value === 'string') return value.length > 0 ? { name: value } : undefined
  if (typeof value !== 'object' || value === undefined || value === null) return undefined
  const filter = value as { name?: unknown, quality?: unknown }
  if (typeof filter.name !== 'string' || filter.name.length === 0) return undefined
  return typeof filter.quality === 'string' ? { name: filter.name, quality: filter.quality } : { name: filter.name }
}

export function research_trigger_summary(name: string): TriggerSummary | undefined {
  const prototype = prototypes.technology[name]
  const trigger = prototype?.research_trigger as any
  if (!trigger || typeof trigger.type !== 'string') return undefined

  const result: TriggerSummary = { type: trigger.type }
  for (const key of NAME_FIELDS) {
    const id = trigger_id(trigger[key])
    if (id === undefined) continue
    result[key] = id.name
    if (id.quality !== undefined && key === 'item') result.item_quality = id.quality
    if (id.quality !== undefined && key === 'entity') result.entity_quality = id.quality
  }
  for (const key of NUMBER_FIELDS) {
    if (typeof trigger[key] === 'number') result[key] = trigger[key]
  }
  return result
}

export function with_research_trigger<T extends Record<string, unknown>>(name: string, technology: T) {
  const trigger = research_trigger_summary(name)
  if (!trigger) return technology
  return {
    ...technology,
    trigger_type: trigger.type,
    research_trigger: trigger,
  }
}
