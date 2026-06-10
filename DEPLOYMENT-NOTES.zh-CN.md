# agentmemory 局域网 + VPN 跨网络部署记录

> 本文档按 **本机实测环境 + 实际部署结果** 生成，作为部署与运维记录。
> 目标：局域网 + VPN 内的所有 AI agent，围绕「某个文件夹项目」的上下文集中同步，
> 通过 MCP 读取；Docker 部署、数据映射到宿主机硬盘、Git 仓库备份、可快速迁移。
>
> 生成日期：2026-06-10 ｜ 适用主机：本机（见下方环境快照）

---

## ✅ 实际部署状态（已落地并验证）

| 项 | 实际值 |
|---|---|
| 部署方式 | 仓库根 `docker-compose.yml`（已改）＋ `deploy/coolify/Dockerfile` 自建镜像 |
| 镜像内容 | `node:22-slim` + `@agentmemory/agentmemory@0.9.27` + iii 引擎二进制 0.11.2 |
| 容器名 | `agentmemory-agentmemory-1` |
| 数据目录（宿主机） | `/Users/hackintosh/agentmemory/data` |
| 对外端口 | `0.0.0.0:3111`（局域网 + VPN 双平面） |
| **鉴权密钥** | `<AGENTMEMORY_SECRET>` |
| 密钥来源 | 容器首次启动由 entrypoint 自动生成，持久化在 `/data/.hmac`（chmod 600） |
| 快照备份 | 已开启（`SNAPSHOT_ENABLED=true`，`/data/snapshots`） |
| 嵌入 | `EMBEDDING_PROVIDER=local`（本地，免费离线） |

**三网络平面验证结果（2026-06-10 实测，从宿主机自测）：**

| 平面 | 地址 | `/livez`（公开探针） | `/profile` 无密钥 | `/profile` 带密钥 |
|---|---|---|---|---|
| 本机 loopback | `127.0.0.1:3111` | ✅ 200 | 401 | ✅ 200 |
| 局域网 en3 | `192.168.22.59:3111` | ✅ 200 | 401 | ✅ 200 |
| VPN utun2 | `172.16.0.34:3111` | ✅ 200 | 401 | ✅ 200 |

- macOS 应用防火墙：**已关闭**（不拦入站 3111）。
- 监听：`*:3111 (LISTEN)`（Docker 在所有网卡监听）。
- ⚠️ 上表是**从宿主机用各网卡 IP 自测**；要确认对面机器可达，须在对面机器上 `curl`（见第 9 节）。
- ⚠️ 设了密钥后 `/agentmemory/health` 也会返回 401；真正的**公开存活探针是 `/agentmemory/livez`**。

---

## 0. 本机环境快照（实测）

| 项目 | 实测值 | 说明 |
|---|---|---|
| 操作系统 | macOS 11.7.10 (Big Sur) | BuildVersion 20G1427 |
| CPU 架构 | **x86_64 (Intel)** | 拉镜像须用 `linux/amd64`，非 arm64 |
| Node.js | v22.22.0 | 满足 `>=20` 要求 |
| npm | 8.19.4 | |
| Docker | 20.10.21 | ✅ 满足部署需求 |
| Docker Compose | v2.13.0 | 用 `docker compose`（v2 子命令） |
| git | 2.49.0 | ✅ 用于快照备份 |
| iii-engine | **未安装** | → 因此走 **Docker 部署路线**（本文档主线） |
| 当前用户 | `hackintosh` | HOME=`/Users/hackintosh` |
| 仓库 origin | `https://github.com/wangwendong1024/agentmemory.git` | 你自己的 fork，可改源码 |
| 当前分支 | `myAgentmemory` | |
| 端口 3111/3113 | 空闲 | 无冲突 |

### 网络平面（关键）

| 接口 | 地址 | 角色 | 网段 |
|---|---|---|---|
| `en3` | `192.168.22.59` | 局域网主网卡 | `192.168.22.0/24` |
| `utun2` | `172.16.0.34` | **VPN 隧道**（点对点） | `172.16.0.0/22` |
| `utun0/1/3` | — | 其它隧道 | — |
| `lo0` | `127.0.0.1` | 回环 | — |

> ⚠️ 本机同时挂在「局域网 192.168.22.x」和「VPN 172.16.x」两个平面上。
> 服务绑定 `0.0.0.0:3111` 即可被两个平面同时访问。

---

## 1. ⚠️ 头号坑：mesh 同步拒绝私网/VPN 网段

agentmemory 自带的实例间 P2P 同步 `mesh-sync`，在注册和同步时都会调用 `isAllowedUrl`，
其中 `isPrivateIP` 会**主动拒绝**以下地址（见 `src/functions/mesh.ts:19-30`）：

```ts
function isPrivateIP(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;   // ← 172.16-31 全拦
  ...
}
```

**直接后果（针对本机）：**
- 局域网 `192.168.22.x` → 被 `192.168.` 规则拦死。
- VPN `172.16.0.34` → 被 `172.16` 规则拦死。

**所以 mesh-sync 默认对你两个网络都不可用。** 跨 VPN 同步必须从下面三套方案里选，
而**不是**直接用 mesh。

---

## 2. 方案选型（先决定走哪条路）

先厘清你的真实拓扑属于哪一种：

- **拓扑甲｜多站点共享同一份记忆**：所有 agent（本地 + VPN 对面）都读写**同一台**中心服务器。
- **拓扑乙｜各站点独立、彼此互相同步**：每个 VPN 站点各跑一台服务器，站点之间双向同步上下文。

| 方案 | 适用拓扑 | 是否改源码 | 实时性 | 同步范围 | 推荐度 |
|---|---|---|---|---|---|
| **A 单中心服务器** | 甲 | 否 | 实时（强一致） | 全量共享 | ⭐⭐⭐ 首选 |
| **B Git 仓库中转** | 乙 | 否 | 分钟级（定时） | 全量快照 | ⭐⭐ 稳妥兜底 |
| **C 放开 mesh 私网限制** | 乙 | 是（本机 fork 可改） | 准实时 | 增量 LWW 合并 | ⭐ 进阶 |

**给你的建议：**
- 如果各 VPN 站点的 agent **可以接受访问同一台中心机**（VPN 路由打通即可）→ **直接用方案 A，零改造、强一致**，根本不需要"同步"。
- 如果要求**每个站点本地都有一份、互不依赖对方在线** → 日常用 **方案 B（git 中转）**；要准实时再上 **方案 C**。

> 当前本机已按**方案 A（单中心服务器）**部署完成（见顶部「实际部署状态」）。

---

## 3. 部署（Docker，数据映射到宿主机硬盘）—— 实际采用方案

### 3.0 为什么不用纯 `iiidev/iii` 引擎镜像（踩坑记录）

最初尝试用仓库自带的「纯引擎镜像 + 挂载 `iii-config.docker.yaml`」方案，结果：

- 引擎本身能起来（`API listening on 0.0.0.0:3111`），但 **`/agentmemory/*` 业务路由全部 404**。
- 原因：`iiidev/iii` 是 distroless 纯引擎镜像，**不包含 agentmemory 的代码**；
  而 `iii-config.docker.yaml` 里的 `iii-exec` worker 想执行 `node dist/index.mjs`，
  该镜像里既没有 Node 运行时也没有 agentmemory 的 `dist/`，business worker 注册不上。
- 日志特征：`Watcher failed: No path was found`、`DO NOT USE IN_MEMORY STORE_METHOD`。

**结论：那套 compose 是给"挂载源码的开发场景"用的，不能直接拿来做 LAN/VPN 服务。**
要自包含可用，必须用 `deploy/coolify/Dockerfile` 构建一个把 agentmemory 代码 + 引擎二进制
都打进去的镜像。本机最终采用此方案。

### 3.1 实际的 `docker-compose.yml`（仓库根目录，已改写）

```yaml
services:
  # 自包含 agentmemory 服务：基于 deploy/coolify/Dockerfile 构建。
  # 该镜像 = node:22-slim + npm 安装 @agentmemory/agentmemory + 复制 iii 引擎二进制。
  # 容器内 entrypoint 会：①把 iii config 重写为绑定 0.0.0.0 + 绝对 /data 路径；
  # ②chown /data 给运行用户；③首次启动生成 HMAC 密钥写入 /data/.hmac 并打印一次。
  agentmemory:
    build:
      context: ./deploy/coolify
      dockerfile: Dockerfile
      args:
        AGENTMEMORY_VERSION: "0.9.27"   # 锁定当前最新发布版
        III_VERSION: "0.11.2"           # 引擎锁 0.11.2，勿升级
        III_SDK_VERSION: "0.11.2"
    platform: linux/amd64               # 本机 Intel x86_64
    restart: unless-stopped
    ports:
      # 3111 暴露到所有网卡：同时服务局域网(192.168.22.59)和 VPN(172.16.0.34)
      - "0.0.0.0:3111:3111"
    environment:
      SNAPSHOT_ENABLED: "true"          # 内置 git 快照备份
      SNAPSHOT_DIR: "/data/snapshots"   # 落到映射卷，宿主机可直接 git push
      EMBEDDING_PROVIDER: "local"       # 本地向量嵌入(免费/离线)
      # 密钥由 entrypoint 首次启动自动生成到 /data/.hmac 并打印一次。
      # 如需固定密钥：在 /Users/hackintosh/agentmemory/data/.hmac 写入自定义值(chmod 600)。
    volumes:
      - /Users/hackintosh/agentmemory/data:/data   # 数据映射到宿主机硬盘
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:3111/agentmemory/livez || exit 1"]
      interval: 30s
      timeout: 5s
      start_period: 40s
      retries: 3
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

> 注：本方案**不需要** `iii-init` chown 容器——`deploy/coolify/entrypoint.sh` 会以 root 启动，
> 自行 `chown /data` 后再用 gosu 降权运行，已覆盖权限问题。

### 3.2 实际的构建与启动命令

```bash
# macOS / Bash —— 脚本统一加 set -euo pipefail
set -euo pipefail

mkdir -p /Users/hackintosh/agentmemory/data
cd /Users/hackintosh/Documents/workspace/agentmemory   # 仓库根目录(compose 所在)

docker compose build      # 首次：npm 装 agentmemory + 打包镜像(约 1-2 分钟)
docker compose up -d

# 抓取首次自动生成的密钥（只打印一次，之后从 /data/.hmac 读）
docker compose logs agentmemory 2>&1 | grep "AGENTMEMORY_SECRET="
cat /Users/hackintosh/agentmemory/data/.hmac

# 健康检查（注意：设密钥后用 livez，不是 health）
curl -fsS http://127.0.0.1:3111/agentmemory/livez      # 本机
curl -fsS http://192.168.22.59:3111/agentmemory/livez  # 局域网
curl -fsS http://172.16.0.34:3111/agentmemory/livez    # VPN
```

> **构建期 DNS 坑（已遇到）**：拉 `node:22-slim` 时 `auth.docker.io` 可能被 DNS 污染解析到
> 无效地址（如 `69.63.176.59`）导致 i/o timeout。解决：单独 `docker pull --platform linux/amd64 node:22-slim`
> 重试到成功（正常应解析到 `108.160.166.142` 这类地址），再 `docker compose build`。

宿主机 `/Users/hackintosh/agentmemory/data` 下即全部数据：
- `state_store.db` —— 主状态库（会话/记忆/图谱/向量索引）
- `stream_store/` —— 流数据
- `snapshots/` —— 内置 git 快照仓库（见第 6 节）
- `.hmac` —— 自动生成的鉴权密钥（chmod 600）

---

## 4. 各 Agent 通过 MCP 接入

所有 agent 使用同一个 MCP 入口；区别只是 `AGENTMEMORY_URL` 指向哪个平面的地址，
密钥统一用本机实际生成的那个。

| Agent 所在位置 | `AGENTMEMORY_URL` |
|---|---|
| 本机 / 局域网内 | `http://192.168.22.59:3111` |
| VPN 对面网络 | `http://172.16.0.34:3111` |

Cursor 示例（写进对应机器的 `~/.cursor/mcp.json`，与现有 `mcpServers` 合并、勿覆盖整个文件）：

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["-y", "@agentmemory/mcp"],
      "env": {
        "AGENTMEMORY_URL": "http://172.16.0.34:3111",
        "AGENTMEMORY_SECRET": "<AGENTMEMORY_SECRET>"
      }
    }
  }
}
```

> - 局域网 agent 把 `AGENTMEMORY_URL` 换成 `http://192.168.22.59:3111`，密钥相同。
> - 连得上服务器才会暴露全部 53 个工具；连不上只剩 7 个本地工具——务必先确认 URL 可达。
> - 沙箱化 MCP 客户端（Flatpak/Snap/严格容器）若访问不到，额外加 `"AGENTMEMORY_FORCE_PROXY": "1"`。
> - 「某个文件夹项目」对应记忆里的 `project` 字段；**多端用同一个 project 名**才能共享同一项目上下文。

---

## 5. 跨 VPN 同步方案详解

### 方案 A：单中心服务器（首选，零改造，强一致）★ 当前已采用

- 只在本机（或某一台）跑第 3 节那一台 agentmemory。
- 局域网 agent 走 `192.168.22.59:3111`，VPN 对面 agent 走 `172.16.0.34:3111`。
- 数据只有一份 → 天然实时一致，**不存在"同步"问题**。
- 前提：VPN 路由已打通，对面能 ping 通 `172.16.0.34` 且放行 3111。

> 这是最省事、最不容易出错的方案。除非你明确需要"每个站点本地各存一份"，否则直接用 A。

### 方案 B：Git 仓库中转（不改源码，跨任意网络）

每个 VPN 站点各跑一台服务器；用**内置 git 快照** + **一个共享 Git 远端仓库**做中转。
git over HTTPS 不受 `isPrivateIP` 限制，能穿透任何网络。

**机制：** A 站定时 `snapshot-create`（把状态写成 `state.json` 并本地 commit）→ 宿主机 `git push` 到远端；
B 站 `git pull` → `snapshot-restore` 回灌。

#### B-1 触发快照（任一端，定时）

```bash
# macOS / Bash
set -euo pipefail
curl -fsS -X POST http://127.0.0.1:3111/agentmemory/snapshot-create \
  -H "Authorization: Bearer <AGENTMEMORY_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"message":"auto snapshot"}'
```

#### B-2 推送脚本（宿主机执行，操作映射出来的快照目录）

```bash
#!/usr/bin/env bash
# /Users/hackintosh/agentmemory/sync-push.sh
# 用途：把本站快照推送到共享远端仓库
set -euo pipefail

snap_dir="/Users/hackintosh/agentmemory/data/snapshots"
cd "$snap_dir"

# 首次绑定远端（仅执行一次）：
# git remote add backup https://github.com/wangwendong1024/agentmemory-context-backup.git

git push backup HEAD:main
```

#### B-3 拉取并还原脚本（对面站点执行）

```bash
#!/usr/bin/env bash
# 对面站点：拉取共享快照并回灌进本地实例
set -euo pipefail

snap_dir="<对面站点>/agentmemory/data/snapshots"
cd "$snap_dir"
git pull backup main

# 取最新 commit hash 并还原
commit="$(git rev-parse HEAD)"
curl -fsS -X POST http://127.0.0.1:3111/agentmemory/snapshot-restore \
  -H "Authorization: Bearer <对面密钥>" \
  -H "Content-Type: application/json" \
  -d "{\"commitHash\":\"$commit\"}"
```

#### B-4 定时（crontab，每 10 分钟一次）

```cron
# A 站：每 10 分钟生成并推送
*/10 * * * * /Users/hackintosh/agentmemory/sync-push.sh >> /tmp/am-sync.log 2>&1
```

> 注意：`snapshot-restore` 是**覆盖式回灌**（按 id `kv.set`），适合"单向主→从"或"低频对账"。
> 双向都在写、要冲突自动合并的，请用方案 C。

### 方案 C：放开 mesh 私网限制（进阶，准实时双向 LWW 同步）

只有当你需要**两端都在写、且要按时间戳自动合并（Last-Write-Wins）**时才上这套。
因为是你自己的 fork（`wangwendong1024/agentmemory`），可以直接改源码。

**改动点：** `src/functions/mesh.ts` 的 `isPrivateIP`，加一个环境变量开关，
在显式开启时放行 VPN 网段。建议改成（示意，部署时再实际落地）：

```ts
function isPrivateIP(ip: string): boolean {
  // 显式允许内网/VPN 互联（仅在受信任的 VPN 内开启）
  if (process.env["AGENTMEMORY_MESH_ALLOW_PRIVATE"] === "true") return false;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // ... 其余不变
}
```

**配套步骤：**
1. 改完源码 `npm run build`，把 `dist/` 一起打进镜像（修改 `deploy/coolify/Dockerfile`
   改为 `COPY` 本地构建产物，而非 `npm install` 线上发布版）。
2. 两端容器都设 `AGENTMEMORY_MESH_ALLOW_PRIVATE=true` 和 `AGENTMEMORY_SECRET`（mesh 强制要密钥）。
3. 互相注册 peer（用 MCP 工具 `memory_mesh_sync`，或 REST）：
   - 本机注册对面：`url=http://<对面VPN_IP>:3111`
   - 对面注册本机：`url=http://172.16.0.34:3111`
4. 触发 `mesh-sync`（`direction: "both"`），按 `updatedAt` 做 LWW 增量合并。

> ⚠️ 安全：放开私网限制等于让 mesh 信任内网地址，**只能在你完全可信的 VPN 内开启**，
> 且两端必须设强 `AGENTMEMORY_SECRET`。不要在开放网络开这个开关。

---

## 6. Git 备份（内置功能）

- 实现：`src/functions/snapshot.ts`，把全状态序列化成 **`state.json`（结构化、可 diff）** 后 `git commit`。
- 已通过 `SNAPSHOT_ENABLED=true` + `SNAPSHOT_DIR=/data/snapshots` 开启。
- 它**只本地 commit、不 push**，push 由宿主机脚本完成（见 5-B-2）。
- 触发：MCP 工具 `memory_snapshot_create`，或 `POST /agentmemory/snapshot-create`。
- 还原：MCP 工具 / `POST /agentmemory/snapshot-restore`（按 commitHash）。

> 不要直接 git 提交 `state_store.db`：它是单文件型 KV，几乎整文件变化，diff 无意义、仓库膨胀。
> 走内置 `state.json` 快照才是正确的 git 备份路径。

---

## 7. 迁移 / 灾备（三层兜底）

| 层级 | 手段 | 适用 |
|---|---|---|
| 1 | 中心服务器模型（方案 A） | 换机/加 agent 只改 `AGENTMEMORY_URL`，零迁移 |
| 2 | `tar` 整个 `/data` | 整机搬迁 |
| 3 | REST `export`/`import` 或 `snapshot-restore` | 逻辑级 / 跨版本 |

整机搬迁（第 2 层）：

```bash
# macOS / Bash —— 旧机停服打包
set -euo pipefail
cd /Users/hackintosh/Documents/workspace/agentmemory
docker compose down
tar czf am-data.tgz -C /Users/hackintosh/agentmemory/data .

# 新机解包后起服(coolify entrypoint 会自动 chown /data，无需手动)
tar xzf am-data.tgz -C <新机>/agentmemory/data
docker compose up -d
```

逻辑级（第 3 层）：

```bash
SECRET="<AGENTMEMORY_SECRET>"
# 导出
curl -fsS http://OLD:3111/agentmemory/export -H "Authorization: Bearer $SECRET" > backup.json
# 导入
curl -fsS -X POST http://NEW:3111/agentmemory/import -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" --data-binary @backup.json
```

> 提示：迁移后密钥仍在 `/data/.hmac` 里，随 `tar` 一起搬走，新机密钥不变。

---

## 8. 坑位清单（本机相关，已逐条核对源码 + 实测）

1. **纯引擎镜像跑不起业务**：`iiidev/iii` 不含 agentmemory 代码，`/agentmemory/*` 全 404 →
   必须用 `deploy/coolify/Dockerfile` 自建自包含镜像（**已采用**，见 3.0）。
2. **mesh 拒私网**：`192.168.x` 和 VPN `172.16.x` 默认都被拦 → 跨网同步用方案 A/B/C，别裸用 mesh。
3. **端口绑定**：官方 compose 绑 `127.0.0.1`，外部访问不到 → 已改 `0.0.0.0:3111`。
4. **公开探针是 `/livez`**：设了 `AGENTMEMORY_SECRET` 后 `/health` 也会 401；健康检查/可达性测试用 `/livez`。
5. **鉴权**：暴露到局域网/VPN 后必须带密钥（真实值见 `/data/.hmac`，**不入库**），所有 agent 同一个。
6. **/data 属主**：coolify entrypoint 以 root 启动自行 chown 后降权，已覆盖；本方案无需 `iii-init`。
7. **架构**：本机是 **Intel x86_64**，compose 已加 `platform: linux/amd64`，别拉 arm64 镜像。
8. **构建期 DNS 污染**：`auth.docker.io` 可能被污染到无效 IP → 单独 `docker pull node:22-slim` 重试。
9. **中文检索（当前未装）**：BM25 默认不切中文词，需要 `@node-rs/jieba`；
   coolify Dockerfile 用 `--omit=optional` **不装它**。中文项目建议改 Dockerfile 加
   `npm install @node-rs/jieba tiny-segmenter` 后重建镜像。
10. **向量召回**：当前 `EMBEDDING_PROVIDER=local`（免费离线）；不配 key 也能跑（BM25-only）。
11. **LLM 压缩默认关闭**：未配 `ANTHROPIC_API_KEY` 等，压缩/摘要走 no-op（安全默认）。
    需要 LLM 压缩再配 provider key + `AGENTMEMORY_AUTO_COMPRESS=true`。
12. **引擎版本**：锁死 `iiidev/iii:0.11.2`，勿升 0.11.6+（未适配新 sandbox 模型，会 EPIPE / 存了搜不到）。
13. **viewer (3113)**：容器内绑 loopback 且无鉴权，当前未对外映射；想看走 SSH 隧道，别直接对网络开放。
14. **VPN 稳定性**：`utun2` 是点对点隧道，VPN 断线时对面 agent 会连不上中心机；
    若要求站点离线可用，优先方案 B（各站点本地有副本）。

---

## 9. 上线验证 Checklist

- [x] `docker compose up -d` 后三个平面 `/livez` 全部 200（**已验证**，从宿主机自测）。
- [x] 鉴权链路正常：无密钥 401、带密钥 200（**已验证**）。
- [x] macOS 防火墙关闭、`*:3111` 监听（**已验证**）。
- [ ] **在对面机器实测**：局域网机 `curl http://192.168.22.59:3111/agentmemory/livez`、
      VPN 对面机 `curl http://172.16.0.34:3111/agentmemory/livez` 均 200。
- [ ] 一台局域网 agent + 一台 VPN agent 都能在 MCP 里看到 53 个工具。
- [ ] 两端用**同一个 project 名**，A 端 `memory_save` 的内容 B 端 `memory_smart_search` 能搜到。
- [ ] `SNAPSHOT_ENABLED` 生效：`/data/snapshots` 下有 `.git` 且 `state.json` 在更新。
- [ ] 宿主机 `sync-push.sh` 能成功 push 到远端备份仓库。
- [ ] 演练一次 `tar /data` → 新目录恢复，数据完整。
- [ ] （若用方案 C）两端 `mesh-sync` 返回 `pushed/pulled > 0`，无 "private/local address" 报错。

---

## 10. 常用运维命令

```bash
cd /Users/hackintosh/Documents/workspace/agentmemory
docker compose ps                   # 查看状态
docker compose logs -f agentmemory  # 跟随日志
docker compose restart              # 重启
docker compose down                 # 停止(数据保留在宿主机 /Users/hackintosh/agentmemory/data)
docker compose up -d --build        # 改了 Dockerfile/源码后重建并起

# 改了 AGENTMEMORY_VERSION 等 build args 后强制重建
docker compose build --no-cache && docker compose up -d
```

---

_本记录由实测本机环境 + 实际部署结果生成；如更换主机或 VPN 网段，请同步更新第 0 节参数与密钥。_
