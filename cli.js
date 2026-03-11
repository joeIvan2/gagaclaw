#!/usr/bin/env node
/**
 * Gagaclaw CLI v1.1 — Interactive terminal interface
 * Uses core.js engine, provides readline REPL, ANSI display, command handling
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { createSession, createExtraSession, MODELS, MODEL_BY_ID, MODES, loadConfig, getCurrentWorkspace, listWorkspaces, switchWorkspace, splitText, LOCAL_VERSION, checkUpdate, getUsage } = require('./core');
const cron = require('./cronjob');

// ─── Log file (cleared on each startup) ──────────────────────────────────────
const cliLog = fs.createWriteStream(path.join(__dirname, 'cli.log'), { flags: 'w' });
const logTs = () => new Date().toISOString().slice(11, 23);
function flog(msg) { cliLog.write(`[${logTs()}] ${msg}\n`); }

// ─── Color helpers ────────────────────────────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
    red: '\x1b[31m', magenta: '\x1b[35m', gray: '\x1b[90m', blue: '\x1b[34m',
};
function log(color, prefix, msg) {
    process.stdout.write(`${color}${c.bold}${prefix}${c.reset}${color} ${msg}${c.reset}\n`);
}

// Logger adapter for core.js
function coreLogger(level, msg) {
    flog(`[${level}] ${msg}`);
    if (level === 'error') log(c.red, '✗', msg);
    else if (level === 'info') log(c.green, '✓', msg);
    else log(c.dim, 'ℹ', msg);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const cfg = loadConfig();
    const appName = cfg.app?.name || 'Antigravity';

    console.log(`\n${c.cyan}${c.bold}═══════════════════════════════════════════════${c.reset}`);
    console.log(`${c.cyan}${c.bold}  ${appName} CLI v${LOCAL_VERSION}${c.reset}`);
    console.log(`${c.cyan}${c.bold}═══════════════════════════════════════════════${c.reset}\n`);

    const { session, auth, resumed, id, title } = await createSession(coreLogger);
    // auth can be used with createExtraSession(auth, cascadeId) to create additional sessions

    if (resumed) {
        log(c.green, '✓', `Resumed: ${id.substring(0, 8)}... — ${title}`);
    } else {
        log(c.green, '✓', `New cascade: ${id.substring(0, 8)}...`);
    }
    log(c.cyan, '🤖', `Model: ${session.modelLabel} | Mode: ${session.modeLabel} | Agentic: ${session.agenticEnabled} | YOLO: ${session.yoloMode ? 'ON ⚡' : 'OFF'}`);

    // Version check (non-blocking)
    checkUpdate().then(v => {
        if (v.upToDate === false) {
            log(c.yellow, '⬆', `Update available: v${v.local} → v${v.remote}  (git pull to update)`);
        } else if (v.upToDate) {
            log(c.green, '✓', `Gagaclaw v${v.local} (up to date)`);
        } else {
            log(c.green, '✓', `Gagaclaw v${v.local} (update check failed)`);
        }
    });

    // ── readline REPL ──
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${c.cyan}${c.bold}You: ${c.reset}`,
    });

    // Clear stale cron queue on startup
    const stale = cron.consumeQueue('cli');
    if (stale.length > 0) {
        log(c.magenta, '⏰', `Cleared ${stale.length} stale cron queue item(s)`);
        flog(`[CRON] Cleared ${stale.length} stale queue item(s) on startup`);
    }

    let thinkingShown = false;
    let _cliBusy = false;

    // ── Cron queue state ──
    let _cronPending = [];
    let _cronActive = null;
    let _savedModel = null;
    let _savedMode = null;
    let _savedAgentic = null;

    function processCronQueue() {
        if (_cronPending.length === 0) {
            _cronPending.push(...cron.consumeQueue('cli'));
        }
        if (_cronPending.length === 0) return;

        const item = _cronPending.shift();
        _cronActive = item;
        const promptPreview = item.prompt?.slice(0, 50) || '';
        log(c.magenta, '⏰', `Cron job: ${item.id} → "${promptPreview}"`);
        flog(`[CRON] Processing job: ${item.id} prompt="${promptPreview}"`);

        // Save & apply settings
        _savedModel = Object.entries(MODELS).find(([k, v]) => v.label === session.modelLabel)?.[0] || null;
        _savedMode = Object.entries(MODES).find(([k, v]) => v.label === session.modeLabel)?.[0] || null;
        _savedAgentic = session.agenticEnabled;

        if (item.model) session.setModel(item.model);
        if (item.mode) session.setMode(item.mode);
        if (item.agentic !== null && item.agentic !== undefined) session.setAgentic(item.agentic);

        log(c.magenta, '⏰', `Cron job: ${item.id}`);
        rl.pause();
        thinkingShown = false;
        process.stdout.write(`\n${c.green}${c.bold}${appName}: ${c.reset}`);
        session.send(item.prompt);
    }

    // ── Wire session events to CLI display ──
    session.on('thinking', (delta) => {
        if (!thinkingShown) { process.stdout.write(`${c.dim}[Thinking] `); thinkingShown = true; }
        process.stdout.write(`${c.dim}${delta}${c.reset}`);
    });

    session.on('response', (delta, full) => {
        if (thinkingShown && session._lastResponse.length === delta.length) {
            // First response chunk after thinking
            process.stdout.write(`${c.reset}\n\n`);
            thinkingShown = false;
        }
        process.stdout.write(delta);
    });

    session.on('toolCall', (tc) => {
        // notify_user: AI's message to the user — display as regular text
        if (tc.toolName === 'notify_user' && tc.Message) {
            process.stdout.write(`\n\n${tc.Message}\n`);
            return;
        }
        if (tc.toolName === 'run_command' && tc.SafeToAutoRun !== false && tc.CommandLine) {
            process.stdout.write(`\n${c.gray}  > ${tc.CommandLine}${c.reset}`);
        } else if (tc.toolName && tc.toolName !== 'run_command') {
            const summary = tc.toolSummary || tc.TaskName || tc.toolName;
            const detail = tc.CommandLine || tc.Task || tc.AbsolutePath || tc.Url || '';
            process.stdout.write(`\n${c.blue}  [${tc.toolName}]${c.reset} ${summary}${detail ? ` — ${detail.slice(0, 120)}` : ''}`);
        }
    });

    session.on('permissionWait', async (perm) => {
        await handleToolApproval(rl, session, perm, appName);
    });

    session.on('newStep', () => {
        thinkingShown = false;
    });

    session.on('turnDone', () => {
        process.stdout.write('\n\n');
        thinkingShown = false;
        _cliBusy = false;

        // Restore cron settings if needed
        if (_cronActive) {
            if (_savedModel) session.setModel(_savedModel);
            if (_savedMode) session.setMode(_savedMode);
            if (_savedAgentic !== null) session.setAgentic(_savedAgentic);
            log(c.magenta, '⏰', `Cron job done, restored settings`);
            flog(`[CRON] Restored settings: model=${_savedModel} mode=${_savedMode} agentic=${_savedAgentic}`);
            _cronActive = null;
            _savedModel = null;
            _savedMode = null;
            _savedAgentic = null;
        }

        // Check cron queue before returning to user prompt
        if (_cronPending.length > 0) {
            processCronQueue();
            return;
        }
        const cronItems = cron.consumeQueue('cli');
        if (cronItems.length > 0) {
            _cronPending.push(...cronItems);
            processCronQueue();
            return;
        }

        rl.resume();
        rl.prompt();
    });

    session.on('streamReconnect', () => {
        log(c.yellow, '⟳', 'Stream closed, reconnecting...');
    });

    session.on('permissionResolved', () => {
        process.stdout.write(`\n${c.green}${c.bold}${appName}: ${c.reset}`);
    });

    session.on('yoloApprove', (desc) => {
        log(c.magenta, '⚡', `YOLO auto-approved: ${desc}`);
    });

    session.on('error', (msg) => {
        flog(`[ERROR] ${msg}`);
        log(c.red, '✗', msg);
    });

    // ── Command handlers ──

    rl.prompt();

    rl.on('line', async (line) => {
        const userInput = line.trim();
        if (!userInput) { rl.prompt(); return; }

        if (userInput.toLowerCase() === 'exit' || userInput === '/exit') {
            log(c.yellow, '👋', 'Goodbye!');
            session.destroy();
            process.exit(0);
        }

        if (userInput.startsWith('/restart')) {
            const arg = userInput.slice(8).trim().toLowerCase();
            if (arg === 'cold') {
                log(c.red, '⟳', 'Cold restart — killing Antigravity + restarting...');
                session.destroy();
                const exeName = (loadConfig().app?.targetExecutables || ['Antigravity.exe'])[0];
                if (process.platform === 'win32') {
                    try { require('child_process').execSync(`taskkill /IM ${exeName} /F`, { stdio: 'ignore' }); } catch { }
                } else {
                    try { require('child_process').execSync(`pkill -9 -f ${exeName.replace(/\.exe$/i, '')}`, { stdio: 'ignore' }); } catch { }
                }
                process.exit(42);
            } else {
                log(c.yellow, '⟳', 'Warm restart — re-auth...');
                session.destroy();
                process.exit(42);
            }
        }

        if (userInput === '/stop') {
            const res = await session.stop();
            if (res.status === 200) log(c.green, '✓', 'Stopped');
            else log(c.red, '✗', `Stop failed (${res.status})`);
            rl.prompt();
            return;
        }

        if (userInput === '/new') {
            const newId = await session.startNewCascade();
            if (newId) {
                session.cascadeId = newId;
                session.openStream();
                log(c.green, '✓', `New cascade: ${newId.substring(0, 8)}...`);
            } else {
                log(c.red, '✗', 'Failed to start new cascade');
            }
            rl.prompt();
            return;
        }

        if (userInput === '/list') {
            const list = await session.listCascades();
            if (list.length === 0) { log(c.yellow, '⚠', 'No conversations found'); }
            else {
                console.log(`\n${c.cyan}${c.bold}Conversations (${list.length}):${c.reset}`);
                for (let i = 0; i < Math.min(list.length, 15); i++) {
                    const e = list[i];
                    const isCurrent = e.id === session.cascadeId;
                    const date = e.lastModifiedTime ? new Date(e.lastModifiedTime).toLocaleString() : '?';
                    const ttl = e.summary || '(untitled)';
                    const prefix = isCurrent ? `${c.green}▶ ` : '  ';
                    console.log(`${prefix}${c.cyan}${i + 1}${c.reset}) ${e.id.slice(0, 8)}... ${c.dim}${date}${c.reset} ${ttl.slice(0, 45)}`);
                }
                console.log(`\n  ${c.dim}/switch N to switch, /delete N to delete${c.reset}\n`);
            }
            rl.prompt();
            return;
        }

        if (userInput.startsWith('/switch')) {
            const arg = userInput.slice(7).trim();
            const num = parseInt(arg);
            const list = await session.listCascades();
            if (!num || num < 1 || num > list.length) {
                log(c.red, '✗', `Invalid. Use /list first, then /switch 1~${list.length}`);
            } else {
                session.switchCascade(list[num - 1].id);
                const ttl = list[num - 1].summary || '(untitled)';
                log(c.green, '✓', `Switched: ${session.cascadeId.substring(0, 8)}... — ${ttl}`);
            }
            rl.prompt();
            return;
        }

        if (userInput.startsWith('/delete')) {
            const arg = userInput.slice(7).trim();
            const num = parseInt(arg);
            const list = await session.listCascades();
            if (!num || num < 1 || num > list.length) {
                log(c.red, '✗', `Invalid. Use /list first, then /delete N`);
            } else {
                const target = list[num - 1];
                const ttl = target.summary || '(untitled)';
                const ok = await session.deleteCascade(target.id);
                if (ok) {
                    log(c.green, '✓', `Deleted #${num}: ${ttl}`);
                    if (!session.cascadeId) {
                        log(c.yellow, '⚠', 'Current conversation deleted. Use /new or /switch.');
                    }
                } else {
                    log(c.red, '✗', 'Delete failed');
                }
            }
            rl.prompt();
            return;
        }

        if (userInput.startsWith('/model')) {
            const arg = userInput.slice(6).trim().toLowerCase();
            if (arg) {
                if (session.setModel(arg)) {
                    log(c.green, '✓', `Model → ${session.modelLabel} (saved)`);
                } else {
                    log(c.red, '✗', `Unknown model: ${arg}`);
                    console.log(`  ${c.cyan}flash${c.reset}   Gemini 3 Flash`);
                    console.log(`  ${c.cyan}low${c.reset}     Gemini 3.1 Low`);
                    console.log(`  ${c.cyan}high${c.reset}    Gemini 3.1 High`);
                    console.log(`  ${c.cyan}opus${c.reset}    Claude 4.6 Opus`);
                    console.log(`  ${c.cyan}sonnet${c.reset}  Claude 4.6 Sonnet`);
                    console.log(`  ${c.cyan}gpt${c.reset}     GPT OSS 120B`);
                }
            } else {
                console.log(`\n${c.cyan}${c.bold}Current model:${c.reset} ${session.modelLabel}`);
                console.log(`  ${c.cyan}/model flash${c.reset}   Gemini 3 Flash`);
                console.log(`  ${c.cyan}/model low${c.reset}     Gemini 3.1 Low`);
                console.log(`  ${c.cyan}/model high${c.reset}    Gemini 3.1 High`);
                console.log(`  ${c.cyan}/model opus${c.reset}    Claude 4.6 Opus`);
                console.log(`  ${c.cyan}/model sonnet${c.reset}  Claude 4.6 Sonnet`);
                console.log(`  ${c.cyan}/model gpt${c.reset}     GPT OSS 120B\n`);
            }
            rl.prompt();
            return;
        }

        if (userInput.startsWith('/mode')) {
            const arg = userInput.slice(5).trim().toLowerCase();
            if (arg) {
                if (session.setMode(arg)) {
                    log(c.green, '✓', `Mode → ${session.modeLabel} (saved)`);
                } else {
                    log(c.red, '✗', `Unknown mode: ${arg}`);
                    console.log(`  ${c.cyan}planning${c.reset}  Plan before executing (default)`);
                    console.log(`  ${c.cyan}fast${c.reset}      Execute directly, no planning`);
                }
            } else {
                console.log(`\n${c.cyan}${c.bold}Current mode:${c.reset} ${session.modeLabel}`);
                console.log(`  ${c.cyan}/mode planning${c.reset}  Plan before executing (default)`);
                console.log(`  ${c.cyan}/mode fast${c.reset}      Execute directly, no planning\n`);
            }
            rl.prompt();
            return;
        }

        if (userInput.startsWith('/agentic')) {
            const arg = userInput.slice(8).trim().toLowerCase();
            if (arg === 'true' || arg === 'on' || arg === '1') {
                session.setAgentic(true);
                log(c.green, '✓', 'Agentic → ON (saved)');
            } else if (arg === 'false' || arg === 'off' || arg === '0') {
                session.setAgentic(false);
                log(c.green, '✓', 'Agentic → OFF (saved)');
            } else {
                console.log(`\n${c.cyan}${c.bold}Agentic:${c.reset} ${session.agenticEnabled ? 'ON' : 'OFF'}`);
                console.log(`  ${c.cyan}/agentic true${c.reset}   Enable tool usage`);
                console.log(`  ${c.cyan}/agentic false${c.reset}  Disable tool usage\n`);
            }
            rl.prompt();
            return;
        }

        if (userInput.startsWith('/yolo')) {
            const arg = userInput.slice(5).trim().toLowerCase();
            if (arg === 'on' || arg === 'true' || arg === '1') {
                session.setYolo(true);
                log(c.magenta, '⚡', 'YOLO mode → ON (all permissions auto-approved, saved)');
            } else if (arg === 'off' || arg === 'false' || arg === '0') {
                session.setYolo(false);
                log(c.green, '✓', 'YOLO mode → OFF (saved)');
            } else {
                console.log(`\n${c.magenta}${c.bold}YOLO mode:${c.reset} ${session.yoloMode ? 'ON ⚡' : 'OFF'}`);
                console.log(`  ${c.cyan}/yolo on${c.reset}   Auto-approve all permissions`);
                console.log(`  ${c.cyan}/yolo off${c.reset}  Ask before approving\n`);
            }
            rl.prompt();
            return;
        }

        if (userInput.startsWith('/ws')) {
            const arg = userInput.slice(3).trim();
            if (arg) {
                const result = switchWorkspace(arg);
                if (result.ok) log(c.green, '✓', result.msg);
                else log(c.red, '✗', result.msg);
            } else {
                const current = getCurrentWorkspace();
                const available = listWorkspaces();
                console.log(`\n${c.cyan}${c.bold}Active workspace:${c.reset} ${current}`);
                if (available.length > 0) {
                    console.log(`${c.dim}Available:${c.reset} ${available.join(', ')}`);
                }
                console.log(`  ${c.cyan}/ws <name>${c.reset}  Switch workspace\n`);
            }
            rl.prompt();
            return;
        }

        if (userInput.startsWith('/cron')) {
            const arg = userInput.slice(5).trim();
            const parts = arg.split(/\s+/);
            const sub = parts[0]?.toLowerCase() || '';
            const jobId = parts[1] || '';

            if (!sub) {
                const jobs = cron.listAllJobs();
                if (jobs.length === 0) {
                    log(c.yellow, '📋', 'No cron jobs — edit cronjobs.json to add');
                } else {
                    console.log(`\n${c.cyan}${c.bold}Cron Jobs (${jobs.length}):${c.reset}`);
                    for (const j of jobs) {
                        const status = j.enabled ? `${c.green}ON${c.reset}` : `${c.dim}OFF${c.reset}`;
                        const nextStr = j.nextRun ? new Date(j.nextRun).toLocaleString() : '—';
                        const prompt = j.prompt.length > 50 ? j.prompt.slice(0, 50) + '…' : j.prompt;
                        console.log(`  ${status} ${c.cyan}${j.id}${c.reset} — ${j.cron} → next: ${nextStr}`);
                        console.log(`     ${c.dim}${prompt}${c.reset}`);
                    }
                    console.log(`\n  ${c.dim}/cron on <id> · /cron off <id>${c.reset}\n`);
                }
            } else if (sub === 'on') {
                if (!jobId) { log(c.red, '✗', 'Usage: /cron on <id>'); }
                else { const r = cron.toggleJob(jobId, true); log(r.ok ? c.green : c.red, r.ok ? '✓' : '✗', r.msg); }
            } else if (sub === 'off') {
                if (!jobId) { log(c.red, '✗', 'Usage: /cron off <id>'); }
                else { const r = cron.toggleJob(jobId, false); log(r.ok ? c.green : c.red, r.ok ? '✓' : '✗', r.msg); }
            } else {
                log(c.red, '✗', 'Usage: /cron · /cron on <id> · /cron off <id>');
            }
            rl.prompt();
            return;
        }

        if (userInput === '/help') {
            console.log(`\n${c.cyan}${c.bold}Commands:${c.reset}`);
            console.log(`  ${c.cyan}/new${c.reset}          Start new conversation`);
            console.log(`  ${c.cyan}/stop${c.reset}         Stop current response`);
            console.log(`  ${c.cyan}/list${c.reset}         List all conversations`);
            console.log(`  ${c.cyan}/switch N${c.reset}     Switch to conversation #N`);
            console.log(`  ${c.cyan}/delete N${c.reset}     Delete conversation #N`);
            console.log(`  ${c.cyan}/model${c.reset}        Show/switch model (flash/low/high)`);
            console.log(`  ${c.cyan}/mode${c.reset}         Show/switch mode (planning/fast)`);
            console.log(`  ${c.cyan}/agentic${c.reset}      Toggle agentic on/off`);
            console.log(`  ${c.cyan}/yolo${c.reset}         Toggle auto-approve all permissions`);
            console.log(`  ${c.cyan}/ws <name>${c.reset}    Switch workspace`);
            console.log(`  ${c.cyan}/cron${c.reset}         Cron job management`);
            console.log(`  ${c.cyan}/usage${c.reset}        Model quota & remaining usage`);
            console.log(`  ${c.cyan}/restart${c.reset}      Warm restart (re-auth, keep Antigravity)`);
            console.log(`  ${c.cyan}/restart cold${c.reset} Cold restart (kill Antigravity + re-auth)`);
            console.log(`  ${c.cyan}/help${c.reset}         Show this help`);
            console.log(`  ${c.cyan}exit${c.reset}          Quit\n`);
            rl.prompt();
            return;
        }

        if (userInput === '/usage') {
            log(c.cyan, '⌛', 'Fetching quota from Language Server...');
            try {
                const info = await getUsage(session.auth);
                console.log(`\n${c.cyan}${c.bold}📊 Antigravity Model Usage${c.reset}`);
                console.log(`${c.cyan}Tier: ${c.reset}${c.bold}${info.userTier}${c.reset}\n`);
                if (info.models.length === 0) {
                    log(c.yellow, '⚠', 'No per-model quota data returned by server.');
                } else {
                    for (const m of info.models) {
                        const pct = m.pct !== null ? m.pct : null;
                        const pctStr = pct !== null ? `${pct}%` : '?';
                        let bar = '';
                        if (pct !== null) {
                            const filled = Math.round(pct / 5);
                            bar = ' [' + '█'.repeat(filled) + '░'.repeat(20 - filled) + ']';
                        }
                        const color = pct === null ? c.gray : pct < 20 ? c.red : pct < 50 ? c.yellow : c.green;
                        const reset = m.resetTime ? `  ${c.dim}(reset: ${new Date(m.resetTime).toLocaleString()})${c.reset}` : '';
                        console.log(`  ${color}${c.bold}${m.label}${c.reset}`);
                        console.log(`    Remaining: ${color}${pctStr}${c.reset}${bar}${reset}`);
                    }
                }
                console.log();
            } catch (e) {
                log(c.red, '✗', `Usage fetch failed: ${e.message}`);
            }
            rl.prompt();
            return;
        }

        // ── Send message ──
        _cliBusy = true;
        rl.pause();
        thinkingShown = false;
        process.stdout.write(`\n${c.green}${c.bold}${appName}: ${c.reset}`);
        const ok = await session.send(userInput);
        if (!ok) {
            rl.resume();
            rl.prompt();
            return;
        }
        // turnDone event will resume rl and prompt
    });

    // ── Cron queue watcher (check every 30s when idle) ──
    setInterval(() => {
        if (_cliBusy || _cronActive) return;
        processCronQueue();
    }, 30000);

    rl.on('close', () => {
        log(c.yellow, '👋', 'Disconnected.');
        session.destroy();
        process.exit(0);
    });
}

// ─── Interactive tool approval ───────────────────────────────────────────────
async function handleToolApproval(rl, session, perm, appName) {
    const tc = perm.toolCall || perm;
    const ctx = perm.contextTool || tc;

    if (perm.type === 'browser') {
        const url = ctx.Url || ctx.PageIdToReplace || '';
        process.stdout.write(`\n\n${c.yellow}${c.bold}⚠ Browser permission required${c.reset}`);
        if (url) process.stdout.write(`\n  ${c.cyan}URL:${c.reset} ${url}`);
        process.stdout.write(`\n\n  ${c.cyan}1${c.reset}) Allow this conversation\n`);
        process.stdout.write(`  ${c.cyan}2${c.reset}) Allow once\n`);
        process.stdout.write(`  ${c.cyan}3${c.reset}) Deny\n`);
        rl.resume();
        const answer = await new Promise(r => rl.question(`${c.yellow}Choose (1-3): ${c.reset}`, r));
        const choice = parseInt(answer);
        const allowed = choice !== 3;
        log(allowed ? c.green : c.red, allowed ? '✓' : '✗', allowed ? 'Allowed' : 'Denied');
        await session.approvePermission(perm, allowed);

    } else if (perm.type === 'file') {
        const filePath = perm.permissionPath || ctx.DirectoryPath || ctx.AbsolutePath || ctx.TargetFile || ctx.argsRaw || '';
        process.stdout.write(`\n\n${c.yellow}${c.bold}⚠ File access permission required${c.reset}`);
        if (filePath) process.stdout.write(`\n  ${c.cyan}Path:${c.reset} ${filePath}`);
        if (ctx.toolName) process.stdout.write(`\n  ${c.cyan}Tool:${c.reset} ${ctx.toolName}`);
        process.stdout.write(`\n\n  ${c.cyan}1${c.reset}) Allow this conversation\n`);
        process.stdout.write(`  ${c.cyan}2${c.reset}) Allow once\n`);
        process.stdout.write(`  ${c.cyan}3${c.reset}) Deny\n`);
        rl.resume();
        const answer = await new Promise(r => rl.question(`${c.yellow}Choose (1-3): ${c.reset}`, r));
        const choice = parseInt(answer);
        const allowed = choice !== 3;
        const scope = choice === 2 ? 'PERMISSION_SCOPE_TURN' : 'PERMISSION_SCOPE_CONVERSATION';
        log(allowed ? c.green : c.red, allowed ? '✓' : '✗', allowed ? `Allowed (${scope})` : 'Denied');
        await session.approvePermission(perm, allowed, { scope });

    } else if (perm.type === 'run_command') {
        process.stdout.write(`\n\n${c.yellow}${c.bold}⚠ Command approval required:${c.reset}\n`);
        process.stdout.write(`  ${c.cyan}Command:${c.reset} ${tc.CommandLine}\n`);
        if (tc.Cwd) process.stdout.write(`  ${c.cyan}Cwd:${c.reset} ${tc.Cwd}\n`);
        process.stdout.write(`\n  ${c.cyan}1${c.reset}) Always run\n`);
        process.stdout.write(`  ${c.cyan}2${c.reset}) Run once\n`);
        process.stdout.write(`  ${c.cyan}3${c.reset}) Reject\n`);
        process.stdout.write(`  ${c.cyan}4${c.reset}) Edit command\n`);
        rl.resume();
        const answer = await new Promise(r => rl.question(`${c.yellow}Choose (1-4): ${c.reset}`, r));
        const choice = parseInt(answer);
        let allowed = true;
        let editedCommand = null;
        if (choice === 3) {
            allowed = false;
            log(c.red, '✗', 'Rejected');
        } else if (choice === 4) {
            editedCommand = await new Promise(r => rl.question(`${c.cyan}New command: ${c.reset}`, r));
            log(c.green, '✓', `Modified: ${editedCommand}`);
        } else {
            log(c.green, '✓', `Approved: ${tc.CommandLine}`);
        }
        await session.approvePermission(perm, allowed, { editedCommand });

    } else {
        process.stdout.write(`\n\n${c.yellow}${c.bold}⚠ Unknown permission type: ${perm.type}${c.reset}`);
        if (ctx.toolName) process.stdout.write(`\n  ${c.cyan}Tool:${c.reset} ${ctx.toolName}`);
        process.stdout.write(`\n  ${c.red}Please approve in IDE${c.reset}\n`);
    }
}

main().catch(err => {
    flog(`[FATAL] ${err.message}\n${err.stack}`);
    console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
    process.exit(1);
});
