// Deterministic repair of a malformed control reply (submitPlan arguments, or the JSON control object a
// tools-off round carries in assistant content). Owner rule (2026-10-08): code only, no Jev, no model call, and
// ENCODING/SYNTAX only -- never content. The repaired object holds exactly the model's own values: no field is
// invented, defaulted, dropped or reinterpreted. Two repairs exist:
//
//   trailing_comma   a `,` directly before `}` or `]` outside strings, applied only when the text then parses.
//   decoded_string   a value the schema expects to be an array or object, or a member of a closed enum, sent as a
//                    string that holds that value JSON-encoded once (`"operations": "[{...}]"`, or an enum member
//                    wrapped in its own quotes: `"developmentMode": "\"vertical\""`). The string is replaced by the
//                    decoded value only when the decoded value validates against the field's own schema. One level.
//
// Never decoded: a string whose schema is free text (no enum), a string already valid for its schema, and scalars.
// A stringified number is a type error the model should be told about, and a stringified boolean
// (assessmentOnly "true") is pinned as refused by luna-controller-contract.test.mjs.
// The caller runs its normal parse/validation on the result exactly as if the model had sent the repaired form,
// and keeps today's behaviour (format recovery / retry) when that still fails. Repair is only ever attempted
// after the strict path failed, so a member the strict path would silently ignore or drop after a successful parse
// is not a reason to repair and is not covered here.
//
// Pure module: the schema is passed in, nothing is read from the runtime.

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function typesOf(schema) {
  if (!isPlainObject(schema)) return []
  if (typeof schema.type === 'string') return [schema.type]
  if (Array.isArray(schema.type)) return schema.type.filter(item => typeof item === 'string')
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined
  if (branches) return [...new Set(branches.flatMap(typesOf))]
  if (Array.isArray(schema.enum)) return [...new Set(schema.enum.map(member => (member === null ? 'null' : typeof member)))]
  return []
}

function matchesType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'integer': return Number.isSafeInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value)
    case 'object': return isPlainObject(value)
    case 'null': return value === null
    default: return false
  }
}

// The subset of JSON Schema the control tool definitions use. An unknown keyword is not enforced, so an
// unrecognised constraint can only make this more permissive about structure, never invent a value.
export function validatesAgainstSchema(value, schema) {
  if (!isPlainObject(schema)) return true
  if (Array.isArray(schema.oneOf) && !schema.oneOf.some(branch => validatesAgainstSchema(value, branch))) return false
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(branch => validatesAgainstSchema(value, branch))) return false
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : []
  if (types.length > 0 && !types.some(type => matchesType(value, type))) return false
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return false
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return false
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return false
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return false
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return false
    if (isPlainObject(schema.items) && !value.every(item => validatesAgainstSchema(item, schema.items))) return false
  }
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required) && !schema.required.every(key => Object.hasOwn(value, key))) return false
    const properties = isPlainObject(schema.properties) ? schema.properties : undefined
    if (schema.additionalProperties === false && properties && !Object.keys(value).every(key => Object.hasOwn(properties, key))) return false
    if (properties) {
      for (const [key, child] of Object.entries(value)) {
        if (Object.hasOwn(properties, key) && !validatesAgainstSchema(child, properties[key])) return false
      }
    }
  }
  return true
}

function childPath(path, key) {
  return path === '' ? key : `${path}.${key}`
}

// Walks `text` outside strings and drops a comma whose next significant character closes the container. Returns
// the cleaned text and where each comma sat (the path of the container it closed), or undefined when none.
function stripTrailingCommas(text) {
  const frames = [] // { array: boolean, key: string | number | undefined, expectKey: boolean }
  const dropped = []
  const pathOf = () => frames.map((frame, index) => {
    if (index === 0) return ''
    const parent = frames[index - 1]
    return parent.array ? `[${parent.index}]` : `.${parent.key}`
  }).join('').replace(/^\./, '')
  const removeAt = []
  let inString = false
  let escaped = false
  let stringStart = -1
  let previous = '' // last significant character seen outside a string
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        inString = false
        previous = '"'
        const top = frames[frames.length - 1]
        if (top && !top.array && top.expectKey) {
          try { top.key = JSON.parse(text.slice(stringStart, index + 1)) }
          catch { top.key = '?' }
          top.expectKey = false
        }
      }
      continue
    }
    if (char === '"') { inString = true; stringStart = index; continue }
    const top = frames[frames.length - 1]
    if (char === '{') frames.push({ array: false, key: undefined, expectKey: true })
    else if (char === '[') frames.push({ array: true, index: 0 })
    else if (char === '}' || char === ']') frames.pop()
    else if (char === ',' && top) {
      let next = index + 1
      while (next < text.length && /\s/.test(text[next])) next++
      // A comma that follows no value (`[,]`, `{,}`, `,,`) is not a trailing comma and is not removed.
      if ((text[next] === '}' || text[next] === ']') && previous !== '' && !'[{,:'.includes(previous)) {
        removeAt.push(index)
        dropped.push(pathOf())
      }
      else if (top.array) top.index++
      else top.expectKey = true
    }
    if (!/\s/.test(char)) previous = char
  }
  if (removeAt.length === 0) return undefined
  let cleaned = ''
  let from = 0
  for (const at of removeAt) {
    cleaned += text.slice(from, at)
    from = at + 1
  }
  cleaned += text.slice(from)
  return { text: cleaned, dropped }
}

// A fenced reply (the same fence rule the provider uses) carries the object between the fences.
function unfence(text) {
  if (text.startsWith('```') && text.endsWith('```') && text.length >= 6) {
    const inner = text.slice(3, -3).trim()
    return inner.slice(0, 4).toLowerCase() === 'json' ? inner.slice(4).trim() : inner
  }
  return text
}

function branchFor(value, schema) {
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined
  if (!branches) return schema
  const whole = branches.find(branch => validatesAgainstSchema(value, branch))
  if (whole) return whole
  if (!isPlainObject(value)) return undefined
  // No branch validates yet (the broken part may be a child). Pick the branch whose closed-enum members, such
  // as a `kind` discriminator, accept the object's own values.
  return branches.find((branch) => {
    const properties = isPlainObject(branch?.properties) ? branch.properties : {}
    return Object.entries(properties).every(([key, child]) =>
      !Array.isArray(child?.enum) || !Object.hasOwn(value, key) || child.enum.includes(value[key]))
  })
}

// `str` as the schema's value, decoded once; undefined when it is not a faithful single-level encoding.
function decodeString(str, schema, path, repairs) {
  const expected = typesOf(schema)
  const closedStrings = Array.isArray(schema.enum) || expected.some(type => type !== 'string')
  if (expected.length === 0 || (!closedStrings && expected.every(type => type === 'string'))) return undefined // free text
  if (validatesAgainstSchema(str, schema)) return undefined // already what the schema asks for
  const trimmed = str.trim()
  let parsed
  try { parsed = JSON.parse(trimmed) }
  catch { return undefined }
  if (!expected.some(type => matchesType(parsed, type))) return undefined
  if (typeof parsed === 'string') {
    // Only a string that is itself a JSON-encoded string, and only into a closed set of members.
    if (!Array.isArray(schema.enum) || !trimmed.startsWith('"')) return undefined
  }
  else if (parsed === null || typeof parsed !== 'object') return undefined // numbers and booleans are never decoded
  // One level only: a decoded string is final, so a triple-encoded value is never decoded twice. A decoded
  // container's members are separate values and each gets its own single decode.
  const nested = []
  const repaired = typeof parsed === 'object' ? repairNode(parsed, schema, path, nested) : parsed
  if (!validatesAgainstSchema(repaired, schema)) return undefined
  repairs.push({ kind: 'decoded_string', path }, ...nested)
  return { value: repaired }
}

function repairNode(value, schema, path, repairs) {
  if (!isPlainObject(schema)) return value
  if (typeof value === 'string') {
    const decoded = decodeString(value, schema, path, repairs)
    return decoded ? decoded.value : value
  }
  const branch = branchFor(value, schema)
  if (!branch) return value
  if (Array.isArray(value)) {
    if (!isPlainObject(branch.items)) return value
    return value.map((item, index) => repairNode(item, branch.items, `${path}[${index}]`, repairs))
  }
  if (isPlainObject(value)) {
    if (!isPlainObject(branch.properties)) return value
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      // defineProperty, not assignment: a model-sent `__proto__` key must stay an own key (and reach the strict
      // unexpected-argument check) rather than set the prototype.
      const next = Object.hasOwn(branch.properties, key) ? repairNode(child, branch.properties[key], childPath(path, key), repairs) : child
      Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true })
    }
    return out
  }
  return value
}

// Entry point. `schema` is the control tool's `parameters` object. Returns undefined when there is nothing to
// repair (or the text is not a JSON object even after trailing commas), else { text, object, repairs } where
// `repairs` lists each change as { kind, path } and `text` is the repaired object serialised.
export function repairControlJson(text, schema) {
  if (typeof text !== 'string' || !isPlainObject(schema)) return undefined
  const body = unfence(text.trim())
  if (!body.startsWith('{')) return undefined
  const repairs = []
  let parsed
  try { parsed = JSON.parse(body) }
  catch {
    const stripped = stripTrailingCommas(body)
    if (!stripped) return undefined
    try { parsed = JSON.parse(stripped.text) }
    catch { return undefined }
    for (const path of stripped.dropped) repairs.push({ kind: 'trailing_comma', path })
  }
  if (!isPlainObject(parsed)) return undefined
  const object = repairNode(parsed, schema, '', repairs)
  if (repairs.length === 0) return undefined
  return { text: JSON.stringify(object), object, repairs }
}
