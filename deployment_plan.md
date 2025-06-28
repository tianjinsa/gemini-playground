# Cloudflare Worker 部署指南

本指南将详细说明如何将转换后的代码部署到 Cloudflare Worker。

## 1. 安装 Wrangler CLI

Wrangler 是 Cloudflare 官方的命令行工具，用于开发、测试和部署 Worker。

```bash
npm install -g wrangler
```

## 2. 登录 Cloudflare

使用 Wrangler 登录到你的 Cloudflare 账户。这会打开一个浏览器窗口进行认证。

```bash
wrangler login
```

## 3. 配置 `wrangler.toml`

在项目根目录（`d:/code/github/gemini-playground`）下创建一个名为 `wrangler.toml` 的文件，并添加以下配置。请将 `name` 和 `account_id` 替换为你的实际信息。

```toml
name = "your-gemini-proxy-worker" # 你的 Worker 名称，例如：gemini-proxy
main = "src/cloudflare_worker.ts" # 指向你的 Worker 代码文件
compatibility_date = "2024-01-01" # 兼容性日期，建议使用最新日期

# 绑定环境变量
[vars]
SECURITY_ADMIN_TOKEN = "change-this-in-production" # 替换为你的安全管理令牌

# 如果你需要使用 Cloudflare Workers KV 或 R2 存储静态文件，可以在这里配置
# 例如，如果你有一个 KV 命名空间用于静态文件：
# [[kv_namespaces]]
# binding = "STATIC_ASSETS" # 在 Worker 代码中访问 KV 的变量名
# id = "YOUR_KV_NAMESPACE_ID" # 你的 KV 命名空间 ID
```

**重要提示：**
*   `name`: 这是你的 Worker 的名称，它将成为你的 Worker URL 的一部分（例如：`your-gemini-proxy-worker.your-username.workers.dev`）。
*   `main`: 确保指向你创建的 Cloudflare Worker 代码文件路径，即 `src/cloudflare_worker.ts`。
*   `compatibility_date`: 建议使用最新的日期，以确保你的 Worker 使用最新的运行时行为。
*   `SECURITY_ADMIN_TOKEN`: **务必在生产环境中将其替换为强密码或从环境变量中获取。** 在 `wrangler.toml` 中设置 `vars` 部分，Wrangler 会自动将其作为环境变量注入到 Worker 中。

## 4. 部署 Worker

在项目根目录运行以下命令来部署你的 Worker：

```bash
wrangler deploy
```

Wrangler 会将你的 `src/cloudflare_worker.ts` 文件打包并部署到 Cloudflare。部署成功后，你将获得一个 Worker URL。

## 5. Cloudflare Pages 部署设置 (针对前端静态文件)

如果你计划将前端静态文件（如 `index.html`, `css/style.css`, `js/main.js`, `favicon.ico`）部署到 Cloudflare Pages，请参考以下设置：

### 5.1. 创建新 Pages 项目

1.  登录 Cloudflare 仪表板。
2.  导航到 "Pages" (页面) 部分。
3.  点击 "Create a project" (创建项目)。
4.  连接你的 Git 仓库（例如 GitHub）。

### 5.2. 配置构建和部署设置

在 Pages 项目设置界面，你可能会看到以下选项：

*   **为您的应用程序命名 (Project name)**:
    *   输入一个唯一的项目名称。如果提示 "已存在具有该名称的项目。请选择其他名称"，请选择一个不同的名称，例如 `gemini-playground-proxy` 或 `my-gemini-app`。

*   **构建和部署命令 (Build and deployment commands)**:
    *   **构建命令 (Build command)**: 对于纯静态文件，通常不需要构建命令，可以留空。如果你的前端项目需要构建步骤（例如使用 Vite, React, Vue 等），则需要填写相应的构建命令（例如 `npm run build` 或 `yarn build`）。
    *   **部署命令 (Deploy command)**: 对于 Pages 项目，通常不需要手动设置部署命令，Cloudflare Pages 会自动处理。如果你的项目是 Worker，并且你希望通过 Pages 部署 Worker，则可以使用 `npx wrangler deploy`。但对于纯前端静态文件，此项通常留空。

*   **非生产分支 (Non-production branches)**:
    *   **非生产分支部署命令 (Non-production branch deploy command)**: 类似部署命令，通常留空。

*   **根目录 (Root directory)**:
    *   输入你的静态文件所在的根目录路径。如果你的 `index.html` 和其他静态文件直接位于仓库的根目录，则设置为 `/`。如果它们在一个子目录中（例如 `dist` 或 `public`），则设置为相应的路径。

*   **API 令牌 (API Token)**:
    *   如果你需要 Pages 项目与 Cloudflare API 交互（例如，部署 Worker），你可能需要创建一个 API 令牌。点击 "➕ 创建新令牌" 并按照指示操作。通常，对于纯静态 Pages 部署，不需要 API 令牌。

*   **构建变量 (Build variables)**:
    *   如果你需要在构建过程中注入环境变量，可以在这里添加。例如，如果你的前端应用需要知道 Worker 的 URL，你可以在这里设置一个变量，并在前端代码中读取它。
    *   对于 Worker 部署，`SECURITY_ADMIN_TOKEN` 应该在 `wrangler.toml` 的 `[vars]` 部分设置，或者在 Cloudflare Worker 仪表板中手动配置。

## 6. 静态文件处理（CSS, JS, Favicon.ico）

当前转换的代码中，`index.html` 已嵌入到 Worker 中。但是，`favicon.ico` 以及 `index.html` 中引用的 `css/style.css` 和 `js/main.js` 文件目前在 Worker 中会返回 404。

为了正确提供这些静态文件，你有以下几种选择：

### 选项 A: 使用 Cloudflare Pages (推荐)

对于包含 HTML、CSS、JavaScript 和其他静态资源的前端应用，Cloudflare Pages 是一个更好的选择。
1.  将你的前端代码（包括 `index.html`, `css/style.css`, `js/main.js`, `favicon.ico` 等）部署到 Cloudflare Pages。
2.  将你的 Worker 部署为 API 代理，处理 `/v1beta` 和 `/admin/security` 等 API 请求。
3.  在前端代码中，确保 API 请求指向你的 Worker URL。

### 选项 B: 将静态文件打包到 Worker 中 (适用于小文件)

对于非常小的文件，你可以将它们的内容 Base64 编码或直接作为字符串嵌入到 Worker 代码中。
*   **Favicon.ico**: 可以将其内容 Base64 编码后嵌入，并在 `handleRequest` 中返回相应的 `Response`。
*   **CSS/JS**: 如果文件很小，也可以嵌入。但对于较大的文件，这会增加 Worker 的大小和启动时间。

### 选项 C: 使用 Cloudflare Workers KV 或 R2

*   **Cloudflare Workers KV**: 适用于存储小到中等大小的静态文件。你需要将文件上传到 KV 命名空间，并在 Worker 中通过 KV API 读取它们。
*   **Cloudflare R2**: 适用于存储大量或大尺寸的静态文件，提供 S3 兼容的 API。

**当前代码的临时解决方案：**
在 `src/cloudflare_worker.ts` 中，`favicon.ico` 和 `/css/`、`/js/` 路径目前返回 404。你需要根据上述选项选择一个方案来提供这些文件。

完成上述步骤后，你的 Gemini Playground 代理 Worker 应该就能在 Cloudflare 上运行了。