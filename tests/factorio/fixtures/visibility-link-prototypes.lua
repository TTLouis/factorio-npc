-- Native visibility regressions only. These prototypes never ship in the NPC mod or installer.
local pipe = table.deepcopy(data.raw["pipe-to-ground"]["pipe-to-ground"])
pipe.name = "npc-test-long-underground-pipe"
for _, connection in pairs(pipe.fluid_box.pipe_connections) do
  if connection.connection_type == "underground" then connection.max_underground_distance = 30 end
end
local inserter = table.deepcopy(data.raw.inserter["fast-inserter"])
inserter.name = "npc-test-custom-vector-inserter"
inserter.allow_custom_vectors = true
data:extend({pipe, inserter})
