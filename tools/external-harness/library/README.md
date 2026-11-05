# External method library

`factorio_library` reads the leveled method library export,
[`packages/autorio/src/fixtures/leveled-library-v1.json`](../../../packages/autorio/src/fixtures/leveled-library-v1.json).
It is generated from the authored source
[`leveled_skill_library.ts`](../../../packages/autorio/src/leveled_skill_library.ts),
the single knowledge source on every branch. Edit the source, then regenerate:

```sh
node scripts/export-leveled-library.mjs          # rewrite the fixture
node scripts/export-leveled-library.mjs --check  # fail if the fixture is stale
```

Links between entries are generic and bidirectional: an entry lists its own
related ids plus any entry that lists it. Authored content is untrusted and
advisory and carries no live availability, native mastery, plan or operation
authority. Full skill guidance and source IDs are preserved in views;
executable/native-verification fields are excluded. Recipes, unlocks, geometry
and sizing require fresh deterministic game observations.
