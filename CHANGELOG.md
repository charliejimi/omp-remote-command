# Changelog

## [0.1.0] - 2026-10-12

### Added

- Extension: the RPC `bash` side door runs only `git status --short` and `git log --oneline -5`; anything else gets exit code 126 without running, and the handler never throws.
- Extension: every tool call is blocked, with a notice at session start, when omp is not set up for remote use (an approval mode other than `always-ask`, `--yolo` or `--auto-approve`, an `allow` rule in `tools.approval` or `bash.patterns`, or collab auto-start on).
- Bridge: starts omp in RPC mode with `always-ask`, the policy's tools, `--no-extensions`, a generated settings overlay with collab off, and only the named environment variables.
- Bridge: forwards only messages from allowlisted platform user IDs, never a slash command, one request at a time, and only as the text of a prompt; the policy is re-read for every message.
- Bridge: binds each tool approval to the tool call omp reported before asking, and asks the owner privately with the requester, the channel message, the full arguments, and a deadline; only the owner's first answer counts; the bridge answers Deny at the deadline or when a question matches no single tool call; every other dialog is cancelled.
- Bridge: posts the reply under the request and writes a JSONL audit log of every message, question, and ignored answer.
- Chat side: the adapter interface, Slack-style webhook signature verification, and a simulated chat for tests. No real platform adapter is included.
- Tests through omp's extension loader and runner, a stand-in omp child process, and opt-in live tests against real omp.
