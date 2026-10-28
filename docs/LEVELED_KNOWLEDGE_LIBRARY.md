# Leveled knowledge and skill methods

Owner: Codex chat 01a18444. Source: reviewed Jev integration
`1ec2b1980f09788971d4cd9712ece73a1a30da28`.
Task branch: `feat/leveled-knowledge-library`.

The owner requested the approved method catalog be built, independently reviewed
by a stand-alone Sol 6.1 for practical NPC content gaps using only local
knowledge, and reflected in the in-game GUI. This implements a selectable
library of six knowledge entries and forty-two skills across complexity levels.
It does not establish autonomous gameplay mastery or authorize a live test.

## Methods and live facts

**No recipes. No ratios. Read them directly from the live game.** Authored
entries contain no ingredient bills, recipe topology, numerical mechanics or
assumed unlock sequence. They teach when to inspect, which live facts matter,
how to choose a supported action and what evidence completes the method.
Requested owner quantities and stock policies remain requirements; they are
not factual recipes or production ratios.

Each entry has:

- `content_type`: `knowledge` for interpretation/decision support, or `skill`
  for a reusable method. This is independent of existing domain `kind`.
- `level`: complexity, independent of availability and evidence.
- `guidance`: when to use/skip, live checks, procedural steps, completion
  evidence, required capabilities and related canonical entry IDs.
- Candidate lifecycle and untested native verification. Future techniques
  explicitly require capabilities that the current NPC may not have.

Knowledge entries cannot receive `verified` status through the existing physical
skill verifier. That verifier proves physical construction/output contracts,
not the truth or complete applicability of an interpretation guide. The new
metadata is optional; canonical legacy records omit it, preserving old JSON.

## Select the library and browse it

The basic curated profile remains the default for comparison compatibility.
Open the existing learning/library window and choose **Leveled curated library**
to install the new catalog. **Basic curated library** restores basic curation.
Switching removes only untouched curation from the inactive profile. Personal
edits, learned entries and other dynamic imports survive; therefore a customized
save can contain more entries than the selected curated profile.

The window separates **Knowledge** and **Skills**, filters by complexity level,
labels unclassified older entries as **Unleveled**, and displays the complete
method, live checks, required capabilities, completion evidence and lifecycle
status. Filters and selections are player-specific synchronized GUI-event state;
rendering does not create storage. Refreshes preserve an unchanged detail pane
and do not overwrite an active edit.

For a controlled local import, `autorio_skills.select_curated_library` accepts
`basic` or `leveled`, and `autorio_skills.curated_profile` reports the selected
profile. These are administrative native interfaces, not newly exposed model
tools. Selecting a profile grants no gameplay, plan replacement or completion
authority. It does not alter the instruction copies pinned to committed plans.

## Catalog and exact export

The source of truth is
[leveled_skill_library.ts](../packages/autorio/src/leveled_skill_library.ts).
The complete importable JSON is
[leveled-library-v1.json](../packages/autorio/src/fixtures/leveled-library-v1.json).
Regenerate/check it without dependencies or network access:

```sh
node scripts/export-leveled-library.mjs
node scripts/export-leveled-library.mjs --check
```

The exporter requires a Node version with `node:module.stripTypeScriptTypes`.
It strips types from this data-only module and exports its static definitions;
it does not load native Factorio code, connect to a provider or start a game.

| Level | Entry names |
| --- | --- |
| Live-world literacy | Available Capabilities; Acquisition Paths; Production Dependencies; Machine State Interpretation; Connection Geometry; Rates, Stocks and Freshness |
| Reliable local cells | Reuse Before Building; Place-Observe-Connect; Direct Transfer; Deliberate Belt Routing; Complete the Operating Cell; Commission Before Copying |
| Efficient bootstrap | Minimum Useful Bootstrap; Trigger-Aware Progression; Parallel Production Scheduling; Construction-Kit Planning; Production Reinvestment; Manual-to-Automatic Transition |
| Self-sustaining production | Find the Actual Bottleneck; Protect Critical Supply; Manage Every Output; Control Without Chatter; Preserve Working Stock; Prove Sustainment |
| Factory infrastructure | Define Production Interfaces; Choose Local or Shared Production; Build Rail Clearance; Match Station Commitments to Capacity; Design Robot Service Areas; Maintain Remote Operations |
| Whole-chain optimization | Choose the Best Next Investment; Evaluate Module Tradeoffs; Design Economical Beacon Coverage; Test Transport Under Uneven Demand; Size Logistics from Completed Service; Upgrade Without Losing Service |
| Specialized systems | Invest Selectively in Quality; Separate Quality Streams; Control Recycling Surplus; Schedule Perishable Production; Preserve Biological Restart Paths; Sustain Environmental Services |
| Long supply chains | Establish an Independent Operating Base; Sustain a Traveling Platform; Match Travel to Support Capacity; Plan Cargo by Delivered Value; Protect Both Ends of a Supply Route; Optimize Network-Wide Progress |

## Model delivery and save/restart

Existing `findSkills`/`getSkillDetails` names and per-step `skillIds` remain
compatible and can reference either content type. Discovery cards and details
carry the optional type/level labels. The real detail compactor retains full
guidance and applicability. Planner/executor role boundaries, detail budgets,
immutable plan references, snapshot hashes and recovery limits are unchanged.
New context text explains the distinction and requires current admitted tools
and live facts; historical unclassified context keeps its original wording.

The actual selected procedure is captured in the existing durable handoff and
restored after restart. Changing the current profile or library cannot substitute
a different method into an already committed selected-skill plan. No extra model,
Jev or executor lookup is introduced.

## Content review and acceptance evidence

The independent reviewer used Sol 6.1 with a fresh short context and local files
only. It assessed whether all authored entries make sense for this standalone
NPC to act upon, using the local tool contract and native implementation where
needed. It did not inspect the internet or establish gameplay mastery.

Resolved content findings:

- Commissioning now distinguishes configurable recipe selection/readback before
  startup from automatic selection observed after supplying startup inputs.
- Fluid connections require live identity, direction, filter and applicable
  temperature compatibility; missing/truncated facts do not prove compatibility.
- Feedback control states separate boundaries, retained state between them and
  initialization/restart behavior without storing thresholds.
- Robot-service guidance is explicitly scoped to item delivery; it does not
  imply construction-job submission/completion support.

Final content-only verdict: **APPROVED**, no remaining actionable findings.
Implementation verification is separate: meaningful regressions cover profile
selection and personal edits, content-policy/schema checks, discovery, actual
context compaction, disk-restart handoff, and the GUI selectors/unchanged refresh.
Validation on this task passed: tooling, agent, runtime and mod offline gates;
TypeScript, generated Lua and changed-code lint; exact Factorio `2.0.77` native
profile selection, discovery, complete method presence and ZIP/save/reload with
zero connected humans. The native smoke does not test GUI rendering: GUI
interaction behavior is covered by the repository's simulated GUI tests, and
appearance in a connected game client remains unverified. No live provider
trial or autonomous production result is claimed. Full logs and reviewer/cleanup evidence
remain local under the workspace's
`test-results/leveled-knowledge-library-20261028`, unstaged and unpushed.
