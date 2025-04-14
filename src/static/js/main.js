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

// 导入新增工具
import { WeatherTool } from './tools/weather-tool.js';
import { GoogleSearchTool } from './tools/google-search.js';

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

// 新增 DOM 元素
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const toggleApiKeyBtn = document.getElementById('toggle-api-key');
const toolsToggle = document.getElementById('tools-toggle');
const sidePanel = document.getElementById('side-panel');
const closeToolsBtn = document.getElementById('close-tools');
const toolCards = document.querySelectorAll('.tool-card');
const toolPanel = document.getElementById('tool-panel');
const closeToolBtn = document.querySelector('.close-tool');
const activeToolTitle = document.getElementById('active-tool-title');
const toolContent = document.getElementById('tool-content');
const submitToolBtn = document.getElementById('submit-tool');
const connectionStatus = document.querySelector('.connection-status');
const modelSelect = document.getElementById('model-select');
const exportHistoryBtn = document.getElementById('export-history');
const clearHistoryBtn = document.getElementById('clear-history');
const attachmentButton = document.getElementById('attachment-button');
const fileInput = document.getElementById('file-input');

// 从localStorage加载保存的值
const savedApiKey = localStorage.getItem('gemini_api_key');
const savedVoice = localStorage.getItem('gemini_voice');
const savedFPS = localStorage.getItem('video_fps');
const savedSystemInstruction = localStorage.getItem('system_instruction');
const savedTheme = localStorage.getItem('ui_theme') || 'light';
const savedModel = localStorage.getItem('model_name') || 'gemini-2.0-flash';

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

if (savedModel) {
    modelSelect.value = savedModel;
}

// 设置页面主题
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeIcon(savedTheme);

// 处理主题切换
themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('ui_theme', newTheme);
    updateThemeIcon(newTheme);
});

/**
 * 更新主题图标
 * @param {string} theme - 当前主题 ('light' 或 'dark')
 */
function updateThemeIcon(theme) {
    themeIcon.textContent = theme === 'light' ? 'dark_mode' : 'light_mode';
}

// 处理API密钥显示切换
toggleApiKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        toggleApiKeyBtn.querySelector('span').textContent = 'visibility';
    } else {
        apiKeyInput.type = 'password';
        toggleApiKeyBtn.querySelector('span').textContent = 'visibility_off';
    }
});

// 处理设置面板切换
configToggle.addEventListener('click', () => {
    configContainer.classList.add('active');
});

closeConfigBtn.addEventListener('click', () => {
    configContainer.classList.remove('active');
});

// 处理工具面板切换
toolsToggle.addEventListener('click', () => {
    sidePanel.classList.toggle('active');
});

closeToolsBtn.addEventListener('click', () => {
    sidePanel.classList.remove('active');
});

// 处理工具卡片点击
toolCards.forEach(card => {
    card.addEventListener('click', () => {
        const toolType = card.getAttribute('data-tool');
        openToolPanel(toolType);
    });
});

closeToolBtn.addEventListener('click', closeToolPanel);

/**
 * 打开特定工具面板
 * @param {string} toolType - 工具类型
 */
function openToolPanel(toolType) {
    toolPanel.style.display = 'flex';
    
    // 清空之前的内容
    toolContent.innerHTML = '';
    
    // 根据工具类型设置标题和内容
    switch (toolType) {
        case 'weather':
            activeToolTitle.textContent = '天气查询';
            renderWeatherTool();
            break;
        case 'search':
            activeToolTitle.textContent = '网络搜索';
            renderSearchTool();
            break;
        case 'calculator':
            activeToolTitle.textContent = '计算器';
            renderCalculatorTool();
            break;
        case 'translator':
            activeToolTitle.textContent = '翻译工具';
            renderTranslatorTool();
            break;
        default:
            activeToolTitle.textContent = '工具';
            toolContent.textContent = '工具内容加载失败';
    }
}

/**
 * 关闭工具面板
 */
function closeToolPanel() {
    toolPanel.style.display = 'none';
}

/**
 * 渲染天气工具
 */
function renderWeatherTool() {
    const weatherForm = document.createElement('div');
    weatherForm.classList.add('tool-form');
    
    const locationInput = document.createElement('input');
    locationInput.type = 'text';
    locationInput.placeholder = '输入城市名称（如：北京）';
    locationInput.classList.add('tool-input');
    
    weatherForm.appendChild(createFormGroup('位置', locationInput));
    toolContent.appendChild(weatherForm);
    
    // 更新提交按钮行为
    submitToolBtn.onclick = async () => {
        const location = locationInput.value.trim();
        if (!location) {
            showNotification('请输入城市名称', 'error');
            return;
        }
        
        try {
            const weatherTool = new WeatherTool();
            const weatherData = await weatherTool.getWeather(location);
            
            // 发送到聊天
            logMessage(`我查询了 ${location} 的天气`, 'user');
            const weatherMessage = `${location}天气：${weatherData.weather}，温度${weatherData.temperature}°C，湿度${weatherData.humidity}%`;
            client.send({ text: weatherMessage });
            
            closeToolPanel();
        } catch (error) {
            showNotification(`天气查询失败: ${error.message}`, 'error');
        }
    };
}

/**
 * 渲染搜索工具
 */
function renderSearchTool() {
    const searchForm = document.createElement('div');
    searchForm.classList.add('tool-form');
    
    const queryInput = document.createElement('input');
    queryInput.type = 'text';
    queryInput.placeholder = '输入搜索关键词';
    queryInput.classList.add('tool-input');
    
    searchForm.appendChild(createFormGroup('搜索关键词', queryInput));
    toolContent.appendChild(searchForm);
    
    // 更新提交按钮行为
    submitToolBtn.onclick = async () => {
        const query = queryInput.value.trim();
        if (!query) {
            showNotification('请输入搜索关键词', 'error');
            return;
        }
        
        try {
            const searchTool = new GoogleSearchTool();
            const searchResults = await searchTool.search(query);
            
            // 发送到聊天
            logMessage(`我搜索了 "${query}"`, 'user');
            client.send({ text: `我想了解关于"${query}"的信息，以下是搜索结果：${JSON.stringify(searchResults)}` });
            
            closeToolPanel();
        } catch (error) {
            showNotification(`搜索失败: ${error.message}`, 'error');
        }
    };
}

/**
 * 渲染计算器工具
 */
function renderCalculatorTool() {
    const calcContainer = document.createElement('div');
    calcContainer.classList.add('calculator');
    
    const display = document.createElement('div');
    display.classList.add('calc-display');
    display.textContent = '0';
    
    const buttons = document.createElement('div');
    buttons.classList.add('calc-buttons');
    
    const buttonValues = [
        '7', '8', '9', '/',
        '4', '5', '6', '*',
        '1', '2', '3', '-',
        '0', '.', '=', '+'
    ];
    
    let currentInput = '0';
    let operator = null;
    let previousInput = null;
    
    buttonValues.forEach(value => {
        const button = document.createElement('button');
        button.textContent = value;
        button.classList.add('calc-button');
        
        if (['/', '*', '-', '+', '='].includes(value)) {
            button.classList.add('operator');
        }
        
        button.addEventListener('click', () => {
            if ('0123456789.'.includes(value)) {
                if (currentInput === '0' && value !== '.') {
                    currentInput = value;
                } else if (currentInput.includes('.') && value === '.') {
                    // 忽略重复小数点
                } else {
                    currentInput += value;
                }
                display.textContent = currentInput;
            } else if ('+-*/'.includes(value)) {
                if (previousInput !== null) {
                    // 执行之前的操作
                    currentInput = calculate(previousInput, currentInput, operator);
                    display.textContent = currentInput;
                }
                previousInput = currentInput;
                currentInput = '0';
                operator = value;
            } else if (value === '=') {
                if (previousInput !== null) {
                    currentInput = calculate(previousInput, currentInput, operator);
                    display.textContent = currentInput;
                    previousInput = null;
                    operator = null;
                }
            }
        });
        
        buttons.appendChild(button);
    });
    
    // 添加清除按钮
    const clearButton = document.createElement('button');
    clearButton.textContent = 'C';
    clearButton.classList.add('calc-button', 'clear');
    clearButton.addEventListener('click', () => {
        currentInput = '0';
        previousInput = null;
        operator = null;
        display.textContent = currentInput;
    });
    buttons.appendChild(clearButton);
    
    calcContainer.appendChild(display);
    calcContainer.appendChild(buttons);
    toolContent.appendChild(calcContainer);
    
    // 更新提交按钮行为
    submitToolBtn.onclick = () => {
        const result = display.textContent;
        logMessage(`计算结果: ${result}`, 'user');
        client.send({ text: `计算结果是 ${result}` });
        closeToolPanel();
    };
    
    // 辅助函数：计算
    function calculate(a, b, op) {
        a = parseFloat(a);
        b = parseFloat(b);
        switch (op) {
            case '+': return String(a + b);
            case '-': return String(a - b);
            case '*': return String(a * b);
            case '/': return b !== 0 ? String(a / b) : 'Error';
            default: return b;
        }
    }
    
    // 添加计算器样式
    const calcStyle = document.createElement('style');
    calcStyle.textContent = `
        .calculator {
            width: 100%;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .calc-display {
            background: #f1f1f1;
            color: #333;
            font-size: 1.8rem;
            padding: 1rem;
            text-align: right;
        }
        .calc-buttons {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
        }
        .calc-button {
            border: 1px solid #ddd;
            background: #fff;
            font-size: 1.2rem;
            padding: 1rem;
            cursor: pointer;
        }
        .calc-button:hover {
            background: #f9f9f9;
        }
        .calc-button.operator {
            background: #f0f8ff;
        }
        .calc-button.clear {
            background: #ffe6e6;
            grid-column: span 4;
        }
    `;
    document.head.appendChild(calcStyle);
}

/**
 * 渲染翻译工具
 */
function renderTranslatorTool() {
    const transForm = document.createElement('div');
    transForm.classList.add('tool-form');
    
    const sourceInput = document.createElement('textarea');
    sourceInput.placeholder = '输入要翻译的文本';
    sourceInput.rows = 4;
    sourceInput.classList.add('tool-input');
    
    const sourceLang = document.createElement('select');
    ['自动检测', '中文', '英语', '日语', '韩语', '法语', '德语', '俄语'].forEach(lang => {
        const option = document.createElement('option');
        option.value = lang;
        option.textContent = lang;
        sourceLang.appendChild(option);
    });
    
    const targetLang = document.createElement('select');
    ['英语', '中文', '日语', '韩语', '法语', '德语', '俄语'].forEach(lang => {
        const option = document.createElement('option');
        option.value = lang;
        option.textContent = lang;
        if (lang === '中文') option.selected = true;
        targetLang.appendChild(option);
    });
    
    transForm.appendChild(createFormGroup('源文本', sourceInput));
    transForm.appendChild(createFormGroup('源语言', sourceLang));
    transForm.appendChild(createFormGroup('目标语言', targetLang));
    
    toolContent.appendChild(transForm);
    
    // 更新提交按钮行为
    submitToolBtn.onclick = () => {
        const text = sourceInput.value.trim();
        const fromLang = sourceLang.value;
        const toLang = targetLang.value;
        
        if (!text) {
            showNotification('请输入要翻译的文本', 'error');
            return;
        }
        
        logMessage(`请将以下文本从${fromLang}翻译为${toLang}：${text}`, 'user');
        client.send({ text: `请将以下文本从${fromLang}翻译为${toLang}：\n\n${text}` });
        closeToolPanel();
    };
}

/**
 * 创建表单分组
 * @param {string} label - 标签文本
 * @param {HTMLElement} inputElement - 输入元素
 * @returns {HTMLDivElement} 表单分组元素
 */
function createFormGroup(label, inputElement) {
    const group = document.createElement('div');
    group.classList.add('form-group');
    
    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    
    group.appendChild(labelElement);
    group.appendChild(inputElement);
    
    return group;
}

// 处理历史记录导出
exportHistoryBtn.addEventListener('click', exportChatHistory);

/**
 * 导出聊天历史
 */
function exportChatHistory() {
    const chatLogs = Array.from(logsContainer.children).map(log => {
        const type = log.classList.contains('user') ? 'user' : 
                    log.classList.contains('ai') ? 'ai' : 'system';
        return {
            type,
            message: log.textContent.replace(/\d{1,2}:\d{1,2}:\d{1,2}⚙️|🫵|🤖/, '').trim(),
            timestamp: new Date().toISOString()
        };
    });
    
    const exportData = {
        exportTime: new Date().toISOString(),
        chatHistory: chatLogs
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-history-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showNotification('聊天历史已导出', 'success');
}

// 处理历史记录清除
clearHistoryBtn.addEventListener('click', () => {
    if (confirm('确定要清除所有聊天历史吗？此操作不可撤销。')) {
        logsContainer.innerHTML = '';
        logMessage('聊天历史已清除', 'system');
        showNotification('聊天历史已清除', 'success');
    }
});

// 处理文件上传
attachmentButton.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', handleFileUpload);

/**
 * 处理文件上传
 */
async function handleFileUpload() {
    const files = fileInput.files;
    if (!files || files.length === 0) return;
    
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    
    try {
        const uploadMessages = [];
        
        for (const file of files) {
            if (file.size > MAX_FILE_SIZE) {
                showNotification(`文件过大: ${file.name}`, 'error');
                continue;
            }
            
            const reader = new FileReader();
            const filePromise = new Promise((resolve, reject) => {
                reader.onload = e => resolve(e.target.result);
                reader.onerror = () => reject(new Error(`无法读取文件: ${file.name}`));
                
                // 根据文件类型选择读取方式
                if (file.type.startsWith('image/')) {
                    reader.readAsDataURL(file);
                } else if (file.type === 'application/pdf' || file.type.startsWith('text/')) {
                    reader.readAsArrayBuffer(file);
                } else {
                    reject(new Error(`不支持的文件类型: ${file.type}`));
                }
            });
            
            const fileData = await filePromise;
            
            if (file.type.startsWith('image/')) {
                uploadMessages.push({
                    mimeType: file.type,
                    data: fileData.split(',')[1] // 去掉 data:image/jpeg;base64, 前缀
                });
            } else if (file.type === 'application/pdf') {
                uploadMessages.push({
                    mimeType: 'application/pdf',
                    data: arrayBufferToBase64(fileData)
                });
            } else if (file.type.startsWith('text/')) {
                const text = new TextDecoder().decode(fileData);
                uploadMessages.push({
                    text: text
                });
            }
        }
        
        if (uploadMessages.length > 0) {
            logMessage(`上传了 ${uploadMessages.length} 个文件`, 'user');
            client.sendRealtimeInput(uploadMessages);
            showNotification('文件已上传', 'success');
        }
    } catch (error) {
        Logger.error('文件上传错误:', error);
        showNotification(`文件上传失败: ${error.message}`, 'error');
    }
    
    // 清空文件输入，以便可以上传相同的文件
    fileInput.value = '';
}

/**
 * 将ArrayBuffer转换为Base64字符串
 * @param {ArrayBuffer} buffer - 要转换的缓冲区
 * @returns {string} Base64编码的字符串
 */
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

applyConfigButton.addEventListener('click', () => {
    configContainer.classList.remove('active');
    
    // 保存设置到本地存储
    localStorage.setItem('gemini_api_key', apiKeyInput.value);
    localStorage.setItem('gemini_voice', voiceSelect.value);
    localStorage.setItem('system_instruction', systemInstructionInput.value);
    localStorage.setItem('video_fps', fpsInput.value);
    localStorage.setItem('model_name', modelSelect.value);
    
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
 * @param {boolean} [desktop=false] - 是否同时显示桌面通知
 */
function showNotification(message, type = 'info', desktop = false) {
    // 应用内通知
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
    
    // 桌面通知（如果请求并且浏览器支持）
    if (desktop && 'Notification' in window) {
        // 检查是否已获得通知权限
        if (Notification.permission === 'granted') {
            sendDesktopNotification('Gemini 智能助手', message);
        } 
        // 如果未明确授权或拒绝，请求权限
        else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    sendDesktopNotification('Gemini 智能助手', message);
                }
            });
        }
    }
}

/**
 * 发送桌面通知
 * @param {string} title - 通知标题
 * @param {string} body - 通知内容
 */
function sendDesktopNotification(title, body) {
    const notification = new Notification(title, {
        body: body,
        icon: 'favicon.ico'
    });
    
    // 点击通知时聚焦当前窗口
    notification.onclick = function() {
        window.focus();
        this.close();
    };
    
    // 几秒后自动关闭
    setTimeout(() => notification.close(), 5000);
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

    // 格式化并处理消息文本
    const messageText = document.createElement('span');
    messageText.classList.add('message-text');
    
    // 处理代码块
    if (type === 'ai' && message.includes('```')) {
        const formattedMessage = formatMessageWithCodeBlocks(message);
        messageText.innerHTML = formattedMessage;
    } else {
        // 处理普通文本（添加链接、换行等）
        const formattedText = formatSimpleText(message);
        messageText.innerHTML = formattedText;
    }
    
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
 * 格式化包含代码块的消息
 * @param {string} text - 消息文本
 * @returns {string} - 格式化后的HTML
 */
function formatMessageWithCodeBlocks(text) {
    // 分离代码块和普通文本
    const parts = text.split(/```([a-zA-Z]*)\n([\s\S]*?)```/g);
    let formatted = '';
    
    for (let i = 0; i < parts.length; i++) {
        if (i % 3 === 0) {
            // 普通文本
            if (parts[i]) {
                formatted += formatSimpleText(parts[i]);
            }
        } else if (i % 3 === 1) {
            // 语言标识符
            const language = parts[i] || 'plaintext';
            const codeContent = parts[i + 1] || '';
            formatted += `<div class="code-block"><div class="code-header"><span>${language}</span><button class="code-copy-btn">复制</button></div><pre><code class="language-${language}">${escapeHtml(codeContent)}</code></pre></div>`;
            i++; // 跳过已处理的代码内容
        }
    }
    
    // 延迟添加代码高亮
    setTimeout(() => {
        if (window.hljs) {
            document.querySelectorAll('pre code').forEach((block) => {
                window.hljs.highlightElement(block);
            });
        }
        
        // 添加复制代码按钮功能
        document.querySelectorAll('.code-copy-btn').forEach(btn => {
            // 只给新按钮添加事件（避免重复）
            if (!btn.hasListener) {
                btn.addEventListener('click', function() {
                    const codeBlock = this.closest('.code-block').querySelector('code');
                    copyToClipboard(codeBlock.textContent);
                    
                    // 显示复制成功状态
                    const originalText = this.textContent;
                    this.textContent = '已复制!';
                    setTimeout(() => {
                        this.textContent = originalText;
                    }, 2000);
                });
                btn.hasListener = true;
            }
        });
    }, 10);
    
    return formatted;
}

/**
 * 格式化简单文本，处理链接和换行
 * @param {string} text - 文本内容
 * @returns {string} - 格式化后的HTML
 */
function formatSimpleText(text) {
    return text
        // 转义HTML字符
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // 处理链接
        .replace(/https?:\/\/\S+/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
        // 处理换行
        .replace(/\n/g, '<br>');
}

/**
 * 转义HTML特殊字符
 * @param {string} text - 需要转义的文本
 * @returns {string} - 转义后的文本
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/<//g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * 复制文本到剪贴板
 * @param {string} text - 要复制的文本
 */
function copyToClipboard(text) {
    navigator.clipboard.writeText(text)
        .then(() => console.log('文本已复制到剪贴板'))
        .catch(err => console.error('复制失败:', err));
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
        // 更新连接状态
        connectionStatus.textContent = '连接中...';
        connectionStatus.classList.remove('online', 'offline');
        connectionStatus.classList.add('connecting');
        connectButton.textContent = '连接中...';
        connectButton.disabled = true;
        
        // 保存值到localStorage
        localStorage.setItem('gemini_api_key', apiKeyInput.value);
        localStorage.setItem('gemini_voice', voiceSelect.value);
        localStorage.setItem('system_instruction', systemInstructionInput.value);
        localStorage.setItem('model_name', modelSelect.value);

        const config = {
            model: modelSelect.value,
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
        
        // 更新UI状态
        connectionStatus.innerHTML = '<span class="status-dot"></span>已连接';
        connectionStatus.classList.remove('connecting', 'offline');
        connectionStatus.classList.add('online');
        
        connectButton.textContent = '断开连接';
        connectButton.classList.add('connected');
        connectButton.disabled = false;
        messageInput.disabled = false;
        sendButton.disabled = false;
        micButton.disabled = false;
        cameraButton.disabled = false;
        screenButton.disabled = false;
        
        logMessage(`已连接到${modelSelect.options[modelSelect.selectedIndex].text}多模态实时API`, 'system');
        showNotification('连接成功', 'success');
        
        // 自动聚焦输入框
        messageInput.focus();
    } catch (error) {
        const errorMessage = error.message || '未知错误';
        Logger.error('连接错误:', error);
        logMessage(`连接错误: ${errorMessage}`, 'system');
        
        // 恢复UI状态
        connectionStatus.innerHTML = '<span class="status-dot"></span>未连接';
        connectionStatus.classList.remove('connecting', 'online');
        connectionStatus.classList.add('offline');
        
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
    
    // 更新连接状态
    connectionStatus.innerHTML = '<span class="status-dot"></span>未连接';
    connectionStatus.classList.remove('connecting', 'online');
    connectionStatus.classList.add('offline');
    
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

// 实现消息输入框自动调整高度
messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
});

// 事件监听器
client.on('open', () => {
    logMessage('WebSocket连接已打开', 'system');
    
    // 更新连接状态
    connectionStatus.innerHTML = '<span class="status-dot"></span>已连接';
    connectionStatus.classList.remove('connecting', 'offline');
    connectionStatus.classList.add('online');
});

client.on('log', (log) => {
    Logger.debug(`Websocket log: ${log.type}`, log.message);
});

client.on('close', (event) => {
    logMessage(`WebSocket连接已关闭(代码 ${event.code})`, 'system');
    
    // 自动重置连接状态
    if (isConnected) {
        // 更新连接状态
        connectionStatus.innerHTML = '<span class="status-dot"></span>未连接';
        connectionStatus.classList.remove('connecting', 'online');
        connectionStatus.classList.add('offline');
        
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

client.on('content', (data) => {
    if (data.modelTurn) {
        if (data.modelTurn.parts.some(part => part.functionCall)) {
            isUsingTool = true;
            Logger.info('模型正在使用工具');
        } else if (data.modelTurn.parts.some(part => part.functionResponse)) {
            isUsingTool = false;
            Logger.info('工具使用完成');
        }

        const text = data.modelTurn.parts.map(part => part.text).join('');
        if (text) {
            // 检查是否已有一个正在流式输出的消息
            let typingIndicator = document.getElementById('typing-indicator');
            if (typingIndicator) {
                // 如果有，删除它并创建正式消息
                typingIndicator.remove();
            }
            
            // 添加消息到聊天界面
            logMessage(text, 'ai');
        }
    }
});

// 添加正在输入指示器
function showTypingIndicator() {
    // 确保没有重复的指示器
    removeTypingIndicator();
    
    const indicator = document.createElement('div');
    indicator.id = 'typing-indicator';
    indicator.className = 'log-entry ai typing-indicator';
    
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('div');
        dot.className = 'typing-dot';
        indicator.appendChild(dot);
    }
    
    logsContainer.appendChild(indicator);
    
    // 滚动到底部
    logsContainer.scrollTo({
        top: logsContainer.scrollHeight,
        behavior: 'smooth'
    });
    
    return indicator;
}

// 移除正在输入指示器
function removeTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) {
        indicator.remove();
    }
}

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
});

client.on('error', (error) => {
    Logger.error('客户端错误', error);
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
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
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

// 添加通知和工具面板样式
const additionalStyles = document.createElement('style');
additionalStyles.textContent = `
    .notification {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 10px 20px;
        border-radius: var(--border-radius);
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
    
    .chat-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--spacing-sm);
        border-bottom: 1px solid var(--border-color);
        margin-bottom: var(--spacing-sm);
    }
    
    .form-group {
        margin-bottom: var(--spacing-md);
    }
    
    .form-group label {
        display: block;
        margin-bottom: var(--spacing-xs);
        font-size: 0.9rem;
        color: var(--text-secondary);
    }
    
    .tool-input {
        width: 100%;
        padding: var(--spacing-sm);
        border: 1px solid var(--border-color);
        border-radius: var(--border-radius);
        font-family: var(--font-family);
        background-color: var(--surface-color);
        color: var(--text-color);
    }
    
    .tool-input:focus {
        outline: none;
        border-color: var(--primary-color);
    }
`;
document.head.appendChild(additionalStyles);

/**
 * 保存聊天记录到本地存储
 */
function saveChatHistory() {
    const chatLogs = Array.from(logsContainer.children).map(log => {
        const type = log.classList.contains('user') ? 'user' : 
                    log.classList.contains('ai') ? 'ai' : 'system';
                    
        // 获取原始消息文本（不包含时间戳和表情符号）
        let messageEl = log.querySelector('.message-text');
        let message = '';
        
        if (messageEl) {
            // 如果使用了格式化消息，需要特殊处理以获取原始文本
            if (type === 'ai' && messageEl.querySelector('.code-block')) {
                // 有代码块的消息，需要重建原始文本
                const codeBlocks = messageEl.querySelectorAll('.code-block');
                let plainText = messageEl.innerHTML;
                
                // 替换HTML中的代码块为markdown格式
                Array.from(codeBlocks).forEach(block => {
                    const language = block.querySelector('.code-header span')?.textContent || '';
                    const code = block.querySelector('code')?.textContent || '';
                    
                    const markdownBlock = `\`\`\`${language}\n${code}\n\`\`\``;
                    
                    // 创建一个临时元素，保存代码块在DOM中的表示
                    const temp = document.createElement('div');
                    temp.appendChild(block.cloneNode(true));
                    
                    // 用markdown格式替换HTML格式
                    plainText = plainText.replace(temp.innerHTML, markdownBlock);
                });
                
                // 移除HTML标签，恢复为纯文本
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = plainText;
                message = tempDiv.textContent || tempDiv.innerText || '';
                
                // 还原换行符
                message = message.replace(/<br\s*\/?>/gi, '\n');
            } else {
                // 普通消息，直接获取文本内容
                message = log.textContent.replace(/\d{1,2}:\d{1,2}:\d{1,2}⚙️|🫵|🤖/, '').trim();
            }
        } else {
            message = log.textContent.replace(/\d{1,2}:\d{1,2}:\d{1,2}⚙️|🫵|🤖/, '').trim();
        }
        
        return {
            type,
            message,
            timestamp: new Date().toISOString()
        };
    });
    
    // 排除typing-indicator
    const filteredLogs = chatLogs.filter(log => 
        !(log.type === 'ai' && log.message.trim() === '')
    );
    
    localStorage.setItem('gemini_chat_history', JSON.stringify(filteredLogs));
    Logger.debug('已保存聊天历史到本地存储');
}

/**
 * 从本地存储中加载聊天记录
 */
function loadChatHistory() {
    try {
        const savedHistory = localStorage.getItem('gemini_chat_history');
        if (savedHistory) {
            const chatLogs = JSON.parse(savedHistory);
            
            // 清空当前聊天容器
            logsContainer.innerHTML = '';
            
            // 加载历史消息
            chatLogs.forEach(log => {
                logMessage(log.message, log.type);
            });
            
            Logger.info('已加载聊天历史');
            return true;
        }
    } catch (error) {
        Logger.error('加载聊天历史失败:', error);
        showNotification('加载聊天历史失败', 'error');
    }
    return false;
}

/**
 * 监听聊天容器变化，保存聊天历史
 */
const chatObserver = new MutationObserver(debounce(() => {
    // 这里使用之前定义的debounce函数，防止频繁保存
    saveChatHistory();
}, 500));

// 配置观察器
chatObserver.observe(logsContainer, { 
    childList: true, // 观察子节点的添加或删除
    subtree: true,   // 观察所有后代节点
    characterData: true // 观察文本内容变化
});

// 在页面加载后添加欢迎消息
window.addEventListener('load', () => {
    // 尝试加载历史记录
    const historyLoaded = loadChatHistory();
    
    // 只有在没有历史记录时才显示欢迎消息
    if (!historyLoaded) {
        logMessage('欢迎使用 Gemini 智能助手，点击右上角的"连接"按钮开始对话', 'system');
    } else {
        logMessage('已恢复之前的聊天历史', 'system');
    }
});
