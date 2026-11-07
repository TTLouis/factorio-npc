-- Test-image-only hook inserted inside the compiled bundle before its final return.
remote.add_interface('fluid_connection_test_fixture', {
  observation = function(entity, index, target_id)
    local summary = require('spatial_semantics').compact_spatial_summary(nil, entity)
    for _, port in pairs(summary.fluid.storages[index].connections) do
      if port.target and port.target.unit_number == target_id then return port.hydraulic_state end
    end
    return 'missing'
  end,
  state = function(entity, index, target_id)
    local helpers = require('fluid_connections')
    for _, connection in pairs(entity.get_fluid_box_pipe_connections(index) or {}) do
      if connection.target and connection.target.unit_number == target_id then
        return helpers.fluid_connection_state(nil, entity, index, connection)
      end
    end
    return 'missing'
  end,
})