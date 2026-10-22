-- Test-image-only access to this mod's storage. Factorio keeps the RCON level
-- storage separate from mod storage and cannot manufacture a LuaPlayer. This
-- fixture never ships in the installer and cannot approve a pending review.
remote.add_interface("reservation_test_fixture", {
  mode = function(value)
    assert(value == "auto" or value == "review")
    storage.sgluna_area_mode = value
    return true
  end,
  markers = function(id)
    for _, row in pairs(storage.sgluna_area_reservations or {}) do
      if row.id == id then
        return {
          blueprint_tiles = #row.blueprint[1].get_blueprint_tiles(),
          pin = row.tag.valid,
          outline = row.outline.valid,
        }
      end
    end
    error("reservation not found")
  end,
})
