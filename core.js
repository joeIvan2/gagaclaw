/**
 * Gagaclaw Core v1.1 — Shared Engine Module
 * Encapsulates config, HTTP transport, auth extraction, stream parsing, session management
 * Interface layers (CLI/Telegram/Discord) only need to require this module
 */

const puppeteer = require('puppeteer-core');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { EventEmitter } = require('events');

// ─── Config (gagaclaw.json) ──────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'gagaclaw.json');

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4) + '\n');
}

const MODELS = {
    flash: { id: 'MODEL_PLACEHOLDER_M18', label: 'Gemini 3 Flash (M18)' },
    low: { id: 'MODEL_PLACEHOLDER_M36', label: 'Gemini 3.1 Low (M36)' },
    high: { id: 'MODEL_PLACEHOLDER_M37', label: 'Gemini 3.1 High (M37)' },
    opus: { id: 'MODEL_PLACEHOLDER_M26', label: 'Claude 4.6 Opus (M26)' },
    sonnet: { id: 'MODEL_PLACEHOLDER_M35', label: 'Claude 4.6 Sonnet (M35)' },
    gpt: { id: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', label: 'GPT OSS 120B' },
};
const MODEL_BY_ID = Object.fromEntries(Object.values(MODELS).map(m => [m.id, m]));

const MODES = {
    planning: { plannerMode: 'CONVERSATIONAL_PLANNER_MODE_DEFAULT', agenticMode: true, label: 'Planning (plan → execute)' },
    fast: { plannerMode: 'CONVERSATIONAL_PLANNER_MODE_DEFAULT', agenticMode: false, label: 'Fast (execute directly)' },
};

function getConfigModel() {
    return loadConfig().defaults?.model || MODELS.high.id;
}
function setConfigModel(modelId) {
    const cfg = loadConfig();
    if (!cfg.defaults) cfg.defaults = {};
    cfg.defaults.model = modelId;
    saveConfig(cfg);
}
function getConfigMode() {
    return loadConfig().defaults?.mode || 'planning';
}
function setConfigMode(mode) {
    const cfg = loadConfig();
    if (!cfg.defaults) cfg.defaults = {};
    cfg.defaults.mode = mode;
    saveConfig(cfg);
}
function getConfigAgentic() {
    return loadConfig().defaults?.agentic !== false;
}
function setConfigAgentic(val) {
    const cfg = loadConfig();
    if (!cfg.defaults) cfg.defaults = {};
    cfg.defaults.agentic = val;
    saveConfig(cfg);
}

// ─── TLS agent (self-signed cert) ───────────────────────────────────────────
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Packet logger ──────────────────────────────────────────────────────────
const pktLog = fs.createWriteStream(path.join(__dirname, 'network-packets.log'), { flags: 'w' });
const ts = () => new Date().toISOString().slice(11, 23);
function pktWrite(msg) { pktLog.write(`[${ts()}] ${msg}\n`); }
pktLog.write(`Session: ${new Date().toISOString()}\n${'═'.repeat(60)}\n`);

// ─── Node.js direct API calls ────────────────────────────────────────────────
function nodePost(port, pathName, body, csrfToken, host) {
    const url = `https://${host || '127.0.0.1'}:${port}/exa.language_server_pb.LanguageServerService/${pathName}`;
    const payload = JSON.stringify(body);
    pktWrite(`>>> POST ${pathName}`);
    pktWrite(`    ${payload.slice(0, 2000)}`);
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            agent: tlsAgent,
            headers: {
                'content-type': 'application/json',
                'connect-protocol-version': '1',
                ...(csrfToken ? { 'x-codeium-csrf-token': csrfToken } : {}),
            },
            timeout: 15000,
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                pktWrite(`<<< ${res.statusCode} ${pathName}`);
                pktWrite(`    ${data.slice(0, 2000)}`);
                resolve({ status: res.statusCode, body: data });
            });
        });
        req.on('error', err => { pktWrite(`ERR ${pathName}: ${err.message}`); resolve({ status: 0, body: err.message }); });
        req.on('timeout', () => { req.destroy(); pktWrite(`TIMEOUT ${pathName}`); resolve({ status: 0, body: 'timeout' }); });
        req.write(payload);
        req.end();
    });
}

// Streaming fetch for connect+json — returns { abort }
function nodeStreamFetch(port, pathName, body, csrfToken, onFrame, onEnd, host) {
    const url = `https://${host || '127.0.0.1'}:${port}/exa.language_server_pb.LanguageServerService/${pathName}`;
    const jsonStr = JSON.stringify(body);
    const encoded = Buffer.from(jsonStr, 'utf8');
    const frame = Buffer.alloc(5 + encoded.length);
    frame[0] = 0;
    frame.writeUInt32BE(encoded.length, 1);
    encoded.copy(frame, 5);

    let aborted = false;
    let ended = false;
    pktWrite(`>>> STREAM ${pathName}`);
    const fireEnd = () => { if (!ended && !aborted) { ended = true; pktWrite(`    STREAM_END ${pathName}`); if (onEnd) onEnd(); } };

    const req = https.request(url, {
        method: 'POST',
        agent: tlsAgent,
        headers: {
            'content-type': 'application/connect+json',
            'connect-protocol-version': '1',
            ...(csrfToken ? { 'x-codeium-csrf-token': csrfToken } : {}),
        },
    }, res => {
        let buffer = Buffer.alloc(0);
        res.on('data', chunk => {
            if (aborted) return;
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 5) {
                const flags = buffer[0];
                const frameLen = buffer.readUInt32BE(1);
                if (buffer.length < 5 + frameLen) break;
                const payload = buffer.slice(5, 5 + frameLen).toString('utf8');
                buffer = buffer.slice(5 + frameLen);

                if (flags & 0x02) {
                    fireEnd();
                    return;
                }
                pktWrite(`    S[] ${payload.slice(0, 3000)}`);
                try { onFrame(payload); } catch { }
            }
        });
        res.on('end', fireEnd);
        res.on('error', fireEnd);
    });
    req.on('error', fireEnd);
    req.write(frame);
    req.end();

    return { abort: () => { aborted = true; req.destroy(); } };
}

// ─── Stream frame parser ─────────────────────────────────────────────────────
function parseStreamFrame(jsonStr) {
    try {
        const obj = JSON.parse(jsonStr);
        const info = { thinking: [], response: [], toolCalls: [], trajectoryId: null, stepIndex: null, turnDone: false, newStepStarted: false, permissionWait: null, permissionPath: null, permissionCmd: null, permStepType: null, serverError: null };
        walk(obj, [], info);
        const diffs = obj?.diff?.fieldDiffs;
        if (diffs && diffs.length === 1 && diffs[0].fieldNumber === 8) {
            const ev = diffs[0].updateSingular?.enumValue;
            if (ev === 1) info.turnDone = true;
            if (ev === 2) info.newStepStarted = true;
        }
        return info;
    } catch { return null; }
}

function walk(node, fieldStack, info) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) walk(item, fieldStack, info);
        return;
    }

    const fn = node.fieldNumber;
    const newStack = fn !== undefined ? [...fieldStack, fn] : fieldStack;
    const parentFn = fieldStack[fieldStack.length - 1];

    if (node.updateSingular?.stringValue !== undefined) {
        const sv = node.updateSingular.stringValue;
        if (fn === 3 && parentFn === 20) info.thinking.push(sv);
        else if (fn === 8 && parentFn === 20) {
            // Strip leaked <EPHEMERAL_MESSAGE>...</EPHEMERAL_MESSAGE> blocks (IDE system context)
            const cleaned = sv
                .replace(/<EPHEMERAL_MESSAGE>[\s\S]*?<\/EPHEMERAL_MESSAGE>/g, '') // complete blocks
                .replace(/<\/?EPHEMERAL_MESSAGE>/g, '')                           // stray tags
                .trim();
            if (cleaned) info.response.push(cleaned);
        }
        else if (fn === 1 && parentFn === 20) info.trajectoryId = sv;
    }
    if (node.updateSingular?.uint32Value !== undefined) {
        if (fn === 2 && parentFn === 20) {
            // DEBUG: log every stepIndex capture with full stack trace
            pktWrite(`STEP_IDX_SET value=${node.updateSingular.uint32Value} prev=${info.stepIndex} stack=[${newStack.join(',')}] depth=${newStack.length}`);
            info.stepIndex = node.updateSingular.uint32Value;
        }
    }
    if (fn === 7 && parentFn === 20 && node.updateRepeated?.updateValues) {
        for (const val of node.updateRepeated.updateValues) {
            const diffs = val?.messageValue?.fieldDiffs;
            if (!diffs) continue;
            const tc = {};
            for (const d of diffs) {
                if (d.fieldNumber === 1 && d.updateSingular?.stringValue) tc.id = d.updateSingular.stringValue;
                if (d.fieldNumber === 2 && d.updateSingular?.stringValue) tc.toolName = d.updateSingular.stringValue;
                if (d.fieldNumber === 3 && d.updateSingular?.stringValue) {
                    try { Object.assign(tc, JSON.parse(d.updateSingular.stringValue)); } catch { tc.argsRaw = d.updateSingular.stringValue; }
                }
            }
            if (tc.toolName) info.toolCalls.push(tc);
        }
    }

    // Permission detection: based on CortexStepType enum (f1) + WAITING status (f4=9)
    // Both appear at the same level in the step node.
    // Strategy: whitelist run_command/mcp, then check for file:/// URI → file, else browser fallback
    // Steps with file_permission_request (from proto): CodeAction(5), GrepSearch(7),
    //   ViewFile(?), ListDirectory(?), ViewCodeItem(13), ViewContentChunk(32),
    //   Find(25), ViewFileOutline(47) — too many to whitelist, so detect by file:/// URI instead
    if (node.messageValue?.fieldDiffs) {
        const diffs = node.messageValue.fieldDiffs;
        let hasStatus9 = false, stepType = null;
        let permPath = null, cmdLine = null;
        for (const d of diffs) {
            if (d.fieldNumber === 4 && d.updateSingular?.enumValue === 9) hasStatus9 = true;
            if (d.fieldNumber === 1 && d.updateSingular?.enumValue != null) stepType = d.updateSingular.enumValue;
            // Extract file path: scan ALL fields for file:/// URI (covers f10, f14, and any future fields)
            // Known: f10=FileContext (write_to_file), f14=FilePermissionInteractionSpec (view_file)
            if (!permPath && d.fieldNumber !== 5 && d.fieldNumber !== 20) {
                try {
                    const s = JSON.stringify(d);
                    const m = s.match(/"file:\/\/\/[^"]+"/);
                    if (m) permPath = JSON.parse(m[0]);
                } catch { }
            }
            // Extract CommandLine from f28 (RunCommandStep) → f23 (command string)
            if (d.fieldNumber === 28) {
                try {
                    const inner = d.updateSingular?.messageValue?.fieldDiffs;
                    if (inner) {
                        const f23 = inner.find(x => x.fieldNumber === 23);
                        if (f23?.updateSingular?.stringValue) cmdLine = f23.updateSingular.stringValue;
                    }
                } catch { }
            }
        }
        if (stepType !== null) info.permStepType = stepType;
        if (hasStatus9 && !info.permissionWait) {
            // Use updateIndex from steps array if walk() didn't find stepIndex in metadata
            if (info._updateIndex !== undefined && info.stepIndex === null) {
                info.stepIndex = info._updateIndex;
                pktWrite(`STEP_IDX_FROM_WAITING value=${info._updateIndex}`);
            }
            // Determine interaction type: run_command and mcp by stepType, file by URI presence, else browser
            if (stepType === 21) info.permissionWait = 'run_command';        // RUN_COMMAND
            else if (stepType === 38) info.permissionWait = 'mcp';           // MCP_TOOL
            else if (permPath) info.permissionWait = 'file';                 // any step with file:/// URI
            else info.permissionWait = 'browser';                            // fallback
            if (permPath) info.permissionPath = permPath;
            if (cmdLine) info.permissionCmd = cmdLine;
            pktWrite(`PERM_TYPE_DETECT type=${info.permissionWait} stepType=${stepType} cmd=${cmdLine} path=${permPath} stack=[${newStack.join(',')}]`);
        }
    }

    // Server error detection: fieldNumber 24 contains error details (e.g. 503 capacity exhausted)
    if (fn === 24 && node.updateSingular?.messageValue?.fieldDiffs) {
        const errDiffs = node.updateSingular.messageValue.fieldDiffs;
        let errUserMsg = null, errCode = null, errTechMsg = null;
        for (const ed of errDiffs) {
            if (ed.fieldNumber === 3 && ed.updateSingular?.messageValue?.fieldDiffs) {
                for (const inner of ed.updateSingular.messageValue.fieldDiffs) {
                    if (inner.fieldNumber === 1 && inner.updateSingular?.stringValue) errUserMsg = inner.updateSingular.stringValue;
                    if (inner.fieldNumber === 7 && inner.updateSingular?.uint32Value) errCode = inner.updateSingular.uint32Value;
                    if (inner.fieldNumber === 9 && inner.updateSingular?.stringValue) errTechMsg = inner.updateSingular.stringValue;
                }
            }
        }
        if (errUserMsg || errCode) {
            info.serverError = { code: errCode, message: errUserMsg, technical: errTechMsg };
            pktWrite(`SERVER_ERROR code=${errCode} msg=${errUserMsg}`);
        }
    }

    // Handle updateRepeated with updateIndices: track which array index we're processing
    if (node.updateRepeated?.updateValues && node.updateRepeated.updateIndices) {
        const vals = node.updateRepeated.updateValues;
        const idxs = node.updateRepeated.updateIndices;
        for (let i = 0; i < vals.length; i++) {
            const prev = info._updateIndex;
            info._updateIndex = idxs[i];
            walk(vals[i], newStack, info);
            info._updateIndex = prev;
        }
    }

    for (const key of Object.keys(node)) {
        if (key === 'updateRepeated' && node.updateRepeated?.updateIndices) continue; // already handled above
        const val = node[key];
        if (val && typeof val === 'object') walk(val, newStack, info);
    }
}

// ─── Auto-discover CDP port ──────────────────────────────────────────────────
async function checkPort(port, host) {
    const h = host || '127.0.0.1';
    return new Promise(resolve => {
        const req = http.get(`http://${h}:${port}/json`, { timeout: 800 }, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try {
                    const pages = JSON.parse(body);
                    if (Array.isArray(pages) && pages.length > 0) resolve({ port, pages });
                    else resolve(null);
                } catch { resolve(null); }
            });
        }).on('error', () => resolve(null))
            .on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// ─── Auth extraction (one-time, via Puppeteer) ───────────────────────────────

function readAuthFromDisk(log) {
    try {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const candidates = [
            path.join(home, 'AppData/Roaming/Antigravity/User/globalStorage/state.vscdb'),
            path.join(home, '.config/Antigravity/User/globalStorage/state.vscdb'),
        ];
        for (const dbPath of candidates) {
            if (!fs.existsSync(dbPath)) continue;
            const buf = fs.readFileSync(dbPath);
            const text = buf.toString('latin1');
            const apiKeyMatch = text.match(/"apiKey"\s*:\s*"(ya29\.[^"]+)"/);
            if (apiKeyMatch) {
                const metadata = { apiKey: apiKeyMatch[1], ideName: 'antigravity', extensionName: 'antigravity', locale: 'en', ideVersion: '1.0.0' };
                log('info', `Auth: apiKey from disk (${dbPath.split(/[/\\]/).pop()})`);
                return metadata;
            }
        }
    } catch { }
    return null;
}

async function findLsHttpsPort(pid, log) {
    let ports = [];
    try {
        if (process.platform === 'win32') {
            const out = execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort"`,
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
            ports = out.split(/\s+/).map(Number).filter(p => p > 0);
        } else {
            const out = execSync(`ss -tlnp 2>/dev/null | grep 'pid=${pid}' | awk '{print $4}' | grep -oP '\\d+$'`,
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
            ports = out.split(/\s+/).map(Number).filter(p => p > 0);
        }
    } catch { }
    if (ports.length === 0) return null;
    log('debug', `Auth: language_server PID ${pid} listens on: ${ports.join(', ')}`);
    // Try HTTPS on each port concurrently — the API port uses HTTPS
    const checks = ports.map(port => new Promise(resolve => {
        const req = https.get(`https://127.0.0.1:${port}/`, { agent: tlsAgent, timeout: 1500 }, res => {
            res.resume();
            resolve(port);
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    }));
    const results = await Promise.all(checks);
    const found = results.find(p => p !== null);
    if (found) log('info', `Auth: HTTPS API port ${found} (from PID ${pid})`);
    return found ? String(found) : null;
}

async function captureAuth(browser, page, logger) {
    const log = logger || (() => { });

    let osCsrfToken = null, osLsPort = null, osPid = null;
    try {
        let cmd;
        if (process.platform === 'win32') {
            cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like '%language_server%.exe'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Csv -NoTypeInformation"`;
        } else {
            cmd = `ps aux | grep language_server | grep -v grep`;
        }
        const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
        const csrfMatch = out.match(/--csrf_token\s+([a-f0-9\-]{36})/i);
        if (csrfMatch) osCsrfToken = csrfMatch[1];
        // Extract PID
        if (process.platform === 'win32') {
            const pidMatch = out.match(/"(\d+)"/);
            if (pidMatch) osPid = pidMatch[1];
        } else {
            const pidMatch = out.match(/\S+\s+(\d+)/);
            if (pidMatch) osPid = pidMatch[1];
        }
        if (osCsrfToken) log('info', 'Auth: csrf from OS command line');
    } catch { }

    // Find the real HTTPS API port via PID
    if (osPid) osLsPort = await findLsHttpsPort(osPid, log);
    // Fallback: try --extension_server_port (may not be the HTTPS port)
    if (!osLsPort) {
        try {
            const cmd = process.platform === 'win32'
                ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like '%language_server%.exe'\\" | Select-Object -ExpandProperty CommandLine"`
                : `ps aux | grep language_server | grep -v grep`;
            const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
            const portMatch = out.match(/--extension_server_port\s+(\d+)/i);
            if (portMatch) osLsPort = portMatch[1];
        } catch { }
    }

    // Layer 1: Read apiKey from disk (state.vscdb) + csrf from OS — instant, no waiting
    if (osCsrfToken && osLsPort) {
        const diskMetadata = readAuthFromDisk(log);
        if (diskMetadata) {
            log('info', `Auth: instant (disk + OS) · port ${osLsPort}`);
            return { metadata: diskMetadata, csrfToken: osCsrfToken, cascadeConfig: null, lsPort: osLsPort };
        }
    }

    // Layer 2: Scan browser globals/storage/webpack/fiber
    const fromGlobals = await page.evaluate(() => {
        const result = {};
        try {
            const lsEntries = performance.getEntriesByType('resource')
                .filter(r => r.name.includes('LanguageServerService'));
            if (lsEntries.length > 0) {
                const m = lsEntries[0].name.match(/:(\d+)/);
                if (m) result.lsPort = m[1];
            }
        } catch { }
        for (const store of [localStorage, sessionStorage]) {
            for (let i = 0; i < store.length; i++) {
                const key = store.key(i);
                try {
                    const val = JSON.parse(store.getItem(key) || '');
                    if (val?.apiKey && !result.metadata) result.metadata = val;
                    const csrf = val?.csrfToken || val?.['x-codeium-csrf-token'];
                    if (csrf && !result.csrfToken) result.csrfToken = csrf;
                    if (val?.cascadeConfig && !result.cascadeConfig) result.cascadeConfig = val.cascadeConfig;
                } catch { }
            }
        }
        for (const g of ['__codeiumAuth', '__cascadeAuth', '__codeiumState', 'codeiumState',
            '__CODEIUM__', '_codeiumMetadata', '__windsurf_auth__', '__antigravity__']) {
            try {
                const v = window[g];
                if (!v || typeof v !== 'object') continue;
                if (v.apiKey && !result.metadata) result.metadata = v;
                if (v.metadata?.apiKey && !result.metadata) result.metadata = v.metadata;
                if (v.csrfToken && !result.csrfToken) result.csrfToken = v.csrfToken;
                if (v.cascadeConfig && !result.cascadeConfig) result.cascadeConfig = v.cascadeConfig;
            } catch { }
        }
        try {
            for (const key of Object.keys(window).slice(0, 300)) {
                try {
                    const v = window[key];
                    if (!v || typeof v !== 'object') continue;
                    if (v.apiKey && !result.metadata) result.metadata = v;
                    if (v.csrfToken && !result.csrfToken) result.csrfToken = v.csrfToken;
                } catch { }
            }
        } catch { }
        try {
            const scanObj = (v) => {
                if (!v || typeof v !== 'object') return;
                if (v.apiKey && !result.metadata) result.metadata = v;
                if (v.metadata?.apiKey && !result.metadata) result.metadata = v.metadata;
                const csrf = v.csrfToken || v['x-codeium-csrf-token'];
                if (csrf && !result.csrfToken) result.csrfToken = csrf;
                if (v.cascadeConfig && !result.cascadeConfig) result.cascadeConfig = v.cascadeConfig;
                for (const key of Object.keys(v).slice(0, 40)) {
                    try {
                        const sub = v[key];
                        if (!sub || typeof sub !== 'object' || Array.isArray(sub)) continue;
                        if (sub.apiKey && !result.metadata) result.metadata = sub;
                        const subCsrf = sub.csrfToken || sub['x-codeium-csrf-token'];
                        if (subCsrf && !result.csrfToken) result.csrfToken = subCsrf;
                        if (sub.cascadeConfig && !result.cascadeConfig) result.cascadeConfig = sub.cascadeConfig;
                    } catch { }
                }
            };
            const chunkArr = window.webpackChunkwindsurf || window.webpackChunkantigravity
                || window.webpackChunkwindsurf_ide || window.webpackChunkvscode;
            const req = (chunkArr && chunkArr[0]?.[2]) || window.__webpack_require__;
            const moduleCache = req?.c || req?.m;
            if (moduleCache) {
                for (const mod of Object.values(moduleCache)) {
                    if (result.metadata && result.csrfToken) break;
                    try { scanObj(mod?.exports); scanObj(mod?.exports?.default); } catch { }
                }
            }
        } catch { }
        try {
            const root = document.querySelector('#root') || document.querySelector('[data-reactroot]') || document.body?.firstElementChild;
            const fiberKey = root && Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
            if (fiberKey) {
                let fiber = root[fiberKey], depth = 0;
                while (fiber && depth < 200 && !(result.metadata && result.csrfToken)) {
                    depth++;
                    try {
                        for (const src of [fiber.memoizedState, fiber.memoizedState?.memoizedState, fiber.memoizedProps]) {
                            if (!src || typeof src !== 'object') continue;
                            if (src.apiKey && !result.metadata) result.metadata = src;
                            const csrf = src.csrfToken || src['x-codeium-csrf-token'];
                            if (csrf && !result.csrfToken) result.csrfToken = csrf;
                        }
                    } catch { }
                    fiber = fiber.child || fiber.sibling || fiber.return?.sibling;
                }
            }
        } catch { }
        return (result.metadata || result.csrfToken || result.lsPort) ? result : null;
    }).catch(() => null);

    log('debug', `Globals scan: metadata=${!!fromGlobals?.metadata} csrf=${!!fromGlobals?.csrfToken} port=${fromGlobals?.lsPort || 'none'}`);
    if (fromGlobals?.metadata && (osCsrfToken || fromGlobals?.csrfToken)) {
        const lsPort = fromGlobals.lsPort || osLsPort || '57396';
        log('info', `Auth: metadata from globals · port ${lsPort}`);
        return {
            metadata: fromGlobals.metadata,
            csrfToken: osCsrfToken || fromGlobals.csrfToken,
            cascadeConfig: fromGlobals.cascadeConfig || null,
            lsPort,
        };
    }

    // Layer 3: CDP network interception (fallback — waits for periodic traffic)
    log('debug', 'CDP interception (waiting for periodic auth traffic)...');
    const targets = await browser.targets();
    const clients = [];
    for (const t of targets) {
        try { const cl = await t.createCDPSession(); await cl.send('Network.enable'); clients.push(cl); } catch { }
    }

    return new Promise(resolve => {
        let done = false, auth = {};
        const tryResolve = () => {
            if (done || !auth.metadata || (!auth.csrfToken && !osCsrfToken)) return;
            done = true; resolve({ ...auth, csrfToken: osCsrfToken || auth.csrfToken });
        };
        const handle = e => {
            if (done) return;
            const url = e.request.url;
            if (!url.includes('LanguageServerService') || !e.request.postData) return;
            try {
                const body = JSON.parse(e.request.postData);
                const csrf = e.request.headers['x-codeium-csrf-token'] || '';
                if (body.metadata?.apiKey && !auth.metadata) {
                    const portMatch = url.match(/:(\d+)/);
                    const endpoint = url.match(/\/([^/]+)$/)?.[1] || 'unknown';
                    auth = { metadata: body.metadata, cascadeConfig: body.cascadeConfig || null, csrfToken: csrf, lsPort: portMatch ? portMatch[1] : '57396' };
                    log('info', `Auth: metadata from ${endpoint} (port ${auth.lsPort})`);
                }
                tryResolve();
            } catch { }
        };
        for (const cl of clients) cl.on('Network.requestWillBeSent', handle);
        const startTime = Date.now();
        const progress = setInterval(() => {
            if (done) { clearInterval(progress); return; }
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            log('debug', `Waiting for auth traffic... (${elapsed}s)`);
        }, 10000);
        setTimeout(() => { clearInterval(progress); if (!done) { done = true; resolve(null); } }, 70000);
    });
}

// ─── Session class ───────────────────────────────────────────────────────────
// Events: 'thinking', 'response', 'toolCall', 'permissionWait', 'turnDone',
//         'newStep', 'streamReconnect', 'error'
class Session extends EventEmitter {
    constructor(auth) {
        super();
        this.auth = auth;
        this.cascadeId = '';
        this.currentModelId = getConfigModel();
        this.cascadeConfig = auth.cascadeConfig || { plannerConfig: { requestedModel: {} }, modelConfig: {} };
        this.currentMode = getConfigMode();
        this.agenticEnabled = getConfigAgentic();
        this.yoloMode = loadConfig().yoloMode || false;

        // Stream state
        this._latestTrajectoryId = null;
        this._latestStepIndex = null;
        this._stepTypeMap = new Map();  // stepIndex -> stepType (persists across diffs)
        this._stepPathMap = new Map();  // stepIndex -> permissionPath (persists across diffs)
        this._lastThinking = '';
        this._lastResponse = '';
        this._lastSeenToolCall = null;
        this._pendingToolCall = null;
        this._pendingPermTimer = null;  // debounce timer for WAITING approval
        this._turnDoneTimer = null;
        this._awaitingResponse = false;
        this._stream = null;
        this._lastServerError = '';
        this._lastServerErrorTime = 0;

        this._applyModel();
        this._applyMode();
    }

    _applyModel() {
        if (!this.cascadeConfig.plannerConfig) this.cascadeConfig.plannerConfig = {};
        if (!this.cascadeConfig.plannerConfig.requestedModel) this.cascadeConfig.plannerConfig.requestedModel = {};
        this.cascadeConfig.plannerConfig.requestedModel.model = this.currentModelId;
    }

    _applyMode() {
        if (!this.cascadeConfig.plannerConfig) this.cascadeConfig.plannerConfig = {};
        if (!this.cascadeConfig.plannerConfig.conversational) this.cascadeConfig.plannerConfig.conversational = {};
        const m = MODES[this.currentMode] || MODES.planning;
        this.cascadeConfig.plannerConfig.conversational.plannerMode = m.plannerMode;
        this.cascadeConfig.plannerConfig.conversational.agenticMode = this.agenticEnabled;
    }

    get modelLabel() { return MODEL_BY_ID[this.currentModelId]?.label || this.currentModelId; }
    get modeLabel() { return MODES[this.currentMode]?.label || this.currentMode; }

    setModel(key) {
        if (MODELS[key]) {
            this.currentModelId = MODELS[key].id;
        } else {
            const byM = Object.values(MODELS).find(m => m.id.toLowerCase().includes(key) || m.label.toLowerCase().includes(key));
            if (byM) this.currentModelId = byM.id;
            else return false;
        }
        this._applyModel();
        setConfigModel(this.currentModelId);
        return true;
    }

    setMode(mode) {
        if (!MODES[mode]) return false;
        this.currentMode = mode;
        this._applyMode();
        setConfigMode(mode);
        return true;
    }

    setAgentic(val) {
        this.agenticEnabled = val;
        this._applyMode();
        setConfigAgentic(val);
    }

    // ── Cascade lifecycle ──

    async startNewCascade() {
        const res = await nodePost(this.auth.lsPort, 'StartCascade', {
            metadata: this.auth.metadata,
            source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT'
        }, this.auth.csrfToken, this.auth.cdpHost);
        if (res.status === 200) {
            try { const b = JSON.parse(res.body); return b.cascadeId || null; } catch { }
        }
        return null;
    }

    async listCascades() {
        const res = await nodePost(this.auth.lsPort, 'GetAllCascadeTrajectories', {}, this.auth.csrfToken, this.auth.cdpHost);
        if (res.status !== 200) return [];
        try {
            const map = JSON.parse(res.body).trajectorySummaries || {};
            return Object.entries(map).map(([id, v]) => ({ id, ...v }))
                .sort((a, b) => (b.lastModifiedTime || '').localeCompare(a.lastModifiedTime || ''));
        } catch { return []; }
    }

    async deleteCascade(targetId) {
        const res = await nodePost(this.auth.lsPort, 'DeleteCascadeTrajectory', { cascadeId: targetId }, this.auth.csrfToken, this.auth.cdpHost);
        if (res.status === 200 && targetId === this.cascadeId) this.cascadeId = '';
        return res.status === 200;
    }

    async stop() {
        return nodePost(this.auth.lsPort, 'CancelCascadeInvocation', { cascadeId: this.cascadeId }, this.auth.csrfToken, this.auth.cdpHost);
    }

    switchCascade(id) {
        this.cascadeId = id;
        this.openStream();
    }

    async resumeOrNew() {
        const cascades = await this.listCascades();
        if (cascades.length > 0) {
            this.cascadeId = cascades[0].id;
            return { resumed: true, id: cascades[0].id, title: cascades[0].summary || '(untitled)' };
        }
        const newId = await this.startNewCascade();
        if (!newId) return null;
        this.cascadeId = newId;
        return { resumed: false, id: newId, title: '' };
    }

    // ── Stream management ──

    openStream() {
        if (this._stream) { try { this._stream.abort(); } catch { } }
        this._stream = nodeStreamFetch(this.auth.lsPort, 'StreamCascadeReactiveUpdates',
            { protocolVersion: 1, id: this.cascadeId, subscriberId: 'session-' + Date.now() },
            this.auth.csrfToken,
            (frameJson) => this._handleStreamFrame(frameJson),
            () => this._handleStreamEnd(),
            this.auth.cdpHost
        );
    }

    _handleStreamFrame(frameJson) {
        const info = parseStreamFrame(frameJson);
        if (!info) return;
        if (info.trajectoryId) this._latestTrajectoryId = info.trajectoryId;
        if (info.stepIndex !== null) {
            pktWrite(`LATEST_STEP_UPDATE ${this._latestStepIndex} → ${info.stepIndex}`);
            this._latestStepIndex = info.stepIndex;
        }
        // Server error (e.g. 503) → store but don't emit yet (IDE may auto-retry)
        if (info.serverError) {
            const e = info.serverError;
            this._lastServerError = e.code ? `Server error ${e.code}: ${e.message || e.technical}` : (e.message || 'Unknown server error');
        }

        if (!this._awaitingResponse) return;
        if (this._pendingToolCall) return;

        // Thinking deltas
        for (const t of info.thinking) {
            if (t.length > this._lastThinking.length) {
                const delta = t.slice(this._lastThinking.length);
                this.emit('thinking', delta, t);
                this._lastThinking = t;
            }
        }
        // Response deltas
        for (const r of info.response) {
            if (r.length > this._lastResponse.length) {
                const delta = r.slice(this._lastResponse.length);
                this.emit('response', delta, r);
                this._lastResponse = r;
                this._lastServerError = ''; // retry succeeded, clear error
            }
        }
        // Tool calls — record for context
        for (const tc of info.toolCalls) {
            this._lastSeenToolCall = tc;
            this.emit('toolCall', tc);
        }
        // Maintain stepType/path maps: remember per stepIndex across diffs
        if (info.permStepType !== null && info.stepIndex !== null) {
            this._stepTypeMap.set(info.stepIndex, info.permStepType);
        }
        if (info.permissionPath && info.stepIndex !== null) {
            this._stepPathMap.set(info.stepIndex, info.permissionPath);
        }
        // Permission: triggered by WAITING status (enumValue:9)
        // Resolve stepType from map if not in current diff (protobuf only sends changed fields)
        if (info.permissionWait && !this._pendingToolCall) {
            const stepIdx = info.stepIndex !== null ? info.stepIndex : this._latestStepIndex;
            const resolvedType = info.permStepType ?? this._stepTypeMap.get(stepIdx) ?? null;
            if (resolvedType === null) {
                pktWrite(`PERM_SKIP stepIndex=${stepIdx} (no stepType in diff or map — likely false positive)`);
            } else {
                const trajId = info.trajectoryId || this._latestTrajectoryId;
                const lastTc = this._lastSeenToolCall || {};
                // Re-resolve permissionWait using cached stepType/path only when walk() fell back to browser
                const cachedPath = this._stepPathMap.get(stepIdx) ?? null;
                if (info.permissionWait === 'browser') {
                    if (resolvedType === 21) info.permissionWait = 'run_command';
                    else if (resolvedType === 38) info.permissionWait = 'mcp';
                    else if (info.permissionPath || cachedPath) info.permissionWait = 'file';
                    // else: stays 'browser'
                }
                if (!info.permissionPath && cachedPath) info.permissionPath = cachedPath;
                const perm = {
                    type: info.permissionWait,
                    contextTool: lastTc,
                    permissionPath: info.permissionPath,
                    CommandLine: info.permissionCmd || lastTc.CommandLine,
                    _trajectoryId: trajId,
                    _stepIndex: stepIdx,
                };
                this._pendingToolCall = perm;
                pktWrite(`PERM_DETECT type=${info.permissionWait} stepIndex=${stepIdx} trajId=${trajId} cmd=${info.permissionCmd} path=${info.permissionPath}`);
                // Debounce: wait 1s before approving — server sometimes auto-resolves WAITING
                // If a newer WAITING arrives for the same step, reset the timer (take the last one)
                if (this._pendingPermTimer) { clearTimeout(this._pendingPermTimer); this._pendingPermTimer = null; }
                this._pendingPermTimer = setTimeout(() => {
                    this._pendingPermTimer = null;
                    // Only approve if this perm is still the active pending (not superseded)
                    if (this._pendingToolCall === perm) {
                        pktWrite(`PERM_DEBOUNCE_FIRE stepIndex=${stepIdx}`);
                        this._emitPermission(perm);
                    } else {
                        pktWrite(`PERM_DEBOUNCE_SKIP stepIndex=${stepIdx} (superseded)`);
                    }
                }, 1000);
                return;
            }
        }
        // New step → cancel turnDone debounce + reset delta tracking
        if (info.newStepStarted && this._turnDoneTimer) {
            clearTimeout(this._turnDoneTimer);
            this._turnDoneTimer = null;
            this._lastThinking = '';
            this._lastResponse = '';
            this.emit('newStep');
        }
        // Turn done → 5s debounce
        if (info.turnDone && !this._pendingToolCall && this._awaitingResponse) {
            if (this._turnDoneTimer) clearTimeout(this._turnDoneTimer);
            this._turnDoneTimer = setTimeout(() => {
                this._turnDoneTimer = null;
                if (this._awaitingResponse && !this._pendingToolCall) {
                    // If no response was produced and there was a server error, report it
                    if (!this._lastResponse && !this._lastThinking && this._lastServerError) {
                        this.emit('error', this._lastServerError);
                    }
                    this._awaitingResponse = false;
                    this._lastServerError = '';
                    this.emit('turnDone');
                }
            }, 5000);
        }
    }

    setYolo(val) {
        this.yoloMode = val;
        const cfg = loadConfig();
        cfg.yoloMode = val;
        saveConfig(cfg);
    }

    _emitPermission(perm) {
        if (this.yoloMode) {
            this._autoApprove(perm);
            return;
        }
        this.emit('permissionWait', perm);
    }

    async _autoApprove(perm) {
        const desc = perm.type === 'run_command' ? `run_command: ${perm.CommandLine || '(cmd)'}`
            : perm.type === 'file' ? `file: ${perm.permissionPath || perm.contextTool?.AbsolutePath || '(path)'}`
                : perm.type === 'browser' ? `browser: ${perm.contextTool?.Url || '(url)'}`
                    : perm.type === 'mcp' ? `mcp: ${perm.contextTool?.toolName || '(tool)'}`
                        : `${perm.type}`;
        this.emit('yoloApprove', desc);
        const ok = await this.approvePermission(perm, true, {
            scope: 'PERMISSION_SCOPE_CONVERSATION',
        });
        if (!ok) this.emit('yoloError', desc);
    }

    async approvePermission(perm, allowed, opts = {}) {
        let interactionPayload;
        if (perm.type === 'browser') {
            interactionPayload = {
                cascadeId: this.cascadeId,
                interaction: { trajectoryId: perm._trajectoryId, stepIndex: perm._stepIndex, browserAction: { confirm: allowed } }
            };
        } else if (perm.type === 'file') {
            const scope = opts.scope || 'PERMISSION_SCOPE_CONVERSATION';
            const pathUri = perm.permissionPath || perm.contextTool?.DirectoryPath || perm.contextTool?.AbsolutePath || '';
            interactionPayload = {
                cascadeId: this.cascadeId,
                interaction: { trajectoryId: perm._trajectoryId, stepIndex: perm._stepIndex, filePermission: { allow: allowed, scope, absolutePathUri: pathUri } }
            };
        } else if (perm.type === 'run_command') {
            const cmdLine = perm.CommandLine || '';
            const submittedCmd = opts.editedCommand || cmdLine;
            interactionPayload = {
                cascadeId: this.cascadeId,
                interaction: { trajectoryId: perm._trajectoryId, stepIndex: perm._stepIndex, runCommand: { confirm: allowed, proposedCommandLine: cmdLine, submittedCommandLine: submittedCmd } }
            };
        } else if (perm.type === 'mcp') {
            interactionPayload = {
                cascadeId: this.cascadeId,
                interaction: { trajectoryId: perm._trajectoryId, stepIndex: perm._stepIndex, mcp: { confirm: allowed } }
            };
        } else {
            this._pendingToolCall = null;
            this.emit('error', `Unknown permission type: ${perm.type}`);
            return;
        }

        pktWrite(`APPROVE>>> ${JSON.stringify(interactionPayload).slice(0, 2000)}`);
        let res = await nodePost(this.auth.lsPort, 'HandleCascadeUserInteraction', interactionPayload, this.auth.csrfToken, this.auth.cdpHost);
        pktWrite(`APPROVE<<< status=${res.status} body=${res.body.slice(0, 500)}`);
        // Retry on "not registered" — race condition: server hasn't registered the input handler yet
        // Use up to 12 retries with 1s fixed delay (~12s total) to handle slow browser-action steps
        if (res.status !== 200 && res.body && res.body.includes('not registered')) {
            for (let retry = 1; retry <= 12; retry++) {
                const delay = 1000;
                pktWrite(`APPROVE_RETRY ${retry}/12 in ${delay}ms (not registered)`);
                await new Promise(r => setTimeout(r, delay));
                res = await nodePost(this.auth.lsPort, 'HandleCascadeUserInteraction', interactionPayload, this.auth.csrfToken, this.auth.cdpHost);
                pktWrite(`APPROVE<<< status=${res.status} body=${res.body.slice(0, 500)}`);
                if (res.status === 200 || !(res.body && res.body.includes('not registered'))) break;
            }
        }
        if (res.status !== 200) {
            if (res.body && res.body.includes('not registered')) {
                pktWrite(`APPROVE_GIVE_UP not registered after retries`);
                this.emit('error', `Approve give up (not registered after retries)`);
            } else {
                this.emit('error', `Interaction failed (${res.status}): ${res.body.slice(0, 80)}`);
            }
        }

        // Reset for continued response
        this._lastThinking = '';
        this._lastResponse = '';
        this._pendingToolCall = null;
        this.emit('permissionResolved');
        return res.status === 200;
    }

    _handleStreamEnd() {
        this.emit('streamReconnect');
        this.openStream();
    }

    // ── Send message ──

    async send(userText) {
        const sendPayload = {
            cascadeId: this.cascadeId,
            items: [{ text: userText }],
            metadata: this.auth.metadata,
            cascadeConfig: this.cascadeConfig,
            clientType: 'CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE',
        };
        const sendRes = await nodePost(this.auth.lsPort, 'SendUserCascadeMessage', sendPayload, this.auth.csrfToken, this.auth.cdpHost);
        if (sendRes.status !== 200) {
            this.emit('error', `Send failed (${sendRes.status}): ${sendRes.body.slice(0, 80)}`);
            return false;
        }
        this._lastThinking = '';
        this._lastResponse = '';
        this._pendingToolCall = null;
        this._awaitingResponse = true;
        return true;
    }

    // Wait for turn completion (returns a Promise)
    waitForTurn() {
        if (!this._awaitingResponse) return Promise.resolve();
        return new Promise(resolve => {
            this.once('turnDone', resolve);
        });
    }

    destroy() {
        if (this._stream) { try { this._stream.abort(); } catch { } }
        if (this._turnDoneTimer) clearTimeout(this._turnDoneTimer);
    }
}

// ─── Connect & create session ────────────────────────────────────────────────
async function connectAndAuth(logger) {
    const log = logger || (() => { });
    const cfg = loadConfig();
    const cdpPorts = cfg.defaults?.cdpPorts || [9229];
    const cdpHost = cfg.defaults?.cdpHost || '127.0.0.1';
    const targetExes = cfg.app?.targetExecutables || ['Antigravity.exe'];
    const appName = cfg.app?.name || 'Antigravity';

    // Find CDP port
    let cdpPort = null;
    log('info', `Scanning for ${appName} on ${cdpHost}:${cdpPorts.join(',')}...`);
    for (const p of cdpPorts) {
        const found = await checkPort(p, cdpHost);
        if (found) { cdpPort = p; break; }
    }

    if (!cdpPort) {
        log('info', `Not found. Launching ${appName}...`);
        const exeName = targetExes[0];
        const exeBase = exeName.replace(/\.exe$/i, '');
        let exePath;
        if (process.platform === 'win32') {
            exePath = `${process.env.LOCALAPPDATA}\\Programs\\${exeBase}\\${exeName}`;
        } else if (process.platform === 'darwin') {
            exePath = `/Applications/${exeBase}.app/Contents/MacOS/${exeBase}`;
        } else {
            exePath = `/usr/bin/${exeBase.toLowerCase()}`;
        }
        if (!fs.existsSync(exePath)) {
            throw new Error(`Not found: ${exePath}`);
        }
        const launchPort = cdpPorts[0];
        if (process.platform === 'win32') {
            try { execSync(`taskkill /IM ${exeName} /F`, { stdio: 'ignore' }); } catch { }
        } else {
            try { execSync(`pkill -f ${exeBase}`, { stdio: 'ignore' }); } catch { }
        }
        await new Promise(r => setTimeout(r, 2000));
        const { spawn } = require('child_process');
        const child = spawn(exePath, [`--remote-debugging-port=${launchPort}`, `--remote-debugging-address=${cdpHost}`], {
            detached: true, stdio: 'ignore', cwd: path.dirname(exePath),
        });
        child.on('error', err => log('error', `Launch error: ${err.message}`));
        child.unref();

        log('info', 'Waiting for startup...');
        const start = Date.now();
        while (Date.now() - start < 30000) {
            if (await checkPort(launchPort, cdpHost)) { cdpPort = launchPort; break; }
            await new Promise(r => setTimeout(r, 2000));
        }
        if (!cdpPort) throw new Error('Timed out waiting for app startup');
        log('info', `${appName} started on port ${cdpPort}`);
    } else {
        log('info', `Found instance on port ${cdpPort}`);
    }

    // Connect Puppeteer for auth extraction
    log('info', 'Extracting auth tokens...');
    const browser = await puppeteer.connect({
        browserURL: `http://${cdpHost}:${cdpPort}`,
        defaultViewport: null,
    });

    let page = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 60000) {
        for (const p of await browser.pages()) {
            const title = await p.title().catch(() => '');
            if (title.includes(appName) && title !== 'Manager' && title !== 'Launchpad') {
                try {
                    const ok = await p.evaluate(() => {
                        const has = Array.from(document.querySelectorAll('p, div, span')).some(el =>
                            el.innerText && el.innerText.includes('Ask anything'));
                        return has || !!document.querySelector('[contenteditable="true"]');
                    });
                    if (ok) { page = p; break; }
                } catch { }
            }
        }
        if (page) break;
        await new Promise(r => setTimeout(r, 2000));
    }
    if (!page) {
        browser.disconnect();
        throw new Error('No chat window found');
    }

    const auth = await captureAuth(browser, page, log);

    // Install IDE interaction interceptor (keeps browser connected)
    try {
        await page.exposeFunction('__onIdeInteraction', (payload) => {
            pktWrite(`IDE>>> HandleCascadeUserInteraction`);
            pktWrite(`IDE>>> ${payload.slice(0, 3000)}`);
        });
        await page.evaluate(() => {
            const origFetch = window.fetch;
            window.fetch = async function (...args) {
                const [url, opts] = args;
                if (typeof url === 'string' && url.includes('HandleCascadeUserInteraction') && opts?.body) {
                    try {
                        const buf = opts.body instanceof ArrayBuffer ? opts.body : await new Response(opts.body).arrayBuffer();
                        const bytes = new Uint8Array(buf);
                        if (bytes.length > 5) {
                            const json = new TextDecoder().decode(bytes.slice(5));
                            window.__onIdeInteraction(json);
                        }
                    } catch { }
                }
                return origFetch.apply(this, args);
            };
        });
        log('info', 'IDE interaction interceptor installed');
    } catch (e) {
        log('debug', `IDE interceptor failed: ${e.message} (non-critical)`);
        browser.disconnect();
    }

    if (!auth || !auth.metadata || !auth.csrfToken) {
        throw new Error(`Failed to extract auth. Ensure ${appName} is logged in.`);
    }

    auth.cdpHost = cdpHost;
    log('info', `Auth ready · LS port ${auth.lsPort} · host ${cdpHost}`);
    return auth;
}

// ─── High-level: create a ready-to-use session ───────────────────────────────
// Returns { session, auth, resumed, id, title }
// - First call: runs connectAndAuth to get auth tokens
// - Subsequent calls with same auth: just creates new Session
async function createSession(logger, opts = {}) {
    const auth = opts.auth || await connectAndAuth(logger);
    const session = new Session(auth);
    if (opts.cascadeId) {
        // Attach to specific existing cascade
        session.cascadeId = opts.cascadeId;
        session.openStream();
        return { session, auth, resumed: true, id: opts.cascadeId, title: '' };
    }
    const result = await session.resumeOrNew();
    if (!result) throw new Error('Failed to start or resume cascade session');
    session.openStream();
    return { session, auth, ...result };
}

// Create additional session using existing auth (for multi-cascade)
async function createExtraSession(auth, cascadeId) {
    const session = new Session(auth);
    if (cascadeId) {
        session.cascadeId = cascadeId;
    } else {
        const newId = await session.startNewCascade();
        if (!newId) throw new Error('Failed to start new cascade');
        session.cascadeId = newId;
    }
    session.openStream();
    return session;
}

// ─── Workspace helpers (shared by cli.js / telegram.js) ──────────────────────
const RULES_PATH = path.join(__dirname, '.agents', 'rules', 'rules.md');

function getCurrentWorkspace() {
    return loadConfig().activeWorkspace || 'workspace';
}

function listWorkspaces() {
    try {
        return fs.readdirSync(__dirname).filter(f => {
            if (!f.startsWith('workspace')) return false;
            const fp = path.join(__dirname, f);
            return fs.statSync(fp).isDirectory();
        });
    } catch { return []; }
}

function switchWorkspace(name) {
    let wsName = name;
    if (/^\d+$/.test(name)) wsName = name === '1' ? 'workspace' : `workspace${name}`;
    if (!wsName.startsWith('workspace')) wsName = `workspace${wsName}`;

    const wsDir = path.join(__dirname, wsName);
    if (!fs.existsSync(wsDir) || !fs.statSync(wsDir).isDirectory()) {
        return { ok: false, msg: `Directory not found: ${wsName}/` };
    }

    try {
        const cfg = loadConfig();
        cfg.activeWorkspace = wsName;
        saveConfig(cfg);

        let content = '';
        try { content = fs.readFileSync(RULES_PATH, 'utf8'); } catch { }
        if (/Current workspace: `[^`]+`/.test(content)) {
            content = content.replace(/Current workspace: `[^`]+`/, `Current workspace: \`${wsName}/\``);
        } else {
            content = content.trimEnd() + `\nCurrent workspace: \`${wsName}/\`\n`;
        }
        const rulesDir = path.dirname(RULES_PATH);
        if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true });
        fs.writeFileSync(RULES_PATH, content);

        const hasSoul = fs.existsSync(path.join(wsDir, 'soul.md'));
        return { ok: true, msg: `Workspace → ${wsName}/${hasSoul ? '' : ' (⚠️ no soul.md)'}` };
    } catch (e) {
        return { ok: false, msg: `Switch failed: ${e.message}` };
    }
}

// ─── Text splitting (shared by telegram.js / cronjob.js) ─────────────────────
function splitText(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) { chunks.push(remaining); break; }
        let splitAt = remaining.lastIndexOf('\n', maxLen);
        if (splitAt < maxLen * 0.5) splitAt = maxLen;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
    }
    return chunks;
}

// ─── Version check ──────────────────────────────────────────────────────────
const LOCAL_VERSION = require('./package.json').version;

async function checkUpdate() {
    try {
        const data = await new Promise((resolve, reject) => {
            https.get('https://raw.githubusercontent.com/joeIvan2/gagaclaw/main/package.json', {
                headers: { 'User-Agent': 'gagaclaw' }, timeout: 5000,
            }, res => {
                let body = '';
                res.on('data', d => body += d);
                res.on('end', () => resolve(body));
            }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
        });
        const remote = JSON.parse(data).version;
        if (remote !== LOCAL_VERSION) {
            return { upToDate: false, local: LOCAL_VERSION, remote };
        }
        return { upToDate: true, local: LOCAL_VERSION, remote };
    } catch {
        return { upToDate: null, local: LOCAL_VERSION, remote: null };
    }
}

// ─── Usage / Quota fetcher ──────────────────────────────────────────────────
/**
 * Fetches real-time quota/usage from the local Antigravity Language Server.
 * Uses the same technique as AntigravityQuota extension: probes GetUserStatus.
 * Returns an object with { userTier, models } or throws on failure.
 */
async function getUsage(auth) {
    // Resolve auth if not provided
    let lsPort = auth?.lsPort;
    let csrfToken = auth?.csrfToken;
    let apiKey = auth?.metadata?.apiKey;

    if (!lsPort || !csrfToken) {
        // Try to find from running process
        try {
            const { execSync } = require('child_process');
            const out = execSync('ps aux | grep language_server | grep -v grep', { encoding: 'utf8', timeout: 3000 });
            const csrfMatch = out.match(/--csrf_token\s+([a-f0-9\-]{36})/i);
            if (csrfMatch) csrfToken = csrfMatch[1];
            const pidMatch = out.match(/\S+\s+(\d+)/);
            if (pidMatch) {
                const pid = pidMatch[1];
                const ssOut = execSync(`ss -tlnp 2>/dev/null | grep 'pid=${pid}' | awk '{print $4}' | grep -oP '\\d+$'`, { encoding: 'utf8', timeout: 2000 }).trim();
                lsPort = ssOut.split(/\s+/).find(p => p);
            }
        } catch { }
    }

    if (!lsPort || !csrfToken) throw new Error('Cannot find Language Server (lsPort or csrfToken missing)');

    const metadata = auth?.metadata || { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en', ideVersion: '1.0.0', apiKey: apiKey || '' };
    const body = JSON.stringify({ metadata });

    const data = await new Promise((resolve, reject) => {
        const req = https.request({
            hostname: '127.0.0.1',
            port: lsPort,
            path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            method: 'POST',
            agent: tlsAgent,
            headers: {
                'content-type': 'application/json',
                'connect-protocol-version': '1',
                'x-codeium-csrf-token': csrfToken,
            },
            timeout: 8000,
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve(raw));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('GetUserStatus timeout')); });
        req.write(body);
        req.end();
    });

    const parsed = JSON.parse(data);
    const userStatus = parsed.userStatus || parsed;

    // Extract tier
    const tier = userStatus.userTier?.name || userStatus.userTier?.id || 'Unknown';

    // Extract per-model quota from cascadeModelConfigData.clientModelConfigs[]
    // Each model has: label, quotaInfo.remainingFraction (0.0–1.0), quotaInfo.resetTime
    const models = [];
    const clientModelConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
    for (const m of clientModelConfigs) {
        const label = m.label || m.name || 'Unknown Model';
        const qi = m.quotaInfo || {};
        const remainingFraction = qi.remainingFraction !== undefined ? qi.remainingFraction : null;
        const resetTime = qi.resetTime || null;
        // Convert fraction to percent
        const pct = remainingFraction !== null ? Math.round(remainingFraction * 100) : null;
        models.push({ label, remainingFraction, pct, resetTime });
    }

    return { userTier: tier, models, raw: userStatus };
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
    // Config
    loadConfig, saveConfig, MODELS, MODEL_BY_ID, MODES,
    getConfigModel, setConfigModel, getConfigMode, setConfigMode, getConfigAgentic, setConfigAgentic,
    // Transport
    nodePost, nodeStreamFetch, tlsAgent,
    // Parsing
    parseStreamFrame,
    // Auth
    checkPort, captureAuth, connectAndAuth,
    // Session
    Session, createSession, createExtraSession,
    // Workspace
    getCurrentWorkspace, listWorkspaces, switchWorkspace,
    // Utilities
    splitText,
    // Version
    LOCAL_VERSION, checkUpdate, getUsage,
    // Logging
    pktWrite,
};
