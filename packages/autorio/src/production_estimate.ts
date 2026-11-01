// Time estimate for producing a count of one item through a chain of steps the
// planner chose (which recipe or resource, which machine, how many of them).
//
// Pure arithmetic over already-resolved per-cycle facts, so it is unit-testable
// without the engine; production_estimate_live.ts resolves the facts from live
// prototypes. The estimate never picks a machine count: it reports what the
// chosen counts give, which step limits the time, and what one more machine on
// that step would change.
//
// Model:
//   - Each step's machines share its cycles evenly; a machine does whole cycles.
//   - Steps run concurrently as a pipeline. A step finishes no earlier than its
//     own busy time plus the time for its first input to arrive (the slowest
//     single-cycle path from a leaf up to it) plus the time for its last output
//     to flow through the steps downstream of it.
//   - The actor's own work (hand crafting, hand mining) is one serial lane: the
//     NPC does one hand operation at a time.
//   - Ingredients without a step are assumed available. Transfer, walking,
//     placement and inserter time are not included.

export type EstimateStepKind = 'machine' | 'drill' | 'hand_craft' | 'hand_mine'

export interface EstimateStepInput {
  /** Item or fluid this step makes. One step per item. */
  item: string
  kind: EstimateStepKind
  /** Recipe name for crafting steps, resource name for mining steps. */
  source: string
  /** Machine or drill prototype; absent for hand steps. */
  machine?: string
  machine_count: number
  /** Seconds for one cycle on one machine (or by hand). */
  seconds_per_cycle: number
  /** Expected amount of `item` per cycle, productivity included. */
  output_per_cycle: number
  /** Ingredients consumed per cycle. */
  ingredients: Array<{ name: string, amount: number }>
  /** Fuel burned per second per working machine, when a fuel was named. */
  fuel?: { name: string, per_second_per_machine: number }
}

export interface EstimateRequest {
  target: string
  count: number
  steps: EstimateStepInput[]
}

export interface EstimateStepResult {
  item: string
  kind: EstimateStepKind
  source: string
  machine?: string
  machine_count: number
  cycles: number
  amount: number
  seconds_per_cycle: number
  output_per_minute: number
  busy_seconds: number
  finish_seconds: number
  fuel?: { name: string, per_minute_per_machine: number, total: number }
}

export interface EstimateSuccess {
  ok: true
  target: string
  count: number
  total_seconds: number
  bottleneck: { lane: 'step' | 'hand', item?: string, finish_seconds: number }
  hand_lane_seconds: number
  steps: EstimateStepResult[]
  external_inputs: Array<{ name: string, amount: number }>
  external_inputs_truncated: boolean
  /** Steps the target never draws from; they are not part of the estimate. */
  unused_steps: string[]
  one_more_on_bottleneck?: {
    item: string
    machine_count: number
    total_seconds: number
    saved_seconds: number
    new_bottleneck: { lane: 'step' | 'hand', item?: string }
  }
  model: string
}

export interface EstimateFailure {
  ok: false
  error: string
}

export type EstimateResult = EstimateSuccess | EstimateFailure

export const MAX_ESTIMATE_STEPS = 16
export const MAX_ESTIMATE_COUNT = 1000000
export const MAX_MACHINE_COUNT = 1000
const MAX_EXTERNAL_INPUTS = 16

const MODEL = 'pipelined steps; machines share a step\'s cycles evenly; hand work is one serial lane; ingredients without a step are assumed available; transfer, walking and placement time excluded'

function round2(value: number) {
  return math.floor(value * 100 + 0.5) / 100
}

function round4(value: number) {
  return math.floor(value * 10000 + 0.5) / 10000
}

function is_hand(kind: EstimateStepKind) {
  return kind === 'hand_craft' || kind === 'hand_mine'
}

function positive_finite(value: number) {
  return typeof value === 'number' && value === value && value > 0 && value < math.huge
}

function validate(request: EstimateRequest): string | undefined {
  if (typeof request.target !== 'string' || request.target === '') return 'target must be an item name'
  if (!positive_finite(request.count) || math.floor(request.count) !== request.count || request.count > MAX_ESTIMATE_COUNT) {
    return `count must be an integer from 1 to ${MAX_ESTIMATE_COUNT}`
  }
  if (request.steps.length === 0) return 'at least one step is required'
  if (request.steps.length > MAX_ESTIMATE_STEPS) return `at most ${MAX_ESTIMATE_STEPS} steps`
  const seen: Record<string, boolean> = {}
  let target_has_step = false
  for (const step of request.steps) {
    if (seen[step.item] === true) return `more than one step makes ${step.item}`
    seen[step.item] = true
    if (step.item === request.target) target_has_step = true
    if (!positive_finite(step.seconds_per_cycle)) return `step ${step.item} has no positive cycle time`
    if (!positive_finite(step.output_per_cycle)) return `step ${step.item} does not make ${step.item}`
    const count = step.machine_count
    if (!positive_finite(count) || math.floor(count) !== count || count > MAX_MACHINE_COUNT) {
      return `step ${step.item} machine_count must be an integer from 1 to ${MAX_MACHINE_COUNT}`
    }
    if (is_hand(step.kind) && count !== 1) return `step ${step.item} is hand work; machine_count must be 1`
  }
  if (!target_has_step) return `no step makes the target ${request.target}`
  return undefined
}

interface Graph {
  // step index -> indices of steps that make its ingredients
  inputs: number[][]
  // step index -> indices of steps that consume its item
  consumers: number[][]
  // consumer-first order (target first)
  order: number[]
}

function build_graph(request: EstimateRequest): Graph | string {
  const index_of: Record<string, number> = {}
  for (let i = 0; i < request.steps.length; i++) index_of[request.steps[i].item] = i
  const inputs: number[][] = []
  const consumers: number[][] = []
  for (let i = 0; i < request.steps.length; i++) {
    inputs.push([])
    consumers.push([])
  }
  for (let i = 0; i < request.steps.length; i++) {
    for (const ingredient of request.steps[i].ingredients) {
      const producer = index_of[ingredient.name]
      if (producer === undefined) continue
      inputs[i].push(producer)
      consumers[producer].push(i)
    }
  }

  // Depth-first from the target; a step reached again while still on the path
  // is a cycle, which this estimate does not model.
  const state: Record<number, number> = {}
  const postorder: number[] = []
  let cycle_item: string | undefined
  const visit = (i: number) => {
    if (cycle_item !== undefined) return
    if (state[i] === 2) return
    if (state[i] === 1) {
      cycle_item = request.steps[i].item
      return
    }
    state[i] = 1
    for (const input of inputs[i]) visit(input)
    state[i] = 2
    postorder.push(i)
  }
  visit(index_of[request.target])
  if (cycle_item !== undefined) return `steps form a cycle through ${cycle_item}`

  const order: number[] = []
  for (let k = postorder.length - 1; k >= 0; k--) order.push(postorder[k])
  return { inputs, consumers, order }
}

interface Evaluation {
  total_seconds: number
  bottleneck: { lane: 'step' | 'hand', item?: string, finish_seconds: number }
  hand_lane_seconds: number
  steps: EstimateStepResult[]
  external: Record<string, number>
  external_names: string[]
}

function evaluate(request: EstimateRequest, graph: Graph): Evaluation {
  const steps = request.steps
  const needed: Record<number, number> = {}
  const cycles: Record<number, number> = {}
  const external: Record<string, number> = {}
  const external_names: string[] = []
  const index_of: Record<string, number> = {}
  for (let i = 0; i < steps.length; i++) index_of[steps[i].item] = i

  // Demand flows from the target down to its inputs, consumer before producer.
  needed[index_of[request.target]] = request.count
  for (const i of graph.order) {
    const step = steps[i]
    // Guard float noise (0.1 + 0.2) before rounding up to whole cycles.
    const step_cycles = math.max(0, math.ceil((needed[i] ?? 0) / step.output_per_cycle - 1e-9))
    cycles[i] = step_cycles
    for (const ingredient of step.ingredients) {
      const amount = step_cycles * ingredient.amount
      const producer = index_of[ingredient.name]
      if (producer !== undefined) {
        needed[producer] = (needed[producer] ?? 0) + amount
      }
      else {
        if (external[ingredient.name] === undefined) {
          external[ingredient.name] = 0
          external_names.push(ingredient.name)
        }
        external[ingredient.name] += amount
      }
    }
  }

  // Busy time per step, and the single-cycle latency to first input (up) and
  // from last output to the target (down).
  const busy: Record<number, number> = {}
  let hand_lane_seconds = 0
  for (const i of graph.order) {
    const step = steps[i]
    busy[i] = math.ceil(cycles[i] / step.machine_count) * step.seconds_per_cycle
    if (is_hand(step.kind)) hand_lane_seconds += busy[i]
  }
  const up: Record<number, number> = {}
  for (let k = graph.order.length - 1; k >= 0; k--) {
    const i = graph.order[k]
    let longest = 0
    for (const input of graph.inputs[i]) longest = math.max(longest, up[input])
    up[i] = steps[i].seconds_per_cycle + longest
  }
  const down: Record<number, number> = {}
  for (const i of graph.order) {
    let longest = 0
    for (const consumer of graph.consumers[i]) {
      if (down[consumer] !== undefined) longest = math.max(longest, down[consumer])
    }
    down[i] = steps[i].seconds_per_cycle + longest
  }

  const results: EstimateStepResult[] = []
  let bottleneck: Evaluation['bottleneck'] = { lane: 'step', finish_seconds: 0 }
  let smallest_hand_fill: number | undefined
  for (const i of graph.order) {
    const step = steps[i]
    const fill = (up[i] - step.seconds_per_cycle) + (down[i] - step.seconds_per_cycle)
    const finish = busy[i] + fill
    if (is_hand(step.kind)) {
      if (smallest_hand_fill === undefined || fill < smallest_hand_fill) smallest_hand_fill = fill
    }
    else if (finish > bottleneck.finish_seconds) {
      bottleneck = { lane: 'step', item: step.item, finish_seconds: finish }
    }
    const result: EstimateStepResult = {
      item: step.item,
      kind: step.kind,
      source: step.source,
      machine: step.machine,
      machine_count: step.machine_count,
      cycles: cycles[i],
      amount: round4(cycles[i] * step.output_per_cycle),
      seconds_per_cycle: round4(step.seconds_per_cycle),
      output_per_minute: round4(step.machine_count * step.output_per_cycle / step.seconds_per_cycle * 60),
      busy_seconds: round2(busy[i]),
      finish_seconds: round2(finish),
    }
    if (step.fuel !== undefined) {
      result.fuel = {
        name: step.fuel.name,
        per_minute_per_machine: round4(step.fuel.per_second_per_machine * 60),
        // Fuel burns only while a machine works: total machine-seconds of work.
        total: round4(step.fuel.per_second_per_machine * cycles[i] * step.seconds_per_cycle),
      }
    }
    results.push(result)
  }
  if (smallest_hand_fill !== undefined) {
    const hand_finish = hand_lane_seconds + smallest_hand_fill
    if (hand_finish > bottleneck.finish_seconds) bottleneck = { lane: 'hand', finish_seconds: hand_finish }
  }
  bottleneck.finish_seconds = round2(bottleneck.finish_seconds)

  return {
    total_seconds: bottleneck.finish_seconds,
    bottleneck,
    hand_lane_seconds: round2(hand_lane_seconds),
    steps: results,
    external,
    external_names,
  }
}

function unused_steps(request: EstimateRequest, graph: Graph) {
  const used: Record<number, boolean> = {}
  for (const i of graph.order) used[i] = true
  const result: string[] = []
  for (let i = 0; i < request.steps.length; i++) {
    if (used[i] !== true) result.push(request.steps[i].item)
  }
  return result
}

export function estimate_production(request: EstimateRequest): EstimateResult {
  const invalid = validate(request)
  if (invalid !== undefined) return { ok: false, error: invalid }
  const graph = build_graph(request)
  if (typeof graph === 'string') return { ok: false, error: graph }

  const base = evaluate(request, graph)
  const external_inputs: Array<{ name: string, amount: number }> = []
  for (const name of base.external_names) {
    if (external_inputs.length >= MAX_EXTERNAL_INPUTS) break
    external_inputs.push({ name, amount: round4(base.external[name]) })
  }

  const result: EstimateSuccess = {
    ok: true,
    target: request.target,
    count: request.count,
    total_seconds: base.total_seconds,
    bottleneck: base.bottleneck,
    hand_lane_seconds: base.hand_lane_seconds,
    steps: base.steps,
    external_inputs,
    external_inputs_truncated: base.external_names.length > MAX_EXTERNAL_INPUTS,
    unused_steps: unused_steps(request, graph),
    model: MODEL,
  }

  // One more machine on the limiting step. Hand work cannot be scaled this way.
  const limiting = base.bottleneck.item
  if (base.bottleneck.lane === 'step' && limiting !== undefined) {
    const steps: EstimateStepInput[] = []
    let machine_count = 0
    for (const step of request.steps) {
      if (step.item === limiting) {
        machine_count = step.machine_count + 1
        steps.push({ ...step, machine_count })
      }
      else {
        steps.push(step)
      }
    }
    if (machine_count <= MAX_MACHINE_COUNT) {
      const more = evaluate({ target: request.target, count: request.count, steps }, graph)
      result.one_more_on_bottleneck = {
        item: limiting,
        machine_count,
        total_seconds: more.total_seconds,
        saved_seconds: round2(base.total_seconds - more.total_seconds),
        new_bottleneck: { lane: more.bottleneck.lane, item: more.bottleneck.item },
      }
    }
  }
  return result
}
