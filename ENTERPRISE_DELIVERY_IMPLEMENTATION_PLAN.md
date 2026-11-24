# OpenMAIC 企业级交付实施计划

日期：2026-10-08。状态：ED01 可复现基线与定向检查已完成；ED02 初次租户选择已覆盖，active-session 切换等待 D01；ED03 错误分类、重试和登录恢复切片进行中；ED04 当前组织/成员/审计与成员写操作切片进行中；ED05 可访问性与本地化切片进行中；ED13 请求编号覆盖切片进行中；ED14 liveness 探测切片进行中；见 [企业交付状态](ENTERPRISE_DELIVERY_STATUS.md)。

基线：本地 `main`，HEAD `a9c9ca1`。工作区在 ED01 前已有未提交的认证、request-id、媒体供应商、开发配置和相关测试改动，具体清单见 [企业交付状态](ENTERPRISE_DELIVERY_STATUS.md)。这些改动已记录并保留；未独立验证的功能不当作 ED 已完成。本计划以当前工作区证据为基础，不把历史批次说明当作当前发布证明。

目标：用户能稳定完成企业版主流程；身份、租户、费用和任务边界可验证；故障可定位、可恢复；每次上线都有明确验收与回退路径。

本次交付物是实施计划。后续代码工作按任务推进；生产迁移、真实数据导入、发布和环境切换需在目标环境与恢复方案明确后取得相应授权。本计划不表示这些操作已经执行。

## 1. 基线事实与证据等级

“代码存在”表示静态检查发现实现；“验证通过”需要本版本的执行结果；“已部署”需要目标环境的发布证据。当前盘点没有运行测试、连接数据库或访问供应商。

| 范围 | 当前证据 | 对实施的影响 |
| --- | --- | --- |
| OIDC API 准入 | [middleware.ts](middleware.ts) 已允许生成、转录、课堂和视频导出等具体方法；保留对未列入路径的拒绝 | 逐路由验证已开放能力，不按旧准备记录重复“开闸” |
| 登录与租户 | [session.ts](lib/server/auth/session.ts)、[session endpoint](app/api/auth/session/route.ts) 支持 `tenant-required`；租户 API 已存在 | 补齐用户选择、切换、管理入口及跨标签页一致性 |
| 客户端认证处理 | [client-login.ts](lib/auth/client-login.ts) 已集中处理 `LOGIN_REQUIRED`，认证依赖故障不会跳登录 | 复用既有行为，扩展租户与业务错误处理 |
| 用量 | [usage-storage.ts](lib/server/usage-storage.ts) JSONL 写入、文件全量读取、失败仅记录警告 | 增加企业用量账本、恢复与可验证切换 |
| 配额 | [LLM quota](lib/server/personal-llm-quota.ts)、[media quota](lib/server/personal-modality-quota.ts) 已按租户和用户计额 | 复用预留/结算接口，接通可靠事件，核实全部调用路径 |
| ASR | [transcription route](app/api/transcription/route.ts) 有身份与请求限流，直接 `formData()` 解析；模态月额度目录只含 image/video/tts | 补实际字节上限、时长策略、ASR 月额度和计量 |
| 渲染 | [export-render-jobs.ts](lib/server/export-render-jobs.ts) 有 owner/tenant 绑定；并发为短时窗口软限制 | 改为事务预留和服务端生命周期结算 |
| 渲染状态 | [JobStore](render-service/src/job-store.ts) 使用进程内存，[coordinator](render-service/src/render-coordinator.ts) 的调度也在进程内 | 持久状态与完整输入后再接受任务，支持重启恢复 |
| 渲染隔离 | [docker-compose.yml](docker-compose.yml) 使用 internal 网络、出站限制及独立资源限额 | 持久化方案必须保留渲染沙箱隔离，不给它数据库凭据 |
| 课堂任务 | [classroom-job-store.ts](lib/server/classroom-job-store.ts) 文件状态与进程内锁；[runner](lib/server/classroom-job-runner.ts) 依赖当前进程；[submit](app/api/generate-classroom/route.ts) 用 `after()` 启动 | 企业任务需持久输入、执行租约和检查点，不能把 `after()` 视为持久队列 |
| 健康与追踪 | [health route](app/api/health/route.ts) 未探测依赖；request-id 第 28 批改动尚在工作区 | 区分存活/就绪，验收所有出口及异步传播 |
| 迁移与 CI | [migrations](migrations) 当前到 0023；发布文档仍写到 0019；已有 Vitest、Playwright 和 PostgreSQL CI | 修正文档，补企业专用隔离测试，不重建整套 CI |

现有 `*.db.test.ts` 中至少 LLM 配额和渲染归属测试使用 **PGlite**；不能据文件名宣称已完成真实 PostgreSQL 多连接并发验证。[现有 PostgreSQL 工作流](.github/workflows/storage-pg-contract.yml) 可扩展使用。

`docs/` 被 [.gitignore](.gitignore) 忽略，因此本计划放在仓库根目录。受版本管理的验收材料不得依赖本机忽略文档，也不得复制其中的账户口令。

## 2. 实施不变量

1. 身份、角色、tenant 和 owner 由服务端会话/任务记录建立。客户端租户选择和上下文版本只表达意图，不能作为授权证明。
2. 每个资源操作检查 owner、tenant、公开状态和删除状态。跨租户私有资源与不存在资源保持同样的 404；显式公开读取沿用已接受的政策。
3. 权限撤销、成员停用与租户停用对后续请求生效；长任务的后续持久写入也必须按既定撤销契约校验。
4. legacy 行为有独立回归。OIDC 不降级为匿名或 ACCESS_CODE。匿名数据保留与不自动认领的现有政策继续有效。
5. 外部调用前持久记录操作和额度预留。上游结果未知时保留待确认状态，不通过无条件重试制造重复费用。
6. 消息、任务与用量按“可能重复执行/投递”设计，用数据库唯一键、事务和执行版本防重；不承诺跨供应商的 exactly-once。
7. 长上传、LLM/媒体调用和渲染过程不占用长数据库事务。锁仅覆盖准入、状态更新和结算等短事务。
8. 任务和日志不保存明文 BYOK、cookie、OIDC token 或连接字符串。任务输入只保存允许的业务字段和凭据引用。
9. 所有新迁移向前执行，不重写 0001–0023 的 checksum；下一编号暂为 0024，实际分配以实施时目录为准。
10. 实施 Next.js 接口前读取安装版 `node_modules/next/dist/docs/` 的相关指南。已检查的 `after` 文档说明它受路由执行时限约束；middleware 文件约定存在弃用说明。相关更名单独评估，不混入无关任务。

## 3. 决策登记与推进规则

决策由对应任务负责人补充具体提案与演示后确认。缺少决策只阻塞依赖它的任务，不阻塞基线整理、隔离验证和其他独立工作。

| ID | 必须明确的事项 | 推荐方向 | 阻塞范围 |
| --- | --- | --- | --- |
| D01 | 同一会话的标签页切换规则；旧客户端兼容窗口 | 同一浏览器会话共用当前租户；切换增加服务端上下文版本；陈旧写入明确拒绝，所有标签页同步更新 | ED02 的正式启用 |
| D02 | 企业账本与模态额度政策 | OIDC 使用 PostgreSQL 账本；沿用 UTC 月和模态原始单位；真实/估算/待确认分别呈现；BYOK 与托管分别列规则 | ED06–ED08 的切换和额度配置 |
| D03 | ASR 大小、最长音频、格式、超时、并发和月额度 | 按音频秒数计量；解析前限制实际字节；给出供应商约束与隔离测量后确定数值；不信任客户端时长 | ED07 的 ASR 启用 |
| D04 | 任务产物留存、恢复与凭据失效行为 | 试点可沿用当前渲染产物 TTL，元数据单独留存并显示“产物已过期”；无可用 BYOK 引用时转待补输入；未知上游结果先对账 | ED09–ED12 的恢复和清理政策 |
| D05 | 交付功能列表、运行拓扑和客户性能要求 | 区分单节点受控试点与高可用交付；功能清单内的聊天、白板、评分和导出均需验收；高可用要求 ED17 | ED16；高可用则追加 ED17 |
| D06 | 部署 PostgreSQL 主版本、目标环境、RPO/RTO 与现有回退政策的演练 | 按实际目标版本演练；备份必须恢复；已接受的 legacy 回退数据可见性政策不重新决策，但须在交付证据中准确展示 | ED16 的生产操作 |

对已有明确会话政策、角色政策和公开读取决策不重复征求许可；D01–D06 只补充新行为与尚无数值的交付约定。

## 4. 批次与依赖

ED 编号独立于历史 1–28 批，避免把未提交工作自动计入新任务完成度。下表优先级表示交付顺序；ED01 基线已完成，ED02 初次选择已覆盖但 active-session 切换等待 D01，ED03 分类/重试切片进行中，ED04 管理概览与成员变更切片进行中，其余任务待实施。工作量 S/M/L 为相对复杂度，不是工期承诺。

| 任务 | 交付结果 | 优先级 / 规模 | 前置条件 | 主责 / 复核 |
| --- | --- | --- | --- | --- |
| ED01 | 真实交付基线和版本证据（路由静态覆盖完成；逐 handler 授权矩阵留至 ED15） | P0 / S | 无 | 开发 / QA |
| ED02 | 选择与切换租户，不产生陈旧写入 | P0 / L | ED01、D01 | 开发 / 安全与 QA |
| ED03 | 统一认证与业务失败交互 | P0 / M | ED01；租户场景依赖 ED02 | 前后端 / QA |
| ED04 | 角色与成员管理界面可用 | P1 / M | ED02、ED03 | 前后端 / QA |
| ED05 | 关键流程满足交互和无障碍标准 | P1 / M | ED03；最终验收依赖 ED04、ED12 | 前端 / QA |
| ED06 | LLM 操作、额度与用量可靠闭环 | P0 / L | ED01、D02 | 后端 / DBA 与 QA |
| ED07 | 媒体和 ASR 有完整输入/额度边界 | P0 / L | ED06、D02、D03 | 后端 / 安全与 QA |
| ED08 | 企业用量读取和历史切换可对账 | P0 / M | ED06、ED07、D02 | 前后端 / DBA 与 QA |
| ED09 | 渲染服务重启后任务可解释、提交可防重 | P0 / L | ED01、D04 | 后端 / 运维与 QA |
| ED10 | 渲染严格准入及无人轮询时的恢复 | P0 / L | ED09 | 后端 / DBA 与 QA |
| ED11 | 课堂任务持久执行和检查点恢复 | P0 / L | ED06、ED07、D04 | 后端 / QA |
| ED12 | 任务进度、取消、恢复和过期界面 | P0 / M | ED02、ED03、ED10、ED11 | 前后端 / QA |
| ED13 | 失败编号、任务日志与指标可关联 | P1 / M | ED01；最终覆盖依赖 ED06、ED09、ED11 | 后端 / 运维 |
| ED14 | 就绪检查和依赖故障降级 | P1 / M | ED01；最终覆盖依赖 ED06、ED09、ED11 | 后端 / 运维 |
| ED15 | 企业 CI 和故障/授权 E2E 门槛 | P0 / L | 夹具可从 ED01 后开始；最终门槛依赖 ED02–ED14 | QA / 开发 |
| ED16 | 迁移、生产构建、回滚与小流量交付 | P0 / M | ED01–ED15、D05、D06；高可用时追加 ED17 | 运维 / QA 与交付负责人 |
| ED17 | 高可用拓扑可跨副本工作 | 扩展 / L | ED06、ED08–ED14、D05 | 后端与运维 / QA |

默认顺序：ED01 → ED02/ED03 → ED04；ED06 → ED07 → ED08；ED09 → ED10；ED11 → ED12 → ED05；随后 ED13/ED14 收口 → ED15 → ED16。各任务的定向验证随任务实施，不等到 ED15 才补验证。

可独立推进的工作流不等于必须使用多代理。共享 `with-owner`、session、API 错误契约、迁移编号和 `llm.ts` 的改动顺序执行；确需并行时先约定接口和文件归属。

## 5. 任务实施契约

### ED01：建立可追溯的交付基线

**结果**：能从一个清单准确判断某功能的实现、验证和部署状态。

**入口**：`ENTERPRISE_AUTH.md`、`ENTERPRISE_ROUTE_INVENTORY.md`、`ENTERPRISE_REFACTOR_PREPARATION.md`、`.trae/documents/完整多租户实施计划.md`、`scripts/audit-enterprise-routes.mjs`、`migrations/`。

**工作**：

- 保存 HEAD、工作区差异清单和环境类别；分别复核未提交的第 28 批与媒体改动，保留用户工作，不自动提交或重置。
- 路由审计采用“方法 + 路径 + handler 授权 + 成本/输入边界 + 公开例外”，检查 SSE、Server Action 和资产下载；生成脚本只作覆盖证据。
- 历史准备记录标注日期和后续取代关系；修正发布迁移范围、单租户旧描述和尚未证实的全覆盖声明。
- 建立受版本控制的功能验收表，字段包含负责人、依赖决策、代码 revision、检查命令/环境、结果和遗留项。

**验收**：

- [ ] 静态生成结果与人工逐入口清单一致；漏项和保持关闭的入口有解释。
- [ ] 新声明有明确证据；旧记录不再与当前版本状态混淆。
- [ ] 本机文档和证据无真实口令、token、连接字符串；工作区原有改动完整保留。

**验证与回退**：文档差异、链接、route audit 和 `git diff --check`；本任务不连接数据库。回退仅撤销本任务文档变更。

### ED02：租户选择、切换和会话一致性

**结果**：多租户用户能进入正确组织；旧标签页和延迟响应不会污染新组织的界面或写入。

**入口**：`lib/server/auth/session.ts`、`tenant-admin.ts`、`app/api/auth/session/route.ts`、`app/api/tenant/active/route.ts`、`lib/server/agent-runtime/with-owner.ts`、`app/layout.tsx`、客户端身份/缓存入口。

**工作**：

- 增加全局租户选择界面：无成员时显示联系管理员；一个/多个成员按既有服务端规则展示；`tenant-required` 不走反复登录。
- 按 D01 引入服务端会话上下文版本（拟称 `tenant_context_version`）；切换事务校验成员/tenant 活跃状态并更新版本，返回最新 session 快照。
- 客户端写操作携带预期版本；服务端只用它拒绝陈旧意图。短数据库写入在事务中校验版本；任务提交将已验证的 tenant/owner 固定到持久记录，切换后不重定向到新 tenant。
- 与切换竞争的写入按数据库串行结果解释：切换之前获准的操作仍属于原 tenant；切换之后的陈旧写入拒绝；不在长外部调用期间持有会话锁。
- 给新旧客户端预条件协议制定兼容和启用顺序；旧包需明确刷新升级，不能突然改变所有公开响应。
- 切换时处理未保存输入，停止旧流/轮询，更新缓存作用域和界面世代；跨标签页广播后重取服务端状态，广播内容不授予身份。
- 后续任务写入重新验证原 tenant 的成员资格和权限；撤销后进入明确拒绝/待处理状态，费用结算保留。

**验收**：

- [ ] 0/1/多个租户、租户停用、成员暂停、会话失效与 DB 故障均有可执行界面。
- [ ] 标签页 A 切换到 B tenant 后，标签页 B 的旧版本写入失败并刷新；伪造版本或 tenant 不绕过授权。
- [ ] 延迟的旧响应不显示在新 tenant；草稿不会自动归入另一个 tenant；旧任务仍受原归属约束。
- [ ] 两个真实 PG 连接验证切换/写入竞争；已授权的短事务线性顺序清楚，跨租户资源仍 404。

**风险与回退**：会话 schema 与请求预条件属于共同契约。先部署加列/兼容读取，再部署新客户端，最后启用预条件；回退时暂停切换并处理旧快照，不能通过跳过 tenant 校验恢复服务。

### ED03：统一失败交互与安全恢复

**结果**：用户知道操作是否成功、失败原因和下一步；付费请求不会因重登录或重试发生重复调用。

**入口**：`lib/auth/client-login.ts`、`components/auth-session-notice.tsx`、`lib/server/api-response.ts`、现有生成/上传/聊天/设置调用方。

**工作**：

- 复用现有响应 envelope，建立客户端错误分类：登录、tenant-required、权限、冲突、输入、短限流、月额度、供应商不可用和依赖故障；需要的新增字段采用兼容扩展并同步调用方。
- 短期限流使用 `Retry-After`；额度耗尽显示单位/周期/重置时间，不用同一倒计时自动重试。
- 登录恢复只恢复安全输入和导航，不自动重放生成、删除、导出或付费请求；重试使用同一业务幂等编号。
- 草稿按用户与 tenant 作用域保存，排除凭据；登出/账号变化后的展示与保留按原政策及 D01 处理。
- 错误包含可复制故障编号，错误文案不展示堆栈、原始供应商响应或凭据。

**新增凭据持久化切片（2026-10-08）**：新建 generation session 只保留 PDF provider ID，不再快照 API key、访问密钥或 base URL；提取时从当前设置读取 provider 配置。读取旧 session 时会先剥离顶层和 document source 上的旧配置字段并立刻重写 sessionStorage，所有后续 session 写入也统一经过脱敏函数。`safe-session` 的 3 项测试通过，覆盖序列化无凭据、清理不修改原对象及任意旧 provider ID 拒绝配置索引。旧 session 使用当前配置，用户需确保原 provider 配置仍可用；失败后的草稿/任务恢复与按 tenant 隔离仍未完成。

**验收**：

- [ ] 各错误类别在核心页面有一致处理；认证服务故障不触发登录循环。
- [ ] 表单输入保留正确，登录后需要用户再次确认付费操作；未知提交状态优先查任务。
- [ ] 429 缺少/非法 `Retry-After` 时仍有有界操作；月额度拒绝不会持续请求。

**验证与回退**：纯错误分类与关键页面浏览器验证，覆盖中英文；保留既有响应结构。回退客户端时仍保留服务端幂等与授权约束。

**已交付切片（2026-10-08）**：`lib/generation/client-failure.ts` 集中分类并抑制认证、授权、配额及输入类失败的结果重试；`lib/generation/retry-after.ts` 解析秒数和 HTTP 日期并将提示限制为一天。生成 preview 显示登录/租户/权限/认证依赖/供应商凭据/限流/配额/内部错误提示，读取 owner-boundary 返回的 `x-request-id` 并允许复制；图片/视频媒体的用户触发重试先恢复登录或租户状态，不自动重放供应商请求。`recoverClientAuthFailure` 将精确 `LOGIN_REQUIRED` / `TENANT_REQUIRED` HTTP envelope 统一映射到登录或选择页恢复，生成之外也覆盖全局组织选择和设置管理；新增用例验证不误处理普通 `FORBIDDEN` 和非 JSON 响应。新增文案已加入全部 12 个 locale。生成分类/重试 4 个 suite（34 tests）、认证/租户恢复 3 个 suite（32 tests）、媒体失败分类 suite（12 tests）及媒体恢复集成用例通过；`server-backed-media-orchestrator.test.ts` 52 tests 通过。该并发套件曾有两项失败，复核发现测试在事件尚未发生时就断言/中止；改成等候替代 pass 和 provider 请求等明确事件后通过，运行时代码未改。相关 ESLint 和 TypeScript 检查通过。真实多标签/多实例并发与表单恢复仍待做。

### ED04：租户、成员与审计管理界面

**结果**：owner/admin 能完成已支持的管理操作，member/viewer 得到准确的可见权限。

**入口**：`app/api/tenant/*`、`lib/server/auth/permissions.ts`、`authorize.ts`、`tenant-admin.ts`、`components/settings/`。

**工作**：

- 在既有设置导航加入当前 tenant、成员列表、角色变更、暂停/恢复、移除、自助退出与审计视图。
- owner-only 的 tenant 设置按权限呈现；确认窗口展示具体对象和后果；服务端秩守卫及最后一个 owner 保护继续执行。
- 管理操作使用原 API，不在前端重建权限真源；并发变更发生冲突时重新读取，不覆盖他人变更。
- 多租户变更后清理对应缓存；暂停自己或退出组织时进入选择/无成员界面。

**验收**：

- [ ] 四角色展示与服务端权限一致；隐藏入口也不能通过直接请求越权。
- [ ] 最后一名 active owner 保护、跨租户 404、重复点击、并发变更与审计记录均验证。
- [ ] 成功反馈只在服务端成功后出现；失败有原因和下一步，审计读取有界且只读本 tenant。

**风险与回退**：优先完成既有 API 对应界面，不增加自助租户创建。回退界面不撤销已有成员变更；数据恢复另按审计和受控操作执行。

**已交付切片（2026-10-08）**：General Settings 显示当前 OIDC tenant 和角色；owner/admin 可读成员及最近 50 条审计，member/viewer 只读自身组织/角色。成员已有账户可按 user ID 加入，可变更其允许管理的低权限角色、暂停/恢复、移除；member 可自行退出，owner 可改名。目标用户及动作由确认提示展示，所有写入走现有 API。审计显示角色变更前后值与操作时间；管理请求遇到明确的 `LOGIN_REQUIRED` / `TENANT_REQUIRED` 时走统一登录/组织恢复入口，写入期间用状态播报提示等待。隔离 Chrome/mock smoke 实测成员角色更新及审计刷新；完整 SettingsDialog 导航仍待验证。暂停组织控件尚未呈现：当前 session resolver 会把暂停租户判为 invalid 并清除登录态，需先补定 owner 恢复路径。47 项 tenant API 定向测试通过；组件 ESLint 与最新标准 TypeScript 检查通过。

### ED05：关键流程的交互与无障碍验收

**结果**：主流程的加载、空状态、失败、成功和长任务状态可理解，键盘及辅助技术能完成关键操作。

**入口**：既有 `components/ui/`、生成预览、课堂、答题、设置、ED04/ED12 新界面。

**工作**：

- 复用现有组件和依赖，对每个交付页面建立状态清单，不做全站视觉重设计。
- 加载进度来自真实持久状态；只有阶段数据时显示阶段和等待提示；可用内容与未完成内容明确区分。
- 验收焦点顺序/返回、键盘、标签、表单错误、状态播报、对比度、缩放、按钮目标大小与减少动态效果。
- 将 WCAG 2.2 AA 映射到受影响页面的检查表；自动检查与人工键盘/读屏结合，不能仅凭工具通过宣称全站合规。

**验收**：

- [ ] 登录/租户选择、建课、答题、管理和导出全程可用键盘操作。
- [ ] 对话框关闭后焦点返回正确；进度和错误可感知；窄屏、缩放及减少动画模式不挡住操作。
- [ ] 所有发布范围内的失败态有演示证据，范围与未覆盖标准明确记录。

**验证与回退**：组件与浏览器定向检查，人工键盘/辅助技术验收；回退仅受影响组件，保留服务端安全行为。

**已交付切片（2026-10-08）**：ED02 的组织选择弹窗将标题、说明、空状态、选择动作及状态变化消息接入全部 12 个 locale；组织角色与停用状态复用已有本地化标签。继续按钮可访问名称包含对应组织名，弹窗有明确标题和说明；组织选项较多或视口较矮时，弹窗会限制最大高度并在内部滚动。首页设置入口、设置关闭按钮和成员角色下拉有可访问名称，ED04 管理操作等待时使用状态播报和 `aria-busy`。隔离 Chrome/mock smoke 检查了组织选择和成员角色管理的主要读写状态。格式、相关 ESLint、最新标准 TypeScript、租户 API suites 和 `git diff --check` 通过。键盘焦点回退、窄视口缩放、对比度、完整 SettingsDialog 导航和屏幕阅读器仍需浏览器人工检查；此切片不代表 WCAG 合规验收。

**新增租户选择进度与减少动态效果切片（2026-10-08）**：租户 gate 在获知 session 为 `tenant-required` 后立即显示 modal loading 状态，租户列表加载与选择提交均提供可播报的 status，相关文案覆盖 12 个 locale；Dialog Content 标记 `aria-busy`。共享 Dialog overlay/content 在 `prefers-reduced-motion: reduce` 下关闭动画和 transition。新增 `e2e/tests/tenant-required-gate.spec.ts` mock-browser 验收：等待受控租户列表请求期间检查 loading announcement；核对暂停项不可选、Escape 不绕过必选 gate、连续 Tab 焦点留在对话框内、Enter 提交 active 组织、提交中播报、reload 后 gate 解除，并检查 reduced-motion。使用 loopback-only legacy dev server（DB、Agent Runtime、资产采集关闭）及系统 Chrome 实跑后发现普通 `motion-reduce:animate-none` 被同 specificity 的 `data-open:animate-in` 覆盖；改为 important reduced-motion utilities 后，隔离 browser 用例 **1 passed**，相关 TypeScript、ESLint、Prettier 和 `git diff --check` 通过。浏览器 API 全部 mock，不代表 OIDC 或实际数据库验收。`check-i18n-keys` 仍只报原有 10 个 locale 缺少 `settings.usage.estimatedQuotaTokens`，新增租户进度文案均已对齐。此切片不替代键盘焦点返回、缩放/对比度和屏幕阅读器人工验收，也不代表全站 WCAG 合规。

### ED06：LLM 用量与额度的可靠闭环

**结果**：OIDC 生成有可追溯操作记录，用量可去重、可恢复，结算异常不会变成无记录的付费调用。

**入口**：`lib/ai/llm.ts`、`lib/server/personal-llm-quota.ts`、`usage-attribution.ts`、`usage-storage.ts`、持久化 provider 与迁移接口。

**拟议模型**（实际名称随设计复核确定）：

- 操作：UUID `operation_id`，服务端 tenant/owner、父任务、步骤/尝试、模态、供应商/模型、request-id、状态、时间与输入摘要 hash；不保存密钥或原始提示词。
- 用量事件：稳定事件键与 operation/attempt 关联、真实 usage、独立估算、单位、来源、待确认状态；金额不是现有计量范围。
- 结算：既有 reservation 与 operation 关联；实际额度更新与对应事件/持久待办在同一事务落地，重复处理不重复扣额。

**工作**：

- 在统一 LLM 边界做一个端到端切片：调用前持久记录/预留，调用后原子结算/写事件；复用统一归属与既有配额引擎，不创建并行计费系统。
- 每个模型步骤和可识别的供应商尝试独立标识；沿用关闭隐藏重试的 OIDC 约束。流式中断、取消、超时和工具循环同样纳入。
- 上游成功但 DB 暂时失败时返回真实业务结果，同时原有 durable operation 保持待结算；已知 usage 尽力重试持久化，崩溃后无法恢复的真实值明确转估算/待对账。
- 故障恢复根据上游 receipt 或已持久结果对账；未知结果不释放为零费用。保证不会声称 DB 故障期间所有真实 token 都能准确恢复。
- 企业读/写缺少可信 tenant 时拒绝，不隐式退回 default；legacy 文件接口保持既有行为。

**验收**：

- [ ] 普通与流式调用、工具多步骤、超时、断流、取消分别有 operation 和事件。
- [ ] 同一结算事件重复执行不重复扣额；并发申请额度不超出既定数据库契约。
- [ ] 调用前 DB 故障不触达供应商；调用后故障/进程崩溃可恢复为准确结果或明确估算/待确认。
- [ ] 两 tenant 同用户的账本、预算和读取隔离；凭据不进入日志、事件或错误。

**验证与回退**：PGlite 验证 schema/查询，真实 PostgreSQL 多连接验证锁/事务，fixture 供应商验证外部调用次数。先加 schema、兼容读取和禁用状态下探测；启用后回退须保留操作恢复 worker，不允许仅切回 JSONL 丢掉待结算记录。

### ED07：媒体与 ASR 的完整准入和计量

**结果**：图片、视频、TTS、ASR 无论直接路由或后台生成，均有明确输入上限、主体、额度和故障行为。

**入口**：`app/api/generate/{image,video,tts}/route.ts`、`app/api/transcription/route.ts`、`lib/server/media-quota-route.ts`、媒体/音频适配器、`classroom-media-generation.ts`、agent-runtime 的媒体调用。

**工作**：

- 列出 direct、classroom、agent、供应商后台异步轮询全部调用路径，在真正的 provider 边界接通 ED06 的 operation 和模态 reservation，避免路由与底层双重扣额。
- ASR 用受限流式读取或等价方式在 `formData()` 完整缓冲前限制实际字节；校验字段类型、文件数、格式/内容与时长。chunked 上传也执行上限。
- 按 D03 使用可信解析得到时长或单次允许上界预留；供应商提供可信实耗后结算。无法可靠获取时长时有确定拒绝/保守额度行为。
- 新迁移扩展 ASR modality、单位、策略和约束；计量单位舍入规则、UTC 月边界和迟到结算行为文档化。
- 保留托管 provider 优先级、BYOK 公网校验、DNS pinning/redirect 边界及输出大小控制；核查各 adapter，而非仅看 URL 预检。
- 视频供应商返回外部任务 ID 时将其持久关联操作，并限制轮询、取消、任务截止和结果回收；结果未知不重复创建任务。

**验收**：

- [ ] 超大、无 Content-Length、畸形、假 MIME、过长、缺字段和多个文件均在有界资源内拒绝。
- [ ] 四模态及所有调用路径各计量一次；月额度不足/策略缺失/DB 故障在调用前确定拒绝。
- [ ] BYOK/托管、SSRF、断线、上游任务长时间 pending、异常 usage 和结算失败有验证结果。

**风险与回退**：尺寸/时长数值须经 D03 定案；若需要新解码依赖，先检查现有库与容器工具并验证处理恶意文件的隔离。上线先按供应商和模态试点；关闭对应能力仍需继续处理已提交任务和待结算记录。

### ED08：用量界面与历史数据切换

**结果**：用户看到可靠的本人当前 tenant 用量，迁移前后能够按源记录对账，旧无归属行不会误归给用户。

**入口**：`app/api/usage/route.ts`、`components/settings/usage-dashboard.tsx`、`lib/server/usage-storage.ts`、新账本、迁移/导入脚本。

**工作**：

- 企业读侧改为有 tenant+owner 条件、时间范围和有界查询的 PostgreSQL 聚合；保留现有 API 兼容字段。
- 界面区分真实、估算、待确认、预留/已用和额度重置时间；tenant 管理汇总按未来明确授权另行交付，不扩展个人读取权限。
- 历史 JSONL 导入先对隔离快照 dry-run，按源文件标识+偏移+内容 hash 保证重跑安全；旧时间戳 id 不是全局唯一证明。
- 有可信归属的行按原归属导入；无 tenant/owner、不合法或矛盾行隔离分类，不按模型、时间或邮箱推断归属。
- 推荐受控短暂停写窗口：冻结快照 → 导入/对账 → 企业写和读同时切换 → 恢复。需要零停机时先设计 durable 双写/outbox 和水位协议，禁止临时 best-effort 双写。

**验收**：

- [ ] 总行数 = 导入 + 已存在去重 + 隔离 + 明确排除；各 owner/tenant/模态/周期金额之外的原始数量可核对。
- [ ] 同一快照重跑无重复；中断后能继续；读取分页/聚合有界；历史无归属行不出现在个人数据中。
- [ ] 切换前后 UI 数值含义一致，估算不伪装为供应商报告；legacy 行为保留。

**风险与回退**：真实历史导入属于数据变更，先确认目标库和备份。账本启用后回退 reader 时保持新 writer 和恢复服务，或用已验证导出/兼容 reader；不能无对账地退回旧文件写入。历史原文件先保留只读备份。

**独立准备切片（2026-10-08）**：新增 `scripts/audit-usage-snapshot.mjs`，对显式指定的只读隔离 JSONL 快照输出逐行 NDJSON 与最终 summary；以逻辑源标识、字节偏移和内容 hash 建立稳定源键，缺失归属、非法记录及矛盾单位隔离，空白行明确排除。有效且有归属字段的行仍标为 `reviewRequired`，不把字段存在当作可信归属或可导入证明。工具保留真实 token 字段与独立估算、现有模态原始单位，内存按 chunk/单行上限控制并等待输出背压；失败或文件变化不产生完整汇总。合成快照的 Node tests **8/8 passed**，已加入主 CI，操作契约见 [离线快照核对](ENTERPRISE_USAGE_SNAPSHOT_AUDIT.md)。没有访问真实文件、数据库或供应商，没有导入、去重事务、账本读写切换或新额度政策。ED08 主任务仍等待 D02/ED06/ED07；不将此准备切片计为 ED08 完成。

### ED09：渲染服务的持久接受、重启与防重

**结果**：收到接受响应的渲染任务，其输入和状态已持久保存；网络重试不会再创建第二个渲染。

**入口**：`render-service/src/job-store.ts`、`render-coordinator.ts`、`main.ts`、`types.ts`、容器与 compose；应用提交/查询/取消/下载代理。

**设计方向**：应用 PostgreSQL 保存业务任务、归属与恢复意图；隔离渲染服务先通过既有 JobStore seam 增加持久 manifest 和专用数据卷。应用单向调用渲染服务获取状态，渲染沙箱不访问 PostgreSQL，也不持有应用数据库凭据。持久 JobStore 只是基础，还必须恢复 coordinator 的调度与输入。

**工作**：

- 应用生成稳定业务提交编号并在发送上游前保存任务意图；内部提交协议关联同一编号、规范化输入 hash 和执行版本。
- 服务完成受限上传、校验并持久保存输入和 manifest 后才返回 202；同编号同内容返回原任务，同编号不同内容产生明确冲突。旧任务 ID 和旧查询接口保持可读。
- 用原子替换及明确 flush 策略保存 manifest；中间目录、最终目录、元数据不一致时有扫描与修复规则；清理仅针对服务自己创建、过期且不活跃的文件。
- 启动时恢复 queued；对 running 验证旧执行者是否停止，标记 interrupted 或按安全政策重新排队；不能凭时间过期允许两个执行者同时提交产物。
- 执行版本决定唯一可提交结果者；旧版本产物写入独立临时路径，CAS 成功后才成为可下载结果。
- 持久取消意图、终态和产物过期状态；保留出站限制、解压/路径防护、无网 Chromium、上传/展开上限、CPU/RAM/队列限制。

**验收**：

- [ ] 202 后重启服务仍能查到任务；queued 输入可恢复，running 不成为无解释的消失任务。
- [ ] 响应丢失后重试或两个请求并发提交同编号，都只创建一个任务；内容不同产生冲突；越权提交编号不泄露他人状态。
- [ ] 磁盘满、manifest 损坏、部分上传、进程崩溃和孤儿文件有有界恢复行为；持久化失败不会返回已接受。
- [ ] 恢复测试中不会双重发布结果；沙箱依旧不能连接数据库、公网或应用敏感接口。

**风险与回退**：为 OIDC 试点新增持久路径，不把 legacy 内存实现立即删除。已接受 durable 任务需继续由兼容服务处理；回退前停止新提交并完成或明确终结存量任务。暂不承诺多渲染副本，共享产物与分布式调度由 ED17 交付。

### ED10：严格渲染准入与独立恢复服务

**结果**：同 tenant/owner 的活跃任务不能因并发提交突破上限；用户关闭浏览器后任务仍会结束、释放名额并留下状态。

**入口**：`lib/server/export-render-jobs.ts`、`app/api/export-video/render/*`、ED09 的服务协议、后台 reconciler 入口。

**工作**：

- 拟增加持久 render intent/slot，事务内按 tenant+owner 串行化准入，唯一提交键防重复占用；初始数量沿用当前上限 3，配置修改另记策略。
- 转发上传前完成短事务预留，提交后将同业务编号关联服务任务；不在上传期间持有数据库事务或锁。
- uploading/queued/running/cancel-requested/submission-unknown 按政策占用名额；terminal/已确认未接受才释放。租约到期先查询服务，不能仅按 15 分钟窗口释放仍运行任务。
- 应用侧持久 reconciler 从数据库认领待查任务，独立于用户轮询；用租约和执行版本控制重复 worker，限制查询频率、超时和重试次数。
- 上游提交未知时用同编号查询 ED09 记录；确认未接受且可以重复时才重新提交。长时间不可确认转需运维处理，保留风险界限和可操作说明。
- 本人状态/取消/下载继续校验 owner+tenant；过期产物对已获授权用户明确显示，外人仍得到统一 404。

**验收**：

- [ ] 真实 PG 多连接同时提交超过上限，最多只有 3 个任务获准，拒绝者不转发 ZIP、不消耗名额。
- [ ] 任务长于旧 15 分钟窗口时仍受上限约束；同用户不同 tenant 独立；全局 render-service 队列仍受资源限额约束。
- [ ] 无浏览器轮询也能终结任务并释放名额；DB 暂时故障后 reconciler 恢复，重复取消/终态回写不会重复释放。
- [ ] 提交与绑定之间崩溃、取消与完成竞争、服务失联均无越权、隐式双提交或无记录释放。

**风险与回退**：新旧限制并行观测后切换到严格限制；退出严格模式前先排空/确认 durable intent，保留其恢复服务。对长时间失联的任务，运维释放必须有服务停止/任务终结证据。

### ED11：课堂任务的持久执行与安全恢复

**结果**：课堂任务在应用重启后有可解释状态；已完成场景不因恢复而重新付费生成。

**入口**：`classroom-job-store.ts`、`classroom-job-runner.ts`、`classroom-generation.ts`、`classroom-storage.ts`、`app/api/generate-classroom/*`、现有 agent 的 PostgreSQL claim/lease 模式。

**工作**：

- 企业路径持久保存 allowlist 输入、原 tenant/owner、操作 ID 和检查点；PDF/媒体使用授权资产引用或受控业务数据，不保存 `webSearchApiKey` 等明文凭据。
- 复用现有 PostgreSQL claim/lease 的设计模式，限定到 classroom 域，不为本任务重写 agent 包公共契约。
- 用独立、受进程管理器管理的编译后 Node worker 认领任务；生产镜像包含 worker 可执行产物。`after()` 可保留兼容通知，但不作为唯一执行保证。
- claim 采用短事务/行锁与 worker 租约、执行版本；阶段结果和场景检查点持久后才更新可见进度。原文件与 PG 状态之间使用可重跑的发布步骤/结果 hash。
- 恢复时复用已完成、已结算步骤；上游结果未知的步骤沿 ED06 规则对账；无法重新取到 BYOK 时转待补输入，由原用户重新提供，不自动切换供应商或账号。
- 取消检查在步骤之间及可中断调用中执行；发布最终课堂前校验原租户授权和执行版本。未完成草稿与可公开课堂有明确边界。
- 长任务发生成员/tenant 停用时停止后续有权限要求的写入/调用，保存已有计费事实；后台任务不借用操作者随后切换的新 tenant。

**验收**：

- [ ] 在大纲、场景、媒体、最终持久化处分别重启，任务均能继续或明确等待处理；已完成步骤不重复计额。
- [ ] 两个真实 worker 竞争同任务时仅一个有效执行者发布；旧租约执行者不能覆盖新结果。
- [ ] 没有可用 BYOK 时显示待补输入；任务表、临时文件、错误与日志无 API key。
- [ ] 取消、权限撤销、部分场景失败及最终保存失败保留可恢复检查点，不显示虚假完成。

**风险与回退**：业务 pipeline 当前在内存生成，检查点落地需分阶段实施，先大纲/单场景端到端切片。旧文件任务通过显式兼容 reader 读取，新 worker 不盲目接管未知历史输入；回退前暂停企业新任务，存量由兼容 worker 完结。

### ED12：任务进度、取消、恢复和产物过期界面

**结果**：用户刷新、断线或重新登录后能继续查看有权访问的任务，并理解取消/恢复的真实结果。

**入口**：生成预览、课堂等待界面、导出弹窗及 hooks；ED10/ED11 的任务 API。

**工作**：

- 按业务任务类型定义状态映射：提交中、已排队、执行中、待确认、待补输入、取消请求中、已取消、成功、失败及产物过期；内部细节不直接变成用户文案。
- 复用现有任务 ID 及导航入口实现恢复，不要求重建全站任务中心；查询只展示当前用户/tenant 任务。
- 轮询/SSE 有退避、超时、卸载清理与最后事件/版本处理；断流后从授权快照重建，不只靠进程内通知。
- 防重复点击与服务端幂等一起工作；取消请求得到受理不立即显示已取消；已失败任务只在安全重试条件满足后给出重试入口。
- 课堂展示已生成内容和剩余步骤；导出显示队列/处理阶段及下载有效期；未知费用和待确认状态保持可见。

**验收**：

- [ ] 关闭页面后任务持续，重新登录/刷新恢复同任务；重试不创建第二个任务。
- [ ] 切 tenant 后旧 stream/response 不进入新界面；取消与完成竞争最终显示服务端真状态。
- [ ] 产物过期、服务失联、待补凭据、权限撤销均有可执行操作和明确说明。

**验证与回退**：受控任务 fixture 的浏览器测试，辅以小型真实渲染/课堂恢复 smoke；回退 UI 时不能移除后台任务恢复，也不能把未知提交作为失败重新发送。

### ED13：故障关联、结构化日志和运行指标

**结果**：用户提供故障编号后，运维能定位对应 API、后台任务、供应商尝试与结算。

**入口**：`lib/server/request-id.ts`、`with-owner.ts`、`auth/authorize.ts`、middleware、`lib/logger.ts`、`instrumentation.ts`、ED06/ED09/ED11。

**工作**：

- 先独立复核工作区第 28 批，建立覆盖矩阵：middleware 拒绝、owner/tenant 管理拒绝、auth 路由、handler 提前返回、异常、SSE 与下载；检查一请求只有一个回显值。
- 引入 requestId/operationId/jobId/attempt 的结构化关联字段。下游相同 request-id 不是用户身份或上游可信性证明。
- 后台任务保存起始关联，新的轮询请求有自己的 request-id 并指向同 job；恢复任务不伪造仍处于原 HTTP request 中。
- 记录请求拒绝/错误、生成成功率、分阶段耗时、队列等待、活跃任务、未知提交、待结算年龄、DB 连接池和存储失败。
- 指标标签使用有限路由模板、状态和供应商枚举；用户/tenant/请求/任务 ID 仅用于受控日志，避免高基数指标。
- OpenTelemetry 在需要跨服务 trace 时采用 adapter 接入；先核对现有依赖与 Next instrumentation。Collector 故障不影响授权与业务，采样和脱敏配置可审计。

**验收**：

- [ ] 普通、提前拒绝、500、断流、异步失败都能关联；非法入站 request-id 被规范处理，日志和响应一致。
- [ ] 至少一次 API → worker → provider attempt → settlement 故障可由编号复现定位。
- [ ] 无凭据/原始文档正文日志，指标 cardinality 有预算；监控后端故障不拖垮业务。

**风险与回退**：日志 schema 变更同步查询和告警；关闭 trace exporter 不关闭本地结构化日志或账本。未验证的“所有出口已覆盖”不得写入发布说明。

**已交付切片（2026-10-08）**：既有 `withRequestOwnerId` / OIDC middleware 之外，`withTenantPermission`、`withAuthenticatedIdentity` 和手工 session 解析的 `/api/tenant/active` 也统一回显受验证的 `x-request-id`，覆盖租户管理 API 的成功和提前拒绝响应。回归测试验证请求编号穿过租户列表拒绝/成功、自助退出和首次 tenant 选择。ESLint、相关 Vitest 与最新标准 TypeScript 检查通过。仍缺全路由提前拒绝/SSE/下载/worker-operation-settlement 覆盖矩阵；本切片不宣称所有 API 均可关联。

**新增认证/middleware 出口切片（2026-10-08）**：OIDC `/api/auth/login`、`callback`、`logout`、`session` 在 handler 外统一规范并回显 request-id，覆盖 early refusal、redirect、204、成功读取及意外异常降级；legacy `/api/access-code/status`、`/verify` 的成功、拒绝及意外异常兜底也统一回显。OIDC edge refusal、未登录页面 redirect、workbench disabled 404、legacy access-code gate 401 由 middleware 自身设置同一 request-id。错误日志仅保留异常名，响应不带底层错误消息。结合 callback、租户边界、owner-gate、middleware 和 access-code regression，9 个 suite 共 **108 tests passed**。`middleware` 未迁移到 Next 16 的 `proxy` 命名；其它手工 API、SSE/下载和后台 operation/attempt/settlement 仍待完成。

**新增 SSE/下载切片（2026-10-08）**：owner 与 per-session Agent SSE 在 runtime 未配置时的 404、存储初始化/会话读取失败时的通用 503，以及 render 下载在 provider 未配置时的 501，均规范化并回显 request-id；失败日志只写编号和异常类型，不写原始错误。正常 SSE、鉴权拒绝和下载内容仍由既有 owner boundary 设置。三个定向 suite（owner events、session events、export ownership）共 **47 tests passed**。其它手写 API 早退、完整流断开路径、后台 operation/attempt/settlement 关联仍待盘点和验证，ED13 仍未完成。

**新增 SSE 取消切片（2026-10-08）**：session 与 owner stream 在存储轮询进行中取消 reader 时，会清理 timer 并取消 wake subscription；迟到的存储结果不会再排程下一次轮询。定向验证 `session-events-route` 与 `owner-events-route` 共 **34 tests passed**。该测试不表示底层 PostgreSQL 查询会被取消，也未覆盖代理/网络断开；普通请求早退及后台 operation/attempt/settlement 关联仍待盘点和验证，ED13 仍未完成。

**新增 stage freshness SSE 故障切片（2026-10-08）**：精确 runtime-disabled 404、owner resolution 异常和首轮存储读取异常均回显同一个 request-id；owner/存储异常对外统一为不含底层细节的 503，日志只记录请求编号与异常类型。正常 freshness stream 沿用 owner boundary 提供的编号。`stage-freshness-route` 定向 suite **7 tests passed**，覆盖正常流、runtime gate 和两种初始化故障。流已建立后的轮询错误仍按现有降级协议发送 rev 0，异步任务全链路关联仍待完成。

**新增 public health/render capability 关联切片（2026-10-08）**：旧 `/api/health` 与 `/api/export-video/capability` 成功响应现回显规范化 request-id；health provider 配置异常返回通用 503 并只记录编号与异常类型。render capability 探针失败仍按原语义降级为 `enabled: false`，但日志不再包含原始异常消息，并通过同一个 request-id 关联。`health-access-code` 与 `video-export-capability` 两个定向 suite 共 **15 tests passed**；错误的跨系统 operation/attempt/settlement 传播仍待 ED06/ED09/ED11。

**新增 Agent Runtime API gate 切片（2026-10-08）**：runtime 未配置时，session collection/detail/status/cancel/messages、skills collection/detail 的方法级 404 都通过统一 request-id 规范化；`GET /api/agent/runtime` 的状态响应也回显编号。定向 `runtime-probe`、session、skills、owner/session SSE 等 10 个 suite 共 **103 tests passed**。该切片只覆盖 Agent Runtime 这组 handler，不代表其它 API gate 或异步 operation/attempt/settlement 已完成。

**新增 ASR request-id 早退切片（2026-10-08）**：`POST /api/transcription` 的 legacy handler 响应（包括校验/供应商错误）与认证配置读取失败的通用 503 现均通过统一 request-id stamp；OIDC handler 继续使用已有 owner boundary。回归在 `tests/api/transcription-oidc.test.ts` 验证 legacy 成功编号透传和 auth-config 503 编号透传；该 suite **6 tests passed**。与同一命令运行的 capability-force-off suite 首次并发时有一项图片用例超过既有 5 秒超时，单独重跑 **11/11 passed**，未见稳定失败。ASR 计量和上传限制仍受 D02/D03 阻塞；其它 route exits 仍待 ED13 矩阵审查。

**新增图片/视频 provider 验证 request-id 切片（2026-10-08）**：两条 `/api/verify-*-provider` POST handler 的 legacy 完成响应现在回显 request-id；认证配置解析异常返回脱敏 503 并回显编号；OIDC 成功/拒绝由 owner boundary 继续提供编号。回归组合 `verify-image-provider`、`verify-video-provider`、`transcription-oidc` **3 suites / 26 tests passed**，ESLint、TypeScript、Prettier 与 `git diff --check` 通过。该切片只覆盖这些 handler 的出口，不能代表所有 provider/media routes 已完整关联。

**新增文档抽取 request-id 早退切片（2026-10-08）**：`POST /api/extract-document` 的 legacy multipart/JSON 结果与 auth-config 故障 503 现均回显规范化编号；OIDC 路径仍由 owner boundary 提供。`extract-document-route` **33/33**、`extract-document-oidc` **5/5** 分开串行通过；并发运行时这两个 suite 的既有基础用例各触发一次默认 5 秒超时，单独重跑通过。ESLint、TypeScript、Prettier 与 `git diff --check` 通过。媒体/文档类请求的其它 handler 和完整 request-id 出口矩阵仍未覆盖。

**新增 owner materials API gate request-id 切片（2026-10-08）**：`GET/POST /api/materials` runtime-disabled 早退，以及 GET 缺失 session/非法 limit 参数的 4xx 现在回显规范化编号；正常 owner-bound responses 沿用统一 boundary。`materials-route` **18/18** 与跨 16 个持久化 API 的 `persistence-routes-gate` **66/66** 通过，相关 ESLint、TypeScript、Prettier 和 `git diff --check` 通过。此修正只覆盖 materials GET/POST 早退；全部 Agent Runtime API 和其它手写路由仍需矩阵检查。

**新增 stage collection/detail request-id 早退切片（2026-10-08）**：`/api/stages` 与 `/api/stages/[id]` runtime-disabled 404、collection JSON/name 校验，以及 detail PATCH/PUT JSON/schema 校验早退现在回显规范化 request-id；owner-bound 正常结果继续沿用既有边界。`stages-route` 与 `stage-detail-route` **2 suites / 40 tests passed**，ESLint、标准 TypeScript、Prettier 与 `git diff --check` 通过。其它 stages 子路由和其余手写 API 出口仍须逐项审计；ED13 保持进行中。

**新增 material detail / stage-meta 关联切片（2026-10-08）**：材料详情 runtime-disabled 与缺失 `sessionId` 早退、stage-meta persistence-disabled 早退均回显规范化 request-id；stage-meta 故障日志现在关联 request-id 并只写异常类型，不暴露原始异常正文。`material-detail-route` 与 `stage-meta-routes` **2 suites / 20 tests passed**，其中回归注入含凭据字样的错误并确认日志不回显。其余 stages 子路由、所有 API 普通成功/错误出口及后台任务 attempt/settlement 关联仍待矩阵验收。

**新增 classroom-media 流与错误日志切片（2026-10-08）**：完整与 range 流式响应继续携带 owner boundary 的 request-id；所有权查询与文件读取失败日志改为有限字段，仅关联 request-id 和错误类型，不写原始异常堆栈/消息、classroom id 或用户控制的路径。`classroom-media-range` **10/10 tests passed**，含流式响应 header 和两类敏感异常脱敏断言。其他 API 的完整出口审计、代理断流和异步 job/attempt/settlement 关联仍未完成。

**新增 render submit 故障关联/脱敏切片（2026-10-08）**：渲染并发存储故障、owner→job 绑定失败和上游网络失败日志现在记录 request-id 与有限错误类型；绑定失败另关联 job id。原始异常堆栈和上游异常正文不写日志，最后一类也不再回传给客户端。`export-video-ownership` suite **16/16 tests passed**，覆盖请求编号和凭据字样脱敏；当时 ED15 gate 实跑 **46 files / 483 tests passed / zero skipped**。这不替代完整异步 worker/provider/settlement 故障关联验收。

### ED14：存活、就绪与能力降级

**结果**：进程活着与能够接流量可以区分，必要依赖故障能快速、准确地减少错误请求。

**入口**：`app/api/health/route.ts`、middleware 精确准入、持久化 provider、render capability、Docker/反代或目标调度平台。

**工作**：

- 保持现有 `/api/health` 兼容；拟新增精确 GET `/api/health/live` 与 `/api/health/ready`，同步准入和路由清单，避免开放任意子路径。
- live 不查询 DB/付费供应商；ready 检查当前部署必须依赖的 DB、最低兼容 schema 和必要存储。legacy 可选依赖不被错误升级为强制依赖。
- 设置单依赖/总探测预算、结果缓存与并发合并；schema checksum 完整校验在部署/启动阶段完成，不在每次探测中全表扫描。
- 可选 render 或某供应商故障降低对应 capability，不使所有课堂读取不可用；OIDC 核心 DB 不可用则不就绪。
- 公共探测返回最小 status，详细依赖原因仅进入受控运维记录；上线新 ready 后才把部署流量门槛接到它。

**验收**：

- [ ] DB 断开或必需 schema 缺失时 ready 失败；live 仍按进程健康回答；恢复后能重新接流量。
- [ ] 可选渲染能力失效只影响导出；探测不调用付费模型，不暴露配置/凭据。
- [ ] 高并发探测不形成 DB 风暴；探测时间与缓存寿命有测量结果和配置记录。

**风险与回退**：错误的 ready 条件可能切走全部副本。先观测再绑定部署，回退探测接入时保留真实依赖错误指标和安全拒绝。

**已交付切片（2026-10-08）**：新增精确 GET `/api/health/live`，只返回最小 `status: ok`，附 `no-store` 和 request-id；不触碰数据库、存储或供应商。新增精确 GET `/api/health/ready`：OIDC 与 durable agent runtime 必须有 PostgreSQL；legacy 且 agent runtime 关闭时不强制数据库。ready 使用独立、只读、max=1 的临时 pool 检查 `schema_migrations` 当前最高版本至少为 0023，连接/查询各限 1 秒；结果 2 秒缓存并合并并发探测，公共响应不含依赖细节。OIDC 与 legacy access-code 准入只公开两个精确路径的 GET/HEAD，POST 和子路径没有开放。路由审计生成器将两者分类为公开精确 GET/HEAD。3 个定向 suite（28 tests）、相关 ESLint、TypeScript、route inventory 审计通过，当前清单 82 handlers / 101 methods。迁移 checksum 仍由发布迁移程序校验；真实 PostgreSQL 故障演练、可选能力降级和部署流量门槛尚未加入，不能将探针当作发布健康证明。

### ED15：企业自动化验收与故障演练

**结果**：本版本的 CI 能证明企业用户流程、授权边界、真实并发和故障恢复，不会因测试跳过而假绿。

**入口**：现有 Vitest/Playwright 配置、`.github/workflows/ci.yml`、`storage-pg-contract.yml`、`tests/server`、`tests/api`、`tests/persistence`、`e2e/tests` 与 render-service 测试。

**工作**：

- 建立独立企业 fixture：两个租户、同一用户跨租户、四角色、无成员、停用/撤销/过期状态、私有/公开/删除资源和临时存储。
- 扩展真实 PostgreSQL job：按仓库支持的基础 schema 初始化，再运行完整迁移和新迁移；用多个连接及多 worker 验证锁、租约、唯一约束和事务，不用 PGlite 替代真实并发。
- 新增 suite 必须有显式 required 开关、收集与跳过数检查；保留现有 storage suite guard，避免根工作流没有执行新增测试仍通过。
- 增加企业 Playwright 配置：独立 Keycloak realm、受控 provisioning、HTTPS app/issuer、production build/start、可信测试证书和每 case 独立会话；不复用本机登录态。
- provider 使用固定、可计数的 test double，经真实托管配置入口接入。隔离测试可采用显式 operator 网络策略，不放宽生产 SSRF 或 OIDC 校验；CI 不调用真实付费 API。
- 用夹具覆盖主观/客观评分、聊天、白板、PPTX、MP4 与恢复；小型真实 MP4 smoke 验证 Chromium/FFmpeg 和沙箱，模拟服务测试负责大量故障分支。
- 需要共享角色/会话的测试序列化，其他 case 隔离 realm/user/schema/目录，避免 `fullyParallel` 引起租户切换互扰。
- 将故障矩阵纳入 CI 或明确的预发布演练；关键功能不再以“观察项未实测”通过完整交付验收。

**验收**：

- [ ] 主流程、权限矩阵、跨 tenant 同用户、并发准入、计量幂等和重启恢复均有实际执行证据。
- [ ] production HTTPS 登录、cookie、callback、登出、Origin、撤销和 viewer 行为通过；生产规则未为测试被弱化。
- [ ] CI 报告包含预期 suite/case，required 项不得 skipped；失败区分新增回归与基线问题，关键基线问题未解决不得发布。
- [ ] 测试不加载 `.env.local`，不写真实 `data/`，不连接真实库、不调用真实 provider；trace/log/artifact 不包含测试口令。

**风险与回退**：夹具先建设并随任务复用；不把全部测试留到最后。不得降低断言、删除 suite、放宽类型检查或隐藏 skip 来通过门槛；CI 故障可修复基础设施，不能省略必要证据。

**已交付 CI 门槛切片（2026-10-08）**：主 CI 新增 required enterprise regression contract，固定收集 47 个租户/资源/配额/限流迁移、OIDC/access-code、owner gate、认证恢复、Agent Runtime、stage/material/stage-meta/classroom-media、PDF/image/video provider request-id route 与生成会话凭据脱敏 suites，包含同一用户跨 tenantScope 的 storage 与 API PGlite 契约、stage-freshness SSE gate/owner/store 初始化故障契约、16 个持久化 API 在 runtime 关闭/缺少数据库/配置完整三种状态的门控契约，以及 health/render capability 与 liveness/readiness 探针；reporter JSON guard 要求每个预期文件实际执行、至少有通过断言且零 skip/pending。该门槛显式设置 `ENTERPRISE_REGRESSION_REQUIRED=1`、`TEST_LOAD_LOCAL_ENV=0`、空 `DATABASE_URL` 和关闭 agent runtime；不覆盖真实 PostgreSQL 或生产 E2E。PGlite suites 初始化较重，workflow 将 file workers 限定为 2，避免资源争用触发原有 hook timeout。`agent-sessions-tenant` fixture 经单独执行观察约 6 秒，为其初始化/慢用例分别设 20/15 秒明确预算，未改断言。最新本地隔离实跑 **47 files / 486 tests passed**，required suites 均无 skipped case；guard 自身的 5 个 Node 单测验证缺 suite、skip 和空 suite会失败。多租户计量幂等、完整恢复和 production E2E 仍未证明。

**新增 PostgreSQL CI 合约门槛（2026-10-08）**：既有 PG16 工作流在 storage、app-domain PG suites 后新增 required contract，收集 Agent NOTIFY transaction delivery、lease/attempt takeover、真实 per-session SSE tail 和 owner-material reservation concurrency 4 个 PG suite；共享 JSON guard 在 `ENTERPRISE_PG_REGRESSION_REQUIRED=1` 且 `PG_CONTRACT_URL` 存在时要求四套都执行且零跳过。guard 单测覆盖独立 PG suite 清单。该工作流在当前机器未连接/启动 PostgreSQL，故这里只验证 guard 逻辑和 YAML 格式；首次 CI 运行才提供真实服务端执行证据。完整迁移 upgrade/checksum 和多 worker E2E 仍未验收。

**新增 storage 多租户 PostgreSQL 合约（2026-10-08）**：将 `pg-agent-session-store.pg.test.ts` 纳入 storage PG 外部必跑 suite 清单与发布包复用的同一守卫；suite 验证同一 owner 在两个 `tenantScope` 下互不可见，覆盖 session get/list、session event replay、owner event projection 与 tenant-scoped high-water mark。守卫计数现要求 agent session schema 的六张表也在本次运行有真实插入变化。相同边界也由独立 PGlite suite `tests/persistence/agent-session-tenant.test.ts` 验证；本次重跑 **7/7 passed**。storage PGlite 会话 suite **89 passed / 4 skipped**。该套件执行时还发现 custom owner-event 表名为保留字 `user` 的索引 DDL 缺少标识符引用，已修复 `schemaFor()` 表名重写并重跑全套成功。当前本地没有配置 `PG_CONTRACT_URL`，真实 PG suite 不会在本机连接数据库；真实 PostgreSQL 执行证据等待 PG16 CI 运行。

**新增生产模式 OIDC E2E CI 夹具（2026-10-08）**：`.github/workflows/ci.yml` 新增独立 `enterprise-oidc-e2e` job，使用 PostgreSQL 16 和固定版本 Keycloak 26.7.5 disposable realm。工作流拒绝 `.env.local`，为 `localhost` 生成两日测试 CA/叶证书并加入 runner 信任库；本地 TLS proxy 只绑定 loopback，转发到本机 production app 与 Keycloak HTTP listener，重写代理头并让 Keycloak 只信任受控代理网段。夹具运行完整 23 个迁移，CLI 预置 owner/viewer/selector 账户；selector 用户另有 default owner 和 secondary viewer 两个活跃成员关系，使用独立 SQL 夹具事务化创建并记录审计。`OIDC_AUTO_PROVISION_USERS=false`；独立 Playwright 配置在 production build/start 下验证 HTTPS OIDC callback、Secure/HttpOnly cookie、owner 与 viewer 的 tenant API 授权、拒绝跨源 logout 以及会话撤销，并验证多成员用户初次登录后处于 `tenant-required`、必须选定 secondary 才变为该 tenant 下 viewer。Playwright trace、视频、截图均关闭，job 不上传报告，CI 不调用真实 provider。新增 JSON 结果守卫精确要求三个命名用例各通过一次，缺失、skip、retry、flaky 或 unexpected 均失败；守卫自身 4 个 Node 测试已通过。PostgreSQL E2E、隔离 schema migration-runner contract 和 PGlite 完整迁移测试复用同一个 `tests/e2e/enterprise-baseline.sql`。新增企业 E2E 尚未在本地或 GitHub Actions 执行：当前环境没有 Docker/actionlint；首次 CI job 仍需证明镜像导入、证书信任和浏览器流程可运行。该切片不覆盖完整角色矩阵、provider double、异步恢复或 MP4 smoke。Keycloak 的固定 hostname、反向代理头和导入配置依据[官方 hostname 文档](https://www.keycloak.org/server/hostname)、[官方反向代理文档](https://www.keycloak.org/server/reverseproxy)和[官方 realm 导入文档](https://www.keycloak.org/server/importExport)。

**新增全迁移链验收（2026-10-08）**：离线必跑门槛新增 `tests/persistence/full-migration-chain.test.ts`，以旧版应用基表和 user/anonymous 资源数据依序执行连续 0001–0023 SQL，并核对 default tenant backfill 与 anonymous NULL 保留；该 PGlite suite 已执行通过。PG16 storage workflow 另新增 `scripts/assert-migration-runner-postgres.mjs`，在临时 schema 中真实调用 `scripts/migrate-database.mjs`：要求 23 个连续 migration，验证全部文件名/SHA-256 登记与代表性历史数据 backfill，重跑要求无 `Applied` 项，再篡改最新 checksum 并要求 runner 拒绝。脚本由 required workflow flag 和 `PG_CONTRACT_URL` 双重启用，只创建/删除本次随机 schema。当前环境没有真实 PostgreSQL/psql/Docker，因此脚本只完成 Node syntax、ESLint、格式检查，实际 runner 与 PostgreSQL 行为等待 PG16 CI 执行；不得把 PGlite 结果当作实服端证据。

**企业 OIDC E2E locale 稳定性修正（2026-10-08）**：多租户 selector 用例在首次导航前通过 `page.addInitScript` 固定 `zh-CN`，避免 `I18nProvider` hydration 后读取 Chromium 的 `navigator.language`，造成中文对话框断言和英文 runner locale 竞争。`playwright test --config=playwright.enterprise.config.ts --list` 收集到预期的 3 个用例；该用例 Prettier、`eslint --no-ignore`、标准 TypeScript 检查及 `git diff --check` 通过。`--list` 不启动服务，真实 Keycloak/HTTPS 浏览器执行仍待 CI。

### ED16：发布预演、回滚与受控交付

**结果**：发布包、迁移、配置、能力和验收证据属于同一版本；出现故障有可执行的回退步骤。

**入口**：`ENTERPRISE_AUTH.md` 发布章节、`.env.example`、`Dockerfile`、compose、migrator、CI artifacts、企业验收表。

**工作**：

- 建立发布 manifest：commit、应用/worker/render 镜像 digest、构建 flags、迁移名称/checksum、配置 schema、启用能力、前后版本兼容范围和所有 Gate 结果。
- 在目标 PostgreSQL 同主版本的隔离库演练完整初始化/升级、幂等重跑、故障回滚和 checksum 拒绝；记录大表锁预算、backfill 批量与所需窗口。
- 备份数据库与必要持久卷/产物元数据，在隔离环境恢复并跑读取验证；恢复目标遵守已确定的 RPO/RTO。
- 用 production 构建通过 HTTPS 预发布完整验收，构建期 `NEXT_PUBLIC_*` 与运行期 server 配置都列入 manifest。
- 先部署扩展 schema/兼容应用/worker，再启用新 writer 和企业界面；存量账本、任务和新旧客户端在切换窗口内有明确接管规则。
- 小流量按受控测试用户/组织逐步启用；记录观测窗口、错误率/待结算/积压阈值、停止条件和回退负责人。性能目标在启用前填入，不能把未测数字写成 SLA。
- 回退优先暂停新付费操作并保留恢复 worker；回退 app/reader 需兼容新记录。既有 OIDC→legacy 回退的数据不可见政策保持并在演练中展示，不重复声称是无损业务恢复。
- 只有数据损坏事件才评估备份/PITR 恢复；schema 保留向前变更，不删除表或改写旧 SQL 迁移。

**验收**：

- [ ] manifest 与运行版本、schema 和能力一致，备份已实际恢复，所有发布 Gate 有签署的结果。
- [ ] 旧应用遇到新 schema、新 worker 处理旧任务、新客户端遇到旧服务分别有兼容或明确拒绝证明。
- [ ] 租约、任务、已知/未知用量、产物和数据可见性在回退演练中有结果；无自动跨 tenant 接管。
- [ ] 正式环境/时间窗/恢复目标已确认并授权，监控与值守准备好后才进行迁移、导入和配置切换。

**风险与回退**：实际迁移可能需要锁和数据回填，必须以演练数据量判断，不能因为 migration 文件很短就宣称零停机。新费用/任务数据不能靠切 feature flag 丢弃。

### ED17：多副本与高可用交付（D05 需要时必做）

**结果**：请求落在不同应用/worker 副本仍得到一致授权、任务状态和资产，重启一个副本不会中断整体服务。

**工作**：

- 盘点所有文件/内存边界：classroom 数据与媒体、agent 待决状态、事件通知、render 输入与产物、Next 缓存、provider 配置缓存和本地幂等状态。
- 优先复用已有资产/对象存储 adapter 与 S3 依赖；共享状态只用持久库/受控共享存储。缓存键包含 tenant/owner 和影响结果的版本，敏感读取不靠共享 CDN 缓存。
- 跨副本通知可由持久事件轮询起步，需要 broker 时以容量/延迟证据选型；事件序号和重连快照保证正确性，通知只用于加速。
- 多渲染节点引入可信调度控制层，执行者只获得限定任务输入/输出能力。浏览器沙箱继续无数据库凭据/出站访问；持久 registry 不代表多个 coordinator 已安全调度。
- 若需对象存储签名 URL，固定授权主体与任务，设置短时有效、对象不可变/版本化，并明确撤销权限后已发 URL 的有效窗口。
- 验证全局/tenant 配额和并发跨副本生效；明确连接池总量、资源预算、滚动升级和 drain 行为。

**验收**：

- [ ] 两个应用与两个 worker 的交叉请求、重复认领、断线重连和轮换重启测试通过，无跨 tenant 读取或双重发布。
- [ ] 不依赖 sticky session 才能维持授权与任务正确性；必要状态故障的恢复符合 D06。
- [ ] render 调度、共享产物和 sandbox 隔离均经过验证，高可用范围与剩余单点在交付文档中公开记录。

**风险与回退**：数据库 failover、共享存储故障和 signed URL 撤销语义都需单独证明。ED17 未验收时仅交付已约定的单节点试点，不承诺完整高可用。

## 6. 通用实施完成标准

每项只有满足以下全部条件才从“已实现”进入“已验证”；部署成功后另记“已部署”。

- [ ] 行为契约、边界与依赖决策已记录，改动属于本任务；用户原有工作未被覆盖。
- [ ] 已阅读受影响 caller、存储契约和安装版 Next 指南；复用既有组件、鉴权和 provider 接口。
- [ ] 必要失败、取消、并发与权限路径有可信验证，测试使用隔离状态。
- [ ] 相应 typecheck/lint/format 与定向检查通过；已有失败单独记录，关键风险未解决不得发布。
- [ ] 迁移、配置与运行文档一致，旧数据/旧客户端/旧 worker 的兼容行为明确。
- [ ] 有演示、执行结果、commit/revision、复核人、未执行项和原因；无凭据进入证据。
- [ ] 回退与清理仅作用于本任务的明确目标；不把降低授权或丢弃待结算记录当作恢复。

每个实施批次形成一个可独立复核的变更单元。跨层行为不可拆成“只有表”“只有按钮”后宣称用户功能完成；大任务可按一个供应商/一种任务/一个角色的端到端切片拆分。

## 7. 验证矩阵与执行命令

### 7.1 必测故障与边界

| 边界 | 场景 | 预期可观察结果 |
| --- | --- | --- |
| 会话 | 缺失、过期、撤销、认证 DB 不可用 | 登录或不可用行为确定，不退回匿名，不循环登录 |
| tenant | 无成员、多个成员、停用、跨标签页切换、陈旧写入 | 选择或拒绝准确，原请求/任务不转移归属 |
| 权限 | viewer 写、admin 授高秩、末位 owner、操作中撤销 | 操作被拒绝或停止，审计与费用事实仍保留 |
| 私有资源 | 同 tenant 他人、同人不同 tenant、不存在/删除 | 统一 404，无存在性信息；公开例外独立验证 |
| 输入 | chunked 超限、假格式、超长音频、路径穿越、危险 ZIP | 调用前拒绝、有界内存/CPU、无任意文件读取 |
| 调用 | 提交成功响应丢失、timeout、流中断、provider usage 缺失 | 原任务/operation 可查询，未知/估算状态明确，无无条件重复付费 |
| 计量 | 同事件重投、DB 在结算处故障、月底迟到结果 | 幂等结算、可对账、周期归属按原 reservation 规则 |
| 任务 | 多 worker、旧租约、重启、取消与完成竞争、无人轮询 | 只有有效执行者发布，后台自恢复，取消反馈真实 |
| 存储 | 磁盘满、部分文件、损坏 manifest、产物过期 | 不虚假接受，不误删活跃数据，授权用户可理解结果 |
| 运维 | DB/存储/可选 render 故障、监控后端故障 | readiness/capability 合理，业务不依赖日志 exporter 成功 |
| 发布 | 升级中断、checksum 错误、旧版本回退、备份恢复 | 明确停止/回退，任务/用量与数据可见性符合约定 |

### 7.2 命令与环境原则

以下为实施时执行的命令清单，本次计划编制没有运行实现测试。先确认 Node >=22.19.0、项目锁定的 pnpm、构建后的 workspace 包和独立测试配置。

| 检查 | 命令/方式 | 范围 |
| --- | --- | --- |
| 差异完整性 | `git status --short`、`git diff --check` | 每次编辑前与提交前，保留用户工作 |
| 类型 | `pnpm exec tsc --noEmit` | 与现有 CI 一致；定向检查只能作为开发中补充 |
| 格式与 lint | `pnpm exec prettier <本批文件> --check`、`pnpm exec eslint <本批文件>` | 定向后，在发布门槛运行现有 `pnpm check` / `pnpm lint` |
| 国际化 | `pnpm check:i18n-keys` | 增加或改动用户文案时 |
| 单元/契约 | `pnpm exec vitest run <本批 suite>` | 具体文件名按实际新增测试填写，记录 suite 与 case 数 |
| 根测试 | `pnpm test` | 发布前；包和 render-service 按现有独立工作流执行 |
| 真实 PG | 扩展 `storage-pg-contract.yml` 的企业 suite | 显式隔离连接、required 模式、预期 suite/skip 检查、多连接并发 |
| 渲染服务 | 在 `render-service` 中执行 `npm run typecheck`、`npm test` | 根 tsc/测试不覆盖此独立服务，不可省略 |
| 浏览器 | 现有 `pnpm test:e2e`；ED15 新企业配置用 `pnpm exec playwright test --config=<实际配置>` | 独立 realm、HTTPS、production build、fixture provider |
| 路由覆盖 | `node scripts/audit-enterprise-routes.mjs` 后审阅生成差异 | 脚本会更新清单；不是授权安全证明 |
| 生产构建 | `pnpm build` 与目标容器构建 | flags、包产物和版本记录一致 |
| 迁移演练 | 向已确认的隔离库注入配置后执行 `pnpm db:migrate` | 不默认读取/重用开发或生产连接，不输出连接信息 |

PGlite 用于迁移形状与 SQL 快速验证；真实 PG 用于锁/隔离/并发；浏览器用于用户行为；恢复演练用于部署事实。四者不能相互替代。

## 8. 数据与发布兼容策略

1. **扩展**：先加新列/表/索引/兼容读取；migrator 每迁移事务与 advisory lock 行为保持。大表索引/backfill 需实测锁预算；不要把不能放在事务中的语句塞进既有 migrator。
2. **验证**：对隔离快照比较 schema、行数、归属、用量与任务状态，验证重跑和失败回滚。历史导入为独立受控工具，不放在应用启动或登录回调。
3. **切换**：先兼容 app/worker，再新客户端，再预条件与新 writer/reader。短暂停写或零停机协议必须在 D02/ED08 明确选择。
4. **保留**：保留旧字段、文件快照和兼容 reader，直到确认无存量任务/待结算/旧客户端依赖；本计划不授权删除历史数据。
5. **回退**：暂停新提交，保持授权和恢复服务；回退到明确兼容版本。若需恢复数据库，先停止写入、评估时间点与 RPO，记录回退后不可见的数据范围。

需要新的开关时，默认关闭新行为、校验配置、给出 rollout 顺序；关闭入口不能同时关闭已接受任务的执行/清算。不要用一批未协调的 UI flag 替代服务端能力与权限契约。

## 9. 发布 Gate 与证据包

| Gate | 进入条件 | 必备证据 |
| --- | --- | --- |
| G0 基线可信 | ED01 完成 | revision、工作区归属、功能/路由清单、决策登记 |
| G1 用户与 tenant 闭环 | ED02–ED05、ED12 完成 | 四角色/两 tenant/跨标签页和主界面状态验收 |
| G2 成本与任务可恢复 | ED06–ED11 完成 | 账本对账、真实并发、provider 调用次数、故障恢复和 sandbox 检查 |
| G3 运行可观察 | ED13–ED14 完成 | 故障编号演练、dashboard/alert、就绪与降级验证 |
| G4 发布可验证 | ED15 完成 | required suite/case、production HTTPS E2E、迁移与渲染 smoke |
| G5 可交付 | ED16 完成；高可用范围追加 ED17 | manifest、恢复/回退报告、目标环境授权、值守与小流量结果 |

证据包包含：功能范围、revision/镜像、迁移清单、配置项名与来源、测试报告、非敏感截图、故障恢复记录、备份恢复报告、已知限制、暂停/回退条件和负责人。密钥只在秘密存储中，证据包不能包含真实业务正文或访问凭据。

G1–G4 是交付能力检查项，可随任务逐步通过，不表示编号上的严格实施顺序；G5 要求前面全部通过，最终依赖关系以第 4 节为准。

发布验收表需填入而非临时猜测：目标用户/tenant 数、同时生成/导出数、典型和最大输入、观测窗口、请求错误率、任务成功率、阶段耗时分位数、最大队列等待、最老待结算年龄、RPO/RTO、产物留存和告警阈值。未填数值时不得对客户承诺 SLA。

## 10. 第一项可直接启动的工作

后续实施继续 **ED02 的租户选择端到端切片**：全局 tenant-required 选择界面已复用现有租户列表和 active-tenant API；下一步结合真实调用方与会话/schema 设计梳理 D01 跨标签页预条件。只有在协议、兼容窗口和竞争验证明确后才启用陈旧写入拒绝；单独 UI 不应暗示该保护已完成。

账本 ED06 与渲染 ED09 可在各自设计确认后独立推进；没有环境/额度决策时，仍可完成 schema 设计、隔离 fixture 和故障验证，正式启用等待相应决策。本计划无需创建外部 issue、发布 PR 或执行生产操作即可完成交接。

## 11. 参考依据

- 仓库：`AGENTS.md`、企业认证/路由清单、现有 PG 迁移和独立 CI、安装版 Next.js 16.3.3 文档。历史文档的状态取舍需由 ED01 对照当前代码纠正。
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)：逐请求授权与默认拒绝。
- [OWASP Multi-Tenant Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)：服务端 tenant 上下文、共享状态和缓存隔离。
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)：可验证的键盘、焦点、状态消息和错误交互要求。
- [OpenTelemetry context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)：跨请求/服务关联日志与 trace。
- [Kubernetes probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)：存活、就绪和启动探测的职责区分；本项目不因此强制采用 Kubernetes。
- [PostgreSQL SELECT / locking](https://www.postgresql.org/docs/current/sql-select.html)：短事务锁与队列认领设计；实施时同时核对目标 PG 主版本文档。

上述资料支持原则；具体表形状、界面和 rollout 顺序是本项目的实施提案，需由各任务验证，不能当作已经实现的事实。

