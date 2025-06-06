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
      const status = err.status || 500;
      const body = JSON.stringify({
        error: {
          message: err.message || 'Internal Server Error',
          type: err.name || 'Error',
          status
        }
      }, null, 2);
      
      return new Response(body, fixCors({ 
        status, 
        headers: { 'Content-Type': 'application/json' }
      }));
    };
    
    try {
      // 从不同的头部获取API密钥，并根据 X-API-Format 或 X-Goog-Api-Key 判断 Gemini 格式
      const authHeader = request.headers.get("Authorization");
      const googleApiKeyHeader = request.headers.get("X-Goog-Api-Key");
      const apiFormat = request.headers.get("X-API-Format");
      const url = new URL(request.url);
      let apiKey;
      
      // 只有 X-Goog-Api-Key 或 X-API-Format=gemini 时才识别为 Gemini 格式
      // 或者路径以 /v1beta 或 /v1 开头
      const isGeminiFormat = !!googleApiKeyHeader || 
                             apiFormat === "gemini" || 
                             url.pathname.startsWith('/v1beta') || 
                             url.pathname.startsWith('/v1');

      if (googleApiKeyHeader) {
        apiKey = googleApiKeyHeader;
      } else if (isGeminiFormat && url.searchParams.has('key')) {
        // 如果是 Gemini 格式且 URL 查询参数中有 key，则优先使用它
        apiKey = url.searchParams.get('key');
        console.log('Using API key from query parameter for Gemini format.');
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

      // 请求限流检查
      if (!isGeminiFormat) {
        // OpenAI格式的请求限流
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
      } else {
        // Gemini格式的请求限流
        if (pathname.includes("generateContent") || pathname.includes("streamGenerateContent")) {
          if (chatCompletionLimiter.isRateLimited(clientIP)) {
            throw new HttpError("Rate limit exceeded for generate content", 429);
          }
        } else if (pathname.includes("embedContent")) {
          if (embeddingsLimiter.isRateLimited(clientIP)) {
            throw new HttpError("Rate limit exceeded for embed content", 429);
          }
        }
      }
      
      const assert = (success, message = "Method not allowed", status = 405) => {
        if (!success) {
          throw new HttpError(message, status);
        }
      };
      
      // 根据API格式处理请求
      if (isGeminiFormat) {
        // 所有 Gemini 格式请求，使用通用转发
        // handleGeminiRequest 内部会处理 API 版本路径
        return await handleGeminiRequest(request, url, apiKey, errHandler); // Pass URL object
      } else {
        // 处理OpenAI格式的API请求
        switch (true) {
          case pathname.endsWith("/chat/completions"):
            assert(request.method === "POST");
            const chatCompletionBody = await request.json();
            
            // 内容安全检查
            validateContentSafety(chatCompletionBody);
            
            return await withRetry(() => handleCompletions(chatCompletionBody, apiKey))
              .catch(errHandler);
              
          case pathname.endsWith("/embeddings"):
            assert(request.method === "POST");
            const embeddingsBody = await request.json();
            
            // 验证输入长度，防止过大请求
            if (Array.isArray(embeddingsBody.input)) {
              assert(
                embeddingsBody.input.length <= 128, 
                "Too many input items. Maximum allowed: 128", 
                400
              );
            }
            
            return await withRetry(() => handleEmbeddings(embeddingsBody, apiKey))
              .catch(errHandler);
              
          case pathname.endsWith("/models"): // OpenAI 格式允许访问 /models
            assert(request.method === "GET");
            // OpenAI 格式的模型列表请求，进行格式转换
            return await withRetry(() => handleOpenAIModels(apiKey)) // Renamed from handleModels
              .catch(errHandler);
              
          default:
            throw new HttpError("404 Not Found", 404);
        }
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};

// 处理Gemini原生格式的API请求
// Modify handleGeminiRequest to accept URL object
async function handleGeminiRequest(request, url, apiKey, errHandler) {
  // 直接转发到Gemini API
  try {
    // 构建Gemini API URL
    // let finalPathname = url.pathname; // Use pathname from URL object
    // // 处理 API 版本路径：如果请求路径不以 /v1beta/ 或 /v1/ 开头，则添加默认版本
    // const versionPattern = /^\/v(1beta|1)\//;
    // if (!versionPattern.test(finalPathname)) {
    //   // 如果不包含版本前缀，则添加默认 API_VERSION
    //   finalPathname = `/${API_VERSION}${finalPathname.startsWith('/') ? finalPathname : `/${finalPathname}`}`;
    //   console.log(`Prepending API version. Original pathname: ${url.pathname}, New pathname: ${finalPathname}`);
    // } else {
    //   console.log(`Pathname already includes API version: ${url.pathname}`);
    // }

    // 直接使用原始请求的 URL 路径和查询参数，因为 Deno 已经处理了格式判断
    const targetUrl = `${CONFIG.BASE_URL}${url.pathname}${url.search}`;

    // 创建请求头
    const headers = new Headers();
    for (const [key, value] of request.headers.entries()) {
      // 跳过一些特定的头，特别是 host 和可能导致问题的头
      const lowerKey = key.toLowerCase();
      if (!['host', 'connection', 'content-length', 'content-type', 'authorization', 'x-api-format', 'x-goog-api-key'].includes(lowerKey)) {
         headers.set(key, value);
      }
    }
     // 显式设置 Content-Type (如果原始请求中有)
     if (request.headers.has('content-type')) {
        headers.set('content-type', request.headers.get('content-type'));
     }

    // 确保API密钥正确设置 (使用 x-goog-api-key)
    // 注意：即使原始请求使用 ?key=...，转发到 Google API 时也应该用 x-goog-api-key 头
    headers.set('x-goog-api-key', apiKey);
    // 添加 x-goog-api-client 头
    headers.set('x-goog-api-client', API_CLIENT);

    console.log(`Forwarding Gemini request to: ${targetUrl}`);
    console.log(`Forwarding headers (using x-goog-api-key):`, [...headers.entries()]); // Log headers

    // 构建 fetch 选项，仅在非 GET/HEAD 请求中包含 body 和 duplex
    const fetchOptions = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fetchOptions.body = request.body;
      // 对于 Cloudflare Workers，可能需要 'half' duplex
      // 对于 Deno Deploy 或其他环境，可能不需要或需要不同设置
      // 暂时移除 duplex，让 fetch 自动处理
      // fetchOptions.duplex = 'half'; 
    }
    const geminiResponse = await fetch(targetUrl, fetchOptions);

    console.log(`Received Gemini response status: ${geminiResponse.status}`);

    // 创建响应头
    let responseHeaders = new Headers();
    for (const [key, value] of geminiResponse.headers.entries()) {
       // 过滤掉 content-encoding，因为 Cloudflare Worker 会自动处理
       if (key.toLowerCase() !== 'content-encoding') {
          responseHeaders.set(key, value);
       }
    }

    // 添加CORS头
    responseHeaders = fixCors({ headers: responseHeaders }).headers;

    // 返回响应，直接流式传输响应体
    return new Response(geminiResponse.body, {
      status: geminiResponse.status,
      statusText: geminiResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
     console.error("Error in handleGeminiRequest:", err);
    return errHandler(err);
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
      console.warn(`Request failed (attempt ${i + 1}/${attempts}): ${error.message}`);
      lastError = error;
      
      // 只重试可恢复的错误（网络错误或5xx错误）
      if (error.status && (error.status < 500 || error.status === 429)) {
        throw error; // 不重试客户端错误或请求过多
      }
      
      if (i < attempts - 1) {
        // 指数退避
        const delay = CONFIG.RETRY_DELAY * Math.pow(2, i);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400"); // 24小时
  return { headers, status, statusText };
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
    status: 204 // 使用正确的 No Content 状态码
  });
};

const BASE_URL = CONFIG.BASE_URL;
const API_VERSION = CONFIG.API_VERSION;

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
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

// 重命名原来的 handleModels 以明确其用于 OpenAI 格式转换
async function handleOpenAIModels (apiKey) {
  return await measurePerformance('handleOpenAIModels', async () => {
    const cacheKey = 'openai_models'; // Use a different cache key for OpenAI format
    const cachedResponse = modelsCache.get(cacheKey);
    if (cachedResponse) {
      return new Response(cachedResponse, fixCors({
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    const url = `${BASE_URL}/${API_VERSION}/models`; // Fetch from the correct Gemini endpoint
    console.log(`Fetching models for OpenAI format from: ${url}`);

    const response = await fetch(url, {
      headers: makeHeaders(apiKey),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Models API error (for OpenAI format): ${response.status} ${errorText}`);
      throw new HttpError(`Models API error: ${response.status} ${errorText}`, response.status);
    }

    // Transform to OpenAI format
    const { models } = JSON.parse(await response.text());
    const body = JSON.stringify({
      object: "list",
      data: models.map(({ name }) => ({
        id: name.replace("models/", ""),
        object: "model",
        owned_by: "google",
      })),
    }, null, "  ");

    modelsCache.set(cacheKey, body); // Cache the transformed OpenAI format response

    return new Response(body, fixCors({
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  });
}

const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-004";
async function handleEmbeddings (req, apiKey) {
  const cacheKey = JSON.stringify(req);
  const cachedResponse = embeddingsCache.get(cacheKey);
  if (cachedResponse) {
    return new Response(cachedResponse, fixCors({
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  if (!Array.isArray(req.input)) {
    req.input = [ req.input ];
  }
  let model;
  if (req.model.startsWith("models/")) {
    model = req.model;
  } else {
    req.model = DEFAULT_EMBEDDINGS_MODEL;
    model = "models/" + req.model;
  }
  const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      "requests": req.input.map(text => ({
        model,
        content: { parts: { text } },
        outputDimensionality: req.dimensions,
      }))
    })
  });
  let { body } = response;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: req.model,
    }, null, "  ");
    embeddingsCache.set(cacheKey, body);
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_MODEL = "gemini-1.5-pro-latest";
async function handleCompletions (req, apiKey) {
  let model = DEFAULT_MODEL;
  switch(true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("gemini-"):
    case req.model.startsWith("learnlm-"):
      model = req.model;
  }
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(await transformRequest(req)), // try
  });

  let body = response.body;
  if (response.ok) {
    let id = generateChatcmplId(); //"chatcmpl-8pMMaqXMK68B3nyDBrapTDrhkHBQK";
    if (req.stream) {
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
        }))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          streamIncludeUsage: req.stream_options?.include_usage,
          model, id, last: [],
        }))
        .pipeThrough(new TextEncoderStream());
    } else {
      body = await response.text();
      body = processCompletionsResponse(JSON.parse(body), model, id);
    }
  }
  return new Response(body, fixCors(response));
}

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
  //if (typeof req.stop === "string") { req.stop = [req.stop]; } // no need
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch(req.response_format.type) {
      case "json_schema":
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
        // eslint-disable-next-line no-fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new Error("Invalid image data: " + url);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformMsg = async ({ role, content }) => {
  const parts = [];
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({ text: content });
    return { role, parts };
  }
  // user:
  // An array of content parts with a defined type.
  // Supported options differ based on the model being used to generate the response.
  // Can contain text, image, or audio inputs.
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new TypeError(`Unknown "content" item type: "${item.type}"`);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" }); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return { role, parts };
};

const transformMessages = async (messages) => {
  if (!messages) { return; }
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    if (item.role === "system") {
      delete item.role;
      system_instruction = await transformMsg(item);
    } else {
      item.role = item.role === "assistant" ? "model" : "user";
      contents.push(await transformMsg(item));
    }
  }
  if (system_instruction && contents.length === 0) {
    contents.push({ role: "model", parts: { text: " " } });
  }
  //console.info(JSON.stringify(contents, 2));
  return { system_instruction, contents };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
});

const generateChatcmplId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return "chatcmpl-" + Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  //"OTHER": "OTHER",
  // :"function_call",
};
const SEP = "\n\n|>";
const transformCandidates = (key, cand) => ({
  index: cand.index || 0, // 0-index is absent in new -002 models response
  [key]: {
    role: "assistant",
    content: cand.content?.parts.map(p => p.text).join(SEP) },
  logprobs: null,
  finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
});
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (data) => ({
  completion_tokens: data.candidatesTokenCount,
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount
});

const processCompletionsResponse = (data, model, id) => {
  return JSON.stringify({
    id,
    choices: data.candidates.map(transformCandidatesMessage),
    created: Math.floor(Date.now()/1000),
    model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion",
    usage: transformUsage(data.usageMetadata),
  });
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
async function parseStream (chunk, controller) {
  chunk = await chunk;
  if (!chunk) { return; }
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}
async function parseStreamFlush (controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
  }
}

function transformResponseStream (data, stop, first) {
  const item = transformCandidatesDelta(data.candidates[0]);
  if (stop) { item.delta = {}; } else { item.finish_reason = null; }
  if (first) { item.delta.content = ""; } else { delete item.delta.role; }
  const output = {
    id: this.id,
    choices: [item],
    created: Math.floor(Date.now()/1000),
    model: this.model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion.chunk",
  };
  if (data.usageMetadata && this.streamIncludeUsage) {
    output.usage = stop ? transformUsage(data.usageMetadata) : null;
  }
  return "data: " + JSON.stringify(output) + delimiter;
}
const delimiter = "\n\n";
async function toOpenAiStream (chunk, controller) {
  const transform = transformResponseStream.bind(this);
  const line = await chunk;
  if (!line) { return; }
  let data;
  try {
    data = JSON.parse(line);
  } catch (err) {
    console.error(line);
    console.error(err);
    const length = this.last.length || 1; // at least 1 error msg
    const candidates = Array.from({ length }, (_, index) => ({
      finishReason: "error",
      content: { parts: [{ text: err }] },
      index,
    }));
    data = { candidates };
  }
  const cand = data.candidates[0];
  console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
  cand.index = cand.index || 0; // absent in new -002 models response
  if (!this.last[cand.index]) {
    controller.enqueue(transform(data, false, "first"));
  }
  this.last[cand.index] = data;
  if (cand.content) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(transform(data));
  }
}
async function toOpenAiStreamFlush (controller) {
  const transform = transformResponseStream.bind(this);
  if (this.last.length > 0) {
    for (const data of this.last) {
      controller.enqueue(transform(data, "stop"));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}

// 添加内容安全验证函数
function validateContentSafety(body) {
  // 检查消息内容
  if (body.messages && Array.isArray(body.messages)) {
    // 检查消息总数
    if (body.messages.length > 100) {
      throw new HttpError("Too many messages. Maximum allowed: 100", 400);
    }
    
    // 检查每条消息内容大小
    for (const message of body.messages) {
      if (typeof message.content === 'string') {
        if (message.content.length > 1000000) {  // 限制10万字符
          throw new HttpError("Message content too large. Maximum allowed: 1000000 characters", 400);
        }
      } else if (Array.isArray(message.content)) {
        // 检查多模态内容
        for (const part of message.content) {
          if (part.type === 'text' && part.text.length > 1000000) {
            throw new HttpError("Text content too large. Maximum allowed: 1000000 characters", 400);
          }
          
          // 检查图像URL
          if (part.type === 'image_url') {
            // 简单的URL格式检查
            const url = part.image_url.url;
            if (typeof url !== 'string' || (!url.startsWith('http://') && 
                !url.startsWith('https://') && !url.startsWith('data:'))) {
              throw new HttpError("Invalid image URL format", 400);
            }
          }
        }
      }
    }
  }
}