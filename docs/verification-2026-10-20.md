# Verification: 2026-10-20

This release was tested against existing Codex desktop chats on Windows, using
the configured authenticated HTTPS connector. Private chat IDs, instructions,
credentials, hostnames, screenshots, and raw receipts are excluded from this
public record.

| Check | Observed result |
| --- | --- |
| Automated suite | 151 tests passed; zero failed, skipped, or cancelled. |
| Syntax and patch checks | `npm run check` and `git diff --check` passed. |
| Windows setup | DPAPI fallback, credential hash, plaintext exclusion, default capacity 4, and preservation of an existing credential/configuration passed. |
| Native concurrency | Four distinct native turns overlapped for approximately 44 seconds and all completed with their own correlated receipts. |
| Durable queue | A fifth instruction was accepted once, initially blocked by capacity and its chat, then automatically dispatched and completed. |
| Browser/desktop coordination | Muse submitted a browser health check and a Windows Calculator action together. The second waited for `ui`, then started three seconds after the first native turn completed. Calculator visibly displayed `12 × 9 = 108`; both returned screenshots and matching receipts. |
| Queued edit | The same job advanced to revision 1 and returned only the replacement instruction's result. |
| Queued cancel | The job remained in history as cancelled with `submitted: false`; no native turn was created. |
| Active correction | The existing native turn returned the revised result with both original job and control receipts. |
| Active stop | The existing native turn stopped cooperatively and returned both receipts; only then did the gateway mark the job cancelled. |
| Control retries | Exact edit and stop retries returned the same control record IDs and unchanged timestamps, without another send. |
| Service restart | Gateway and SSH relay restarted through the existing scheduled task; all 44 pre-restart job IDs survived. After the controls batch all 48 job records remained. |
| Final authenticated status | Desktop reachable, capacity 4, zero running or queued jobs, UI lane free. |

The four-job test used the public HTTPS route. Muse's updated helper performed
the UI and control batches, including submission, queue inspection, polling,
and exact control retries. No replacement chats were created and old failed
instructions were not replayed.

These observations prove the tested execution paths, not unlimited capacity or
an OS-wide UI lock. Background execution is a declared tool-use contract; route
all competing browser and desktop work through the connector.

Automatic startup restores the gateway and relay. After a cold Codex restart,
the configured controller chat must call `desktop_context_status` once to
activate its new native lease. A surviving activated registrar renews its lease,
but native submissions after the controller turn ends were not separately
verified during this release. See [automatic startup](automatic-startup.md).
