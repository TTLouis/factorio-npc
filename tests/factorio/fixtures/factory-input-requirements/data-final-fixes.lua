-- TEST ONLY. Exercise the software 24-input bound using synthetic native data.
-- This is neither a game recipe guide nor a claim about ordinary production.
local names = {}
for name in pairs(data.raw.item) do names[#names + 1] = name end
table.sort(names)
assert(#names >= 25, "test requires 25 native item prototypes")
local ingredients = {}
for index = 1, 25 do ingredients[#ingredients + 1] = {type="item", name=names[index], amount=1} end
local machine = table.deepcopy(data.raw["assembling-machine"]["assembling-machine-3"])
assert(machine, "test requires its probed native assembler template")
machine.name = "factory-input-bound-machine"
machine.minable = nil
machine.next_upgrade = nil
machine.fast_replaceable_group = nil
machine.crafting_categories = {"factory-input-bound-category"}
machine.ingredient_count = 255
data:extend({
  {type="recipe-category", name="factory-input-bound-category"},
  {type="recipe", name="factory-input-bound-recipe", category="factory-input-bound-category", enabled=true,
    ingredients=ingredients, results={{type="item",name=names[1],amount=1}}, energy_required=1},
  machine,
})
