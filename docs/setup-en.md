# One-Click AI Setup (with Linux/Docker support)

> **Just open a fresh Antigravity workspace, paste the prompt below, and the AI will handle everything — clone, install, configure, all interactive.**

### How to use:
1. Open Antigravity IDE
2. Close all other workspace tabs
3. Create or open an **empty folder** as workspace
4. Paste the entire prompt below into the chat
5. Answer the AI's questions — done!

---

```
I need you to install and configure Gagaclaw. Go through each step IN ORDER. Ask me questions when needed and WAIT for my answer before proceeding to the next step.

Step 1 — Clone & Install:
Run these commands in the current workspace directory:
  git clone https://github.com/joeIvan2/gagaclaw.git .
  npm install
  cd gagaclaw_recommend_mcp && npm install && cd ..
If git is not installed, tell me to install it from https://git-scm.com and stop.
If node/npm is not installed, tell me to install it from https://nodejs.org and stop.
Confirm when done.

Step 2 — Initialize Config Files:
  cp gagaclaw.example.json gagaclaw.json
  cp cronjobs.example.json cronjobs.json
  cp workspace/soul.example.md workspace/soul.md
  cp workspace/memory.example.md workspace/memory.md
  cp .agents/rules/rules.example.md .agents/rules/rules.md
Confirm when done.

Step 3 — Set Default Model:
Read core.js and find the MODELS object (near line 25). It lists all available models with their IDs.
Ask me which model I want as default, showing the available options:
  - MODEL_PLACEHOLDER_M18 — Gemini 3 Flash
  - MODEL_PLACEHOLDER_M36 — Gemini 3.1 Low
  - MODEL_PLACEHOLDER_M37 — Gemini 3.1 High (recommended)
  - MODEL_PLACEHOLDER_M26 — Claude 4.6 Opus
  - MODEL_PLACEHOLDER_M35 — Claude 4.6 Sonnet
  - MODEL_OPENAI_GPT_OSS_120B_MEDIUM — GPT OSS 120B
Update gagaclaw.json: set "defaults.model" to the chosen model ID string.
Do NOT use shorthand keys like "high" or "flash" — use the full MODEL_... ID.
Confirm when done.

Step 4 — Language Preference:
Ask me: "What language should I use? (e.g., English, 繁體中文, 日本語)"
After I answer, update these files to my chosen language:
- .agents/rules/rules.md — add "Preferred language: <language>" and translate content
- workspace/soul.md — translate all content, keep structure
- workspace/memory.md — set header in chosen language

Step 5 — Configure gagaclaw.json:
Read gagaclaw.json and interactively fill in each placeholder field. Ask ONE question at a time, wait for my answer, then update the file before asking the next.

5a. telegram.token
    - Placeholder: "PASTE_YOUR_BOT_TOKEN_HERE"
    - Ask me: "Please paste your Telegram bot token. (Create a bot at @BotFather on Telegram if you don't have one)"
    - Token format example: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz
    - Write as a JSON string (with quotes)

5b. telegram.allowedUsers
    - Placeholder: [0]
    - Ask me: "Please enter your Telegram user ID number. (Send /start to @userinfobot on Telegram to find it)"
    - Write as a number WITHOUT quotes inside the array, e.g. [919730886]

5c. groq.apiKey
    - Placeholder: "PASTE_YOUR_GROQ_API_KEY_HERE"
    - Ask me: "Please paste your Groq API key (get one free at https://console.groq.com/keys), or type 'skip' to skip."
    - If skipped, set to empty string "" (voice transcription won't work, everything else is fine)
    - Write as a JSON string (with quotes)

5d. [🐧 LINUX] Ask me: "Are you running on Linux? (yes/no)"
    If YES, apply this change to gagaclaw.json:
    - Set "app.targetExecutables" to ["antigravity"] (lowercase, no .exe)

    Then ask: "How is Antigravity deployed? (A) Natively on host  (B) Inside a Docker container"
    Remember the answer for Step 7.

After ALL fields are updated, read gagaclaw.json back and show me the result with sensitive values masked (e.g. token: "862***lqs") so I can confirm.

Step 6 — Install MCP Server:
The project includes mcp_config.json as a reference template. Do NOT edit it directly
(everyone's path is different, editing it causes git conflicts).

Instead, create the MCP config directly in Antigravity's config location:
  [🪟 WINDOWS] %USERPROFILE%\.gemini\antigravity\mcp_config.json
  [🐧 LINUX]   ~/.gemini/antigravity/mcp_config.json

Create the directory if it doesn't exist:
  [🪟 WINDOWS] mkdir -p "$USERPROFILE/.gemini/antigravity"
  [🐧 LINUX]   mkdir -p ~/.gemini/antigravity

Write this content to the file, replacing <ABSOLUTE_PATH> with the actual absolute path
to the gagaclaw directory (e.g. /home/user/gagaclaw or C:/Users/user/gagaclaw):
  {
    "mcpServers": {
      "gagaclaw_recommend_mcp": {
        "command": "node",
        "args": ["<ABSOLUTE_PATH>/gagaclaw_recommend_mcp/index.js"]
      }
    }
  }

The IDE only reads MCP config from ~/.gemini/antigravity/ — always edit it there.
Confirm when done.

Step 7 — [🐧 LINUX] Configure Launch Scripts:

The repo already includes Linux launch scripts (start.sh, start-telegram.sh, start-cron.sh).
They auto-detect and start Antigravity with CDP if not already running, and support
restart-on-exit-code-42 just like the Windows .bat files.

First, make them executable:
  chmod +x start.sh start-telegram.sh start-cron.sh

There are TWO deployment scenarios. Use the one matching the answer from Step 5d:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[A] HOST MODE — Antigravity runs natively on the Linux host
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The included .sh scripts work out of the box. No modifications needed.
They will auto-start Antigravity with:
  antigravity --no-sandbox --remote-debugging-port=9229 &

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[B] DOCKER MODE — Antigravity runs inside a Docker container
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Ask me these Docker-specific questions (one at a time, wait for answers):
  1. "What is the Docker container name? (e.g., desktop-gui-1)"
  2. "What is the desktop user inside the container? (e.g., abc)"

Important: There are TWO sub-options for Docker:

  [B1] Gagaclaw runs INSIDE the container (e.g., double-click from container desktop)
       - The included .sh scripts work as-is — no modifications needed
       - Antigravity and node are available directly inside the container
       - This is the recommended approach if you access via VNC/remote desktop

  [B2] Gagaclaw runs on the HOST, connecting to Antigravity in the container via CDP
       - The container must use --network=host OR expose port 9229
       - Modify the .sh scripts: replace the Antigravity launch line with docker exec

Ask me: "Where will Gagaclaw run? (B1) Inside the container  (B2) On the host"

── [B1] In-Container: ──
No script changes needed. The included .sh scripts work as-is.

── [B2] Host-to-Container: ──
Edit each .sh script — replace the Antigravity launch line:
  FROM:  antigravity --no-sandbox --remote-debugging-port=9229 &
  TO:    docker exec -d -u <USER> -e DISPLAY=:1 <CONTAINER> antigravity --no-sandbox --remote-debugging-port=9229

Replace <CONTAINER> and <USER> with the answers from above.

Note for [B2]: The container must use --network=host so CDP port 9229 is accessible
from the host at 127.0.0.1:9229. If using bridge networking, replace 127.0.0.1 in
gagaclaw.json "defaults.cdpHost" with the container's IP address.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For ALL scenarios above:
- Ensure /dev/shm is at least 2GB: mount -o remount,size=2G /dev/shm
- The --no-sandbox flag is required when running as non-root or in Docker
- [🐳 DOCKER] File ownership: The entire gagaclaw directory must be owned by the desktop user
  who runs node/Antigravity, otherwise writing to cronjobs.json, queue/, etc. will fail with
  EACCES permission denied. Run: chown -R <USER>:<USER> /path/to/gagaclaw
- [🐳 DOCKER] Optional: Mount the host root filesystem for full access (HIGH RISK — the AI
  can read/write any file on the host):
    volumes:
      - /:/host_root

Step 8 — Verify:
Do a final check:
- All required files exist (core.js, telegram.js, cli.js, cronjob.js, cron.js, gagaclaw.json, package.json, gagaclaw_recommend_mcp/index.js, workspace/soul.md, workspace/memory.md)
- gagaclaw.json has non-placeholder values for telegram.token and telegram.allowedUsers
- gagaclaw.json has a valid MODEL_... ID in defaults.model (not "high" or "flash")
- MCP server is registered
- node_modules exists in both root and gagaclaw_recommend_mcp/
- [🐧 LINUX] If Linux: verify targetExecutables is ["antigravity"] (not ["Antigravity.exe"])
- [🐧 LINUX] Verify CDP is accessible: curl -s http://127.0.0.1:9229/json/version
- [🐧 LINUX] Verify start.sh, start-telegram.sh, start-cron.sh exist and are executable
- [🐳 DOCKER] Verify file ownership: ls -la gagaclaw.json cronjobs.json queue/ — all must be
  writable by the user running node. If not, run: chown -R <USER>:<USER> /path/to/gagaclaw
Report any issues found, or confirm everything is ready.

Step 9 — Done:

[🪟 WINDOWS] Tell me:
  "Setup complete! Close Antigravity IDE, then use these batch files to launch:
   - start-telegram.bat → Telegram bot
   - start.bat → CLI mode
   - start-cron.bat → Cron scheduler (run in separate terminal)
   Important: Always use the .bat files to launch — they enable the debug port and restart support."

[🐧 LINUX] Tell me:
  "Setup complete! Use these shell scripts to launch (double-click or run from terminal):
   - start.sh → CLI mode
   - start-telegram.sh → Telegram bot
   - start-cron.sh → Cron scheduler

   Each script will automatically start Antigravity with CDP if it's not already running.
   To verify CDP manually: curl -s http://127.0.0.1:9229/json/version"
```
