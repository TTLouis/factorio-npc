# External harness Windows journal validation — October 30, 2026

This addendum covers the native Windows compatibility change to the supplied
external-harness package, isolated on `feat/external-harness-mcp` from package
base `1ec2b1980f09788971d4cd9712ece73a1a30da28`. The starting source was verified
against all 1,294 supplied package files before implementation. Later Jev
integration changes were not imported. Earlier package reports remain intact.

## Change and supported boundary

The supplied runtime flushed a temporary ledger, renamed it, then opened and
flushed the parent directory. Native Windows refuses that directory operation,
so successful writes incorrectly poisoned the journal before mutation.

`tools/external-harness/runtime.mjs` preserves the temporary-file write, flush
and close on both platforms. Linux retains rename plus directory flush. Windows
calls the bundled `replace-journal-windows.ps1` using literal argv paths and a
credential-free environment. The helper uses Win32 `MoveFileExW` with
`REPLACE_EXISTING | WRITE_THROUGH`, refuses nonlocal/non-NTFS drives and reparse
path components, and returns failure without fallback. Script execution and
`Add-Type` must be permitted by local policy. No execution-policy bypass is used.

Any file or helper failure prevents sending the operation and poisons further
runtime work. A visible replacement after an uncertain helper result is retained
as conservative write-ahead evidence; restart reconciles it and never resends.
The existing single-owner lock and literal-loopback RCON allowlist are unchanged.

The [operator guide](../EXTERNAL_HARNESS.md) describes native Windows,
Windows-host-to-Docker, and Linux-container bridge layouts. Docker publication
for a Windows host bridge is explicitly `127.0.0.1:27015:27015/tcp`; the bridge
does not accept Docker hostnames or container IPs. Its state remains on local
NTFS even when Factorio runs in Docker.

## Focused proof

Native Windows Node 24.11.1, outside the restricted Codex process sandbox:

```text
node --test tools/external-harness/runtime.test.mjs tools/external-harness/cli.e2e.test.mjs
35 tests; 33 passed; 0 failed; 2 POSIX-only tests skipped
```

The new regressions exercise:

- Real file write, flush and close boundaries with injected `EPERM`: no native
  submission, followed by poisoned-runtime refusal.
- A read-only Windows ledger destination: the real Win32 replacement fails,
  leaves prior contents intact and prevents submission.
- Owned temporary-directory junction rejection and literal paths containing
  spaces, Unicode and shell metacharacters.
- Helper spawn, timeout and nonzero-exit errors, plus a real successful native
  replacement followed by injected acknowledgement loss. Restart retains the
  unresolved operation without sending it.
- Abrupt real CLI process termination after native fixture admission but before
  acknowledgement: persisted write-ahead record, stale-lock refusal, verified
  operator lock recovery and duplicate reconciliation with one total admission.
- POSIX rename/directory-flush error regressions, intended for the Linux lane.

Existing concurrent idempotency, uncertain/unsent restart, cancellation, world
rollback, conflicting historical receipts and lock exclusivity checks also pass
in that focused Windows run. The CLI fixture uses the actual MCP transport,
NativeBridge and TCP RCON implementation; its engine responses are synthetic.

## Final gates and real-engine connection checks

The complete external-harness suite passed on both platforms:

| Environment | Tests | Passed | Failed | Expected skips |
| --- | ---: | ---: | ---: | ---: |
| Native Windows, Node 24.11.1 | 84 | 82 | 0 | 2 POSIX-only |
| Linux Node 24 Docker, Windows bind-mounted temporary state | 84 | 77 | 0 | 7 Windows-only |

The required `bash scripts/test-local.sh all` gate exited 0: 104 ordinary-agent,
4,368 runtime and 1,697 mod tests passed, with tooling, type checking, Lua build
and generated-Lua checks passing. Scoped ESLint also exited 0 for every
`tools/external-harness/*.mjs` module, `packages/autorio/src/control.ts` and
`external_placement.control-wiring.test.ts`, using the existing offline Docker
runner. These immutable results preceded this report-only update;
implementation bytes did not change afterward.

Exact Factorio **2.0.77** connection lanes also passed:

| Lane | Retained successful attempt | Result |
| --- | --- | --- |
| Windows-host MCP to native Windows Factorio | `native-windows-attempt3` | Exact completed receipt for a 120-tick wait; disconnect, bridge restart, resume and duplicate request retained one admission |
| Windows-host MCP to Docker Factorio, host RCON published on loopback | `windows-to-docker-attempt4` | Same exact wait/reconnect/duplicate checks; admission high-water remained 1 before and after duplicate submission |

Both lanes ran with zero connected humans at normal speed, finished native-idle,
and saved ZIPs whose 55 entries passed CRC verification. Run-owned cleanup was
verified for the successful lanes. No model or provider requests were made.
These checks prove connection, bounded native waiting and reconnect/idempotency;
they do not prove factory construction, production, other operation families or
overall gameplay success.

Local logs and metrics are retained outside Git under workspace directory
`test-results/external-harness-package-review-20261030/windows-fix-validation`:
`windows-suite-exit.json`, `linux-suite.json`, `offline-all-exit.json`, and each
successful attempt's `metrics.json`. Earlier unsuccessful setup attempts remain
separate: two server-settings fixture boot failures and a Docker save barrier
that was too short were orchestration issues; no bridge source repair was
required for those attempts. They are not counted as successful connection
checks. Full local logs and saves are intentionally unstaged.

No provider or model calls are part of these tests. Physical power-cut behavior
was not tested; write-through requests still depend on the OS/filesystem/storage
contract. Paired save/journal backups and the documented private storage limits
remain required.
