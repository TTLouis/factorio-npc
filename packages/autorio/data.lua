-- The hidden NPC awareness radar companion was removed: with zero
-- connected players it charted nothing. The mod keeps its own map knowledge
-- (src/map_knowledge.ts); Factorio drops leftover radars from older saves.

-- These listen-only wheel inputs were introduced to stop Recent activity follow
-- when a player manually scrolls the feed. The control-stage handler assumed a
-- CustomInputEvent exposes the hovered GUI element, but Factorio does not make
-- that relationship available through this event. In 2.0.77 the unsafe handler
-- can be invoked without a usable event payload and crash the whole multiplayer
-- server. Keep the prototypes so existing control-stage registrations and save
-- bindings stay valid, but disable them until the handler is replaced with an
-- event-safe implementation. The LIVE/PAUSED button and hover hold behavior
-- remain available in the console.
data:extend({
  {
    type = "custom-input",
    name = "airi-task-board-activity-scroll-up",
    localised_name = "SGLuna console: scroll activity up",
    key_sequence = "mouse-wheel-up",
    consuming = "none",
    action = "lua",
    enabled = false,
  },
  {
    type = "custom-input",
    name = "airi-task-board-activity-scroll-down",
    localised_name = "SGLuna console: scroll activity down",
    key_sequence = "mouse-wheel-down",
    consuming = "none",
    action = "lua",
    enabled = false,
  },
})

-- The console's top-left button shows which vendor is behind the model SGLuna is
-- currently calling. Each vendor has several avatars and a player is rolled one
-- when they join, so the console does not look identical every session; the
-- file is graphics/icons/provider/<id>-<n>.png and the sprite is named to
-- match. A model that matches no vendor deliberately gets no house avatar: the
-- button answers "which vendor answers", and keeps its default sprite when
-- there is no answer.
--
-- The counts here must match `variants` in src/task_board_provider.ts. Factorio's
-- data stage has no file-exists test and a missing sprite file is a hard load
-- failure, so every id and count listed must have its PNGs committed. Import
-- artwork with scripts/import_provider_icon.py, which produces the 128x128 the
-- prototype expects and normalizes the framing across a set. See the folder's
-- README.
local provider_variants = {
  {"claude", 4},
  {"openai", 4},
  {"deepseek", 4},
  {"gemini", 4},
  {"qwen", 4},
}

-- The mod-GUI button is fixed at 48 GUI units. Draw every provider canvas at
-- 40 units so the avatar is materially larger than the old 32-unit rendering
-- while keeping four units of breathing room on each side. The artwork itself
-- is optically normalized by the importer; the data stage deliberately uses
-- one scale for every provider and variant.
local provider_avatar_source_size = 128
local provider_avatar_gui_size = 40

local provider_avatars = {}
for _, entry in ipairs(provider_variants) do
  local provider, count = entry[1], entry[2]
  for variant = 1, count do
    local id = provider .. "-" .. variant
    provider_avatars[#provider_avatars + 1] = {
      type = "sprite",
      name = "airi-provider-" .. id,
      filename = "__autorio__/graphics/icons/provider/" .. id .. ".png",
      -- Keep one prototype scale for the entire set. Per-avatar visual
      -- corrections belong to the asset import metadata, not the runtime UI.
      size = provider_avatar_source_size,
      scale = provider_avatar_gui_size / provider_avatar_source_size,
      flags = {"gui-icon"},
    }
  end
end

data:extend(provider_avatars)

-- The console's title-bar buttons (Learn, Old tasks, Debug). Drawn by
-- scripts/draw_console_icons.py: a light variant for the title bar and a dark
-- one for the hovered/clicked button, like Factorio's own frame action icons.
-- As above, a missing file is a hard load failure, so every name listed here
-- must have both PNGs committed.
local console_icons = {}
for _, name in ipairs({"learn", "history", "debug"}) do
  for _, variant in ipairs({"white", "black"}) do
    console_icons[#console_icons + 1] = {
      type = "sprite",
      name = "airi-console-" .. name .. "-" .. variant,
      filename = "__autorio__/graphics/icons/console/" .. name .. "-" .. variant .. ".png",
      size = 32,
      flags = {"gui-icon"},
    }
  end
end

data:extend(console_icons)
