# 部署到 Cloudflare Workers 的说明

## 项目架构

本项目已从 Deno 服务迁移到 Cloudflare Workers。主要文件包括：

- `src/worker.js`: 主要的 Worker 入口文件
- `src/security.js`: 安全模块
- `wrangler.toml`: Cloudflare Workers 配置文件

## 部署步骤

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare 账户

```bash
wrangler login
```

### 3. 创建 KV 命名空间用于存储静态文件

```bash
wrangler kv:namespace create STATIC_ASSETS
```

执行后，您会得到一个 KV namespace ID，请将此 ID 复制到 `wrangler.toml` 文件中：

```toml
kv_namespaces = [
  { binding = "STATIC_ASSETS", id = "您的KV namespace ID" }
]
```

### 4. 上传静态资源到 KV 存储

```bash
# 上传 index.html
wrangler kv:key put --namespace-id=您的KV命名空间ID "/index.html" --path="src/static/index.html"

# 上传 favicon.ico
wrangler kv:key put --namespace-id=您的KV命名空间ID "/favicon.ico" --path="src/static/favicon.ico"
```

### 5. 设置环境变量

在 `wrangler.toml` 文件中更新 `ADMIN_TOKEN` 环境变量为安全的值：

```toml
[vars]
ADMIN_TOKEN = "您的安全令牌"
```

或者使用 Cloudflare 控制台中的"环境变量"部分进行设置。

### 6. 发布 Worker

```bash
wrangler publish
```

## 本地开发

### 启动本地开发服务器

```bash
wrangler dev
```

### 测试 API 代理

本地开发服务器运行后，您可以使用以下URL测试 API 代理：

```bash
http://localhost:8787/v1beta/models
```

## 迁移差异说明

1. **文件系统访问**：Cloudflare Workers 不支持直接文件系统访问，我们使用 KV 存储替代
2. **WebSocket 实现**：使用 Cloudflare 特有的 WebSocketPair API 处理 WebSocket 连接
3. **环境变量**：使用 Cloudflare Workers 环境变量替代 Deno.env
4. **请求处理**：适配了 Cloudflare Workers 的 fetch 事件处理模式
5. **IP 获取**：使用 CF-Connecting-IP 头获取真实客户端 IP

## 其他注意事项

- 请确保您已经在 Cloudflare 控制台中创建了一个 Worker
- 如果您有自定义域名，请在 Cloudflare 控制台中配置路由
- 建议定期备份 KV 存储中的数据
- 针对生产环境，请使用安全的 ADMIN_TOKEN 值
