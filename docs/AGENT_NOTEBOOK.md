# Explicit working notes and concept references

The planner and executor can use `readNotebook({scope})` and
`updateNotebook({scope, expectedRevision, text})` as explicit tools. These are
ordinary external working notes, not hidden reasoning. Neither tool changes a
goal, plan, Roadmap Shelf, operation, recovery allowance or completion contract.

`goal` is shared by both roles for the current host-selected NPC and goal.
Changing the goal presents an empty revision-zero view; the first write for that
goal replaces the old goal slot. `persistent` is separate and survives goals and
restart for that NPC in the same native world. The model cannot select a file,
NPC, goal identifier or world. Keys use the native `sgluna_factory` world UUID
and the host NPC identity. First use may allocate that UUID using the existing
native metadata API; this is recorded separately from gameplay operations. A
copied host state file in a different native world does not expose old notes.

Read before editing and replace the complete bounded text using its revision.
A successful update acknowledges the committed revision and `durable: true`;
it does not echo the text into the response. Revision conflicts are explicit
failed tool results. There is no automatic retry or merge. An empty string is an
explicit clear and still increments the revision.

## Content and delivery

Notes are opaque, untrusted and advisory. Use them for questions, lessons and
pointers to historical observations. Recheck live facts through deterministic
game tools. The tools instruct models not to store recipe bills, ratios or
numerical game mechanics. This semantic content policy is a model instruction,
not a complete deterministic filter; numbers such as evidence IDs and owner
requirements are not rejected by heuristics. A hostile or incorrect note has no
authority in the harness and never becomes a verified fact.

Only requested read results contain note text. Notes are absent from system
messages, automatic request prefixes, skill context, authored libraries, pinned
skill selections and planner/executor handoff facts. Compaction removes notebook
call/result pairs, including write arguments and acknowledgements, while keeping
aligned world-result pairs from mixed historical exchanges. Restart does not
autoload notes. Existing model dialogue may quote a note; such model-authored
text remains subject to the ordinary role and admission contracts.

The six built-in knowledge entries describe conceptual distinctions and a
qualitative contrast rather than repeated procedures. Authored `search_aliases`
participate in the existing deterministic tag ranker and round-trip through
reference exports/imports. Only exact prior canonical knowledge copies upgrade
to revision two; modified personal copies, including older imports without an
edit marker, retain their content. Existing committed instruction snapshots stay
independent of catalog updates.

## Bounds, persistence and refusal

- Each text is at most 4,096 JavaScript characters. There are at most 32 native
  world/NPC pairs, with one goal slot and one persistent slot per pair. A full
  store refuses a new pair; it never silently evicts another NPC or world.
- Each request has eight shared knowledge/notebook calls, including cached
  reference reads and correctable notebook refusals. At most four are notebook
  write attempts. Conversation restages and role switches do not refill these
  counters. Schema-invalid submissions remain subject to existing format guards.
- Notebook tools require a single-call batch. They are excluded from world
  observation relevance selection, targeted observation requests, native
  operation admission and Jev. Generic provider, cancellation, output and
  observation-only no-progress limits still apply. Closed or targeted recovery
  rounds cannot use notebook tools.
- Revisions are bounded to one billion. Invalid, duplicate, oversized or
  overflowing restored notebook data produces a durable notebook-local fault,
  not an empty usable revision-zero store. The canonical plan and other memory
  remain available. The entire original invalid JSON value is retained unchanged
  as inert recovery data, including valid personal rows beside a bad row. This
  quarantine may exceed admitted-store bounds; it is never exposed to model
  tools, truncated, wrapped repeatedly or interpreted as a usable notebook.
  Ordinary saves and further restarts preserve it. The fault persists until an
  explicit operator repair of the state file.

Writes stage a candidate in the existing `persistQueue`. The host checks owner
and revision at queue execution, after filesystem awaits and before atomic
rename. Memory does not expose the staged text. A failed mkdir/write/rename
leaves the committed notebook unchanged; a later ordinary save cannot leak a
failed candidate. No state file means no successful write, including in tests.

Atomic rename is the commit point, using the existing state-file persistence
contract. If a request is superseded while rename completes, the captured scope
remains committed and memory is synchronized before any later queued save. The
stale requester receives no success acknowledgement. The refusal trace says
`committed: true`; it does not claim a rollback. Fences cover NPC, native actor,
epoch/session, current goal, memory instance, request, generation, role, lineage
and conversation sequence. Revision checks also fence store restoration.

Common `tool.call`/`tool.result` traces retain original arguments and result text
with request/tool-call IDs. Notebook events add scope, committed revision and
identity. Classify reads as context reads and updates as local working-memory
writes; neither is a native gameplay operation. No private chain of thought is
requested or required.

## Verification

Focused tests are in
`deploy/pterodactyl/runtime-v8/agent-notebook.test.mjs` and
`packages/autorio/src/leveled_skill_library.test.ts`. They cover both roles,
explicit delivery, scripted full-loop handoff, disk restoration, scope isolation,
CAS concurrency, filesystem faults, owner changes around commit, bounded corrupt
restoration and unchanged authority. The required full offline gate still applies.

The isolated exact-version native driver is
`tests/factorio/runner/agent_notebook_factorio.mjs`:

```text
node tests/factorio/runner/agent_notebook_factorio.mjs --repo <checkout> --results <shared-results> --phase prepare|reload|cold --host <host> --port <port> --password <fixture-password>
```

The run owner supplies Factorio 2.0.77 and owns all resources. `prepare` tests
the real catalog/search/import/profile boundary, both roles and strict host
writes. It creates `notebook-prepare-state.json`, a byte-identical retained
`notebook-prepared-state.json`, and `notebook-expected.json`. Save the paused
native world and preserve its ZIP before loading it for `reload`. That phase
copies the retained host file into `notebook-reload-state.json`, verifies both
scopes and native identities, then proves goal replacement and a second host
reload. `cold` requires a separate pristine native world; it copies the same
retained host bytes into `notebook-cold-state.json` and proves empty reads under
a newly allocated, different native UUID for the same host NPC/goal identities.

Each phase emits its JSON result, complete command transcript and events. The
driver uses the bounded console-readiness handshake, explicit `__autorio__`
scope for native storage snapshots, and a failed status on any finalization
error. It performs no inference or operation submissions. Static tests and this
native proof do not establish model usefulness or gameplay success and do not
authorize an E2E trial.
