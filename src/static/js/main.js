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
});

import { MultimodalLiveClient } from './core/websocket-client.js';
import { AudioStreamer } from './audio/audio-streamer.js';
import { AudioRecorder } from './audio/audio-recorder.js';
import { CONFIG } from './config/config.js';
import { Logger } from './utils/logger.js';
import { VideoManager } from './video/video-manager.js';
import { ScreenRecorder } from './video/screen-recorder.js';

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

// 历史记录管理
const HistoryManager = {
    STORAGE_KEY: 'chat_history',
    MAX_HISTORY: 20,
    
    getHistory() {
        const history = localStorage.getItem(this.STORAGE_KEY);
        return history ? JSON.parse(history) : [];
    },
    
    saveHistory(history) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(history));
    },
    
    addConversation(title, messages) {
        const history = this.getHistory();
        history.unshift({
            id: Date.now(),
            title,
            timestamp: new Date().toLocaleString(),
            messages
        });
        
        // 限制历史记录数量
        if (history.length > this.MAX_HISTORY) {
            history.pop();
        }
        
        this.saveHistory(history);
        return history;
    },
    
    deleteConversation(id) {
        const history = this.getHistory().filter(item => item.id !== id);
        this.saveHistory(history);
        return history;
    }
};

// 历史记录UI交互
const historyContainer = document.getElementById('history-container');
const historyToggle = document.getElementById('history-toggle');
const closeHistoryBtn = document.querySelector('.close-history');
const historyList = document.querySelector('.history-list');

// 渲染历史记录列表
function renderHistoryList() {
    const history = HistoryManager.getHistory();
    historyList.innerHTML = '';
    
    history.forEach(item => {
        const historyItem = document.createElement('div');
        historyItem.className = 'history-item';
        historyItem.innerHTML = `
            <div class="history-item-title">${item.title}</div>
            <div class="history-item-time">${item.timestamp}</div>
        `;
        
        historyItem.addEventListener('click', () => {
            loadConversation(item);
            historyContainer.classList.remove('active');
        });
        
        historyList.appendChild(historyItem);
    });
}

// 加载历史对话
function loadConversation(conversation) {
    logsContainer.innerHTML = '';
    conversation.messages.forEach(msg => {
        logMessage(msg.content, msg.type);
    });
}

// 保存当前对话
function saveCurrentConversation() {
    const messages = Array.from(logsContainer.querySelectorAll('.log-entry')).map(el => ({
        type: el.classList.contains('log-entry system') ? 'system' :
              el.classList.contains('log-entry user') ? 'user' : 'ai',
        content: el.querySelector('span:last-child').textContent
    }));
    
    if (messages.length > 0) {
        const firstUserMessage = messages.find(msg => msg.type === 'user');
        const title = firstUserMessage ? firstUserMessage.content.substring(0, 30) : '新对话';
        HistoryManager.addConversation(title, messages);
        renderHistoryList();
    }
}

// 历史记录面板切换
historyToggle.addEventListener('click', () => {
    renderHistoryList();
    historyContainer.classList.add('active');
});

closeHistoryBtn.addEventListener('click', () => {
    historyContainer.classList.remove('active');
});

// 从localStorage加载保存的值
const savedApiKey = localStorage.getItem('gemini_api_key');
const savedVoice = localStorage.getItem('gemini_voice');
const savedFPS = localStorage.getItem('video_fps');
const savedSystemInstruction = localStorage.getItem('system_instruction');
const savedTheme = localStorage.getItem('ui_theme') || 'light';

// 主题切换功能
const themeToggle = document.getElementById('theme-toggle');
const updateThemeIcon = () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    themeToggle.textContent = isDark ? 'light_mode' : 'dark_mode';
    themeToggle.title = isDark ? '切换到浅色模式' : '切换到深色模式';
};

const toggleTheme = () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('ui_theme', newTheme);
    updateThemeIcon();
};

// 初始化主题
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeIcon();
themeToggle.addEventListener('click', toggleTheme);

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

// 处理设置面板切换
configToggle.addEventListener('click', () => {
    configContainer.classList.add('active');
});

closeConfigBtn.addEventListener('click', () => {
    configContainer.classList.remove('active');
});

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
    showNotification('设置已保存');
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

// 多模态客户端
const client = new MultimodalLiveClient();

/**
 * 显示一个临时通知
 * @param {string} message - 要显示的消息
 * @param {string} [type='info'] - 通知类型 (info, success, error)
 */
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.classList.add('notification', type, 'fade-in');
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
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
            emoji.textContent = '🫵';
            break;
        case 'ai':
            emoji.textContent = '🤖';
            break;
    }
    logEntry.appendChild(emoji);

    const messageText = document.createElement('span');
    messageText.textContent = message;
    logEntry.appendChild(messageText);

    logsContainer.appendChild(logEntry);
    
    // 使用平滑滚动到底部
    logsContainer.scrollTo({
        top: logsContainer.scrollHeight,
        behavior: 'smooth'
    });
    
    // 添加渐入动画
    logEntry.style.opacity = '0';
    setTimeout(() => {
        logEntry.style.opacity = '1';
    }, 10);
}

/**
 * 根据录音状态更新麦克风图标。
 */
function updateMicIcon() {
    micIcon.textContent = isRecording ? 'mic_off' : 'mic';
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
    
    if (!visualizer.contains(audioBar)) {
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

/**
 * 处理麦克风切换。开始或停止音频录制。
 * @returns {Promise<void>}
 */
async function handleMicToggle() {
    if (!isRecording) {
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
            Logger.error('麦克风错误:', error);
            logMessage(`错误: ${error.message}`, 'system');
            isRecording = false;
            updateMicIcon();
            showNotification('麦克风访问失败: ' + error.message, 'error');
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
        return;
    }

    try {
        // 显示连接中状态
        connectButton.textContent = '连接中...';
        connectButton.disabled = true;
        
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
                    }
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
        
        logMessage('已连接到Gemini 2.0 Flash多模态实时API', 'system');
        showNotification('连接成功', 'success');
    } catch (error) {
        const errorMessage = error.message || '未知错误';
        Logger.error('连接错误:', error);
        logMessage(`连接错误: ${errorMessage}`, 'system');
        isConnected = false;
        connectButton.textContent = '连接';
        connectButton.classList.remove('connected');
        connectButton.disabled = false;
        messageInput.disabled = true;
        sendButton.disabled = true;
        micButton.disabled = true;
        cameraButton.disabled = true;
        screenButton.disabled = true;
        
        showNotification('连接失败: ' + errorMessage, 'error');
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
        logMessage(message, 'user');
        client.send({ text: message });
        messageInput.value = '';
        
        // 聚焦回输入框
        messageInput.focus();
    }
}

// 事件监听器
client.on('open', () => {
    logMessage('WebSocket连接已打开', 'system');
});

client.on('log', (log) => {
    logMessage(`${log.type}: ${JSON.stringify(log.message)}`, 'system');
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

let typingIndicator = null;

function showTypingIndicator() {
    if (!typingIndicator) {
        typingIndicator = document.createElement('div');
        typingIndicator.className = 'log-entry ai typing-indicator';
        typingIndicator.innerHTML = `
            <span class="timestamp">${new Date().toLocaleTimeString()}</span>
            <span class="emoji">🤖</span>
            <div class="typing-dots">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
            </div>
        `;
        logsContainer.appendChild(typingIndicator);
        logsContainer.scrollTo({
            top: logsContainer.scrollHeight,
            behavior: 'smooth'
        });
    }
}

function hideTypingIndicator() {
    if (typingIndicator) {
        typingIndicator.remove();
        typingIndicator = null;
    }
}

client.on('content', (data) => {
    if (data.modelTurn) {
        if (data.modelTurn.parts.some(part => part.functionCall)) {
            isUsingTool = true;
            Logger.info('模型正在使用工具');
            showTypingIndicator();
        } else if (data.modelTurn.parts.some(part => part.functionResponse)) {
            isUsingTool = false;
            Logger.info('工具使用完成');
            hideTypingIndicator();
        }

        const text = data.modelTurn.parts.map(part => part.text).join('');
        if (text) {
            hideTypingIndicator();
            logMessage(text, 'ai');
        }
    }
});

client.on('interrupted', () => {
    hideTypingIndicator();
});

client.on('interrupted', () => {
    audioStreamer?.stop();
    isUsingTool = false;
    Logger.info('模型被中断');
    logMessage('模型被中断', 'system');
});

client.on('setupcomplete', () => {
    logMessage('设置完成', 'system');
});

client.on('turncomplete', () => {
    isUsingTool = false;
    logMessage('对话回合结束', 'system');
    saveCurrentConversation();
});

client.on('error', (error) => {
    if (error instanceof ApplicationError) {
        Logger.error(`应用错误: ${error.message}`, error);
    } else {
        Logger.error('意外错误', error);
    }
    logMessage(`错误: ${error.message}`, 'system');
    showNotification('发生错误: ' + error.message, 'error');
});

client.on('message', (message) => {
    if (message.error) {
        Logger.error('服务器错误:', message.error);
        logMessage(`服务器错误: ${message.error}`, 'system');
        showNotification('服务器错误: ' + message.error, 'error');
    }
});

// 按钮事件监听器
sendButton.addEventListener('click', handleSendMessage);
messageInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
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
    
    localStorage.setItem('video_fps', fpsInput.value);

    if (!isVideoActive) {
        try {
            Logger.info('尝试启动视频');
            if (!videoManager) {
                videoManager = new VideoManager();
            }
            
            await videoManager.start(fpsInput.value,(frameData) => {
                if (isConnected) {
                    client.sendRealtimeInput([frameData]);
                }
            });

            isVideoActive = true;
            cameraIcon.textContent = 'videocam_off';
            cameraButton.classList.add('active');
            Logger.info('摄像头启动成功');
            logMessage('摄像头已启动', 'system');
            showNotification('摄像头已启动', 'success');

        } catch (error) {
            Logger.error('摄像头错误:', error);
            logMessage(`错误: ${error.message}`, 'system');
            isVideoActive = false;
            videoManager = null;
            cameraIcon.textContent = 'videocam';
            cameraButton.classList.remove('active');
            showNotification('摄像头访问失败: ' + error.message, 'error');
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
    cameraIcon.textContent = 'videocam';
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
    if (!isScreenSharing) {
        try {
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
            screenIcon.textContent = 'stop_screen_share';
            screenButton.classList.add('active');
            Logger.info('屏幕共享已启动');
            logMessage('屏幕共享已启动', 'system');
            showNotification('屏幕共享已启动', 'success');

        } catch (error) {
            Logger.error('屏幕共享错误:', error);
            logMessage(`错误: ${error.message}`, 'system');
            isScreenSharing = false;
            screenIcon.textContent = 'screen_share';
            screenButton.classList.remove('active');
            screenContainer.style.display = 'none';
            showNotification('屏幕共享失败: ' + error.message, 'error');
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
    screenIcon.textContent = 'screen_share';
    screenButton.classList.remove('active');
    screenContainer.style.display = 'none';
    logMessage('屏幕共享已停止', 'system');
    showNotification('屏幕共享已停止');
}

screenButton.addEventListener('click', handleScreenShare);
screenContainer.querySelector('.close-button').addEventListener('click', stopScreenSharing);

// 添加通知样式
const notificationStyle = document.createElement('style');
notificationStyle.textContent = `
    .notification {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 10px 20px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        font-size: 14px;
        z-index: 2000;
        opacity: 1;
        transition: opacity 0.3s ease;
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.2);
    }
    .notification.success {
        background: rgba(52, 168, 83, 0.9);
    }
    .notification.error {
        background: rgba(234, 67, 53, 0.9);
    }
`;
document.head.appendChild(notificationStyle);

// 自动聚焦消息输入框（当启用时）
function focusInput() {
    if (!messageInput.disabled) {
        messageInput.focus();
    }
}

// 在页面加载后和连接成功后聚焦输入框
window.addEventListener('load', () => {
    // 添加欢迎消息
    logMessage('欢迎使用 Gemini Playground，请点击右上角的"连接"按钮开始', 'system');
});
