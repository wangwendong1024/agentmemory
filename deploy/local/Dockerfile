# 本地源码构建镜像：运行时布局与 deploy/coolify/Dockerfile 完全一致，
# 唯一区别是 agentmemory 包来自本仓库源码（builder 阶段 npm pack 产物），
# 而非 npm registry 发布版。用于部署尚未发布的本地修改。
# 构建上下文必须是仓库根目录：
#   docker build -f deploy/local/Dockerfile .
ARG III_VERSION=0.11.2
# npm 镜像源：默认走 npmmirror（国内网络直连 npmjs 极慢甚至卡死），
# 海外环境构建可传 --build-arg NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM iiidev/iii:${III_VERSION} AS iii-image

# ---- 构建阶段：编译 TypeScript 并打包成 tarball ----
FROM node:22-slim AS builder
ARG NPM_REGISTRY

WORKDIR /build

# 先装依赖再拷源码，让依赖层在源码改动时仍可命中缓存。
# 注意：不能加 --omit=optional —— tsdown 依赖的 rolldown 原生绑定
# (@rolldown/binding-linux-x64-gnu) 就是 optional 依赖，跳过会导致构建失败。
COPY package.json tsconfig.json tsdown.config.ts ./
RUN npm config set registry "${NPM_REGISTRY}" \
 && npm install --no-fund --no-audit

COPY src ./src
COPY plugin ./plugin
COPY iii-config.yaml iii-config.docker.yaml docker-compose.yml .env.example LICENSE README.md AGENTS.md ./
RUN npm run build \
 && npm pack \
 && mv agentmemory-agentmemory-*.tgz /tmp/agentmemory-local.tgz

# ---- 运行阶段：与 coolify 镜像保持一致 ----
FROM node:22-slim

ARG III_VERSION=0.11.2
ARG III_SDK_VERSION=0.11.2
ARG NPM_REGISTRY

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini gosu curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=iii-image /app/iii /usr/local/bin/iii

WORKDIR /opt/agentmemory
COPY --from=builder /tmp/agentmemory-local.tgz /tmp/agentmemory-local.tgz
RUN printf '{"name":"agentmemory-deploy","version":"1.0.0","private":true,"overrides":{"iii-sdk":"%s"}}\n' "${III_SDK_VERSION}" > package.json \
 && npm config set registry "${NPM_REGISTRY}" \
 && npm install /tmp/agentmemory-local.tgz --omit=optional --no-fund --no-audit \
 && rm /tmp/agentmemory-local.tgz \
 && ln -s /opt/agentmemory/node_modules/.bin/agentmemory /usr/local/bin/agentmemory

ENV AGENTMEMORY_III_VERSION=${III_VERSION} \
    TINI_SUBREAPER=1

# 复用 coolify 的 entrypoint：重写 iii-config、chown /data、首启生成 HMAC
COPY --chmod=0755 deploy/coolify/entrypoint.sh /usr/local/bin/agentmemory-entrypoint.sh

EXPOSE 3111

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3111/agentmemory/livez || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentmemory-entrypoint.sh"]
