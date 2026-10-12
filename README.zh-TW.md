# omp-remote-command

一個 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）套件：讓聊天頻道裡的人能叫 omp 做事，但不讓頻道決定 omp 聽誰的。它分兩半：omp 用 `-e` 載入的擴充，以及一座橋。橋用 stdio 把 omp 當成子程序啟動，站在頻道和 omp 中間。

[English](README.md)

> **聊天端是模擬的。** 這個套件沒有附任何真的聊天平台轉接器。測試用 `SimulatedChat` 驅動橋，它的使用者 ID 是測試程式給什麼就是什麼。要接真的平台（Slack、Telegram、飛書……），得自己寫一個轉接器：驗過平台的簽章或連線，只把平台驗過的使用者 ID 交給橋。見〈[寫一個聊天轉接器](#寫一個聊天轉接器)〉。

## 為什麼

omp 的 RPC 模式把能寫進 stdin 的都當成你。它不知道是誰在叫它：核准的題目誰先回答就算誰的，RPC 的 `bash` 指令不經模型、不經核准就直接跑。所以寫進 omp stdin 的那支程式，就是信任邊界。這個套件讓那支程式驗是誰、只轉一句話、每一道核准題只問一位具名的擁有者；也在 omp 裡把側門鎖上，橋有 bug 時還擋得住。

## 哪一段在哪裡跑

| 在哪裡 | 檔案 | 做什麼 |
|---|---|---|
| omp 裡（`-e`） | `src/index.ts` | **側門：** RPC 的 `bash` 只放行 `git status --short` 和 `git log --oneline -5`，其他一律回結束碼 126，不執行。這個處理器從不丟錯，因為 `user_bash` 的處理器一丟錯，omp 就照跑那行指令。**啟動鎖：** omp 的設定不適合遠端使用時，每一個工具呼叫都擋下，session 開始時也發一則通知。 |
| 橋（omp 之外） | `src/bridge.ts`、`src/policy.ts` | 啟動 omp、決定什麼能送進去、把它的題目轉給擁有者、把回覆貼回頻道、寫稽核紀錄。 |
| 聊天端 | `src/chat.ts` | 轉接器介面、webhook 簽章檢查、`SimulatedChat`。 |

「適合遠端使用」指的是：`tools.approvalMode` 是 `always-ask`；指令列上沒有 `--yolo` 或 `--auto-approve`；`tools.approval.<工具>` 和 `bash.patterns` 都沒有寫 `allow` 的規則（任一條都會讓呼叫不經擁有者就執行）；`collab.autoStart` 是 `off`。

## 流程

1. **進門。** 轉接器把頻道訊息連同平台的使用者 ID 交給橋。橋每收到一則訊息就重讀一次名單檔，所以把人從名單拿掉，他的下一則訊息就進不去。不在名單上的人，訊息不轉，也不回覆。第一個非空白字元是 `/` 的訊息不轉（omp 會把它當成斜線指令執行，例如 `/collab`）。上一件事還在跑時，什麼都不轉，所以有人在頻道裡打 `Approve` 也回答不了任何題目。
2. **轉送。** 橋寫進 omp 的只有兩種：以訊息原文當內容的 `prompt`，以及對 omp 對話框的回答。看起來像 RPC 指令的訊息（`{"type":"bash",...}`）也只是一句 prompt 的內容。
3. **動手前。** omp 以 `always-ask` 執行，所以寫檔、shell、派 subagent 都會回到橋這邊，成為一道標題是 `Allow tool: <工具>` 的題目。
   - 橋把題目對到 omp 在發問前剛回報的那一個工具呼叫（`tool_execution_start`）。完整參數就是從那裡來的：omp 自己的 bash 題目只有指令那一行，不含 `cwd`、`timeout`、`pty`、`async`。
   - 然後私下問擁有者，附上是誰要求的、頻道原話、工具、完整參數、omp 的題目原文和時限。
   - 只認擁有者對這一題的第一個回答。別人回的、回答舊題目的、第二次回答，一律不算，並記下來。
   - 時限內沒回，橋自己回 Deny，並在頻道告訴要求的人。
   - 對不到唯一一個工具呼叫的題目，橋直接回 Deny，不問任何人。
   - 其他對話框（`confirm`、`input`、`editor`，以及不是工具核准的選擇題，例如模型的 `ask` 工具）一律取消。
4. **側門。** 橋從不送 `bash`。就算送了，擴充的側門檢查也會擋下。
5. **回報與紀錄。** 這一輪結束時，把最後一則助理訊息貼在原訊息底下。稽核紀錄記下每一則訊息（誰、何時、原話、轉不轉、原因）和每一道題目（工具呼叫、完整參數、誰要求、誰回答、答什麼、有沒有逾時）。

**`/collab`。** omp 的 collab 連結是不經過橋的另一個入口：拿到完整連結的人能操作 session，也能回答它的題目。橋啟動的 omp 設了 `collab.autoStart: off`，橋也從不轉 `/collab`。如果你想用手機回答自己終端機裡那個 omp 的題目，那是另一件工具（例如 omp-session-gateway），不在這個套件裡。要分享，只給 view 連結。

## 需求

- omp 18.2.8 以上（以 18.2.8 測試）
- Bun 1.3.14 以上（以 1.4.2 測試）
- 一個 omp 在 RPC 模式下能用的模型 provider，金鑰放在橋的環境變數裡

## 名單檔

橋讀一份 JSON 名單檔，要放在工作目錄之外（否則橋不啟動）。範例見 [`examples/policy.example.json`](examples/policy.example.json)。

| 欄位 | 意思 |
|---|---|
| `owner` | 回答 omp 題目的那一位，填平台的使用者 ID。必填；不接受 `*`。 |
| `allowlist` | 可以叫 omp 做事的平台使用者 ID。必填、不能空白；不接受 `*`。 |
| `ownerTimeoutMs` | 題目等擁有者多久，逾時橋就回 Deny。預設 120000。 |
| `workdir` | omp 工作的專案（絕對路徑）。 |
| `auditLog` | JSONL 稽核紀錄（絕對路徑，要在 `workdir` 之外）。 |
| `omp.command` | 怎麼執行 omp，例如 `["omp"]` 或 `["bun", "/path/to/cli.ts"]`。 |
| `omp.model`、`omp.thinking` | 當作 `--model` 和 `--thinking` 傳入。 |
| `omp.extensions` | 模型 provider 的擴充，在這個套件之前用 `-e` 載入。 |
| `omp.tools` | 當作 `--tools` 傳入。只給頻道用得到的；不需要 subagent 就別給 `task`。 |
| `omp.toolRules` | 產生的設定檔裡的 `tools.approval`：每個工具 `prompt` 或 `deny`，不接受 `allow`。沒寫時，`omp.tools` 裡唯讀以外的工具都是 `prompt`。 |
| `omp.bashPatterns` | 產生的設定檔裡的 `bash.patterns`：`{ "match": "...", "approval": "prompt" | "deny" }`，不接受 `allow`。 |
| `omp.env` | 要給 omp 的環境變數名稱，例如模型金鑰。omp 只拿得到這些，加上 `PATH`、`HOME`、`USER`、`LANG`、`TERM`，橋自己的祕密留在橋。 |
| `omp.sessionDir` | 當作 `--session-dir` 傳入（要在 `workdir` 之外）。 |

`owner`、`allowlist`、`ownerTimeoutMs` 從下一則訊息起生效；`omp.*` 和 `auditLog` 要等橋下次啟動才生效。

橋這樣啟動 omp，並產生一份 `--config`，裡面是 `tools.approvalMode: always-ask`、你的工具規則與 bash 樣式，以及 `collab.autoStart: off`：

```text
<omp.command> --mode rpc --cwd <workdir> --no-extensions -e <provider 擴充>… -e <這個套件>
  --config <產生的設定檔> --approval-mode always-ask --tools <工具> --model <模型>
  [--thinking <等級>] [--session-dir <目錄>] --no-title --no-lsp --no-skills --no-rules
```

## 啟動橋

```ts
import { Bridge } from "./omp-remote-command/src/bridge.ts";
import { SimulatedChat } from "./omp-remote-command/src/chat.ts";

const chat = new SimulatedChat(); // 換成你的平台轉接器
const bridge = await Bridge.start({ policyPath: "/etc/omp-remote-command/policy.json", chat });

chat.onQuestion = (owner, question) => console.log(owner, question.tool, question.args);
await chat.say("U034TEAMMATE", "Run the unit tests and tell me what fails.");
// 之後：await chat.answer("U012OWNER", questionId, "Approve");

await bridge.whenIdle();
await bridge.stop();
```

名單檔不合格時，`Bridge.start` 丟出 `PolicyError`，列出每一個問題，而且什麼都不啟動。

## 寫一個聊天轉接器

轉接器實作 `src/chat.ts` 的 `ChatAdapter`：

```ts
interface ChatAdapter {
	start(handlers: ChatHandlers): Promise<void>;
	postToChannel(channelId: string, text: string, replyTo?: string): Promise<void>;
	askOwner(ownerId: string, question: OwnerQuestion): Promise<void>;
	stop(): Promise<void>;
}
```

- 只對平台證明過的事件呼叫 `handlers.onChannelMessage`：驗 webhook 的簽章（Slack 式的簽章就用 `verifyWebhookSignature`），或用平台自己驗過身分的連線。傳平台的使用者 ID，不要傳顯示名稱，也不要用訊息裡自稱的名字。
- `askOwner` 要私下送達，例如一則附 Approve、Deny 按鈕的私訊，按鈕帶著 `questionId`。
- 用按下按鈕那個人的、平台驗過的 ID 呼叫 `handlers.onOwnerAnswer`。是不是擁有者由橋判斷，不是轉接器。
- 別讓外人知道 bot 存在：橋從不要求轉接器回覆他們。

## 擁有者收到的題目

| 欄位 | 內容 |
|---|---|
| `questionId` | 隨機產生；回答這一題的唯一方式。 |
| `toolCallId`、`tool`、`args` | 這個工具呼叫，以及 omp 回報的完整參數。 |
| `requester`、`channelId`、`messageId`、`requestText` | 誰要求的、在哪裡、引出這一題的那則訊息。 |
| `ompTitle` | omp 自己的題目原文（`Allow tool: …`）。 |
| `deadline` | ISO 時間；過了這個時間橋就回 Deny。 |

## 稽核紀錄

一行一個 JSON 物件，每個都有 `ts` 和 `event`：

| `event` | 記下什麼 |
|---|---|
| `start` | omp 的指令列、它拿到的環境變數名稱、擁有者、名單人數、工具 |
| `message` | `from`、`channel`、`messageId`、`text`、`forwarded`、`reason` |
| `question_asked` | `questionId`、`toolCallId`、`tool`、`args`、`requester`、`requestText`、`owner`、`deadline` |
| `question_settled` | `questionId`、`answer`、`answeredBy`、`timedOut`、`bound`（題目對不到唯一工具呼叫時為 `false`）、`reason` |
| `answer_ignored` | 擁有者以外的人回答的、回答未知或已結束題目的、答案不是 Approve 或 Deny 的 |
| `dialog_cancelled`、`omp_notice`、`turn_end`、`omp_exit`、`extension_error`、`post_failed` | 如名稱所示 |

## 測試

```bash
bun test
```

單元測試不需要網路：擴充透過 omp 自己的 loader 和 runner 載入，橋則驅動一支冒充 omp 的程式（`test/fake-omp.ts`），它是真的子程序。

`test/live.test.ts` 接真的 omp，要另外開啟。用到模型的情境會消耗你模型 provider 的額度。

```bash
REMOTE_COMMAND_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
  OMP_MODEL_EXTENSION=/path/to/model-provider-extension OMP_MODEL=cursor-sdk/claude-opus-5-5 \
  CURSOR_API_KEY=... bun test test/live.test.ts
```

裝好的 omp 用 `OMP_BIN` 取代 `OMP_CLI`；金鑰不在 `CURSOR_API_KEY` 就設 `OMP_MODEL_KEY_ENV`；要保留每個情境的紀錄就設 `REMOTE_COMMAND_LIVE_OUT=<資料夾>`。

## 還做不到的

- omp 本身仍不知道是誰在叫它。橋是邊界；其他寫得進 omp stdin 的東西，照樣被信任。
- `always-ask` 仍讓唯讀工具不問就跑，名單上的人可以請 omp 讀一個檔，再貼回頻道。祕密別放在工作目錄裡，或把 omp 放進容器。
- 核准過的 shell 指令，保有 shell 原本的全部權限：`bash.patterns` 決定要不要問，管不到指令碰得到什麼。寫得夠繞的指令，做的事可能比看起來多。
- 同一個工具同時有兩個待核准的呼叫時，分不出哪道題對哪個，橋兩題都回 Deny。
- omp 自己不設時限。題目還開著時橋停了，那一輪會一直等到 omp 結束。
- `--no-extensions` 讓 omp 不載入專案的擴充，但專案的 `.omp/tools` 照樣載入。這一部分只能信任工作目錄。
- 模型的 shell 讀得到 omp 執行時拿到的模型金鑰。
- 稽核紀錄是普通檔案，不防竄改。
- subagent 以 `tools.approvalMode: yolo` 執行，裡面只有明確寫出的逐項規則生效（`prompt` 在那裡直接被拒，`deny` 直接擋）。把 `task` 加進 `omp.tools` 的話，要替 subagent 不該用的工具寫 `deny`。
- 沒有附真的聊天平台轉接器。
