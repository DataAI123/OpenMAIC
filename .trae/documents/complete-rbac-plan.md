# 完整 RBAC 实施计划（批次 14–16）

## Context

第一阶段（企业认证与授权重构）已收口：OIDC 会话、租户边界、资源 owner 授权与 73 条路由的逐批开闸均已完成（批次 1–13）。

但授权仍停在「身份 + 资源 owner」层面，**角色（role）几乎未被使用**：全仓库唯一的角色判定是
[with-owner.ts](file:///d:/AI_APP/openmaic/lib/server/agent-runtime/with-owner.ts#L49-L56) 里硬编码
`role === 'viewer'` 拦截非 GET，以及 [workspace-actions.ts](file:///d:/AI_APP/openmaic/lib/workbench/workspace-actions.ts#L26)
里同样的判断。`OWNER_REFACTOR_PLAN` §10 要求的「权限动作、角色绑定、管理审计、权限变更生效策略」四项均缺失：

- 无权限动作定义，角色语义只散落在两处魔法判断里；
- 无「谁可以授予/变更角色」的受控路径——[provision-enterprise-user.mjs](file:///d:/AI_APP/openmaic/scripts/provision-enterprise-user.mjs#L111-L115) 明确拒绝改角色（"role changes require a separate authorization step"），而那一步从未被实现；
- 无管理审计，角色变更不可追溯。

本计划补齐这四项，使 `owner|admin|member|viewer` 成为**可用、可审计、可验收**的权限模型，同时不触碰已收口的会话、租户与资源授权边界。

## 关键设计决策

**权限矩阵放在代码里，不放进数据库（对最初设想的修订）。**

原设想是「数据库可配置 permission/role_permissions 表」。评审后改选**静态目录 + 静态矩阵**：

- §10 的字面要求是「权限动作」与「角色绑定」——**角色绑定本就在库中**（`tenant_memberships.role`），而权限动作是代码契约；
- 数据库矩阵需要缓存与失效策略、且当某角色无行时会**静默降为全无权限**，还要改动 `AuthenticatedSession` 形状并连带 ~12 个测试 fixture；
- 静态矩阵无查询开销、无漂移缓存、对未知角色 fail-closed，且**角色授予/变更仍走数据库**，因此「权限变更即时生效」不受影响（见下）。

唯一真源：`lib/server/auth/permissions.ts`。

```ts
export const PERMISSIONS = {
  'tenant.member.read':  '查看本租户成员及其角色',
  'tenant.member.manage':'授予/变更/移除本租户成员角色',
  'tenant.audit.read':   '查看本租户角色变更审计',
  'webapp.write':        '执行非只读业务操作（写/生成/导出等）',
} as const;

// viewer 无任何写权限；member 可写业务资源但不可管理租户；admin 可管理成员；owner 全权。
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<PermissionKey>>;
export function hasPermission(role: Role, key: PermissionKey): boolean;
export function roleRank(role: Role): number;              // owner 3 / admin 2 / member 1 / viewer 0
export function canAssignRole(actor: Role, target: Role): boolean; // 秩严格更高，或 actor 为 owner
export function canModifyRole(actor: Role, current: Role): boolean; // 同上，作用于目标当前角色
```

**权限变更生效策略 = 会话内即时生效。**
[session.ts](file:///d:/AI_APP/openmaic/lib/server/auth/session.ts#L108-L151) 每次请求都 JOIN `tenant_memberships(tenant_id='default', status='active')` 读取角色，因此改角色立刻生效、删成员立刻令会话失效（401）。本计划**不修改**该 SQL，只在文档中明确该契约。

**越权与锁死守卫**（不能只靠矩阵）：
- 只能授予/修改**秩低于自己**的角色（owner 例外，可授 owner）；
- 不得移除或降级**最后一名 active owner**（同事务 `FOR UPDATE` 内统计）；
- 跨租户成员一律 404，且与「不存在」逐字节一致（无存在性 oracle）。

## 批次 14：权限模型与统一判定点

**改动文件**

- 新增 [permissions.ts](file:///d:/AI_APP/openmaic/lib/server/auth/permissions.ts)：上节全部内容；`Role` 类型从 `AuthenticatedSession['role']` 复用，矩阵必须覆盖四个角色且 `webapp.write` 授予 owner/admin/member。
- [with-owner.ts](file:///d:/AI_APP/openmaic/lib/server/agent-runtime/with-owner.ts#L49-L56)：**只替换角色比较，保留方法门**——即
  `if (!['GET','HEAD','OPTIONS'].includes(method) && !hasPermission(session.session.role, 'webapp.write'))` 返回 403 `{success:false,errorCode:'FORBIDDEN'}` + `Cache-Control: no-store`（保持手写 `Response.json` 与既有字节一致，不改用 NextResponse）。
- [workspace-actions.ts](file:///d:/AI_APP/openmaic/lib/workbench/workspace-actions.ts#L26)：同一替换（第二个角色判定点）。
- 新增 `tests/server/permissions.test.ts`：四角色 × 四权限矩阵断言、未知角色 fail-closed、`canAssignRole`/`canModifyRole` 秩规则、`roleRank` 单调。

**验证**：`npx vitest run tests/server/permissions.test.ts`，并回归既有 owner-gate 测试（member 写仍应 200、viewer 写仍应 403）：
`tests/server/request-owner-auth.test.ts`、`tests/server/chat-routes-owner-gate.test.ts`、`tests/workbench/workspace-actions-auth.test.ts`。

## 批次 15：管理 API 与管理审计

**改动文件**

- 新增 [0017_tenant_role_audit.sql](file:///d:/AI_APP/openmaic/migrations/0017_tenant_role_audit.sql)（forward-only，命名须匹配 `^\d{4}_[a-z0-9_]+\.sql$`）：

```sql
CREATE TABLE tenant_role_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES app_users(id) ON DELETE RESTRICT, -- CLI 为 NULL
  subject_user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('grant','change','revoke')),
  previous_role TEXT CHECK (previous_role IS NULL OR previous_role IN ('owner','admin','member','viewer')),
  new_role      TEXT CHECK (new_role      IS NULL OR new_role      IN ('owner','admin','member','viewer')),
  source TEXT NOT NULL CHECK (source IN ('api','cli')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tenant_role_audit_shape CHECK (
    (action = 'grant'  AND previous_role IS NULL     AND new_role IS NOT NULL) OR
    (action = 'change' AND previous_role IS NOT NULL AND new_role IS NOT NULL) OR
    (action = 'revoke' AND previous_role IS NOT NULL AND new_role IS NULL)
  )
);
CREATE INDEX tenant_role_audit_tenant_idx  ON tenant_role_audit (tenant_id, created_at DESC);
CREATE INDEX tenant_role_audit_subject_idx ON tenant_role_audit (subject_user_id, created_at DESC);
```

- 新增 `lib/server/auth/authorize.ts`：`withTenantPermission(req, key, handler)`，语义与 [with-owner.ts](file:///d:/AI_APP/openmaic/lib/server/agent-runtime/with-owner.ts#L24-L99) 对齐：
  `resolveAuthConfig()` 失败或 `mode !== 'oidc'` → 503；`resolveApplicationSession` `unavailable` → 503、`missing/invalid` → 401（invalid 追加清 cookie header）、缺权限 → 403；写方法要求 `Origin === appOrigin`，否则 403。全部响应 `Cache-Control: no-store`。
- 新增 `lib/server/auth/tenant-admin.ts`：事务化业务（`pool.connect()` + `BEGIN`，仿 [identity.ts](file:///d:/AI_APP/openmaic/lib/server/auth/identity.ts#L36-L132)）：
  - `listMembers(tenantId)`：JOIN `app_users`，只返回本租户；
  - `assignRole(tenantId, actorUserId, subjectUserId, role, reason)`：`FOR UPDATE` 目标 membership；`canAssignRole`/`canModifyRole` 守卫；`assertNotLastOwner`；upsert 后写 `action='grant'|'change'` 审计；
  - `revokeMembership(...)`：`action='revoke'`；目标无 membership 或跨租户 → 404 与「不存在」逐字节一致；
  - `listAudit(tenantId, limit)`：`limit` 有界（默认 50，上限 200）。
- 新增路由：
  - `app/api/tenant/members/route.ts` — `GET`（`tenant.member.read`）
  - `app/api/tenant/members/[userId]/route.ts` — `PUT`（`tenant.member.manage`，body `{role, reason?}`）、`DELETE`（同上）
  - `app/api/tenant/audit/route.ts` — `GET`（`tenant.audit.read`）
- [api-response.ts](file:///d:/AI_APP/openmaic/lib/server/api-response.ts#L3-L41)：追加 `FORBIDDEN`、`NOT_FOUND` 两个错误码（纯追加；**不改** with-owner 的手写响应）。
- [middleware.ts](file:///d:/AI_APP/openmaic/middleware.ts#L7-L174)：新增独立谓词 `isTenantAdminApi(pathname, method)`，并在 `middleware()` 中与 `isOwnerScopedOidcApi` 同分支放行（Edge 只验签名会话，Node 再复核权限），4 条精确条目：
  `/api/tenant/members` GET、`/api/tenant/members/:id` PUT/DELETE、`/api/tenant/audit` GET。其余方法与子路径保持 503；**不得**进入 `isAnonymousPublicReadApi`。
- 测试 `tests/persistence/rbac-audit-migration.test.ts`（PGlite，仿 [enterprise-identity-migration.test.ts](file:///d:/AI_APP/openmaic/tests/persistence/enterprise-identity-migration.test.ts#L39-L84)：建 0001 依赖后跑 0017，断言 `action`/`shape`/`source` 约束与索引）；`tests/api/tenant-members.test.ts`、`tests/api/tenant-audit.test.ts`（仿 [verify-pdf-provider.test.ts](file:///d:/AI_APP/openmaic/tests/api/verify-pdf-provider.test.ts#L1-L80) 的 `vi.hoisted`+`vi.mock`）。

**验证**：`npx vitest run tests/persistence/rbac-audit-migration.test.ts tests/api/tenant-members.test.ts tests/api/tenant-audit.test.ts tests/server/middleware-oidc.test.ts`。
断言矩阵：legacy 503；未登录 401 + 清 cookie；member/viewer 403 `FORBIDDEN`；跨 Origin 写 403；跨租户/不存在 404 同字节；末位 owner 降级 409；admin 授 admin/owner 403；成功变更写入审计行且 `previous_role` 正确。

## 批次 16：CLI 审计、文档与清单

**改动文件**

- [provision-enterprise-user.mjs](file:///d:/AI_APP/openmaic/scripts/provision-enterprise-user.mjs#L87-L117)：在同一事务内为新建 membership 写一条 `action='grant', source='cli', actor_user_id=NULL` 审计；保留「拒绝改角色」断言，并在报错文案中指向管理 API（角色变更走批次 15 的授权路径）。
- [audit-enterprise-routes.mjs](file:///d:/AI_APP/openmaic/scripts/audit-enterprise-routes.mjs#L34-L61) 三处同步：`currentIdentity`、`policyFor`、`oidcGateFor` 为三条新路由加条目（写明权限键、守卫与「其它方法 503」）。
- 重生成 `ENTERPRISE_ROUTE_INVENTORY.md`。
- [ENTERPRISE_AUTH.md](file:///d:/AI_APP/openmaic/ENTERPRISE_AUTH.md) 新增「完整 RBAC（批次 14–16）」段：权限目录、角色矩阵、越权/末位 owner 守卫、「权限变更会话内即时生效」契约、以及**已知边界**（长连 SSE 在连接期持有已解析会话，降权不重查；`usage-attribution.ts` 仍固定 default 租户，属多租户阶段范围）。

**验证**：`node scripts/audit-enterprise-routes.mjs` 后 `git diff --exit-code ENTERPRISE_ROUTE_INVENTORY.md` 应为空。

## 验证计划（端到端）

```powershell
npx tsc --noEmit -p tsconfig.json
npx eslint lib/server/auth/permissions.ts lib/server/auth/authorize.ts lib/server/auth/tenant-admin.ts lib/server/agent-runtime/with-owner.ts lib/workbench/workspace-actions.ts app/api/tenant middleware.ts
npx prettier --check lib/server/auth app/api/tenant middleware.ts migrations/0017_tenant_role_audit.sql
npx vitest run tests/server/permissions.test.ts tests/persistence/rbac-audit-migration.test.ts tests/api/tenant-members.test.ts tests/api/tenant-audit.test.ts tests/server/middleware-oidc.test.ts tests/server/request-owner-auth.test.ts tests/server/chat-routes-owner-gate.test.ts tests/workbench/workspace-actions-auth.test.ts
node scripts/audit-enterprise-routes.mjs
```

迁移需在受控步骤执行（`node scripts/migrate-database.mjs`），不在应用启动时自动应用。

已知既存失败测试（不追、不误报）：`workspace-rail-session-rename`、`provider-neutrality-guard`、`media-placeholder-lease-guard`、`server-backed-media-orchestrator`、`element-reference-route-l2`。

## 关键边界（不做）

- 不重建并行 OIDC 目录，不改会话签名与租户边界。
- 不把 OIDC `sub`/email 当授权主体。
- 不引入数据库可配置权限矩阵（理由见上）。
- 不动 `session.ts` 的会话 SQL，不改 `AuthenticatedSession` 形状。
- 多租户生命周期、配额/成本路由不在本次范围。
