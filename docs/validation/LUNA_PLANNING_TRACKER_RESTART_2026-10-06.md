# Luna planning probe fresh-container retry — 2026-10-06

The owner requested restarting the test Docker after the first direct-Tailscale probe run. Source: `d3988992`, with the clarified missing-initial-action diagnostic. No production runtime, prompt or validation changes were made for this retry.

The previous disposable planning container had already been removed after exiting. A new named container, `luna-planning-restart-20261006`, ran the same four scenarios with freshly seeded local tracker state and then removed itself. This did not restart Docker Desktop, the remote proxy, or a Factorio server. Authenticated proxy health returned HTTP 200 before the retry.

## Results

| Case | First run | Fresh-container retry |
| --- | --- | --- |
| New plan with initial operations | Fail: operations omitted | Fail: operations omitted |
| Unmet/stale research keeps step open and proposes action | Fail: blocked without action | Pass: research action proposed |
| Satisfied-step continuation | Pass | Pass |
| Grounded semantic closure | Pass | Pass |

The runner exited 1: **3/4 passed**. All four decisions returned in roughly six to eight seconds each; neither run showed a provider timeout or a stuck test process. The changed research answer demonstrates variation between requests, not proof of a Docker stall. The repeated initial-planning omission remains open. The planning-only prompt's statement that no proposed operations would execute may contribute to that omission; this is an inference, not an established cause.

Four Luna requests, zero automatic retries, zero corrective prompts, zero Jev calls, no game connections and no gameplay admissions. The Tailscale endpoint override was temporary; `.env`, proxy routing and gameplay state were unchanged. No further model calls were made after this retry.

Evidence: `test-results/luna-system-fixes-2026-10-06/luna-planning-tailnet-restart-1/` contains sanitized actual requests, raw model decisions and validation results. The summary and log are retained alongside the earlier run, with no overwritten evidence. Proxy health is recorded in `luna-planning-restart-health.log`.
