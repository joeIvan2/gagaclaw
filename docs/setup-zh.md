# 一鍵 AI 安裝（支援 Linux/Docker）

> **只要開啟一個新的 Antigravity 工作區，貼上下方提示詞，AI 就會自動完成一切 — 複製、安裝、設定，全程互動式引導。**

### 使用方法：
1. 開啟 Antigravity IDE
2. 關閉所有其他工作區分頁
3. 建立或開啟一個**空資料夾**作為工作區
4. 將下方整段提示詞貼入聊天
5. 回答 AI 的問題 — 完成！

---

```
請幫我安裝並設定 Gagaclaw。請按順序逐步執行，需要問我問題時請先等我回答，再進行下一步。

步驟 1 — 複製並安裝：
在目前的工作區目錄執行以下指令：
  git clone https://github.com/joeIvan2/gagaclaw.git .
  npm install
  cd gagaclaw_recommend_mcp && npm install && cd ..
如果沒有安裝 git，請告訴我從 https://git-scm.com 下載安裝，然後停止。
如果沒有安裝 node/npm，請告訴我從 https://nodejs.org 下載安裝，然後停止。
完成後請確認。

步驟 2 — 初始化設定檔：
  cp gagaclaw.example.json gagaclaw.json
  cp cronjobs.example.json cronjobs.json
  cp workspace/soul.example.md workspace/soul.md
  cp workspace/memory.example.md workspace/memory.md
  cp .agents/rules/rules.example.md .agents/rules/rules.md
完成後請確認。

步驟 3 — 設定預設模型：
讀取 core.js，找到 MODELS 物件（約第 25 行），列出所有可用模型及其 ID。
問我要使用哪個模型作為預設值，顯示以下選項：
  - MODEL_PLACEHOLDER_M18 — Gemini 3 Flash
  - MODEL_PLACEHOLDER_M36 — Gemini 3.1 Low
  - MODEL_PLACEHOLDER_M37 — Gemini 3.1 High（推薦）
  - MODEL_PLACEHOLDER_M26 — Claude 4.6 Opus
  - MODEL_PLACEHOLDER_M35 — Claude 4.6 Sonnet
  - MODEL_OPENAI_GPT_OSS_120B_MEDIUM — GPT OSS 120B
更新 gagaclaw.json：將 "defaults.model" 設為選定的模型 ID 字串。
不可使用簡寫 key（如 "high" 或 "flash"）— 必須用完整的 MODEL_... ID。
完成後請確認。

步驟 4 — 語言偏好：
問我：「您希望使用什麼語言？（例如：English、繁體中文、日本語）」
我回答後，將以下檔案更新為我選擇的語言：
- .agents/rules/rules.md — 加入「Preferred language: <語言>」並翻譯內容
- workspace/soul.md — 翻譯所有內容，保留結構
- workspace/memory.md — 以選定語言設定標題

步驟 5 — 設定 gagaclaw.json：
讀取 gagaclaw.json，互動式填入每個 placeholder 欄位。一次只問一個問題，等我回答後再更新檔案，然後才問下一個。

5a. telegram.token
    - Placeholder: "PASTE_YOUR_BOT_TOKEN_HERE"
    - 問我：「請貼上你的 Telegram Bot Token。（如果沒有，請在 Telegram 找 @BotFather 建立一個）」
    - Token 格式範例：123456789:ABCdefGHIjklMNOpqrsTUVwxyz
    - 寫入為 JSON 字串（含引號）

5b. telegram.allowedUsers
    - Placeholder: [0]
    - 問我：「請輸入你的 Telegram 使用者 ID 數字。（在 Telegram 傳送 /start 給 @userinfobot 即可取得）」
    - 寫入為不含引號的數字放在陣列中，例如 [919730886]

5c. groq.apiKey
    - Placeholder: "PASTE_YOUR_GROQ_API_KEY_HERE"
    - 問我：「請貼上你的 Groq API Key（可在 https://console.groq.com/keys 免費取得），或輸入 'skip' 跳過。」
    - 如果跳過，設為空字串 ""（語音轉文字功能將無法使用，其他功能不受影響）
    - 寫入為 JSON 字串（含引號）

5d. [🐧 LINUX] 問我：「你是在 Linux 上執行嗎？（是/否）」
    如果是，對 gagaclaw.json 做以下修改：
    - 將 "app.targetExecutables" 設為 ["antigravity"]（小寫，不加 .exe）

    然後問：「Antigravity 的部署方式是？(A) 直接安裝在主機上  (B) 在 Docker 容器內」
    記住答案，步驟 7 會用到。

所有欄位更新完成後，重新讀取 gagaclaw.json 並顯示結果，敏感資訊請遮罩顯示（例如 token: "862***lqs"），讓我確認。

步驟 6 — 安裝 MCP 伺服器：
專案內的 mcp_config.json 僅供參考，請勿直接編輯（每個人路徑不同，修改會造成 git 衝突）。

請直接在 Antigravity 的設定目錄中建立 MCP 設定檔：
  [🪟 WINDOWS] %USERPROFILE%\.gemini\antigravity\mcp_config.json
  [🐧 LINUX]   ~/.gemini/antigravity/mcp_config.json

如果目錄不存在，先建立：
  [🪟 WINDOWS] mkdir -p "$USERPROFILE/.gemini/antigravity"
  [🐧 LINUX]   mkdir -p ~/.gemini/antigravity

將以下內容寫入該檔案，把 <絕對路徑> 替換為 gagaclaw 目錄的實際絕對路徑
（例如 /home/user/gagaclaw 或 C:/Users/user/gagaclaw）：
  {
    "mcpServers": {
      "gagaclaw_recommend_mcp": {
        "command": "node",
        "args": ["<絕對路徑>/gagaclaw_recommend_mcp/index.js"]
      }
    }
  }

IDE 只會從 ~/.gemini/antigravity/ 讀取 MCP 設定 — 請一律在該位置編輯。
完成後請確認。

步驟 7 — [🐧 LINUX] 設定啟動腳本：

Repo 已內建 Linux 啟動腳本（start.sh、start-telegram.sh、start-cron.sh）。
它們會自動偵測並啟動 Antigravity 及 CDP（若尚未執行），並支援 exit code 42 自動重啟，
與 Windows 的 .bat 檔行為一致。

首先，設為可執行：
  chmod +x start.sh start-telegram.sh start-cron.sh

有兩種部署情境，依據步驟 5d 的回答選擇對應的方案：

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[A] 主機模式 — Antigravity 直接安裝在 Linux 主機上
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

內建的 .sh 腳本可直接使用，無需修改。
它們會自動以下列指令啟動 Antigravity：
  antigravity --no-sandbox --remote-debugging-port=9229 &

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[B] DOCKER 模式 — Antigravity 在 Docker 容器內執行
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

問我以下 Docker 相關問題（一次一個，等我回答）：
  1.「Docker 容器名稱是什麼？（例如：desktop-gui-1）」
  2.「容器內的桌面使用者是誰？（例如：abc）」

重要：Docker 有兩個子選項：

  [B1] Gagaclaw 在容器內執行（例如從容器桌面雙擊啟動）
       - 內建的 .sh 腳本可直接使用，無需修改
       - Antigravity 和 node 可直接使用
       - 如果你透過 VNC/遠端桌面存取，建議使用此方式

  [B2] Gagaclaw 在主機上執行，透過 CDP 連線到容器內的 Antigravity
       - 容器必須使用 --network=host 或開放 port 9229
       - 需修改 .sh 腳本中的 Antigravity 啟動指令改為 docker exec

問我：「Gagaclaw 要在哪裡執行？(B1) 容器內  (B2) 主機上」

── [B1] 容器內：──
無需修改腳本，內建的 .sh 腳本可直接使用。

── [B2] 主機對容器：──
編輯每個 .sh 腳本 — 將 Antigravity 啟動行替換：
  原本：antigravity --no-sandbox --remote-debugging-port=9229 &
  改為：docker exec -d -u <USER> -e DISPLAY=:1 <CONTAINER> antigravity --no-sandbox --remote-debugging-port=9229

將 <CONTAINER> 和 <USER> 替換為上方的回答。

[B2] 注意：容器必須使用 --network=host，CDP port 9229 才能從主機的
127.0.0.1:9229 存取。如果使用 bridge 網路，請將 gagaclaw.json 中的
"defaults.cdpHost" 改為容器的 IP 位址。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

以上所有情境共通事項：
- 確保 /dev/shm 至少 2GB：mount -o remount,size=2G /dev/shm
- 以非 root 身分或在 Docker 中執行時，必須加上 --no-sandbox 參數
- [🐳 DOCKER] 檔案所有權：整個 gagaclaw 目錄必須屬於執行 node/Antigravity 的桌面使用者，
  否則寫入 cronjobs.json、queue/ 等檔案時會出現 EACCES 權限拒絕錯誤。
  執行：chown -R <USER>:<USER> /path/to/gagaclaw
- [🐳 DOCKER] 選用：掛載主機根目錄以獲得完整存取權限（高風險 — AI 可讀寫主機上的任何檔案）：
    volumes:
      - /:/host_root

步驟 8 — 驗證：
執行最終檢查：
- 所有必要檔案都存在（core.js, telegram.js, cli.js, cronjob.js, cron.js, gagaclaw.json, package.json, gagaclaw_recommend_mcp/index.js, workspace/soul.md, workspace/memory.md）
- gagaclaw.json 中 telegram.token 和 telegram.allowedUsers 已非 placeholder 值
- gagaclaw.json 的 defaults.model 為有效的 MODEL_... ID（不可為 "high" 或 "flash"）
- MCP 伺服器已註冊
- node_modules 在根目錄和 gagaclaw_recommend_mcp/ 中都存在
- [🐧 LINUX] 如為 Linux：確認 targetExecutables 為 ["antigravity"]（非 ["Antigravity.exe"]）
- [🐧 LINUX] 確認 CDP 可連線：curl -s http://127.0.0.1:9229/json/version
- [🐧 LINUX] 確認 start.sh、start-telegram.sh、start-cron.sh 存在且為可執行
- [🐳 DOCKER] 確認檔案所有權：ls -la gagaclaw.json cronjobs.json queue/ — 全部必須為執行
  node 的使用者可寫入。若不是，執行：chown -R <USER>:<USER> /path/to/gagaclaw
回報任何發現的問題，或確認一切就緒。

步驟 9 — 完成：

[🪟 WINDOWS] 告訴我：
  「安裝完成！請關閉 Antigravity IDE，然後使用以下 bat 檔啟動：
   - start-telegram.bat → Telegram 機器人
   - start.bat → CLI 模式
   - start-cron.bat → 排程任務（在另一個終端機視窗執行）
   重要：請務必使用 .bat 檔啟動 — 它們會啟用除錯連接埠並支援重啟功能。」

[🐧 LINUX] 告訴我：
  「安裝完成！使用以下 shell 腳本啟動（雙擊或在終端機執行）：
   - start.sh → CLI 模式
   - start-telegram.sh → Telegram 機器人
   - start-cron.sh → 排程任務

   每個腳本會自動啟動 Antigravity 及 CDP（如果尚未執行）。
   手動驗證 CDP：curl -s http://127.0.0.1:9229/json/version」
```
