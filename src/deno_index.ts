/// <reference types="https://deno.land/x/deno/runtime/mod.ts" />
// @ts-nocheck
// 直接使用 Deno.serve 提供 HTTP 服务

// 限速配置常量
const RATE_LIMIT_MAX_REQUESTS = 10; // 每个时间窗口最大请求数
const RATE_LIMIT_WINDOW_MS = 60000; // 时间窗口（毫秒），60000ms = 1分钟

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
  logger.info('Request received', { url: req.url });

  // WebSocket 处理
  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

  // 限速处理
  const clientIP = getClientIP(req);
  if (!rateLimiter.isAllowed(clientIP)) {
    const retryAfter = Math.ceil(rateLimiter.getRemainingRequests(clientIP) / 20);
    return new Response(JSON.stringify({ error: 'Too Many Requests', status: 429 }), { 
      status: 429,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'Retry-After': retryAfter.toString(),
      }
    });
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

    const fullPath = `${Deno.cwd()}/src/static${filePath}`;

    const file = await Deno.readFile(fullPath);
    const contentType = getContentType(filePath);

    return new Response(file, {
      headers: {
        'content-type': `${contentType};charset=UTF-8`,
      },
    });
  } catch (e) {
    logger.error('Static file request error', { error: e, url: req.url });
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

Deno.serve(handleRequest);