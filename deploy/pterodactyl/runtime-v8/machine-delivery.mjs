import { luaString } from '../staging/structured-policy.mjs'

const key = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value)
const unit = value => Number.isSafeInteger(value) && value > 0 && value < 1_000_000_000
export const isMachineDeliveryTool = name => name === 'bindMachineDelivery'
export function validateMachineDeliveryBindingArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(field => field !== 'unit_number') || !unit(args.unit_number)) throw new Error('invalid_machine_delivery_binding')
}
export function isValidatedMachineDeliveryBatch(prepared) {
  try {
    if (!Array.isArray(prepared) || prepared.length !== 1) return false
    const entry = prepared[0]
    validateMachineDeliveryBindingArgs(entry.args)
    return isMachineDeliveryTool(entry.tool?.function?.name) && entry.command === null
      && JSON.stringify(entry.args) === JSON.stringify(JSON.parse(entry.tool.function.arguments))
  }
  catch { return false }
}
const render = (method, request) => `/silent-command local request=helpers.json_to_table(${luaString(JSON.stringify(request))}); rcon.print(helpers.table_to_json(remote.call("autorio_tools","${method}",request)))`
export function machineDeliverySpec(raw) {
  if (!key(raw?.acceptance_key) || typeof raw.item_name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(raw.item_name)
    || !unit(raw.minimum) || raw.producer_type !== 'furnace') throw new Error('invalid_machine_delivery_spec')
  return { acceptance_key: raw.acceptance_key, item_name: raw.item_name, minimum: raw.minimum, producer_type: 'furnace' }
}
export const armMachineDeliveryCommand = spec => render('arm_machine_delivery', machineDeliverySpec(spec))
export const evaluateMachineDeliveryCommand = spec => render('evaluate_condition', { kind: 'machine_output_delivered', ...machineDeliverySpec(spec) })
export function bindMachineDeliveryCommand(args) {
  if (!args || Object.keys(args).some(field => !['acceptance_key', 'unit_number'].includes(field))
    || !key(args.acceptance_key) || !unit(args.unit_number)) throw new Error('invalid_machine_delivery_binding')
  return render('bind_machine_delivery', { acceptance_key: args.acceptance_key, unit_number: args.unit_number })
}
export async function evaluateMachineDelivery(spec, command) {
  try {
    const evidence = JSON.parse(String(await command(evaluateMachineDeliveryCommand(spec))).trim())
    return { satisfied: evidence.ok === true && evidence.satisfied === true && evidence.acceptance_key === spec.acceptance_key
      && evidence.item_name === spec.item_name && evidence.minimum === spec.minimum, evidence }
  }
  catch { return { satisfied: false, evidence: { ok: false, error: 'machine_delivery_evidence_unreadable' } } }
}
export const machineDeliveryToolDefinition = { type: 'function', function: { name: 'bindMachineDelivery',
  description: 'Select the exact newly placed destination chest for this finite machine-output goal. Goal metadata only; no world mutation. Selection is immutable. Use for automated output, or an exact successful target-item deposit selects the chest automatically.',
  parameters: { type: 'object', properties: { unit_number: { type: 'integer', minimum: 1, maximum: 999999999 } }, required: ['unit_number'], additionalProperties: false } } }
