//Author: PublicAffairs
//Project: https://github.com/PublicAffairs/openai-gemini
//MIT License : https://github.com/PublicAffairs/openai-gemini/blob/main/LICENSE

import { Buffer } from "node:buffer";

// 简单的内存缓存实现
class MemoryCache {
  constructor(ttl = 300000) { // 默认5分钟过期
    this.cache = new Map();
    this.ttl = ttl;
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }
    
    return item.value;
  }

  set(key, value, customTtl) {
    const expiry = Date.now() + (customTtl || this.ttl);
    this.cache.set(key, { value, expiry });
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }
}

// 请求限流机制
class RateLimiter {
  constructor(maxRequests = 60, timeWindow = 60000) { // 默认每分钟60个请求
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
    this.requests = new Map(); // key: IP, value: array of timestamps
  }

  // 检查IP是否超过限制
  isRateLimited(ip) {
    const now = Date.now();
    const timestamps = this.requests.get(ip) || [];
    
    // 清理过期的请求记录
    const validTimestamps = timestamps.filter(time => now - time < this.timeWindow);
    
    // 更新请求记录
    this.requests.set(ip, [...validTimestamps, now]);
    
    return validTimestamps.length >= this.maxRequests;
  }
  
  // 获取剩余可用请求数量
  getRemainingRequests(ip) {
    const now = Date.now();
    const timestamps = this.requests.get(ip) || [];
    const validTimestamps = timestamps.filter(time => now - time < this.timeWindow);
    return Math.max(0, this.maxRequests - validTimestamps.length);
  }
}

// 初始化缓存实例
const modelsCache = new MemoryCache(1800000); // 模型列表缓存30分钟
const embeddingsCache = new MemoryCache(300000); // 嵌入缓存5分钟

// 创建限流器实例
const chatCompletionLimiter = new RateLimiter(60, 60000); // 聊天补全每分钟60个请求
const embeddingsLimiter = new RateLimiter(100, 60000); // 嵌入每分钟100个请求

// 添加 API 配置和常量
const CONFIG = {
  BASE_URL: "https://generativelanguage.googleapis.com",
  API_VERSION: "v1beta",
  DEFAULT_MODEL: "gemini-1.5-pro-latest",
  DEFAULT_EMBEDDINGS_MODEL: "text-embedding-004",
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000, // 毫秒
};

export default {
  async fetch (request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }

    // 改进的错误处理
    const errHandler = (err) => {
      console.error(`Error: ${err.message || 'Unknown error'}`, err.stack || '');
      // Ensure HttpError status is used, default to 500 otherwise
      const status = (err instanceof HttpError && err.status) ? err.status : 500;
      const body = JSON.stringify({
        error: {
          message: err.message || 'Internal Server Error',
          type: err.name || 'Error',
          status
        }
      }, null, 2);

      // Use fixCors to ensure headers are correctly set
      return new Response(body, fixCors({
        status,
        headers: { 'Content-Type': 'application/json' }
      }));
    };

    try {
      // 从不同的头部获取API密钥
      const authHeader = request.headers.get("Authorization");
      const googleApiKeyHeader = request.headers.get("X-Goog-Api-Key");

      // 优先使用X-Goog-Api-Key头部的API密钥，如果没有则从Authorization头部提取
      let apiKey;
      if (googleApiKeyHeader) {
        apiKey = googleApiKeyHeader;
      } else if (authHeader) {
        apiKey = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : authHeader;
      }

      // 验证 API Key
      if (!apiKey) {
        throw new HttpError("API key is required", 401);
      }

      // 获取客户端 IP (假设通过 CF-Connecting-IP 或 X-Forwarded-For 头部)
      const clientIP = request.headers.get("CF-Connecting-IP") ||
                       request.headers.get("X-Forwarded-For")?.split(",")[0] ||
                       "unknown";

      const { pathname } = new URL(request.url);
      const method = request.method;
      const apiFormat = request.headers.get("X-API-Format") || "openai";
      const isGeminiFormat = apiFormat === "gemini";

      // --- Centralized Validation and Rate Limiting ---
      let parsedBody;
      let bodyBuffer; // Store buffer for potential forwarding

      // Read and parse body for POST/PUT requests for validation/forwarding
      if (method === "POST" || method === "PUT") {
          try {
              // Only read body if there's content expected
              const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
              if (contentLength > 0 || request.headers.get('transfer-encoding')?.includes('chunked')) {
                  bodyBuffer = await request.arrayBuffer();
                  const contentType = request.headers.get('content-type');
                  if (contentType && contentType.includes('application/json') && bodyBuffer.byteLength > 0) {
                      const bodyText = new TextDecoder().decode(bodyBuffer);
                      parsedBody = JSON.parse(bodyText);
                  }
              } else {
                  // Handle cases like POST with empty body if necessary, otherwise assume no body
                  bodyBuffer = new ArrayBuffer(0); // Empty buffer
              }
          } catch (e) {
              // Handle JSON parsing error or body reading error
              console.error("Failed to read or parse request body:", e);
              throw new HttpError("Invalid request body: " + e.message, 400);
          }
      }

      // Rate Limiting
      if (!isGeminiFormat) { // OpenAI format
        switch (true) {
          case pathname.endsWith("/chat/completions"):
            if (chatCompletionLimiter.isRateLimited(clientIP)) {
              throw new HttpError("Rate limit exceeded for chat completions", 429);
            }
            break;
          case pathname.endsWith("/embeddings"):
            if (embeddingsLimiter.isRateLimited(clientIP)) {
              throw new HttpError("Rate limit exceeded for embeddings", 429);
            }
            break;
        }
      } else { // Gemini format
        if (pathname.includes("generateContent") || pathname.includes("streamGenerateContent")) {
          if (chatCompletionLimiter.isRateLimited(clientIP)) {
            throw new HttpError("Rate limit exceeded for generate content", 429);
          }
        } else if (pathname.includes("embedContent") || pathname.includes("batchEmbedContents")) { // Added batch
          if (embeddingsLimiter.isRateLimited(clientIP)) {
            throw new HttpError("Rate limit exceeded for embed content", 429);
          }
        }
      }

      // Content Validation (Applied based on format and path if body was parsed)
      // Only validate if we successfully parsed a JSON body
      if (parsedBody) {
          if (!isGeminiFormat) { // OpenAI format validation
              if (pathname.endsWith("/chat/completions")) {
                  validateOpenAIContentSafety(parsedBody); // Use renamed function
              } else if (pathname.endsWith("/embeddings")) {
                  validateOpenAIEmbeddingsInput(parsedBody); // Use new function
              }
          } else { // Gemini format validation
              if (pathname.includes("generateContent") || pathname.includes("streamGenerateContent")) {
                  validateGeminiContentSafety(parsedBody); // Use new function
              } else if (pathname.includes("embedContent") || pathname.includes("batchEmbedContents")) {
                  validateGeminiEmbeddingsInput(parsedBody); // Use new function
              }
          }
      } else if (method === "POST" && !parsedBody && (pathname.endsWith("/chat/completions") || pathname.endsWith("/embeddings") || pathname.includes("generateContent") || pathname.includes("embedContent"))) {
          // If it's a POST request to an endpoint expecting a JSON body, but parsing failed or body was empty/non-JSON
          const contentType = request.headers.get('content-type');
          if (!contentType || !contentType.includes('application/json')) {
               // Allow non-JSON POSTs if applicable, otherwise throw error
               // throw new HttpError("Invalid Content-Type, expected application/json", 415);
          } else {
               // Body was likely empty JSON or malformed
               throw new HttpError("Request body is missing or malformed", 400);
          }
      }
      // --- End Centralized Validation ---


      const assert = (success, message = "Method not allowed", status = 405) => {
        if (!success) {
          throw new HttpError(message, status);
        }
      };

      // 根据API格式处理请求
      if (isGeminiFormat) {
        if (pathname.endsWith("/models") && method === "GET") {
          // Google 原生格式直接转发并返回原始模型列表
          // Pass original request object as handleGoogleModels doesn't need the parsed body
          return await withRetry(() => handleGoogleModels(request, apiKey))
            .catch(errHandler);
        }
        // 处理其他Gemini格式的API请求
        // Pass original request and the pre-read body buffer
        // Note: handleGeminiRequest needs the original request for headers/method, and bodyBuffer for forwarding
        return await handleGeminiRequest(request, pathname, apiKey, bodyBuffer, errHandler);
      } else {
        // 处理OpenAI格式的API请求
        switch (true) {
          case pathname.endsWith("/chat/completions"):
            assert(method === "POST");
            // Pass the pre-parsed body, ensure it exists
            if (!parsedBody) throw new HttpError("Request body required for chat completions", 400);
            return await withRetry(() => handleCompletions(parsedBody, apiKey))
              .catch(errHandler);

          case pathname.endsWith("/embeddings"):
            assert(method === "POST");
            // Pass the pre-parsed body, ensure it exists
            if (!parsedBody) throw new HttpError("Request body required for embeddings", 400);
            return await withRetry(() => handleEmbeddings(parsedBody, apiKey))
              .catch(errHandler);

          case pathname.endsWith("/models"):
            assert(method === "GET");
            return await withRetry(() => handleModels(apiKey))
              .catch(errHandler);

          default:
            throw new HttpError("404 Not Found", 404);
        }
      }
    } catch (err) {
      // Catch all errors and pass to errHandler
      return errHandler(err); // errHandler now correctly handles HttpError status
    }
  }
};

// 处理Gemini原生格式的API请求
// Added bodyBuffer parameter
async function handleGeminiRequest(request, pathname, apiKey, bodyBuffer, errHandler) {
  try {
    const url = new URL(request.url);
    // Construct target URL carefully, ensuring pathname starts with /
    const targetPath = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
    const targetUrl = `${CONFIG.BASE_URL}${targetPath}${url.search}`;

    const headers = new Headers();
    for (const [key, value] of request.headers.entries()) {
      // Forward most headers, excluding sensitive/hop-by-hop/proxy-specific ones
      const lowerKey = key.toLowerCase();
      if (!['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
            'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
            'x-api-format', 'authorization', 'content-length', // Let fetch set content-length
            'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-proto', // Avoid forwarding client IP info directly unless intended
           ].includes(lowerKey)) {
        headers.set(key, value);
      }
    }
    headers.set('x-goog-api-key', apiKey);
    headers.set('x-goog-api-client', API_CLIENT);
    // Preserve original Content-Type if body exists
    if (bodyBuffer && bodyBuffer.byteLength > 0 && request.headers.has('content-type')) {
        headers.set('content-type', request.headers.get('content-type'));
    }


    console.log(`Forwarding Gemini request to: ${targetUrl}`);

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      // Use the pre-read buffer if method allows body
      body: (request.method !== 'GET' && request.method !== 'HEAD') ? bodyBuffer : undefined,
      // Consider adding redirect: 'manual' or 'error' if needed
    });

    // Check if the fetch itself failed (e.g., network error, DNS error)
    // Note: fetch only throws for network errors, not HTTP errors like 4xx/5xx
    if (!response) {
        throw new HttpError('Failed to fetch upstream Gemini API', 502); // Bad Gateway
    }

    const responseBody = await response.arrayBuffer();
    const responseHeaders = new Headers();
    for (const [key, value] of response.headers.entries()) {
      // Filter hop-by-hop headers from the upstream response
       if (!['connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade'].includes(key.toLowerCase())) {
           responseHeaders.set(key, value);
       }
    }

    // Add CORS headers using fixCors utility for consistency
    const finalHeaders = fixCors({ headers: responseHeaders }).headers; // Get headers modified by fixCors

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: finalHeaders, // Use CORS-fixed headers
    });
  } catch (err) {
     // Ensure HttpError instances are passed correctly
     if (err instanceof HttpError) {
        return errHandler(err);
     }
     // Log unexpected errors during forwarding
     console.error("Error in handleGeminiRequest:", err);
     // Pass a generic error to the handler
     return errHandler(new HttpError('Failed to forward Gemini request', 502)); // Use 502 Bad Gateway
  }
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

// 添加重试逻辑
async function withRetry(fn, attempts = CONFIG.RETRY_ATTEMPTS) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      // Ensure we capture the original error correctly
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`Request failed (attempt ${i + 1}/${attempts}): ${lastError.message}`);

      // Check if it's an HttpError and its status code
      const status = (lastError instanceof HttpError && lastError.status) ? lastError.status : null;

      // Only retry network errors or specific server errors (e.g., 500, 502, 503, 504)
      // Do not retry client errors (4xx) except for 429 (Rate Limit)
      let shouldRetry = !status || status >= 500 || status === 429;

      if (!shouldRetry) {
        throw lastError; // Don't retry this error
      }

      if (i < attempts - 1) {
        // Exponential backoff
        const delay = CONFIG.RETRY_DELAY * Math.pow(2, i);
        // Add jitter (e.g., +/- 10%)
        const jitter = delay * 0.2 * (Math.random() - 0.5);
        await new Promise(resolve => setTimeout(resolve, delay + jitter));
      }
    }
  }
  // Throw the last captured error after all attempts fail
  throw lastError;
}


const fixCors = ({ headers, status, statusText }) => {
  // Ensure headers is a Headers object
  headers = headers instanceof Headers ? headers : new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE"); // Allow more methods if needed
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Goog-Api-Key, X-API-Format"); // Include custom headers
  headers.set("Access-Control-Max-Age", "86400"); // 24 hours
  return { headers, status, statusText };
};

const handleOPTIONS = async () => {
  // Use fixCors for consistency
  const corsOptions = fixCors({ headers: {} });
  return new Response(null, {
    headers: corsOptions.headers,
    status: 204 // No Content
  });
};

const BASE_URL = CONFIG.BASE_URL;
const API_VERSION = CONFIG.API_VERSION;

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  "Content-Type": "application/json", // Usually needed for Google API POST requests
  ...more
});

// 添加性能监控
const measurePerformance = async (name, fn) => {
  const startTime = performance.now();
  try {
    return await fn();
  } finally {
    const duration = performance.now() - startTime;
    console.info(`Performance: ${name} took ${duration.toFixed(2)}ms`);
  }
};

async function handleModels (apiKey) {
  return await measurePerformance('handleModels', async () => {
    const cacheKey = 'models';
    const cachedResponse = modelsCache.get(cacheKey);
    if (cachedResponse) {
      console.info("Serving models list from cache (OpenAI format)");
      return new Response(cachedResponse, fixCors({
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    }
    console.info("Fetching models list from Google API (for OpenAI format)");
    const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
      headers: makeHeaders(apiKey), // makeHeaders adds Content-Type, might not be needed for GET
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new HttpError(`Models API error: ${response.status} ${errorText}`, response.status);
    }

    // Read response text once
    const responseText = await response.text();
    const { models } = JSON.parse(responseText); // Parse the text

    // Transform to OpenAI format
    const body = JSON.stringify({
      object: "list",
      data: models
        .filter(m => m.supportedGenerationMethods?.includes("generateContent")) // Filter for generative models if needed
        .map(({ name, displayName, description, version }) => ({
          id: name.replace("models/", ""),
          object: "model",
          created: Date.now(), // Placeholder timestamp
          owned_by: "google",
          // Add more details if available and useful
          // description: description,
          // version: version,
          // display_name: displayName,
      })),
    }, null, "  ");

    modelsCache.set(cacheKey, body); // Cache the transformed response

    return new Response(body, fixCors({
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  });
}

// handleGoogleModels remains the same (fetches raw for Gemini format)
async function handleGoogleModels(request, apiKey) {
  // Directly call Google Generative Language API's models list endpoint
  const url = `${BASE_URL}/${API_VERSION}/models`;
  console.info("Fetching models list from Google API (Gemini format)");
  const response = await fetch(url, {
    method: 'GET',
    // Use makeHeaders but remove Content-Type as it's GET
    headers: makeHeaders(apiKey, { 'Content-Type': undefined })
  });

  if (!response.ok) {
      const errorText = await response.text();
      throw new HttpError(`Google Models API error: ${response.status} ${errorText}`, response.status);
  }

  // Read the original response text
  const body = await response.text();
  // Return the original JSON, with CORS
  return new Response(body, fixCors({
    status: response.status,
    headers: { 'Content-Type': 'application/json' } // Assume Google returns JSON
  }));
}


// handleEmbeddings needs to accept parsedBody (req)
async function handleEmbeddings (req, apiKey) {
  // Validation moved outside, req is already parsed JSON
  const cacheKey = JSON.stringify(req); // Use parsed body for cache key
  const cachedResponse = embeddingsCache.get(cacheKey);
  if (cachedResponse) {
    console.info("Serving embeddings from cache (OpenAI format)");
    return new Response(cachedResponse, fixCors({
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }
  console.info("Requesting embeddings from Google API (via OpenAI format)");

  // Model determination logic remains
  let model;
  const requestedModel = req.model || DEFAULT_EMBEDDINGS_MODEL; // Use default if not provided
  if (requestedModel.startsWith("models/")) {
    model = requestedModel;
  } else {
    model = "models/" + requestedModel;
  }

  // Ensure input is an array
  const inputs = Array.isArray(req.input) ? req.input : [req.input];

  // Construct Google API request body
  const googleRequestBody = {
    "requests": inputs.map(text => ({
      model,
      content: { parts: [{ text }] }, // Assuming simple text input for OpenAI compatibility
      // Pass dimensions if provided in the OpenAI request
      ...(req.dimensions && { outputDimensionality: req.dimensions }),
      // Add task_type if needed, e.g., "RETRIEVAL_DOCUMENT" or "SEMANTIC_SIMILARITY"
      // taskType: req.task_type || "RETRIEVAL_DOCUMENT" // Example
    }))
  };

  const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKey), // makeHeaders adds Content-Type: application/json
    body: JSON.stringify(googleRequestBody)
  });

  let body;
  if (response.ok) {
    const responseText = await response.text();
    const { embeddings } = JSON.parse(responseText);
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: requestedModel, // Return the model name requested by the client
      // Add usage if available from Google API response (check API docs)
      // usage: { prompt_tokens: ..., total_tokens: ... }
    }, null, "  ");
    embeddingsCache.set(cacheKey, body); // Cache the successful response
  } else {
      // Handle API errors
      const errorText = await response.text();
      console.error(`Embeddings API error: ${response.status}`, errorText);
      // Don't cache errors
      // Return the error response from Google, but with CORS headers
      return new Response(errorText, fixCors(response));
      // Or throw an HttpError
      // throw new HttpError(`Embeddings API error: ${response.status} ${errorText}`, response.status);
  }
  return new Response(body, fixCors(response));
}


// handleCompletions needs to accept parsedBody (req)
async function handleCompletions (req, apiKey) {
  // Validation moved outside, req is already parsed JSON
  console.info("Requesting chat completion from Google API (via OpenAI format)");

  let model = DEFAULT_MODEL;
  // Model selection logic
  if (typeof req.model === "string") {
      if (req.model.startsWith("models/")) {
          model = req.model.substring(7);
      } else if (req.model.startsWith("gemini-") || req.model.startsWith("learnlm-")) {
          model = req.model;
      }
      // Add handling for other known model prefixes if necessary
  }


  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }

  let googleRequestBody;
  try {
      googleRequestBody = await transformRequest(req); // Transform OpenAI format to Google format
  } catch (transformError) {
      console.error("Error transforming request:", transformError);
      throw new HttpError(`Failed to transform request: ${transformError.message}`, 400);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey), // makeHeaders adds Content-Type: application/json
    body: JSON.stringify(googleRequestBody),
  });

  let body = response.body; // Default to streaming body
  const responseHeaders = fixCors(response).headers; // Get CORS headers

  if (response.ok) {
    let id = generateChatcmplId();
    if (req.stream) {
      // Set content type for SSE
      responseHeaders.set('Content-Type', 'text/event-stream');
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "", // Initialize buffer state here
        }))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          // Pass necessary state for transformation
          streamIncludeUsage: req.stream_options?.include_usage,
          model: req.model || model, // Use requested model name if available
          id,
          last: [], // Initialize last state here
        }))
        .pipeThrough(new TextEncoderStream());
    } else {
      // Handle non-streaming response
      const responseText = await response.text();
      try {
          const googleResponseData = JSON.parse(responseText);
          body = processCompletionsResponse(googleResponseData, req.model || model, id); // Pass parsed data
          responseHeaders.set('Content-Type', 'application/json'); // Ensure correct content type
      } catch (parseError) {
          console.error("Failed to parse non-streaming response:", parseError, responseText);
          throw new HttpError("Failed to parse upstream response", 502);
      }
    }
  } else {
      // Handle upstream errors (4xx, 5xx from Google)
      const errorText = await response.text();
      console.error(`Chat Completions API error: ${response.status}`, errorText);
      // Return Google's error response directly, but with CORS headers and correct content type
      responseHeaders.set('Content-Type', 'application/json'); // Assume error is JSON
      return new Response(errorText, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
      });
  }

  // Return the processed body (stream or JSON string) with appropriate headers
  return new Response(body, {
      status: response.status, // Use original status code (usually 200 for success)
      statusText: response.statusText,
      headers: responseHeaders
  });
}


// 添加内容安全验证函数
const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  stop: "stopSequences",
  n: "candidateCount", // not for streaming
  max_tokens: "maxOutputTokens",
  max_completion_tokens: "maxOutputTokens",
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK", // non-standard
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
};

const transformConfig = (req) => {
  let cfg = {};
  // Map standard OpenAI fields to Gemini fields
  for (let key in fieldsMap) {
    if (req[key] !== undefined && req[key] !== null) { // Check if key exists and is not null
      const matchedKey = fieldsMap[key];
      cfg[matchedKey] = req[key];
    }
  }

  // Handle stop sequences (string or array)
  if (req.stop) {
      cfg.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
      // Add validation for max 5 stop sequences if needed
      if (cfg.stopSequences.length > 5) {
          console.warn("More than 5 stop sequences provided, Gemini API supports max 5.");
          cfg.stopSequences = cfg.stopSequences.slice(0, 5);
      }
  }


  // Handle response_format (JSON mode)
  if (req.response_format) {
    // Gemini only supports application/json or text/plain
    if (req.response_format.type === "json_object") {
        cfg.responseMimeType = "application/json";
    } else if (req.response_format.type === "text") {
        cfg.responseMimeType = "text/plain";
    } else {
        // Ignore unsupported types or throw error?
        console.warn(`Unsupported response_format type: ${req.response_format.type}. Using default.`);
        // throw new HttpError(`Unsupported response_format.type: ${req.response_format.type}`, 400);
    }
    // Note: Gemini's responseSchema is more complex than just setting mime type
    // This basic mapping only handles the mime type for JSON output mode.
  }
  return cfg;
};

const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // Example: 4MB limit

const parseImg = async (url) => {
  let mimeType, data, sourceDescription;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    sourceDescription = `URL: ${url}`;
    try {
      const response = await fetch(url); // Add timeout?
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
      }
      mimeType = response.headers.get("content-type");
      if (!mimeType || !mimeType.startsWith('image/')) {
          throw new Error(`Invalid content type for image: ${mimeType}`);
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
          throw new Error(`Image size (${buffer.byteLength} bytes) exceeds limit of ${MAX_IMAGE_SIZE_BYTES} bytes.`);
      }
      data = Buffer.from(buffer).toString("base64");
    } catch (err) {
      console.error(`Error fetching image from ${url}:`, err);
      throw new Error(`Error fetching image (${sourceDescription}): ${err.message}`);
    }
  } else if (url.startsWith("data:")) {
    sourceDescription = `Data URL (truncated): ${url.substring(0, 100)}...`;
    const match = url.match(/^data:(?<mimeType>image\/.*?)(;base64)?,(?<data>.*)$/);
    if (!match || !match.groups.mimeType || !match.groups.data) {
      throw new Error("Invalid image data URL format.");
    }
    ({ mimeType, data } = match.groups);
    // Estimate size from base64 length (approx 3/4)
    const approxSize = data.length * 0.75;
     if (approxSize > MAX_IMAGE_SIZE_BYTES) {
         throw new Error(`Image size (estimated ${approxSize} bytes from data URL) exceeds limit of ${MAX_IMAGE_SIZE_BYTES} bytes.`);
     }
  } else {
      throw new Error("Unsupported image URL format. Must start with http(s):// or data:image/");
  }

  // Validate mime type further if needed (e.g., allow only jpeg, png, webp)
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
  if (!allowedMimeTypes.includes(mimeType.toLowerCase())) {
       console.warn(`Unsupported image MIME type: ${mimeType}. Attempting to use anyway.`);
       // Or throw: throw new Error(`Unsupported image MIME type: ${mimeType}. Allowed: ${allowedMimeTypes.join(', ')}`);
  }


  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformMsg = async ({ role, content, tool_calls }) => { // Added tool_calls
  const parts = [];
  // Handle string content (common case)
  if (typeof content === 'string') {
    parts.push({ text: content });
  }
  // Handle array content (multimodal)
  else if (Array.isArray(content)) {
    for (const item of content) {
      switch (item.type) {
        case "text":
          parts.push({ text: item.text });
          break;
        case "image_url":
          try {
              parts.push(await parseImg(item.image_url.url));
          } catch (imgError) {
              // Propagate image parsing errors
              throw new HttpError(`Failed to process image_url: ${imgError.message}`, 400);
          }
          break;
        // Add handling for other potential OpenAI content types if needed
        // case "audio_url": ...
        default:
          // Ignore unknown types or throw error?
          console.warn(`Unknown content part type "${item.type}" in role ${role}. Skipping.`);
          // throw new TypeError(`Unknown "content" item type: "${item.type}"`);
      }
    }
    // Gemini requires text if only images are present
    if (parts.length > 0 && parts.every(p => p.inlineData)) {
        parts.push({ text: "" }); // Add empty text part
    }
  }
  // Handle null content (often for assistant messages with tool calls)
  else if (content === null && role === 'assistant' && tool_calls) {
      // Content is null, parts remain empty, handled below by tool_calls
  }
  // Handle unexpected content types
  else if (content !== null) {
      console.warn(`Unexpected content type in role ${role}: ${typeof content}. Content:`, content);
      throw new HttpError(`Invalid content type for role ${role}: ${typeof content}`, 400);
  }


  // --- Tool Call Transformation ---
  // Assistant message requesting tool execution
  if (role === 'assistant' && tool_calls) {
      parts.push({
          functionCall: {
              name: tool_calls[0].function.name, // Assuming one tool call per message for simplicity
              args: JSON.parse(tool_calls[0].function.arguments) // Arguments are stringified JSON
          }
      });
  }

  // Tool message providing results
  if (role === 'tool' && content) { // Assuming content holds the result string for the tool role
      // Find the corresponding functionCall part in the previous message? This is complex.
      // Simpler: Assume 'content' is the result for the function called previously.
      // Gemini expects { functionResponse: { name: ..., response: { content: ... } } }
      // We need the function name from the previous assistant message. This requires state or looking back.
      // For stateless proxy, this transformation is difficult.
      // Option 1: Require client to use Gemini format for tool calls.
      // Option 2: Attempt to look back (hard in stateless worker).
      // Option 3: Make assumptions (e.g., content is the result for the *last* function called).
      // Let's log a warning and skip transformation for now.
      console.warn("Transforming OpenAI 'tool' role to Gemini 'function' role is complex and not fully supported in this stateless proxy. Use Gemini native format for tool calls.");
      // If we *had* the function name:
      // return {
      //     role: 'function', // Gemini uses 'function' role for tool results
      //     parts: [{
      //         functionResponse: {
      //             name: tool_call_id, // Need the function name (or id?) from the call
      //             response: {
      //                 // Gemini expects 'name' and 'content' inside response
      //                 // This structure might vary based on the tool definition
      //                 content: content // Assuming content is the direct result
      //             }
      //         }
      //     }]
      // };
      // Since we can't reliably transform, return null or throw error?
      return null; // Skip tool role messages for now
  }
  // --- End Tool Call Transformation ---


  // Map role: assistant -> model, tool -> function (partially handled above)
  let geminiRole = role;
  if (role === 'assistant') geminiRole = 'model';
  // 'tool' role mapping is problematic (see above)

  // Skip message if role mapping failed (e.g., for 'tool')
  if (!geminiRole || geminiRole === 'tool') return null;


  // Return null if parts are empty and it's not a function call message
  if (parts.length === 0 && !(role === 'assistant' && tool_calls)) {
      // Allow empty content for system messages? Check Gemini docs.
      // If system instruction is handled separately, empty user/model messages might be invalid.
      console.warn(`Message with role ${role} resulted in empty parts and no tool call. Skipping.`);
      return null;
  }


  return { role: geminiRole, parts };
};

const transformMessages = async (messages) => {
  if (!messages) { return {}; } // Return empty object if no messages

  const contents = [];
  let system_instruction = null; // Use null as default

  // Process messages sequentially
  for (const item of messages) {
    if (item.role === "system") {
      // Handle system instruction (Gemini expects only one)
      if (system_instruction) {
          console.warn("Multiple system messages found. Only the first one will be used as system_instruction.");
      } else {
          // System instruction content should be simple text
          if (typeof item.content === 'string') {
              system_instruction = { role: 'system', parts: [{ text: item.content }] };
          } else {
               console.warn("System message content is not a string. Ignoring.");
               // Or throw: throw new HttpError("System message content must be a string", 400);
          }
      }
    } else {
      // Transform user, assistant, tool messages
      const transformed = await transformMsg(item);
      if (transformed) { // Only add if transformation was successful
          contents.push(transformed);
      }
    }
  }

  // Gemini requires alternating user/model roles after the optional system instruction.
  // Validate and potentially adjust the sequence.
  let lastRole = 'system'; // Start assuming system instruction might be present
  const validatedContents = [];
  for (const msg of contents) {
      // Skip consecutive messages with the same role (except for function/model pairs?)
      // Gemini expects user -> model -> user -> model ...
      // Or user -> model (func_call) -> function -> model -> ...
      if (msg.role === lastRole) {
          console.warn(`Skipping consecutive message with role '${msg.role}'. Gemini requires alternating roles.`);
          continue;
      }
      // Basic alternation check (user/model)
      if ((lastRole === 'user' && msg.role !== 'model') || (lastRole === 'model' && msg.role !== 'user')) {
           // This check needs refinement for tool calls (model -> function -> model)
           // For now, just log a warning if basic alternation is broken
           console.warn(`Role alternation potentially broken: ${lastRole} -> ${msg.role}`);
      }

      validatedContents.push(msg);
      lastRole = msg.role;
  }


  // Add dummy model message if only system instruction exists? Gemini might require contents.
  // if (system_instruction && validatedContents.length === 0) {
  //   validatedContents.push({ role: "model", parts: [{ text: " " }] }); // Or handle as error?
  // }

  // Return structure, ensuring properties exist even if null/empty
  return {
      system_instruction: system_instruction || undefined, // Use undefined if null
      contents: validatedContents
  };
};

const transformRequest = async (req) => {
    const { system_instruction, contents } = await transformMessages(req.messages);
    const generationConfig = transformConfig(req);

    // --- Tool Handling ---
    let tools = undefined;
    if (req.tools) {
        tools = req.tools.map(tool => {
            if (tool.type === 'function') {
                // Map OpenAI function tool to Gemini function declaration
                return {
                    functionDeclarations: [{
                        name: tool.function.name,
                        description: tool.function.description,
                        parameters: tool.function.parameters // Assuming schema is compatible
                    }]
                };
            }
            console.warn(`Unsupported tool type: ${tool.type}. Only 'function' tools are supported.`);
            return null;
        }).filter(t => t !== null);
        // Gemini expects a single 'tools' object containing functionDeclarations array
        if (tools.length > 0) {
             tools = { functionDeclarations: tools.flatMap(t => t.functionDeclarations) };
        } else {
             tools = undefined; // No valid tools found
        }
    }
    // --- End Tool Handling ---


    // Construct the final request body for Gemini API
    const geminiRequest = {
        ...(system_instruction && { system_instruction }), // Include if present
        contents, // Always include contents array
        ...(tools && { tools }), // Include if present
        safetySettings, // Include default safety settings
        ...(Object.keys(generationConfig).length > 0 && { generationConfig }), // Include if not empty
    };

    // console.log("Transformed Gemini Request:", JSON.stringify(geminiRequest, null, 2));
    return geminiRequest;
};

const generateChatcmplId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return "chatcmpl-" + Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  "FINISH_REASON_UNSPECIFIED": null, // Map unspecified to null or omit
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter", // Map recitation to content_filter
  "OTHER": "unknown", // Map OTHER to a generic reason or null
  "TOOL_CODE_INVALID": "tool_code_invalid", // New reason in some APIs? Map if needed.
  // Gemini specific reasons related to tools:
  "FUNCTION_CALL": "tool_calls", // Map Gemini's FUNCTION_CALL to OpenAI's tool_calls
};

// Helper to safely extract text or function call from Gemini parts
const extractContentFromParts = (parts) => {
    if (!parts || !Array.isArray(parts)) return null;

    const textParts = parts.filter(p => p.text !== undefined).map(p => p.text);
    const functionCallParts = parts.filter(p => p.functionCall);

    if (functionCallParts.length > 0) {
        // Handle function call
        const fc = functionCallParts[0].functionCall; // Assuming one function call per candidate part list
        return {
            tool_calls: [{
                id: `call_${generateChatcmplId()}`, // Generate a unique ID for the tool call
                type: 'function',
                function: {
                    name: fc.name,
                    // Arguments from Gemini are already objects, stringify for OpenAI
                    arguments: JSON.stringify(fc.args || {}),
                }
            }]
        };
    } else {
        // Handle text content
        // Join text parts with newline or space? OpenAI usually expects a single string.
        return textParts.join(""); // Join text parts into a single string
    }
};

const transformCandidates = (key, cand) => {
  const finishReason = reasonsMap[cand.finishReason] || cand.finishReason || null; // Map reason, default to null if unknown/unspecified

  // Extract content (text or tool call)
  const contentResult = extractContentFromParts(cand.content?.parts);

  let messageContent = null;
  let toolCalls = null;

  if (typeof contentResult === 'string') {
      messageContent = contentResult;
  } else if (contentResult && contentResult.tool_calls) {
      toolCalls = contentResult.tool_calls;
      // OpenAI expects content to be null when tool_calls are present
      messageContent = null;
  }

  // Construct the message/delta part
  const messagePart = {
      role: "assistant",
      // Only include content if it's not null (OpenAI spec)
      ...(messageContent !== null && { content: messageContent }),
      // Only include tool_calls if present
      ...(toolCalls && { tool_calls: toolCalls }),
  };

  return {
    index: cand.index || 0,
    [key]: messagePart, // Use 'message' or 'delta' as the key
    logprobs: null, // logprobs not directly available from Gemini API in this format
    // Only include finish_reason if it's not null
    ...(finishReason && { finish_reason: finishReason }),
  };
};
// Bind the function for message and delta transformations
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (usageMetadata) => {
    if (!usageMetadata) return undefined; // Return undefined if no usage data
    // Gemini fields: promptTokenCount, candidatesTokenCount, totalTokenCount
    return {
        completion_tokens: usageMetadata.candidatesTokenCount || 0, // Use candidatesTokenCount for completion
        prompt_tokens: usageMetadata.promptTokenCount || 0,
        total_tokens: usageMetadata.totalTokenCount || 0,
    };
};

const processCompletionsResponse = (data, model, id) => {
  // Handle potential errors returned in the response body
  if (data.error) {
      console.error("Error in Gemini API response:", data.error);
      // Re-throw as an HttpError or return an error structure?
      // For now, let's try to return OpenAI-like error structure if possible
      return JSON.stringify({
          id,
          choices: [], // No choices on error
          created: Math.floor(Date.now()/1000),
          model,
          object: "chat.completion", // Still completion object type
          error: { // Add error field
              message: data.error.message || "Unknown Gemini API error",
              type: data.error.status || "gemini_error",
              param: null,
              code: data.error.code || null,
          }
      });
  }

  // Handle cases where candidates might be missing (e.g., safety blocks without candidates array)
  const candidates = data.candidates || [];
  const usage = transformUsage(data.usageMetadata); // Transform usage

  return JSON.stringify({
    id,
    choices: candidates.map(transformCandidatesMessage), // Use the updated transform function
    created: Math.floor(Date.now()/1000),
    model, // Use the model name passed in
    // system_fingerprint: "fp_xxxxxxxxxx", // Not available from Gemini
    object: "chat.completion",
    ...(usage && { usage }), // Include usage if available
  }, null, "  "); // Pretty print JSON
};

const responseLineRE = /^data:\s*(.*)(?:\r\n|\r|\n){2}/; // More robust regex for line endings and optional space after data:
async function parseStream (chunk, controller) {
  // chunk is already decoded by TextDecoderStream
  if (typeof chunk !== 'string') {
      console.warn("parseStream received non-string chunk:", chunk);
      return;
  }
  this.buffer += chunk;
  let match;
  while ((match = this.buffer.match(responseLineRE))) {
    const line = match[1].trim(); // Get the JSON part and trim whitespace
    if (line && line !== '[DONE]') { // Process only if it's not empty and not the DONE marker
        controller.enqueue(line);
    } else if (line === '[DONE]') {
        // Handle DONE marker if needed, though usually handled in flush
        console.info("Received [DONE] marker in stream chunk.");
    }
    this.buffer = this.buffer.substring(match[0].length); // Remove processed part
  }
}
async function parseStreamFlush (controller) {
  // Process any remaining buffer content (might be incomplete JSON)
  if (this.buffer.trim()) {
    console.warn("parseStreamFlush: Non-empty buffer remaining, potentially incomplete data:", this.buffer);
    // Try to enqueue if it looks like valid JSON, otherwise discard/log
    try {
        JSON.parse(this.buffer.trim()); // Test if it's valid JSON
        controller.enqueue(this.buffer.trim());
    } catch (e) {
        console.error("Discarding invalid JSON fragment from buffer:", this.buffer);
    }
  }
  this.buffer = ""; // Clear buffer
}

function transformResponseStream (data, isStopChunk, isFirstChunk) {
  // data here is the parsed JSON object from a single SSE event

  // Handle potential errors within the stream data
  if (data.error) {
      console.error("Error in Gemini stream response:", data.error);
      // How to signal this error in OpenAI stream format?
      // Option 1: Send an error chunk (custom format, might break clients)
      // Option 2: Send a chunk with finish_reason: 'error' (not standard)
      // Option 3: Terminate the stream (controller.terminate())?
      // Let's try sending a final chunk with an error message in content
      const errorChoice = {
          index: 0,
          delta: { role: 'assistant', content: `[ERROR: ${data.error.message || 'Unknown stream error'}]` },
          finish_reason: 'error', // Custom reason
      };
       return "data: " + JSON.stringify({
           id: this.id,
           choices: [errorChoice],
           created: Math.floor(Date.now()/1000),
           model: this.model,
           object: "chat.completion.chunk",
       }) + delimiter;
  }

  // If no candidates (e.g., safety block), create a placeholder or skip?
  const candidates = data.candidates || [];
  if (candidates.length === 0 && !isStopChunk) {
      // Maybe a safety block occurred without content.
      // Send a chunk with finish_reason: 'content_filter'?
      console.warn("Stream chunk received with no candidates.");
       const filterChoice = {
           index: 0,
           delta: { role: 'assistant', content: null }, // No content change
           finish_reason: 'content_filter',
       };
        return "data: " + JSON.stringify({
            id: this.id,
            choices: [filterChoice],
            created: Math.floor(Date.now()/1000),
            model: this.model,
            object: "chat.completion.chunk",
        }) + delimiter;
  }

  // Assuming only one candidate in streaming for simplicity here
  const cand = candidates[0];
  if (!cand) return null; // Should not happen if candidates array checked, but be safe

  const item = transformCandidatesDelta(cand); // Use updated transform function for delta

  // Adjust delta structure for OpenAI stream format
  if (isFirstChunk) {
      // First chunk should include the role
      item.delta = { role: "assistant", ...item.delta };
  } else {
      // Subsequent chunks only include changed fields (content or tool_calls)
      delete item.delta.role; // Role is only in the first delta
  }

  // If it's the stop chunk, delta should be empty, only finish_reason matters
  if (isStopChunk) {
      item.delta = {}; // Empty delta for the final chunk
      // Ensure finish_reason is set based on the last candidate received
      item.finish_reason = reasonsMap[cand.finishReason] || cand.finishReason || 'stop'; // Default to stop if reason missing
  } else {
      // For intermediate chunks, finish_reason should be null
      item.finish_reason = null;
      // If delta content/tool_calls are empty/null, skip sending the chunk?
      if (!item.delta.content && !item.delta.tool_calls) {
          // console.log("Skipping empty delta chunk");
          // return null; // Don't send chunk if delta has no changes
      }
  }

  const output = {
    id: this.id,
    choices: [item],
    created: Math.floor(Date.now()/1000),
    model: this.model,
    object: "chat.completion.chunk",
  };

  // Include usage in the *last* chunk if requested and available
  if (isStopChunk && data.usageMetadata && this.streamIncludeUsage) {
    output.usage = transformUsage(data.usageMetadata);
  } else {
      output.usage = null; // Usage is null for intermediate chunks
  }

  return "data: " + JSON.stringify(output) + delimiter;
}

const delimiter = "\\n\\n"; // Use double newline as delimiter

async function toOpenAiStream (chunk, controller) {
  const transform = transformResponseStream.bind(this); // Bind context (this.id, this.model, etc.)
  // chunk is already parsed JSON string from parseStream
  if (!chunk) { return; }

  let data;
  try {
    data = JSON.parse(chunk);
  } catch (err) {
    console.error("toOpenAiStream: Failed to parse JSON chunk:", chunk, err);
    // Send an error chunk?
     const errorChunk = transform({ error: { message: "Invalid JSON received in stream" } }, true, false);
     if (errorChunk) controller.enqueue(errorChunk);
    return; // Stop processing this chunk
  }

  // Determine if this is the first chunk based on whether 'this.last' is populated for the index
  const candIndex = data.candidates?.[0]?.index || 0; // Get index (default to 0)
  const isFirst = !this.last[candIndex];

  // Store the latest data received for this candidate index (used for final chunk generation)
  this.last[candIndex] = data;

  // Transform and enqueue the intermediate chunk
  // Pass isStopChunk=false, isFirstChunk=isFirst
  const outputChunk = transform(data, false, isFirst);
  if (outputChunk) { // Only enqueue if transform returned data
      controller.enqueue(outputChunk);
  }
}

async function toOpenAiStreamFlush (controller) {
  const transform = transformResponseStream.bind(this);
  // This flush is called after the source stream closes.
  // We need to generate the final chunk(s) with finish_reason and potentially usage.
  if (this.last && this.last.length > 0) {
    for (let i = 0; i < this.last.length; i++) {
        const lastDataForIndex = this.last[i];
        if (lastDataForIndex) {
            // Generate the final stop chunk for this index
            // Pass isStopChunk=true, isFirstChunk=false (it's definitely not the first)
            const stopChunk = transform(lastDataForIndex, true, false);
            if (stopChunk) {
                controller.enqueue(stopChunk);
            }
        }
    }
    // After sending all final chunks, send the [DONE] marker
    controller.enqueue("data: [DONE]" + delimiter);
  } else {
      // If no chunks were ever processed, maybe send DONE anyway or log warning
      console.warn("toOpenAiStreamFlush: No data was processed, sending [DONE] marker.");
      controller.enqueue("data: [DONE]" + delimiter);
  }
  // Clear state
  this.last = [];
}

// --- Updated/New Validation Functions ---

// Renamed original validateContentSafety
function validateOpenAIContentSafety(body) {
  // Original implementation for OpenAI 'messages' structure
  if (!body || !body.messages || !Array.isArray(body.messages)) {
      // Allow empty messages? Or throw?
      // throw new HttpError("Invalid request: 'messages' array is required.", 400);
      console.warn("validateOpenAIContentSafety: 'messages' array missing or invalid.");
      return; // Allow request if messages are optional?
  }

  if (body.messages.length === 0) {
       throw new HttpError("Invalid request: 'messages' array cannot be empty.", 400);
  }
  if (body.messages.length > 100) { // Example limit
    throw new HttpError("Too many messages. Maximum allowed: 100", 400);
  }

  for (const message of body.messages) {
      if (!message || typeof message.role !== 'string' || !message.role) {
           throw new HttpError("Invalid message format: 'role' is required.", 400);
      }
      // Content can be string or array for user/assistant, null for assistant tool calls
      const content = message.content;
      const role = message.role;

      if (role === 'system' || role === 'user') {
          if (typeof content === 'string') {
              if (content.length > 1000000) { // Example limit
                  throw new HttpError(`Message content (role: ${role}) too large. Maximum allowed: 1,000,000 characters`, 400);
              }
          } else if (Array.isArray(content)) { // Multimodal user message
              if (content.length === 0) {
                   throw new HttpError(`Message content array (role: ${role}) cannot be empty.`, 400);
              }
              for (const part of content) {
                  if (!part || typeof part.type !== 'string') {
                       throw new HttpError(`Invalid part in message content (role: ${role}): 'type' is required.`, 400);
                  }
                  if (part.type === 'text') {
                      if (typeof part.text !== 'string') {
                           throw new HttpError(`Invalid text part in message content (role: ${role}): 'text' must be a string.`, 400);
                      }
                      if (part.text.length > 1000000) { // Example limit
                          throw new HttpError(`Text part too large (role: ${role}). Maximum allowed: 1,000,000 characters`, 400);
                      }
                  } else if (part.type === 'image_url') {
                      if (!part.image_url || typeof part.image_url.url !== 'string') {
                           throw new HttpError(`Invalid image_url part in message content (role: ${role}): 'image_url.url' must be a string.`, 400);
                      }
                      const url = part.image_url.url;
                      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
                          throw new HttpError(`Invalid image URL format in message content (role: ${role}).`, 400);
                      }
                      // Add size check here? Requires fetching URL or decoding data URL, complex here. parseImg handles it later.
                  } else {
                       throw new HttpError(`Unsupported part type '${part.type}' in message content (role: ${role}).`, 400);
                  }
              }
          } else {
               throw new HttpError(`Invalid message content type for role ${role}: expected string or array.`, 400);
          }
      } else if (role === 'assistant') {
           // Assistant content can be string or null (if tool_calls present)
           if (typeof content === 'string') {
                if (content.length > 1000000) { // Example limit
                    throw new HttpError(`Message content (role: ${role}) too large. Maximum allowed: 1,000,000 characters`, 400);
                }
           } else if (content === null) {
                // Check if tool_calls are present if content is null
                if (!message.tool_calls || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
                     throw new HttpError(`Assistant message content is null, but 'tool_calls' are missing or empty.`, 400);
                }
                // Validate tool_calls structure further?
           } else {
                throw new HttpError(`Invalid message content type for role ${role}: expected string or null.`, 400);
           }
      } else if (role === 'tool') {
           // Tool role requires content (result) and tool_call_id
           if (typeof content !== 'string') {
                throw new HttpError(`Invalid message content type for role ${role}: expected string.`, 400);
           }
           if (content.length > 1000000) { // Example limit for tool result
                throw new HttpError(`Tool result content (role: ${role}) too large. Maximum allowed: 1,000,000 characters`, 400);
           }
           if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) {
                throw new HttpError(`Invalid message format (role: ${role}): 'tool_call_id' is required.`, 400);
           }
      } else {
           throw new HttpError(`Invalid message role: '${role}'.`, 400);
      }
    }
}

function validateOpenAIEmbeddingsInput(body) {
  // Validation for OpenAI embeddings input
  if (!body || (!body.input && body.input !== '')) { // Allow empty string input? Check API spec.
      throw new HttpError("Invalid request: 'input' field is required for embeddings.", 400);
  }

  const inputs = Array.isArray(body.input) ? body.input : [body.input];

  if (inputs.length === 0) {
       throw new HttpError("Invalid request: 'input' array cannot be empty.", 400);
  }
  if (inputs.length > 128) { // Keep existing limit or adjust based on target model
      throw new HttpError(`Too many input items for embeddings. Maximum allowed: 128`, 400);
  }

  for (const item of inputs) {
      if (typeof item !== 'string') {
           throw new HttpError("Invalid input item for embeddings: all items must be strings.", 400);
      }
      if (item.length > 8192) { // Example limit per item, check model limits
           throw new HttpError(`Input item too large for embeddings. Maximum allowed: 8192 characters.`, 400);
      }
  }

  // Validate dimensions if present
  if (body.dimensions !== undefined) {
      if (typeof body.dimensions !== 'number' || !Number.isInteger(body.dimensions) || body.dimensions <= 0) {
           throw new HttpError("Invalid 'dimensions' parameter: must be a positive integer.", 400);
      }
      // Add model-specific dimension limits if known
  }
}

function validateGeminiContentSafety(body) {
  // Validation for Gemini 'contents' structure
  if (!body || !body.contents || !Array.isArray(body.contents)) {
      // Allow requests without 'contents' if valid (e.g., only system_instruction)? Check Gemini API spec.
      // If contents are always required for generateContent:
      // throw new HttpError("Invalid request: 'contents' array is required for generateContent.", 400);
      console.warn("validateGeminiContentSafety: 'contents' array missing or invalid.");
      return; // Allow request for now, Gemini API will likely reject if needed
  }

  if (body.contents.length === 0) {
       throw new HttpError("Invalid request: 'contents' array cannot be empty.", 400);
  }
  if (body.contents.length > 100) { // Example limit
    throw new HttpError("Too many content blocks. Maximum allowed: 100", 400);
  }

  for (const content of body.contents) {
      if (!content || !content.parts || !Array.isArray(content.parts)) {
           throw new HttpError("Invalid content block: 'parts' array is required.", 400);
      }
      if (content.parts.length === 0) {
           throw new HttpError("Invalid content block: 'parts' array cannot be empty.", 400);
      }
      if (content.parts.length > 50) { // Example limit on parts per content block
          throw new HttpError("Too many parts in a content block. Maximum allowed: 50", 400);
      }

      for (const part of content.parts) {
          if (!part) {
               throw new HttpError("Invalid part in content block: part cannot be null.", 400);
          }
          const hasText = part.text !== undefined && part.text !== null;
          const hasInlineData = part.inlineData !== undefined && part.inlineData !== null;
          const hasFunctionCall = part.functionCall !== undefined && part.functionCall !== null;
          const hasFunctionResponse = part.functionResponse !== undefined && part.functionResponse !== null;

          // Check that each part has exactly one content type defined
          const definedParts = [hasText, hasInlineData, hasFunctionCall, hasFunctionResponse].filter(Boolean).length;
          if (definedParts !== 1) {
               throw new HttpError("Invalid part in content block: Each part must contain exactly one of 'text', 'inlineData', 'functionCall', or 'functionResponse'.", 400);
          }


          if (hasText) {
              if (typeof part.text !== 'string') {
                   throw new HttpError("Invalid text part: 'text' must be a string.", 400);
              }
              if (part.text.length > 1000000) { // Example limit
                  throw new HttpError("Text part too large. Maximum allowed: 1,000,000 characters", 400);
              }
          } else if (hasInlineData) {
              if (typeof part.inlineData !== 'object' || !part.inlineData.mimeType || !part.inlineData.data) {
                   throw new HttpError("Invalid inlineData part: must be an object with 'mimeType' and 'data'.", 400);
              }
              // Add size check for base64 data? parseImg handles this during transformation.
              // const approxSize = part.inlineData.data.length * 0.75;
              // if (approxSize > MAX_IMAGE_SIZE_BYTES) { ... }
          }
          // Add validation for functionCall and functionResponse structures if needed
          else if (hasFunctionCall) {
               if (typeof part.functionCall !== 'object' || typeof part.functionCall.name !== 'string' || typeof part.functionCall.args !== 'object') {
                    throw new HttpError("Invalid functionCall part: must be an object with 'name' (string) and 'args' (object).", 400);
               }
          } else if (hasFunctionResponse) {
               if (typeof part.functionResponse !== 'object' || typeof part.functionResponse.name !== 'string' || typeof part.functionResponse.response !== 'object') {
                    throw new HttpError("Invalid functionResponse part: must be an object with 'name' (string) and 'response' (object).", 400);
               }
          }
      }
  }
  // Validate system_instruction if present
  if (body.system_instruction) {
       if (typeof body.system_instruction !== 'object' || !body.system_instruction.parts || !Array.isArray(body.system_instruction.parts) || body.system_instruction.parts.length !== 1 || typeof body.system_instruction.parts[0].text !== 'string') {
            throw new HttpError("Invalid 'system_instruction': must contain exactly one part with text content.", 400);
       }
       if (body.system_instruction.parts[0].text.length > 100000) { // Example limit
            throw new HttpError("System instruction text too large. Maximum allowed: 100,000 characters.", 400);
       }
  }
  // Validate tools structure if present
  if (body.tools) {
      // Add validation for Gemini tools structure (e.g., functionDeclarations)
  }
  // Validate generationConfig if present
  if (body.generationConfig) {
      // Add validation for Gemini generationConfig fields (temperature, topP, maxOutputTokens, etc.)
  }
}

function validateGeminiEmbeddingsInput(body) {
  // Validation for Gemini embeddings input (embedContent / batchEmbedContents)
  const isBatch = body.requests !== undefined;
  const isSingle = body.content !== undefined;

  if (!isBatch && !isSingle) {
      throw new HttpError("Invalid request structure for Gemini embeddings: requires 'content' or 'requests'.", 400);
  }
  if (isBatch && isSingle) {
       throw new HttpError("Invalid request structure for Gemini embeddings: cannot have both 'content' and 'requests'.", 400);
  }

  let requestsToValidate = [];
  if (isBatch) {
      if (!Array.isArray(body.requests)) {
           throw new HttpError("Invalid batch embedding request: 'requests' must be an array.", 400);
      }
      if (body.requests.length === 0) {
           throw new HttpError("Invalid batch embedding request: 'requests' array cannot be empty.", 400);
      }
      if (body.requests.length > 100) { // Gemini API limit is 100 per batch
          throw new HttpError("Too many embedding requests in batch. Maximum allowed: 100", 400);
      }
      requestsToValidate = body.requests;
  } else { // isSingle
      requestsToValidate = [{ content: body.content, model: body.model, taskType: body.taskType, outputDimensionality: body.outputDimensionality, title: body.title }]; // Wrap single request for uniform validation
  }

  for (const req of requestsToValidate) {
      if (!req || !req.content || !req.content.parts || !Array.isArray(req.content.parts) || req.content.parts.length === 0) {
           throw new HttpError("Invalid embedding request: 'content.parts' array is required and cannot be empty.", 400);
      }
      // Add model validation if needed (e.g., check against known embedding models)
      // if (!req.model || !req.model.startsWith('models/text-embedding-')) { ... }

      let totalTextLength = 0;
      for (const part of req.content.parts) {
          if (!part || typeof part.text !== 'string') {
               throw new HttpError("Invalid part in embedding request: Each part must contain 'text' (string).", 400);
          }
          if (part.text.length > 20000) { // Example limit per text part, check Gemini docs
               throw new HttpError(`Text part too large in embedding request. Max 20,000 chars per part.`, 400);
          }
          totalTextLength += part.text.length;
      }
       // Add total length check if applicable (e.g., across all parts)
       if (totalTextLength > 30000) { // Example total limit
            throw new HttpError(`Total text length across parts too large in embedding request. Max 30,000 chars total.`, 400);
       }

       // Validate taskType if present
       if (req.taskType && typeof req.taskType !== 'string') {
            // Add explicit braces
            { throw new HttpError("Invalid 'taskType' in embedding request: must be a string.", 400); }
       }
       // Validate outputDimensionality if present
       if (req.outputDimensionality !== undefined && (typeof req.outputDimensionality !== 'number' || !Number.isInteger(req.outputDimensionality) || req.outputDimensionality <= 0)) {
            // Add explicit braces
            { throw new HttpError("Invalid 'outputDimensionality' in embedding request: must be a positive integer.", 400); }
       }
       // Validate title if present
       if (req.title !== undefined && typeof req.title !== 'string') {
            // Add explicit braces
            { throw new HttpError("Invalid 'title' in embedding request: must be a string.", 400); }
       }
  }
}