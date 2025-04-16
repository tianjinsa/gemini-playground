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
    // 判断API格式类型
    const url = new URL(req.url);
    const isGeminiFormat = url.pathname.startsWith('/v1beta') || 
                           url.pathname.startsWith('/v1') || 
                           url.pathname.includes('generativelanguage');

    // 将请求转发到worker处理
    const worker = await import('./api_proxy/worker.mjs');
    
    // 添加API格式标记，传递给worker
    const apiFormatHeader = new Headers(req.headers);
    apiFormatHeader.set('X-API-Format', isGeminiFormat ? 'gemini' : 'openai');
    
    // 创建新的请求对象，保持原始请求的其他部分不变
    const modifiedReq = new Request(req.url, {
      method: req.method,
      headers: apiFormatHeader,
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

    return await worker.default.fetch(modifiedReq);
  } catch (error) {
    logger.error('API request error', { error, url: req.url });
    
    // 增强的错误信息
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStack = error instanceof Error ? error.stack : undefined;
    const errorStatus = (error as { status?: number }).status || 500;
    
    return new Response(JSON.stringify({
      error: errorMessage,
      status: errorStatus,
      timestamp: new Date().toISOString(),
      path: new URL(req.url).pathname,
      stack: process.env.NODE_ENV !== 'production' ? errorStack : undefined
    }), {
      status: errorStatus,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
      }
    });
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  logger.info('Request received', { url: req.url });

  // WebSocket 处理
  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

  // API 请求处理
  // 支持 OpenAI 格式的路径
  if (url.pathname.endsWith("/chat/completions") ||
      url.pathname.endsWith("/embeddings") ||
      url.pathname.endsWith("/models")) {
    return handleAPIRequest(req);
  }
  
  // 支持 Google 格式的路径
  if (url.pathname.startsWith("/v1beta") || url.pathname.startsWith("/v1")) {
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

Deno.serve(handleRequest);