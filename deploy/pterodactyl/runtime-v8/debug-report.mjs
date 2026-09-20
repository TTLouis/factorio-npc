import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clean(value, max = 1000) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

export function parseJsonl(text) {
  const rows = []
  const errors = []
  for (const [index, line] of String(text ?? '').split('\n').entries()) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row)
      else errors.push({ line: index + 1, error: 'row is not an object' })
    }
    catch (error) {
      errors.push({ line: index + 1, error: clean(error instanceof Error ? error.message : error, 300) })
    }
  }
  return { rows, errors }
}

function latest(rows, predicate) {
  for (let index = rows.length - 1; index >= 0; index--) {
    if (predicate(rows[index])) return rows[index]
  }
  return undefined
}

function promptRequestFor(promptRows, id) {
  return latest(promptRows, row => row?.event === 'provider.request' && (!id || row?.request_id === id))
}

function promptResponseFor(promptRows, id) {
  return latest(promptRows, row => ['provider.response', 'provider.response_error'].includes(row?.event) && (!id || row?.request_id === id))
}

function behaviorProviderFor(behaviorRows, id) {
  return latest(behaviorRows, row => ['provider.response', 'provider.error'].includes(row?.event) && (!id || row?.request_id === id))
}

function compactStructured(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return {
    json_valid: value.json_valid === true,
    plan_valid: value.plan_valid === true,
    error: clean(value.error, 800),
  }
}

function compactProvider(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return {
    response_id: clean(value.response_id, 160),
    model: clean(value.model, 200),
    finish_reason: clean(value.finish_reason, 80),
    diagnostic_code: clean(value.diagnostic_code, 200),
    response_bytes: finiteNumber(value.response_bytes),
    content_chars: finiteNumber(value.content_chars),
    content_utf8_bytes: finiteNumber(value.content_utf8_bytes),
    content_non_ascii_chars: finiteNumber(value.content_non_ascii_chars),
    content_replacement_chars: finiteNumber(value.content_replacement_chars),
    normalized_content_chars: finiteNumber(value.normalized_content_chars),
    reasoning_content_chars: finiteNumber(value.reasoning_content_chars),
    tool_call_count: finiteNumber(value.tool_call_count),
    structured_content: compactStructured(value.structured_content),
  }
}

function diagnosisHints(provider, failureMessage) {
  const hints = []
  if (provider?.finish_reason === 'length' && provider?.content_chars === 0 && provider?.tool_call_count === 0) {
    hints.push('Provider exhausted its output budget before producing visible structured content; inspect reasoning_content_chars and output token limits.')
  }
  else if (provider?.finish_reason === 'length') {
    hints.push('Provider output was truncated; structured JSON may have been cut before closing.')
  }
  if ((provider?.content_replacement_chars ?? 0) > 0) {
    hints.push('UTF-8 replacement characters were observed; investigate byte slicing/decoding before blaming the model language.')
  }
  if (provider?.structured_content?.json_valid === false && provider?.content_chars > 0) {
    hints.push('Visible provider content was not valid JSON; inspect the bounded provider content preview in sgluna-prompts.jsonl for the exact malformed region.')
  }
  if (provider?.structured_content?.json_valid === true && provider?.structured_content?.plan_valid === false) {
    hints.push('Provider content was valid JSON but failed the SGLuna structured-plan schema.')
  }
  if (/recovery exhausted/i.test(String(failureMessage ?? ''))) {
    hints.push('Structured-response recovery was exhausted; compare provider diagnostics across all recovery attempts for this request id.')
  }
  return hints
}

function behaviorTimeline(rows, id, limit = 16) {
  const relevant = rows.filter(row => !id || row?.request_id === id)
  return relevant.slice(-limit).map(row => ({
    ts: row.ts,
    seq: row.seq,
    event: row.event,
    turn: row.turn,
    actor_id: row.actor_id,
    epoch: row.epoch,
    round: row?.data?.round,
    recovery_attempt: row?.data?.recovery_attempt ?? row?.data?.attempt,
    tool: clean(row?.data?.name, 120),
    message: clean(row?.data?.message ?? row?.data?.reason, 300),
  }))
}

export function buildFailureReport(behaviorRows, promptRows = []) {
  const failure = latest(behaviorRows, row => row?.event === 'request.failed')
  if (!failure) return undefined
  const snapshot = failure?.data?.failure_snapshot ?? {}
  const id = snapshot.request_id ?? failure.request_id
  const behaviorProvider = behaviorProviderFor(behaviorRows, id)
  const promptResponse = promptResponseFor(promptRows, id)
  const promptRequest = promptRequestFor(promptRows, id)
  const behaviorProviderEvent = snapshot.provider ?? behaviorProvider?.data ?? {}
  const provider = compactProvider(behaviorProviderEvent?.provider ?? (promptResponse?.event === 'provider.response' ? promptResponse : undefined))
  const failureMessage = snapshot.message ?? failure?.data?.message

  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    request: {
      request_id: id,
      turn: snapshot.turn ?? failure.turn,
      stage: clean(snapshot.stage ?? failure?.data?.stage, 120),
      message: clean(failureMessage, 2000),
      actor_id: snapshot.actor_id ?? failure.actor_id,
      epoch: snapshot.epoch ?? failure.epoch,
    },
    provider: {
      round: behaviorProviderEvent?.round ?? promptResponse?.round,
      recovery_attempt: behaviorProviderEvent?.recovery_attempt ?? promptResponse?.recovery_attempt,
      latency_ms: behaviorProviderEvent?.latency_ms,
      ...provider,
    },
    recovery: snapshot.recovery,
    last_tool: snapshot.last_tool,
    plan: snapshot.plan,
    usage: snapshot.usage ?? failure?.data?.usage,
    prompt_request: promptRequest ? {
      trigger_source: promptRequest.trigger_source,
      recovery_attempt: promptRequest.recovery_attempt,
      allow_tools: promptRequest.allow_tools,
      stats: promptRequest.stats,
    } : undefined,
    prompt_trace_result: promptResponse ? {
      event: promptResponse.event,
      diagnostic_code: promptResponse.diagnostic_code,
      http_status: promptResponse.http_status,
      parse_error: clean(promptResponse.parse_error, 500),
    } : undefined,
    diagnosis_hints: diagnosisHints(provider, failureMessage),
    timeline: behaviorTimeline(behaviorRows, id),
  }
}

function printable(value) {
  return value === undefined || value === null || value === '' ? '—' : String(value)
}

export function formatFailureReport(report) {
  if (!report) return 'No request.failed event found.'
  const provider = report.provider ?? {}
  const structured = provider.structured_content ?? {}
  const lines = [
    'SGLuna failure report',
    `request: ${printable(report.request?.request_id)} · turn ${printable(report.request?.turn)} · stage ${printable(report.request?.stage)}`,
    `failure: ${printable(report.request?.message)}`,
    `actor: ${printable(report.request?.actor_id)} · epoch ${printable(report.request?.epoch)}`,
    `provider: ${printable(provider.model)} · round ${printable(provider.round)} · recovery ${printable(provider.recovery_attempt)}`,
    `result: ${printable(provider.diagnostic_code)} · finish=${printable(provider.finish_reason)} · latency=${printable(provider.latency_ms)}ms`,
    `content: ${printable(provider.content_chars)} chars · ${printable(provider.content_utf8_bytes)} utf8 bytes · non-ascii=${printable(provider.content_non_ascii_chars)} · replacement=${printable(provider.content_replacement_chars)}`,
    `reasoning/tool: reasoning_chars=${printable(provider.reasoning_content_chars)} · tool_calls=${printable(provider.tool_call_count)}`,
    `structured: json_valid=${printable(structured.json_valid)} · plan_valid=${printable(structured.plan_valid)}${structured.error ? ` · ${structured.error}` : ''}`,
    `last tool: ${printable(report.last_tool?.name)} · ${printable(report.last_tool?.phase)}`,
  ]
  if (report.diagnosis_hints?.length) {
    lines.push('diagnosis hints:')
    for (const hint of report.diagnosis_hints) lines.push(`- ${hint}`)
  }
  return lines.join('\n')
}

async function readJsonlFile(filename) {
  try { return parseJsonl(await fsp.readFile(filename, 'utf8')) }
  catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], errors: [{ file: filename, error: 'not found' }] }
    throw error
  }
}

async function preferredTracePath(root, preferredName, legacyName) {
  const preferred = path.resolve(root, 'logs', preferredName)
  try { await fsp.access(preferred); return preferred }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  const legacy = path.resolve(root, 'logs', legacyName)
  try { await fsp.access(legacy); return legacy }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  return preferred
}

export async function generateFailureReport({ behaviorFile, promptFile } = {}) {
  const root = process.cwd()
  const behaviorPath = behaviorFile ? path.resolve(behaviorFile) : await preferredTracePath(root, 'sgluna-behavior.jsonl', 'airi-behavior.jsonl')
  const promptPath = promptFile ? path.resolve(promptFile) : await preferredTracePath(root, 'sgluna-prompts.jsonl', 'airi-prompts.jsonl')
  const [behavior, prompts] = await Promise.all([readJsonlFile(behaviorPath), readJsonlFile(promptPath)])
  return {
    report: buildFailureReport(behavior.rows, prompts.rows),
    parse_errors: {
      behavior: behavior.errors,
      prompts: prompts.errors,
    },
    files: {
      behavior: behaviorPath,
      prompts: promptPath,
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const positionals = args.filter(arg => arg !== '--json')
  const result = await generateFailureReport({
    behaviorFile: positionals[0],
    promptFile: positionals[1],
  })
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(formatFailureReport(result.report))
    const totalErrors = result.parse_errors.behavior.length + result.parse_errors.prompts.length
    if (totalErrors > 0) console.log(`\nJSONL parse warnings: ${totalErrors}`)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch(error => {
  console.error(`SGLuna debug report failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
