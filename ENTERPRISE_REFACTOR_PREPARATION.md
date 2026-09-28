# 企业级重构实施准备记录

日期：2026-09-23
关联计划：[ENTERPRISE_REFACTOR_PLAN.md](./ENTERPRISE_REFACTOR_PLAN.md)
状态：第一批身份贯通与读越权修复已实施；异步任务与媒体/导出入口审计已完成且继续 fail-closed，完整第一阶段仍在推进。

## 1. 工作区保护与现有实现归类

当前工作区有未提交内容，实施前必须保留，不执行 reset、clean、覆盖或自动提交。

### 与企业认证直接相关的现有改动

- `.env.example`、`instrumentation.ts`、`middleware.ts`、`package.json`、`pnpm-lock.yaml`
- `app/api/auth/*`、`lib/server/auth/*`
- `migrations/0001_enterprise_identity.sql`
- `scripts/migrate-database.mjs`、`scripts/provision-enterprise-user.mjs`
- `tests/server/auth-config.test.ts`、`tests/server/auth-flow.test.ts`、`tests/persistence/enterprise-identity-migration.test.ts`
- `ENTERPRISE_AUTH.md`、`ENTERPRISE_ROUTE_INVENTORY.md`、`scripts/audit-enterprise-routes.mjs`

### 需单独确认归属的现有工作

`HANDOFF.md`、`scripts/dev-all.ps1`、`scripts/setup-pg-wsl.sh` 描述本机 Pro/WSL PostgreSQL 与生成性能工作。它们不属于本次认证实现范围，应保留并避免顺手重构。

实施前应逐文件审查认证相关改动并记录接受、修改或延期；不能把“工作区已有”误当成“已验证可发布”。

## 2. 已核实的基线事实

- OIDC 登录、回调、session、logout 路由及配置、flow state、OIDC discovery、内部身份建立和数据库会话已有初步实现。
- `OPENMAIC_AUTH_MODE` 默认为 legacy；选择 OIDC 时 middleware 允许健康与认证入口，对其他业务路径统一返回 503。这是安全的暂时门控，应在授权接通前保留。
- 当前数据库迁移建立 `app_users`、`external_identities`、`tenants`、`tenant_memberships`、`auth_sessions`，并给 `stage_meta` 增加 `tenant_id`。迁移将既有课程归入 `default`，不认领匿名数据。
- 用户预置工具和自动 provisioning 开关已有初步设计；自动 provisioning 默认关闭。身份映射使用 `(issuer, subject)`，应用用户使用内部 ID。
- 应用会话 JWT 有数据库会话记录，并检查会话是否撤销、用户状态和活跃成员关系。
- 认证测试文件和迁移测试文件已存在；本次准备审查未运行测试，也未连接或变更数据库。
- 路由盘点当前报告 73 个 API route handlers、90 个显式导出 HTTP 方法，并搜集了带 `use server` 的文件。

## 3. 实施前必须处理的安全与架构门槛

### P0：固定 tenant 选择规则

当前会话查询联接所有活跃成员关系，按 tenant ID 排序后取第一条。用户若属于多个租户，会被隐式分配到排序靠前的租户。

**第一阶段建议**：只允许 `default` 租户；会话解析显式要求该租户的活跃成员资格。以后开放多租户时，再增加明确的 tenant 选择与逐请求成员校验。不要保留隐式排序选择。

### P0：贯穿业务身份前保持 503 门控

认证路由建立会话不代表业务入口已使用会话。目前 middleware 的 fail-closed 503 门控必须保持，直到路由策略清单中每个要开放的入口都能解析可信会话并执行资源授权。

### P0：公开课程与 OIDC 只读例外

当前 `/api/stages/[id]/status` 的注释明确称仅凭 stage ID 即可读取发布状态；响应包含 `isPublic` 与 `publishedAt`。这会暴露私有课程元数据。`stage-meta` 等旁路也需按相同规则审计。

**第一阶段建议**：公开课程继续可匿名查看，但只通过窄化的公开读取入口开放；入口必须验证课程已发布、未删除，并只返回公开页面所需内容。所有管理状态、私有元数据和写操作要求 owner/授权成员身份。OIDC middleware 只对白名单中的公开读取操作放行，不能按整个路由前缀放行。

需进一步在路由盘点中逐项列明匿名公开读路径、响应字段和底层资源校验方式，未列明的默认关闭。

### P0：写请求 CSRF 策略

检索未发现覆盖业务写请求的统一 CSRF/Origin helper；当前可见的显式 Origin 校验主要在 logout。会话依赖浏览器 Cookie，开放任何 OIDC 写路由前必须有一致的防护。

**第一阶段建议**：对 OIDC cookie-auth 的所有非安全方法统一校验 `Origin` 与配置的 `APP_ORIGIN`；按部署与客户端模式处理缺失 Origin 的情况，明确允许的机器客户端认证方式。`SameSite=Lax` 作为纵深防御，不替代服务端校验。Server Actions 也需纳入 Next.js Origin/Host 行为审查。

### P1：路由盘点器只能用于覆盖检查

现有脚本按源码字符串识别 owner helper 和路由类型，不能证明授权正确；输出策略是路由级，不是方法级。Server Actions 只列出文件，未细分导出函数和每个 action 的身份边界。

实施前应增强或补充人工清单，使其能逐个 HTTP 方法/action 记录认证、资源授权、公开例外、费用风险和验收用例。静态盘点结果不作为安全通过证明。

### P1：多租户边界尚未覆盖全部存储

当前迁移把 `tenant_id` 加到 `stage_meta`，而 document store 与多种关联存储已有各自 owner 键。该状态支持“为课程建立默认租户边界”的起点，不等于所有资料、Agent 数据、资产和后台任务都具备多租户隔离。

第一阶段按单一 default tenant 定义范围；任何对外多租户承诺前，应补齐所有表、查询、唯一索引、后台任务和文件引用的租户边界。

### P1：匿名认领须保持独立

登录回调不得执行跨表迁移。若本阶段不实现认领，必须在发布说明中明确：登录后匿名旧数据仍按原匿名身份保存，需后续单独认领或迁移。若纳入认领，则先完成来源证明、显式用户确认、冲突矩阵、并发控制、审计和恢复设计。

## 4. 推荐采用的第一阶段决策

以下为实施基线建议；若产品范围不变，按此落地：

- 范围：多用户、单一受控 `default` tenant，不宣传完整多租户。
- 主体：`(issuer, subject)` 映射到内部用户 ID；email 不用于身份合并或授权。
- 授权角色：应用数据库成员关系为准；IdP role claim 不直接授予应用权限。
- provisioning：默认手动预置；自动创建维持关闭。
- ACCESS_CODE：仅服务 legacy 部署；OIDC 模式不允许它绕过用户身份与业务授权。
- public：仅显式发布的课程允许匿名只读，范围限于经过盘点的公开视图；私有状态和管理操作均要求身份。
- anonymous claim：推迟到独立增量，不阻断登录，不在 callback 执行。
- logout：应用本地会话撤销和 cookie 清理为必需；IdP SSO logout 若不实现，文档必须明确其不会被本地注销清除。
- session：沿用数据库可撤销会话和现有短 TTL；无 refresh 时需验证 Keycloak SSO 重登体验。密钥轮换需定义兼容窗口和 `kid` 处理策略。
- CSRF：OIDC Cookie 写请求统一执行同源 Origin 校验，并对缺失 Origin 的调用类型给出显式策略。

## 5. 推荐实施顺序与进入条件

### 准备 A：改动审查

逐一审查本记录第 1 节的认证相关未提交文件，列出缺陷和采用的实现。完成前不改写已有认证骨架。

### 准备 B：策略矩阵

为所有 API 方法及 Server Actions 逐项填写身份、tenant、owner、公开读、CSRF 和费用策略。公开例外必须精确到方法与响应数据。

### 准备 C：数据边界表

盘点 owner/tenant 存储表、关联表、索引、读写路径和任务队列；标记阶段 1 覆盖范围与后续多租户工作。

### 准备 D：本地验证环境

准备隔离的 Keycloak 开发 realm、人工预置测试用户、独立测试数据库及可重置数据。检查迁移的前置表结构、备份和回滚步骤。不得对生产数据库做准备性试迁移。

### 进入实现的门槛

只有以下条件全部满足才打开任何业务路径：

- 多租户选择和 public 读取政策已固定。
- OIDC mutation 的 CSRF 处理方案已确定。
- 每个拟开放 API 方法/action 都有具体授权策略与对应验证用例。
- 认证实现审查完成，迁移可在隔离数据库中应用和恢复。
- 所有其余业务路由仍受 fail-closed 门控。

## 6. 执行状态（2026-09-23）

### 已完成的第一批实现

- 建立 auth-aware owner 解析：legacy 保留匿名 owner；OIDC 必须解析有效的数据库会话，并将内部用户 ID 作为 owner；失效会话、数据库故障、viewer 写入和跨源写请求均失败关闭。
- 将 OIDC 会话解析接入课程、场景、manifest、status、freshness、stage-meta、agent SSE 和 persistence 等已列入白名单的入口；Server Action 也执行同一身份、角色和 Origin 边界。
- Agent `existingCourse` session 创建必须能解析到未删除且归当前 owner 的课程；仅知道 ID 或课程公开不允许建立可操作该课程的 agent session。
- 将 session 成员关系固定到 `default` tenant，取消按租户 ID 排序后隐式选租户。
- 修复文档存储、stage metadata 和 status 的 owner/public 读取边界；公开读取仍要求资源显式公开，写入始终要求 owner。
- persistence OIDC 请求从服务端会话导出 learner identity；资产上传采用用户 principal，读取要求本人 principal 或匹配活跃公开课程引用；替换、删除和未盘点子路径继续拒绝。
- middleware 只放行已接入身份解析的路由与有限公开 GET；未审查业务 API 仍返回 503。匿名旧数据不自动认领。
- 增加身份解析、Edge token 校验、middleware 门控、owner-read 策略和 existing-course owner 检查的测试；路由清单现按 HTTP method 记录 OIDC 门控。
- 将 OIDC middleware 的 owner API 门控收紧为已审查的精确路径与 HTTP 方法；未来新增子路由或方法默认返回 503，不再继承父路径的放行资格。

### 已完成验证

- 聚焦 Vitest：30 个直接相关测试文件、337 项通过，覆盖 API 授权边界、session 创建、迁移、legacy/OIDC 身份、会话 token、middleware、文档及资产访问策略和 persistence 路由。
- `node scripts/audit-enterprise-routes.mjs`：成功生成 73 个 API handler、90 个 HTTP 方法的清单。
- `pnpm exec tsc --noEmit --pretty false`：通过。
- 对本轮变更的 TypeScript 文件运行聚焦 ESLint：通过。
- `git diff --check`：通过。
- Prettier 对本批可识别代码和 Markdown 文件检查/格式化：通过；`.env.example` 没有可识别 parser，因此未交由 Prettier 改写。
- 初次宽范围运行的两个问题已解决：Node 模拟浏览器 bootstrap 测试补上 `/api/auth/session` 响应；Vitest 默认 worker 限为 2，避免 PPTX 等重型测试并发耗尽内存。随后 `tests/agent-runtime` 与 `tests/persistence` 完整运行通过：101 个文件中 93 个通过、8 个跳过；1164 项通过、29 项跳过。
- 本轮精确 OIDC 路由门控回归：11 个授权相关测试文件、151 项通过；其中 middleware、request-owner 与 SSE 路由的最后回归为 4 个文件、36 项通过。
- OIDC 登录流程、配置、Edge session 校验与身份迁移回归：4 个测试文件、11 项通过；未启动外部 Keycloak 或应用数据库迁移。
- 隔离 PostgreSQL 18 演练历史：在专用 Docker 测试库用仓库 migrator 验证缺少旧 `stage_meta` 时事务回滚、补表后迁移成功、幂等重跑和迁移前备份恢复。该历史测试库与 `.env.local` 中的 `127.0.0.1:5432/openmaic` 完全分离；测试口令未写入仓库。
- 2026-09-24 配额迁移复验：专用隔离库 `openmaic_enterprise_test` 确认为 PostgreSQL 18.6；迁移前只有 0001。先创建了迁移前 custom-format `pg_dump`，随后从只读仓库挂载的临时 Node runner 调用仓库 `scripts/migrate-database.mjs`，首次成功应用 0002，紧接着第二次运行无变更成功。只读 SQL 核对显示 0001/0002 名称与校验和、三张配额表，以及 `llm/token/utc_calendar_month/1000000000` 策略种子均正确。服务随后再次进入启动阶段；基于该备份的临时 restore-clone 复核在创建 clone 前被数据库拒绝连接，未对原库造成额外变更。PG18 历史备份恢复演练仍按上一条记载。后续 PG16.15 隔离演练现已覆盖 0001/0002/0003 schema、备份恢复、0003 事务失败回滚和用户限流并发边界。
- 2026-09-24 PostgreSQL 16.15 隔离演练：使用与 compose 同为 PG16 主版本的临时 `postgres:16-alpine` 容器，无宿主机端口映射。缺少 `stage_meta` 时实际 migrator 失败，检查确认 `app_users` 和 0001 版本记录都未残留；补入与旧部署一致的 `stage_meta` fixture 后 0001、0002 和连续重跑均成功，legacy stage 被分配到 `default`，策略值为每 UTC 月 1,000,000,000 token。0001 状态的 custom-format 备份恢复到隔离 clone 后只存在 0001；在 clone 上制造 0002 中段表冲突，确认 quota policy DDL 与 0002 记录整笔回滚，移除冲突后再次迁移成功。临时容器、clone 和备份文件均已清理；未连接生产/开发数据库。
- 隔离 Keycloak 配置验证：曾使用官方 `keycloak/keycloak:26.7.4` 容器导入 `openmaic-enterprise-test` realm；在该实例可用期间，通过 discovery 和 Admin API 确认 issuer、confidential client `openmaic-web`、授权码流程、PKCE S256、启用且邮箱已验证的 `oidc-test-user`，并校验客户端密钥与临时配置一致。合成用户 subject 与 `OIDC_ISSUER` 仅写入用户 Temp 目录测试 env 文件，密钥未写入仓库。
- OIDC 真实浏览器端到端验证：在独立测试数据库 `openmaic_enterprise_test`、隔离 Keycloak realm `openmaic-enterprise-test` 和测试账户上，使用 Playwright + 已安装 Chromium 完成完整授权码/PKCE 流程。验证访客 session → Keycloak 登录及首次资料确认 → callback 创建 `authenticated/member` 应用 session → 应用 logout 返回 204 并撤销 session → session 恢复 `guest`。测试应用、数据库和 Keycloak 均为本机隔离实例；Windows Node 进程通过临时 WSL TCP 转发连接测试数据库。Playwright CLI 下载因 npm TLS 重置未完成，因此使用项目现有 Playwright API 和 Chromium 驱动真实浏览器；未修改 `.env.local`、防火墙或 `.wslconfig`，未连接生产/开发数据库。测试账户首次登录要求 `VERIFY_PROFILE`，已在隔离 realm 中提交合成姓名后继续完成验证。
- 个人用量读取边界：`tests/usage/route.test.ts`、`tests/server/usage-storage.test.ts`、`tests/server/usage-attribution.test.ts`、`tests/server/middleware-oidc.test.ts` 共 4 个测试文件、24 项通过；覆盖 owner 精确过滤、排除无归属旧记录、忽略客户端 owner 参数、个人用量 no-store、legacy 视图兼容及精确 OIDC method/path 门控。最新 TypeScript、聚焦 ESLint、Prettier 与 `git diff --check` 均通过。改动后的 usage API 未再做浏览器端在线冒烟：该次重试时临时 WSL/Docker 服务已停止，单元及 middleware 回归已覆盖本次新增边界。
- 最新 `pnpm exec tsc --noEmit --pretty false`、聚焦 ESLint、Prettier 与 `git diff --check` 均通过。

### 仍待完成

- 已完成当前 OIDC 放行面的一轮 owner 数据路径审计：Agent session/SSE、session materials、owner materials、user skills、folders、stage/document 及 persistence assets。各 HTTP 入口从共享服务端 owner/session 边界取身份；逐资源读取、写入或事件查询都使用 owner 或已验证的父 session。对应 SSE 和 owner 分区在存储层按 `owner_id` / `session_id` 过滤。
- 该审计确认 tenant 隔离目前只由登录会话强制限定在 `default` tenant；`owner_material`、agent session/material 和 user skill 等表没有 `tenant_id`。这足够支撑受控单 tenant 阶段，不构成完整多租户隔离；开放第二个 tenant 前必须给这些资源和异步任务补 tenant 约束及复合查询边界。
- 已完成尚未开放的异步 worker、媒体/导出任务及附件引用审计。课堂生成 job JSON 和新写入 classroom 文件都持久记录服务端解析的 owner/tenant；轮询隐藏不匹配主体的 job，runner 的状态更新逐次核对 owner/tenant，后台 LLM usage 也在 worker 内显式绑定到任务主体。classroom-media 的 Node handler 对 OIDC 用户核对 classroom owner/tenant 并返回 `private, no-store`；遗留无 owner classroom 不会被 OIDC 用户接管。视频导出代理仍按 render job ID 查询、取消或下载上游任务，应用侧未持久绑定用户和租户。`/extract-document`、`/parse-pdf` 和 `/transcription` 是同步请求/响应处理，没有后台 job 状态、worker 轮询、取消或结果下载生命周期；其中 `/extract-document` 已接入身份与 asset-id owner 检查，`/parse-pdf` 已接入数据库 session、Origin、非 viewer 身份边界和私有响应；两路由的费用/用量限流、上传上限与 provider 网络边界仍未闭环。代理媒体和其他生成入口同样没有完整的身份、费用和资源授权策略。
- 上述路由和媒体入口在 OIDC middleware 精确 allowlist 外，均由 middleware 返回 503；本轮为课堂读取/媒体、生成和轮询 job、同步文档抽取、媒体代理、视频导出提交/轮询/取消/下载补充了带有效应用 session 的 503 回归断言。课堂提交、job 状态和媒体文件现在具备 owner/tenant 数据关联及 Node 层检查；`/api/classroom GET` 已加入本人同 tenant 的 Node 授权、跨 owner/tenant 统一 404 和 `private, no-store`，但跨 owner 的公开发布语义仍待验收，所以 middleware 继续 503。任务多实例一致性和其余异步任务类型仍未完成；异步组需补齐取消、下载、附件引用和完整生命周期后才能开放。同步抽取路由没有 job 生命周期，但仍须补齐身份、费用归属和资源策略。不可预测 ID 不作为授权机制；媒体缓存的 `public, immutable` 也不能替代授权，OIDC 媒体响应已改为 `private, no-store`。
- OIDC 已支持用户级资产分区和公开课程引用读取；旧 `shared` 资产仅在仍公开的 legacy anonymous 课程引用时可匿名读取。资产替换、删除以及跨 principal 的引用授权保持关闭。
- PostgreSQL 18 与 16.15 隔离环境均已验证迁移、失败回滚、幂等重跑和备份恢复路径；隔离 Keycloak realm/client/user 通过 discovery、Admin API 和浏览器 OIDC 登录/登出验证。完整证据见“已完成验证”。没有配置现有 Keycloak，也没有连接生产/开发数据库。
- 生产部署回滚与密钥轮换清单见下文；生产配置、生产密钥轮换与真实上线回滚仍未执行。
- Agent runtime 中经 `callLLM` / `streamLLM` 的 OIDC 请求已实施每人每 UTC 月 10 亿 token 配额；`/api/verify-model POST` 现使用同一 owner-scoped quota。0002 配额迁移和 0003 用户 API 限流迁移已在隔离库验证，但须受控部署后才能启用依赖它们的生产流量。直接生成 API、image/video 生成与其他付费模态额度仍未接通，相关路由保持 503。AliDocMind PDF verify handler 已完成身份、限流、网络与净化边界，0005 已通过隔离 PG16.15 正式 migrator、失败回滚、修复重试与幂等演练；PDF middleware 仍 503。图片/视频 verifier 已验收并精确开放 POST：仅 BYOK OpenRouter `/key` GET，不生成；其他 provider 仍拒绝。`POST /api/provider/probe-models` 另用 BYOK 和 5 次/用户/60 秒限流；legacy 匿名 owner 不获开放。
- 异步任务 owner/tenant 生命周期授权、匿名旧数据认领、完整 RBAC 与完整多租户仍延期。OIDC 未授权路由返回 503 是计划内门控。
- 本轮没有切换 ACCESS_CODE/OIDC，也没有触碰生产环境。

### 6.1 追加执行（2026-09-23）：用量归属写入侧 + flaky 测试修复

对既有工作区先跑验证门，发现并修复 `tests/server/auth-flow.test.ts` 的偶发失败：原用例篡改 JWE 认证 tag 的末位 base64url 字符，该字符含 4 个无效低位、约 1/4 概率解回原字节而绕过 GCM，且 `sealed` 含 `Date.now()` 每次密文变化 → 间歇红。改为篡改密文中段字符（`a↔b` 必改解密字节），实现本身未动（属测试缺陷）。修复后认证/访问回归 11 文件 51 项在默认并发与串行下均稳定通过；`tsc`、ESLint、Prettier、`git diff --check` 全绿。

按选定增量"用量归属先行"完成 usage **写入侧**归属；之后依据已确认的个人范围开放受限读取：

- 新增请求/执行级归属上下文 `lib/server/usage-attribution.ts`（`AsyncLocalStorage`，仿 `thinking-context` 的 globalThis 单例）；`recordUsage` 在任意 `await` 之前**同步**读取归属，`UsageRecord` 增加可选 `ownerId`/`tenantId`，仅来自服务端解析、绝不取自客户端。
- 两处边界注入归属：HTTP `withRequestOwnerId` 用已复核的会话 owner（OIDC 带 `session.tenantId`，legacy `anon:` 无 tenant）包裹 handler；detached runner 在 `runSession` 调用点用 `meta.ownerId` 建立自身作用域（后台执行不在请求链内）。`attributionForOwner` 把 `user:` 前缀映射到受控 `default` 租户。
- OIDC 下 `/api/usage` 由 `withRequestOwnerId` 复核数据库 session，再按服务端 ownerId 过滤；其他用户和旧未归属行不参与聚合，响应不回显逐行归属且设置 `Cache-Control: no-store`。legacy 部署级视图保持兼容。Agent runtime 的统一 LLM 调用边界已有并发安全的个人月额度预留/结算；付费直接生成路由仍保持 503。
- 验证：新增 `tests/server/usage-attribution.test.ts`（7 项：OIDC 归属、legacy 无 tenant、无上下文不归属、fire-and-forget 捕获、跨 await 作用域、`attributionForOwner` 派生）；连同 usage-storage/normalize/route 与认证回归 14 文件 68 项全绿；`tsc`/ESLint/Prettier/`git diff --check` 通过。未重跑完整 runner 套件（改动为行为中性的 ALS 包裹，按最小验证范围处理）。

## 7. 当前安全与产品边界

- OIDC 会话的 Edge JWT 检查只用于门控；拥有业务数据的 Node handlers 仍从数据库复核会话、用户状态和 `default` 成员资格。
- OIDC 下仅开放清单列出的资源路由、个人用量 `GET /api/usage`、受控 BYOK `POST /api/provider/probe-models`、`POST /api/verify-image-provider` 与 `POST /api/verify-video-provider`，以及 `POST /api/verify-model`；图片/视频 verifier 只调用固定 OpenRouter `/key` GET，owner、逐用户限流和 DNS-pinned transport 由 handler 校验。公开 GET 候选仍需资源当前公开、未删除。直接生成、其他 provider verify、tenant usage 汇总、视频任务以及其他未审查 API 返回 503。
- OIDC 资产 POST 使用用户 principal；GET/HEAD 只允许本人资产或当前公开课程所引用且 principal 匹配的资产；PUT/DELETE 和私有跨 owner 读取拒绝。
- legacy 模式保留匿名 owner 隔离及既有公开访问兼容；企业身份不会自动接管 `anon:` 数据。
- 当前只支持受控 `default` tenant；不要把此阶段描述为完整多租户。应用本地 logout 会撤销本地 session，不清除 Keycloak SSO 会话。

## 8. 后续执行顺序

1. **已完成**：审计尚未开放的异步 worker、媒体/导出任务及附件引用 owner/tenant 查询；所有缺少身份贯穿的入口保持 503，精确路径和方法 allowlist 有回归测试。
2. **已完成：隔离环境 OIDC 与迁移验证**：Keycloak 浏览器登录/退出及 PostgreSQL 18、16.15 上的迁移、失败回滚、幂等重跑和备份恢复路径均已验证；整个过程没有连接生产环境。
3. **进行中**：OIDC agent runtime 和 `/api/verify-model POST` 的每用户 LLM 月配额已实现并通过迁移验证，不再列作延期。当前已完成 handler、但仍需用户关键验收的准入节点是 `/api/azure-voices POST`（只读 voice-list）、`/api/verify-pdf-provider POST`（AliDocMind 轻量状态查询）和 `/api/classroom GET`（owner-only 与同 tenant 已发布读取语义）；未收到相应验收前继续 503。已验收的 image/video verifier 仅精确开放 POST。之后按单一路由组补齐直接生成、同步抽取及其它模态的身份、资源归属、用量策略和回归，再评估异步任务；未完成节点继续 fail-closed。
4. 为未来启用异步 extraction、媒体和导出任务单独设计 owner/tenant 持久模型及生命周期授权；已完成的 session materials、SSE、资产引用和本轮 fail-closed 审计作为回归基线保留。
5. **进行中**：按下文清单推进受控部署准备、密钥轮换方案和回滚演练；生产侧操作仍需单独发布窗口与关键验收。完成后再进入匿名认领与完整多租户的独立计划。

### 8.1 受控部署与回滚清单（不代表已执行生产变更）

迁移 `0002_personal_llm_monthly_quota.sql` 新增个人 LLM 配额表，`0003_user_api_rate_limits.sql` 新增用户 API 固定窗口限流表，`0004_azure_voices_rate_limit.sql`、`0005_pdf_provider_verify_rate_limit.sql`、`0007_verify_image_provider_rate_limit.sql` 和 `0008_verify_video_provider_rate_limit.sql` 扩展限流 route key CHECK，`0006_personal_media_quota.sql` 新增 image/video/TTS 个人额度策略与 reservation 表；0006 种入 image 每 UTC 月 2,000 张、video 3,600 秒、TTS 2,000,000 字符的试点值，尚待产品验收；ASR 额度未定义，依赖媒体额度的生成路由继续关闭。**0006 SQL 注释中的 “Confirmed balanced pilot” 与当前验收状态不符；该迁移已进入迁移序列，不得为改注释而改写 SQL/checksum。额度获批后如需调整种子值，应通过新的向前迁移，并在获批前继续关闭相关生成路由。**0007–0008 已在隔离 PostgreSQL 16.15 上以正式 migrator 完成应用、迁移前备份恢复到 clone、route key 正反向检查与幂等重跑演练。以上迁移均为向后兼容的结构变更。仓库 migrator 使用版本号/校验和、advisory lock，并逐迁移事务执行。不要在应用启动时自动迁移。升级按以下顺序执行：

课堂生成任务的新 owner/tenant 字段写入现有 JSON job 文件，没有回填旧文件的自动归属方案。发布包含此改动的版本前，需先停止提交并排空旧 job；无法证明 owner 的遗留 job 应继续不可读取，不能根据 job ID 或当前 cookie 推断归属。

1. **前置确认**：记录应用版本、数据库版本和目标环境；验证连接目标确为预期环境，隔离演练不得复用 `.env.local` 的数据库。PG16 主版本隔离演练已完成；若实际生产不是 PostgreSQL 16，还需在目标主版本复跑。
2. **备份**：在维护窗口前创建带时间戳的数据库备份，记录文件大小与 `pg_dump` 退出码；将备份放到受控存储，并在隔离数据库完成恢复抽查。仅有备份文件而未恢复验证不算通过。
3. **预检与迁移**：确认当前 schema_migrations 版本/校验和与发布预期一致；从本次发布的精确 Git tag/commit checkout，在独立受控 release runner 中用仓库锁定的 Node/pnpm 版本运行 `pnpm db:migrate`，并通过部署密钥注入已二次核对目标的 `DATABASE_URL`。Dockerfile 的 production `runner` stage 只复制 Next standalone/static，不包含 `scripts/migrate-database.mjs` 和 `migrations/`；不得假设可在 app runtime image 内执行迁移。日志须留存迁移版本与结果，不得记录连接串/凭证。若迁移报错，逐迁移事务应回滚；停止发布并在隔离副本检查，不手工标记迁移成功。
4. **数据库验收**：检查版本 0001–0008 各有一条正确校验和记录；核对 `personal_usage_quota_policies` 中 `llm/token/utc_calendar_month/1000000000` 恰有一条，`personal_media_quota_policies` 三项策略值与已记录的产品验收一致。当前 image/video/TTS 试点值尚未验收，因此不得据此开放相关生成路由；ASR 尚无额度策略。确认 LLM 与媒体额度/月计数/reservation 表的主外键、检查约束和部分索引，以及 `user_api_rate_limits` 用户外键和包含 `azure_voices`、`verify_pdf_provider`、`verify_image_provider`、`verify_video_provider` 的 route key 检查约束存在。重复执行 migrator 应为无变更成功。
5. **应用发布**：先部署兼容该 schema 的版本并保持 `OPENMAIC_AUTH_MODE=legacy`；完成 preview 冒烟后，再通过受控配置逐步启用 OIDC。检查登录/登出、配额 reservation 与 settlement、用量页面、已开放的 BYOK probe、LLM verify、图片/视频只读 verifier 身份/限流/SSRF/quota 边界，以及其余未开放生成路由仍返回 503；观察认证拒绝、数据库错误和配额拒绝指标。
6. **应用回滚**：若新应用异常，切回前一应用版本并关闭 OIDC 流量。迁移只新增或扩展结构，通常保留 schema 即可回滚应用；不要仅为回滚代码自动删表或收窄 route key 约束。只有数据损坏等需恢复数据库的事件才从已验证备份/PITR 恢复，并先评估迁移后写入的数据损失、暂停写入和恢复点，再按事故流程执行。
7. **密钥轮换**：OIDC client secret、`OPENMAIC_SESSION_SIGNING_KEY` 与 `OPENMAIC_OIDC_FLOW_KEY` 使用独立高熵随机值，经密钥管理系统注入，不进入仓库、日志或镜像。轮换前验证备用密钥/回退值和部署传播范围；client secret 按 IdP 与应用协调切换。当前 session JWT 固定使用 `kid: v1` 且仅接受单一签名密钥，没有双 key 验签窗口；轮换 `OPENMAIC_SESSION_SIGNING_KEY` 会让已有应用 session 失效，应安排全量重新登录窗口，禁止假定可无缝轮换。轮换 flow key 会使待完成的 OIDC 登录流程 state 无法解封，安排短暂登录重试窗口。轮换后验证 callback、已有/新会话和 logout，并撤销旧密钥。
8. **关闭条件**：迁移版本/校验和不符、备份恢复未验证、PostgreSQL 主版本不匹配、Keycloak 配置未核验、异常率上升或回滚路径未演练时，不扩大 OIDC 流量；保留全局 503 fail-closed 路由门控。

### 8.2 Server Actions 逐操作授权核对

全仓实际 `'use server'` 指令扫描（`app`、`components`、`lib`、`packages`，排除依赖及构建目录）只找到 `lib/workbench/workspace-actions.ts`；其他字符串命中为普通模块内容或 API route。路由审计生成器使用相同源码根目录持续收集 Server Action 模块。该模块当前导出一个 action：

| Action | 身份与请求来源 | 资源授权 | 结论/缺口 |
| --- | --- | --- | --- |
| `deleteWorkspaceSession(id)` | OIDC 从请求头解析数据库-backed session，并要求 Origin 精确匹配 `APP_ORIGIN`；缺失/失效 session fail-closed；viewer 拒绝。legacy 使用校验后的匿名 cookie | 先解析 owner，再验证输入并将服务端 ownerId 传给 `softDeleteSession(sessionId, ownerId)`；存储层 SQL 同时匹配 `id`、`owner_id` 和未删除状态 | 唯一 Server Action 已逐操作覆盖；回归包含 Origin/session/unavailable/viewer、空输入仍鉴权、legacy cookie 和 foreign/missing owner 结果。新增 Server Action 必须逐项登记，不能只凭 `'use server'` 文件级判断 |

路由盘点中原“待人工定案”共五项，已逐项拆成可执行策略：`/azure-voices POST` 已实现 BYOK 语音目录读取、数据库 session/非 viewer 授权、5 次/用户/60 秒限流、请求/响应上限和固定公网 DNS 连接；该查询不生成音频。0001–0006 已在隔离 PG16.15 通过正式 migrator、route-key 检查及备份恢复演练；OIDC gate 暂保持 503，等待关键验收。classroom media 按持久 owner/tenant 绑定和私有缓存校验；ComfyUI workflow 列表要求数据库复核 session（含 viewer 只读）并仅列 `public/` 文件名/展示名；`/server-providers` 的响应字段已核验，并接入 session 复核和 no-store；`/skills/:id` 所有下载要求应用 session，内置技能对已认证主体可用、用户技能按 owner 授权。`/provider/probe-models POST` 是 BYOK、非 viewer、5 次/用户/60 秒；`/verify-model POST` 使用 owner-scoped `callLLM` 月配额和同等逐用户限流，BYOK 走严格公网 SSRF/DNS pinning，server-managed endpoint 按操作员网络策略；响应不返回模型生成文本。AliDocMind PDF verify handler 现要求数据库 session/非 viewer、每用户 5 次/60 秒；BYOK 固定公网 DNS，managed endpoint 按操作员 `ALLOW_LOCAL_NETWORKS` 策略；只做不提交解析任务的状态查询，响应不回显 provider 错误。OIDC 下其它 PDF provider 仍 503；migration 0005 的 PG16.15 正式 migrator、备份恢复、失败原子回滚、修复重试及幂等演练均通过；route middleware gate 仍关闭，待关键验收。图片/视频 verifier 仅 OpenRouter BYOK 固定 `/key` GET，已有 5 次/用户/60 秒、严格 DNS pinning 和上游 body 丢弃；用户于 2026-09-24 验收后仅精确 POST 接入 OIDC middleware。图像/视频生成型探测和其余未满足前置条件的路由继续保持 503。

### 8.3 2026-09-24 已完成节点

| 节点 | 实现/决定 | 验证 |
| --- | --- | --- |
| PostgreSQL 16 配额迁移演练 | 在临时 PG16.15 容器完整演练 0001/0002，不映射宿主端口；演练缺少旧表失败、修复前置结构、幂等重跑、迁移前备份恢复及 0002 中段失败事务回滚。 | 全部通过，PG16.15 容器、runner、恢复 clone 和备份均清理；未连接生产/开发库。 |
| `/api/server-providers GET` | 仅该精确 GET 接入 OIDC gate 和 Node 层 `withRequestOwnerId` 数据库 session 复核；允许 active `viewer` 只读；响应设 `private, no-store` 并保留 owner headers。getter 字段为 provider IDs、模型 allowlist、disabled 标记和并发上限，不含 API key、base URL、proxy。其他方法继续 503。 | 新增 handler、viewer、no-store、敏感字段和错误路径回归；middleware 精确 path/method 回归；123 项相关测试、全量 TypeScript、聚焦 ESLint、Prettier、route audit（73 handlers/90 methods）和 `git diff --check` 均通过。 |
| `/api/comfyui-workflows GET` | 仅该精确 GET 接入 OIDC gate 和 Node 层数据库 session 复核；active viewer 可读；仅返回 `public/` 中匹配的文件名和展示名，不返回 JSON 内容；响应 `private, no-store`。其他方法仍为 503。 | 与 `/api/server-providers` 联合回归 5 个测试文件、125 项通过；全量 TypeScript、聚焦 ESLint、Prettier、route audit（73 handlers/90 methods）和 `git diff --check` 通过。覆盖成功/异常、owner headers、no-store、未登录 401 和不支持方法 503。 |
| PostgreSQL 16 配额迁移演练 | 在临时 PG16.15 容器完整演练 0001/0002；新增 0003 两个限流 route key 后，再用隔离 PG16.15 验证 0003 事务应用、迁移前备份恢复、冲突失败不留部分 DDL/版本记录，以及 20 个并发限流请求。容器无宿主端口映射。 | 前两项迁移沿用完整 migrator 演练记录；0003 隔离 SQL 演练与 PGlite migration 测试通过；并发固定窗口 5/20 仅放行 5 次、计数为 5，过期窗口重置为 1；临时容器、clone 与备份均清理。未连接生产/开发库。 |
| `/api/provider/probe-models POST` | 精确 POST 接入 OIDC gate 和 `withRequestOwnerId` 数据库 session、成员资格及 Origin 复核；viewer 被写操作边界拒绝，legacy 匿名 owner 不作为个人主体。仅允许已登录用户自己的 BYOK key；PostgreSQL 固定窗口限流为 5 次/60 秒，DB 不可用 fail-closed；拒绝本地/私网目标并以 DNS pinning 约束实际连接，拒绝重定向；请求体最多 16 KiB，上游成功响应最多 256 KiB；只返回稳定错误，不回显密钥、URL 或上游错误内容。无 owner 任务状态。其他方法继续 503。 | 定向验证 8 个文件 127 项测试通过，覆盖路由、OIDC gate/session/viewer/Origin、SSRF、响应超时和 migration；全量 TypeScript、聚焦 ESLint、Prettier、route audit 和 `git diff --check` 通过。PG16.15 隔离库验证迁移和并发限流。 |
| `/api/verify-model POST` | 精确 POST 接入 OIDC 数据库 session、成员资格和 Origin；viewer 与 legacy 匿名主体拒绝。单次最多生成 32 个输出 token，30 秒超时；owner-scoped `callLLM` 使用现有个人 UTC 月 LLM 配额；PostgreSQL 5 次/用户/60 秒限流。BYOK custom URL 必须通过严格公网 SSRF 校验，全部请求与重定向 DNS pinning；仅 operator policy 可为 server-managed provider 开启内网。配置了自定义 proxy 的 provider 暂不开放，避免请求绕过已验证的目标连接策略。上游响应最多 1 MiB，响应不返回生成内容，错误不回显 provider 内容/URL/key。其他方法继续 503。 | 新增路由、transport、限流 route key 和 middleware allowlist；跨路由聚焦回归 13 个文件、141 项通过，覆盖身份/限流/配额调用/managed 与 BYOK 网络策略/请求和响应体上限/proxy fail-closed/错误净化；全量 TypeScript、聚焦 ESLint、Prettier、route audit 和 `git diff --check` 通过。 |
| 路由盘点准确性 | 复核已开放的 `/api/usage GET` 时，发现生成器把它误报为 503，虽然 middleware 与 handler 已精确开放。补充该路径的 session/owner gate 描述；其余实际未开放入口仍保持 503。 | 重新生成清单并核对 route table rows：`/usage GET` 记录数据库 session 与当前用户归属，找不到任何路由表行残留“待人工定案”；未改变运行时路由策略。 |
| 课堂生成任务 owner/tenant 绑定 | `POST /api/generate-classroom` 通过统一身份边界取得 owner/tenant 并原子写入 job JSON；worker 所有状态更新和 `GET /api/generate-classroom/:jobId` 都按同一 owner/tenant 检查。worker 内部重新建立 usage attribution，避免 Next `after()` 的上下文传播假设。 | 7 个定向文件、31 项测试通过，覆盖同 owner、跨 owner/tenant 隐藏、worker 更新隔离、匿名 owner 分区、身份必填、job ID 冲突、usage attribution、trusted tenant context、poll 响应净化及 OIDC gate 503；TypeScript、聚焦 ESLint、Prettier 通过。结果 classroom 文件和媒体尚未绑定，因此未开放路由。 |
| classroom 文件及媒体 owner/tenant 绑定 | 课堂直写与后台生成都只接收服务端解析的 identity，并将 owner/tenant 写入 reserve 与最终 classroom JSON。OIDC media GET 先读 classroom 文件确认 owner/tenant，再打开媒体文件；命中 owner 路径时对成功和失败响应都设 `private, no-store`。legacy 媒体读取行为保持兼容；缺归属的旧文件不会由 OIDC 用户自动认领。 | 8 个相关测试文件、56 项通过，覆盖身份写入、跨用户/租户 404、响应缓存边界、旧媒体读取兼容、文件/job ID 碰撞与 OIDC 503 门控；TypeScript、ESLint、Prettier 和 `git diff --check` 通过。`/api/classroom GET` 与课堂/媒体 OIDC gate 仍保持 503。 |
| `/api/export-video/capability GET` | 只报告渲染服务 `enabled`/`accepting`，不含服务地址、job 数据或凭据；要求有效签名应用会话，读取范围非用户特定。状态、取消、下载不会因此开放。 | 2 个定向文件、13 项测试通过：handler 能力/health/异常/超时用例，以及 OIDC middleware 有效会话 200、无会话 401、POST 及其它 export 方法 503。TypeScript、ESLint、Prettier 和 `git diff --check` 通过。 |
| `/api/azure-voices POST` handler（OIDC gate 未开放） | 纯 BYOK voice-list 查询，不提交 TTS 生成；要求数据库-backed `user:` 主体与非 viewer 写操作会话边界。PostgreSQL 固定窗口每用户 5 次/60 秒；请求 16 KiB、key 8 KiB、URL 2 KiB；仅 HTTPS，拒绝 URL 凭证/query/hash；DNS 在连接时固定到公网地址，逐跳校验重定向并跨域剥离凭证；响应最多 1 MiB，provider/JSON/网络错误不回显上游内容，响应 `private, no-store`。速率库不可用则 503。 | 5 个定向文件、22 项测试通过，覆盖成功/响应兼容、anonymous owner、无效 URL/key、413、用户限流/DB 故障、上游错误净化、DNS pinning/响应上限 transport、route-key migration 和 OIDC gate 503；全量 TypeScript、聚焦 ESLint、Prettier 通过。隔离 PG16.15 正式 migrator 应用 0001–0004，验证 route key、未知 key 拒绝及备份恢复；临时数据库/网络均清理。OIDC gate 继续关闭，待关键验收。 |
| 状态记录与路由策略一致性 | 修正异步任务表中已过期的 classroom owner/tenant 描述；同步更新路由审计生成器对 classroom job、生成文件和媒体读取现状的策略说明。视频导出及其余异步任务仍未绑定 owner/tenant，相关入口继续 503。 | 重新生成路由清单为 73 routes / 90 methods；检视 classroom 行反映现有归属校验，export 提交/状态/取消/下载均报告 OIDC 503；Server Actions 专项 8 项与 middleware 4 项回归通过；无路由策略残留“待人工定案”。 |
| 图片/视频/PDF 供应商验证策略审计 | 逐项检查 connectivity probe 的实际上游操作。图像 Seedream/Qwen/Grok/MiniMax 和视频 Grok/旧版 MiniMax 探测会向 generation endpoint 提交 POST；PDF 探测不上传待解析文件，但访问用户或服务器指定 endpoint。 | 视频生成型 probe 保持 503。图片/视频 OIDC handler 仅接受 OpenRouter BYOK 固定 `/key` GET，5 次/用户/60 秒、严格 DNS pinning、拒绝重定向、丢弃响应；用户验收后仅精确 middleware POST 已开放。PDF verify 已有专用 AliDocMind OIDC handler，但 middleware gate 继续 503。 |
| AliDocMind PDF 凭证验证 transport | 给 AliDocMind 的 verify-only SDK client 替换底层 HTTP transport，同时复用安装版本的 SDK SPI 签名、endpoint resolution 与响应解码；仅允许 HTTPS 公网目标、连接时 DNS pinning、无重定向、30 秒超时、1 MiB 响应上限；每次请求结束关闭 dispatcher。不改变 PDF/媒体解析路径。 | 新增 transport 回归覆盖实际 ACS4 签名 header、strict dispatcher、重定向拒绝、响应上限与资源关闭；AliDocMind verify 定向 11 项测试、ESLint、全量 TypeScript 通过。更新 route audit 后仍为 73 routes / 90 methods，`POST /verify-pdf-provider` 继续 OIDC 503；其余身份/限流/managed endpoint 网络策略/错误净化/成本策略尚未完成。 |
| `/api/verify-pdf-provider POST` OIDC handler（middleware gate 保持关闭） | OIDC 下仅开放代码路径给 AliDocMind：trusted user session、Origin 与非 viewer 由 owner boundary 校验；每人 5 次/60 秒；请求最多 16 KiB；BYOK strict public SSRF + DNS pinning；managed credentials/baseUrl 只取服务端，private/custom port 仅在 operator `ALLOW_LOCAL_NETWORKS` 下；安全状态查询不提交解析任务；1 MiB 上游响应上限及错误净化。其它 PDF providers 在 OIDC 下拒绝；legacy 分支保留原行为。 | handler 策略/错误/managed-key 隔离回归通过；新增 `0005_pdf_provider_verify_rate_limit.sql`，PGlite 与 PG16.15 正式 migrator 演练通过；该 POST 仍未加入 middleware allowlist，继续 503。 |
| PDF verify 路由组授权与限流实施 | OIDC 分支仅执行 AliDocMind 轻量状态查询，不提交解析/生成任务；逐用户 5 次/60 秒固定窗口；输入 16 KiB 上限；BYOK 使用严格公网 SSRF 预检及连接时 pinning；托管凭证只从服务端取，并遵循 operator `ALLOW_LOCAL_NETWORKS`；响应 `private, no-store`，上游错误不返回客户端。其它 PDF provider OIDC 分支统一 503，legacy 分支保持现有路径。 | 6 个定向测试文件 34 项通过，覆盖 handler、用户限流、middleware 503、ACS4 transport、输入边界、私有目标、server credential 隔离和错误净化；0005 PGlite 2 项和媒体额度 PGlite 10 项通过；ESLint、全量 TypeScript、Prettier、route audit 与 `git diff --check` 通过，清单 73 routes / 90 methods。PG16.15 隔离正式 migrator 已应用 0001–0006，覆盖迁移前备份恢复 clone、0005 故障回滚及修复重试、有效/未知 route key 和连续幂等重跑。middleware 未加入 PDF 路由，OIDC 实际仍返回 503。 |
| `/api/verify-image-provider POST` OIDC 只读验证切片 | 对每个请求要求数据库-backed `user:` owner，拒绝 anonymous；仅接受客户端 BYOK 的 `openrouter-image` key，不使用服务器托管 key；向固定 `https://openrouter.ai/api/v1/key` 发 HTTPS GET，拒绝其他 endpoint 与 3xx，不执行模型/图像生成。按用户 PostgreSQL 限流 5 次/60 秒，连接时 DNS pinning，响应最多 1 MiB 且上游 body 全部丢弃；provider 账户/用量信息不会回传。其它图像 provider 在 OIDC 下 503，legacy 路径不变。 | 6 个定向测试文件 37 项通过，覆盖固定 GET、匿名拒绝、provider/URL/body 输入、重定向、上游错误净化、用户限流和 DNS-pinned transport；验收后 middleware 仅开放精确 POST。0007 在隔离 PG16.15 正式 migrator 上应用、迁移前备份恢复到 clone、route key 正反向检查和幂等重跑通过。 |
| `/api/verify-video-provider POST` OIDC 只读验证切片 | 对每个请求要求数据库-backed `user:` owner，拒绝 anonymous；仅接受客户端 BYOK 的 `openrouter-video` key，不使用服务器托管 key；固定请求 `https://openrouter.ai/api/v1/key` HTTPS GET，拒绝自定义目标与 3xx，不创建视频任务。按用户 PostgreSQL 限流 5 次/60 秒，连接时 DNS pinning，响应最多 1 MiB 且上游 body 全部丢弃。其他 video providers 在 OIDC 下 503，legacy 路径不变。 | 4 个定向测试文件 19 项通过，覆盖固定 GET、匿名拒绝、生成型 provider 拒绝、BYOK/base URL/body 边界、redirect、rate-limit 故障和 DNS-pinned transport；PG16.15 0008 应用、失败原子性、备份恢复、route key 正反向检查和幂等重跑演练通过。验收后 middleware 仅开放精确 POST。 |
| Server Action `deleteWorkspaceSession` | 唯一 Server Action 先完成 OIDC Origin/session/member-role 校验，再检查输入并用可信 owner 调用 owner-scoped delete；空输入也不跳过授权，ID 长度限制为 256。legacy 仍使用校验后的匿名 UUID cookie。 | 8 项 action 专项用例通过：成功归属、缺失/失效/不可用会话、viewer、Origin、空输入、无权/缺失 session 以及 legacy owner；全量 TypeScript 和聚焦 ESLint 通过。 |
| OIDC 配置与 callback 参数校验 | OIDC issuer/APP/callback 只接受 HTTP(S)，HTTP 仅限 loopback；callback URI 固定 `/api/auth/callback`、同 `APP_ORIGIN` 且不含配置 query。回调必须有且仅有一个 state，并在进入 code exchange 前拒绝重复 code/error、空 error 及 code 与 error 同时出现；正常交换传入 flow 绑定的 PKCE verifier、state 与 nonce。 | 新增 callback 路由测试覆盖重复 state/code/error、混合 code+error、空 error，以及成功路径中的 PKCE/state/nonce 参数和 session cookie；auth config/flow/session/middleware 定向 21 项通过，全量 TypeScript、聚焦 ESLint、Prettier 与 `git diff --check` 通过。 |
| OIDC signing/flow key 轮换语义 | 应用只接受单一 `kid: v1` session key；更新 signing key 后旧 JWT 在数据库访问前失效，用户需重新登录。更换 flow encryption key 会让旧登录 flow JWE 无法解封。 | 隔离单元验证覆盖旧 key 签发 session 在新 key 下被拒，新 key 签发 session 可正常通过数据库会话复核；旧 flow 在新 key 下解密失败。只验证行为，没有轮换任何部署 secret。 |
| 图片/视频 verifier 验收与 gate 开放 | 用户验收仅开放 `POST /api/verify-image-provider` 和 `POST /api/verify-video-provider`：签名应用会话、Node handler 数据库 session/owner 复核；仅用户 BYOK OpenRouter 固定 `/key` GET，每用户 5 次/60 秒，不触发生成。其它 provider 在 handler 拒绝；GET 和其它方法仍由 middleware 503。 | middleware、两个 handler、用户限流 helper 与 pinned transport 共 5 个测试文件 33 项通过，覆盖 authenticated POST 放行、GET/其他方法 503、未认证 POST 401、BYOK/owner/限流/transport 与生成型 provider 拒绝；全量 TypeScript、ESLint、Prettier、route audit（73 routes / 90 methods）和 `git diff --check` 通过。0007/0008 已在隔离 PG16.15 完成正式迁移与备份恢复演练。 |
| Azure voice-list endpoint 约束与 legacy 兼容 | OIDC 下只接受官方 Azure Speech regional 域名或 Speech resource 域名、默认 HTTPS 端口及根路径；发送 BYOK key 到固定 voice-list 路径，resource endpoint 使用 `/tts/cognitiveservices/voices/list`，并继续 DNS pinning、无重定向和公网目标检查。默认 legacy 模式保留自定义 endpoint 路径及原有处理分支；错误响应不回显上游内容，日志不记录 endpoint 或 provider error。route gate 保持 503。 | Azure handler + middleware 两个测试文件 22 项通过，覆盖非 Azure host/path/端口在限流和上游请求前拒绝、resource endpoint 路径、legacy 自定义 endpoint、legacy error 净化、未认证及 middleware 503；全量 TypeScript、ESLint、Prettier、route audit（73 routes / 90 methods）与 `git diff --check` 通过。endpoint 格式依照 [Microsoft Text to Speech REST 文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech) 和 [Azure Speech Sovereign Clouds 文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/sovereign-clouds)。 |
| `/api/classroom GET` owner/tenant 读取边界 | OIDC Node handler 复核数据库-backed 身份；只允许 `ownerId` 与 `tenantId` 均匹配的本人课堂，foreign owner/tenant、缺少 owner 和 missing id 都返回不可区分的 404，读取响应 `private, no-store`。legacy 按 ID 的既有分享读取和匿名 cookie 保持兼容。middleware GET gate 暂不开放，因为跨 owner published/public 规则尚未验收。 | 新增 owner-read 专项与既有 classroom sanitization/middleware 3 个测试文件 15 项通过，覆盖 owner 命中、foreign owner/tenant 统一 404、旧无 owner 拒绝、legacy 分享读取/cookie 及 OIDC gate 503。全量 TypeScript、ESLint、Prettier、route audit（73 routes / 90 methods）及 `git diff --check` 通过。 |
| 管理员预置用户脚本 | 身份只按精确 issuer/subject 插入；不按 email 关联。existing user 必须 active；已有 default membership 必须 active 且角色与命令一致，否则事务回滚，不隐式改角色或恢复停用状态。issuer 拒绝 credentials/query/fragment 和 realm root，避免写入无法匹配运行时 OIDC 配置的身份。 | 5 项脚本用例通过，覆盖新 member 创建、existing role mismatch、disabled user、suspended membership rollback 和 issuer query 拒绝；聚焦 ESLint 通过。只使用 mock 数据库，不执行真实 provisioning。 |
| 视频渲染异步任务策略审计 | render-service 当前 job metadata 为单进程 `InMemoryJobStore`；状态、取消和下载 handler 只按随机 jobId 查找，没有用户授权。app `POST` 仅传 `clientIdentity(req)`，依赖可信反代头或落为共享 `direct`；compose 将 `RENDER_MAX_JOBS_PER_USER=0`，即关闭活跃任务逐身份限额。终态 job/artifact 默认 TTL 30 分钟，单 job 执行截止默认 45 分钟，系统最大并行 1、队列上限 20。 | 已核对 `render-service/src/job-store.ts`、`src/main.ts`、`src/config.ts`、`docker-compose.yml` 与对应 README；OIDC export submit/status/cancel/download 仍全是 middleware 503。开放前需用户确认逐用户活跃任务上限，并补 app 持久 owner/tenant、每个 job 操作的授权检查、状态丢失/留存处理与跨层回归。 |
| Server Action 盘点范围 | `scripts/audit-enterprise-routes.mjs` 先前只扫描 `app` 和 `lib`，会漏掉位于 `components` 或 `packages` 的 action 模块。 | 生成器现扫描 `app`、`components`、`lib`、`packages`，跳过 `.next`、`build`、`dist`、`node_modules`、`.turbo`；全仓精确指令扫描与生成清单均只发现 `lib/workbench/workspace-actions.ts` 中的 `deleteWorkspaceSession`，route audit 仍为 73 routes / 90 methods，清单无“待人工定案”。 |
| 配额状态与路由状态对齐 | LLM 每用户 UTC 月配额已经在 OIDC agent runtime 的 `callLLM`/`streamLLM` 边界和 `/api/verify-model POST` 接入；尚未开放的是直接生成端点、异步任务及 image/video/TTS/ASR 等尚未完成对应策略或验收的模态。 | 配额迁移在隔离 PostgreSQL 16.15 已通过；route inventory 与本节状态记录均明确区分“LLM 配额已实现”和“直接生成路由仍关闭”。生产迁移/密钥配置未执行，不把隔离验证描述为生产就绪。 |
| 路由身份清单与逐操作复核 | 修正清单身份栏对 `withRequestOwnerId` 路由的过度概括：classroom GET/POST 按方法记录 legacy 与 OIDC 身份差异；OIDC 专用分支不再错误推断 legacy 匿名路径也被拒绝。图片/视频验证路由记录其已验收并精确开放 POST。 | 生成 `ENTERPRISE_ROUTE_INVENTORY.md` 为 73 routes / 90 methods；Node 脚本语法、ESLint、Prettier、`git diff --check` 通过。Server Action、classroom 读取与 middleware 回归 3 个测试文件 18 项通过；全量 TypeScript 通过。 |
| 迁移 0006 试点额度注释与验收状态 | 迁移文件仍含 “Confirmed balanced pilot” 注释，而 image/video/TTS 值在当前计划仍待产品验收；直接编辑旧 SQL 会更改迁移 checksum 并使已应用数据库的 migrator 校验失败。 | 在受控部署清单标出注释不代表验收，不改写历史迁移；获批后的额度调整须使用新迁移，未获批时对应生成路由保持 503。 |
| Windows skill ZIP 归档路径 | `buildSkillDirZip` 将平台分隔符写入 ZIP entry，Windows 上产出含反斜杠的条目名。改为统一使用 ZIP 规范的 `/` 分隔符；下载身份门控不变。 | 修复后 `tests/server/skill-export.test.ts` 10 项通过；全量 TypeScript、聚焦 ESLint、Prettier 通过。工作树相关 45 个测试文件 318 项通过；API、server、agent-runtime、persistence 等相关目录共 220 个文件、2,338 项通过，9 个文件/37 项跳过。 |
| 全仓测试范围核对 | `pnpm test -- --reporter=dot` 的一次完整运行未全绿：782 个文件中 758 通过、12 失败、12 跳过；8,685 项中 8,476 通过、112 失败、97 跳过。至少一个 `call-agent-json-actions` 超时用例单文件复跑通过；其余全仓失败未逐项归因。 | 本轮所有相关目录复跑通过，但不把该结果表述为全仓全绿；后续全仓失败应单独收集报告并按失败文件归因。 |
| `/api/extract-document POST` OIDC 身份和资产来源边界 | handler 使用 `withRequestOwnerId` 执行数据库-backed session、Origin 和非 viewer 写操作检查；OIDC 响应 `private, no-store`。multipart 上传只在已认证请求中处理；asset-id 输入将 verified `user:` owner 交给 `resolveServerAsset`，再由 `resolveOidcAssetPrincipal` 检查本人资产或现行公开课程引用，不使用共享 persistence token。legacy 仍使用原 3 参数 shared-principal 路径。middleware gate 继续 503。 | 新增 handler 和 resolver 回归，连同现有 extractor、资产授权及 middleware 门控 5 个测试文件 47 项通过；全量 TypeScript、聚焦 ESLint/Prettier、`git diff --check` 通过。整体请求体/文件总量上限、用户限流与费用/用量策略、server-managed 成本归属和 extractor 上游连接时 DNS pinning 仍未闭环，不能开放。 |
| `/api/parse-pdf POST` OIDC 身份与私有响应边界 | OIDC handler 要求数据库-backed session、同源 Origin 和非 viewer 身份边界；OIDC 响应 `private, no-store`，上游异常不会回显 provider/文件信息。legacy handler 分支保持原有响应行为。middleware gate 继续 503。 | 新增身份、拒绝前置、错误净化和 legacy 兼容回归；解析/抽取/资产授权相关 3 个测试文件 11 项通过，聚焦 TypeScript、ESLint、Prettier 与 diff 检查通过。multipart 总体积/文件数上限、用户限流、BYOK 与 managed 费用归属、provider 连接 DNS pinning/redirect 边界仍未完成，不能开放。 |

### 下一增量的准入条件：生成与用量

当前应先完成策略和数据归属设计，再逐组接入会话；不能仅在 middleware allowlist 中添加路径。

| 路由组 | 当前实现与缺口 | 放行前条件 |
| --- | --- | --- |
| `/api/usage` | JSONL 新写入可从 owner/runner 的异步上下文带上服务端 `ownerId`/`tenantId`；OIDC 读取现按 ownerId 过滤，旧行或无 principal scope 的直接生成记录不会展示给成员。 | 个人读取和严格路径门控已完成；tenant 管理汇总等待 RBAC；旧数据不得按模型/时间推断归属。 |
| `/api/server-providers` | **已完成**：OIDC 精确 GET 需数据库复核 session；返回只读部署能力元数据，`private, no-store`。 | 仅 GET 在 gate 内；active viewer 可读。保留敏感字段和错误路径回归，不增加其它方法。 |
| `/api/comfyui-workflows` | **已完成**：OIDC 精确 GET 需数据库复核 session；索引静态 public 文件名/展示名，`private, no-store`。 | 仅 GET 在 gate 内；无 session 401，viewer 只读；其他方法维持 503。 |
| provider probe / verify | `/api/provider/probe-models POST` **已受控开放**：BYOK、每用户每 60 秒最多 5 次、严格公网目标与 DNS pinning、15 秒单次/30 秒总超时、256 KiB 成功响应上限；不接触服务器托管凭证。`/api/verify-model POST` **已受控开放**：单次 32 token、30 秒超时、owner-scoped LLM quota、相同逐用户限流、BYOK strict SSRF/pinning、server-managed provider 采用 operator network policy。自定义 proxy provider 继续关闭。PDF verify handler 仅 AliDocMind；image/video verify handler 仅 OpenRouter 的 BYOK `/key` GET，均不触发生成、逐用户 5 次/60 秒、strict DNS pinning 并丢弃上游响应。用户已验收，middleware 现仅精确开放 image/video verifier POST；PDF verify 与其它供应商仍 503。0005、0007、0008 已完成 PG16.15 隔离 migrator 演练；PDF gate 仍待关键验收。 | 其他端点逐一确定凭证来源、上游成本/重试策略、身份和资源授权、用户级限额、请求/响应上限及回归覆盖后，才精确开放对应方法。 |
| 同步生成（LLM/image/TTS/video 等） | 直接调用上游；客户端可选模型/凭证与 server-managed provider 混合，部分请求还会写入 stage 或返回媒体结果。现有 usage attribution context 只覆盖明确建立 owner/runner scope 的调用路径，并非所有生成 API 的通用授权或限额边界。 | 所有输入和目标资源按当前用户授权；usage 在结果产生时携带服务端 owner/tenant；个人分模态额度表已存在；接入前需验收已种入的 image/video/TTS 试点额度、补齐 ASR 决策，并落实 owner 归属、并发安全与拒绝行为；未验收前维持 503。 |
| 异步 classroom/video/export | 课堂生成 job 与新写入的 classroom 文件已持久记录 owner/tenant；worker 更新与 job 轮询逐次校验二者。OIDC classroom-media GET 在读取媒体前校验对应 classroom 的 owner/tenant，并使用 `private, no-store`。视频渲染 app 代理没有 owner/tenant 映射；render-service 的 job 状态位于进程内存，compose 关闭 per-client 活跃任务限额，所有状态/取消/下载只按 job ID 定位；已完成任务和产物默认保留 30 分钟。`/api/classroom GET` 的 Node handler 已仅允许本人同 tenant 读取；跨 owner 的公开访问策略尚待验收，因此 middleware gate 关闭。 | 决定跨 owner 已发布课堂是否可公开读取及需满足的发布/删除条件后，再开放对应 GET；为视频导出及其它真正异步任务在提交时绑定 owner/tenant，worker 只更新该主体任务，状态/取消/下载复核同一 owner 与 tenant，并处理过期、重试与失败恢复。为视频渲染另需先确定每用户活跃任务上限，再设计 owner 映射清理与 render-service 重启后的状态行为；全部验证前相关 OIDC 入口保持 503。 |
| 同步文档抽取与转录 | `/api/extract-document`、`/api/parse-pdf`、`/api/transcription` 都在请求内读取上传/既有资产、调用 extractor/provider 并直接返回结果；没有后台 job 或独立 worker 状态机。`/api/extract-document` 已加入 handler 身份边界和 asset-id OIDC owner 校验；`/api/parse-pdf` 已接入身份边界和私有响应，`/api/transcription` 仍未接入 OIDC 身份。BYOK 与服务器托管 provider 都可能产生费用或处理敏感内容。 | 开放前逐路由要求数据库 session、Origin/角色边界、服务端 owner/tenant 归属、BYOK/managed 费用规则、用户限流与上传体积限制；asset-id 形式必须复核同一用户的资产归属。不得把同步抽取误记成需 job status/cancel/download 的异步任务；所有未满足成本和用量准入的路由继续 503。 |

策略决策已确认：第一阶段按个人归属、个人限额，暂不开放 tenant 汇总；额度按各模态原始用量分别计量（LLM token、图片张数、视频秒数、TTS/ASR 字符或秒），不折算金额。LLM 初始额度为每人每 UTC 自然月 10 亿 token；迁移 0006 种入 image 每月 2,000 张、video 每月 3,600 秒、TTS 每月 2,000,000 字符的试点值，待用户关键验收；ASR 额度未定，因此相关生成路由保持关闭。当前 `default` tenant 还没有管理员角色。LLM 配额 reservation 与实际用量 settlement 已接入统一 `callLLM`/`streamLLM` 边界：每个 AI SDK 模型步骤先按模型目录 `contextWindow` 上限预留，步骤完成后按 provider usage 结算；工具循环逐步再预留，验证重试独立计量；OIDC 下关闭 AI SDK 隐式重试，避免一次 reservation 包含多次隐藏 provider 请求。未知模型上下文上限、缺少可信 `user:` owner、数据库/策略不可用均失败关闭。直接 `/api/generate/*`、PDF verify、其他付费生成和异步任务仍由 OIDC middleware 返回 503；image/video verifier 已验收并精确开放 POST，调用固定 OpenRouter `/key` GET 且不生成；`/api/provider/probe-models POST` 使用用户自带 key 和 PostgreSQL 5 次/60 秒的独立限流，不消耗服务器托管额度；`/api/verify-model POST` 通过同一 `callLLM` quota 为 BYOK 或服务器托管 LLM 验证计量；目前 OIDC agent-runtime 的 LLM 调用由上述 quota boundary 约束。

额度实施约定：当前周期按 UTC 自然月（每月 1 日 00:00 UTC 重置），数据库策略种子为 `llm/token = 1,000,000,000`。每位用户独立累计，数据库预留与实耗分开；每个模型步骤预留其已登记的最大上下文窗口，provider 成功后按实际 usage 结算，usage 缺失则计入整段预留上限；provider 请求异常时也按预留上限计入，因为请求是否已在上游计费无法可靠判断。无法取得 provider usage 的保守扣费会作为独立的 `quotaEstimatedTokens` 写入 JSONL，并纳入个人用量总量；用量仪表盘单独显示该估算值，不伪装成 provider 报告的输入/输出 token。步骤 reservation 每分钟续租，五分钟无续租则在下次该用户当月额度申请时回收；迟到的真实 usage 仍回写 used 计数，可能让计数超过额度并阻止后续请求。迁移须先由受控部署流程应用；直接生成接口、custom/未知模型和其他模态仍关闭。image/video/TTS 的单位与试点额度已写入迁移 0006，待用户验收；ASR 仍需确定单位和额度。
