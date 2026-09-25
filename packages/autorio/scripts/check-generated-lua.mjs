#!/usr/bin/env node
// Reject TypeScriptToLua output that is valid Lua but wrong at runtime.
//
// TypeScriptToLua only emits `#x`, 1-based indexing and dot calls when it knows
// a value's type. On an untyped (`any`) value it emits JavaScript semantics
// literally, and real Factorio 2.0 rejects each form:
//   - `x.length` is a nil field on a Lua table or string (and raises on a
//     LuaObject such as LuaFluidBox);
//   - `x:method(...)` passes x as an extra argument, which Factorio methods
//     reject ("Expected 0 arguments but 1 were given", "Invalid QualityID");
//   - a method read into a local and called (`const f = entity.get_recipe`;
//     `f(entity)`) compiles to `f(nil, entity)`, two extra arguments;
//   - `x:slice(...)` and other JavaScript array methods do not exist on a table.
// Unit tests mock these objects in JavaScript, so none of this shows there.
//
// Run from packages/autorio after `pnpm run build`:
//   node scripts/check-generated-lua.mjs [dist/control.lua]

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLASSES = join(ROOT, 'node_modules/typed-factorio/runtime/generated/classes.d.ts')

// Receivers that are this mod's own objects (the actor wrapper, controllers,
// lualib Set/Map), whose methods take self. Their method names can collide
// with Factorio's (actor:get_main_inventory wraps LuaEntity.get_main_inventory).
export const OWN_RECEIVERS = new Set(['self', 'actor', 'maybeActor', 'result', 'follow_controller'])

const JS_ARRAY_METHODS = ['slice', 'push', 'includes', 'indexOf', 'join', 'map', 'filter', 'forEach', 'some', 'every', 'find', 'splice', 'concat', 'reduce']

export function factorio_method_names(classes_source) {
  return new Set([...classes_source.matchAll(/^ {4}([a-z_]\w*)\s*(?:<[^>]*>)?\(/gm)].map(match => match[1]))
}

// Split the bundle into its modules so findings name a source file and the
// lualib runtime (which legitimately reads `.length` on its own tables) is skipped.
function modules(lua) {
  const result = []
  let current = { name: '<preamble>', start: 1, lines: [] }
  lua.split('\n').forEach((line, index) => {
    const header = /^\["([^"]+)"\] = function/.exec(line)
    if (header) {
      result.push(current)
      current = { name: header[1], start: index + 1, lines: [] }
    }
    current.lines.push(line)
  })
  result.push(current)
  return result
}

export function check_generated_lua(lua, factorio_methods) {
  const findings = []
  // Functions this mod defines itself take a nil self from TypeScriptToLua.
  const own_functions = new Set([...lua.matchAll(/function\s+(?:[\w.]+\.)?([a-z_]\w*)\(self\b/g)].map(match => match[1]))
  for (const module of modules(lua)) {
    if (module.name === 'lualib_bundle') continue
    module.lines.forEach((line, offset) => {
      const at = `${module.name} (control.lua:${module.start + offset})`
      if (/^\s*--/.test(line)) return
      if (/\.length\b/.test(line)) findings.push(`${at}: untyped .length field: ${line.trim()}`)
      for (const match of line.matchAll(/([A-Za-z_][\w.[\]]*):([a-z_]\w*)\(/g)) {
        const [, receiver, method] = match
        if (JS_ARRAY_METHODS.includes(method) && receiver !== 'self') findings.push(`${at}: JavaScript array method ${receiver}:${method}(): ${line.trim()}`)
        else if (factorio_methods.has(method) && !OWN_RECEIVERS.has(receiver)) findings.push(`${at}: colon call ${receiver}:${method}() passes self to a Factorio method: ${line.trim()}`)
      }
      for (const match of line.matchAll(/(?<![\w.:])([a-z_]\w*)\(nil,/g)) {
        if (factorio_methods.has(match[1]) && !own_functions.has(match[1])) findings.push(`${at}: detached Factorio method ${match[1]}(nil, ...) passes extra arguments: ${line.trim()}`)
      }
    })
  }
  return findings
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ?? join(ROOT, 'dist/control.lua')
  const findings = check_generated_lua(readFileSync(target, 'utf8'), factorio_method_names(readFileSync(CLASSES, 'utf8')))
  for (const finding of findings) console.error(finding)
  if (findings.length > 0) {
    console.error(`${findings.length} untyped JavaScript construct(s) in generated Lua; give the value a Factorio or array type.`)
    process.exit(1)
  }
  console.log('generated Lua: no untyped .length, self-passing Factorio calls or JavaScript array methods')
}
