const elements = {
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    btnSend: document.getElementById('btn-send'),
    btnNewChat: document.getElementById('btn-new-chat'),
    cascadeList: document.getElementById('cascade-list'),
    currentChatTitle: document.getElementById('current-chat-title'),

    selectModel: document.getElementById('select-model'),
    selectMode: document.getElementById('select-mode'),
    checkAgentic: document.getElementById('check-agentic'),
    checkYolo: document.getElementById('check-yolo'),

    permModal: document.getElementById('permission-modal'),
    permDesc: document.getElementById('permission-desc'),
    permDetails: document.getElementById('permission-details'),
    btnPermDeny: document.getElementById('btn-perm-deny'),
    btnPermAllowOnce: document.getElementById('btn-perm-allow-once'),
    btnPermAllow: document.getElementById('btn-perm-allow'),

    statusText: document.getElementById('status-text'),
    statusDot: document.getElementById('connection-status'),
};

let currentMessageDiv = null;
let currentThinkingDiv = null;

// Initialize Markdown parser options
marked.setOptions({
    gfm: true,
    breaks: true
});

async function init() {
    await fetchStatus();
    await fetchCascades();
    setupEventListeners();
    setupSSE();
}

async function fetchStatus() {
    const res = await fetch('/api/status');
    const data = await res.json();

    // Populate dropdowns
    elements.selectModel.innerHTML = data.models.map(m => `<option value="${m.key}" ${data.model === m.key ? 'selected' : ''}>${m.label}</option>`).join('');
    elements.selectMode.innerHTML = data.modes.map(m => `<option value="${m.key}" ${data.mode === m.key ? 'selected' : ''}>${m.label}</option>`).join('');

    elements.checkAgentic.checked = data.agentic;
    elements.checkYolo.checked = data.yolo;
}

async function fetchCascades() {
    const res = await fetch('/api/cascades');
    const data = await res.json();

    elements.cascadeList.innerHTML = data.cascades.map(c => `
        <li class="${c.id === data.currentId ? 'active' : ''}" data-id="${c.id}" title="${c.summary || 'New Conversation'}">
            ${c.id.substring(0, 8)}... - ${c.summary ? c.summary.substring(0, 20) : 'New Conversation'}
        </li>
    `).join('');

    const curr = data.cascades.find(c => c.id === data.currentId);
    if (curr) {
        elements.currentChatTitle.textContent = curr.summary || 'New Conversation';
    }
}

function updateConfig(payload) {
    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

function setupEventListeners() {
    elements.selectModel.addEventListener('change', e => updateConfig({ model: e.target.value }));
    elements.selectMode.addEventListener('change', e => updateConfig({ mode: e.target.value }));
    elements.checkAgentic.addEventListener('change', e => updateConfig({ agentic: e.target.checked }));
    elements.checkYolo.addEventListener('change', e => updateConfig({ yolo: e.target.checked }));

    elements.btnNewChat.addEventListener('click', async () => {
        elements.chatMessages.innerHTML = '';
        await fetch('/api/cascades/new', { method: 'POST' });
        await fetchCascades();
    });

    elements.cascadeList.addEventListener('click', async (e) => {
        const li = e.target.closest('li');
        if (!li) return;
        const id = li.dataset.id;
        elements.chatMessages.innerHTML = ''; // Basic clear for demo (could fetch history if server maintained it)
        await fetch('/api/cascades/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        await fetchCascades();
    });

    elements.btnSend.addEventListener('click', sendMessage);
    elements.chatInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Permission Modal actions
    elements.btnPermDeny.addEventListener('click', () => sendPermission('deny'));
    elements.btnPermAllowOnce.addEventListener('click', () => sendPermission('allow_once'));
    elements.btnPermAllow.addEventListener('click', () => sendPermission('allow'));
}

async function sendMessage() {
    const text = elements.chatInput.value.trim();
    if (!text) return;

    elements.chatInput.value = '';
    elements.chatInput.style.height = 'auto';

    await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
    });
}

function sendPermission(action) {
    elements.permModal.classList.add('hidden');
    fetch('/api/permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
    });
}

function appendUserMessage(text) {
    const div = document.createElement('div');
    div.className = 'message user';
    div.innerHTML = `<div class="message-content">${marked.parse(text)}</div>`;
    elements.chatMessages.appendChild(div);
    scrollToBottom();
}

function ensureBotMessage() {
    if (!currentMessageDiv) {
        currentMessageDiv = document.createElement('div');
        currentMessageDiv.className = 'message bot';
        currentMessageDiv.innerHTML = `<div class="message-content"></div>`;
        elements.chatMessages.appendChild(currentMessageDiv);
    }
    return currentMessageDiv.querySelector('.message-content');
}

function ensureThinking() {
    if (!currentThinkingDiv) {
        currentThinkingDiv = document.createElement('div');
        currentThinkingDiv.className = 'thinking-block';
        if (currentMessageDiv) {
            elements.chatMessages.insertBefore(currentThinkingDiv, currentMessageDiv);
        } else {
            elements.chatMessages.appendChild(currentThinkingDiv);
        }
    }
    return currentThinkingDiv;
}

function appendToolCall(tc) {
    const div = document.createElement('div');
    div.className = 'tool-box';

    let icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`;

    const detail = tc.CommandLine || tc.Task || tc.AbsolutePath || tc.Url || '';

    div.innerHTML = `
        <div class="tool-header">${icon} ${tc.toolName}</div>
        <div class="tool-cmd">${detail}</div>
    `;
    elements.chatMessages.appendChild(div);
    scrollToBottom();
}

function showPermissionModal(data) {
    elements.permDesc.textContent = `Tool wants to execute a ${data.type} action.`;
    elements.permDetails.textContent = data.cmd || data.path || data.url || 'Unknown detail';
    elements.permModal.classList.remove('hidden');
}

function setupSSE() {
    const evtSource = new EventSource('/api/stream');

    evtSource.onopen = () => {
        elements.statusDot.classList.add('connected');
        elements.statusText.textContent = 'Connected';
    };

    evtSource.onerror = () => {
        elements.statusDot.classList.remove('connected');
        elements.statusText.textContent = 'Reconnecting...';
    };

    evtSource.addEventListener('userMessage', e => {
        const data = JSON.parse(e.data);
        appendUserMessage(data.text);
    });

    evtSource.addEventListener('thinking', e => {
        const data = JSON.parse(e.data);
        const div = ensureThinking();
        if (div.textContent.length < 150) { // Limit length to avoid massive blocks
            div.textContent += data.delta;
        } else if (!div.textContent.endsWith('...')) {
            div.textContent += '...';
        }
        scrollToBottom();
    });

    evtSource.addEventListener('response', e => {
        const data = JSON.parse(e.data);
        const content = ensureBotMessage();
        content.innerHTML = marked.parse(data.full);
        scrollToBottom();
    });

    evtSource.addEventListener('toolCall', e => {
        const tc = JSON.parse(e.data);
        if (tc.toolName === 'notify_user' && tc.Message) {
            // Render as regular bot message
            const content = ensureBotMessage();
            content.innerHTML += `<br><br>${marked.parse(tc.Message)}`;
            scrollToBottom();
        } else {
            appendToolCall(tc);
        }
    });

    evtSource.addEventListener('permissionWait', e => {
        const data = JSON.parse(e.data);
        showPermissionModal(data);
    });

    evtSource.addEventListener('permissionResolved', e => {
        elements.permModal.classList.add('hidden');
    });

    evtSource.addEventListener('newStep', () => {
        currentThinkingDiv = null;
    });

    evtSource.addEventListener('turnDone', () => {
        currentMessageDiv = null;
        currentThinkingDiv = null;
    });

    evtSource.addEventListener('error', e => {
        const data = JSON.parse(e.data);
        const div = document.createElement('div');
        div.className = 'tool-box';
        div.style.borderColor = 'var(--danger)';
        div.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
        div.innerHTML = `<span style="color: var(--danger)">⚠ Error: ${data.msg}</span>`;
        elements.chatMessages.appendChild(div);
        scrollToBottom();
    });
}

function scrollToBottom() {
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

// Auto-grow textarea
elements.chatInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
});

// Start
init();
