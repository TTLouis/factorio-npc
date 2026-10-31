import { factoryMetadataDigest as digest } from './factory-dependencies.mjs'

const known = row => row?.state === 'known' && row.truncated !== true
const exact = (a, b) => a?.unit_number === b?.unit_number && a?.name === b?.name && a?.surface_index === b?.surface_index
  && a?.force_index === b?.force_index && a?.position?.x === b?.position?.x && a?.position?.y === b?.position?.y
const unknown = code => ({ state: 'unverified', code })
function endpoint(cell, portId, proof, native, output, nativeOutput) {
  const port = cell?.ports.find(port => port.port_id === portId)
  const binding = cell?.port_bindings?.find(binding => binding.port_id === portId)
  const historical = cell?.metadata_history?.find(row => row.revision === proof?.cell_revision)?.port_bindings.find(row => row.port_id === portId)
  if (!port || !binding || !proof || !historical || proof.binding_digest !== digest(historical) || proof.binding_digest !== digest(binding)) return undefined
  if (!cell.members.some(member => exact(member, binding.member))) return undefined
  const member = native?.members.find(member => exact(member.locator, binding.member))
  if (member?.state !== 'observed') return undefined
  if (output) {
    const derived = nativeOutput(member, port)
    if (!derived) return undefined
    if (derived.kind === 'inventory' && (binding.endpoint.kind !== 'inventory' || derived.inventory_index !== binding.endpoint.inventory_index)) return undefined
    if (derived.kind === 'fluidbox' && (binding.endpoint.kind !== 'fluidbox' || derived.fluidbox_index !== binding.endpoint.fluidbox_index)) return undefined
    if (derived.kind === 'item_drop' && binding.endpoint.kind !== 'item_drop') return undefined
    if (derived.kind === 'electricity' && binding.endpoint.kind !== 'electric_service') return undefined
    return { port, binding, member, derived }
  }
  const facts = member.endpoint_facts
  if (binding.endpoint.kind === 'inventory') {
    const endpoint = known(facts?.inventories) && facts.inventories.endpoints.find(row => row.inventory_index === binding.endpoint.inventory_index)
    const role = port.kind === 'fuel' ? 'fuel' : 'input'
    if (!known(endpoint) || !known(endpoint.roles) || !endpoint.roles.values.includes(role)) return undefined
  } else if (binding.endpoint.kind === 'fluidbox') {
    const endpoint = known(facts?.fluidboxes) && facts.fluidboxes.endpoints.find(row => row.fluidbox_index === binding.endpoint.fluidbox_index)
    if (!known(endpoint) || !known(endpoint.recipe_association) || endpoint.recipe_association.direction !== 'input'
      || endpoint.recipe_association.resource !== port.resource) return undefined
  } else if (!known(facts?.services?.electricity)) return undefined
  return { port, binding, member }
}

/** Exact supplier and endpoint matching is separate from observed delivery.
 * Historical metadata and native stock never serve as a delivered-flow fact. */
export function validateFactoryDelivery(registry, dependency, nativeByCell, nativeOutput) {
  const consumerCell = registry.cells.find(cell => cell.cell_id === dependency.consumer.cell_id)
  const consumer = endpoint(consumerCell, dependency.consumer.port_id, dependency.endpoint_bindings?.consumer,
    nativeByCell.get(consumerCell?.cell_id), false, nativeOutput)
  const base = { dependency_id: dependency.dependency_id, supplier: dependency.supplier.kind, commissioning: 'unverified' }
  if (!consumer) return { ...base, ...unknown('consumer_endpoint_stale_or_unverified') }
  if (dependency.supplier.kind !== 'cell') return { ...base, ...unknown(`supplier_${dependency.supplier.kind}`), delivery: dependency.delivery.kind }
  const supplierCell = registry.cells.find(cell => cell.cell_id === dependency.supplier.cell_id)
  const supplier = endpoint(supplierCell, dependency.supplier.port_id, dependency.endpoint_bindings?.supplier,
    nativeByCell.get(supplierCell?.cell_id), true, nativeOutput)
  if (!supplier || ['retired', 'degraded'].includes(supplierCell.lifecycle_state)) return { ...base, ...unknown('supplier_endpoint_stale_or_unverified') }
  if (supplier.port.resource !== consumer.port.resource || !(supplier.port.kind === consumer.port.kind || supplier.port.kind === 'item' && consumer.port.kind === 'fuel')) {
    return { ...base, state: 'mismatch', code: 'supplier_assigned_job_mismatch' }
  }
  const matched = { ...base, supplier: 'cell', supplier_cell_id: supplierCell.cell_id, supplier_revision: supplierCell.revision,
    consumer_cell_id: consumerCell.cell_id, consumer_revision: consumerCell.revision, supplier_job: 'matched', endpoints: 'matched' }
  if (dependency.delivery.kind === 'direct') {
    const routes = supplier.member.item_routes
    const connected = known(routes) && routes.routes?.filter(row => row.state === 'connected' && row.kind === 'drop')
    if (connected?.length === 1 && exact(connected[0].target, consumer.binding.member)) {
      return { ...matched, state: 'configured', code: 'exact_direct_route_configured', delivery: 'configured', commissioning: 'unverified' }
    }
    return { ...matched, ...unknown('direct_route_unverified') }
  }
  // Electric network IDs, fluid contents and belt buffers are not physical flow
  // attribution. Unsupported transport remains visible, never empty/complete.
  return { ...matched, ...unknown(`${dependency.delivery.kind}_delivery_unverified`) }
}

export function factoryInputCoverage(cell, native, dependencies) {
  const rows = []
  for (const member of native.members ?? []) {
    const facts = member.input_requirements
    for (const domain of ['material', 'fluid', 'power', 'fuel']) {
      const fact = facts?.[domain]
      if (!fact || fact.truncated || !['known', 'not_applicable'].includes(fact.state)) {
        rows.push({ unit_number: member.locator.unit_number, domain, state: 'unverified', code: 'native_input_requirement_unknown' }); continue
      }
      if (fact.state === 'not_applicable' && fact.required === false) continue
      for (const input of fact.inputs ?? []) {
        const kind = input.kind === 'electricity' ? 'power' : input.kind
        const ports = cell.ports.filter(port => port.direction === 'input' && port.kind === kind
          && (input.name === undefined || port.resource === input.name)
          && cell.port_bindings?.some(binding => binding.port_id === port.port_id && exact(binding.member, member.locator)))
        const declared = dependencies.filter(dep => ports.some(port => port.port_id === dep.consumer.port_id))
        rows.push({ unit_number: member.locator.unit_number, domain, input, state: declared.length ? 'declared' : 'unresolved',
          dependency_ids: declared.map(dep => dep.dependency_id), supplier_and_delivery: 'require_exact_validation' })
      }
    }
  }
  return { state: rows.some(row => ['unverified', 'unresolved'].includes(row.state)) ? 'incomplete' : 'declared', rows,
    independence: rows.length === 0 ? 'not_established_by_empty_declarations' : 'unverified', commissioning: 'unverified' }
}
