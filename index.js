import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { chat } from "../../../../script.js";

const extensionName = "SillyTavern-Extension-ChatBridge";
const defaultSettings = {
    wsPort: 8001,
    autoConnect: false,
    token: ""
};

if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = {};
}

Object.keys(defaultSettings).forEach(key => {
    if (extension_settings[extensionName][key] === undefined) {
        extension_settings[extensionName][key] = defaultSettings[key];
    }
});

let ws;

// ─── 调试日志 ─────────────────────────────────────────────────────────────────

function updateDebugLog(message) {
    const debugLog = $('#debug_log');
    if (debugLog.length === 0) return;
    const timestamp = new Date().toLocaleTimeString();
    debugLog.val(debugLog.val() + `[${timestamp}] ${message}\n`);
    debugLog.scrollTop(debugLog[0].scrollHeight);
    console.log(`[${extensionName}] ${message}`);
}

function updateWSStatus(connected) {
    const status = $('#ws_status');
    if (connected) {
        status.text('已连接').css('color', 'green');
    } else {
        status.text('未连接').css('color', 'red');
    }
}

// ─── 消息格式转换 ─────────────────────────────────────────────────────────────

function convertOpenAIToSTMessage(msg) {
    const isUser = msg.role === 'user';
    return {
        name: isUser ? 'user' : 'Assistant',
        is_user: isUser,
        is_system: false,
        send_date: new Date().toLocaleString(),
        mes: msg.content,
        extra: { isSmallSys: false, token_count: 0, reasoning: '' },
        force_avatar: null
    };
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function setupWebSocket() {
    const wsUrl = $('#ws_url').val();
    const wsPort = $('#ws_port').val();
    const token = $('#ws_token').val();
    let wsUrlFull = `ws://${wsUrl}:${wsPort}`;
    if (token) {
        wsUrlFull += `?token=${encodeURIComponent(token)}`;
    }
    updateDebugLog(`尝试连接WebSocket服务器: ${wsUrlFull}`);

    ws = new WebSocket(wsUrlFull);

    ws.onopen = () => {
        updateWSStatus(true);
        updateConnectionButtons(true);
        updateDebugLog('WebSocket连接已建立');
    };

    ws.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            updateDebugLog(`收到消息: ${JSON.stringify(data)}`);

            if (data.type === 'user_request') {
                updateDebugLog('收到用户请求');
                if (data.content?.messages) {
                    const context = getContext();
                    const newChat = data.content.messages
                        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
                        .map(msg => convertOpenAIToSTMessage(msg));

                    chat.splice(0, chat.length, ...newChat);
                    context.clearChat();
                    context.printMessages();
                    context.eventSource.emit(context.eventTypes.CHAT_CHANGED, context.getCurrentChatId());
                    updateDebugLog(`已更新聊天内容，共${context.chat.length}条消息`);
                    $('#send_but').click();
                } else {
                    updateDebugLog('错误：消息格式不正确');
                }
            }
        } catch (error) {
            updateDebugLog(`处理消息时出错: ${error.message}`);
            console.error(error);
        }
    };

    ws.onclose = () => {
        updateWSStatus(false);
        updateConnectionButtons(false);
        updateDebugLog('WebSocket连接已关闭');
    };

    ws.onerror = (error) => {
        updateWSStatus(false);
        updateDebugLog(`WebSocket错误: ${error}`);
    };
}

function updateConnectionButtons(connected) {
    $('#ws_connect').prop('disabled', connected);
    $('#ws_disconnect').prop('disabled', !connected);
    $('#ws_url').prop('disabled', connected);
    $('#ws_port').prop('disabled', connected);
    $('#ws_token').prop('disabled', connected);
}

function disconnectWebSocket() {
    if (ws) ws.close();
    updateWSStatus(false);
    updateConnectionButtons(false);
    updateDebugLog('已断开WebSocket连接');
    if (extension_settings[extensionName].autoConnect) {
        startAutoConnect();
    }
}

let autoConnectTimer = null;

function startAutoConnect() {
    if (autoConnectTimer) clearInterval(autoConnectTimer);
    autoConnectTimer = setInterval(() => {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            updateDebugLog('自动尝试连接尝试中...');
            setupWebSocket();
        }
    }, 5000);
}

function stopAutoConnect() {
    if (autoConnectTimer) {
        clearInterval(autoConnectTimer);
        autoConnectTimer = null;
    }
}

// ─── Plugin API：后端配置 ─────────────────────────────────────────────────────

const PLUGIN_API = '/api/plugins/chatbridge';
let pluginAvailable = false;

async function checkPlugin() {
    try {
        const resp = await fetch(`${PLUGIN_API}/probe`, { method: 'POST' });
        pluginAvailable = resp.ok;
    } catch {
        pluginAvailable = false;
    }
    if (!pluginAvailable) {
        $('#cb_py_status').text('插件未加载（需要 enableServerPlugins: true）').css('color', 'orange');
        updateDebugLog('ChatBridge Server Plugin 未加载，后端配置功能不可用');
    }
    return pluginAvailable;
}

async function loadBackendSettings() {
    if (!pluginAvailable) return;
    try {
        const resp = await fetch(`${PLUGIN_API}/settings`);
        if (!resp.ok) return;
        const s = await resp.json();
        $('#cb_user_api_key').val(s?.user_api?.api_key || '');
        $('#cb_user_api_port').val(s?.user_api?.port || 8003);
        $('#cb_ws_port').val(s?.websocket?.port || 8001);
    } catch (e) {
        updateDebugLog(`读取后端配置失败: ${e.message}`);
    }
}

async function saveBackendSettings() {
    if (!pluginAvailable) {
        $('#cb_save_status').text('插件未加载').css('color', 'red');
        return;
    }

    // 先读取当前完整配置，再只覆盖用户修改的字段
    let current = {};
    try {
        const resp = await fetch(`${PLUGIN_API}/settings`);
        if (resp.ok) current = await resp.json();
    } catch { /* 读取失败就用空对象 */ }

    const newSettings = {
        ...current,
        websocket: {
            ...(current.websocket || {}),
            host: '0.0.0.0',
            port: parseInt($('#cb_ws_port').val()) || 8001,
            token: '',
        },
        st_api: {
            ...(current.st_api || {}),
            host: '0.0.0.0',
            port: 8002,
            api_key: 'st-internal-key',
        },
        user_api: {
            ...(current.user_api || {}),
            host: '0.0.0.0',
            port: parseInt($('#cb_user_api_port').val()) || 8003,
            api_key: $('#cb_user_api_key').val().trim(),
        },
        llm_api: current.llm_api || { base_url: 'http://localhost', api_keys: ['placeholder'] },
    };

    try {
        $('#cb_save_status').text('保存中...').css('color', 'gray');
        const resp = await fetch(`${PLUGIN_API}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newSettings),
        });
        if (resp.ok) {
            $('#cb_save_status').text('已保存，后端重启中...').css('color', 'green');
            updateDebugLog('后端配置已保存，py 进程正在重启');
            setTimeout(pollPyStatus, 2000);
        } else {
            $('#cb_save_status').text(`保存失败 HTTP ${resp.status}`).css('color', 'red');
        }
    } catch (e) {
        $('#cb_save_status').text(`保存失败: ${e.message}`).css('color', 'red');
    }
}

async function pollPyStatus() {
    if (!pluginAvailable) return;
    try {
        const resp = await fetch(`${PLUGIN_API}/status`);
        if (!resp.ok) return;
        const data = await resp.json();
        const statusEl = $('#cb_py_status');
        if (data.running) {
            statusEl.text(`运行中 (PID: ${data.pid})`).css('color', 'green');
        } else {
            statusEl.text('已停止').css('color', 'red');
        }
    } catch { /* 忽略 */ }
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

jQuery(async () => {
    const template = await $.get(`/scripts/extensions/third-party/${extensionName}/index.html`);
    $('#extensions_settings').append(template);

    // WebSocket 设置
    $('#ws_port').val(extension_settings[extensionName].wsPort);
    $('#ws_token').val(extension_settings[extensionName].token);

    $('#ws_connect').on('click', setupWebSocket);
    $('#ws_disconnect').on('click', disconnectWebSocket);

    $('#ws_port').on('change', function () {
        extension_settings[extensionName].wsPort = $(this).val();
        saveSettingsDebounced();
    });
    $('#ws_token').on('change', function () {
        extension_settings[extensionName].token = $(this).val();
        saveSettingsDebounced();
    });

    $('#ws_auto_connect').prop('checked', extension_settings[extensionName].autoConnect);
    $('#ws_auto_connect').on('change', function () {
        const isChecked = $(this).prop('checked');
        extension_settings[extensionName].autoConnect = isChecked;
        saveSettingsDebounced();
        if (isChecked) {
            updateDebugLog('已启用自动尝试连接');
            startAutoConnect();
        } else {
            updateDebugLog('已禁用自动尝试连接');
            stopAutoConnect();
        }
    });

    // 后端配置
    $('#cb_save_settings').on('click', saveBackendSettings);

    // 检测 plugin 是否可用，可用则加载配置
    const available = await checkPlugin();
    if (available) {
        await loadBackendSettings();
        pollPyStatus();
        // 每 10 秒刷新一次进程状态
        setInterval(pollPyStatus, 10000);
    }

    // 自动连接 WebSocket
    setupWebSocket();
    if (extension_settings[extensionName].autoConnect) {
        startAutoConnect();
    }

    updateDebugLog('扩展初始化完成');
});
