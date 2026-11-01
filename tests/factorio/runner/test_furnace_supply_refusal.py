import unittest

from furnace_supply_refusal import FOREIGN_COUNT, FOREIGN_ITEM, ORE_PER_FURNACE, output_count, refused_batch_problems


def refused_status(**result_overrides):
    result = {
        'type': 'moving_items',
        'accepted': False,
        'completed': False,
        'code': 'nothing_moved',
        'target_unit_number': 6,
        'item_name': 'iron-ore',
        'moved_count': 0,
        'requested_count': ORE_PER_FURNACE,
        'to_entity': True,
        'held_count': 160,
        'refusal_cause': 'input_slot_holds_other_item',
        'tick': 900,
        'refusal_tick': 897,
        'target_inventories': [
            {'role': 'fuel', 'name': 'fuel', 'empty_slots': 1, 'can_insert': False, 'contents': []},
            {'role': 'input', 'name': 'crafter_input', 'empty_slots': 0, 'can_insert': False,
             'contents': [{'name': FOREIGN_ITEM, 'count': FOREIGN_COUNT}]},
            {'role': 'output', 'name': 'crafter_output', 'empty_slots': 1, 'can_insert': False, 'contents': []},
        ],
    }
    result.update(result_overrides)
    return {
        'task_state': 'idle',
        'queue_length': 0,
        'last_cancelled_batch': {
            'outcome': 'refused',
            'task_count': 6,
            'refused_count': 1,
            'completed_count': 5,
            'tick': 900,
            'reason': 'moving_items:nothing_moved:input_slot_holds_other_item',
            'refusals': [{'target_unit_number': 6}],
        },
        'basic_operation': {'last_result': result},
    }


class FurnaceSupplyRefusalContractTests(unittest.TestCase):
    def test_refused_batch_with_cause_and_slot_contents_passes(self):
        self.assertEqual(refused_batch_problems(refused_status(), refused_unit=6, sibling_units=[7, 8], held_before=160), [])

    def test_bare_nothing_moved_without_cause_is_rejected(self):
        status = refused_status(refusal_cause=None, held_count=None, target_inventories=[])
        problems = refused_batch_problems(status, refused_unit=6, sibling_units=[7, 8], held_before=160)
        self.assertTrue(any('refusal_cause' in problem for problem in problems), problems)
        self.assertTrue(any('held_count' in problem for problem in problems), problems)
        self.assertTrue(any('input inventory' in problem for problem in problems), problems)

    def test_cancelled_siblings_are_rejected(self):
        status = refused_status()
        status['last_cancelled_batch'] = {'task_count': 6, 'tick': 900, 'reason': 'moving_items:nothing_moved'}
        problems = refused_batch_problems(status, refused_unit=6, sibling_units=[7, 8], held_before=160)
        self.assertTrue(any('outcome' in problem for problem in problems), problems)
        self.assertTrue(any('completed_count' in problem for problem in problems), problems)

    def test_output_slot_ore_is_counted_under_factorio_2_names(self):
        furnace = {'inventories': [
            {'name': 'crafter_input', 'contents': [{'name': 'iron-ore', 'count': 20}]},
            {'name': 'crafter_output', 'contents': [{'name': 'iron-ore', 'count': 50}]},
        ]}
        self.assertEqual(output_count(furnace, 'iron-ore'), 50)


if __name__ == '__main__':
    unittest.main()
