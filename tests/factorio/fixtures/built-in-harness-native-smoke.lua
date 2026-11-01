-- Deterministic exact-engine canary only; no inference or gameplay acceptance.
-- Execute in the task-owned disposable Factorio 2.0.77 fixture AFTER its normal
-- standalone actor bootstrap. Then advance >=120 ticks and execute the query
-- in the final comment. This script creates only its named isolated surface.
local name = "built-in-harness-starter-smoke"
assert(not game.surfaces[name], "smoke surface already exists; use a fresh owned fixture")
local surface = game.create_surface(name, {width=64,height=64,autoplace_controls={}})
surface.request_to_generate_chunks({0,0},1)
surface.force_generate_chunk_requests()
local tiles = {}
for x=-20,20 do for y=-12,12 do tiles[#tiles+1]={name="grass-1",position={x,y}} end end
surface.set_tiles(tiles)
local force = game.forces.player
local science_item = "automation-science-pack" -- owner-selected red science, not a recipe bill
local machine = prototypes.entity["assembling-machine-3"]
local function output_recipe(item)
  local candidates = {}
  for recipe_name,recipe in pairs(force.recipes) do
    local product=recipe.products[1]
    if #recipe.products==1 and product.type=="item" and product.amount and (product.probability or 1)==1
      and (not item or product.name==item) and machine.crafting_categories[recipe.category] then
      local all_items=true
      for _,input in pairs(recipe.ingredients) do if input.type~="item" then all_items=false end end
      if all_items then candidates[#candidates+1]=recipe_name end
    end
  end
  table.sort(candidates)
  assert(#candidates>0,"no supported live native recipe")
  return force.recipes[candidates[1]]
end
local science=output_recipe(science_item)
local stock=output_recipe(nil)
local technology
local technologies={}
for tech_name,tech in pairs(force.technologies) do
  for _,ingredient in pairs(tech.research_unit_ingredients or {}) do
    if ingredient.name==science_item then technologies[#technologies+1]=tech_name; break end
  end
end
table.sort(technologies); technology=technologies[1]
assert(technology,"no red-science technology in live force")
local function create(prototype,x,y,direction)
  local entity=surface.create_entity{name=prototype,position={x,y},force=force,direction=direction}
  assert(entity and entity.valid,"fixture placement failed: "..prototype)
  return entity
end
local producer=create("assembling-machine-3",-4,0)
science.enabled=true; producer.set_recipe(science.name); assert(producer.get_recipe(),"science recipe rejected")
local arm=create("inserter",-2,0,defines.direction.west)
local lab=create("lab",0,0)
local stock_producer=create("assembling-machine-3",-4,7)
stock.enabled=true; stock_producer.set_recipe(stock.name)
local stock_arm=create("inserter",-2,7,defines.direction.west)
local chest=create("steel-chest",-1,7)
-- Explicit arm endpoints avoid relying on remembered orientation semantics.
arm.pickup_position={x=-3,y=0}; arm.drop_position={x=-1,y=0}
stock_arm.pickup_position={x=-3,y=7}; stock_arm.drop_position={x=-1,y=7}
local stock_item=stock.products[1].name
storage.built_in_harness_smoke_request={kind="automated_starter_base",acceptance_key="deterministic-native-smoke",observation_id="native-smoke-window-1",science_item=science_item,technology=technology,
  supply_items={stock_item},construction_stocks={{item_name=stock_item,minimum=1}},
  bindings={members={producer.unit_number,arm.unit_number,lab.unit_number,stock_producer.unit_number,stock_arm.unit_number,chest.unit_number},
    science={producer=producer.unit_number,inserter=arm.unit_number,lab=lab.unit_number},
    supplies={{item_name=stock_item,producer=stock_producer.unit_number}},
    stocks={{item_name=stock_item,producer=stock_producer.unit_number,inserter=stock_arm.unit_number,container=chest.unit_number}}}}
rcon.print(helpers.table_to_json({setup=true,surface=name,science_recipe=science.name,stock_recipe=stock.name,technology=technology}))
-- Query 1 after >=120 ticks (wrap as /silent-command):
-- local q=storage.built_in_harness_smoke_request; local good=remote.call("autorio_tools","evaluate_condition",q); assert(good.ok==true and good.satisfied==false,helpers.table_to_json(good)); local bad=helpers.json_to_table(helpers.table_to_json(q)); bad.bindings.science.inserter=99999999; local refused=remote.call("autorio_tools","evaluate_condition",bad); assert(refused.ok==false and refused.error=="starter_exact_bindings_required",helpers.table_to_json(refused)); rcon.print(helpers.table_to_json({valid=good,invalid=refused}))
-- Query 2 after another >=120 ticks:
-- local result=remote.call("autorio_tools","evaluate_condition",storage.built_in_harness_smoke_request); assert(result.ok==true and result.satisfied==false and result.current_evidence,helpers.table_to_json(result)); rcon.print(helpers.table_to_json(result))
-- Query 3: same-goal completion acknowledgement stops sampling; wrong goal cannot stop it.
-- local q=storage.built_in_harness_smoke_request; local bad=remote.call("autorio_tools","evaluate_condition",{kind=q.kind,acceptance_key="wrong-goal",stop_observation=true}); assert(bad.ok==false); local wrong_window=remote.call("autorio_tools","evaluate_condition",{kind=q.kind,acceptance_key=q.acceptance_key,observation_id="superseded-window",stop_observation=true}); assert(wrong_window.ok==false and wrong_window.error=="starter_observation_owner_changed"); local good=remote.call("autorio_tools","evaluate_condition",{kind=q.kind,acceptance_key=q.acceptance_key,observation_id=q.observation_id,stop_observation=true}); assert(good.ok==true and good.stopped==true); rcon.print(helpers.table_to_json({wrong_owner=bad,wrong_window=wrong_window,stopped=good}))
