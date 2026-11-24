# OpenMAIC Pro 模式 —— 会话交接文档（Handoff）

> 面向：接续本任务的新会话 / 新同学
> 工程根目录：`d:\AI_APP\openmaic`
> 适用平台：Windows 宿主机 + WSL2(Ubuntu) PostgreSQL

---

## 0. 一句话现状

**Pro 模式已跑通并验证**：一条命令 `pwsh -File scripts/dev-all.ps1` 即可拉起「WSL PostgreSQL → Next.js dev server → 端点自检」整条链路，`/workspace`（Pro 工作台）返回 200。
**但遗留一个未修复的性能问题**：*生成课程很慢*，根因已定位（模型路由落到未注册的 `deepseek-chat` → 输出被 8192 截断 → 同 prompt 重试风暴），**修复方案已给出但尚未落地**（见第 5、6 节）。

---

## 1. 目标

1. 在 Windows 本机开启 OpenMAIC 的 **Pro 模式**（Pro 工作台 + Agent Runtime），数据库使用本机 WSL2 里的 PostgreSQL。
2. 提供 **一条命令** 的启动脚本，把「数据库 + 前后端」一次性拉起并做健康校验。
3. 修复 `/workspace` 无法访问的问题，最终使其稳定可访问。

> 目标 1–3 均已达成并验证。
> 当前新增目标（进行中）：**定位并修复"生成课程很慢"**。

---

## 2. 运行环境与前置条件

| 项 | 值 / 说明 |
|---|---|
| OS | Windows（PowerShell 5.1/7，脚本用 `pwsh`） |
| WSL 发行版 | `Ubuntu`（脚本内硬编码 `$WslDistro = "Ubuntu"`） |
| PostgreSQL | WSL 内 PostgreSQL 16 集群 `16/main`，端口 `5432` |
| DB 账号 | user/pass/db = `openmaic` / `openmaic` / `openmaic` |
| Node / 包管理 | Node（`node -v`）+ `pnpm`（脚本优先用 `pnpm.cmd` shim） |
| 前端端口 | `3000` |
| 框架 | Next.js 16.3.3 / React 19 / Turbopack |
| 版本 | OpenMAIC v1.0.3 |

**注意**：WSL2 的 IP 是动态的（每次重启 WSL 会变）。上一次运行时为 `172.25.203.47`，脚本每次都会重新探测，不要把 IP 写死。

---

## 3. 方案（架构与关键决策）

### 3.1 数据库连通方案：绕开 WSL2 localhost 转发，改走 vEthernet IP

- **问题**：本机 WSL2 的 localhost 端口转发（127.0.0.1 relay）不稳定，导致 Next.js dev server 内出现 `ECONNREFUSED 127.0.0.1:5432`。
- **决策**：放弃 localhost 转发，改为让 PG **监听所有网卡**、Windows **直连 WSL vEthernet IP**。
- **落地**：`scripts/setup-pg-wsl.sh`（需 root，幂等）
  - `listen_addresses = '*'`
  - `pg_hba.conf` 追加 `host all all 172.16.0.0/12 md5`
  - 仅当配置真的变化时才重启集群，否则只确保服务在跑
- **连接串**：`postgres://openmaic:openmaic@<WSL_IP>:5432/openmaic`

### 3.2 dev server 启动方案：进程外（detached）启动

- **问题**：早先 `/workspace` 看似"无法访问"，真因是 **调用方 shell/终端被回收时把 dev server 一起杀掉了**（尽管 Next.js 已打印 Ready）。
- **决策**：用 WMI `Win32_Process.Create` 把 dev server 启动到**当前 shell 进程树之外**。
- **落地**：`scripts/dev-all.ps1`
  - `Start-DetachedDevServer`：以全新 `powershell.exe -Command "& '<pnpm>' dev > dev.log 2> dev.err.log"` 拉起；PID 写入 `logs/dev.pid`
  - `Stop-DevServerOnPort`：按端口找 listener + 记下的 PID，`taskkill /T /F` 清理

### 3.3 端点验证方案：绕过 Windows 系统代理

- **问题**：机器上装了 Clash/VPN 类工具，会往 `HKCU Internet Settings` 写 `ProxyServer`，导致 PowerShell 的 `Invoke-WebRequest/Invoke-RestMethod` 连 **localhost 都失败/超时**。
- **决策**：用 `[System.Net.HttpWebRequest]::Create()` 并显式 `$req.Proxy = $null`（对 127.0.0.1 安全）。
- **落地**：`Invoke-Http` 函数（兼容 PS 5.1）。

### 3.4 关键 `.env.local` 配置（Pro 模式必需）

```
NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=true
OPENMAIC_AGENT_RUNTIME_ENABLED=true
DATABASE_URL=postgres://openmaic:openmaic@<WSL_IP>:5432/openmaic   # 脚本自动同步
MODEL_ROUTES='{"maic-agent-driver":{"model":"deepseek:deepseek-v4-pro","api":"openai-completions"}}'
DEFAULT_MODEL=deepseek:deepseek-v4-pro
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODELS=deepseek-chat,deepseek-reasoner
```

> `scripts/dev-all.ps1` 的 Stage 6 会校验前 4 项，缺失直接 FAIL 退出。

---

## 4. 已完成进展（含验证证据）

### 4.1 交付物

| 文件 | 作用 |
|---|---|
| `scripts/setup-pg-wsl.sh` | WSL 内 PG 配置（监听全网卡 + hba 放行子网），幂等 |
| `scripts/dev-all.ps1` | 一键启动：8 个 Stage，含动态取 WSL IP、进程级覆盖 `DATABASE_URL`、健康校验 |

### 4.2 `dev-all.ps1` 的 8 个 Stage

1. 检查 WSL 发行版存在且可执行
2. 以 root 跑 `setup-pg-wsl.sh`（幂等）
3. 解析 WSL IP → 写 `logs/wsl-ip.txt` → 等 `WSL_IP:5432` TCP 通
4. 用真实 `pg` driver 从 Windows 侧连库，`select count(*) from information_schema.tables`
5. 把 `.env.local` 的 `DATABASE_URL` 同步成当前 WSL IP
6. 校验 Pro 模式必需配置（workbench / runtime / DB / model route）
7. 起 Node + 选择 `pnpm.cmd` → 清端口 → detached 启动 dev server
8. 轮询校验 `/api/health`、`/api/agent/runtime`、`/api/agent/sessions`、`/workspace`

### 4.3 实跑验证结果（8/8 通过）

| 端点 | 结果 |
|---|---|
| `GET /api/health` | `200 {"success":true,"status":"ok","version":"1.0.3"}` |
| `GET /api/agent/runtime` | `200 {"enabled":true,"runtimeEnabled":true}`（Pro runtime ON） |
| `GET /api/agent/sessions` | `200 []`（DB 经 Pro runtime 可达） |
| `GET /workspace` | `200`（Pro 工作台可达） |

- 脚本用法：`pwsh -File scripts/dev-all.ps1`（启动+验证后驻留）/ `-NoWait`（验证后退出）/ `-Stop`（停止）
- **最近一次核对：端口 3000 仍在 LISTEN（pid 26388），服务处于运行中。**
- 日志：`logs/dev.log`（stdout）、`logs/dev.err.log`（stderr）；`logs/dev.err.log` 只有 `instrumentation.ts` 的 Edge Runtime 无害告警。

---

## 5. 未完成 / 待处理

### 5.1 【高优】生成课程很慢 —— 根因已定位，修复未落地

**问题**：用户反馈"生成课程很慢"。

**关键代码结构（供新会话快速上手）**

- 存在两条生成路径：
  - **A. 服务端 Job 路径**：`POST /api/generate-classroom` → Next.js `after()` + 返回 202 + 前端 5s 轮询；编排在 [classroom-generation.ts](file:///d:/AI_APP/openmaic/lib/server/classroom-generation.ts)
  - **B. 浏览器分步路径**：`/api/generate/scene-outlines-stream`、`/api/generate/scene-content`、`/api/generate/scene-actions`，由 `use-scene-generator.ts` 编排（只有 outlines 是流式）
- 所有 LLM 调用统一走 [llm.ts](file:///d:/AI_APP/openmaic/lib/ai/llm.ts) 的 `callLLM` / `streamLLM`
- 服务端场景循环 [classroom-generation.ts](file:///d:/AI_APP/openmaic/lib/server/classroom-generation.ts) L606–L700 是**严格串行** `for (outline of outlines)`，每个场景内先 `content` 再 `actions`（2 次串行 LLM 调用）
- 重试层 `withGenerationRetry`（`DEFAULT_MAX_RETRIES=5`，指数退避）
- 模型解析优先级：**stage route > 客户端 `x-model` > `DEFAULT_MODEL`**（[resolve-model.ts](file:///d:/AI_APP/openmaic/lib/server/resolve-model.ts)）
- 模型目录定义在 [providers.ts](file:///d:/AI_APP/openmaic/lib/ai/providers.ts)；`MODEL_ROUTES` 的合法 stage 白名单在 [model-routes.ts](file:///d:/AI_APP/openmaic/lib/server/model-routes.ts) 的 `LLM_STAGES`
- 用量埋点在 [usage-storage.ts](file:///d:/AI_APP/openmaic/lib/server/usage-storage.ts)，落盘 `data/usage/YYYY-MM.jsonl`（**不是 PG**）

**证据（已核实）**

- `data/usage/2026-09.jsonl` 共 **176** 条：
  - 按模型：`deepseek:deepseek-chat` = **128**、`deepseek:deepseek-v4-pro` = 46、`deepseek:deepseek-v4-flash` = 2
  - 按 source：`scene-content` = 83、`agent-runtime` = 25、`scene-actions` = 23、其余若干
  - 合计 tokens：input 1,344,208 / output 855,370 / reasoning 164,398
- **93 次 scene-content 调用中有 79 次 `outputTokens >= 8190`** → 几乎全部顶到 **8192 硬上限**被截断
- **同 prompt 重试风暴**（相同 `inputTokens` 视为同一 prompt）：
  - `inputTokens=4534` → **30 次**（maxOut 8192）
  - `4504` → **22 次**、`4515` → 12 次、`4516` → 6 次（maxOut 8193）
- `logs/dev.log`：AgentRunner session `38925bf3-…` 在 `10:51:35.438Z` 被 claim，`11:36:10.261Z` 才 succeeded（attempt 1，**26 tool calls**）≈ **44 分 35 秒**；对照：5 tool calls ≈ 1 分 46 秒

**根因链（结论）**

1. 场景/内容生成实际落到 `deepseek:deepseek-chat`，但 **`deepseek-chat` 不在 OpenMAIC 模型目录里**（目录只有 `deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`）→ 命中 fallback 输出上限（表现为 **8192**）
2. 输出被 8192 截断 → 结果被判不完整 → `withGenerationRetry` **反复重试同一 prompt**（最多 30 次，单次约 **25–45s**）→ 单个场景可烧掉 10–20 分钟
3. 叠加服务端场景循环**串行**，总时长线性放大
4. 对照：`deepseek-v4-pro`（目录内，`outputWindow=393216`）产出完整（最高 33,581 tokens 含 reasoning），**不触发截断**

**已排除的干扰项（不是原因）**

- `/api/stages/[id]/freshness`、`/api/agent/sessions/[id]/events`、`/api/agent/owner-events` 返回 50s~55min 的耗时：这些是 **SSE 长连接**（5s 轮询 + 25s 心跳），Next.js 记录的是**连接存活时长而非真实延迟**
- 本地 ComfyUI：**未启用**（`IMAGE_*` 全空、`imageGeneration:false`），媒体阶段是条件执行，不是阻塞项
- 模型路由配置错误：`lib/server/config-validation.ts` 只在启动时**告警**，不会抛错

### 5.2 【安全】明文 API Key

`.env.local` 第 37 行 `DEEPSEEK_API_KEY` 为**明文真实密钥**。建议轮换（rotate）并改用集中式密钥管理，不要提交进版本库。

### 5.3 配置不一致（潜在隐患）

`DEFAULT_MODEL=deepseek:deepseek-v4-pro`，但 `DEEPSEEK_MODELS=deepseek-chat,deepseek-reasoner`（两者互不对应，且后者都不在模型目录里）。这正是 §5.1 根因的来源之一。

---

## 6. 建议的下一步（按优先级）

1. **修复模型路由**（直接对症）：在 `MODEL_ROUTES` 里显式把
   `scene-content` / `scene-content:slide` / `scene-content:quiz` / `scene-content:interactive` / `scene-actions` / `scene-outlines-stream`
   路由到 `deepseek:deepseek-v4-pro`（`outputWindow=393216`）。
   - 合法 stage 名单以 `lib/server/model-routes.ts` 的 `LLM_STAGES` 为准，改错只会告警、静默回退。
2. **修正 `DEEPSEEK_MODELS` / `DEFAULT_MODEL` 不一致**，避免再回落到目录外模型。
3. **验证修复**：清空或另存 `data/usage/2026-09.jsonl` 后重跑一次课程生成，确认：
   - `scene-content` 不再出现 `outputTokens≈8192` 的截断
   - 同 prompt 的重试簇消失（相同 `inputTokens` 不再 ×N）
   - AgentRunner session 的 `claim → succeeded` 时长显著下降
4. **（可选）并行化**：`PARALLEL_SCENE_CONCURRENCY`（注意：`lazyBoundedMap` 目前只被**客户端路径**使用，服务端串行循环需另行改造才有用）。
5. **（可选）降延迟**：DeepSeek provider 的 thinking 默认开启（`defaultEnabled=true`，effort 默认 `high`），会额外产生 reasoning tokens 与延迟；可考虑 `LLM_THINKING_DISABLED`（当前**未设置**）。
6. **安全**：轮换 `.env.local` 中的 DeepSeek 明文密钥。

> 变更点集中在 `d:\AI_APP\openmaic\.env.local`（`MODEL_ROUTES` / `DEEPSEEK_MODELS` / 可选 `LLM_THINKING_DISABLED`）。

---

## 7. 关键文件与命令速查

**脚本 / 配置**
- `scripts/dev-all.ps1` —— 一键启动 + 验证（`-NoWait` / `-Stop`）
- `scripts/setup-pg-wsl.sh` —— WSL PG 配置（幂等，需 root）
- `.env.local` —— Pro 开关 / DB / 模型路由（**改这里**）

**核心代码**
- `lib/server/classroom-generation.ts` —— 服务端生成编排（串行循环 L606–L700）
- `lib/ai/llm.ts` —— 统一 LLM 调用 + usage 埋点
- `lib/ai/providers.ts` —— 模型目录（决定 outputWindow）
- `lib/ai/model-metadata.ts` —— thinking / effort 默认值
- `lib/server/model-routes.ts` —— `LLM_STAGES` 白名单 + stage 解析
- `lib/server/resolve-model.ts` —— 模型解析优先级
- `lib/server/usage-storage.ts` —— 用量落盘（`data/usage/*.jsonl`）
- `lib/server/config-validation.ts` —— 启动期配置校验（仅告警）

**常用命令**
```powershell
# 启动整条栈（含校验）后驻留
pwsh -File scripts/dev-all.ps1

# 只启动+校验，不驻留
pwsh -File scripts/dev-all.ps1 -NoWait

# 停止 dev server
pwsh -File scripts/dev-all.ps1 -Stop

# 查端口占用
Get-NetTCPConnection -LocalPort 3000 -State Listen

# 看日志
Get-Content logs/dev.log -Tail 50
Get-Content logs/dev.err.log -Tail 50
```

---

## 8. 踩过的坑 / 注意事项

1. **不要把 dev server 挂在自己的 shell 下**：shell 被回收会连带杀掉进程 —— 用 WMI detached 启动（脚本已处理）。
2. **localhost 校验会被系统代理污染**：必须用 `WebRequest` + `Proxy=$null`，别用 `Invoke-WebRequest`。
3. **Next.js 日志里的"长耗时"可能是 SSE 存活时长**，不要把它当成接口真实延迟。
4. **WSL IP 会变**：`DATABASE_URL` 每次启动由脚本自动同步；手改后重启 WSL 会失效。
5. **模型不在目录 = 静默降级**：不会报错，只会用 fallback 输出上限（本例 8192），这是本次"慢"的隐藏根源，排查配置时优先看 `providers.ts` 的模型清单。
6. **用量数据在文件里不在 PG**：`data/usage/YYYY-MM.jsonl`，且**没有延迟字段**——只能靠 token 数与 JSONL 的 `createdAt` 间隔反推耗时。
