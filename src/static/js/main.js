// Performance monitoring and resource loading
/**
 * Performance monitoring utility
 */
const PerformanceMonitor = {
    marks: {},
    
    /**
     * Start timing for a specific action
     * @param {string} name - The name of the action
     */
    start(name) {
        this.marks[name] = performance.now();
    },
    
    /**
     * End timing for a specific action and log the duration
     * @param {string} name - The name of the action
     * @returns {number} - The duration in milliseconds
     */
    end(name) {
        if (!this.marks[name]) {
            console.warn(`No start mark found for ${name}`);
            return 0;
        }
        
        const duration = performance.now() - this.marks[name];
        console.info(`Performance: ${name} took ${duration.toFixed(2)}ms`);
        delete this.marks[name];
        return duration;
    }
};

/**
 * Resource loader for lazy loading
 */
const ResourceLoader = {
    loaded: {},
    
    /**
     * Lazy load a JavaScript module
     * @param {string} path - The path to the JavaScript module
     * @returns {Promise<any>} - The imported module
     */
    async loadModule(path) {
        if (this.loaded[path]) {
            return this.loaded[path];
        }
        
        PerformanceMonitor.start(`load-module-${path}`);
        try {
            const module = await import(path);
            this.loaded[path] = module;
            PerformanceMonitor.end(`load-module-${path}`);
            return module;
        } catch (err) {
            console.error(`Failed to load module ${path}:`, err);
            throw err;
        }
    },
    
    /**
     * Preload modules that might be needed soon
     * @param {string[]} paths - Paths to the modules to preload
     */
    preloadModules(paths) {
        // Use requestIdleCallback for non-critical resources
        if ('requestIdleCallback' in window) {
            requestIdleCallback(() => {
                paths.forEach(path => {
                    this.loadModule(path).catch(err => {
                        console.warn(`Preload failed for ${path}:`, err);
                    });
                });
            });
        } else {
            // Fallback for browsers not supporting requestIdleCallback
            setTimeout(() => {
                paths.forEach(path => {
                    this.loadModule(path).catch(err => {
                        console.warn(`Preload failed for ${path}:`, err);
                    });
                });
            }, 1000);
        }
    }
};

// 应用防抖动于某些频繁触发的事件处理函数
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

// 初始记录页面加载性能
PerformanceMonitor.start('page-load');
window.addEventListener('load', () => {
    PerformanceMonitor.end('page-load');
    
    // 预加载可能会用到的模块
    ResourceLoader.preloadModules([
        './audio/audio-streamer.js',
        './audio/audio-recorder.js',
        './video/video-manager.js',
        './video/screen-recorder.js'
    ]);
    
    // 隐藏加载覆盖层
    hideLoading();
});

import { MultimodalLiveClient } from './core/websocket-client.js';
import { AudioStreamer } from './audio/audio-streamer.js';
import { AudioRecorder } from './audio/audio-recorder.js';
import { CONFIG } from './config/config.js';
import { Logger } from './utils/logger.js';
import { VideoManager } from './video/video-manager.js';
import { ScreenRecorder } from './video/screen-recorder.js';
import { ErrorCodes } from './utils/error-boundary.js';

/**
 * @fileoverview Main entry point for the application.
 * Initializes and manages the UI, audio, video, and WebSocket interactions.
 */

// DOM 元素
const logsContainer = document.getElementById('logs-container');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const micButton = document.getElementById('mic-button');
const micIcon = document.getElementById('mic-icon');
const audioVisualizer = document.getElementById('audio-visualizer');
const connectionStatus = document.getElementById('connection-status');
const connectButton = document.getElementById('connect-button');
const cameraButton = document.getElementById('camera-button');
const cameraIcon = document.getElementById('camera-icon');
const stopVideoButton = document.getElementById('stop-video');
const screenButton = document.getElementById('screen-button');
const screenIcon = document.getElementById('screen-icon');
const screenContainer = document.getElementById('screen-container');
const screenPreview = document.getElementById('screen-preview');
const inputAudioVisualizer = document.getElementById('input-audio-visualizer');
const apiKeyInput = document.getElementById('api-key');
const voiceSelect = document.getElementById('voice-select');
const fpsInput = document.getElementById('fps-input');
const configToggle = document.getElementById('config-toggle');
const configContainer = document.getElementById('config-container');
const closeConfigBtn = document.querySelector('.close-config');
const systemInstructionInput = document.getElementById('system-instruction');
systemInstructionInput.value = CONFIG.SYSTEM_INSTRUCTION.TEXT;
const applyConfigButton = document.getElementById('apply-config');
const responseTypeSelect = document.getElementById('response-type-select');
const clearChatButton = document.getElementById('clear-chat');
const toggleApiVisibilityButton = document.getElementById('toggle-api-visibility');
const toggleApiVisibilityIcon = toggleApiVisibilityButton.querySelector('.material-symbols-outlined');
const themeToggleButton = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const presetButtons = document.querySelectorAll('.preset-button');
const loadingOverlay = document.getElementById('loading-overlay');
const toolIndicator = document.getElementById('tool-indicator');
const toolName = document.querySelector('.tool-name');

// 从localStorage加载保存的值
const savedApiKey = localStorage.getItem('gemini_api_key');
const savedVoice = localStorage.getItem('gemini_voice');
const savedFPS = localStorage.getItem('video_fps');
const savedSystemInstruction = localStorage.getItem('system_instruction');
const savedTheme = localStorage.getItem('ui_theme') || 'light';

if (savedApiKey) {
    apiKeyInput.value = savedApiKey;
}

if (savedVoice) {
    voiceSelect.value = savedVoice;
}

if (savedFPS) {
    fpsInput.value = savedFPS;
}

if (savedSystemInstruction) {
    systemInstructionInput.value = savedSystemInstruction;
    CONFIG.SYSTEM_INSTRUCTION.TEXT = savedSystemInstruction;
}

// 设置页面主题
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeIcon();

// 预设系统指令模板
const systemInstructionPresets = {
    assistant: "你是一个有用的助手，可以回答用户提出的各种问题，提供准确和有用的信息。你的回答应该简明扼要，但要全面。如果你不确定某个问题的答案，请坦诚地说出来。",
    coder: "你是一个专业的编程助手，擅长解决编程问题和代码相关的挑战。你可以提供代码示例、调试帮助和最佳实践建议。请确保你的代码是高效、可读和易于维护的。",
    creative: "你是一个创意合作伙伴，能够帮助用户进行创意思考、头脑风暴和内容创作。你的回答应该有创意、有灵感且能引起用户的思考。你可以提出新颖的观点和替代方案。"
};

// 处理预设按钮点击
presetButtons.forEach(button => {
    button.addEventListener('click', () => {
        const presetType = button.dataset.preset;
        if (systemInstructionPresets[presetType]) {
            systemInstructionInput.value = systemInstructionPresets[presetType];
        }
    });
});

// 处理设置面板切换
configToggle.addEventListener('click', () => {
    configContainer.classList.add('active');
});

closeConfigBtn.addEventListener('click', () => {
    configContainer.classList.remove('active');
});

// API密钥可见性切换
toggleApiVisibilityButton.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    // 使用表情符号替换文本图标
    toggleApiVisibilityButton.querySelector('.emoji-icon').textContent = isPassword ? '👁️' : '👁️‍🗨️';
});

// 主题切换
themeToggleButton.addEventListener('click', toggleTheme);

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('ui_theme', newTheme);
    updateThemeIcon();
    showNotification(`已切换到${newTheme === 'light' ? '浅色' : '深色'}主题`);
}

function updateThemeIcon() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    // 使用表情符号替换文本图标
    themeIcon.textContent = currentTheme === 'light' ? '🌙' : '☀️';
}

applyConfigButton.addEventListener('click', () => {
    configContainer.classList.remove('active');
    
    // 保存设置到本地存储
    localStorage.setItem('gemini_api_key', apiKeyInput.value);
    localStorage.setItem('gemini_voice', voiceSelect.value);
    localStorage.setItem('system_instruction', systemInstructionInput.value);
    localStorage.setItem('video_fps', fpsInput.value);
    
    // 更新系统指令
    CONFIG.SYSTEM_INSTRUCTION.TEXT = systemInstructionInput.value;
    
    // 显示通知
    showNotification('设置已保存', 'success');
});

// 自动调整文本区域的高度
messageInput.addEventListener('input', function() {
    this.style.height = 'auto';
    const maxHeight = 150; // 最大高度限制
    const newHeight = Math.min(this.scrollHeight, maxHeight);
    this.style.height = newHeight + 'px';
    
    // 如果达到最大高度，启用滚动
    if (this.scrollHeight > maxHeight) {
        this.style.overflowY = 'auto';
    } else {
        this.style.overflowY = 'hidden';
    }
});

// 状态变量
let isRecording = false;
let audioStreamer = null;
let audioCtx = null;
let isConnected = false;
let audioRecorder = null;
let isVideoActive = false;
let videoManager = null;
let isScreenSharing = false;
let screenRecorder = null;
let isUsingTool = false;
let currentChatId = null;

// 多模态客户端
const client = new MultimodalLiveClient();

/**
 * 显示加载覆盖层，带有自定义消息
 * @param {string} message - 要显示的加载消息
 */
function showLoading(message = '加载中...') {
    const loadingContent = loadingOverlay.querySelector('.loading-content p') || 
                          loadingOverlay.querySelector('p');
    
    if (loadingContent) {
        loadingContent.textContent = message;
    } else {
        const loadingContentDiv = document.createElement('div');
        loadingContentDiv.className = 'loading-content';
        loadingContentDiv.innerHTML = `
            <div class="loading-spinner"></div>
            <p>${message}</p>
        `;
        loadingOverlay.innerHTML = '';
        loadingOverlay.appendChild(loadingContentDiv);
    }
    
    loadingOverlay.style.display = 'flex';
    document.body.classList.add('loading-active');
    
    // 为屏幕阅读器添加状态标记
    loadingOverlay.setAttribute('aria-busy', 'true');
    loadingOverlay.setAttribute('role', 'progressbar');
    loadingOverlay.setAttribute('aria-label', message);
}

/**
 * 隐藏加载覆盖层
 */
function hideLoading() {
    loadingOverlay.style.display = 'none';
    document.body.classList.remove('loading-active');
    
    // 清除状态标记
    loadingOverlay.removeAttribute('aria-busy');
}

/**
 * 处理错误并显示给用户
 * @param {string|Error} error - 错误对象或错误消息
 * @param {string} [context=''] - 错误发生的上下文描述
 */
function handleError(error, context = '') {
    const errorMessage = error instanceof Error ? error.message : error;
    const contextPrefix = context ? `${context}: ` : '';
    
    // 记录到控制台
    Logger.error(`${contextPrefix}${errorMessage}`, error);
    
    // 记录到日志区域
    logMessage(`错误: ${contextPrefix}${errorMessage}`, 'system');
    
    // 显示通知
    showNotification(`${contextPrefix}${errorMessage}`, 'error');
    
    // 确保加载指示器被隐藏
    hideLoading();
    
    // 根据错误类型执行其他操作
    if (error.code === ErrorCodes.WEBSOCKET_CONNECTION_FAILED ||
        error.code === ErrorCodes.API_AUTHENTICATION_FAILED) {
        // 在认证或连接问题时显示设置面板
        configContainer.classList.add('active');
    }
}

/**
 * 显示一个临时通知
 * @param {string} message - 要显示的消息
 * @param {string} [type='info'] - 通知类型 (info, success, error)
 */
function showNotification(message, type = 'info') {
    // 移除之前存在的通知
    const existingNotifications = document.querySelectorAll('.notification');
    existingNotifications.forEach(n => n.remove());
    
    const notification = document.createElement('div');
    notification.classList.add('notification', type, 'fade-in');
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.classList.remove('fade-in');
        notification.classList.add('fade-out');
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

/**
 * 生成唯一的聊天ID
 * @returns {string} 唯一ID
 */
function generateChatId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

/**
 * 在UI上记录消息。
 * @param {string} message - 要记录的消息。
 * @param {string} [type='system'] - 消息类型 (system, user, ai).
 */
function logMessage(message, type = 'system') {
    const logEntry = document.createElement('div');
    logEntry.classList.add('log-entry', type);

    const timestamp = document.createElement('span');
    timestamp.classList.add('timestamp');
    timestamp.textContent = new Date().toLocaleTimeString();
    logEntry.appendChild(timestamp);

    const emoji = document.createElement('span');
    emoji.classList.add('emoji');
    switch (type) {
        case 'system':
            emoji.textContent = '⚙️';
            break;
        case 'user':
            emoji.textContent = '🙋';
            break;
        case 'ai':
            emoji.textContent = '🤖';
            break;
    }
    logEntry.appendChild(emoji);

    const messageText = document.createElement('span');
    messageText.classList.add('message-text');
    messageText.textContent = message;
    logEntry.appendChild(messageText);

    logsContainer.appendChild(logEntry);
    
    // 使用平滑滚动到底部
    logsContainer.scrollTo({
        top: logsContainer.scrollHeight,
        behavior: 'smooth'
    });
}

/**
 * 处理麦克风切换。开始或停止音频录制。
 * @returns {Promise<void>}
 */
async function handleMicToggle() {
    if (!isRecording) {
        // 如果未连接，先尝试连接
        if (!isConnected) {
            await connectToWebsocket();
            if (!isConnected) return;
        }
        
        try {
            await ensureAudioInitialized();
            audioRecorder = new AudioRecorder();
            
            const inputAnalyser = audioCtx.createAnalyser();
            inputAnalyser.fftSize = 256;
            const inputDataArray = new Uint8Array(inputAnalyser.frequencyBinCount);
            
            await audioRecorder.start((base64Data) => {
                if (isUsingTool) {
                    client.sendRealtimeInput([{
                        mimeType: "audio/pcm;rate=16000",
                        data: base64Data,
                        interrupt: true     // 使用工具时模型不可中断，所以我们手动执行
                    }]);
                } else {
                    client.sendRealtimeInput([{
                        mimeType: "audio/pcm;rate=16000",
                        data: base64Data
                    }]);
                }
                
                inputAnalyser.getByteFrequencyData(inputDataArray);
                const inputVolume = Math.max(...inputDataArray) / 255;
                updateAudioVisualizer(inputVolume, true);
            });

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const source = audioCtx.createMediaStreamSource(stream);
            source.connect(inputAnalyser);
            
            await audioStreamer.resume();
            isRecording = true;
            Logger.info('麦克风已启动');
            logMessage('麦克风已启动', 'system');
            updateMicIcon();
            showNotification('麦克风已启动', 'success');
        } catch (error) {
            handleError(error, '麦克风错误');
            isRecording = false;
            updateMicIcon();
        }
    } else {
        if (audioRecorder && isRecording) {
            audioRecorder.stop();
        }
        isRecording = false;
        logMessage('麦克风已停止', 'system');
        updateMicIcon();
        updateAudioVisualizer(0, true);
    }
}

/**
 * 如果音频上下文被暂停，则恢复它。
 * @returns {Promise<void>}
 */
async function resumeAudioContext() {
    if (audioCtx && audioCtx.state === 'suspended') {
        try {
            await audioCtx.resume();
        } catch (error) {
            Logger.error('恢复音频上下文时出错:', error);
        }
    }
}

/**
 * 连接到WebSocket服务器。
 * @returns {Promise<void>}
 */
async function connectToWebsocket() {
    if (!apiKeyInput.value) {
        logMessage('请输入API密钥', 'system');
        showNotification('请输入API密钥', 'error');
        
        // 自动显示设置面板
        configContainer.classList.add('active');
        apiKeyInput.focus();
        return;
    }

    try {
        // 显示连接中状态
        connectButton.textContent = '连接中...';
        connectButton.disabled = true;
        connectionStatus.textContent = '连接中...';
        showLoading('连接中...');
        
        // 保存值到localStorage
        localStorage.setItem('gemini_api_key', apiKeyInput.value);
        localStorage.setItem('gemini_voice', voiceSelect.value);
        localStorage.setItem('system_instruction', systemInstructionInput.value);

        const config = {
            model: CONFIG.API.MODEL_NAME,
            generationConfig: {
                responseModalities: responseTypeSelect.value,
                speechConfig: {
                    voiceConfig: { 
                        prebuiltVoiceConfig: { 
                            voiceName: voiceSelect.value
                        }
                    },
                },
            },
            systemInstruction: {
                parts: [{
                    text: systemInstructionInput.value
                }],
            }
        };  

        await client.connect(config, apiKeyInput.value);
        isConnected = true;
        await resumeAudioContext();
        connectButton.textContent = '断开连接';
        connectButton.classList.add('connected');
        connectButton.disabled = false;
        messageInput.disabled = false;
        sendButton.disabled = false;
        micButton.disabled = false;
        cameraButton.disabled = false;
        screenButton.disabled = false;
        
        // 更新连接状态指示器
        connectionStatus.textContent = '已连接';
        connectionStatus.classList.add('online');
        
        logMessage('已连接到Gemini 2.0 Flash多模态实时API', 'system');
        showNotification('连接成功', 'success');
        
        // 隐藏任何打开的设置面板
        configContainer.classList.remove('active');
        
        // 创建新对话会话
        if (!currentChatId) {
            currentChatId = generateChatId();
        }
        
        // 聚焦输入框
        messageInput.focus();
        
        hideLoading();
    } catch (error) {
        handleError(error, '连接错误');
        isConnected = false;
        connectButton.textContent = '连接';
        connectButton.classList.remove('connected');
        connectButton.disabled = false;
        messageInput.disabled = true;
        sendButton.disabled = true;
        micButton.disabled = true;
        cameraButton.disabled = true;
        screenButton.disabled = true;
        
        // 更新连接状态指示器
        connectionStatus.textContent = '未连接';
        connectionStatus.classList.remove('online');
        
        hideLoading();
    }
}

/**
 * 断开与WebSocket服务器的连接。
 */
function disconnectFromWebsocket() {
    client.disconnect();
    isConnected = false;
    if (audioStreamer) {
        audioStreamer.stop();
        if (audioRecorder) {
            audioRecorder.stop();
            audioRecorder = null;
        }
        isRecording = false;
        updateMicIcon();
    }
    connectButton.textContent = '连接';
    connectButton.classList.remove('connected');
    messageInput.disabled = true;
    sendButton.disabled = true;
    micButton.disabled = true;
    cameraButton.disabled = true;
    screenButton.disabled = true;
    
    // 更新连接状态指示器
    connectionStatus.textContent = '未连接';
    connectionStatus.classList.remove('online');
    
    logMessage('已断开与服务器的连接', 'system');
    showNotification('已断开连接');
    
    if (videoManager) {
        stopVideo();
    }
    
    if (screenRecorder) {
        stopScreenSharing();
    }
}

/**
 * 处理发送文本消息。
 */
function handleSendMessage() {
    const message = messageInput.value.trim();
    if (message) {
        // 如果未连接，先尝试连接
        if (!isConnected) {
            connectToWebsocket().then(() => {
                if (isConnected) {
                    sendMessage(message);
                }
            });
        } else {
            sendMessage(message);
        }
    }
}

/**
 * 发送消息到服务器
 * @param {string} message 消息内容
 */
function sendMessage(message) {
    logMessage(message, 'user');
    client.send({ text: message });
    messageInput.value = '';
    
    // 重置文本区域高度
    messageInput.style.height = 'auto';
    
    // 聚焦回输入框
    messageInput.focus();
}

// 事件监听器
client.on('open', () => {
    logMessage('WebSocket连接已打开', 'system');
});

client.on('log', (log) => {
    console.log(`${log.type}: ${JSON.stringify(log.message)}`);
    // 不在UI上显示所有日志，只显示重要的
    if (log.type === 'error') {
        logMessage(`${log.type}: ${JSON.stringify(log.message)}`, 'system');
    }
});

client.on('close', (event) => {
    logMessage(`WebSocket连接已关闭(代码 ${event.code})`, 'system');
    
    // 自动重置连接状态
    if (isConnected) {
        isConnected = false;
        connectButton.textContent = '连接';
        connectButton.classList.remove('connected');
        messageInput.disabled = true;
        sendButton.disabled = true;
        micButton.disabled = true;
        cameraButton.disabled = true;
        screenButton.disabled = true;
        
        // 更新连接状态指示器
        connectionStatus.textContent = '未连接';
        connectionStatus.classList.remove('online');
        
        showNotification('连接已断开，请重新连接', 'error');
    }
});

client.on('audio', async (data) => {
    try {
        await resumeAudioContext();
        const streamer = await ensureAudioInitialized();
        streamer.addPCM16(new Uint8Array(data));
    } catch (error) {
        logMessage(`处理音频时出错: ${error.message}`, 'system');
    }
});

// 创建或获取一个AI响应的消息容器
let currentAiResponse = null;
let currentResponseText = '';

client.on('content', (data) => {
    if (data.modelTurn) {
        if (data.modelTurn.parts.some(part => part.functionCall)) {
            isUsingTool = true;
            Logger.info('模型正在使用工具');
            showToolIndicator(data.modelTurn.parts.find(part => part.functionCall).functionCall.name);
        } else if (data.modelTurn.parts.some(part => part.functionResponse)) {
            isUsingTool = false;
            Logger.info('工具使用完成');
            hideToolIndicator();
        }

        const text = data.modelTurn.parts.map(part => part.text).join('');
        if (text) {
            // 流式文本处理
            if (!currentAiResponse) {
                // 创建一个新的AI回复元素
                currentAiResponse = document.createElement('div');
                currentAiResponse.classList.add('log-entry', 'ai');
                
                const timestamp = document.createElement('span');
                timestamp.classList.add('timestamp');
                timestamp.textContent = new Date().toLocaleTimeString();
                currentAiResponse.appendChild(timestamp);
                
                const emoji = document.createElement('span');
                emoji.classList.add('emoji');
                emoji.textContent = '🤖';
                currentAiResponse.appendChild(emoji);
                
                const messageText = document.createElement('span');
                messageText.classList.add('message-text');
                messageText.textContent = '';
                currentAiResponse.appendChild(messageText);
                
                logsContainer.appendChild(currentAiResponse);
                currentResponseText = '';
                
                // 滚动到最新消息
                logsContainer.scrollTo({
                    top: logsContainer.scrollHeight,
                    behavior: 'smooth'
                });
            }
            
            // 更新文本内容
            currentResponseText += text;
            const messageText = currentAiResponse.querySelector('.message-text');
            messageText.textContent = currentResponseText;
        }
    }
});

client.on('interrupted', () => {
    audioStreamer?.stop();
    isUsingTool = false;
    Logger.info('模型被中断');
    logMessage('模型被中断', 'system');
    hideToolIndicator();
});

client.on('setupcomplete', () => {
    logMessage('设置完成', 'system');
});

client.on('turncomplete', () => {
    isUsingTool = false;
    logMessage('对话回合结束', 'system');
    hideToolIndicator();
    
    // 重置当前响应变量，准备下一次交互
    if (currentAiResponse) {
        currentAiResponse = null;
        currentResponseText = '';
    }
});

client.on('error', (error) => {
    handleError(error, '应用错误');
});

client.on('message', (message) => {
    if (message.error) {
        handleError(message.error, '服务器错误');
    }
});

// 按钮事件监听器
sendButton.addEventListener('click', handleSendMessage);

// 支持Enter发送，Shift+Enter换行
messageInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault(); // 阻止默认的换行行为
        handleSendMessage();
    }
});

micButton.addEventListener('click', handleMicToggle);

connectButton.addEventListener('click', () => {
    if (isConnected) {
        disconnectFromWebsocket();
    } else {
        connectToWebsocket();
    }
});

// 初始化按钮状态
messageInput.disabled = true;
sendButton.disabled = true;
micButton.disabled = true;
cameraButton.disabled = true;
screenButton.disabled = true;
connectButton.textContent = '连接';

/**
 * 处理视频切换。开始或停止视频流。
 * @returns {Promise<void>}
 */
async function handleVideoToggle() {
    Logger.info('视频切换被点击，当前状态:', { isVideoActive, isConnected });
    
    // 如果未连接，先尝试连接
    if (!isConnected) {
        await connectToWebsocket();
        if (!isConnected) return;
    }
    
    localStorage.setItem('video_fps', fpsInput.value);

    if (!isVideoActive) {
        try {
            Logger.info('尝试启动视频');
            showLoading('启动视频中...');
            if (!videoManager) {
                videoManager = new VideoManager();
            }
            
            await videoManager.start(fpsInput.value,(frameData) => {
                if (isConnected) {
                    client.sendRealtimeInput([frameData]);
                }
            });

            isVideoActive = true;
            // 使用表情符号替换文本图标
            cameraIcon.textContent = '📹';
            cameraButton.classList.add('active');
            Logger.info('摄像头启动成功');
            logMessage('摄像头已启动', 'system');
            showNotification('摄像头已启动', 'success');
            hideLoading();
        } catch (error) {
            handleError(error, '摄像头错误');
            isVideoActive = false;
            videoManager = null;
            // 使用表情符号替换文本图标
            cameraIcon.textContent = '📷';
            cameraButton.classList.remove('active');
            hideLoading();
        }
    } else {
        Logger.info('停止视频');
        stopVideo();
    }
}

/**
 * 停止视频流。
 */
function stopVideo() {
    if (videoManager) {
        videoManager.stop();
        videoManager = null;
    }
    isVideoActive = false;
    // 使用表情符号替换文本图标
    cameraIcon.textContent = '📷';
    cameraButton.classList.remove('active');
    logMessage('摄像头已停止', 'system');
    showNotification('摄像头已停止');
}

cameraButton.addEventListener('click', handleVideoToggle);
stopVideoButton.addEventListener('click', stopVideo);

/**
 * 处理屏幕共享切换。开始或停止屏幕共享。
 * @returns {Promise<void>}
 */
async function handleScreenShare() {
    // 如果未连接，先尝试连接
    if (!isConnected) {
        await connectToWebsocket();
        if (!isConnected) return;
    }
    
    if (!isScreenSharing) {
        try {
            showLoading('启动屏幕共享中...');
            screenContainer.style.display = 'block';
            
            screenRecorder = new ScreenRecorder();
            await screenRecorder.start(screenPreview, (frameData) => {
                if (isConnected) {
                    client.sendRealtimeInput([{
                        mimeType: "image/jpeg",
                        data: frameData
                    }]);
                }
            });

            isScreenSharing = true;
            // 使用表情符号替换文本图标
            screenIcon.textContent = '⏹️';
            screenButton.classList.add('active');
            Logger.info('屏幕共享已启动');
            logMessage('屏幕共享已启动', 'system');
            showNotification('屏幕共享已启动', 'success');
            hideLoading();
        } catch (error) {
            handleError(error, '屏幕共享错误');
            isScreenSharing = false;
            // 使用表情符号替换文本图标
            screenIcon.textContent = '📺';
            screenButton.classList.remove('active');
            screenContainer.style.display = 'none';
            hideLoading();
        }
    } else {
        stopScreenSharing();
    }
}

/**
 * 停止屏幕共享。
 */
function stopScreenSharing() {
    if (screenRecorder) {
        screenRecorder.stop();
        screenRecorder = null;
    }
    isScreenSharing = false;
    // 使用表情符号替换文本图标
    screenIcon.textContent = '📺';
    screenButton.classList.remove('active');
    screenContainer.style.display = 'none';
    logMessage('屏幕共享已停止', 'system');
    showNotification('屏幕共享已停止');
}

screenButton.addEventListener('click', handleScreenShare);
screenContainer.querySelector('.close-button').addEventListener('click', stopScreenSharing);

// 自动聚焦消息输入框（当启用时）
function focusInput() {
    if (!messageInput.disabled) {
        messageInput.focus();
    }
}

/**
 * 显示工具使用指示器
 * @param {string} toolName - 工具名称
 */
function showToolIndicator(name) {
    toolName.textContent = `正在使用工具: ${name}...`;
    toolIndicator.style.display = 'block';
    toolIndicator.setAttribute('aria-hidden', 'false');
}

/**
 * 隐藏工具使用指示器
 */
function hideToolIndicator() {
    toolIndicator.classList.add('closing');
    setTimeout(() => {
        toolIndicator.style.display = 'none';
        toolIndicator.classList.remove('closing');
        toolIndicator.setAttribute('aria-hidden', 'true');
    }, 300);
}

// 在页面加载后显示欢迎消息
window.addEventListener('load', () => {
    // 添加欢迎消息
    logMessage('欢迎使用 Gemini Playground，一个多模态API体验工具', 'system');
    logMessage('点击右上角的"连接"按钮开始，或者进入设置页面配置API密钥', 'system');
});

/**
 * 格式化日期时间为更友好的显示格式
 * @param {Date} date - 日期对象
 * @returns {string} 格式化后的日期字符串
 */
function formatDateTime(date) {
    // 获取当前日期
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    // 传入日期的日期部分
    const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    // 判断是今天、昨天还是更早
    let prefix = '';
    if (dateDay.getTime() === today.getTime()) {
        prefix = '今天 ';
    } else if (dateDay.getTime() === yesterday.getTime()) {
        prefix = '昨天 ';
    } else {
        // 其他日期显示完整年月日
        prefix = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} `;
    }
    
    // 加上时间
    return `${prefix}${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 清空当前聊天
 */
function clearChat() {
    // 清空UI
    logsContainer.innerHTML = '';
    
    // 创建新聊天会话
    currentChatId = generateChatId();
    
    // 显示系统消息
    logMessage('聊天已清空。', 'system');
    
    // 如果已连接，断开并重新连接websocket以清空AI上下文
    if (isConnected) {
        // 先断开连接
        client.disconnect();
        isConnected = false;
        
        // 然后重新连接
        connectToWebsocket().then(() => {
            logMessage('已重置AI上下文', 'system');
        }).catch(error => {
            handleError(error, '重连错误');
        });
    }
}

// 清空聊天按钮事件处理
clearChatButton.addEventListener('click', clearChat);

/**
 * 根据录音状态更新麦克风图标。
 */
function updateMicIcon() {
    // 使用表情符号替换文本图标
    micIcon.textContent = isRecording ? '🛑' : '🎤';
    micButton.style.backgroundColor = isRecording ? '#ea4335' : '';
    micButton.classList.toggle('active', isRecording);
}

/**
 * 根据音量更新音频可视化器。
 * @param {number} volume - 音频音量(0.0 到 1.0)。
 * @param {boolean} [isInput=false] - 是否为输入音频的可视化器。
 */
function updateAudioVisualizer(volume, isInput = false) {
    const visualizer = isInput ? inputAudioVisualizer : audioVisualizer;
    const audioBar = visualizer.querySelector('.audio-bar') || document.createElement('div');
    
    if (!audioBar.classList.contains('audio-bar')) {
        audioBar.classList.add('audio-bar');
        visualizer.appendChild(audioBar);
    }
    
    audioBar.style.width = `${volume * 100}%`;
    if (volume > 0.05) {
        audioBar.classList.add('active');
    } else {
        audioBar.classList.remove('active');
    }
}

/**
 * 如果尚未初始化，则初始化音频上下文和流传输器。
 * @returns {Promise<AudioStreamer>} 音频流传输器实例。
 */
async function ensureAudioInitialized() {
    if (!audioCtx) {
        audioCtx = new AudioContext();
    }
    if (!audioStreamer) {
        audioStreamer = new AudioStreamer(audioCtx);
        await audioStreamer.addWorklet('vumeter-out', 'js/audio/worklets/vol-meter.js', (ev) => {
            updateAudioVisualizer(ev.data.volume);
        });
    }
    return audioStreamer;
}
