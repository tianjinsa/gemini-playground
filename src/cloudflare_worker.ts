// @ts-nocheck
// Cloudflare Worker 兼容版本

// 限速配置常量
const RATE_LIMIT_MAX_REQUESTS = 10; // 每个时间窗口最大请求数
const RATE_LIMIT_WINDOW_MS = 60000; // 时间窗口（毫秒），60000ms = 1分钟

// 安全模块 - 用于检测和防御可疑访问行为
/**
 * 性能优化说明:
 * 
 * 本安全模块针对Deno免费服务的性能限制进行了以下优化:
 * 
 * 1. CPU限制(50ms/请求)优化:
 *    - 使用简单的字符串比较替代部分正则表达式
 *    - 为常见路径检测添加缓存机制
 *    - 使用高效的数据结构(Set, Map)减少循环遍历
 *    - 通过采样降低日志记录频率
 * 
 * 2. 内存使用优化:
 *    - 限制记录历史的大小
 *    - 定期清理过期数据
 *    - 压缩日志信息，只存储关键数据
 *    - 使用计数器替代完整的日志存储
 * 
 * 3. 安全性能平衡:
 *    - 降低扫描检测阈值，提前识别攻击
 *    - 自动解除过期的IP封禁，避免永久积累数据
 *    - 为静态资源添加缓存头，减少请求频率
 * 
 * 所有这些优化确保了安全功能在严格的资源限制下仍能有效运行。
 */

// 扫描检测器类 - 用于识别扫描攻击模式
class ScanDetector {
  // 记录每个IP的访问历史 - 使用更高效的数据结构
  private requestHistory: Map<string, {paths: Set<string>, timestamps: number[]}> = new Map();
  // 记录被封禁的IP - 使用Map存储封禁时间，以便自动解除封禁
  private blockedIPs: Map<string, number> = new Map();
  // 配置
  private readonly historyLimit: number = 10;   // 减少保留的历史记录数量以节省内存
  private readonly scanThreshold: number = 3;   // 降低扫描判定阈值，更早检测到攻击
  private readonly scanTimeWindow: number = 30000; // 减少到30秒以更快检测攻击模式
  private readonly blockDuration: number = 3600000; // 封禁1小时后自动解除，避免长期积累数据
  
  // 记录请求 - 优化以减少CPU使用
  recordRequest(ip: string, path: string): void {
    // 清理过期的封禁记录，避免数据累积
    this.cleanupBlockedIPs();
    
    const now = Date.now();
    
    // 获取或创建IP记录
    if (!this.requestHistory.has(ip)) {
      this.requestHistory.set(ip, {
        paths: new Set<string>(),
        timestamps: []
      });
    }
    
    const record = this.requestHistory.get(ip)!;
    
    // 添加新路径和时间戳
    record.paths.add(path);
    record.timestamps.push(now);
    
    // 清理旧记录，只保留近期的时间戳
    if (record.timestamps.length > this.historyLimit) {
      record.timestamps.shift();
      
      // 重新计算活跃路径
      this.rebuildPathsSet(ip, record, now);
    }
  }
  
  // 重建路径集合，移除过期路径 - 此操作成本较高，但执行频率低
  private rebuildPathsSet(ip: string, record: {paths: Set<string>, timestamps: number[]}, now: number): void {
    // 如果历史记录为空，清空路径集合并返回
    if (record.timestamps.length === 0) {
      record.paths.clear();
      return;
    }
    
    // 为了减少CPU使用，只有当IP累积了足够多的记录时才进行清理
    if (record.paths.size > this.historyLimit * 2) {
      // 获取该IP的所有近期请求路径
      const allPaths = this.getAllPaths(ip);
      
      // 重置路径集合
      record.paths.clear();
      
      // 只添加时间窗口内的路径
      for (const {path, timestamp} of allPaths) {
        if (now - timestamp <= this.scanTimeWindow) {
          record.paths.add(path);
        }
      }
    }
  }
  
  // 辅助方法：获取IP的所有近期访问路径记录
  private getAllPaths(ip: string): {path: string, timestamp: number}[] {
    // 这个方法通常不会被频繁调用，仅在清理大量数据时使用
    // 临时使用额外的内存来构建完整记录
    const history = this.requestHistory.get(ip);
    if (!history) return [];
    
    // 在真实环境中，这里会从持久化存储中读取数据
    // 在这个实现中我们只能基于内存中的数据模拟
    return Array.from(history.paths).map(path => ({
      path,
      timestamp: history.timestamps[0] // 简化实现，使用最早的时间戳
    }));
  }
  
  // 检测是否为扫描攻击 - 优化以减少CPU使用
  isScanningAttack(ip: string): boolean {
    // 检查IP是否已被封禁
    if (this.isBlocked(ip)) {
      return true;
    }
    
    const record = this.requestHistory.get(ip);
    if (!record) {
      return false;
    }
    
    // 快速检查：如果近期没有足够多的请求，直接返回false
    const now = Date.now();
    const recentTimestamps = record.timestamps.filter(ts => now - ts <= this.scanTimeWindow);
    
    if (recentTimestamps.length < this.scanThreshold) {
      return false;
    }
    
    // 如果短时间内访问了多个不同的敏感路径，判定为扫描行为
    if (record.paths.size >= this.scanThreshold) {
      // 将此IP加入黑名单，并记录封禁时间
      this.blockedIPs.set(ip, now);
      return true;
    }
    
    return false;
  }
  
  // 清理过期的封禁记录
  private cleanupBlockedIPs(): void {
    const now = Date.now();
    
    for (const [ip, blockTime] of this.blockedIPs.entries()) {
      // 如果封禁时间超过指定时长，移除封禁
      if (now - blockTime > this.blockDuration) {
        this.blockedIPs.delete(ip);
      }
    }
    
    // 限制记录的IP数量，防止内存泄漏
    this.limitHistorySize();
  }
  
  // 限制历史记录大小，避免内存占用过大
  private limitHistorySize(): void {
    // 如果记录IP数量超过限制，清理最早的记录
    const maxIPs = 1000; // 最多记录1000个不同的IP
    
    if (this.requestHistory.size > maxIPs) {
      // 找出最不活跃的IP
      let oldestIP: string | null = null;
      let oldestTime = Infinity;
      
      for (const [ip, record] of this.requestHistory.entries()) {
        // 使用最近一次活动时间来判断
        const latestActivity = Math.max(...record.timestamps);
        if (latestActivity < oldestTime) {
          oldestTime = latestActivity;
          oldestIP = ip;
        }
      }
      
      // 删除最不活跃的IP记录
      if (oldestIP) {
        this.requestHistory.delete(oldestIP);
      }
    }
  }
  
  // 获取被封禁的IP列表
  getBlockedIPs(): string[] {
    return Array.from(this.blockedIPs.keys());
  }
  
  // 检查IP是否被封禁
  isBlocked(ip: string): boolean {
    if (!this.blockedIPs.has(ip)) {
      return false;
    }
    
    // 检查封禁是否过期
    const blockTime = this.blockedIPs.get(ip)!;
    const now = Date.now();
    
    if (now - blockTime > this.blockDuration) {
      // 自动解除过期的封禁
      this.blockedIPs.delete(ip);
      return false;
    }
    
    return true;
  }
}

// 敏感路径检测器 - 优化版本
class PathDetector {
  // 敏感文件扩展名和前缀 - 使用直接比较替代部分正则表达式以提高性能
  private sensitiveExtensions: string[] = [
    '.env', '.env.local', '.env.prod', '.env.dev', '.env.test',
    '.sql', '.pem', '.key', '.p12', '.pfx', '.keystore',
    '.bak', '.backup', '.old', '.config', '.conf', '.log', '.ini',
  ];
  
  private sensitivePrefixes: string[] = [
    '.git', 'wp-config', 'config.php', 'config.json'
  ];
  
  // 仍然需要使用正则表达式的模式 - 减少数量以提高性能
  private regexPatterns: RegExp[] = [
    /password|credential|secret/i,        // 包含敏感词的文件
    /\.DS_Store$/i,                       // macOS文件系统元数据
    /phpMyAdmin/i,                        // phpMyAdmin路径
    /admin\/|administrator\//i,           // 管理员路径
    /wp-admin/i,                          // WordPress管理路径
    /node_modules/i,                      // Node.js模块目录
  ];
  
  // 结果缓存 - 用于减少重复计算
  private cache: Map<string, boolean> = new Map();
  private readonly cacheSize: number = 100; // 限制缓存大小
  
  // 检查路径是否敏感 - 优化性能
  isSensitive(path: string): boolean {
    // 检查缓存
    if (this.cache.has(path)) {
      return this.cache.get(path)!;
    }
    
    // 清除旧缓存项以避免内存泄漏
    if (this.cache.size > this.cacheSize) {
      // 简单清理策略：直接清空缓存
      this.cache.clear();
    }
    
    // 检查文件扩展名
    const lowercasePath = path.toLowerCase();
    
    // 检查敏感扩展名
    for (const ext of this.sensitiveExtensions) {
      if (lowercasePath.endsWith(ext)) {
        this.cache.set(path, true);
        return true;
      }
    }
    
    // 检查敏感前缀
    for (const prefix of this.sensitivePrefixes) {
      if (lowercasePath.includes(prefix)) {
        this.cache.set(path, true);
        return true;
      }
    }
    
    // 最后检查正则表达式模式 - 这是最消耗CPU的部分
    const result = this.regexPatterns.some(pattern => pattern.test(path));
    this.cache.set(path, result);
    return result;
  }
}

// 安全审计日志 - 优化版本，减少内存占用和计算成本
class SecurityAuditLogger {
  // 使用更高效的数据结构存储日志统计数据而不是完整日志
  private logStats = {
    // 按小时计数
    hourly: {
      info: 0,
      warn: 0,
      alert: 0,
      block: 0,
      total: 0,
      hour: getCurrentHour()
    },
    // 保存少量最近的重要日志用于查询
    recentAlerts: [] as {level: string, message: string, data: any, timestamp: Date}[],
  };
  
  private readonly maxRecentAlerts: number = 25; // 最多保留的最近告警数量
  
  log(level: 'info' | 'warn' | 'alert' | 'block', message: string, data: any): void {
    // 初始化或重置小时统计
    this.checkAndRotateHourly();
    
    // 更新统计数据
    this.logStats.hourly[level]++;
    this.logStats.hourly.total++;
    
    // 对于重要级别的日志，保存详情
    if (level === 'alert' || level === 'block') {
      // 创建新的日志项
      const newLog = {
        level,
        message,
        // 只保留关键数据字段，减少存储体积
        data: this.sanitizeData(data),
        timestamp: new Date()
      };
      
      // 添加到最近告警列表
      this.logStats.recentAlerts.push(newLog);
      
      // 保持列表大小不超过限制
      if (this.logStats.recentAlerts.length > this.maxRecentAlerts) {
        this.logStats.recentAlerts.shift();
      }
    }
    
    // 输出日志 - 对warn以下级别的日志进行采样以减少控制台输出
    const shouldLog = level === 'alert' || level === 'block' || 
                      level === 'warn' || 
                      (level === 'info' && Math.random() < 0.1); // 只记录10%的info日志
    
    if (shouldLog) {
      this.outputLog(level, message, data);
    }
  }
  
  // 清理数据对象，只保留必要字段
  private sanitizeData(data: any): any {
    if (!data) return null;
    
    // 如果是简单对象，直接返回
    if (typeof data !== 'object') return data;
    
    // 从常见的日志数据中提取关键信息
    const sanitized: Record<string, any> = {};
    
    // 保留常见的重要字段
    const keysToKeep = ['clientIP', 'ip', 'path', 'url', 'status', 'reason'];
    
    for (const key of keysToKeep) {
      if (key in data) {
        sanitized[key] = data[key];
      }
    }
    
    // 如果对象有错误信息，只保留错误名称和消息
    if ('error' in data && data.error) {
      if (typeof data.error === 'object') {
        sanitized.error = {
          name: data.error.name || 'Error',
          message: data.error.message || String(data.error)
        };
      } else {
        sanitized.error = String(data.error);
      }
    }
    
    return sanitized;
  }
  
  // 检查并轮换小时统计
  private checkAndRotateHourly(): void {
    const currentHour = getCurrentHour();
    if (currentHour !== this.logStats.hourly.hour) {
      // 重置小时统计
      this.logStats.hourly = {
        info: 0,
        warn: 0,
        alert: 0,
        block: 0,
        total: 0,
        hour: currentHour
      };
    }
  }
  
  private outputLog(level: string, message: string, data: any): void {
    const timestamp = new Date().toISOString();
    
    // 减少日志中的数据量，避免大对象
    let logData = '';
    if (data) {
      const simplifiedData = this.sanitizeData(data);
      logData = ` ${JSON.stringify(simplifiedData)}`;
    }
    
    // 根据级别选择输出方式
    switch(level) {
      case 'alert':
      case 'block':
        console.error(`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
        break;
      case 'warn':
        console.warn(`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
        break;
      default:
        console.info(`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
    }
  }
  
  // 获取最近的安全警报
  getRecentAlerts(count: number = 10): any[] {
    // 直接返回已经预处理好的最近告警
    return this.logStats.recentAlerts
      .slice(-Math.min(count, this.maxRecentAlerts))
      .reverse();
  }
  
  // 获取安全摘要 - 使用预计算的统计数据，避免重新过滤
  getSummary(): any {
    // 确保统计数据是最新的
    this.checkAndRotateHourly();
    
    return {
      lastHour: {
        total: this.logStats.hourly.total,
        alerts: this.logStats.hourly.alert,
        blocks: this.logStats.hourly.block,
        warnings: this.logStats.hourly.warn
      }
    };
  }
}

// 辅助函数：获取当前小时，用于分组统计
function getCurrentHour(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}-${now.getHours()}`;
}

// 初始化安全组件
const pathDetector = new PathDetector();
const scanDetector = new ScanDetector();
const securityLogger = new SecurityAuditLogger();

// 检查是否为敏感文件路径（使用安全模块）
function isSensitivePath(path: string): boolean {
  return pathDetector.isSensitive(path);
}

// 添加一个结构化日志工具
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const logger = {
  log: (level: LogLevel, message: string, data?: any) => {
    const timestamp = new Date().toISOString();
    const logData = data ? ` ${JSON.stringify(data)}` : '';
    console[level](`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
  },
  debug: (message: string, data?: any) => logger.log('debug', message, data),
  info: (message: string, data?: any) => logger.log('info', message, data),
  warn: (message: string, data?: any) => logger.log('warn', message, data),
  error: (message: string, data?: any) => logger.log('error', message, data),
};

// 添加限速功能
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  
  // 添加可疑IP的黑名单跟踪
  private suspiciousIPs: Map<string, number> = new Map();

  constructor(maxRequests: number = 20, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  isAllowed(clientId: string): boolean {
    const now = Date.now();
    const requests = this.requests.get(clientId) || [];
    
    // 清理过期的请求记录
    const validRequests = requests.filter(time => now - time < this.windowMs);
    
    // 检查是否超过限制
    if (validRequests.length >= this.maxRequests) {
      this.requests.set(clientId, validRequests);
      return false;
    }
    
    // 添加当前请求
    validRequests.push(now);
    this.requests.set(clientId, validRequests);
    return true;
  }

  getRemainingRequests(clientId: string): number {
    const now = Date.now();
    const requests = this.requests.get(clientId) || [];
    const validRequests = requests.filter(time => now - time < this.windowMs);
    return Math.max(0, this.maxRequests - validRequests.length);
  }
  
  // 记录可疑请求，如访问敏感文件
  recordSuspiciousRequest(clientId: string): void {
    const count = (this.suspiciousIPs.get(clientId) || 0) + 1;
    this.suspiciousIPs.set(clientId, count);
    
    // 如果累计3次可疑请求，减少该IP的请求配额
    if (count >= 3) {
      // 减少该IP的剩余请求数，通过添加额外的时间戳记录
      const requests = this.requests.get(clientId) || [];
      // 添加5个额外请求记录，降低该IP的剩余配额
      for (let i = 0; i < 5; i++) {
        requests.push(Date.now());
      }
      this.requests.set(clientId, requests);
      
      // 记录此IP已被进一步限流
      logger.warn('Enhanced rate limiting for suspicious IP', { clientId, suspiciousCount: count });
    }
  }
  
  // 判断IP是否已被标记为可疑
  isSuspicious(clientId: string): boolean {
    return (this.suspiciousIPs.get(clientId) || 0) >= 3;
  }
}

const rateLimiter = new RateLimiter(RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);

const getContentType = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
    'js': 'application/javascript',
    'css': 'text/css',
    'html': 'text/html',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'ico': 'image/x-icon' // Added for favicon
  };
  return types[ext] || 'text/plain';
};

// 嵌入静态文件内容
const INDEX_HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gemini Playground - 多模态API体验工具</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" />
    <link rel="stylesheet" href="css/style.css">
    <link rel="icon" href="favicon.ico" type="image/x-icon">
    <!-- 添加marked.js库用于解析Markdown -->
    <script src="https://cdn.jsdelivr.net/npm/marked@9.1.5/marked.min.js"></script>
    <style>
        #history-container, .history-panel, .history-sidebar {
            display: none !important;
        }
        
        /* 如果主内容区域有根据历史面板调整的布局，需要修正 */
        .main-content-area {
            width: 100% !important;
            margin-left: 0 !important;
        }
    </style>
</head>
<body>
    <div id="app">
        <header class="app-header">
            <div class="logo">
                <span class="logo-emoji">🤖</span>
                <h1>Gemini Playground</h1>
            </div>
            <div class="header-controls">
                <button id="theme-toggle" class="icon-button" title="切换主题" aria-label="切换主题">
                    <span id="theme-icon" class="emoji-icon">🌙</span>
                </button>
                <button id="connect-button" class="connect-button">连接</button>
                <button id="config-toggle" class="icon-button" title="设置" aria-label="设置">
                    <span class="emoji-icon">⚙️</span>
                </button>
            </div>
        </header>
        
        <aside id="config-container" class="hidden-mobile">
            <div class="config-header">
                <h2>设置</h2>
                <button class="close-config emoji-icon" aria-label="关闭设置">❌</button>
            </div>
            <div class="config-wrapper">
                <div class="api-key-container">
                    <label for="api-key">API Key</label>
                    <div class="api-key-input-wrapper">
                        <input type="password" id="api-key" placeholder="请输入Gemini API Key" aria-label="API Key" />
                        <button id="toggle-api-visibility" class="icon-button" title="显示/隐藏API Key" aria-label="显示/隐藏API Key">
                            <span class="emoji-icon">👁️</span>
                        </button>
                    </div>
                    <div class="api-key-help">需要Gemini API Key才能使用此工具</div>
                </div>
                
                <div class="setting-group">
                    <h3>语音设置</h3>
                    <div class="setting-container">
                        <label for="voice-select">声音: </label>
                        <select id="voice-select" aria-label="声音选择">
                            <option value="Puck">Puck (男声)</option>
                            <option value="Charon">Charon (男声)</option>
                            <option value="Fenrir">Fenrir (男声)</option>
                            <option value="Kore">Kore (女声)</option>
                            <option value="Aoede" selected>Aoede (女声)</option>
                        </select>
                    </div>
                    <div class="setting-container">
                        <label for="response-type-select">回复类型: </label>
                        <select id="response-type-select" aria-label="回复类型选择">
                            <option value="text" selected>文本</option>
                            <option value="audio">音频</option>
                        </select>
                    </div>
                </div>
                
                <div class="setting-group">
                    <h3>视频设置</h3>
                    <div class="setting-container">
                        <label for="fps-input">视频帧率 (FPS): </label>
                        <input type="number" id="fps-input" value="1" min="1" max="30" step="1" aria-label="视频帧率 (FPS)" />
                        <span class="fps-help">高帧率需要更多的网络带宽</span>
                    </div>
                </div>
                
                <div class="setting-group">
                    <h3>系统指令</h3>
                    <textarea id="system-instruction" placeholder="输入自定义系统指令..." rows="6" aria-label="系统指令"></textarea>
                </div>
                
                <button id="apply-config" class="primary-button">确认</button>
                <div class="config-footer">
                    <p>提示: 可以使用预设系统指令模板</p>
                    <div class="preset-buttons">
                        <button class="preset-button" data-preset="assistant">助手</button>
                        <button class="preset-button" data-preset="coder">程序员</button>
                        <button class="preset-button" data-preset="creative">创意</button>
                    </div>
                </div>
            </div>
        </aside>
        
        <main class="main-content">
            <div class="chat-container">
                <div class="chat-header">
                    <span id="connection-status" class="status-indicator offline" role="status" aria-live="polite">未连接</span>
                    <div class="chat-tools">
                        <button id="clear-chat" class="text-button" title="清空聊天记录" aria-label="清空聊天记录">
                            <span class="emoji-icon">🗑️</span>
                            清空聊天
                        </button>
                    </div>
                </div>

                <div id="logs-container" aria-live="polite" aria-relevant="additions" role="log"></div>
                
                <div class="input-container">
                    <div class="message-input-wrapper">
                        <textarea id="message-input" placeholder="输入消息..." rows="1" aria-label="消息输入"></textarea>
                        <div class="shortcut-hint">按 Enter 发送，Shift+Enter 换行</div>
                    </div>
                    <div class="action-buttons">
                        <button id="send-button" class="primary-button" aria-label="发送消息">发送</button>
                        <div class="tool-buttons">
                            <button id="mic-button" class="icon-button" title="麦克风" aria-label="麦克风">
                                <span id="mic-icon" class="emoji-icon">🎤</span>
                            </button>
                            <button id="camera-button" class="icon-button" title="摄像头" aria-label="摄像头">
                                <span id="camera-icon" class="emoji-icon">📷</span>
                            </button>
                            <button id="screen-button" class="icon-button" title="屏幕分享" aria-label="屏幕分享">
                                <span id="screen-icon" class="emoji-icon">📺</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            
            <aside class="sidebar">
                <div class="visualizer-panel">
                    <h3>音频可视化</h3>
                    <div class="audio-visualizers">
                        <div class="visualizer-container">
                            <label>输入音频</label>
                            <div id="input-audio-visualizer"></div>
                        </div>
                        <div class="visualizer-container">
                            <label>输出音频</label>
                            <div id="audio-visualizer"></div>
                        </div>
                    </div>
                </div>
            </aside>
        </main>
        
        <div id="video-container" style="display: none;">
            <div class="video-header">
                <span class="video-title">摄像头预览</span>
                <div class="video-controls">
                    <button id="flip-camera" class="icon-button" title="翻转摄像头" aria-label="翻转摄像头">
                        <span class="emoji-icon">🔄</span>
                    </button>
                    <button id="stop-video" class="danger-button" aria-label="停止视频">停止视频</button>
                </div>
            </div>
            <video id="preview" playsinline autoplay muted></video>
        </div>
        
        <div id="screen-container" style="display: none;">
            <div class="screen-header">
                <span class="screen-title">屏幕共享</span>
                <button class="close-button emoji-icon" aria-label="关闭屏幕共享">❌</button>
            </div>
            <video id="screen-preview" playsinline autoplay muted></video>
        </div>
        
        <footer class="app-footer">
            <div class="footer-content">
                <p>Gemini Playground - 多模态API体验工具 &copy; 2025</p>
                <div class="footer-links">
                    <a href="https://ai.google.dev/docs" target="_blank">Gemini API 文档</a>
                    <span class="divider">|</span>
                    <a href="https://github.com/ViaAnthroposBenevolentia/gemini-2-live-api-demo" target="_blank">GitHub</a>
                </div>
            </div>
        </footer>
    </div>

    <!-- 加载提示 -->
    <div id="loading-overlay" role="dialog" aria-modal="true" aria-labelledby="loading-title" aria-describedby="loading-description">
        <div class="loading-content">
            <div class="loading-spinner" aria-hidden="true"></div>
            <h2 id="loading-title" class="visually-hidden">处理中</h2>
            <p id="loading-description">加载中...</p>
        </div>
    </div>

    <!-- 工具使用指示器 -->
    <div id="tool-indicator" class="tool-indicator" role="status" aria-live="polite">
        <div class="tool-indicator-content">
            <div class="tool-icon">🔧</div>
            <div class="tool-info">
                <p class="tool-name">使用工具中...</p>
                <div class="tool-progress-bar">
                    <div class="tool-progress"></div>
                </div>
            </div>
        </div>
    </div>

    <script src="js/main.js" type="module"></script>
</body>
</html>`;

// Cloudflare Worker 入口点
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // 从 env 中获取 SECURITY_ADMIN_TOKEN
    const SECURITY_ADMIN_TOKEN = env.SECURITY_ADMIN_TOKEN || "change-this-in-production";

    // 获取客户端IP
    const clientIP = getClientIP(request);
    
    // 检查IP是否已被识别为攻击者
    if (scanDetector.isBlocked(clientIP)) {
      securityLogger.log('block', 'Blocked request from banned IP', { 
        clientIP, 
        url: request.url
      });
      
      // 对已被封禁的IP返回403，不进行任何处理
      return new Response(JSON.stringify({ error: 'Forbidden', status: 403 }), { 
        status: 403,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
        }
      });
    }
    
    // 记录正常请求
    logger.info('Request received', { url: request.url });

    // WebSocket 处理
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return handleWebSocket(request);
    }

    // 限速处理
    if (!rateLimiter.isAllowed(clientIP)) {
      // 可疑IP的重试时间延长
      const isSuspicious = rateLimiter.isSuspicious(clientIP);
      const retryAfter = isSuspicious ? 
        300 : // 可疑IP等待5分钟 
        Math.ceil(rateLimiter.getRemainingRequests(clientIP) / 20);
      
      // 记录限速情况，对可疑IP进行标记
      logger.warn('Rate limit exceeded', { 
        clientIP, 
        suspicious: isSuspicious,
        retryAfter
      });
      
      return new Response(JSON.stringify({ error: 'Too Many Requests', status: 429 }), { 
        status: 429,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'Retry-After': retryAfter.toString(),
        }
      });
    }
    
    // 检查是否为扫描攻击
    if (scanDetector.isScanningAttack(clientIP)) {
      securityLogger.log('alert', 'Detected scanning attack pattern', { 
        clientIP, 
        url: request.url 
      });
      
      // 对扫描攻击返回403
      return new Response(JSON.stringify({ error: 'Forbidden', status: 403 }), { 
        status: 403,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
        }
      });
    }
    // 安全监控请求处理
    if (url.pathname.startsWith('/admin/security/')) {
      return handleSecurityMonitor(request, SECURITY_ADMIN_TOKEN);
    }
    
    // API 请求处理：匹配 /v1beta/* 或带 Authorization/APiKey 头部的请求
    if (url.pathname.startsWith('/v1beta') || request.headers.get('Authorization') || request.headers.get('X-Goog-Api-Key')) {
      return handleAPIRequest(request);
    }
      // 静态文件处理
    try {
      let filePath = url.pathname;
      if (filePath === '/' || filePath === '/index.html') {
        filePath = '/index.html';
      }
      
      // 检查是否为敏感文件路径 - 快速路径，减少处理时间
      if (isSensitivePath(filePath)) {
        // 记录可疑请求以便检测扫描行为
        scanDetector.recordRequest(clientIP, filePath);
        
        // 限制IP请求，减少繁重的处理逻辑，避免达到CPU限制
        rateLimiter.recordSuspiciousRequest(clientIP);
        
        // 对不同客户端的相同敏感路径请求减少日志记录频率
        if (Math.random() < 0.2) { // 只记录20%的相似请求
          securityLogger.log('warn', 'Blocked sensitive file request', { path: filePath });
        }
        
        // 快速返回，不执行任何额外逻辑
        return new Response('Forbidden', { 
          status: 403,
          headers: {
            'content-type': 'text/plain;charset=UTF-8',
          }
        });
      }
      
      // 处理嵌入的静态文件
      if (filePath === '/index.html') {
        return new Response(INDEX_HTML_CONTENT, {
          headers: {
            'content-type': 'text/html;charset=UTF-8',
            'Cache-Control': 'public, max-age=86400'
          },
        });
      } else if (filePath === '/favicon.ico') {
        // TODO: 对于二进制文件如 favicon.ico，需要将其转换为 Base64 编码或通过 Cloudflare Workers KV/R2 提供
        // 目前返回 404 或一个空的响应
        return new Response('Not Found', { 
          status: 404,
          headers: {
            'content-type': 'text/plain;charset=UTF-8',
          }
        });
      } else if (filePath.startsWith('/css/') || filePath.startsWith('/js/')) {
        // 对于外部引用的 CSS/JS 文件，Cloudflare Worker 无法直接提供，需要确保这些文件通过 CDN 或其他方式可用
        // 这里暂时返回 404，实际部署时需要将这些文件也部署到 Cloudflare Pages 或其他静态资源服务
        return new Response('Not Found', { 
          status: 404,
          headers: {
            'content-type': 'text/plain;charset=UTF-8',
          }
        });
      }
      
      // 对于其他未处理的静态文件，返回 404
      return new Response('Not Found', { 
        status: 404,
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
        }
      });

    } catch (e) {
      // 对于敏感文件路径，使用403 Forbidden而非404，并减少日志详情
      if (isSensitivePath(url.pathname)) {
        // 记录可疑请求，使用相同的处理逻辑但不重复记录日志
        scanDetector.recordRequest(clientIP, url.pathname);
        rateLimiter.recordSuspiciousRequest(clientIP);
        
        return new Response('Forbidden', { 
          status: 403,
          headers: {
            'content-type': 'text/plain;charset=UTF-8',
          }
        });
      }
      
      // 对于普通文件的错误，保持简洁的日志记录
      const errorInfo = e instanceof Error ? e.name : 'Unknown';
      logger.error('Static file not found', { path: url.pathname, errorType: errorInfo });
      
      return new Response('Not Found', { 
        status: 404,
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
        }
      });
    }
  },
};

async function handleWebSocket(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const targetUrl = `wss://generativelanguage.googleapis.com${url.pathname}${url.search}`;
  
  logger.info('WebSocket connection', { targetUrl });
  
  // Cloudflare Worker WebSocket 升级
  const { 0: clientWs, 1: workerWs } = new WebSocketPair();
  const response = new Response(null, { status: 101, webSocket: clientWs });

  const targetWs = new WebSocket(targetUrl);
  
  targetWs.addEventListener('open', () => {
    logger.info('Connected to Gemini WebSocket');
    // 将 workerWs 连接到 targetWs
    workerWs.accept();
  });

  workerWs.addEventListener('message', (event) => {
    logger.debug('Client message received', { size: typeof event.data === 'string' ? event.data.length : '(binary)' });
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(event.data);
    }
  });

  targetWs.addEventListener('message', (event) => {
    logger.debug('Gemini message received', { size: typeof event.data === 'string' ? event.data.length : '(binary)' });
    if (workerWs.readyState === WebSocket.OPEN) {
      workerWs.send(event.data);
    }
  });

  workerWs.addEventListener('close', (event) => {
    logger.info('Client connection closed', { code: event.code, reason: event.reason });
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1000, event.reason);
    }
  });

  targetWs.addEventListener('close', (event) => {
    logger.info('Gemini connection closed', { code: event.code, reason: event.reason });
    if (workerWs.readyState === WebSocket.OPEN) {
      workerWs.close(event.code, event.reason);
    }
  });

  targetWs.addEventListener('error', (error) => {
    logger.error('Gemini WebSocket error', { error });
  });

  return response;
}

// 改进错误处理的API请求函数
async function handleAPIRequest(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname;
    const authHeader = req.headers.get("Authorization");
    const isOpenAI = path.startsWith('/v1beta/openai/') || !!authHeader;
    // 计算 suffix，确保剥离 '/v1beta/openai' 或 '/v1beta' 前缀
    let suffix = path;
    if (path.startsWith('/v1beta/openai')) {
      suffix = path.substring('/v1beta/openai'.length);
    } else if (path.startsWith('/v1beta')) {
      suffix = path.substring('/v1beta'.length);
    }
    const prefix = isOpenAI ? '/v1beta/openai' : '/v1beta';
    const targetPath = prefix + suffix;
    const targetUrl = `https://generativelanguage.googleapis.com${targetPath}${url.search}`;
    logger.info('Proxy API request', { targetUrl });
    const modifiedReq = new Request(targetUrl, {
      method: req.method,
      headers: new Headers(req.headers),
      body: req.body,
      // Cloudflare Worker 不支持以下属性，需要移除
      // cache: req.cache,
      // credentials: req.credentials,
      // integrity: req.integrity,
      // keepalive: req.keepalive,
      // mode: req.mode,
      // redirect: req.redirect,
      // referrer: req.referrer,
      // referrerPolicy: req.referrerPolicy,
      // signal: req.signal,
    });
    return await fetch(modifiedReq);
  } catch (error) {
    logger.error('API request error', { error });
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = (error as any).status || 500;
    return new Response(JSON.stringify({ error: message, status }), { status, headers: { 'content-type': 'application/json;charset=UTF-8' } });
  }
}

// 获取客户端IP地址
function getClientIP(req: Request): string {
  // Cloudflare Worker 通常通过 'CF-Connecting-IP' 头获取真实客户端IP
  const cfConnectingIP = req.headers.get('CF-Connecting-IP');
  if (cfConnectingIP) {
    return cfConnectingIP;
  }
  // 备用：如果不在 Cloudflare 环境，尝试其他常见头
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  const realIP = req.headers.get('x-real-ip');
  if (realIP) {
    return realIP;
  }
  // 如果无法获取真实IP，使用请求的 URL 作为标识符（不推荐用于生产环境）
  return req.url;
}

// 处理安全监控API请求
async function handleSecurityMonitor(req: Request, SECURITY_ADMIN_TOKEN: string): Promise<Response> {
  // 检查授权令牌
  const authHeader = req.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') 
    ? authHeader.substring(7) 
    : null;
  
  if (!token || token !== SECURITY_ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, 
      headers: { 'content-type': 'application/json;charset=UTF-8' }
    });
  }
  
  const url = new URL(req.url);
  const path = url.pathname;
  
  // 处理不同的安全监控端点
  if (path === '/admin/security/summary') {
    // 返回安全摘要信息
    const summary = securityLogger.getSummary();
    return new Response(JSON.stringify({
      summary,
      blockedIPs: scanDetector.getBlockedIPs(),
      timestamp: new Date().toISOString()
    }), { 
      status: 200,
      headers: { 'content-type': 'application/json;charset=UTF-8' }
    });
  }
  
  if (path === '/admin/security/alerts') {
    // 返回最近的安全警报
    const count = parseInt(url.searchParams.get('count') || '10', 10);
    const alerts = securityLogger.getRecentAlerts(count);
    return new Response(JSON.stringify({
      alerts,
      count: alerts.length,
      timestamp: new Date().toISOString()
    }), { 
      status: 200,
      headers: { 'content-type': 'application/json;charset=UTF-8' }
    });
  }
  
  // 默认返回404
  return new Response(JSON.stringify({ error: 'Not Found' }), { 
    status: 404,
    headers: { 'content-type': 'application/json;charset=UTF-8' }
  });
}

// Cloudflare Worker 的 Env 类型定义
interface Env {
  SECURITY_ADMIN_TOKEN: string;
  // 如果有其他环境变量，可以在这里添加
}

// Cloudflare Worker 的 ExecutionContext 类型定义
interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}