# 简化版 Gemini API 代理

这是一个简化版的 Cloudflare Workers 服务，专门用于代理 Google Gemini API 请求。该服务移除了原版中的静态资源服务、安全监控等非必要功能，只保留了核心的请求代理和基本的请求过滤功能。

## 功能特点

- 代理 Gemini API 请求
- WebSocket 连接支持
- 基本的请求限流功能
- 可疑请求过滤

## 部署步骤

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare 账户

```bash
wrangler login
```

### 3. 发布 Worker

使用简化版配置文件:

```bash
wrangler publish --config wrangler-simple.toml
```

## 本地开发

启动本地开发服务器:

```bash
wrangler dev --config wrangler-simple.toml
```

## 使用方法

部署后，可以通过以下方式使用:

1. **直接代理 API 请求**

   ```bash
   https://your-worker-url.workers.dev/v1beta/models
   ```

2. **使用 WebSocket 连接**

   ```bash
   wss://your-worker-url.workers.dev/v1beta/stream
   ```
