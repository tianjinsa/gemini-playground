/// <reference types="https://deno.land/x/deno/runtime/mod.ts" />
// @ts-nocheck
// 直接使用 Deno.serve 提供 HTTP 服务

// 限速配置常量
const RATE_LIMIT_MAX_REQUESTS = 10; // 每个时间窗口最大请求数
const RATE_LIMIT_WINDOW_MS = 60000; // 时间窗口（毫秒），60000ms = 1分钟

// 安全监控配置
const SECURITY_ADMIN_TOKEN = Deno.env.get("SECURITY_ADMIN_TOKEN") || "change-this-in-production"; // 管理员访问令牌

// 引入安全模块 - 优化版本适配Deno免费服务性能限制
/**
 * Deno免费服务限制:
 * - 每请求CPU时间: 50ms
 * - 每月请求: 100万次
 * - 存储: 1GiB
 * 
 * 针对这些限制，安全模块采用了高效的算法和数据压缩策略:
 * 1. 优化的路径检测
 * 2. 采样日志记录
 * 3. 自动过期的数据清理
 */
import { PathDetector, ScanDetector, SecurityAuditLogger } from "./core/security.ts";

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
    'gif': 'image/gif'
  };
  return types[ext] || 'text/plain';
};

async function handleWebSocket(req: Request): Promise<Response> {
  const { socket: clientWs, response } = Deno.upgradeWebSocket(req);
  
  const url = new URL(req.url);
  const targetUrl = `wss://generativelanguage.googleapis.com${url.pathname}${url.search}`;
  
  logger.info('WebSocket connection', { targetUrl });
  
  const pendingMessages: string[] = [];
  const targetWs = new WebSocket(targetUrl);
  
  targetWs.onopen = () => {
    logger.info('Connected to Gemini WebSocket');
    pendingMessages.forEach(msg => targetWs.send(msg));
    pendingMessages.length = 0;
  };

  clientWs.onmessage = (event) => {
    logger.debug('Client message received', { size: typeof event.data === 'string' ? event.data.length : '(binary)' });
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(event.data);
    } else {
      pendingMessages.push(event.data);
    }
  };

  targetWs.onmessage = (event) => {
    logger.debug('Gemini message received', { size: typeof event.data === 'string' ? event.data.length : '(binary)' });
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(event.data);
    }
  };

  clientWs.onclose = (event) => {
    logger.info('Client connection closed', { code: event.code, reason: event.reason });
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1000, event.reason);
    }
  };

  targetWs.onclose = (event) => {
    logger.info('Gemini connection closed', { code: event.code, reason: event.reason });
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(event.code, event.reason);
    }
  };

  targetWs.onerror = (error) => {
    logger.error('Gemini WebSocket error', { error });
  };

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
      cache: req.cache,
      credentials: req.credentials,
      integrity: req.integrity,
      keepalive: req.keepalive,
      mode: req.mode,
      redirect: req.redirect,
      referrer: req.referrer,
      referrerPolicy: req.referrerPolicy,
      signal: req.signal,
    });
    return await fetch(modifiedReq);
  } catch (error) {
    logger.error('API request error', { error });
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = (error as any).status || 500;
    return new Response(JSON.stringify({ error: message, status }), { status, headers: { 'content-type': 'application/json;charset=UTF-8' } });
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  // 获取客户端IP
  const clientIP = getClientIP(req);
  
  // 检查IP是否已被识别为攻击者
  if (scanDetector.isBlocked(clientIP)) {
    securityLogger.log('block', 'Blocked request from banned IP', { 
      clientIP, 
      url: req.url
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
  logger.info('Request received', { url: req.url });

  // WebSocket 处理
  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocket(req);
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
      url: req.url 
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
    return handleSecurityMonitor(req);
  }
  
  // API 请求处理：匹配 /v1beta/* 或带 Authorization/APiKey 头部的请求
  if (url.pathname.startsWith('/v1beta') || req.headers.get('Authorization') || req.headers.get('X-Goog-Api-Key')) {
    return handleAPIRequest(req);
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
    
    // 常见的静态文件路径检查 - 减少文件系统查询次数
    const commonStatic = ['index.html', 'favicon.ico', 'css/style.css', 'js/main.js'];
    const isCommonFile = commonStatic.some(file => filePath === `/${file}`);
    
    const fullPath = `${Deno.cwd()}/src/static${filePath}`;
    const file = await Deno.readFile(fullPath);
    const contentType = getContentType(filePath);

    return new Response(file, {
      headers: {
        'content-type': `${contentType};charset=UTF-8`,
        // 为静态资源添加Cache-Control头，减少请求次数
        'Cache-Control': isCommonFile ? 'public, max-age=86400' : 'public, max-age=3600'
      },
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
}

// 获取客户端IP地址
function getClientIP(req: Request): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  const realIP = req.headers.get('x-real-ip');
  if (realIP) {
    return realIP;
  }
  // 如果无法获取真实IP，使用URL作为标识符
  return req.url;
}

// 安全监控端点
async function handleSecurityRequest(req: Request): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${SECURITY_ADMIN_TOKEN}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized', status: 401 }), { 
      status: 401,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
      }
    });
  }
  
  // 返回当前的可疑IP列表及其请求计数
  const suspiciousIPs = Array.from(rateLimiter['suspiciousIPs'].entries())
    .map(([ip, count]) => ({ ip, count }));
  
  return new Response(JSON.stringify({ suspiciousIPs }), { 
    status: 200,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
    }
  });
}

// 处理安全监控API请求
async function handleSecurityMonitor(req: Request): Promise<Response> {
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

Deno.serve(handleRequest);