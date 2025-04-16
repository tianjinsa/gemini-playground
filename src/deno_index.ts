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
    // 检查请求头，判断请求格式类型
    const hasAuthHeader = req.headers.has("Authorization");
    const hasGoogApiKey = req.headers.has("X-Goog-Api-Key");
    
    logger.info('API request received', { 
      url: req.url, 
      isOpenAIFormat: hasAuthHeader, 
      isGeminiFormat: hasGoogApiKey 
    });

    // 根据规则判断请求类型
    if (hasGoogApiKey) {
      // 规则B: 如果包含X-Goog-Api-Key，则为Gemini格式
      return await handleGeminiAPIRequest(req);
    } else if (hasAuthHeader) {
      // 规则A: 如果包含Authorization，则为OpenAI格式
      const worker = await import('./api_proxy/worker.mjs');
      return await worker.default.fetch(req);
    } else {
      // 异常情况：缺少必要的认证头
      logger.warn('API request missing authentication headers');
      return new Response(JSON.stringify({
        error: "Missing authentication headers. Please provide either 'Authorization' for OpenAI format or 'X-Goog-Api-Key' for Gemini format.",
        status: 401,
        timestamp: new Date().toISOString()
      }), {
        status: 401,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }
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
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      }
    });
  }
}

// 处理原生Gemini API格式的请求
async function handleGeminiAPIRequest(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const apiKey = req.headers.get("X-Goog-Api-Key");
    
    // 构建转发到Google Gemini API的目标URL
    const targetUrl = `https://generativelanguage.googleapis.com${url.pathname}${url.search}`;
    
    logger.info('Forwarding Gemini-format request', { targetUrl });
    
    // 创建新的请求头，保留原始请求的所有头部
    const headers = new Headers(req.headers);
    
    // 创建转发请求
    const forwardRequest = new Request(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body,
      redirect: 'follow'
    });
    
    // 发送请求到Gemini API
    const response = await fetch(forwardRequest);
    
    // 处理响应
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    logger.error('Gemini API request error', { error });
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStatus = (error as { status?: number }).status || 500;
    
    return new Response(JSON.stringify({
      error: errorMessage,
      status: errorStatus,
      timestamp: new Date().toISOString(),
      path: new URL(req.url).pathname
    }), {
      status: errorStatus,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
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

  if (url.pathname.endsWith("/chat/completions") ||
      url.pathname.endsWith("/embeddings") ||
      url.pathname.endsWith("/models")) {
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