# 使用官方Deno镜像作为基础镜像
FROM denoland/deno:latest

# 设置工作目录
WORKDIR /app

# 将deno.json和deno.jsonc（如果存在）复制到工作目录，并下载依赖
# 这样可以利用Docker层缓存，如果依赖没有变化，则不需要重新下载
COPY deno.json* ./
RUN deno cache --unstable deno.json

# 复制所有源代码到工作目录
COPY . .

# 暴露应用程序监听的端口
# 您的Deno应用程序在 src/deno_index.ts 中监听的是 8000 端口
EXPOSE 8000

# 运行Deno应用程序
# 使用 --allow-net 和 --allow-read 权限，根据您的应用程序需求添加其他权限
CMD ["deno", "run", "--allow-net", "--allow-read", "--unstable", "src/deno_index.ts"]