# Repeated pump wait fix — 2026-10-20

Owner: Codex session01a15959. Branch `fix/repeated-pump-wait`; source published Jev `2a90c8e07219d7c624114d64b2dcf3a22a4d0075`.

Run AH spent 900 checks on a working offshore pump while its boiler/engine were held, then registered the same passive wait after timeout. A working flag alone supplies no finite production expectation. Passive mode deliberately waits until ongoing production stops; treating its satisfied working predicate as completion would reintroduce false semantic completion.

The shared registration path now reads the exact machine afresh and requires native recipe timing (positive seconds per craft and finite positive seconds until idle). It applies to both zero-operation fallback and wait-only conversion; missing proof returns concrete facts to ordinary bounded act-or-block/review handling. Saved/active passive waits losing this proof wake on their first poll without closing any step. No pump name/type list or model judgment is used. Exact output completion waits remain unchanged, including their authoritative completion predicates and scheduling. Productive furnace passive waits retain existing deadlines and stop behavior.

Fresh reads are fenced by actor/epoch, generation, active goal/step and canonical step identity; the wait-only path carries its scope from before its reused read. Actor/step/generation and canonical-version replacement fixtures reject stale registration. Step/goal advancement, allowances, timeout policy and native gameplay mechanics are unchanged.

- [x] Run AH-shaped pump fixture rejects first/repeated passive conversion; full zero-operation reply reaches repair with decline facts.
- [x] Saved legacy pump wait wakes immediately without completion.
- [x] Seven relevant integration fixtures fail on original source (0/7 pass), pass fixed source. Finite/malformed ETA helper cases covered.
- [x] Standard offline Docker gate: 2,833 runtime / 1,249 mod tests, typecheck, Lua build/check passed. A healthy-passive-timeout fixture now carries real native recipe ETA and an already-scheduled check budget; its original timeout/no-completion assertions are preserved.
- [x] Changed-file ESLint: zero diagnostics; whitespace check passed.
- [ ] Final independent diff review, separate payload repin, integration and exact-head CI/package/security checks.
- [ ] One owner-authorized Run AI, cheaper passive overwatch, strict stop/save/native-load proof and exact owned cleanup.

Evidence: ignored `test-results/repeated-pump-wait/`; historical Run AH evidence is immutable. Other owners' unpublished placement and water changes are excluded. No Pterodactyl deployment, extra trial or external messages are authorized.
