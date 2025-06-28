// Cloudflare Worker 入口文件 - 简化版
// 只保留请求代理和基本请求过滤功能

// 限速配置常量
const RATE_LIMIT_MAX_REQUESTS = 10; // 每个时间窗口最大请求数
const RATE_LIMIT_WINDOW_MS = 60000; // 时间窗口（毫秒），60000ms = 1分钟

// 添加一个结构化日志工具
const logger = {
  log: (level, message, data) => {
    const timestamp = new Date().toISOString();
    const logData = data ? ` ${JSON.stringify(data)}` : '';
    console[level](`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
  },
  debug: (message, data) => logger.log('debug', message, data),
  info: (message, data) => logger.log('info', message, data),
  warn: (message, data) => logger.log('warn', message, data),
  error: (message, data) => logger.log('error', message, data),
};

// 添加限速功能
class RateLimiter {
  constructor(maxRequests = 20, windowMs = 60000) {
    this.requests = new Map();
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.suspiciousIPs = new Map();
  }

  isAllowed(clientId) {
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

  getRemainingRequests(clientId) {
    const now = Date.now();
    const requests = this.requests.get(clientId) || [];
    const validRequests = requests.filter(time => now - time < this.windowMs);
    return Math.max(0, this.maxRequests - validRequests.length);
  }
  
  // 记录可疑请求，如访问敏感文件
  recordSuspiciousRequest(clientId) {
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
  isSuspicious(clientId) {
    return (this.suspiciousIPs.get(clientId) || 0) >= 3;
  }
}

const rateLimiter = new RateLimiter(RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);

// 移除了内容类型检测函数

// 改进错误处理的API请求函数
async function handleAPIRequest(req) {
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
      // 移除 Cloudflare Workers 不支持的 RequestInit 属性
      // 只保留标准属性
      cache: req.cache,
      redirect: req.redirect,
      signal: req.signal,
    });
    return await fetch(modifiedReq);
  } catch (error) {
    logger.error('API request error', { error });
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = error.status || 500;
    return new Response(JSON.stringify({ error: message, status }), { status, headers: { 'content-type': 'application/json;charset=UTF-8' } });
  }
}

// 获取客户端IP地址 - Cloudflare Workers 版本
function getClientIP(req) {
  // Cloudflare 自动提供 CF-Connecting-IP 头
  const cfIP = req.headers.get('CF-Connecting-IP');
  if (cfIP) {
    return cfIP;
  }

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

// 移除了安全监控API请求处理函数

// 处理WebSocket请求 - Cloudflare Workers 版本
async function handleWebSocket(req) {
  // Cloudflare Workers WebSocket 处理
  try {
    const url = new URL(req.url);
    const targetUrl = `wss://generativelanguage.googleapis.com${url.pathname}${url.search}`;
    logger.info('WebSocket connection', { targetUrl });
    
    // 创建一个 WebSocket 对的工具函数
    const pair = new WebSocketPair();
    const [clientToServerReadable, clientToServerWritable] = Object.values(pair);

    // 在 Worker 中处理 WebSocket
    const clientToServerWebSocket = new WebSocket(targetUrl);
    clientToServerWebSocket.addEventListener("open", (event) => {
      logger.info('Connected to Gemini WebSocket');
    });

    clientToServerWebSocket.addEventListener("message", (event) => {
      logger.debug('Gemini message received', { size: typeof event.data === 'string' ? event.data.length : '(binary)' });
      clientToServerReadable.send(event.data);
    });

    clientToServerWebSocket.addEventListener("close", (event) => {
      logger.info('Gemini connection closed', { code: event.code, reason: event.reason });
      clientToServerReadable.close();
    });

    clientToServerWebSocket.addEventListener("error", (error) => {
      logger.error('Gemini WebSocket error');
      clientToServerReadable.close();
    });
    
    // 处理来自客户端的消息
    clientToServerWritable.accept();
    clientToServerWritable.addEventListener("message", (event) => {
      logger.debug('Client message received', { size: typeof event.data === 'string' ? event.data.length : '(binary)' });
      if (clientToServerWebSocket.readyState === WebSocket.OPEN) {
        clientToServerWebSocket.send(event.data);
      }
    });

    clientToServerWritable.addEventListener("close", (event) => {
      logger.info('Client connection closed');
      if (clientToServerWebSocket.readyState === WebSocket.OPEN) {
        clientToServerWebSocket.close(1000);
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: pair[1] // 使用 pair[1] 而非 clientToServerWritable
    });
  } catch (error) {
    logger.error('WebSocket error', { error });
    return new Response('WebSocket connection failed', { status: 500 });
  }
}

// Cloudflare Worker 主处理函数 - 简化版
async function handleRequest(req, env, ctx) {
  const url = new URL(req.url);
  
  // 获取客户端IP
  const clientIP = getClientIP(req);
  
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
  
  // API 请求处理：匹配所有请求
  return handleAPIRequest(req);
}

// Cloudflare Worker 导出
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
