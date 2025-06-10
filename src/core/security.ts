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
export class ScanDetector {
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
export class PathDetector {
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
export class SecurityAuditLogger {
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
