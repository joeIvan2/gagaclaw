#!/usr/bin/env node
/**
 * Gagaclaw Telegram v1.1 — Telegram Bot Interface
 * Uses core.js engine, provides edit-in-place streaming, message queue, inline keyboard permission
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { createSession, MODELS, MODEL_BY_ID, MODES, loadConfig, getCurrentWorkspace, listWorkspaces, switchWorkspace, splitText, LOCAL_VERSION, checkUpdate, checkPort, getUsage } = require('./core');
const cron = require('./cronjob');

// ─── Config ──────────────────────────────────────────────────────────────────
const cfg = loadConfig();
const TG_TOKEN = process.env.TG_TOKEN
    || (process.argv.find(a => a.startsWith('--token=')) || '').slice(8)
    || cfg.telegram?.token || '';
const ALLOWED_USERS = new Set((cfg.telegram?.allowedUsers || []).map(String));
const ADMIN_CHAT_ID = cfg.telegram?.adminChatId || (cfg.telegram?.allowedUsers || [])[0] || null;
const APP_NAME = cfg.app?.name || 'Antigravity';


if (!TG_TOKEN) { console.error('No Telegram token. Set telegram.token in gagaclaw.json or TG_TOKEN env.'); process.exit(1); }

// ─── Telegram API (raw HTTP, no dependencies) ───────────────────────────────
let _rateLimitUntil = 0; // timestamp until which we must wait

function tgRequest(method, params = {}) {
    return new Promise(async resolve => {
        // Respect rate limit
        const wait = _rateLimitUntil - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));

        const body = Buffer.from(JSON.stringify(params));
        const req = https.request({
            hostname: 'api.telegram.org', port: 443,
            path: `/bot${TG_TOKEN}/${method}`, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const r = JSON.parse(data);
                    // Handle rate limit: wait and retry once
                    if (r.error_code === 429 && r.parameters?.retry_after) {
                        const retryMs = r.parameters.retry_after * 1000 + 500;
                        _rateLimitUntil = Date.now() + retryMs;
                        flog(`[RATE_LIMIT] ${method}: waiting ${r.parameters.retry_after}s`);
                        setTimeout(() => tgRequest(method, params).then(resolve), retryMs);
                        return;
                    }
                    resolve(r);
                } catch { resolve({ ok: false }); }
            });
        });
        req.on('error', () => resolve({ ok: false }));
        req.write(body); req.end();
    });
}

function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Restore Telegram-supported HTML tags that were escaped by escapeHtml
// Note: <br> is NOT supported by Telegram — convert to \n instead
const TG_TAGS = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'blockquote', 'a', 'tg-spoiler', 'tg-emoji'];
const TG_TAG_RE = new RegExp(`&lt;(/?(?:${TG_TAGS.join('|')})(?:\\s[^&]*?)?)&gt;`, 'gi');
function restoreTgTags(html) {
    // <br> / <br/> → newline
    html = html.replace(/&lt;br\s*\/?\s*&gt;/gi, '\n');
    return html.replace(TG_TAG_RE, '<$1>');
}

// Fix unclosed/misnested HTML tags for Telegram strict parser
function fixTgHtml(html) {
    const tagStack = [];
    // Match opening and closing tags
    const tagRe = /<(\/?)(\w+)(?:\s[^>]*)?>/g;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const isClose = m[1] === '/';
        const tag = m[2].toLowerCase();
        if (!['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'blockquote', 'tg-spoiler', 'a'].includes(tag)) continue;
        if (isClose) {
            // Find matching open tag
            const idx = tagStack.lastIndexOf(tag);
            if (idx >= 0) {
                // Close any tags opened after this one (fix nesting)
                for (let j = tagStack.length - 1; j > idx; j--) {
                    html = html.slice(0, m.index) + `</${tagStack[j]}>` + html.slice(m.index);
                    tagRe.lastIndex += tagStack[j].length + 3;
                    m.index += tagStack[j].length + 3;
                    tagStack.pop();
                }
                tagStack.splice(idx, 1);
            } else {
                // Stray close tag — strip it
                html = html.slice(0, m.index) + html.slice(m.index + m[0].length);
                tagRe.lastIndex = m.index;
            }
        } else {
            tagStack.push(tag);
        }
    }
    // Close any remaining unclosed tags (in reverse order)
    for (let i = tagStack.length - 1; i >= 0; i--) {
        html += `</${tagStack[i]}>`;
    }
    return html;
}

// Simple Markdown → Telegram HTML
function mdToHtml(text) {
    let html = escapeHtml(text);
    // Code blocks: ```lang\n...\n``` → <pre>
    html = html.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, '<pre>$1</pre>');
    html = html.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
    // Inline code: `...` → <code>
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // Bold: **...** → <b>
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // Italic: *...* → <i> (but not inside <b>)
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>');
    // Blockquote: > line
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    // Restore any Telegram-supported HTML tags that AI wrote directly
    html = restoreTgTags(html);
    // Fix unclosed/misnested tags for Telegram strict parser
    html = fixTgHtml(html);
    return html;
}

async function tgSend(chatId, text, opts = {}) {
    const safeText = String(text || '(empty)').slice(0, 4000);
    const r = await tgRequest('sendMessage', { chat_id: chatId, text: safeText, ...opts });
    return r.ok ? r.result.message_id : null;
}

async function tgEdit(chatId, msgId, text, opts = {}) {
    if (!msgId) return false;
    const safeText = String(text || '(empty)').slice(0, 4000);
    const r = await tgRequest('editMessageText', { chat_id: chatId, message_id: msgId, text: safeText, ...opts });
    if (!r.ok) flog(`[tgEdit] FAIL msgId=${msgId} len=${safeText.length} err=${r.description || JSON.stringify(r).slice(0, 200)}`);
    return r.ok;
}

async function tgDraft(chatId, draftId, text, opts = {}) {
    const safeText = String(text || '').slice(0, 4000);
    if (!safeText) return false;
    const r = await tgRequest('sendMessageDraft', { chat_id: chatId, draft_id: draftId, text: safeText, ...opts });
    if (!r.ok) flog(`[tgDraft] FAIL draftId=${draftId} len=${safeText.length} err=${r.description || JSON.stringify(r).slice(0, 200)}`);
    return r.ok;
}

async function tgSendButtons(chatId, text, buttons, opts = {}) {
    const safeText = String(text || '(empty)').slice(0, 4000);
    const r = await tgRequest('sendMessage', {
        chat_id: chatId, text: safeText,
        reply_markup: { inline_keyboard: buttons },
        ...opts,
    });
    return r.ok ? r.result.message_id : null;
}

async function tgAnswer(callbackQueryId, text = '') {
    return tgRequest('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

function tgDeleteMessage(chatId, msgId) {
    return tgRequest('deleteMessage', { chat_id: chatId, message_id: msgId });
}

// Send a message that auto-deletes after `ms` milliseconds
async function tgSendTemp(chatId, text, opts = {}, ms = 60000) {
    const msgId = await tgSend(chatId, text, opts);
    if (msgId) setTimeout(() => tgDeleteMessage(chatId, msgId), ms);
    return msgId;
}

async function tgSendDocument(chatId, filePath) {
    const fileName = path.basename(filePath);
    let fileData;
    try { fileData = fs.readFileSync(filePath); } catch (e) { return { ok: false }; }
    const boundary = 'TGBotBoundary' + Date.now().toString(16);
    const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, fileData, tail]);
    return new Promise(resolve => {
        const req = https.request({
            hostname: 'api.telegram.org', port: 443,
            path: `/bot${TG_TOKEN}/sendDocument`, method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
        });
        req.on('error', () => resolve({ ok: false }));
        req.write(body); req.end();
    });
}

async function tgGetFile(fileId) {
    const r = await tgRequest('getFile', { file_id: fileId });
    if (r.ok) return r.result.file_path;
    return null;
}

function downloadFile(filePath, destPath) {
    return new Promise((resolve, reject) => {
        const url = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;
        https.get(url, res => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Failed to download: ${res.statusCode}`));
            }
            const stream = fs.createWriteStream(destPath);
            res.pipe(stream);
            stream.on('finish', () => { stream.close(); resolve(destPath); });
            stream.on('error', reject);
        }).on('error', reject);
    });
}

function getWorkspaceDownloadDir() {
    const wsDir = path.join(__dirname, getCurrentWorkspace(), 'download');
    if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, { recursive: true });
    return wsDir;
}

// ─── Log file (cleared on each startup) ──────────────────────────────────────
const tgLog = fs.createWriteStream(path.join(__dirname, 'telegram.log'), { flags: 'w' });
const logTs = () => new Date().toISOString().slice(11, 23);
function flog(msg) { tgLog.write(`[${logTs()}] ${msg}\n`); }

// ─── Core logger → console ──────────────────────────────────────────────────
function coreLogger(level, msg) {
    flog(`[${level}] ${msg}`);
    const prefix = level === 'error' ? '✗' : level === 'info' ? '✓' : 'ℹ';
    console.log(`[${prefix}] ${msg}`);
}

// ─── IDE sync helpers ────────────────────────────────────────────────────────
async function getIdeChatPage() {
    const cdpPorts = cfg.defaults?.cdpPorts || [9229];
    const cdpHost = cfg.defaults?.cdpHost || '127.0.0.1';

    let cdpPort = null;
    for (const p of cdpPorts) {
        if (await checkPort(p, cdpHost)) { cdpPort = p; break; }
    }
    if (!cdpPort) throw new Error(`找不到 ${APP_NAME} 的 CDP port`);

    const browser = await puppeteer.connect({
        browserURL: `http://${cdpHost}:${cdpPort}`,
        defaultViewport: null,
    });

    let page = null;
    for (const p of await browser.pages()) {
        const title = await p.title().catch(() => '');
        if (!title.includes(APP_NAME) || title === 'Manager' || title === 'Launchpad') continue;
        try {
            const ok = await p.evaluate(() => {
                const hasAskAnything = Array.from(document.querySelectorAll('p, div, span')).some(el =>
                    el.innerText && el.innerText.includes('Ask anything')
                );
                return hasAskAnything || !!document.querySelector('[contenteditable="true"]');
            });
            if (ok) { page = p; break; }
        } catch { }
    }

    if (!page) { browser.disconnect(); throw new Error('找不到聊天視窗'); }
    return { browser, page };
}

async function navigateToCascade(page, targetCascadeId) {
    if (!targetCascadeId) return false;

    await page.evaluate(() => {
        const btn = document.querySelector('a[data-tooltip-id="new-conversation-tooltip"]');
        if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    const found = await page.evaluate((cid) => {
        const svg = document.querySelector(`svg[data-tooltip-id="${cid}-delete-conversation"]`);
        if (!svg) return false;
        let el = svg;
        while (el && el.tagName !== 'BUTTON') el = el.parentElement;
        if (el) { el.click(); return true; }
        return false;
    }, targetCascadeId);

    return found;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n═══════════════════════════════════════════════`);
    console.log(`  ${APP_NAME} Telegram Bot v${LOCAL_VERSION}`);
    console.log(`═══════════════════════════════════════════════\n`);

    // Connect & create session
    const { session, auth, resumed, id, title } = await createSession(coreLogger);
    console.log(resumed
        ? `[✓] Resumed: ${id.substring(0, 8)}... — ${title}`
        : `[✓] New cascade: ${id.substring(0, 8)}...`);
    console.log(`[🤖] Model: ${session.modelLabel} | Mode: ${session.modeLabel} | Agentic: ${session.agenticEnabled} | YOLO: ${session.yoloMode ? 'ON' : 'OFF'}`);

    // Version check (non-blocking)
    checkUpdate().then(v => {
        if (v.upToDate === false) {
            const msg = `[⬆] Update available: v${v.local} → v${v.remote}  (git pull to update)`;
            console.log(msg);
            if (ADMIN_CHAT_ID) tgSend(String(ADMIN_CHAT_ID), `⬆️ Gagaclaw update: <b>v${v.local}</b> → <b>v${v.remote}</b>\nRun <code>git pull</code> to update.`, { parse_mode: 'HTML' }).catch(() => { });
        } else if (v.upToDate) {
            console.log(`[✓] Gagaclaw v${v.local} (up to date)`);
        } else {
            console.log(`[✓] Gagaclaw v${v.local} (update check failed)`);
        }
    });

    // Per-chat state (keyed by chatId)
    const chatState = {};
    function getChat(chatId) {
        if (!chatState[chatId]) {
            chatState[chatId] = {
                busy: false,
                queue: [],
                draftId: null,
                placeholderMsgId: null, // fallback when draft not supported
                thinkingText: '',
                responseText: '',
                lastEditTime: 0,
                lastEditContent: '',
                editTimer: null,
            };
        }
        return chatState[chatId];
    }

    const HTML = { parse_mode: 'HTML' };

    // ── Cron queue state ─────────────────────────────────────────────────────
    let _cronPending = [];    // buffered cron queue items
    let _cronActive = null;   // currently executing cron job
    let _savedModel = null;   // saved settings for restore after cron job
    let _savedMode = null;
    let _savedAgentic = null;

    // ── Streaming display helpers ────────────────────────────────────────────
    function scheduleEdit(chatId) {
        const st = getChat(chatId);
        if (st.editTimer) return; // already scheduled
        const elapsed = Date.now() - st.lastEditTime;
        // Draft mode: 300ms throttle; fallback edit mode: 1s throttle
        const interval = st.draftId ? 300 : 1000;
        const delay = Math.max(0, interval - elapsed);
        st.editTimer = setTimeout(async () => {
            st.editTimer = null;
            st.lastEditTime = Date.now();
            if (!st.responseText) return; // thinking is shown via thinking handler

            // Show last 3000 chars during streaming (full text sent in turnDone)
            const tail = st.responseText.length > 3000 ? '…' + st.responseText.slice(-3000) : st.responseText;
            const display = mdToHtml(tail);
            const truncated = display.slice(0, 3900);

            // Skip if content hasn't changed (avoid "message is not modified" spam)
            if (truncated === st.lastEditContent) return;
            st.lastEditContent = truncated;

            // Draft mode: use sendMessageDraft
            if (st.draftId) {
                const ok = await tgDraft(chatId, st.draftId, truncated, HTML);
                if (!ok && !st.placeholderMsgId) {
                    // Draft failed — fallback to sendMessage + edit mode
                    flog(`[DRAFT_FALLBACK] draft failed, switching to edit mode`);
                    st.draftId = null;
                    st.placeholderMsgId = await tgSend(chatId, truncated, HTML)
                        || await tgSend(chatId, tail.slice(0, 3900));
                }
                return;
            }

            // Fallback: editMessageText mode
            if (!st.placeholderMsgId) return;
            const ok = await tgEdit(chatId, st.placeholderMsgId, truncated, HTML);
            if (!ok) {
                await tgEdit(chatId, st.placeholderMsgId, tail.slice(0, 3900));
            }
        }, delay);
    }

    // ── Wire session events ──────────────────────────────────────────────────
    // We use a single session, broadcasting to the active chat
    let activeChatId = ADMIN_CHAT_ID;

    session.on('thinking', (delta, full) => {
        if (!activeChatId) return;
        const st = getChat(activeChatId);
        st.thinkingText = full;
        // Continuously update thinking display (last ~3000 chars), throttled
        if (!st.responseText) {
            if (!st._thinkingTimer) {
                st._thinkingTimer = setTimeout(async () => {
                    st._thinkingTimer = null;
                    if (!st.thinkingText || st.responseText) return;
                    const preview = st.thinkingText.length > 3000 ? '…' + st.thinkingText.slice(-3000) : st.thinkingText;
                    const html = `💭 <i>${escapeHtml(preview)}</i>`;
                    if (html === st._lastThinkingHtml) return;
                    st._lastThinkingHtml = html;

                    if (st.draftId) {
                        await tgDraft(activeChatId, st.draftId, html, HTML);
                    } else if (st.placeholderMsgId) {
                        await tgEdit(activeChatId, st.placeholderMsgId, html, HTML);
                    }
                }, 1500);
            }
        }
    });

    session.on('response', (delta, full) => {
        if (!activeChatId) return;
        const st = getChat(activeChatId);
        // Accumulate via delta — core.js resets _lastResponse after tool approval,
        // so `full` only contains text since last reset; delta accumulation preserves all text
        st.responseText += delta;
        scheduleEdit(activeChatId);
    });

    session.on('toolCall', (tc) => {
        if (!activeChatId) return;
        // notify_user: AI's message to the user — treat as response text
        if (tc.toolName === 'notify_user' && tc.Message) {
            const st = getChat(activeChatId);
            if (st.responseText) st.responseText += '\n\n';
            st.responseText += tc.Message;
            scheduleEdit(activeChatId);
            return;
        }
        if (tc.toolName === 'run_command' && tc.SafeToAutoRun !== false && tc.CommandLine) {
            tgSendTemp(activeChatId, `⚙️ <code>${escapeHtml(tc.CommandLine)}</code>`, HTML).catch(() => { });
        } else if (tc.toolName && tc.toolName !== 'run_command') {
            const detail = tc.CommandLine || tc.AbsolutePath || tc.Url || tc.Task || '';
            const short = detail ? ` — ${detail.slice(0, 100)}` : '';
            tgSendTemp(activeChatId, `🔧 <b>${escapeHtml(tc.toolName)}</b>${escapeHtml(short)}`, HTML).catch(() => { });
        }
    });

    session.on('permissionWait', (perm) => {
        if (!activeChatId) return;
        handlePermission(activeChatId, perm);
    });

    session.on('yoloApprove', (desc) => {
        if (!activeChatId) return;
        tgSendTemp(activeChatId, `⚡ YOLO: ${escapeHtml(desc)}`, HTML).catch(() => { });
    });

    session.on('yoloError', (desc) => {
        if (!activeChatId) return;
        tgSend(activeChatId, `❌ YOLO 失敗: ${escapeHtml(desc)}`, HTML).catch(() => { });
    });

    session.on('newStep', () => {
        if (!activeChatId) return;
        const st = getChat(activeChatId);
        st.thinkingText = '';
        if (st._thinkingTimer) { clearTimeout(st._thinkingTimer); st._thinkingTimer = null; }
        // Don't reset responseText — it accumulates across steps
    });

    session.on('turnDone', () => {
        if (!activeChatId) return;
        const st = getChat(activeChatId);

        // Final response
        if (st.editTimer) { clearTimeout(st.editTimer); st.editTimer = null; }
        const finalText = st.responseText || st.thinkingText || '(no response)';
        const src = st.responseText ? 'response' : st.thinkingText ? 'thinking' : 'none';
        flog(`[TURN_DONE] src=${src} len=${finalText.length}`);
        flog(`[TURN_DONE] text_preview: ${finalText.slice(0, 200)}`);

        const chunks = splitText(finalText, 3500);
        flog(`[TURN_DONE] chunks=${chunks.length} sizes=[${chunks.map(c => c.length).join(',')}]`);
        (async () => {
            // Delete the streaming message, then send all chunks as new messages
            if (st.draftId) {
                st.draftId = null;
            }
            if (st.placeholderMsgId) {
                tgDeleteMessage(activeChatId, st.placeholderMsgId);
                st.placeholderMsgId = null;
            }

            for (const chunk of chunks) {
                const chunkHtml = mdToHtml(chunk);
                const mid = await tgSend(activeChatId, chunkHtml, HTML);
                if (!mid) await tgSend(activeChatId, chunk);
            }

            // Reset state & dequeue
            st.busy = false;
            st.draftId = null;
            st.placeholderMsgId = null;
            st.thinkingText = '';
            st.responseText = '';
            st.lastEditContent = '';
            st._lastThinkingHtml = '';
            if (st._thinkingTimer) { clearTimeout(st._thinkingTimer); st._thinkingTimer = null; }
            dequeue(activeChatId);
        })();
    });

    session.on('streamReconnect', () => {
        console.log('[⟳] Stream reconnecting...');
    });

    session.on('permissionResolved', () => {
        // Permission handled, stream continues
    });

    session.on('error', (msg) => {
        flog(`[ERROR] ${msg}`);
        console.log(`[✗] ${msg}`);
        if (activeChatId) {
            tgSend(activeChatId, `❌ ${escapeHtml(msg)}`, HTML).catch(() => { });
        }
    });

    // ── Permission → inline keyboard ─────────────────────────────────────────
    let pendingPerms = {}; // msgId → perm

    async function handlePermission(chatId, perm) {
        const ctx = perm.contextTool || {};
        let text, buttons;

        if (perm.type === 'run_command') {
            const cmd = perm.CommandLine || ctx.CommandLine || '(command)';
            const cwd = ctx.Cwd || '';
            text = `⚠️ <b>Command approval</b>\n<code>${escapeHtml(cmd)}</code>`;
            if (cwd) text += `\n📁 ${escapeHtml(cwd)}`;
            buttons = [
                [{ text: '✅ Run', callback_data: 'perm_allow' }, { text: '❌ Reject', callback_data: 'perm_deny' }],
            ];
        } else if (perm.type === 'file') {
            const fp = perm.permissionPath || ctx.DirectoryPath || ctx.AbsolutePath || ctx.TargetFile || '';
            text = `⚠️ <b>File access</b>`;
            if (fp) text += `\n📄 <code>${escapeHtml(fp)}</code>`;
            if (ctx.toolName) text += `\n🔧 ${escapeHtml(ctx.toolName)}`;
            buttons = [
                [{ text: '✅ Allow', callback_data: 'perm_allow' }, { text: '❌ Deny', callback_data: 'perm_deny' }],
            ];
        } else if (perm.type === 'browser') {
            const url = ctx.Url || ctx.PageIdToReplace || '';
            text = `⚠️ <b>Browser permission</b>`;
            if (url) text += `\n🌐 ${escapeHtml(url)}`;
            buttons = [
                [{ text: '✅ Allow', callback_data: 'perm_allow' }, { text: '❌ Deny', callback_data: 'perm_deny' }],
            ];
        } else {
            text = `⚠️ <b>Permission: ${escapeHtml(perm.type)}</b>`;
            buttons = [
                [{ text: '✅ Allow', callback_data: 'perm_allow' }, { text: '❌ Deny', callback_data: 'perm_deny' }],
            ];
        }

        const msgId = await tgSendButtons(chatId, text, buttons, HTML);
        if (msgId) pendingPerms[msgId] = perm;
    }

    // ── Process message ──────────────────────────────────────────────────────
    async function processMessage(chatId, text) {
        const st = getChat(chatId);
        st.busy = true;
        st.thinkingText = '';
        st.responseText = '';
        st.lastEditTime = 0;
        st.placeholderMsgId = null;
        activeChatId = chatId;

        // Use sendMessageDraft for streaming (random non-zero draft_id)
        st.draftId = Math.floor(Math.random() * 2147483646) + 1;
        const draftOk = await tgDraft(chatId, st.draftId, '⏳ Thinking…');
        if (!draftOk) {
            // Fallback: classic sendMessage + editMessageText
            flog(`[DRAFT_FALLBACK] initial draft failed, using edit mode`);
            st.draftId = null;
            st.placeholderMsgId = await tgSend(chatId, '⏳ Thinking…');
        }

        const ok = await session.send(text);
        if (!ok) {
            if (st.draftId) {
                // Clear draft and send error as regular message
                await tgDraft(chatId, st.draftId, '❌ Failed to send message');
                st.draftId = null;
            } else if (st.placeholderMsgId) {
                await tgEdit(chatId, st.placeholderMsgId, '❌ Failed to send message');
            }
            st.busy = false;
            st.placeholderMsgId = null;
            dequeue(chatId);
        }
        // Events will handle display updates; turnDone will dequeue
    }

    // ── Queue ────────────────────────────────────────────────────────────────
    function enqueue(chatId, text) {
        const st = getChat(chatId);
        st.queue.push(text);
        tgSendTemp(chatId, `📋 Queued (#${st.queue.length}), waiting for current response...`).catch(() => { });
    }

    function dequeue(chatId) {
        const st = getChat(chatId);
        if (st.queue.length > 0) {
            const next = st.queue.shift();
            processMessage(chatId, next);
            return;
        }
        // IDLE — restore cron settings if needed, then check cron queue
        if (_cronActive) {
            if (_savedModel) session.setModel(_savedModel);
            if (_savedMode) session.setMode(_savedMode);
            if (_savedAgentic !== null) session.setAgentic(_savedAgentic);
            console.log(`[⏰] Cron job done, restored settings`);
            flog(`[CRON] Restored settings: model=${_savedModel} mode=${_savedMode} agentic=${_savedAgentic}`);
            _cronActive = null;
            _savedModel = null;
            _savedMode = null;
            _savedAgentic = null;
        }
        processCronQueue();
    }

    async function processCronQueue() {
        // Refill buffer from queue files
        if (_cronPending.length === 0) {
            _cronPending.push(...cron.consumeQueue('telegram'));
        }
        if (_cronPending.length === 0) return;

        const item = _cronPending.shift();
        _cronActive = item;
        const promptPreview = item.prompt?.slice(0, 50) || '';
        console.log(`[⏰] Cron job: ${item.id} → "${promptPreview}"`);
        flog(`[CRON] Processing job: ${item.id} prompt="${promptPreview}"`);

        // Save current settings & apply cron job settings (non-destructive: restore on turnDone)
        _savedModel = Object.entries(MODELS).find(([k, v]) => v.label === session.modelLabel)?.[0] || null;
        _savedMode = Object.entries(MODES).find(([k, v]) => v.label === session.modeLabel)?.[0] || null;
        _savedAgentic = session.agenticEnabled;

        if (item.model) session.setModel(item.model);
        if (item.mode) session.setMode(item.mode);
        if (item.agentic !== null && item.agentic !== undefined) session.setAgentic(item.agentic);

        const chatId = String(item.chatId || ADMIN_CHAT_ID);
        if (!chatId) {
            console.log(`[⏰] No chatId for job ${item.id}, skipping`);
            flog(`[CRON] No chatId for job ${item.id}, skipping`);
            _cronActive = null;
            processCronQueue(); // try next
            return;
        }
        console.log(`[⏰] Sending to chat ${chatId} (model=${item.model || 'current'} mode=${item.mode || 'current'})`);
        await tgSend(chatId, `⏰ ${escapeHtml(item.prompt)}`, 'HTML');
        processMessage(chatId, item.prompt);
    }

    // ── Command handlers ─────────────────────────────────────────────────────
    async function handleCommand(chatId, text) {
        const cmd = text.split(/\s+/)[0].toLowerCase();
        const arg = text.slice(cmd.length).trim();

        switch (cmd) {
            case '/start':
            case '/help':
                await tgSend(chatId, [
                    `<b>${escapeHtml(APP_NAME)} Telegram Bot</b>\n`,
                    `/new — New conversation`,
                    `/stop — Stop response`,
                    `/list — List conversations`,
                    `/switch N — Switch to conversation N`,
                    `/delete N — Delete conversation N`,
                    `/model [flash|low|high] — Model`,
                    `/mode [planning|fast] — Mode`,
                    `/agentic [on|off] — Tool usage`,
                    `/yolo [on|off] — Auto-approve`,
                    `/ws [name] — Switch workspace`,
                    `/cron — Cron job management`,
                    `/usage — Model quota & usage`,
                    `/sync — Sync IDE to current conversation`,
                    `/restart — Warm restart`,
                    `/restart cold — Cold restart (kill app)`,
                    `/help — Show this help`,
                ].join('\n'), HTML);
                return true;

            case '/new': {
                const newId = await session.startNewCascade();
                if (newId) {
                    session.cascadeId = newId;
                    session.openStream();
                    await tgSend(chatId, `✅ New conversation: ${newId.substring(0, 8)}...`);
                } else {
                    await tgSend(chatId, '❌ Failed to create conversation');
                }
                return true;
            }

            case '/stop': {
                const res = await session.stop();
                const st = getChat(chatId);
                if (st.busy) {
                    st.busy = false;
                    st.draftId = null;
                    if (st.editTimer) { clearTimeout(st.editTimer); st.editTimer = null; }
                }
                await tgSend(chatId, res.status === 200 ? '✅ Stopped' : '❌ Stop failed');
                return true;
            }

            case '/list': {
                const list = await session.listCascades();
                if (list.length === 0) { await tgSend(chatId, '⚠️ No conversations'); return true; }
                const lines = [`<b>Conversations (${list.length}):</b>\n`];
                const rows = [];
                for (let i = 0; i < Math.min(list.length, 15); i++) {
                    const e = list[i];
                    const cur = e.id === session.cascadeId ? '▶ ' : '  ';
                    const ttl = e.summary || '(untitled)';
                    lines.push(`${cur}<b>${i + 1}</b>) ${e.id.slice(0, 8)}... ${escapeHtml(ttl.slice(0, 40))}`);
                    rows.push([
                        { text: `▶ Switch ${i + 1}`, callback_data: `cmd_switch_${i + 1}` },
                        { text: `🗑 Delete ${i + 1}`, callback_data: `cmd_delete_${i + 1}` },
                    ]);
                }
                await tgSendButtons(chatId, lines.join('\n'), rows, HTML);
                return true;
            }

            case '/switch': {
                const num = parseInt(arg);
                const list = await session.listCascades();
                if (!num || num < 1 || num > list.length) {
                    await tgSend(chatId, `❌ Use /list first, then /switch 1~${list.length}`);
                } else {
                    session.switchCascade(list[num - 1].id);
                    const ttl = list[num - 1].summary || '(untitled)';
                    await tgSend(chatId, `✅ Switched: ${list[num - 1].id.slice(0, 8)}... — ${escapeHtml(ttl)}`, HTML);
                }
                return true;
            }

            case '/delete': {
                const num = parseInt(arg);
                const list = await session.listCascades();
                if (!num || num < 1 || num > list.length) {
                    await tgSend(chatId, `❌ Use /list first, then /delete N`);
                } else {
                    const target = list[num - 1];
                    const ok = await session.deleteCascade(target.id);
                    await tgSend(chatId, ok
                        ? `✅ Deleted #${num}: ${escapeHtml((target.summary || '').slice(0, 40))}`
                        : '❌ Delete failed', HTML);
                    if (ok && !session.cascadeId) {
                        await tgSend(chatId, '⚠️ Current conversation deleted. Use /new or /switch');
                    }
                }
                return true;
            }

            case '/model': {
                if (arg) {
                    if (session.setModel(arg.toLowerCase())) {
                        await tgSend(chatId, `✅ Model → ${session.modelLabel}`);
                    } else {
                        await tgSend(chatId, '❌ Unknown model\nflash / low / high / opus / sonnet / gpt');
                    }
                } else {
                    const curKey = Object.entries(MODELS).find(([, v]) => v.label === session.modelLabel)?.[0];
                    const keys = Object.keys(MODELS);
                    const btns = keys.map(k => ({
                        text: (k === curKey ? '✓ ' : '') + MODELS[k].label.split(' (')[0],
                        callback_data: `cmd_model_${k}`,
                    }));
                    // 2 per row
                    const rows = [];
                    for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
                    await tgSendButtons(chatId, `🤖 Current model: <b>${escapeHtml(session.modelLabel)}</b>`, rows, HTML);
                }
                return true;
            }

            case '/mode': {
                if (arg) {
                    if (session.setMode(arg.toLowerCase())) {
                        await tgSend(chatId, `✅ Mode → ${session.modeLabel}`);
                    } else {
                        await tgSend(chatId, '❌ Unknown mode\nplanning / fast');
                    }
                } else {
                    const curKey = Object.entries(MODES).find(([, v]) => v.label === session.modeLabel)?.[0];
                    const btns = Object.keys(MODES).map(k => ({
                        text: (k === curKey ? '✓ ' : '') + MODES[k].label.split(' (')[0],
                        callback_data: `cmd_mode_${k}`,
                    }));
                    await tgSendButtons(chatId, `⚙️ Current mode: <b>${escapeHtml(session.modeLabel)}</b>`, [btns], HTML);
                }
                return true;
            }

            case '/agentic': {
                const v = arg.toLowerCase();
                if (v === 'on' || v === 'true' || v === '1') {
                    session.setAgentic(true);
                    await tgSend(chatId, '✅ Agentic → ON');
                } else if (v === 'off' || v === 'false' || v === '0') {
                    session.setAgentic(false);
                    await tgSend(chatId, '✅ Agentic → OFF');
                } else {
                    const on = session.agenticEnabled;
                    await tgSendButtons(chatId, `Agentic: <b>${on ? 'ON' : 'OFF'}</b>`, [[
                        { text: (on ? '✓ ' : '') + 'ON', callback_data: 'cmd_agentic_on' },
                        { text: (!on ? '✓ ' : '') + 'OFF', callback_data: 'cmd_agentic_off' },
                    ]], HTML);
                }
                return true;
            }

            case '/yolo': {
                const v = arg.toLowerCase();
                if (v === 'on' || v === 'true' || v === '1') {
                    session.setYolo(true);
                    await tgSend(chatId, '⚡ YOLO → ON (auto-approve all permissions)');
                } else if (v === 'off' || v === 'false' || v === '0') {
                    session.setYolo(false);
                    await tgSend(chatId, '✅ YOLO → OFF');
                } else {
                    const on = session.yoloMode;
                    await tgSendButtons(chatId, `YOLO: <b>${on ? 'ON ⚡' : 'OFF'}</b>`, [[
                        { text: (on ? '✓ ' : '') + 'ON ⚡', callback_data: 'cmd_yolo_on' },
                        { text: (!on ? '✓ ' : '') + 'OFF', callback_data: 'cmd_yolo_off' },
                    ]], HTML);
                }
                return true;
            }

            case '/ws': {
                if (arg) {
                    const result = switchWorkspace(arg);
                    await tgSend(chatId, result.ok ? `✅ ${result.msg}` : `❌ ${result.msg}`);
                } else {
                    const current = getCurrentWorkspace();
                    const available = listWorkspaces();
                    if (available.length === 0) {
                        await tgSend(chatId, `📂 Current workspace: <b>${escapeHtml(current)}</b>\nNo other workspaces available`, HTML);
                    } else {
                        const btns = available.map(w => ({
                            text: (w === current ? '✓ ' : '') + w,
                            callback_data: `cmd_ws_${w}`,
                        }));
                        const rows = [];
                        for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
                        await tgSendButtons(chatId, `📂 Current workspace: <b>${escapeHtml(current)}</b>`, rows, HTML);
                    }
                }
                return true;
            }

            case '/cron': {
                const sub = arg.split(/\s+/)[0]?.toLowerCase() || '';
                const jobId = arg.split(/\s+/)[1] || '';

                if (!sub) {
                    const jobs = cron.listAllJobs();
                    if (jobs.length === 0) {
                        await tgSend(chatId, '📋 No cron jobs\n\nEdit <code>cronjobs.json</code> to add jobs', HTML);
                    } else {
                        const lines = [`<b>Cron Jobs (${jobs.length}):</b>\n`];
                        for (const j of jobs) lines.push(cron.formatJob(j));
                        const rows = jobs.map(j => [
                            { text: (j.enabled ? '✓ ' : '') + 'ON', callback_data: `cmd_cron_on_${j.id}` },
                            { text: (!j.enabled ? '✓ ' : '') + 'OFF', callback_data: `cmd_cron_off_${j.id}` },
                            { text: `📋 ${j.id}`, callback_data: `cmd_noop` },
                        ]);
                        await tgSendButtons(chatId, lines.join('\n'), rows, HTML);
                    }
                } else if (sub === 'on') {
                    if (!jobId) { await tgSend(chatId, '❌ Usage: /cron on &lt;id&gt;', HTML); }
                    else {
                        const r = cron.toggleJob(jobId, true);
                        await tgSend(chatId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`);
                    }
                } else if (sub === 'off') {
                    if (!jobId) { await tgSend(chatId, '❌ Usage: /cron off &lt;id&gt;', HTML); }
                    else {
                        const r = cron.toggleJob(jobId, false);
                        await tgSend(chatId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`);
                    }
                } else {
                    await tgSend(chatId, '❌ Usage: /cron · /cron on &lt;id&gt; · /cron off &lt;id&gt;', HTML);
                }
                return true;
            }

            case '/usage': {
                const usageMsg = await tgSend(chatId, '⏳ Fetching quota…');
                try {
                    const info = await getUsage(session.auth);
                    const lines = [`<b>📊 Antigravity Model Usage</b>\n`];
                    lines.push(`👤 Tier: <b>${escapeHtml(info.userTier)}</b>\n`);
                    if (info.models.length === 0) {
                        lines.push('ℹ️ No per-model quota data available.');
                    } else {
                        for (const m of info.models) {
                            const pct = m.pct !== null ? m.pct : null;
                            const pctStr = pct !== null ? `${pct}%` : '?';
                            const barLen = pct !== null ? Math.round(pct / 10) : 0;
                            const bar = pct !== null ? ' [' + '█'.repeat(barLen) + '░'.repeat(10 - barLen) + ']' : '';
                            const icon = pct === null ? '❔' : pct > 50 ? '🟢' : pct > 20 ? '🟡' : '🔴';
                            const reset = m.resetTime ? `\n    ⏰ Reset: ${new Date(m.resetTime).toLocaleString('zh-TW')}` : '';
                            lines.push(`${icon} <b>${escapeHtml(m.label)}</b>\n  Remaining: <code>${pctStr}</code>${bar}${reset}`);
                        }
                    }
                    const reply = lines.join('\n');
                    if (usageMsg) await tgEdit(chatId, usageMsg, reply, HTML);
                    else await tgSend(chatId, reply, HTML);
                } catch (e) {
                    const err = `❌ Usage fetch failed: <code>${escapeHtml(e.message)}</code>`;
                    if (usageMsg) await tgEdit(chatId, usageMsg, err, HTML);
                    else await tgSend(chatId, err, HTML);
                }
                return true;
            }

            case '/sync': {
                if (!session.cascadeId) {
                    await tgSend(chatId, '⚠️ 目前沒有活動對話');
                    return true;
                }
                const syncMsgId = await tgSend(chatId, '⟳ IDE 同步中…');
                let syncBrowser = null;
                try {
                    const ide = await getIdeChatPage();
                    syncBrowser = ide.browser;
                    const found = await navigateToCascade(ide.page, session.cascadeId);
                    const shortId = `${session.cascadeId.substring(0, 8)}...`;
                    const reply = found
                        ? `✅ IDE 已跳到目前對話 <code>${escapeHtml(shortId)}</code>`
                        : `⚠️ 找不到此 cascade（<code>${escapeHtml(shortId)}</code>）\n請先送出一則訊息後再 /sync`;
                    if (syncMsgId) await tgEdit(chatId, syncMsgId, reply, HTML);
                    else await tgSend(chatId, reply, HTML);
                } catch (e) {
                    const reply = `❌ /sync 失敗\n<code>${escapeHtml(e.message || String(e))}</code>`;
                    if (syncMsgId) await tgEdit(chatId, syncMsgId, reply, HTML);
                    else await tgSend(chatId, reply, HTML);
                } finally {
                    if (syncBrowser) try { syncBrowser.disconnect(); } catch { }
                }
                return true;
            }

            case '/restart': {
                const sub = arg.toLowerCase();
                if (sub === 'cold') {
                    await tgSend(chatId, `🔄 Cold restart — kill ${APP_NAME} + restart...`);
                    session.destroy();
                    const exeName = (loadConfig().app?.targetExecutables || ['Antigravity.exe'])[0];
                    if (process.platform === 'win32') {
                        try { require('child_process').execSync(`taskkill /IM ${exeName} /F`, { stdio: 'ignore' }); } catch { }
                    } else {
                        try { require('child_process').execSync(`pkill -9 -f ${exeName.replace(/\.exe$/i, '')}`, { stdio: 'ignore' }); } catch { }
                    }
                    await tgRequest('getUpdates', { offset: updateOffset, timeout: 0 }); // ACK updates before exit
                    process.exit(42);
                } else if (sub === 'warm' || sub === 'hot') {
                    await tgSend(chatId, '🔄 Warm restart...');
                    session.destroy();
                    await tgRequest('getUpdates', { offset: updateOffset, timeout: 0 }); // ACK updates before exit
                    process.exit(42);
                } else if (!arg) {
                    await tgSendButtons(chatId, '🔄 Choose restart type:', [[
                        { text: '♨️ Warm', callback_data: 'cmd_restart_warm' },
                        { text: '❄️ Cold', callback_data: 'cmd_restart_cold' },
                    ]], HTML);
                } else {
                    await tgSend(chatId, '🔄 Warm restart...');
                    session.destroy();
                    await tgRequest('getUpdates', { offset: updateOffset, timeout: 0 }); // ACK updates before exit
                    process.exit(42);
                }
                return true;
            }

            default:
                return false;
        }
    }

    // ── Telegram long-polling ────────────────────────────────────────────────
    let updateOffset = 0;

    // Clear stale cron queue on startup (avoid processing old accumulated jobs)
    const stale = cron.consumeQueue('telegram');
    if (stale.length > 0) {
        console.log(`[⏰] Cleared ${stale.length} stale cron queue item(s)`);
        flog(`[CRON] Cleared ${stale.length} stale queue item(s) on startup`);
    }

    // Clear stale updates on startup
    const init = await tgRequest('getUpdates', { offset: -1, timeout: 0 });
    if (init.ok && init.result?.length > 0) {
        updateOffset = init.result[init.result.length - 1].update_id + 1;
    }

    // Register bot commands for autocomplete
    const cmdResult = await tgRequest('setMyCommands', {
        commands: [
            { command: 'help', description: 'Show help' },
            { command: 'new', description: 'New conversation' },
            { command: 'stop', description: 'Stop response' },
            { command: 'list', description: 'List conversations' },
            { command: 'switch', description: 'Switch conversation (N)' },
            { command: 'delete', description: 'Delete conversation (N)' },
            { command: 'model', description: 'Switch model' },
            { command: 'mode', description: 'Switch mode' },
            { command: 'agentic', description: 'Tool usage on/off' },
            { command: 'yolo', description: 'Auto-approve on/off' },
            { command: 'ws', description: 'Switch workspace' },
            { command: 'cron', description: 'Cron job management' },
            { command: 'restart', description: 'Restart bot' },
        ],
    });
    console.log(cmdResult.ok ? '[✓] Bot commands registered' : `[✗] setMyCommands failed: ${JSON.stringify(cmdResult)}`);

    console.log('[✓] Telegram polling started');
    if (ADMIN_CHAT_ID) {
        tgSend(ADMIN_CHAT_ID, `✅ Gagaclaw v${LOCAL_VERSION} started\n🤖 ${session.modelLabel}\n⚙️ ${session.modeLabel}\nAgentic: ${session.agenticEnabled}\nYOLO: ${session.yoloMode ? 'ON' : 'OFF'}`).catch(() => { });
    }

    async function poll() {
        while (true) {
            try {
                const r = await tgRequest('getUpdates', {
                    offset: updateOffset, timeout: 30,
                    allowed_updates: ['message', 'callback_query'],
                });
                if (!r.ok || !r.result) { await sleep(3000); continue; }
                for (const update of r.result) {
                    updateOffset = update.update_id + 1;

                    // ── Callback query (inline keyboard button click) ──
                    if (update.callback_query) {
                        const query = update.callback_query;
                        const chatId = String(query.message?.chat?.id);
                        const msgId = query.message?.message_id;
                        const data = query.data;

                        if (!isAllowed(chatId)) { await tgAnswer(query.id); continue; }

                        const perm = pendingPerms[msgId];
                        if (perm && (data === 'perm_allow' || data === 'perm_deny')) {
                            const allowed = data === 'perm_allow';
                            delete pendingPerms[msgId];
                            const label = allowed ? '✅ Allowed' : '❌ Denied';
                            await tgAnswer(query.id, label);
                            // Auto-delete permission message after 3s
                            setTimeout(() => tgDeleteMessage(chatId, msgId), 3000);
                            await session.approvePermission(perm, allowed, {
                                scope: 'PERMISSION_SCOPE_CONVERSATION',
                            });
                            // ── Command buttons ──
                        } else if (data.startsWith('cmd_model_')) {
                            const key = data.slice(10);
                            if (session.setModel(key)) {
                                await tgAnswer(query.id, `✅ ${session.modelLabel}`);
                                await tgEdit(chatId, msgId, `✅ Model → <b>${escapeHtml(session.modelLabel)}</b>`, HTML);
                            } else {
                                await tgAnswer(query.id, '❌ Unknown model');
                            }
                        } else if (data.startsWith('cmd_mode_')) {
                            const key = data.slice(9);
                            if (session.setMode(key)) {
                                await tgAnswer(query.id, `✅ ${session.modeLabel}`);
                                await tgEdit(chatId, msgId, `✅ Mode → <b>${escapeHtml(session.modeLabel)}</b>`, HTML);
                            } else {
                                await tgAnswer(query.id, '❌ Unknown mode');
                            }
                        } else if (data.startsWith('cmd_agentic_')) {
                            const val = data.slice(12) === 'on';
                            session.setAgentic(val);
                            await tgAnswer(query.id, `✅ Agentic → ${val ? 'ON' : 'OFF'}`);
                            await tgEdit(chatId, msgId, `✅ Agentic → <b>${val ? 'ON' : 'OFF'}</b>`, HTML);
                        } else if (data.startsWith('cmd_yolo_')) {
                            const val = data.slice(9) === 'on';
                            session.setYolo(val);
                            await tgAnswer(query.id, `✅ YOLO → ${val ? 'ON' : 'OFF'}`);
                            await tgEdit(chatId, msgId, val ? '⚡ YOLO → <b>ON</b>' : '✅ YOLO → <b>OFF</b>', HTML);
                        } else if (data.startsWith('cmd_ws_')) {
                            const name = data.slice(7);
                            const result = switchWorkspace(name);
                            await tgAnswer(query.id, result.ok ? `✅ ${result.msg}` : `❌ ${result.msg}`);
                            await tgEdit(chatId, msgId, result.ok ? `✅ ${escapeHtml(result.msg)}` : `❌ ${escapeHtml(result.msg)}`, HTML);
                        } else if (data.startsWith('cmd_cron_on_') || data.startsWith('cmd_cron_off_')) {
                            const enable = data.startsWith('cmd_cron_on_');
                            const jobId = enable ? data.slice(12) : data.slice(13);
                            const r = cron.toggleJob(jobId, enable);
                            await tgAnswer(query.id, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`);
                            // Refresh the cron list
                            const jobs = cron.listAllJobs();
                            const lines = [`<b>Cron Jobs (${jobs.length}):</b>\n`];
                            for (const j of jobs) lines.push(cron.formatJob(j));
                            const rows = jobs.map(j => [
                                { text: (j.enabled ? '✓ ' : '') + 'ON', callback_data: `cmd_cron_on_${j.id}` },
                                { text: (!j.enabled ? '✓ ' : '') + 'OFF', callback_data: `cmd_cron_off_${j.id}` },
                                { text: `📋 ${j.id}`, callback_data: `cmd_noop` },
                            ]);
                            await tgRequest('editMessageText', {
                                chat_id: chatId, message_id: msgId,
                                text: lines.join('\n'),
                                reply_markup: { inline_keyboard: rows },
                                ...HTML,
                            });
                        } else if (data.startsWith('cmd_switch_')) {
                            const num = parseInt(data.slice(11));
                            const list = await session.listCascades();
                            if (num >= 1 && num <= list.length) {
                                session.switchCascade(list[num - 1].id);
                                const ttl = list[num - 1].summary || '(untitled)';
                                await tgAnswer(query.id, '✅ Switched');
                                await tgEdit(chatId, msgId, `✅ Switched: ${list[num - 1].id.slice(0, 8)}... — ${escapeHtml(ttl)}`, HTML);
                            } else {
                                await tgAnswer(query.id, '❌ Invalid number');
                            }
                        } else if (data.startsWith('cmd_delete_')) {
                            const num = parseInt(data.slice(11));
                            const list = await session.listCascades();
                            if (num >= 1 && num <= list.length) {
                                const target = list[num - 1];
                                const ok = await session.deleteCascade(target.id);
                                if (ok) {
                                    await tgAnswer(query.id, '✅ Deleted');
                                    await tgEdit(chatId, msgId, `✅ Deleted #${num}: ${escapeHtml((target.summary || '').slice(0, 40))}`, HTML);
                                    if (!session.cascadeId) {
                                        await tgSend(chatId, '⚠️ Current conversation deleted. Use /new or /switch');
                                    }
                                } else {
                                    await tgAnswer(query.id, '❌ Delete failed');
                                }
                            } else {
                                await tgAnswer(query.id, '❌ Invalid number');
                            }
                        } else if (data.startsWith('cmd_restart_')) {
                            const type = data.slice(12);
                            if (type === 'cold') {
                                await tgAnswer(query.id);
                                await tgEdit(chatId, msgId, `🔄 Cold restart — kill ${APP_NAME} + restart...`);
                                session.destroy();
                                const exeName = (loadConfig().app?.targetExecutables || ['Antigravity.exe'])[0];
                                if (process.platform === 'win32') {
                                    try { require('child_process').execSync(`taskkill /IM ${exeName} /F`, { stdio: 'ignore' }); } catch { }
                                } else {
                                    try { require('child_process').execSync(`pkill -9 -f ${exeName.replace(/\.exe$/i, '')}`, { stdio: 'ignore' }); } catch { }
                                }
                                await tgRequest('getUpdates', { offset: updateOffset, timeout: 0 }); // ACK updates before exit
                                process.exit(42);
                            } else {
                                await tgAnswer(query.id);
                                await tgEdit(chatId, msgId, '🔄 Warm restart...');
                                session.destroy();
                                await tgRequest('getUpdates', { offset: updateOffset, timeout: 0 }); // ACK updates before exit
                                process.exit(42);
                            }
                        } else if (data === 'cmd_noop') {
                            await tgAnswer(query.id);
                        } else {
                            await tgAnswer(query.id);
                        }
                        continue;
                    }

                    // ── Message ──
                    if (update.message) {
                        const msg = update.message;
                        const chatId = String(msg.chat.id);
                        let text = (msg.text || '').trim();

                        if (!isAllowed(chatId)) continue;

                        // Track active chat
                        activeChatId = chatId;

                        // Handle all files: documents, audio, voice, photos
                        const doc = msg.document || msg.audio || msg.voice || (msg.photo ? msg.photo[msg.photo.length - 1] : null);
                        if (doc) {
                            const fileId = doc.file_id;
                            const ext = msg.voice ? '.ogg' : msg.audio ? '.mp3' : '';
                            const fileName = doc.file_name || (msg.photo ? `photo_${Date.now()}.jpg` : msg.voice ? `voice_${Date.now()}${ext}` : msg.audio ? `audio_${Date.now()}${ext}` : `file_${Date.now()}`);
                            const filePath = await tgGetFile(fileId);
                            if (filePath) {
                                const dlDir = getWorkspaceDownloadDir();
                                const localPath = path.join(dlDir, fileName);
                                await downloadFile(filePath, localPath);
                                tgSend(chatId, `📂 Downloaded: <code>${escapeHtml(fileName)}</code>`, HTML).catch(() => { });

                                // Tell AI about the received file
                                const relPath = path.relative(__dirname, localPath).replace(/\\/g, '/');
                                const fileNotice = `[System] User sent a file, saved to ${relPath}`;
                                if (msg.caption) {
                                    text = `${fileNotice}\nUser caption: ${msg.caption}`;
                                } else {
                                    text = fileNotice;
                                }
                            }
                        }

                        if (!text) continue;

                        // Commands
                        if (text.startsWith('/')) {
                            const handled = await handleCommand(chatId, text);
                            if (handled) continue;
                        }

                        // Normal message → process or queue
                        const st = getChat(chatId);
                        if (st.busy) {
                            enqueue(chatId, text);
                        } else {
                            processMessage(chatId, text);
                        }
                    }
                }
            } catch (e) {
                flog(`[POLL_ERROR] ${e.message}`);
                console.log(`[✗] Poll error: ${e.message}`);
                await sleep(5000);
            }
        }
    }

    // ── Cron queue watcher (check every 30s when idle) ─────────────────────
    setInterval(() => {
        // Only process if not busy on any chat
        const anyBusy = Object.values(chatState).some(st => st.busy);
        if (anyBusy || _cronActive) return;
        processCronQueue();
    }, 30000);

    // ── Graceful shutdown (Ctrl+C / kill) — flush update queue ──────────
    const gracefulExit = async (sig) => {
        console.log(`[⏻] ${sig} received, flushing Telegram updates…`);
        try { await tgRequest('getUpdates', { offset: updateOffset, timeout: 0 }); } catch { }
        process.exit(0);
    };
    process.on('SIGINT', () => gracefulExit('SIGINT'));
    process.on('SIGTERM', () => gracefulExit('SIGTERM'));

    // Start polling
    poll();
}

// ─── Auth check ──────────────────────────────────────────────────────────────
function isAllowed(chatId) {
    if (ALLOWED_USERS.size === 0) return true;
    return ALLOWED_USERS.has(String(chatId));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
    flog(`[FATAL] ${err.message}\n${err.stack}`);
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});
