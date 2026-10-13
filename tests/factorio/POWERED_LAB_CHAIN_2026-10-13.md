# Steam-powered lab gate

Owner: unit 5 (`test/powered-lab-chain`), based on `48182d2a`.

The new `steam-lab` lane runs the existing `steam_power_cell.py` canary, then
extends its actual pump/boiler/engine network to a lab through native NPC
operations. The same extension runs in the existing `production` lane.
The lab is added after all drill throughput and provenance measurements, so
its demand cannot contaminate their assertions.

Fixture setup seeds actor-held construction items, coal and ten red science
packs, plus automation's prerequisites. The target remains unresearched.
Construction, fuel/science transfer and research submission use the original
standalone character's bounded operations. No lab, power source, research
progress or target completion is synthesized after setup. The lab segment
uses speed 1 and requires zero humans; earlier steam/drill measurements retain
their established accelerated fixture clock.

## Result

Factorio 2.0.77 passed on 2026-10-13:

- Existing fluid alignment, 90 kW drill, ore-rate and hand-work provenance
  gates all passed.
- Supplied lab 16, with automation admitted, had no power and zero progress
  after a 300-tick negative window; all ten packs remained.
- The NPC placed pole 17. Lab 16 and original engine 9 then shared network 1.
- Native progress rose from `0.05133333333333317` at tick 27850 to
  `0.10250000000000101` at tick 28157. Science fell from ten to nine.
- The engine generated 2500 J/tick (drill plus lab), had steam, and was the
  only producer reported by the lab's `electric_network_satisfied` goal.
- Actor 1 stayed a valid standalone character; there was exactly one lab,
  no artificial electricity fixture, zero humans, and speed 1.

This is A1 exact-layout mechanics evidence for real research advancement.
It does not prove autonomous planning, science production, completed automation,
or logistic-science research. The scenario deliberately stops after measured
progress and clears its research queue during cleanup.

## Reproduction and evidence

Run from the repository root:

```sh
docker build -f tests/factorio/Dockerfile -t factorio-npc-test-powered-lab .
docker run --rm -e NPC_TEST_LANES=steam-lab factorio-npc-test-powered-lab
```

The validation run retained its container as `npc-powered-lab-gate2` instead
of using `--rm`, so its full evidence could be copied out.

| Gate | Actual exit | Result |
| --- | --- | --- |
| Full Docker build | 0 | 55 prompt tests, 1,105 mod tests, typecheck and Lua build |
| Engine runner Python suite | 0 | 92 tests, including negative powered-lab oracle cases |
| `NPC_TEST_LANES=steam-lab` | 0 | Existing steam canary plus powered-lab progress |
| `git diff --check` | 0 | No whitespace errors |

Compact native receipts and samples are committed in
`tests/factorio/evidence/powered-lab-chain-2026-10-13.json`.
Full local artifacts remain in `test-results/powered-lab-attempt2/`, including
`steam-power-cell.json` and Factorio logs; console/build outputs are
`powered-lab-engine.log` and `powered-lab-build.log`.

Attempt 1 exited 1 because the new observation probe had an extra Lua `end`.
Every preceding steam/drill/provenance assertion passed. The probe was fixed,
the image rebuilt, and attempt 2 ran in a fresh world. The failed attempt is
preserved in `test-results/powered-lab-attempt1/` and
`powered-lab-engine-attempt1.log`; no gameplay assertion was weakened.

No runtime/mod behavior was changed. Integration still owns the ordinary
`scripts/test-local.sh all` gate and any broader production-lane check on the
merged candidate. No provider, Jev, CLI proxy, credentials or deployment were
used by this unit.
