import unittest

from trigger_ladder_cell import Finding, topological_order, trigger_item_name


class TopologicalOrderTests(unittest.TestCase):
    def test_prerequisites_come_first_and_ties_are_sorted(self):
        techs = {
            'logistic-science-pack': {'prerequisites': ['automation-science-pack']},
            'automation-science-pack': {'prerequisites': ['electronics', 'steam-power']},
            'steam-power': {'prerequisites': {}},  # an empty Lua table serialises as {}
            'electronics': {},
        }
        self.assertEqual(
            topological_order(techs),
            ['electronics', 'steam-power', 'automation-science-pack', 'logistic-science-pack'],
        )

    def test_prerequisites_outside_the_closure_are_ignored(self):
        self.assertEqual(topological_order({'a': {'prerequisites': ['elsewhere']}}), ['a'])

    def test_a_cycle_is_an_error(self):
        with self.assertRaises(AssertionError):
            topological_order({'a': {'prerequisites': ['b']}, 'b': {'prerequisites': ['a']}})


class TriggerItemNameTests(unittest.TestCase):
    def test_accepts_bare_name_and_filter_table(self):
        self.assertEqual(trigger_item_name({'item': 'iron-plate'}), 'iron-plate')
        self.assertEqual(trigger_item_name({'item': {'name': 'lab'}}), 'lab')
        self.assertIsNone(trigger_item_name({'entity': 'stone-furnace'}))


class FindingTests(unittest.TestCase):
    def test_finding_is_an_assertion_error_with_its_name_first(self):
        self.assertTrue(issubclass(Finding, AssertionError))
        self.assertTrue(str(Finding('FINDING trigger_not_credited tech=x')).startswith('FINDING trigger_not_credited'))


if __name__ == '__main__':
    unittest.main()
