import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { chat } from "../../../../script.js";

const extensionName = "SillyTavern-Extension-ChatBridge";
const defaultSettings = {
    url: "http://localhost:8003",
    autoConnect: false,
    token: ""
};

if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = {};
}

// 只补充缺失的默认值，不覆盖已有设置
Object.keys(defaultSettings).forEach(key => {
    if (extension_settings[extensionName][key] === undefined) {
        extension_settings[extensionName][key] = defaultSettings[key];
    }
});

// 当前正在处理的请求 ID（用于回传响应）
let currentRequestId = null;
// 轮询是否运行中
let polling = false;
// 用于中断轮询的 AbortController
let pollAbortController = null;

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function getBaseUrl() {
    // 去掉末尾斜杠
    return (extension_settings[extensionName].url || 'http://localhost:8003').replace(/\/$/, '');
}

function getHeaders() {
    const token = extension_settings[extensionName].token;
    const headers = { "Content-Type": "application/json" };
    if (token) {
        headers["X-Token"] = token;
    }
    return headers;
}

function updateDebugLog(message) {
    const debugLog = $('#debug_log');
    if (debugLog.length === 0) {
        console.warn('找不到调试日志元素');
        return;
    }
    const timestamp = new Date().toLocaleTimeString();
    const currentContent = debugLog.val();
    const newLine = `[${timestamp}] ${message}\n`;
    debugLog.val(currentContent + newLine);
    debugLog.scrollTop(debugLog[0].scrollHeight);
    console.log(`[${extensionName}] ${message}`);
}

function updateStatus(connected) {
    const status = $('#cb_status');
    if (connected) {
        status.text('轮询中').css('color', 'green');
    } else {
        status.text('未连接').css('color', 'red');
    }
}

function updateControlButtons(running) {
    $('#cb_connect').prop('disabled', running);
    $('#cb_disconnect').prop('disabled', !running);
    $('#cb_url').prop('disabled', running);
    $('#cb_token').prop('disabled', running);
}

// ─── 消息格式转换 ─────────────────────────────────────────────────────────────

function convertOpenAIToSTMessage(msg) {
    const isUser = msg.role === 'user';
    const currentTime = new Date().toLocaleString();
    return {
        name: isUser ? 'user' : 'Assistant',
        is_user: isUser,
        is_system: false,
        send_date: currentTime,
        mes: msg.content,
        extra: {
            isSmallSys: false,
            token_count: 0,
            reasoning: ''
        },
        force_avatar: null
    };
}

// ─── 响应回传 ─────────────────────────────────────────────────────────────────

async function sendResponseToServer(requestId, content) {
    try {
        const payload = {
            type: "st_response",
            id: requestId,
            content: {
                id: `chatcmpl-${requestId}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "sillytavern",
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: content
                    },
                    finish_reason: "stop"
                }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            }
        };

        const resp = await fetch(`${getBaseUrl()}/st/response`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify(payload)
        });

        if (resp.ok) {
            updateDebugLog(`响应已回传 ID=${requestId.slice(0, 8)}`);
        } else {
            updateDebugLog(`回传失败 HTTP ${resp.status}`);
        }
    } catch (e) {
        updateDebugLog(`回传响应时出错: ${e.message}`);
    }
}

// ─── 处理收到的任务 ───────────────────────────────────────────────────────────

async function handleRequest(data) {
    if (data.type !== 'user_request') return;
    if (!data.content?.messages) {
        updateDebugLog('错误：消息格式不正确');
        return;
    }

    currentRequestId = data.id;
    updateDebugLog(`处理请求 ID=${data.id.slice(0, 8)}`);

    const context = getContext();
    const newChat = data.content.messages
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .map(msg => convertOpenAIToSTMessage(msg));

    chat.splice(0, chat.length, ...newChat);
    context.clearChat();
    context.printMessages();
    context.eventSource.emit(context.eventTypes.CHAT_CHANGED, context.getCurrentChatId());
    updateDebugLog(`已更新聊天内容，共 ${newChat.length} 条消息，等待 ST 生成...`);

    // 监听 ST 生成完成事件，回传响应
    const onGenerationDone = async () => {
        // 取最后一条 assistant 消息
        const lastMsg = context.chat[context.chat.length - 1];
        if (!lastMsg || lastMsg.is_user) {
            updateDebugLog('警告：生成完成但未找到 assistant 消息');
            return;
        }
        const replyText = lastMsg.mes || '';
        updateDebugLog(`ST 生成完成，内容长度: ${replyText.length}`);

        if (currentRequestId) {
            await sendResponseToServer(currentRequestId, replyText);
            currentRequestId = null;
        }

        // 只监听一次，完成后移除
        context.eventSource.removeListener(context.eventTypes.MESSAGE_RECEIVED, onGenerationDone);
    };

    // MESSAGE_RECEIVED 在 ST 收到完整回复后触发
    context.eventSource.once(context.eventTypes.MESSAGE_RECEIVED, onGenerationDone);

    // 触发 ST 发送
    $('#send_but').click();
}

// ─── HTTP 长轮询主循环 ────────────────────────────────────────────────────────

async function pollLoop() {
    updateDebugLog('开始 HTTP 长轮询...');
    updateStatus(true);

    // 先注册心跳
    try {
        await fetch(`${getBaseUrl()}/st/connect`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({})
        });
        updateDebugLog('已向服务器注册');
    } catch (e) {
        updateDebugLog(`注册失败: ${e.message}`);
    }

    while (polling) {
        pollAbortController = new AbortController();
        try {
            const resp = await fetch(`${getBaseUrl()}/st/poll`, {
                method: "GET",
                headers: getHeaders(),
                signal: pollAbortController.signal
            });

            if (resp.status === 204) {
                // 无任务，继续轮询
                continue;
            }

            if (resp.status === 401) {
                updateDebugLog('Token 验证失败，停止轮询');
                stopPolling();
                return;
            }

            if (!resp.ok) {
                updateDebugLog(`轮询返回错误 HTTP ${resp.status}，5s 后重试`);
                await sleep(5000);
                continue;
            }

            const data = await resp.json();
            updateDebugLog(`收到任务: ${JSON.stringify(data).slice(0, 100)}`);
            await handleRequest(data);

        } catch (e) {
            if (e.name === 'AbortError') {
                // 主动停止
                break;
            }
            updateDebugLog(`轮询出错: ${e.message}，5s 后重试`);
            await sleep(5000);
        }
    }

    updateDebugLog('轮询已停止');
    updateStatus(false);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 启动 / 停止 ──────────────────────────────────────────────────────────────

function startPolling() {
    if (polling) return;
    polling = true;
    updateControlButtons(true);
    pollLoop();
}

function stopPolling() {
    polling = false;
    if (pollAbortController) {
        pollAbortController.abort();
        pollAbortController = null;
    }
    updateControlButtons(false);
    updateStatus(false);
    updateDebugLog('已停止轮询');
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

jQuery(async () => {
    const template = await $.get(`/scripts/extensions/third-party/${extensionName}/index.html`);
    $('#extensions_settings').append(template);

    const s = extension_settings[extensionName];

    // 填充 UI 初始值
    $('#cb_url').val(s.url || 'http://localhost:8003');
    $('#cb_token').val(s.token || '');
    $('#cb_auto_connect').prop('checked', s.autoConnect || false);

    // 保存设置
    $('#cb_url').on('change', function () {
        extension_settings[extensionName].url = $(this).val().trim();
        saveSettingsDebounced();
    });
    $('#cb_token').on('change', function () {
        extension_settings[extensionName].token = $(this).val();
        saveSettingsDebounced();
    });

    // 按钮事件
    $('#cb_connect').on('click', startPolling);
    $('#cb_disconnect').on('click', stopPolling);

    // 自动连接
    $('#cb_auto_connect').on('change', function () {
        const checked = $(this).prop('checked');
        extension_settings[extensionName].autoConnect = checked;
        saveSettingsDebounced();
        if (checked) {
            updateDebugLog('已启用自动开始');
            startPolling();
        } else {
            updateDebugLog('已禁用自动开始');
        }
    });

    if (s.autoConnect) {
        startPolling();
    }

    updateDebugLog('扩展初始化完成（HTTP 轮询模式）');
});
