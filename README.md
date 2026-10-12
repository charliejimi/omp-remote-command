# omp-remote-command

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) package for letting people in a chat channel ask omp to do work, without letting the channel decide who omp obeys. It has two parts: an extension that omp loads with `-e`, and a bridge that starts omp as its child over stdio and sits between the channel and omp.

[中文說明](README.zh-TW.md)

> **The chat side is simulated.** This package includes no real chat platform adapter. The tests drive the bridge with `SimulatedChat`, whose user IDs are whatever the test passes. To use a real platform (Slack, Telegram, Feishu, …) you write an adapter that verifies the platform's signature or connection and hands the bridge only platform-verified user IDs. See [Writing a chat adapter](#writing-a-chat-adapter).

## Why

omp in RPC mode treats whatever writes to its stdin as you. It has no caller identity: an approval question goes to whoever answers it first, and the RPC `bash` command runs a shell command without the model and without the approval gate. So the program that writes to omp's stdin is the trust boundary. This package makes that program check who is asking, forward only a prompt, and put every approval to one named owner, and it locks the side door inside omp in case the bridge has a bug.

## What runs where

| Where | File | What it does |
|---|---|---|
| Inside omp (`-e`) | `src/index.ts` | **Side door:** the RPC `bash` command runs only `git status --short` and `git log --oneline -5`; anything else gets exit code 126 and does not run. The handler never throws, because omp runs the command when a `user_bash` handler throws. **Startup lock:** if omp is not set up for remote use, every tool call is blocked and a notice is sent at session start. |
| Bridge (outside omp) | `src/bridge.ts`, `src/policy.ts` | Starts omp, decides what reaches it, routes its questions to the owner, posts replies back, and writes the audit log. |
| Chat side | `src/chat.ts` | The adapter interface, a webhook signature check, and `SimulatedChat`. |

"Set up for remote use" means: `tools.approvalMode` is `always-ask`; neither `--yolo` nor `--auto-approve` is on the command line; no `tools.approval.<tool>` rule and no `bash.patterns` rule is `allow` (either would let a call run without the owner); and `collab.autoStart` is `off`.

## The flow

1. **Entry.** The adapter delivers a channel message with the platform's user ID. The bridge re-reads the policy file for every message, so removing someone takes effect on their next message. A sender not on the allowlist gets nothing forwarded and no reply. A message whose first non-blank character is `/` is not forwarded (omp would run it as a slash command, such as `/collab`). While a request is running, nothing is forwarded, so an `Approve` typed into the channel cannot answer anything.
2. **Forwarding.** The bridge writes only two kinds of frames to omp: a `prompt` whose text is the message, and answers to omp's dialogs. A message that looks like an RPC frame (`{"type":"bash",...}`) is just the text of a prompt.
3. **Before action.** omp runs `always-ask`, so writes, shell commands, and subagent dispatches each come back as a question titled `Allow tool: <name>`.
   - The bridge matches the question to the one tool call omp reported just before asking (`tool_execution_start`). That is where the full arguments come from: omp's own bash question shows only the command, not `cwd`, `timeout`, `pty`, or `async`.
   - It then asks the owner privately, with who asked, the channel message, the tool, the full arguments, omp's question text, and a deadline.
   - Only the owner's first answer to that question counts. Answers from anyone else, answers to an old question, and second answers are ignored and logged.
   - With no answer by the deadline, the bridge answers Deny and tells the requester in the channel.
   - A question that cannot be matched to exactly one tool call is answered Deny without asking anyone.
   - Every other dialog (`confirm`, `input`, `editor`, and selects that are not tool approvals, such as the model's `ask` tool) is cancelled.
4. **Side door.** The bridge never sends `bash`. If it did, the extension's side-door gate would still block it.
5. **Report and record.** When the turn ends, the last assistant message is posted under the request. The audit log records every message (who, when, the text, forwarded or not, and why) and every question (the tool call, the full arguments, who asked, who answered, the answer, and whether it timed out).

**`/collab`.** omp's collab link is a second way in that does not pass through the bridge: whoever holds a full link can steer the session and answer its questions. The bridge's omp runs with `collab.autoStart: off`, and the bridge never forwards `/collab`. If you want to answer questions for an omp session in your own terminal from your phone, that is a different tool (for example omp-session-gateway); it is not part of this package. Share only view links.

## Requirements

- omp 18.2.8 or later (tested with 18.2.8)
- Bun 1.3.14 or later (tested with 1.4.2)
- A model provider omp can use in RPC mode, and its key in the bridge's environment

## The policy file

The bridge reads a JSON policy, kept outside the work tree (the bridge refuses to start otherwise). See [`examples/policy.example.json`](examples/policy.example.json).

| Field | Meaning |
|---|---|
| `owner` | The one platform user ID that answers omp's questions. Required; `*` is refused. |
| `allowlist` | Platform user IDs that may send requests. Required and non-empty; `*` is refused. |
| `ownerTimeoutMs` | How long a question waits for the owner before the bridge answers Deny. Default 120000. |
| `workdir` | The project omp works in (absolute path). |
| `auditLog` | The JSONL audit log (absolute path, outside `workdir`). |
| `omp.command` | How to run omp, e.g. `["omp"]` or `["bun", "/path/to/cli.ts"]`. |
| `omp.model`, `omp.thinking` | Passed as `--model` and `--thinking`. |
| `omp.extensions` | Model provider extensions, loaded with `-e` before this package. |
| `omp.tools` | Passed as `--tools`. Give only what the channel needs; leave out `task` unless you want subagents. |
| `omp.toolRules` | `tools.approval` for the generated config: `prompt` or `deny` per tool. `allow` is refused. Defaults to `prompt` for every tool in `omp.tools` except read-only ones. |
| `omp.bashPatterns` | `bash.patterns` for the generated config: `{ "match": "...", "approval": "prompt" | "deny" }`. `allow` is refused. |
| `omp.env` | Names of environment variables omp gets, such as the model key. omp gets only these and `PATH`, `HOME`, `USER`, `LANG`, and `TERM`, so the bridge's own secrets stay with the bridge. |
| `omp.sessionDir` | Passed as `--session-dir` (outside `workdir`). |

`owner`, `allowlist`, and `ownerTimeoutMs` take effect on the next message. The `omp.*` fields and `auditLog` take effect the next time the bridge starts.

The bridge starts omp like this, with a generated `--config` that sets `tools.approvalMode: always-ask`, your tool rules and bash patterns, and `collab.autoStart: off`:

```text
<omp.command> --mode rpc --cwd <workdir> --no-extensions -e <provider extension>… -e <this package>
  --config <generated config> --approval-mode always-ask --tools <tools> --model <model>
  [--thinking <level>] [--session-dir <dir>] --no-title --no-lsp --no-skills --no-rules
```

## Starting the bridge

```ts
import { Bridge } from "./omp-remote-command/src/bridge.ts";
import { SimulatedChat } from "./omp-remote-command/src/chat.ts";

const chat = new SimulatedChat(); // replace with your platform adapter
const bridge = await Bridge.start({ policyPath: "/etc/omp-remote-command/policy.json", chat });

chat.onQuestion = (owner, question) => console.log(owner, question.tool, question.args);
await chat.say("U034TEAMMATE", "Run the unit tests and tell me what fails.");
// later: await chat.answer("U012OWNER", questionId, "Approve");

await bridge.whenIdle();
await bridge.stop();
```

`Bridge.start` throws a `PolicyError` listing every problem when the policy is invalid, and then starts nothing.

## Writing a chat adapter

An adapter implements `ChatAdapter` from `src/chat.ts`:

```ts
interface ChatAdapter {
	start(handlers: ChatHandlers): Promise<void>;
	postToChannel(channelId: string, text: string, replyTo?: string): Promise<void>;
	askOwner(ownerId: string, question: OwnerQuestion): Promise<void>;
	stop(): Promise<void>;
}
```

- Call `handlers.onChannelMessage` only for events the platform proved: verify a webhook's signature (Slack-style signing is `verifyWebhookSignature`), or use the platform's own authenticated connection. Pass the platform's user ID, never a display name or a name claimed in the message.
- Deliver `askOwner` privately, for example as a direct message with Approve and Deny buttons that carry `questionId`.
- Call `handlers.onOwnerAnswer` with the platform-verified ID of whoever pressed the button. The bridge, not the adapter, decides whether that person is the owner.
- Do not tell outsiders that the bot exists: the bridge never asks the adapter to reply to them.

## The owner's question

| Field | Content |
|---|---|
| `questionId` | Random; the only way to answer this question. |
| `toolCallId`, `tool`, `args` | The tool call, with its complete arguments as omp reported them. |
| `requester`, `channelId`, `messageId`, `requestText` | Who asked, where, and the message that led here. |
| `ompTitle` | omp's own question text (`Allow tool: …`). |
| `deadline` | ISO time after which the bridge answers Deny. |

## Audit log

One JSON object per line, each with `ts` and `event`:

| `event` | Recorded |
|---|---|
| `start` | omp's command line, the names of the variables it got, the owner, the allowlist size, the tools |
| `message` | `from`, `channel`, `messageId`, `text`, `forwarded`, `reason` |
| `question_asked` | `questionId`, `toolCallId`, `tool`, `args`, `requester`, `requestText`, `owner`, `deadline` |
| `question_settled` | `questionId`, `answer`, `answeredBy`, `timedOut`, `bound` (`false` when the question matched no single tool call), `reason` |
| `answer_ignored` | An answer from someone other than the owner, to an unknown or settled question, or other than Approve/Deny |
| `dialog_cancelled`, `omp_notice`, `turn_end`, `omp_exit`, `extension_error`, `post_failed` | What the names say |

## Tests

```bash
bun test
```

The unit tests need no network: the extension is loaded through omp's own loader and runner, and the bridge drives a stand-in omp (`test/fake-omp.ts`) as a real child process.

`test/live.test.ts` runs against real omp and is opt-in. The model scenarios use your model provider's quota.

```bash
REMOTE_COMMAND_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
  OMP_MODEL_EXTENSION=/path/to/model-provider-extension OMP_MODEL=cursor-sdk/claude-opus-5-5 \
  CURSOR_API_KEY=... bun test test/live.test.ts
```

Use `OMP_BIN` instead of `OMP_CLI` for an installed omp, `OMP_MODEL_KEY_ENV` if the key is not in `CURSOR_API_KEY`, and `REMOTE_COMMAND_LIVE_OUT=<folder>` to keep the evidence of each scenario.

## Limits

- omp itself still has no caller identity. The bridge is the boundary; anything else that can write to omp's stdin is trusted as before.
- `always-ask` still lets read-only tools run without a question, so someone on the allowlist can ask omp to read a file and post it to the channel. Keep secrets out of the work tree, or run omp in a container.
- An approved shell command keeps the shell's full power: `bash.patterns` decides what is asked, not what the command can reach. A command written to look harmless can still do more than it shows.
- Two pending calls of the same tool cannot be told apart, so the bridge denies both questions.
- omp sets no deadline of its own. If the bridge stops while a question is open, that turn waits until omp exits.
- `--no-extensions` keeps omp from loading a project's extensions, but a project's `.omp/tools` still load. Trust the work tree for that part.
- The model's shell can read the model key omp runs with.
- The audit log is a plain file, not tamper-evident.
- Subagents run with `tools.approvalMode: yolo`; only explicit per-tool rules apply inside them (`prompt` is refused there, `deny` blocks). If you add `task` to `omp.tools`, write `deny` rules for the tools subagents must not use.
- No real chat platform adapter is included.
