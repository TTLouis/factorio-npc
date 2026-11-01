import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM build script without type declarations
import { check_generated_lua, factorio_method_names } from '../scripts/check-generated-lua.mjs'

const factorio_methods: Set<string> = factorio_method_names(`
  export interface LuaFluidBox {
    get_pipe_connections(index: uint32): PipeConnection[]
  }
  export interface LuaEntityPrototype {
    get_inserter_rotation_speed(quality?: QualityID): double | nil
  }
  export interface LuaEntity {
    get_inventory(inventory: defines.inventory): LuaInventory | nil
    get_recipe(): LuaMultiReturn<[LuaRecipe | nil, LuaQualityPrototype | nil]>
    get_main_inventory(): LuaInventory | nil
  }
`)

function bundle(module: string) {
  return [
    'local ____modules = {}',
    '["lualib_bundle"] = function(...)',
    '    if index > self.length then',
    'end,',
    '["tools"] = function(...)',
    module,
    'end,',
  ].join('\n')
}

describe('generated Lua guard', () => {
  it('rejects the exact emitted empty-claim bug and accepts explicit numeric comparisons', () => {
    const compiled = (body: string) => `["placement_candidates"] = function(...)\n${body}\nend,`
    const broken = compiled([
      'if storage.sgluna_fluid_preservation_claims_initialized and not #__TS__ObjectKeys(storage.sgluna_fluid_preservation_claims or ({})) then return {required = true} end',
      'if not #claims then return {required = false} end',
      'if not #claims then return binding == nil end',
    ].join('\n'))
    const findings = check_generated_lua(broken, factorio_methods)
    expect(findings).toHaveLength(3)
    expect(findings.every((line: string) => line.includes('numeric length truthiness in preservation placement'))).toBe(true)
    expect(check_generated_lua(compiled([
      'if storage.sgluna_fluid_preservation_claims_initialized and #__TS__ObjectKeys(storage.sgluna_fluid_preservation_claims or ({})) == 0 then return {required = true} end',
      'if #claims == 0 then return {required = false} end',
      'if #claims == 0 then return binding == nil end',
    ].join('\n')), factorio_methods)).toEqual([])
  })
  it('reads Factorio method names from typed-factorio declarations', () => {
    expect([...factorio_methods].sort()).toEqual(['get_inserter_rotation_speed', 'get_inventory', 'get_main_inventory', 'get_pipe_connections', 'get_recipe'])
  })

  it('accepts typed output and ignores the lualib runtime', () => {
    expect(check_generated_lua(bundle([
      'local count = #fluidbox',
      'local connections = fluidbox.get_pipe_connections(1)',
      'local inventory = actor:get_main_inventory()',
      'local function get_inventory_items(self, actor) end',
      'get_inventory_items(nil, actor)',
      'local ____opt_1 = prototype.get_inserter_rotation_speed',
      'if ____opt_1 ~= nil then',
      '    ____opt_1 = ____opt_1()',
      'end',
    ].join('\n')), factorio_methods)).toEqual([])
  })

  it('names each untyped JavaScript construct Factorio rejects at runtime', () => {
    const findings = check_generated_lua(bundle([
      'while index <= fluidbox.length do',
      'local connections = fluidbox:get_pipe_connections(index)',
      'local recipe = get_recipe(nil, entity)',
      'local refs = value.evidence_refs:slice(0, 16)',
      'local ____opt_14 = prototype.get_inserter_rotation_speed',
      'if ____opt_14 ~= nil then',
      '    ____opt_14 = ____opt_14(prototype)',
      'end',
    ].join('\n')), factorio_methods)
    expect(findings).toHaveLength(5)
    expect(findings[0]).toContain('tools (control.lua:6): untyped .length field')
    expect(findings[1]).toContain('colon call fluidbox:get_pipe_connections()')
    expect(findings[2]).toContain('detached Factorio method get_recipe(nil, ...)')
    expect(findings[3]).toContain('JavaScript array method value.evidence_refs:slice()')
    expect(findings[4]).toContain('optional call of Factorio method get_inserter_rotation_speed(prototype) passes the receiver')
  })

  it('rejects a remote interface registered as a controller object whose functions take self', () => {
    const findings = check_generated_lua(bundle([
      'remote.add_interface("autorio_operation_admission", operation_admission)',
      'remote.add_interface("autorio_research", {status = function() return research_controller:status() end})',
      'remote.add_interface(name, i)',
    ].join('\n')), factorio_methods)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('remote interface autorio_operation_admission registers operation_admission directly')
  })
})
