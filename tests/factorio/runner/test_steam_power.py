import unittest

from steam_power_cell import (
    EAST, NORTH, SOUTH, WEST,
    aligned_candidates, connection_targets, opposite, ports_aligned, solve_aligned_placement, target_tile,
)


def port(x, y, direction, filter_name=None):
    return {'position': {'x': x, 'y': y}, 'direction': direction, 'filter': filter_name}


class PortGeometryTests(unittest.TestCase):
    def test_target_tile_steps_from_the_own_tile_along_the_facing(self):
        self.assertEqual(target_tile(port(4.5, 2.5, EAST)), (5.5, 2.5))
        self.assertEqual(target_tile(port(4.5, 2.5, WEST)), (3.5, 2.5))
        self.assertEqual(target_tile(port(4.5, 2.5, NORTH)), (4.5, 1.5))
        self.assertEqual(target_tile(port(4.5, 2.5, SOUTH)), (4.5, 3.5))

    def test_a_pump_and_the_boiler_water_port_on_the_next_tile_align(self):
        pump = port(4.5, 2.5, EAST)
        boiler_water = port(5.5, 2.5, WEST, 'water')
        self.assertTrue(ports_aligned(pump, boiler_water))
        self.assertTrue(ports_aligned(boiler_water, pump))

    def test_touching_ports_that_do_not_face_each_other_do_not_align(self):
        pump = port(4.5, 2.5, EAST)
        self.assertFalse(ports_aligned(pump, port(5.5, 2.5, NORTH, 'water')))
        # Facing each other but a tile apart.
        self.assertFalse(ports_aligned(pump, port(6.5, 2.5, WEST, 'water')))
        # The neighbouring row.
        self.assertFalse(ports_aligned(pump, port(5.5, 3.5, WEST, 'water')))

    def test_opposite_is_the_reverse_facing(self):
        self.assertEqual([opposite(d) for d in (0, 4, 8, 12)], [8, 12, 0, 4])


class CandidateSelectionTests(unittest.TestCase):
    def boiler(self, cid, x, y, direction, ports):
        return {'id': cid, 'position': {'x': x, 'y': y}, 'direction': direction, 'fluid_ports': ports}

    def test_only_candidates_with_an_aligned_port_are_selected(self):
        pump = port(4.5, 2.5, EAST)
        covering = self.boiler('candidate-1', 6.0, 2.5, EAST, [port(5.5, 1.5, NORTH, 'water'), port(5.5, 3.5, SOUTH, 'water')])
        aligned = self.boiler('candidate-2', 6.5, 2.0, NORTH, [port(5.5, 2.5, WEST, 'water'), port(7.5, 2.5, EAST, 'water')])
        chosen = aligned_candidates([covering, aligned], pump, 'water')
        self.assertEqual([entry['candidate']['id'] for entry in chosen], ['candidate-2'])
        self.assertEqual(chosen[0]['port']['position'], {'x': 5.5, 'y': 2.5})

    def test_solving_an_engine_placement_from_any_candidate_of_the_wanted_direction(self):
        # Boiler steam port on (6.5, 1.5) facing north: the engine's steam port
        # must be on (6.5, 0.5) facing south.
        boiler_steam = port(6.5, 1.5, NORTH, 'steam')
        # A vertical engine candidate elsewhere: centre (10.5, 20.5), ports at its two ends.
        engine = {'id': 'candidate-4', 'position': {'x': 10.5, 'y': 20.5}, 'direction': NORTH, 'fluid_ports': [
            port(10.5, 22.5, SOUTH, 'steam'), port(10.5, 18.5, NORTH, 'steam'),
        ]}
        solved = solve_aligned_placement([engine], boiler_steam, 'steam')
        self.assertEqual(solved['direction'], NORTH)
        self.assertEqual(solved['position'], {'x': 6.5, 'y': -1.5})
        self.assertTrue(ports_aligned(boiler_steam, solved['port']))

    def test_no_solution_when_no_port_can_face_back(self):
        boiler_steam = port(6.5, 1.5, NORTH, 'steam')
        east_west = {'id': 'candidate-5', 'position': {'x': 0.5, 'y': 0.5}, 'direction': EAST, 'fluid_ports': [
            port(2.5, 0.5, EAST, 'steam'), port(-1.5, 0.5, WEST, 'steam'),
        ]}
        self.assertIsNone(solve_aligned_placement([east_west], boiler_steam, 'steam'))


class ConnectionTargetTests(unittest.TestCase):
    def test_lists_only_connections_with_a_target_per_storage(self):
        status = {'entity': {'spatial': {'fluid': {'storages': [
            {'connections': [{'target': {'name': 'offshore-pump', 'unit_number': 3}}, {'position': {'x': 1, 'y': 1}}]},
            {'connections': []},
        ]}}}}
        self.assertEqual(connection_targets(status), [[{'name': 'offshore-pump', 'unit_number': 3}], []])

    def test_no_spatial_data_is_no_storages(self):
        self.assertEqual(connection_targets({'entity': {}}), [])


if __name__ == '__main__':
    unittest.main()
