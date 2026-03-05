const express = require('express');
const path = require('path');
const { createSession, MODELS, MODES, loadConfig } = require('./core');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Global state
let currentSession = null;
let sseClients = [];

// Logger for core.js
function webLogger(level, msg) {
    console.log(`[CORE:${level}] ${msg}`);
}

// Ensure session exists
async function ensureSession() {
    if (!currentSession) {
        const { session } = await createSession(webLogger);
        currentSession = session;
        setupSessionEvents(session);
    }
    return currentSession;
}

// Broadcast to SSE clients
function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(c => c.res.write(payload));
}

function setupSessionEvents(session) {
    session.on('thinking', (delta, full) => broadcast('thinking', { delta, full }));
    session.on('response', (delta, full) => broadcast('response', { delta, full }));
    session.on('toolCall', (tc) => broadcast('toolCall', tc));
    session.on('permissionWait', (perm) => broadcast('permissionWait', {
        type: perm.type,
        cmd: perm.CommandLine,
        path: perm.permissionPath || (perm.contextTool && (perm.contextTool.AbsolutePath || perm.contextTool.DirectoryPath)),
        url: perm.contextTool && perm.contextTool.Url
    }));
    session.on('newStep', () => broadcast('newStep', {}));
    session.on('turnDone', () => broadcast('turnDone', {}));
    session.on('error', (msg) => broadcast('error', { msg }));
    session.on('yoloApprove', (desc) => broadcast('yoloApprove', { desc }));
    session.on('permissionResolved', () => broadcast('permissionResolved', {}));
}

// API Routes
app.get('/api/status', async (req, res) => {
    const sess = await ensureSession();
    res.json({
        cascadeId: sess.cascadeId,
        model: sess.currentModelId,
        modelLabel: sess.modelLabel,
        mode: sess.currentMode,
        modeLabel: sess.modeLabel,
        agentic: sess.agenticEnabled,
        yolo: sess.yoloMode,
        models: Object.keys(MODELS).map(k => ({ key: k, label: MODELS[k].label })),
        modes: Object.keys(MODES).map(k => ({ key: k, label: MODES[k].label }))
    });
});

app.post('/api/send', async (req, res) => {
    const sess = await ensureSession();
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Empty message' });

    // Broadcast the user message back so UI can append it instantly
    broadcast('userMessage', { text: message });

    const ok = await sess.send(message);
    res.json({ success: ok });
});

app.post('/api/permission', async (req, res) => {
    const sess = await ensureSession();
    const { action, editedCommand } = req.body;
    // action: 'allow', 'allow_once', 'deny', 'edit'
    if (!sess._pendingToolCall) return res.status(400).json({ error: 'No pending permission' });

    let allowed = action === 'allow' || action === 'allow_once';
    let scope = action === 'allow_once' ? 'PERMISSION_SCOPE_TURN' : 'PERMISSION_SCOPE_CONVERSATION';

    if (action === 'edit' && editedCommand) {
        allowed = true;
    }

    await sess.approvePermission(sess._pendingToolCall, allowed, {
        scope,
        editedCommand: action === 'edit' ? editedCommand : undefined
    });

    res.json({ success: true });
});

app.post('/api/config', async (req, res) => {
    const sess = await ensureSession();
    const { model, mode, agentic, yolo } = req.body;
    if (model) sess.setModel(model);
    if (mode) sess.setMode(mode);
    if (agentic !== undefined) sess.setAgentic(agentic);
    if (yolo !== undefined) sess.setYolo(yolo);

    res.json({ success: true });
});

app.post('/api/cascades/new', async (req, res) => {
    const sess = await ensureSession();
    const newId = await sess.startNewCascade();
    if (newId) {
        sess.switchCascade(newId);
        res.json({ success: true, cascadeId: newId });
    } else {
        res.status(500).json({ error: 'Failed to start new cascade' });
    }
});

app.get('/api/cascades', async (req, res) => {
    const sess = await ensureSession();
    const list = await sess.listCascades();
    res.json({ cascades: list, currentId: sess.cascadeId });
});

app.post('/api/cascades/switch', async (req, res) => {
    const sess = await ensureSession();
    const { id } = req.body;
    sess.switchCascade(id);
    res.json({ success: true, cascadeId: id });
});

// SSE endpoint
app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const client = { res };
    sseClients.push(client);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== client);
    });
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Gagaclaw WebUI listening on http://localhost:${PORT}`);
    ensureSession();
});
