# Latest proofs

A record of what the external harness has actually demonstrated. Each entry
identifies the tested source, measured result, screenshots and remaining limits.
New code alone does not upgrade an older result.

---

## Recorded evidence

| Date | Furthest demonstrated milestone | Outcome |
| --- | --- | --- |
| November 5, 2026 | [Electrified starter base with automatic red science](2026-11-05-electrified-starter-base.md) | Electric coal, iron and copper mining; automatic fuel service; 21 new packs delivered to a consuming lab in a hands-off window. Modest output and first-player startup compatibility remain limits. |
| November 4, 2026 | [Automatic red science and lab delivery with burner coal](2026-11-04-automatic-red-science.md) | 62 new packs in a ten-minute hands-off window; automatic fuel and lab delivery. Qualified: burner coal mining remained, and first-player crash creation was deferred. |
| October 31, 2026 | [Semi-automated red science, with screenshots](2026-10-31-red-science.md) | 12 new packs in a two-minute hands-off window; chest output, manual fuel servicing. Formal acceptance failed a furnace observation check. |

The latest run adds electric coal mining and automatic fuel service to the
measured science-to-lab chain. A self-fuelling burner inserter remains at the
boiler; compatibility with later first-player crash-site creation is unproven.

---

## Download saves

Each proof has a privacy-reviewed copy of its post-stop world and the exact
matching NPC mod. The NPC and game-state payloads are preserved. Archive names,
timestamps and host-specific ZIP metadata have been normalized; the copies
passed checks for personal identifiers and credentials and contain no stored
human player records. The original evidence saves remain unchanged and local.

| Run | Save ZIP | Matching NPC mod ZIP |
| --- | --- | --- |
| November 5, 2026 | [Electrified starter base](save/2026-11-05-electrified-starter-base.zip) | [Autorio for this run](save/2026-11-05-electrified-starter-base-autorio-mod.zip) |
| November 4, 2026 | [Automatic red science](save/2026-11-04-automatic-red-science.zip) | [Autorio for this run](save/2026-11-04-automatic-red-science-autorio-mod.zip) |
| October 31, 2026 | [Semi-automated red science](save/2026-10-31-red-science.zip) | [Autorio for this run](save/2026-10-31-red-science-autorio-mod.zip) |

1. Use **Factorio 2.0.77**, with Space Age, Quality and Elevated Rails disabled
   to match the runs. Download the save and its matching mod ZIP.
2. Extract the mod ZIP into Factorio's mods folder. It contains an
   `autorio_0.1.0` folder. These historical builds share that version number;
   use the one for the save you are opening, one at a time.
3. Put the save ZIP in Factorio's saves folder, enable Autorio and load it.
   These downloads contain no external controller or model credentials.

All public save copies loaded successfully with the matching mod in Factorio
2.0.77. They are inspection downloads, not new trial results. See each report
for its limitations, including first-player crash-site behavior.

---

## What the evidence shows

Screenshots show preserved layouts. Production claims come from the recorded
native measurements, not from the appearance of a running machine. Raw traces,
private configuration, detailed metrics and original saves remain owner-local;
the reviewed inspection copies are available above.

---

## Adding a proof

When adding a milestone, keep older dated records intact. Include the exact
source and game version, starting conditions, measurement window, native output,
manual interventions, formal acceptance result and stop/save/cleanup status.
Caption screenshots with their capture context, and state what remains unproven.
Summarize the important run statistics in the report; keep raw metrics JSON local.

For every published run, add a separate save copy under `save/` and link it in
the download table. Include the matching mod when needed. Before publication,
review the save for player/account identities, personal names, addresses, private
paths and credentials; remove personal information from the public copy, clear
host-specific archive metadata and verify ZIP integrity and an exact-version
native load. Preserve the original evidence and record the checks locally.
