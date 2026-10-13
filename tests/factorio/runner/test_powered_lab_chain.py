"""The engine oracle must fail on admission-only or unrelated research work."""
import unittest

from powered_lab_chain import assert_progress


class PoweredLabOracleTests(unittest.TestCase):
    def samples(self):
        before = dict(humans=0, speed=1, actor_valid=True, actor_kind='standalone_character',
                      current='automation', researched=False, lab_status='working', lab_energy=100,
                      lab_network=7, engine_network=7, engine_generating=1000, steam=100,
                      lab_count=1, artificial_power_count=0, actor_id=42, lab_id=55,
                      tick=1000, progress=0.02, science=9)
        return before, dict(before, tick=1300, progress=0.04)

    def test_real_progress_is_required(self):
        before, after = self.samples()
        assert_progress(before, after)
        for changes in ({'progress': 0.02}, {'progress': 0}, {'current': 'logistics'},
                        {'lab_status': 'no_power'}, {'lab_network': 8}, {'actor_id': 43},
                        {'lab_id': 56}, {'science': 10}, {'engine_generating': 0},
                        {'steam': 0}, {'lab_count': 2}, {'artificial_power_count': 1},
                        {'humans': 1}, {'speed': 4}, {'researched': True}):
            with self.subTest(changes=changes), self.assertRaises(AssertionError):
                assert_progress(before, dict(after, **changes))


if __name__ == '__main__':
    unittest.main()
