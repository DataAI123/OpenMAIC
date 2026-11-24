# OpenMAIC 企业级交付状态

盘点时间：2026-10-08（Asia/Shanghai）。关联计划：[企业级交付实施计划](ENTERPRISE_DELIVERY_IMPLEMENTATION_PLAN.md)。状态只反映本页记录的当前 checkout，不代表任何生产环境已经部署。

**整体计划状态：按用户要求暂停。** 本次暂停前完成生成会话凭据脱敏切片验收：企业 required gate 为 **47 suites / 486 tests passed，zero skipped**；标准 TypeScript、Prettier、`git diff --check` 通过。ED01–ED15 仍有多项未完成或只有本地/模拟证据；暂停不代表整体计划完成。

## 可追溯基线

- 分支：`main`；HEAD：`a9c9ca129da62f0431d5b72b33da4cedf972b2ba`。
- ED01 开始前，`git status --short` 报告 **30 个已跟踪文件修改和 4 个未跟踪文件**。改动分布于多租户计划、`ENTERPRISE_AUTH.md`、媒体 provider/设置、图片路由、owner boundary、middleware、Next dev 配置和相关测试，另外有 `HANDOFF.md`。这些工作在 ED01 前已存在；ED01 仅复核和保留，没有重置、清理或覆盖。
- 本轮为 ED01 新增的实施/状态文档为 untracked 文件，不是已提交变更。原有 `ENTERPRISE_AUTH.md` 的第 28 批内容保留，ED01 在其上作了范围受限的状态和迁移说明修订。
- 企业迁移文件目录为 `0001` 至 `0023`。旧发布说明仍写到 `0019`，ED01 已改为核对 `0023`；这只修订仓库文档，不证明任何数据库已迁移。
- 运行 `node scripts/audit-enterprise-routes.mjs` 得到 **80 个 route handler、99 个导出的 HTTP 方法**。重生成的 `ENTERPRISE_ROUTE_INVENTORY.md` 与现有文件无差异。
- 路由生成器是源码覆盖清单，不是安全证明。它用字符串和路径规则做分类，不能证明每个 handler 的资源授权正确。OIDC 的实际拒绝/准入还依赖 `middleware.ts`、Node handler 和方法级测试；存量测试没有证明已枚举全部路由的运行时行为。
- 逐操作授权核查尚未完成；静态路由覆盖率通过不代表 ED01 的安全逐项验收通过，完整 handler 授权矩阵仍列为 ED15 的收口门槛。
- `docs/` 被 `.gitignore` 排除。该盘点保存在根目录，避免交付状态只存在于本机忽略文档。

## 定向验证记录

- `node scripts/audit-enterprise-routes.mjs`：通过，输出 80 routes / 99 methods；重生成清单无差异。
- 定向 Vitest：`tests/server/request-id-owner-gate.test.ts`、`tests/server/middleware-oidc.test.ts`，以及 4 个被本地媒体改动触及的 media suites；**6 files / 46 tests passed**。
- ED02 租户边界回归：`tests/api/tenant-active.test.ts`、`tests/api/tenant-members.test.ts`、`tests/server/auth-session-tenant.test.ts`；**3 files / 32 tests passed**。
- ED02 浏览器 smoke：本地 legacy 开发服务器 + Playwright CLI 路由 mock。实见两个组织、活跃组织可选、暂停组织禁用；选择动作向 mock `POST /api/tenant/active` 发送 `{ tenantId: "tenant-active" }` 并 reload；空租户列表实见联系管理员提示。没有连接数据库或写入真实 session。
- ED03 认证/租户失败分流：`tests/auth/client-login.test.ts`、`tests/workbench/workspace-actions-auth.test.ts`、`tests/api/tenant-active.test.ts`；**3 files / 32 tests passed**。新增 `recoverClientAuthFailure` 统一处理精确的 `LOGIN_REQUIRED` 和 `TENANT_REQUIRED` 响应，并测试登录 returnTo 保留、租户刷新、普通 `FORBIDDEN` 不误跳转及非法 JSON 不误处理；设置管理与全局租户选择均复用该入口。
- ED03 凭据不写入生成会话：新建会话仅持久化 PDF provider ID，提取时读取当前设置；恢复旧 session 时会剥离顶层及 document source 的 provider 凭据字段，并立刻重写 `sessionStorage`。所有后续会话持久化都统一经过脱敏函数。`tests/generation/safe-session.test.ts` **3/3 passed**，验证 JSON 中无 API key/access key/base URL、清理不修改输入对象及任意旧 provider ID 不索引设置。旧会话现使用当前 provider 配置；表单草稿恢复和 tenant 隔离仍未完成。
- ED03 生成失败分类与重试：`tests/generation/client-failure.test.ts`、`tests/generation/retry-after.test.ts`、`tests/generation/scene-generator-language-directive.test.ts`、`tests/generation/foreground-retry.test.ts`；**4 files / 34 tests passed**。分类区分登录、租户、权限、认证依赖、供应商凭据、限流、配额、上游不可用、内部错误和输入错误；未带业务码的 401/403 分别按登录/权限失败显示；对 HTTP 429 读取并限制 `Retry-After`，策略拒绝及 4xx 不自动重试。生成 preview 现在读取合规 `x-request-id`，提供复制按钮和失败编号文案。
- ED03 媒体登录/租户恢复：新增 `mediaFailureRecovery` 与失败提示映射。用户点击失败媒体的“重试”时，`LOGIN_REQUIRED` 先进入登录，`TENANT_REQUIRED` 刷新到组织选择；回来后仍需再次手动重试。`tests/media/media-failure.test.ts` 的 **12 tests** 和 `tests/media/media-orchestrator.test.ts` 的 **12 tests** 通过，后者包括 2 项“恢复前不调用 provider”用例。
- 媒体并发套件：复现后发现两项失败断言在固定微任务等待结束时尚未到达它们声称观测的事件。测试现在分别等到替代 pass 已启动、首个 provider 请求确实在途后再断言/abort；只调整了测试同步，没有改编排运行时代码。`tests/media/server-backed-media-orchestrator.test.ts` **52 tests passed**，Prettier、ESLint 与 `git diff --check` 通过。该结果支持此前失败来自测试时序假设，不能替代真实多标签/多实例或 PostgreSQL 并发验收。
- 类型检查：`pnpm exec tsc --noEmit`：覆盖 ED01、ED02 与 ED03 当前切片，退出码 0。
- ESLint：覆盖本次 ED03 分类器、Retry-After 解析器、生成 hook、生成预览页及对应新测试，退出码 0。
- ED04 设置概览与成员操作：`components/settings/tenant-overview.tsx` 请求当前 session、tenant list，以及 owner/admin 权限门后的 members/audit API；为成员添加、角色变更、暂停/恢复、移除、自助退出、owner 改名接入既有 API。按钮按当前角色做能力过滤，API 仍为授权真源。`tests/api/tenant-active.test.ts`、`tests/api/tenant-members.test.ts`、`tests/api/tenant-membership-lifecycle.test.ts`：**3 files / 47 tests passed**；相关 ESLint、`pnpm exec tsc --noEmit` 和 `git diff --check` 通过。后续隔离 Chrome smoke 覆盖成员角色更新与审计刷新，完整设置弹窗导航尚未测。
- ED04 后续静态切片：审计记录现在显示角色变更前后值及语义化时间；设置页管理请求遇到明确的 `LOGIN_REQUIRED` / `TENANT_REQUIRED` 时使用统一登录/组织恢复入口；管理写入时通过 `aria-busy` 与状态播报提供等待反馈。Prettier、组件 ESLint、`git diff --check` 通过；清除临时 smoke route 后由隔离 `next dev` 重建开发路由类型，最新标准 `pnpm exec tsc --noEmit` 退出码 0。
- ED05 初步可访问性/本地化切片：组织选择弹窗不再在组件内硬编码四种语言并对其余语言退回英文；标题、说明、空状态、继续按钮及组织状态变化消息改用全部 12 个 locale 的翻译资源，角色和暂停状态复用设置页已有翻译。每个继续按钮的 accessible name 包含组织名；首页设置齿轮、设置关闭按钮和成员角色下拉包含可访问名称；弹窗具备标题/描述，管理写入已有等待状态播报。新增组织列表弹窗最大高度约束和内部滚动，避免小视口下组织选择按钮滚出屏幕。Prettier、相关 ESLint、TypeScript 检查及 `git diff --check` 通过；租户相关 API suites 47 tests 通过。隔离 Chrome/mock smoke 实测活跃组织选择、暂停组织禁用、空列表状态、目标成员角色选择和保存后审计变更显示；没有连接数据库、触达供应商或执行迁移。i18n 对齐脚本确认新增键均覆盖，但仍只报 10 个 locale 缺少既有 `settings.usage.estimatedQuotaTokens`。焦点返回、键盘循环、窄视口缩放和屏幕阅读器仍需浏览器人工验收。
- ED13 请求编号覆盖切片：`withTenantPermission`、`withAuthenticatedIdentity`、`/api/tenant/active`、OIDC login/callback/logout/session，以及 middleware 的 OIDC edge refusal/page redirect、disabled-workbench 404、legacy access-code 401 均回显规范化 upstream id 或服务端 UUID。`/api/access-code/status` 和 `/verify` 的成功/拒绝/异常兜底也带 request-id；异常日志仅写异常名，响应不含底层错误正文。Agent Runtime 的 session/skills API runtime-disabled 早退、`/api/agent/runtime` 状态响应、owner/session/freshness SSE runtime-disabled 404、存储/会话读取失败 503 和 render-download provider-disabled 501 也带编号。freshness SSE owner 初始化或首轮存储读取异常返回不含底层细节的 503，日志记录 request-id 与异常类型；旧 `/api/health` 和 `/api/export-video/capability` 的正常响应也带编号，health provider 配置异常返回脱敏 503，render probe 失败日志只记录编号与异常类型。freshness 与 health/render 相关 suite 分别 **7 tests**、**15 tests passed**。此前租户/认证边界 9 files / 108 tests、SSE/下载边界 3 files / 47 tests 通过；本次 Agent Runtime gate/probe/SSE 回归 10 files / 103 tests 通过。ED13 不增 route，inventory 82/101。后台 operation/attempt/settlement 全链路仍待覆盖，不能声称已覆盖全部出口。
- ED14 存活/就绪探测切片：精确 GET `/api/health/live` 只返回 `status: ok`，带 `Cache-Control: no-store` 和 request-id，不触碰依赖；精确 GET `/api/health/ready` 在 OIDC 或 durable agent runtime 必需时，以独立只读 PostgreSQL pool 查询迁移版本，超出 1 秒连接/查询预算即失败；legacy 且 agent runtime 关闭时不强制 PostgreSQL。成功/失败结果按 2 秒缓存并合并并发探测；公共响应不暴露依赖原因，日志只记有限失败分类。两探针均在 OIDC/legacy 下仅开放精确 GET/HEAD；POST/子路径拒绝。`tests/api/health-live.test.ts`、`tests/api/health-ready.test.ts`、`tests/server/middleware-oidc.test.ts`：**3 files / 28 tests passed**。Prettier、ESLint、typecheck、路由审计和 `git diff --check` 通过；当前 inventory 为 82 handlers / 101 methods。ready 探针以 0023 为当前最低 schema 版本，schema checksum 仍由发布迁移程序核验；没有真实 PostgreSQL 故障演练，也未绑定部署流量门槛。
- `node scripts/check-i18n-keys.mjs`：当前工作区失败；10 个非源 locale 缺少 `settings.usage.estimatedQuotaTokens`。本次已给 12 个 locale 添加 ED03 generation 文案，但没有补写这个既有用量键；脚本未报告本次新增的 generation 键缺失。
- ED01 没有访问 PostgreSQL、Keycloak、生产凭据或供应商 API，也没有运行迁移。

## 已修正的企业交付文档

- `ENTERPRISE_AUTH.md` 之前把 OIDC 仅描述为资源读取白名单，并称付费生成仍然全部关闭；与当前 `middleware.ts` 中的图片/视频/TTS、转录、课堂和渲染方法项不符。ED01 现说明 OIDC 使用方法级入口，路由入口仍须由 handler 执行会话、权限、owner、tenant 和成本策略。
- `ENTERPRISE_AUTH.md` 发布预检和 schema 验收的 migration 最高版本从 `0019` 更新到目录当前最高的 `0023`。
- [路由清单](ENTERPRISE_ROUTE_INVENTORY.md) 在 ED01 基线记录 80/99；ED14 新增 liveness 与 readiness handlers 后当前可复现数为 82/101。静态 generator 与人工策略说明仍可能过期。逐操作授权结论需在 ED15 通过 handler/tests 重新验证。

## 实施进度

| ID | 状态 | 说明 |
| --- | --- | --- |
| ED01 | 基线已交付 | 可复现盘点、文档修订、46 项定向测试和类型检查已记录；静态路由覆盖不是逐 handler 授权证明，该安全矩阵待 ED15 收口。 |
| ED02 | 进行中 | 新增全局 tenant-required 选择界面，连接既有租户列表与 active-tenant API；0、1、多个和停用组织均有呈现，选择文案与角色名覆盖 12 种 locale。已绑定会话的切换、跨标签页版本和旧客户端兼容仍受 D01 阻塞。 |
| ED03 | 进行中 | 全局登录/租户恢复已用于生成、workspace、组织选择、设置管理和失败媒体的用户触发重试；生成预览增加稳定错误分类、429 Retry-After 提示、4xx/策略错误不自动重试和可复制的 `x-request-id`，媒体失败给出登录/组织恢复路径。相关文案已覆盖 12 种 locale。生成分类/重试 34 项、媒体失败分类 12 项、server-backed 媒体编排 52 项通过；后者两项测试改用事件同步后稳定通过，未改运行时代码；真实多实例并发仍待覆盖。表单恢复仍待做。 |
| ED04 | 进行中 | 设置页显示 OIDC 当前组织；owner/admin 可查看成员与最近 50 条角色审计，并可添加已有用户、变更低权限成员角色、暂停/恢复或移除成员、改名；各角色都可自助退出当前组织。审计显示角色前后值和操作时间；管理 API 明确返回登录/租户失效时走统一恢复入口。隔离 Chrome/mock smoke 验证角色更新和审计刷新；设置弹窗导航仍待测。暂停组织控制因当前 session 会被清除而未呈现。 |
| ED05 | 进行中 | 租户选择/管理切片已补 12 种 locale、控件名称和等待播报，并通过隔离组件 smoke；组织列表弹窗限制最大高度并在内部滚动。新增 loading/提交状态播报及 reduced-motion 动画关闭样式。使用当前隔离 loopback dev server + 系统 Chrome 实跑 `e2e/tests/tenant-required-gate.spec.ts`：**1 passed**，覆盖加载播报、暂停项、Escape、Tab 焦点循环、Enter 选择/reload、reduced-motion。该实跑发现 Tailwind data-open 动画优先级覆盖了普通 motion-reduce 类，已用 important reduced-motion utilities 修正并复测通过。焦点返回、窄视口缩放、对比度、读屏与完整 SettingsDialog 导航仍需人工验收；本次只 mock API，不代表整体 a11y 合规。 |
| ED13 | 进行中 | 租户管理、OIDC 与 legacy access-code handler、middleware 拒绝/重定向、Agent Runtime API/SSE 早退与存储失败、runtime probe、render submit/download、PDF/image/video provider verification、旧 health 与 render capability 均回显 request-id；health/provider 配置失败与 provider 上游正文均脱敏，render 探针日志只保留编号和异常类型。render submit 的并发存储、owner 绑定和上游网络异常日志只写 request-id、jobId（绑定失败时）与异常类型；上游异常正文不返回客户端。freshness SSE owner 初始化与首轮存储错误返回通用 503 并保留编号。`/api/stages` 与 `/api/stages/[id]` 的 runtime-disabled 和写入校验早退现也回显 request-id；材料详情缺少 session、runtime-disabled 与 stage-meta persistence-disabled 早退也已补齐。stage-meta 与 classroom-media 异常日志只记录 request-id 和异常类型，不再写异常正文/路径。provider response stream 不缓冲到错误正文；相关新增验证 9 suites / 121 tests，含 render submit 16 tests 与 PDF/image/video 35 tests，ESLint、标准 TypeScript、Prettier 通过。ED15 当前完整 required gate **47 suites / 486 tests passed，zero skipped**。成功、拒绝、redirect、204、流式媒体响应和意外异常兜底有回归。session/owner SSE 在存储轮询尚未返回时取消 reader，可清理计时器、取消唤醒订阅，并忽略迟到轮询结果；底层查询仍会运行，代理/网络断开及异步任务链路关联待覆盖。 |
| ED14 | 进行中 | 增加不查依赖的精确 liveness GET/HEAD，以及按 OIDC/agent-runtime 必需性执行的 ready PostgreSQL/schema 探测；有 1 秒预算、2 秒缓存和并发合并。middleware 精确准入、方法/子路径拒绝已有定向测试。真实 PostgreSQL 故障演练与部署流量门槛待做。 |
| ED15 | 进行中 | 主 CI 增加 47 个企业租户/认证/Agent Runtime/provider/session-safety suite 的 required-run JSON gate，拒绝缺失套件和 skip；强制执行文档/Agent Session/Owner Materials、配额/限流/资源迁移、完整迁移链、生成 session 凭据脱敏、stage-freshness SSE 错误边界、16 个持久化 API 的 runtime 配置门控、health/render capability、provider-verification 与 liveness/readiness 契约，以及 stages/material detail/stage-meta/classroom-media 的 request-id 边界。专用 gate 限制 2 个 Vitest file workers；`agent-sessions-tenant` fixture 明确设定 20 秒初始化/15 秒慢用例预算，不降低断言。最新离线本地完整 gate **47 files / 486 tests passed**，required suites 零跳过。PG16 工作流要求 4 个 Agent 并发 suite、storage 5 个 PostgreSQL contract suite，以及新增实际 migration runner 合约：独立 schema 内依次运行 23 个迁移、核对 backfill 和 checksum、重跑验证幂等、篡改记录验证 checksum 拒绝；storage 外部计数守卫覆盖 18 张表。storage 会话的同 owner 双租户断言已加入 PGlite 与 PG 合约；独立 PGlite tenant suite 本次 **7/7 passed**，storage PGlite 会话 suite **89 passed / 4 skipped**；另新增完整 23 迁移 PGlite suite并已通过。新增独立 `enterprise-oidc-e2e` CI job：PG16 + Keycloak 26.7.5 disposable realm、loopback HTTPS proxy 和 runner 信任的临时 CA、production app build/start，以及 owner/viewer 登录、cookie、tenant API 权限、Origin 拒绝和 logout 撤销断言；selector 身份拥有 default owner 与 secondary viewer 两个活跃成员关系，新增浏览器场景验证登录后强制选择并校验会话绑定；只复用迁移后的专用数据库，不加载 `.env.local`，禁用浏览器 trace/screenshot/video，不连真实 provider。JSON 结果守卫精确要求三个用例都通过且零跳过，拒绝缺失、重试、flaky 和 unexpected；守卫自测 **4/4 passed**。PostgreSQL E2E、隔离 schema migration-runner contract 和完整 PGlite migration 测试复用 `tests/e2e/enterprise-baseline.sql`。共享基线下的完整迁移 PGlite suite **1/1 passed**；新增企业 E2E 尚未在本地或 CI 执行，Keycloak import、证书/browser 信任和真实租户选择仍待首次 CI 运行确认。该切片没有覆盖完整角色矩阵、provider double、异步恢复或 MP4 smoke。当前机器没有 `PG_CONTRACT_URL`、psql 或 Docker，故实际 PG16 suites 和 migration runner 合约也尚未执行。 |
| ED06–ED07 | 等待 D02/D03 | 账本切换、额度与 ASR 策略未确定；未新增迁移或启用新计量路径。 |
| ED08 | 准备切片已完成，主任务待 D02/ED06/ED07 | 新增只读隔离快照核对工具，逐行分类、源键与内容 hash、受控数值输出和最终守恒汇总；未导入数据库，未切换应用读写。见下方记录。 |
| ED09–ED12 | 等待 D04 及上游任务 | 留存、恢复和凭据失效契约未确定；未实现或启用依赖这些决策的任务恢复行为。 |
| ED16–ED17 | 待开始 | 按实施计划、依赖关系及决策登记推进。 |

- ED15 E2E 可重复性：selector 浏览器用例在登录前固定 `zh-CN`，避免 `I18nProvider` hydration 后跟随 Chromium `navigator.language` 改变按钮/标题文案。Playwright `--list` 收集预期的 3 个用例（未启动服务）；Prettier、`eslint --no-ignore`、标准 `pnpm exec tsc --noEmit` 与 `git diff --check` 通过。该修正未替代真实 Keycloak/HTTPS E2E；当前环境无 Docker、psql 或 `PG_CONTRACT_URL`。

## ED06–ED12 独立推进记录（2026-10-08）

本轮先读取项目规则、计划/状态和 Git 工作区清单，保留已有未提交内容。安装版 Next.js route handler 指南已读取；实际实现为独立 Node 工具，无应用路由、schema、供应商或 worker 契约改动。

- ED08 新增 [离线快照核对工具](scripts/audit-usage-snapshot.mjs) 与 [操作契约](ENTERPRISE_USAGE_SNAPSHOT_AUDIT.md)。逐行产出源 hash/字节偏移、分类与原始单位数值，最终汇总满足 `totalLines = reviewRequired + quarantined + excluded`；同内容不同位置和重复旧 ID 均不自动去重。owner/tenant 只输出组合 hash，未知字段和原始行不回显；有效结构仍待可信归属审核。真实/估算字段保持分离。
- 工具无默认输入路径、不加载 `.env.local`、不连接 DB/供应商；1 MiB 单行缓冲上限、64 KiB chunk 与逐行输出背压。文件变化、读取或输出错误拒绝完成；无最终 summary 的暂存报告必须整份丢弃。测试先运行并因实现缺失失败，实现后 `node --test scripts/audit-usage-snapshot.test.mjs` **8/8 passed / zero skipped**，覆盖合成快照守恒、四模态、异常字段、重复 ID/稳定键、UTF-8/CRLF、超长行、信息白名单、I/O/输出失败和读取中变化；该命令已加入主 CI。
- 仅执行测试自行创建的合成临时快照，未审计真实用量文件；没有新增依赖、迁移、数据库导入、生产部署或真实供应商调用。未完成数据库去重/恢复、历史归属核验、原始数量跨库对账、企业读写切换，ED08 整体未完成。
- 最终验证：新工具与两个现有企业 CI 守卫合并执行 `node --test scripts/assert-enterprise-regression-suites.test.mjs scripts/assert-enterprise-e2e-results.test.mjs scripts/audit-usage-snapshot.test.mjs`，**17/17 passed / zero skipped**；新脚本 ESLint、涉及文件 Prettier 和 `git diff --check` 通过。未运行完整构建或真实 PG/E2E：此次仅新增独立 Node 工具及其 CI/文档，不改变应用 TypeScript 或运行时路径。
- D02 阻塞 ED06 的账本/额度切换、ED07 的计量配置与 ED08 的导入/读写切换；D03 额外阻塞 ASR 字节/时长/并发/月额度策略。D04 阻塞 ED09 的留存/重启恢复契约，并通过 ED09/ED06/ED07 影响 ED10–ED12。未猜测任何数值、留存或 BYOK 恢复行为。

## ED13 request-id 覆盖矩阵（当前切片）

以下矩阵只证明列出的代码边界和回归，不代表全路由覆盖；request-id 是故障关联字段，不是身份凭据。

| 边界 | 当前证据 | 状态 |
| --- | --- | --- |
| OIDC middleware 拒绝、未登录重定向、disabled-workbench 与 legacy access-code gate | `tests/server/middleware-oidc.test.ts`；既有测试检查归一化 ID 响应 | 已覆盖所列出口；普通透传响应未全量审计 |
| Tenant owner/permission 与 active-tenant session 解析 | `tests/api/tenant-active.test.ts`、`tenant-members.test.ts`、`tenant-membership-lifecycle.test.ts`；3 files / 47 tests | 已覆盖所列成功、拒绝和 active tenant 响应 |
| OIDC auth 与 legacy access-code handler | `tests/api/auth-request-id.test.ts`、`auth-callback.test.ts`、`tests/server/access-code-status-route.test.ts`、verify 对应测试；相关认证边界汇总 9 files / 108 tests | 已覆盖所列 redirect、204、成功、拒绝和异常兜底 |
| Public health 与 render capability | `tests/server/health-access-code.test.ts`、`tests/server/video-export-capability.test.ts`；2 files / 15 tests | 成功响应回显编号；health 配置异常返回脱敏 503，render probe 失败日志不含原始异常消息 |
| Transcription 与图片/视频 provider 验证 | `tests/api/transcription-oidc.test.ts`、`verify-image-provider.test.ts`、`verify-video-provider.test.ts`；3 files / 26 tests | 覆盖 transcription legacy/auth-config 早退以及 image/video legacy success 和 auth-config 脱敏 503；OIDC 继续由 owner boundary 提供编号；非全路由证明 |
| Document extraction | `tests/document/extract-document-route.test.ts` **33/33**、`extract-document-oidc.test.ts` **5/5**；串行执行 | legacy multipart/JSON 结果和 auth-config 脱敏 503 返回规范化编号；OIDC 由 owner boundary；并发执行曾触发两项 5 秒 suite 超时，隔离重跑均通过 |
| Owner materials API | `tests/agent-runtime/materials-route.test.ts` **18/18**；`persistence-routes-gate.test.ts` **66/66** | GET/POST runtime-disabled 与 GET 参数校验早退返回规范化编号；正常 owner-bound response 维持原路径 |
| Stage collection/detail APIs | `tests/agent-runtime/stages-route.test.ts`、`stage-detail-route.test.ts`；2 files / 40 tests | `/api/stages` 与 `/api/stages/[id]` runtime-disabled、JSON/name/document 校验早退回显已提供的 request-id；owner-bound 结果沿用统一边界 |
| Material detail 与 stage-meta | `tests/agent-runtime/material-detail-route.test.ts`、`stage-meta-routes.test.ts`；2 files / 20 tests | material detail 缺少 session/runtime-disabled 和 stage-meta persistence-disabled 早退回显 request-id；stage-meta 存储异常不记录原始异常正文 |
| Classroom media streaming | `tests/api/classroom-media-range.test.ts`；10 tests | 正常流式响应保留 request-id；owner lookup 与文件服务失败日志仅含 request-id/错误类型，不记录原始错误或路径 |
| Render submit | `tests/agent-runtime/export-video-ownership.test.ts`；16 tests | owner 绑定/并发故障日志仅包含 request-id 与有限错误类型；上游异常正文不写日志，也不返回客户端 |
| PDF/image/video provider verification | `tests/api/verify-pdf-provider.test.ts`（15 tests）、`verify-image-provider.test.ts`（12）、`verify-video-provider.test.ts`（8） | 已列出口均回显 request-id；不暴露 provider 错误正文或意外异常消息 |
| Agent Runtime route early gate 与公共状态 probe | runtime/session/skills 的 8 类 handler 回归，包含真实 request header 透传 | 本轮 11 files / 118 tests 覆盖 session、skills、probe、SSE 与 render ownership；不包含其它 API 模块 |
| Agent SSE 和 render download | owner/session/freshness stream 的 runtime-disabled 404；owner/session 初始化和 freshness 首轮 store/owner 失败的编号回显；取消时 poll 未完成会清理计时器/唤醒订阅，迟到结果不再启动下一轮 poll；download provider-disabled 501 和正常 owned stream | 两个 owner/session SSE suites 共 34 tests，freshness SSE suite 7 tests；reader cancel 测试不代表 PostgreSQL 查询已中止或代理/网络断开已演练 |
| ASR transcription route early exits | legacy handler 的完成响应和 auth-config 读取异常 503 均以 `stampRequestId` 回显规范化 ID；OIDC 继续沿用 owner boundary | `tests/api/transcription-oidc.test.ts` 6 tests；另一个并发运行的 capability suite 有一项超时，单独重跑 11/11 通过，尚未证明全 route request-id 覆盖 |
| API → worker → provider attempt → settlement | ED06/ED09/ED11 持久操作和结算链尚未完成 | 待做；当前无可复现端到端关联故障证据 |
| 全路由手写早退、普通成功响应与请求内多组件 ID 一致性 | 当前没有完整逐 handler/逐出口矩阵 | 待 ED15 复核；不能据局部测试推断全部出口完成 |

## 尚未验证

- 未做全量 Vitest、完整浏览器企业 OIDC E2E、真实 PostgreSQL 多连接/任务恢复测试、完整 `pnpm build`。ED02/ED05 浏览器验证只覆盖 mock 的选择界面和提交交互；本次的 loopback smoke 不访问 PG/Keycloak。
- ED04/ED05 首次联调尝试在加载现有 `.env.local` 并启动 instrumentation 后发现数据库 listener/agent runner 开始初始化，立即停止；未访问页面或发出 API 请求。之后使用系统 Chrome 做隔离组件 smoke：`DATABASE_URL` 置空、agent runtime 和 asset collector 显式关闭、全部外部请求拦截、身份/租户 API mock；只验证临时页面里的全局租户 gate 与 `TenantOverview`，成功后已删除临时路由并停止服务器。没有数据库连接、供应商调用或持久数据写入。应用主页完整设置弹窗导航及键盘/缩放/读屏验收仍待做。暂停组织操作尚未呈现：当前 session resolver 将被暂停的租户判为 invalid 并清除 session，需先确定可恢复的 owner 运维路径。临时路由移除后，最新标准 `pnpm exec tsc --noEmit` 通过。
- `tests/media/server-backed-media-orchestrator.test.ts` 当前单文件 52 项通过；测试使用显式事件等待避免在 provider/替代 pass 尚未启动时抢先断言。没有真实多标签、多实例或 PostgreSQL 并发运行证据。
- 没有当前生产 checkout、schema_migrations 实际内容、目标 PostgreSQL 主版本、备份恢复记录或生产部署记录。已有准备文档内的旧环境演练记录不是本次版本的发布验收。
- 未对未提交的媒体/provider 改动宣称完成；required gate 的 47 个定向 suite 通过只证明这些已运行的 suite 在当前本地依赖下通过。

## 暂停时的待办状态

整体计划在用户请求下暂停，后续需用户要求恢复。ED01 基线和可复现检查已完成。ED02 初次选择流程已覆盖，active-session 切换及跨标签页预条件待 D01 决策。ED03 已覆盖部分认证/租户恢复、生成失败反馈与凭据不写入生成会话；表单输入保留和任务恢复仍未完成。ED04 已接入当前组织/成员/审计、成员变更、自助退出和改名；完整角色可见性、设置导航及暂停租户后的 owner 恢复路径仍待验收。ED05 tenant gate 用例已运行通过，但焦点返回、对比度/缩放、读屏和完整设置导航仍须人工验收。生产配置、额度数值和高可用范围只在相应决策与恢复准备齐备后交付。

ED06–ED12 后续按 D02/D03/D04 的具体决策推进；ED08 可先使用已验证的离线工具评审获授权的隔离快照，可信归属核验和目标库导入另行实施。当前没有这些决策或真实导入授权，不启用账本、ASR 新限额、留存清理或 BYOK 恢复。
