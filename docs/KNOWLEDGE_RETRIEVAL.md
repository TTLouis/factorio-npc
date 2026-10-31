# On-demand knowledge references

The authored library has two model-facing views. Skills are reusable procedures
that the planner may select for an immutable execution handoff. Knowledge is
reference material that either role can request when it needs a concept. Neither
view supplies current recipes, quantities, ratios, availability or world state;
those come from live deterministic tools.

## Retrieval and context

`findSkills`, `getSkillDetails`, ranked offers, autoloading, `[SKILL_CONTEXT]`
and `executionGuidance.skillIds` accept procedures only. Native filtering and
runtime projection both exclude knowledge. The executor continues to receive
only its planner-selected, pinned procedures.

`findKnowledge({query, limit?})` and `getKnowledgeDetails({id})` are read-only
runtime-v8 tools available to both roles. They call `autorio_references.find/get`.
The existing `autorio_knowledge` interface still owns live recipe, production and
geometry observations. Reference results contain identity, revision, summary,
applicability, reference concepts/interpretation checks and provenance; they omit physical verification, executable
stage, topology and operation authority.

Knowledge reads require an explicit tool call and a separate batch of at most
three reference calls. Each request permits eight calls, including cached reads,
with at most ten search results and a 7,000-character reference/result bound.
Complete canonical text is retained; an oversized detail is refused intact. The final search envelope also respects the result-size bound.
The cache is bounded by that allowance and expires at the next request. Restaging
a conversation does not refill it. Closed observation phases and targeted repair
rounds do not admit extra reference reads. These calls spend no world-observation
quota or targeted world-observation decision pressure and invoke no Jev relevance or ranking request. Generic observation-only round pressure remains a no-progress guard. Ordinary provider-round,
cancellation and actor fences still apply.

Only the requesting conversation's tool exchange carries a reference. There is
no knowledge autoload, durable reference prompt, selected knowledge ID, or
planner-to-executor fact transfer. Compaction discards old reference exchanges
instead of copying their text into an observation digest. A new executor that
needs the same concept must explicitly request it. Reference access cannot
change the executor's plan or mutation permissions.

## Catalog, persistence and compatibility

The optional leveled catalog retains all six knowledge entries and 54 skills.
Its schema-2 export has separate `knowledge` and `skills` arrays. The original
fixture filename is retained for existing file links. The basic profile stays
the default. The GUI continues to browse/edit both types and omits physical skill
verification rows for knowledge. The physical verifier rejects reference records before actor/template/native work, including restored queued or active verifier records; it cannot promote knowledge to a verified procedure. Untargeted and autonomous verification selection skip historical reference queue entries so later procedures remain reachable. Explicitly targeted reference requests return a refusal without changing that entry. Knowledge exports use
`script-output/sgluna-knowledge/<id>/r<revision>/knowledge.json` and
`KNOWLEDGE.md`; procedure export paths stay unchanged. Exports retain full personal text even when a reference exceeds the smaller RPC retrieval bound.

The native persisted registry remains shared so personal/imported entries,
profile transitions and existing saved records retain their content. Existing
administrative import/edit APIs remain compatible. The typed model views do not
expose that internal storage shape. Imported reference exports are accepted by
the existing canonicalizer with `content_type: knowledge`.

Committed plans and their captured instruction snapshots are never rewritten.
An old mixed snapshot remains intact on load/save. A procedural active step can
still run when another step selected a historical knowledge entry. Attempting to
execute the affected knowledge selection stops at the existing guard boundary
with `planner_skill_handoff_unavailable: legacy_knowledge_selected_as_skill`.
It does not substitute a new method, drop immutable references or start automatic
replanning. Ordinary legacy procedure records without `content_type` remain
supported.

## Validation

Focused coverage lives in `knowledge-retrieval.test.mjs`, the native leveled
library tests, contract parity and skill restart tests. It checks separate typed
views, malicious wrong-type responses, both roles, complete scripted request
flow, budgets, compaction and byte-preserving legacy snapshot holds.

The exact-version native driver is
`tests/factorio/runner/knowledge_retrieval_factorio.mjs`. In an isolated Factorio
2.0.77 server, run `--phase prepare`, save/reload the same world, then run
`--phase reload` with the same `--results` directory. Both phases also take
`--repo`, `--host`, `--port` and an offline-only `--password`. The driver writes
original native transcripts, assertions and an expected library snapshot. The
parent wrapper owns save integrity, pristine reload and resource cleanup. It
uses no inference or gameplay operations; these checks do not establish
autonomous gameplay success or authorize an E2E trial.
