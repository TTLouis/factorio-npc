# CLI-proxy connection restored after Run O

Run O stopped before planning because the configured proxy connection was refused. Read-only inspection over verified SSH established that the Docker VM was online over Tailscale, its existing CLIProxyAPI container was running without restarts, and the VM's loopback proxy publication answered an unauthenticated models request with HTTP 401. The configured local forwarding port had no listener.

Restored the missing local SSH forward to that existing VM proxy listener over Tailscale. The forward binds only to local loopback, preserves strict verification of the already-trusted VM host key, refuses conflicting listeners and uses bounded SSH keepalive detection. No VM service was restarted; no provider configuration, credentials, `.env` file or production source changed.

Verification from the actual game image and configured Compose environment:

| Check | Result |
| --- | --- |
| Before repair, configured TCP connection | `ECONNREFUSED` |
| VM proxy, unauthenticated models GET | HTTP 401 |
| Game image after repair, unauthenticated models GET | TCP connected, HTTP 401 |
| Game image after verified routing, authenticated models GET | HTTP 200; 33 models; `gpt-6.1-sol` and `gpt-6-luna` available |
| Final local listener check | Running SSH process owns one loopback-only listener |

No inference call or additional E2E trial was part of this repair. The temporary diagnostic Docker network was removed; the forward remains running. It is not a boot-persistent scheduled task and must be checked before every live run. Ignored `test-results/cli-proxy-diagnostic/` retains recovery instructions, the restart helper and listener state. Keys, private endpoints, response bodies and endpoint-bearing diagnostics are excluded from this report and Git.

This proves restored authenticated transport/model discovery, not successful gameplay, live baseline recovery or automated science throughput. Those remain subject to the next supervised cold trial.
