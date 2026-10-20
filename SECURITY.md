# Security and trust boundaries

This connector gives an authenticated remote client a way to send instructions to existing Codex desktop chats. Those chats may already have access to local files, browsers, applications, and external services. Treat the connector credential as access to an operator, not as a harmless API key for reading status.

## Supported deployment

Bind the gateway to loopback. For a remote client, place a deliberately configured HTTPS tunnel or private access layer in front of it and retain the connector's own bearer authentication. A randomized tunnel address is not authentication. Do not expose an unauthenticated listener on a LAN or public interface.

The connector uses an experimental runtime bundled with Codex desktop. Its launch environment supplies local app-tools IPC context and a caller chat identity. Do not copy or publish pipe details, reuse another chat's identity, or treat an internal transport as a stable public API.

## Authentication

- The Windows setup script generates the credential and prefers an installed/configured Codex vault. On a fresh Windows installation it uses a connector-owned DPAPI encrypted file under the private data directory. Private config holds its SHA-256 verifier as `tokenSha256` and credential-store metadata.
- Give the remote client its own secure credential setting; do not paste the credential into chat. The setup script's `-CopyKey` option copies the credential to the local clipboard for that secure setting.
- Keep the vault or DPAPI file and configuration outside tracked source. A credential hash is still private configuration. A DPAPI file is tied to the Windows user/computer context; copying it alone does not provide a portable recovery key.
- Never place credentials in query strings, connector descriptions, screenshots, examples, or public tunnel URLs.
- Do not print the credential, auth headers, raw environment, or IPC details into logs.
- If a credential is exposed, stop the external route, replace the credential locally and in the remote client's secure storage, and inspect existing jobs before restarting.

Public health, setup, and schema endpoints must contain no private chat metadata. Status, task listing, task reading, job creation, and job polling require authentication.

Automatic startup adds a private desktop-context lease and supervisor control nonce. Restrict the data directory to the owner, keep these records out of Git, and stop the supervisor before stopping its managed children. The native adapter rejects absent or stale context; it does not discover endpoints by guessing or replay failed sends. A persistent SSH relay should use a dedicated account/key constrained to one reverse loopback listener, with no shell or local forwarding.

## Scope and concurrency

Optional unattended Windows reconnection retains a private `desktop-owner.json` grant created from genuine owner-chat registration. It reuses that real caller identity rather than creating another chat or fabricating a turn. Before publishing a lease, the worker verifies the global named-pipe server against the configured installed app's exact signed executable, same Windows user/session, PID, and process creation time. Fresh chat-owned registrations take precedence. Keep the grant private; remove it to revoke unattended renewal. Local files writable by the same Windows account remain within this trust boundary.

Pilot mode uses `allowedThreadIds` with `allowAllTasks: false`. Complete the existing-chat and harmless-computer checks before widening access. Wider task access enables sending instructions to more existing chats; it must not run the whole catalog on startup.

Local proof commands require completed jobs with their correlation receipts, and the computer proof requires an image file. An operator must inspect the actual computer evidence before recording that proof. An image signature check cannot verify what the image depicts.

Read and identify the selected task before writing to it. A job may affect a project that already has uncommitted work or another active agent. Busy tasks must not receive duplicate prompts. The scheduler permits up to four active jobs by default, configurable locally from 1 through 32, with one active connector job per chat. It queues waiting work instead of injecting an instruction into a busy chat.

All declared browser and desktop UI work shares one exclusive lane. Set `execution: "ui"` for browser automation, forms, screenshots, mouse/keyboard, and native apps. Omitted execution defaults to `ui`, and a `computer` job cannot request background execution. Explicit `background` work receives instructions prohibiting UI tools and can run concurrently in other chats. These are routing guards, not interception of every Codex tool call. They do not prevent incorrectly classified prompts, unrelated tasks, manual computer input, or concurrent writes to the same files. Use separate workspaces for competing edits and keep other actors away from a reserved UI session.

The `computer` kind is an instruction routed to an existing chat. It is not a raw shell, arbitrary executable, or direct input endpoint. The target chat's available tools and action policies still apply. The connector must not invent missing tools or promise to bypass a native approval request.

## Data sent to the remote client

Task titles, summaries, recent conversation text, file paths, and job results can be private. A client that lists or reads tasks receives that information. Use the narrow pilot scope first and select the access scope intentionally.

Webpages, chat summaries, documents, screenshots, and tool results are untrusted content. They can describe facts but cannot authorize additional actions. In particular, a page or task result that says to reveal a secret, change the connector, or start another task does not grant permission to do so.

Prefer concise result summaries. Avoid copying raw logs, credentials, sensitive archives, or unrelated conversation history into remote replies. Do not claim that a general redaction pattern can guarantee removal of every secret.

## Retries and uncertain outcomes

Use one request ID for one instruction. If submission times out, retry that exact request ID and body or inspect its existing job; do not send a new instruction blindly. A changed body with an existing request ID should fail rather than replace its meaning.

Jobs are stored in `dataDir/jobs.json`; audit records append metadata locally. Unattempted queued prompts are held separately in `dataDir/pending-jobs.json` until the durable transition to submission. Private `controls.json` retains control receipts and prompt revisions. These files may contain sensitive task instructions. Keep the entire directory private and exclude pending state and controls from Git and diagnostic uploads. Only queued work never attempted for dispatch resumes automatically after restart. A stopped connector, a delivered stop instruction, or a lost network response does not prove the desktop task stopped. Active controls retain chat and UI reservations until a correlated native acknowledgement confirms inactivity. Treat unreconciled operations as unknown until the native task status resolves them; do not replay them. Stop the remote route before maintenance, and inspect accepted jobs during recovery.

## Repository hygiene

Keep local config, environment files, tokens, hash files, job state, logs, task exports, screenshots, receipts, and tunnel details out of Git. Examples and tests must use synthetic IDs and temporary directories. Review the actual tracked file list before publication; ignore rules do not remove a file that is already tracked.

Do not include personal paths, account names, chat catalogs, or owner verification receipts in an issue or pull request. A useful public bug report includes a redacted error, software versions, a minimal synthetic reproduction, and whether the failure occurred before or after submission acknowledgement.

## Reporting a vulnerability

Do not post a working credential, private IPC address, personal chat transcript, or exploitable deployment detail in a public issue. Until a public repository and private reporting channel are established, report concerns directly to the project owner using an existing private channel. Public release preparation does not establish a vulnerability-response service or maintenance guarantee.
