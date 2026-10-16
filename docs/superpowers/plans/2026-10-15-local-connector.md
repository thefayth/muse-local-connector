# Muse Local Connector Implementation Plan

> For agentic workers: implement the accepted design with the current delegated backend, documentation, scripts, and primary gateway workstreams. Use tests before implementation and independently review the result.

**Goal:** Let an authenticated assistant continue existing desktop chats and request local computer work.

**Architecture:** A loopback JSON API delegates allowlisted operations to the desktop's installed stdio MCP server. A read-only local catalog expands task discovery; all mutations retain the desktop task router. Private runtime state and optional HTTPS tunneling stay outside the shareable source.

**Tech Stack:** Node 22 built-ins, PowerShell startup scripts, installed Codex desktop tools.

**Spec:** ../../design.md

## Global constraints

- Preserve existing chat IDs, project rules, app permissions, and original files.
- Never put credentials or owner chat data in source or audit logs.
- Verify one existing chat and one computer action before expanding.
- Publish only after the owner's working-for-me gate is established.

## Review focus

- Missing or incorrect credentials must not reach desktop tools.
- Repeated or uncertain submissions must not duplicate work.
- Concurrent jobs must not share a chat or foreground computer input.
- Desktop reconnects and unsupported backends must fail clearly.
- Public source must contain no runtime state, paths, receipts, or credentials.

## Tasks

1. [x] Create gateway tests in test/server.test.mjs; run and observe failure. Implement src/server.mjs, then run the full test command.
2. [x] Test desktop transport errors, metadata, and allowlisted calls. Implement src/desktop-backend.mjs and read-only src/local-catalog.mjs. Probe existing chat reads.
3. [x] Implement src/cli.mjs and Windows setup/start/stop scripts. Verify loopback authentication and private persistence without leaking the credential.
4. [x] Run a nonce-based job in one idle existing chat, inspect same-chat reply, then run a Calculator action and inspect the visual evidence. Store private receipts and proof records.
5. [x] Local expansion and authenticated HTTPS checks passed after both proofs. Connected Muse through its secure credential flow and repeated existing-chat and computer checks from Muse itself.
6. [x] Reviewed source/tests/docs/license and scanned the tracked source for private information. Prepared the public GitHub package after the owner's verification condition was met.
