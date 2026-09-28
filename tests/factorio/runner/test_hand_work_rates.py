import unittest

from hand_work_rates_cell import slope_seconds_per_item


def sample(tick, count, progress):
    return {'tick': tick, 'count': count, 'progress': progress}


class SlopeTests(unittest.TestCase):
    def test_uses_items_plus_progress_between_working_samples(self):
        # 2 s per item: 120 ticks per item, progress rises 1/120 per tick.
        samples = [sample(0, 0, 0), sample(30, 0, 0.25), sample(150, 1, 0.25), sample(270, 2, 0.25), sample(400, 3, 0)]
        self.assertAlmostEqual(slope_seconds_per_item(samples, 3), 2.0)

    def test_ignores_samples_before_work_starts_and_after_the_target(self):
        samples = [sample(0, 0, 0), sample(10, 0, 0), sample(40, 0, 0.5), sample(100, 1, 0.5), sample(130, 2, 0)]
        self.assertAlmostEqual(slope_seconds_per_item(samples, 2), 1.0)

    def test_needs_two_working_samples(self):
        self.assertIsNone(slope_seconds_per_item([sample(0, 0, 0), sample(60, 1, 0)], 1))


if __name__ == '__main__':
    unittest.main()
