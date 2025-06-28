// 安全模块 - 用于检测和防御可疑访问行为
/**
 * 性能优化说明:
 * 
 * 本安全模块针对Cloudflare Workers的特性进行了优化:
 * 
 * 1. 计算资源优化:
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
 */

// 敏感路径检测器类
export class PathDetector {
  constructor() {
    // 常见敏感文件和目录模式
    this.sensitivePatterns = [
      // 配置文件
      '.env', 'config.json', 'secrets.json', 'credentials',
      // 常见服务器文件
      '.git', '.svn', '.htaccess', 'web.config',
      // 数据库文件
      '.db', '.sqlite', '.sql',
      // 常见网站后台路径
      'admin', 'dashboard', 'wp-admin', 'wp-login', 'login.php',
      // 常见系统文件
      'etc/passwd', 'etc/shadow', 'proc/self',
      // 脚本文件
      '.php', '.jsp', '.aspx', 'shell.php', 'cmd.php',
      // 常见漏洞探测路径
      'phpinfo.php', 'test.php', 'server-status'
    ];
    
    // 缓存常见路径检测结果，减少重复计算
    this.pathCache = new Map();
    
    // 缓存大小限制
    this.maxCacheSize = 1000;
  }
  
  // 检查路径是否敏感
  isSensitive(path) {
    // 标准化路径，移除开头的斜杠，转为小写以便于比较
    const normalizedPath = path.startsWith('/') ? path.substring(1).toLowerCase() : path.toLowerCase();
    
    // 检查缓存
    if (this.pathCache.has(normalizedPath)) {
      return this.pathCache.get(normalizedPath);
    }
    
    // 对路径进行初步快速检查
    const result = this.quickCheck(normalizedPath);
    
    // 缓存结果，如果缓存过大，则清理
    if (this.pathCache.size >= this.maxCacheSize) {
      // 清理缓存的简单实现 - 删除最早加入的10%条目
      const keysToDelete = Array.from(this.pathCache.keys()).slice(0, Math.floor(this.maxCacheSize * 0.1));
      for (const key of keysToDelete) {
        this.pathCache.delete(key);
      }
    }
    
    this.pathCache.set(normalizedPath, result);
    return result;
  }
  
  // 快速检查是否为敏感路径
  quickCheck(normalizedPath) {
    // 检查是否包含敏感模式
    for (const pattern of this.sensitivePatterns) {
      if (normalizedPath.includes(pattern)) {
        return true;
      }
    }
    
    // 针对目录遍历尝试的特定检查
    if (normalizedPath.includes('../') || normalizedPath.includes('..\\')) {
      return true;
    }
    
    // 检查是否有常见命令注入尝试
    const commandInjectionIndicators = [';', '&&', '||', '`', '$(', '${'];
    for (const indicator of commandInjectionIndicators) {
      if (normalizedPath.includes(indicator)) {
        return true;
      }
    }
    
    return false;
  }
}

// 扫描检测器类 - 用于识别扫描攻击模式
export class ScanDetector {
  constructor() {
    // 记录每个IP的访问历史 - 使用更高效的数据结构
    this.requestHistory = new Map();
    // 记录被封禁的IP - 使用Map存储封禁时间，以便自动解除封禁
    this.blockedIPs = new Map();
    // 配置
    this.historyLimit = 10;   // 减少保留的历史记录数量以节省内存
    this.scanThreshold = 3;   // 降低扫描判定阈值，更早检测到攻击
    this.scanTimeWindow = 30000; // 减少到30秒以更快检测攻击模式
    this.blockDuration = 3600000; // 封禁1小时后自动解除，避免长期积累数据
  }
  
  // 记录请求 - 优化以减少CPU使用
  recordRequest(ip, path) {
    // 清理过期的封禁记录，避免数据累积
    this.cleanupBlockedIPs();
    
    const now = Date.now();
    
    // 获取或创建IP记录
    if (!this.requestHistory.has(ip)) {
      this.requestHistory.set(ip, {
        paths: new Set(),
        timestamps: []
      });
    }
    
    const record = this.requestHistory.get(ip);
    
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
  rebuildPathsSet(ip, record, now) {
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
      for (const { path, timestamp } of allPaths) {
        if (now - timestamp <= this.scanTimeWindow) {
          record.paths.add(path);
        }
      }
    }
  }
  
  // 辅助方法：获取IP的所有近期访问路径记录
  getAllPaths(ip) {
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
  isScanningAttack(ip) {
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
  cleanupBlockedIPs() {
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
  limitHistorySize() {
    // 如果记录IP数量超过限制，清理最早的记录
    const maxIPs = 1000; // 最多记录1000个不同的IP
    
    if (this.requestHistory.size > maxIPs) {
      // 找出最不活跃的IP
      let oldestIP = null;
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
  getBlockedIPs() {
    return Array.from(this.blockedIPs.keys());
  }
  
  // 检查IP是否被封禁
  isBlocked(ip) {
    if (!this.blockedIPs.has(ip)) {
      return false;
    }
    
    // 检查封禁是否过期
    const blockTime = this.blockedIPs.get(ip);
    const now = Date.now();
    
    if (now - blockTime > this.blockDuration) {
      // 自动解除过期的封禁
      this.blockedIPs.delete(ip);
      return false;
    }
    
    return true;
  }
}

// 安全审计日志记录器 - 针对Workers优化版本
export class SecurityAuditLogger {
  constructor() {
    // 使用内存中的循环缓冲区存储最近的安全事件
    this.recentAlerts = [];
    this.maxAlerts = 100; // 最多保存100条警报记录
    
    // 简化的安全事件统计
    this.stats = {
      total: 0,
      warn: 0,
      alert: 0,
      block: 0
    };
  }
  
  // 记录安全事件
  log(level, message, data = {}) {
    // 更新统计数据
    this.stats.total++;
    this.stats[level] = (this.stats[level] || 0) + 1;
    
    // 只有警报和封禁才记录详细信息，以节省内存
    if (level === 'alert' || level === 'block') {
      const event = {
        level,
        message,
        data,
        timestamp: new Date().toISOString()
      };
      
      // 使用循环缓冲区存储
      if (this.recentAlerts.length >= this.maxAlerts) {
        this.recentAlerts.shift(); // 移除最旧的记录
      }
      
      this.recentAlerts.push(event);
    }
  }
  
  // 获取最近的安全警报
  getRecentAlerts(count = 10) {
    return this.recentAlerts.slice(-Math.min(count, this.recentAlerts.length));
  }
  
  // 获取安全统计摘要
  getSummary() {
    return {
      ...this.stats,
      alertsRecorded: this.recentAlerts.length
    };
  }
}
