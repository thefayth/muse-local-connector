# Unattended startup verification: 2026-10-20

The reconnect worker was tested on Windows with Node.js 22.22.1 and Codex desktop
package version 26.1013.4894.0. This record omits personal chat IDs, hostnames,
credentials, prompts, and raw runtime receipts.

| Check | Observed result |
| --- | --- |
| Automated suite | 176 tests passed; zero failed, skipped, or cancelled. |
| Syntax and patch checks | `npm run check`, PowerShell parsing, and `git diff --check` passed. |
| Windows peer verification | Same-user/session, exact installed signed executable, process identity, creation-time recheck, and preferred-pipe checks passed. A spoofed PowerShell-owned pipe was rejected. |
| Owner authorization | A genuine registration from the existing controller was retained privately. The live startup test used a real, already completed controller turn containing that registration. |
| Registrar loss | After stopping only the original context registrar, the worker restored a native lease in approximately four seconds. The original registrar remained absent. |
| Existing-chat round trip | One harmless instruction submitted through authenticated public HTTPS completed in an existing chat with its exact correlated receipt. No replacement chat was created and the instruction was not resent. |
| Service restart | The existing Windows scheduled task restarted the supervisor, gateway, relay, and reconnect worker. A new worker restored its native lease in approximately 13 seconds with the original registrar still absent. |
| State preservation | All 55 job IDs present before the second restart survived; the durable owner grant was unchanged. The original interrupted UI job retained its one submission and held reservation. |
| Public readback after restart | Authenticated native status returned HTTP 200 with `desktopReachable: true`. Reading the existing probe returned the completed result and matching receipt. |

The tests did not open the controller chat, start a controller model turn, or
require a model heartbeat to restore native access. A completed historical owner
turn supplied the retained caller identity. The reconnect worker verifies the
current installed app before publishing a fresh private lease.

The native reply arrived in about nine seconds; gateway polling encountered
transient failures and reconciled the same submission later. This is evidence
of recovery and correlation, not a latency guarantee. Existing interrupted work
and queued UI jobs were preserved rather than replayed during maintenance.

A full Windows reboot and a cold Codex app restart were **not performed for this
worker release**. The earlier logon-task reboot check predates this worker. The
tested scheduled-task restart exercises its startup action, but is separate from
those remaining cold-start checks. Windows must be signed in; interactive
computer work may require an unlocked desktop. The phone client was not
separately tested in this batch.

See [automatic startup](automatic-startup.md) for configuration and revocation,
and the [earlier verification record](verification-2026-10-20.md) for four-job
concurrency, UI coordination, and individual job controls.
