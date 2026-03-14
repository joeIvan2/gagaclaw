<p align="center">
  <img src="gagaclaw_logo.png" alt="Gagaclaw" width="280">
</p>

<h1 align="center">Gagaclaw v1.4.1</h1>

> **The remote controller for your Antigravity.**

> Supports **Windows**, **Linux**, and **macOS** (including Docker) with [Antigravity IDE](https://www.antigravity.so).

**Gagaclaw** is a bridge layer that connects messaging platforms (Telegram, Discord, CLI) to [Antigravity IDE](https://www.antigravity.so), turning it into a remotely controllable AI agent.

It intercepts Antigravity's internal communication via Chrome DevTools Protocol (CDP), allowing you to send prompts, receive streamed responses, approve tool permissions, and manage sessions — all from your phone or terminal.

## Features

- **Telegram Bot** — Full-featured bot with inline keyboard buttons, streaming responses, file upload/download, and command autocomplete
- **Discord Bot** — Per-channel or per-thread sessions, mention/reply routing, permission buttons, image intake, restart support, and cron execution
- **CLI Interface** — Terminal-based interactive session with colored output
- **Multi-Instance / Multi-Cascade** — One Telegram chat, Discord channel/thread, or CLI session can map to one instance and its own `cascadeId`
- **Multi-Model Support** — Switch between Gemini, Claude, and GPT models on the fly
- **Cron Scheduler** — Schedule recurring AI tasks with customizable model/mode per job
- **Per-Instance Bootstrap** — Each instance can inject a one-time `bootstrapPrompt` on the first message and a `messageHeader` on every message
- **MCP Server** — Includes `gagaclaw_recommend_mcp` for Groq audio transcription, Telegram file sending, and Discord REST tools
- **Permission System** — Inline keyboard approval/denial for tool calls, with optional YOLO auto-approve mode
- **Workspace System** — Separate workspaces such as `workspace/` and `workspace-discord-bot/` with per-workspace `soul.md` and `memory.md`

## Requirements

- Windows 10/11, Linux (Ubuntu 20.04+, Debian 11+, etc.), or macOS
- [Node.js](https://nodejs.org/) 18+
- [Antigravity IDE](https://www.antigravity.so)
- A Telegram bot token and/or a Discord bot token
- (Optional) [Groq API key](https://console.groq.com/keys) for audio transcription

## Configuration

`gagaclaw.json` fields:

| Field | Description |
|---|---|
| `telegram.token` | Bot token from [@BotFather](https://t.me/BotFather) |
| `telegram.allowedUsers` | Array of authorized Telegram user IDs (first entry is also used as admin chat for MCP/cron notifications) |
| `app.name` | IDE application name |
| `app.targetExecutables` | Process names to detect |
| `activeWorkspace` | Active workspace folder name |
| `yoloMode` | `true` = auto-approve all tool calls, `false` = ask for approval |
| `groq.apiKey` | Groq API key for audio transcription (optional) |
| `defaults.model` | Model ID (e.g. `MODEL_PLACEHOLDER_M37`). Must use full ID, not shorthand keys. See `MODELS` in core.js for available IDs. |
| `defaults.mode` | `planning` or `fast` |
| `defaults.agentic` | Enable tool usage by default |
| `defaults.cdpPorts` | Chrome DevTools Protocol ports to connect |
| `defaults.cdpHost` | CDP host address |
| `bootstrapPrompt` | Sent once on the first user message of a brand-new conversation for that instance |
| `messageHeader` | Short header prepended to every user message for that instance |

Multi-instance config is supported via `instances`. This is the recommended way to keep one conversation bound to one instance and one `cascadeId`:

```json
{
  "app": { "name": "Antigravity" },
  "groq": { "apiKey": "..." },
  "defaultInstance": "telegram-agent",
  "instances": {
    "telegram-agent": {
      "telegram": { "token": "..." },
      "activeWorkspace": "workspace",
      "messageHeader": "[instance=telegram-agent workspace=workspace]",
      "bootstrapPrompt": "You are the `telegram-agent` instance. Use `workspace` as the primary workspace for this conversation.",
      "defaults": { "cdpPorts": [9229] }
    },
    "discord-bot": {
      "discord": { "token": "..." },
      "activeWorkspace": "workspace-discord-bot",
      "messageHeader": "[instance=discord-bot workspace=workspace-discord-bot]",
      "bootstrapPrompt": "You are the `discord-bot` instance. Use `workspace-discord-bot` as the primary workspace for this conversation.",
      "defaults": { "cdpPorts": [9229] }
    }
  }
}
```

Run a specific instance with:

```bash
node telegram.js telegram-agent
node discord.js discord-bot
node cli.js telegram-agent
```

Recommended pattern:

- `telegram-agent` -> Telegram bot + `workspace/`
- `discord-bot` -> Discord bot + `workspace-discord-bot/`
- Each chat/channel/thread keeps its own active `cascadeId`

`rules.md` is no longer required for runtime workspace switching. Prefer per-instance `bootstrapPrompt`, `messageHeader`, and workspace-local `soul.md` / `memory.md`.

## Setup

Jump to the [One-Click AI Setup](#one-click-ai-setup) section at the bottom — open a fresh Antigravity workspace, paste the prompt, and the AI handles everything (clone, install, configure, MCP registration).

## Telegram Commands

| Command | Description |
|---|---|
| `/help` | Show help |
| `/new` | Start new conversation |
| `/stop` | Stop current response |
| `/list` | List conversations (with switch/delete buttons) |
| `/model` | Switch AI model (inline keyboard) |
| `/mode` | Switch mode — planning / fast |
| `/agentic` | Toggle tool usage ON/OFF |
| `/yolo` | Toggle auto-approve ON/OFF |
| `/ws` | Switch workspace |
| `/cron` | Manage scheduled tasks |
| `/restart` | Warm or cold restart |

All commands support both inline keyboard buttons (tap to select) and text arguments (e.g., `/model flash`).

## Discord Commands

Use mention/reply form in guild channels, for example `@bot !new`.

| Command | Description |
|---|---|
| `!help` | Show help |
| `!new` | Start new conversation for the current channel/thread |
| `!list` | List conversations |
| `!switch <n>` | Switch the current channel/thread to another conversation |
| `!delete <n>` | Delete a conversation |
| `!cron` | List cron jobs |
| `!cron on <id>` | Enable a cron job |
| `!cron off <id>` | Disable a cron job |
| `!restart [cold]` | Warm or cold restart |

## Cron Jobs

Gagaclaw can run scheduled AI tasks automatically. Copy the example and edit:

```bash
cp cronjobs.example.json cronjobs.json
```

Example job in `cronjobs.json`:

```json
{
  "jobs": [
    {
      "id": "news-hourly",
      "enabled": true,
      "cron": "0 * * * *",
      "prompt": "Find 5 trending news articles that match my interests",
      "model": "high",
      "mode": "fast",
      "agentic": true,
      "target": "telegram",
      "targetId": "123456789"
    }
  ]
}
```

| Field | Description |
|---|---|
| `id` | Unique job identifier |
| `enabled` | `true` / `false` |
| `cron` | Cron expression (`min hour day month weekday`) |
| `prompt` | The prompt to send to AI |
| `model` | `flash` / `low` / `high` / `opus` / `sonnet` / `gpt` (optional, defaults to gagaclaw.json) |
| `mode` | `planning` / `fast` (optional) |
| `agentic` | Enable tool usage (optional) |
| `target` | Which consumer executes the job: `telegram` / `discord` / `cli` |
| `targetId` | Target chat/channel ID. Telegram = `chatId`, Discord = `channelId`, CLI = omit |
| `cascadeId` | Reuse a specific conversation; omit to create new each time |

Manage jobs in Telegram with `/cron` (shows ON/OFF toggle buttons per job).

Discord provides the equivalent `!cron`, `!cron on <id>`, and `!cron off <id>` commands.

## MCP Server

The included `gagaclaw_recommend_mcp` provides these tools:

- **`groq_transcribe`** — Transcribe audio files to text using Groq Whisper API
- **`telegram_send_file`** — Send files to Telegram admin chat (auto-converts `.md` to `.html`)
- **`discord_*` tools** — Discord REST helpers for listing guilds/channels/messages, sending messages/files, and basic guild operations

To register it in Antigravity:

1. Copy `mcp_config.example.json` to Antigravity's config directory and rename it `mcp_config.json`
2. Replace `<ABSOLUTE_PATH>` with the actual absolute path to the gagaclaw directory:
   - **Windows:** `%USERPROFILE%\.gemini\antigravity\mcp_config.json`
   - **Linux/macOS:** `~/.gemini/antigravity/mcp_config.json`

The IDE only reads MCP config from `~/.gemini/antigravity/` — always edit it there.

## Project Structure

```text
gagaclaw/
├── core.js                    # Core engine (CDP, auth, session, streaming)
├── telegram.js                # Telegram bot interface
├── discord.js                 # Discord bot interface
├── cli.js                     # CLI interface
├── cronjob.js                 # Cron scheduler
├── cron.js                    # Cron helper
├── start.sh                   # Linux/macOS launch script — CLI mode
├── start-telegram.sh          # Linux/macOS launch script — Telegram bot (telegram-agent)
├── start-discord.sh           # Linux/macOS launch script — Discord bot (discord-bot)
├── start-cron.sh              # Linux/macOS launch script — Cron scheduler
├── start.bat                  # Windows launch script — CLI mode
├── start-telegram.bat         # Windows launch script — Telegram bot (telegram-agent)
├── start-discord.bat          # Windows launch script — Discord bot (discord-bot)
├── start-cron.bat             # Windows launch script — Cron scheduler
├── gagaclaw.json              # Main config (not in repo, copy from example)
├── gagaclaw.example.json      # Config template
├── cronjobs.json              # Cron job definitions
├── mcp_config.example.json    # MCP config template (copy to ~/.gemini/antigravity/mcp_config.json)
├── package.json               # Dependencies
├── gagaclaw_recommend_mcp/    # MCP server (Groq + Telegram + Discord tools)
│   ├── index.js
│   └── discord-related.js
├── docs/
│   ├── setup-en.md            # English setup prompt
│   └── setup-zh.md            # 繁體中文安裝提示詞
├── workspace/                 # Telegram/default workspace
│   ├── soul.example.md        # Workspace personality (template)
│   ├── soul.md                # Workspace personality (copy from example, not in repo)
│   ├── memory.example.md      # Workspace memory (template)
│   └── memory.md              # Workspace memory (copy from example, not in repo)
└── workspace-discord-bot/     # Discord-specific workspace
    ├── soul.example.md
    ├── soul.md
    ├── memory.example.md
    └── memory.md
```

## Disclaimer

This project is provided **for research and educational purposes only**.
- **No Guarantee on AI Results:** AI-generated outputs may contain errors, inaccuracies, or unexpected behavior.
- **Risk of Data Loss & System Damage:** The AI has the ability to execute commands on your machine. The author makes no warranties and assumes no responsibility for any accidental data deletion, broken environments, or system modifications caused by AI operation errors (especially when YOLO mode is enabled).
- **Security & Privacy Risks:** The AI has access to your local filesystem. It may inadvertently read or transmit sensitive information, credentials, or private data to external AI models. Do not use this tool with highly confidential data without strict oversight.
- **Uncontrolled Actions & Financial Risk:** The AI agents have the ability to autonomously invoke external services, APIs, and tools — including but not limited to cloud APIs (Groq, Gemini, Claude, OpenAI), online purchases, subscription sign-ups, and payment transactions. Users are solely responsible for any charges, fees, or financial consequences resulting from AI-initiated actions.
- **Account Suspension Risk:** Using automated tools or bots may violate the terms of service of certain platforms, leading to the risk of your accounts (e.g., Google, Telegram) being suspended or banned.

**Use at your own risk.**

## License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).

---

## One-Click AI Setup

> **Open a fresh Antigravity workspace, paste the setup prompt, and the AI handles everything.**

**[English Setup Prompt](docs/setup-en.md)** | **[繁體中文安裝提示詞](docs/setup-zh.md)**

---

<a name="繁體中文"></a>

# 🇹🇼 繁體中文版

<p align="center">
  <img src="gagaclaw_logo.png" alt="Gagaclaw" width="280">
</p>

<h1 align="center">Gagaclaw v1.4.1</h1>

> **The remote controller for your Antigravity.**
> （你的專屬 Antigravity 遠端遙控器）

> 支援 **Windows**、**Linux** 和 **macOS**（含 Docker），搭配 [Antigravity IDE](https://www.antigravity.so) 使用。

**Gagaclaw** 是一個橋接層，將通訊平台（Telegram、Discord、CLI）連接到 [Antigravity IDE](https://www.antigravity.so)，讓它變成一個可遠端控制的 AI 代理人。

透過 Chrome DevTools Protocol（CDP）攔截 Antigravity 的內部通訊，讓你可以從手機或終端機發送提示詞、接收串流回應、核准工具權限、管理對話 — 一切盡在掌控。

## 功能特色

- **Telegram Bot** — 完整功能的機器人，支援行內鍵盤按鈕、串流回應、檔案上傳/下載、指令自動完成
- **Discord Bot** — 以 channel/thread 為單位維護 session，支援 mention/reply 路由、權限按鈕、收圖、重啟與 cron 執行
- **CLI 介面** — 終端機互動式對話，支援彩色輸出
- **多實體 / 多 Cascade** — 一個 Telegram chat、Discord channel/thread 或 CLI session 可對應一個 instance 與自己的 `cascadeId`
- **多模型支援** — 隨時切換 Gemini、Claude、GPT 模型
- **排程任務** — 透過 Cron 排程自動執行 AI 任務，每個任務可自訂模型/模式
- **Per-Instance Bootstrap** — 每個 instance 可設定首次訊息注入的 `bootstrapPrompt` 與每則訊息附加的 `messageHeader`
- **MCP 伺服器** — 內建 `gagaclaw_recommend_mcp`，提供 Groq 語音轉文字、Telegram 檔案傳送與 Discord REST 工具
- **權限系統** — 工具呼叫的行內鍵盤核准/拒絕，可選 YOLO 自動核准模式
- **工作區系統** — 可使用 `workspace/`、`workspace-discord-bot/` 等不同工作區，各自擁有 `soul.md` 與 `memory.md`

## 系統需求

- Windows 10/11、Linux（Ubuntu 20.04+、Debian 11+ 等）或 macOS
- [Node.js](https://nodejs.org/) 18+
- [Antigravity IDE](https://www.antigravity.so)
- Telegram 機器人 Token 與 / 或 Discord Bot Token
- （選用）[Groq API Key](https://console.groq.com/keys) 用於語音轉文字

## 設定說明

`gagaclaw.json` 欄位說明：

| 欄位 | 說明 |
|---|---|
| `telegram.token` | 從 [@BotFather](https://t.me/BotFather) 取得的 Bot Token |
| `telegram.allowedUsers` | 授權的 Telegram 使用者 ID 陣列（第一個也作為 MCP/排程通知的管理員聊天室） |
| `app.name` | IDE 應用程式名稱 |
| `app.targetExecutables` | 要偵測的程序名稱 |
| `activeWorkspace` | 啟用的工作區資料夾名稱 |
| `yoloMode` | `true` = 自動核准所有工具呼叫，`false` = 詢問後核准 |
| `groq.apiKey` | Groq API Key，用於語音轉文字（選用） |
| `defaults.model` | 模型 ID（例如 `MODEL_PLACEHOLDER_M37`）。必須使用完整 ID，不可使用簡寫 key。可用模型請參考 core.js 中的 `MODELS`。 |
| `defaults.mode` | `planning` 或 `fast` |
| `defaults.agentic` | 預設是否啟用工具使用 |
| `defaults.cdpPorts` | Chrome DevTools Protocol 連接埠 |
| `defaults.cdpHost` | CDP 主機位址 |
| `bootstrapPrompt` | 該 instance 在全新對話的第一則訊息前只注入一次的 bootstrap 內容 |
| `messageHeader` | 每則訊息前都會附上的短 header |

也支援用 `instances` 做多實體設定。這是目前最建議的模式，讓一個對話綁定一個 instance 與一個 `cascadeId`：

```json
{
  "app": { "name": "Antigravity" },
  "groq": { "apiKey": "..." },
  "defaultInstance": "telegram-agent",
  "instances": {
    "telegram-agent": {
      "telegram": { "token": "..." },
      "activeWorkspace": "workspace",
      "messageHeader": "[instance=telegram-agent workspace=workspace]",
      "bootstrapPrompt": "你現在是 `telegram-agent` instance。這個對話的主要工作區是 `workspace`。",
      "defaults": { "cdpPorts": [9229] }
    },
    "discord-bot": {
      "discord": { "token": "..." },
      "activeWorkspace": "workspace-discord-bot",
      "messageHeader": "[instance=discord-bot workspace=workspace-discord-bot]",
      "bootstrapPrompt": "你現在是 `discord-bot` instance。這個對話的主要工作區是 `workspace-discord-bot`。",
      "defaults": { "cdpPorts": [9229] }
    }
  }
}
```

啟動特定 instance：

```bash
node telegram.js telegram-agent
node discord.js discord-bot
node cli.js telegram-agent
```

建議實務配置：

- `telegram-agent` -> Telegram bot + `workspace/`
- `discord-bot` -> Discord bot + `workspace-discord-bot/`
- 每個 chat/channel/thread 各自保存目前的 `cascadeId`

執行期已不再依賴 `rules.md` 切換工作區。請優先使用 per-instance 的 `bootstrapPrompt`、`messageHeader`，以及工作區內的 `soul.md` / `memory.md`。

## 安裝方式

前往下方 [一鍵 AI 安裝](#一鍵-ai-安裝) 章節 — 開啟一個新的 Antigravity 工作區，貼上提示詞，AI 會自動完成所有事項（複製、安裝、設定、MCP 註冊）。

## Telegram 指令

| 指令 | 說明 |
|---|---|
| `/help` | 顯示說明 |
| `/new` | 開始新對話 |
| `/stop` | 停止目前回應 |
| `/list` | 列出對話（含切換/刪除按鈕） |
| `/model` | 切換 AI 模型（行內鍵盤） |
| `/mode` | 切換模式 — planning / fast |
| `/agentic` | 開關工具使用 |
| `/yolo` | 開關自動核准 |
| `/ws` | 切換工作區 |
| `/cron` | 管理排程任務 |
| `/restart` | 熱重啟或冷重啟 |

所有指令皆支援行內鍵盤按鈕（點選選擇）與文字參數（例如 `/model flash`）。

## Discord 指令

在 guild 頻道中建議使用 mention / reply 形式，例如 `@bot !new`。

| 指令 | 說明 |
|---|---|
| `!help` | 顯示說明 |
| `!new` | 為目前 channel/thread 開始新對話 |
| `!list` | 列出對話 |
| `!switch <n>` | 將目前 channel/thread 切到另一個對話 |
| `!delete <n>` | 刪除對話 |
| `!cron` | 列出 cron jobs |
| `!cron on <id>` | 啟用 cron job |
| `!cron off <id>` | 停用 cron job |
| `!restart [cold]` | 熱重啟或冷重啟 |

## 排程任務

Gagaclaw 可以自動執行排程 AI 任務。複製範本並編輯：

```bash
cp cronjobs.example.json cronjobs.json
```

`cronjobs.json` 範例：

```json
{
  "jobs": [
    {
      "id": "news-hourly",
      "enabled": true,
      "cron": "0 * * * *",
      "prompt": "找 5 篇符合我興趣的熱門新聞",
      "model": "high",
      "mode": "fast",
      "agentic": true,
      "target": "telegram",
      "targetId": "123456789"
    }
  ]
}
```

| 欄位 | 說明 |
|---|---|
| `id` | 唯一任務識別碼 |
| `enabled` | `true` / `false` |
| `cron` | Cron 表達式（`分 時 日 月 星期幾`） |
| `prompt` | 要傳送給 AI 的提示詞 |
| `model` | `flash` / `low` / `high` / `opus` / `sonnet` / `gpt`（選用，預設使用 gagaclaw.json） |
| `mode` | `planning` / `fast`（選用） |
| `agentic` | 啟用工具使用（選用） |
| `target` | 指定由哪個 consumer 執行：`telegram` / `discord` / `cli` |
| `targetId` | 目標 chat/channel ID。Telegram = `chatId`，Discord = `channelId`，CLI 可省略 |
| `cascadeId` | 重複使用特定對話；省略則每次建立新對話 |

在 Telegram 中使用 `/cron` 管理任務（顯示每個任務的 ON/OFF 按鈕）。

Discord 也提供對應的 `!cron`、`!cron on <id>`、`!cron off <id>` 指令。

## MCP 伺服器

內建的 `gagaclaw_recommend_mcp` 提供以下工具：

- **`groq_transcribe`** — 使用 Groq Whisper API 將音訊檔轉為文字
- **`telegram_send_file`** — 傳送檔案到 Telegram 管理員聊天室（自動將 `.md` 轉換為 `.html`）
- **`discord_*` 工具** — 透過 Discord REST API 列出 guild/channel/message、傳送訊息/檔案，以及基本 guild 操作

在 Antigravity 中註冊：

1. 將 `mcp_config.example.json` 複製到 Antigravity 的設定目錄，並改名為 `mcp_config.json`
2. 將 `<ABSOLUTE_PATH>` 替換為 gagaclaw 目錄的實際絕對路徑：
   - **Windows:** `%USERPROFILE%\.gemini\antigravity\mcp_config.json`
   - **Linux/macOS:** `~/.gemini/antigravity/mcp_config.json`

IDE 只會從 `~/.gemini/antigravity/` 讀取 MCP 設定 — 請一律在該位置編輯。

## 專案結構

```text
gagaclaw/
├── core.js                    # 核心引擎（CDP、認證、會話、串流）
├── telegram.js                # Telegram 機器人介面
├── discord.js                 # Discord 機器人介面
├── cli.js                     # CLI 介面
├── cronjob.js                 # 排程執行器
├── cron.js                    # 排程輔助工具
├── start.sh                   # Linux/macOS 啟動腳本 — CLI 模式
├── start-telegram.sh          # Linux/macOS 啟動腳本 — Telegram bot（telegram-agent）
├── start-discord.sh           # Linux/macOS 啟動腳本 — Discord bot（discord-bot）
├── start-cron.sh              # Linux/macOS 啟動腳本 — Cron 排程
├── start.bat                  # Windows 啟動腳本 — CLI 模式
├── start-telegram.bat         # Windows 啟動腳本 — Telegram bot（telegram-agent）
├── start-discord.bat          # Windows 啟動腳本 — Discord bot（discord-bot）
├── start-cron.bat             # Windows 啟動腳本 — Cron 排程
├── gagaclaw.json              # 主設定檔（不在 repo 中，從範本複製）
├── gagaclaw.example.json      # 設定範本
├── cronjobs.json              # 排程任務定義
├── mcp_config.example.json    # MCP 設定範本（複製到 ~/.gemini/antigravity/mcp_config.json）
├── package.json               # 相依套件
├── gagaclaw_recommend_mcp/    # MCP 伺服器（Groq + Telegram + Discord 工具）
│   ├── index.js
│   └── discord-related.js
├── docs/
│   ├── setup-en.md            # English 安裝提示詞
│   └── setup-zh.md            # 繁體中文安裝提示詞
├── workspace/                 # Telegram/default 工作區
│   ├── soul.example.md        # 工作區個性（範本）
│   ├── soul.md                # 工作區個性（從範本複製，不在 repo 中）
│   ├── memory.example.md      # 工作區記憶（範本）
│   └── memory.md              # 工作區記憶（從範本複製，不在 repo 中）
└── workspace-discord-bot/     # Discord 專用工作區
    ├── soul.example.md
    ├── soul.md
    ├── memory.example.md
    └── memory.md
```

## 免責聲明

本專案**僅供研究與教育用途**。
- **不保證 AI 結果：** AI 產生的輸出可能包含錯誤、不準確或非預期的行為。
- **資料遺失與系統損壞風險：** AI 具有在您機器上執行指令的能力。對於 AI 操作錯誤（特別是在啟用 YOLO 自動核准模式下）所導致的任何誤刪資料、環境破壞或系統變更，作者不提供任何形式的保證，亦不承擔任何連帶責任。
- **資安與隱私風險：** AI 可存取您的本機檔案系統，可能會不慎讀取或將敏感資訊、帳號密碼或私人數據傳輸給外部 AI 模型。在沒有嚴格監控的情況下，請勿將本工具用於處理高機密資料。
- **不可控行為與財務風險：** AI 代理具備自主呼叫外部服務、API 及工具的能力 — 包括但不限於雲端 API（Groq、Gemini、Claude、OpenAI）、線上購物、訂閱服務及付款交易。使用者須自行承擔因 AI 自主操作所產生的任何費用、扣款或財務後果。
- **帳號停權風險：** 使用自動化工具或機器人可能違反部分平台的服務條款，存在導致您的帳號（例如 Google、Telegram）被鎖定或封禁的風險。

**使用風險自負。**

## 授權條款

本專案採用 [MIT 授權條款](https://opensource.org/licenses/MIT)。

---

## 一鍵 AI 安裝

> **開啟一個新的 Antigravity 工作區，貼上安裝提示詞，AI 就會自動完成一切。**

**[English Setup Prompt](docs/setup-en.md)** | **[繁體中文安裝提示詞](docs/setup-zh.md)**
