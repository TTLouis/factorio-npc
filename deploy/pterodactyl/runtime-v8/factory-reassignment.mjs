import { FactoryRegistryError } from './factory-registry.mjs'
const fail = code => { throw new FactoryRegistryError(code, code) }
const rows = value => Array.isArray(value) ? value : value && typeof value === 'object' && !Object.keys(value).length ? [] : undefined
const known = value => value?.state === 'known' && value.truncated === false
// Native data only. This cut deliberately has no physical operation: an empty
// unselected furnace chooses this unique enabled recipe when legal input arrives.
export function emptyFurnaceAssignment(cell, declaration, native) {
  if (!declaration || Object.keys(declaration).some(key => !['cell_id', 'product', 'resource'].includes(key))
    || declaration.cell_id !== cell.cell_id || ![declaration.product, declaration.resource].every(v => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(v))
    || cell.members.length !== 1 || cell.support || cell.state === 'retired') fail('factory_reassignment_unsupported')
  const row = native?.members?.[0]; const member = cell.members[0]
  if (native?.members?.length !== 1 || row?.state !== 'observed' || row.type !== 'furnace'
    || ['unit_number', 'name', 'surface_index', 'force_index'].some(key => row.locator?.[key] !== member[key])
    || row.locator?.position?.x !== member.position.x || row.locator?.position?.y !== member.position.y
    || row.recipe?.state !== 'none' || !known(row.progress_facts?.crafting_progress) || row.progress_facts.crafting_progress.value !== 0
    || !Array.isArray(row.inventories) || !['input', 'output', 'fuel'].every(role => row.inventories.some(inv => inv.role === role))
    || row.inventories.some(inv => !known(inv) || rows(inv.items)?.length !== 0)) fail('factory_reassignment_empty_native_required')
  const candidates = row.startup_recipe_candidates
  const matches = candidates?.candidates?.filter(recipe => recipe.ingredients?.some(item => item.type === 'item' && item.name === declaration.resource))
  if (candidates?.schema_version !== 1 || !known(candidates) || candidates.coverage !== 'complete'
    || candidates.selection !== 'unselected' || candidates.basis !== 'enabled_native_recipe_category_and_surface'
    || !Array.isArray(matches) || matches.length !== 1 || matches[0].applicability?.state !== 'available'
    || matches[0].products?.length !== 1 || matches[0].products[0].type !== 'item' || matches[0].products[0].name !== declaration.product)
    fail('factory_reassignment_recipe_unproven')
  if (cell.ports.some(port => !['item', 'fuel'].includes(port.kind))) fail('factory_reassignment_unsupported')
  return { assignment: { ...cell.assignment, products: [declaration.product], method: `native_recipe:${matches[0].name}` },
    ports: cell.ports.map(port => ({ ...port, resource: port.direction === 'output' ? declaration.product : port.kind === 'fuel' ? port.resource : declaration.resource })) }
}
