import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = path.join(root, 'app', 'api');
const outputPath = path.join(root, 'ENTERPRISE_ROUTE_INVENTORY.md');
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

async function collectRoutes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectRoutes(fullPath);
      return entry.isFile() && entry.name === 'route.ts' ? [fullPath] : [];
    }),
  );
  return files.flat();
}

function routeMethods(source) {
  return methods.filter((method) =>
    new RegExp(`export\\s+(?:(?:async\\s+)?function|const)\\s+${method}\\b`).test(source),
  );
}

function routePath(file) {
  return `/${path.relative(apiRoot, path.dirname(file)).split(path.sep).join('/')}`
    .replaceAll('[', ':')
    .replaceAll(']', '');
}

function currentIdentity(source, route, method) {
  if (route === '/tenant/active') {
    return '自作用域活跃租户切换：应用会话（数据库复核，允许 tenant-required）+ 存储内成员关系复核；不接受未具备成员资格的租户';
  }
  if (route === '/tenant/leave') {
    return '自作用域退出本租户：应用会话（数据库复核，允许 tenant-required）；userId 取自 session，从不取输入';
  }
  if (route === '/tenant') {
    return '自作用域租户列表：应用会话（数据库复核，允许 tenant-required）；按 session userId 查询，从不接受输入';
  }
  if (route.startsWith('/tenant/')) {
    return 'OIDC 租户管理边界：应用会话（数据库复核）+ 权限矩阵判定；租户与操作者均取自 session，不接受调用方输入';
  }
  if (route === '/export-video/capability') {
    return 'signed application session enforced by middleware (non-user-specific capability probe)';
  }
  if (route === '/access-code/status') {
    return 'signed application session enforced by middleware (non-user-specific channel status probe)';
  }
  if (route === '/classroom' && method === 'GET') {
    return 'auth-aware owner boundary: legacy share behavior; OIDC database-backed user identity with handler owner/tenant check';
  }
  if (route === '/classroom' && method === 'POST') {
    return 'auth-aware owner boundary: legacy anonymous or OIDC database-backed identity; server persists owner/tenant';
  }
  if (source.includes('withRequestOwnerId') && source.includes("ownerId.startsWith('user:')")) {
    return 'OIDC branch requires database-backed user identity; legacy behavior is handled separately';
  }
  if (source.includes('withRequestOwnerId')) {
    return 'auth-aware owner boundary (legacy anonymous or database-backed OIDC session; audit each method)';
  }
  if (source.includes('resolveRequestOwnerIdForRequest')) {
    return 'auth-aware owner resolution (database-backed OIDC session or legacy anonymous)';
  }
  if (source.includes('resolveRequestOwnerId')) return '直接解析匿名 owner';
  if (source.includes('requireAuthenticated') || source.includes('getServerSession')) {
    return '显式会话校验（需复核）';
  }
  return '未发现身份校验';
}

function policyFor(route, method) {
  if (route === '/health') return '公开：健康探针；仅输出非敏感状态';
  if (route === '/health/live')
    return '公开 GET/HEAD：进程存活探针；不查询数据库、存储或供应商，仅输出非敏感状态';
  if (route === '/health/ready')
    return '公开 GET/HEAD：应用就绪探针；仅返回最小可用状态，不暴露依赖详情';
  if (route === '/access-code/status') {
    return '公开状态探针：只报告访问码通道的启用/认证状态，不得授予企业业务权限；OIDC 下恒为 enabled:false 且不读取或签发任何凭据';
  }
  if (route.startsWith('/access-code/')) return '公开：访问码引导/验证，不得授予企业业务权限';
  if (route === '/tenant/members') {
    return '租户成员读取：签名应用会话 + tenant.member.read 权限（owner/admin）；member/viewer 403 且不触达存储；租户取自 session；响应 private,no-store；OIDC 入口已按精确 GET 开放（批次15），其它方法/子路径保持 503';
  }
  if (route === '/tenant/members/:userId') {
    return '租户成员与角色管理（迁移 0017）：签名应用会话 + tenant.member.manage 权限 + 同源写入；事务内按租户 advisory lock 串行化，秩守卫禁止越权授予/降级同秩、保护最后一个 active owner（409），未知/停用 subject 与移除时本租户无成员关系者统一 404 无 oracle；每次实际变更写 tenant_role_audit（source=api）；PUT 绑定角色、PATCH 暂停/恢复成员、DELETE 移除；响应 private,no-store；OIDC 入口已按精确 PUT/PATCH/DELETE 开放（批次15/19），其它方法/子路径保持 503';
  }
  if (route === '/tenant/audit') {
    return '租户角色变更审计读取：签名应用会话 + tenant.audit.read 权限（owner/admin）；member/viewer 403；租户取自 session；limit 有界（默认 50、上限 200）；响应 private,no-store；OIDC 入口已按精确 GET 开放（批次15），其它方法/子路径保持 503';
  }
  if (route === '/tenant/active') {
    return '活跃租户选择：签名应用会话（允许 tenant-required 状态）+ 写方法同源校验 + 存储内复核目标成员关系；切换到当前租户为幂等 no-op（不写审计）；租户取自 session/输入但必须已具备成员资格；响应 private,no-store；OIDC 入口已按精确 POST 开放（批次17），其它方法/子路径保持 503';
  }
  if (route === '/tenant/leave') {
    return '退出本租户：签名应用会话（允许 tenant-required）+ 自作用域（userId 取自 session，从不取输入）；存储拒绝末位 active owner（409）、非本租户 active 成员统一 404 无 oracle，并解除该用户会话的活动租户钉定；响应 private,no-store；OIDC 入口已按精确 POST 开放（批次19），其它方法/子路径保持 503';
  }
  if (route === '/tenant') {
    return '本人租户列表：签名应用会话（允许 tenant-required）+ 自作用域（按 session userId 查询，从不接受输入），不枚举他人成员关系；每项携带租户 status；响应 private,no-store；OIDC 入口已按精确 GET 开放（批次18），其它方法/子路径保持 503';
  }
  if (route === '/tenant/:tenantId') {
    return '租户改名/停用/启用：签名应用会话 + owner-only tenant.settings.manage 权限 + 同源写入；路径租户必须等于 session 当前租户（其它/未知一律 404 无 oracle），admin 被拒于触达存储之前；每次实际变更写 tenant_role_audit（source=api）；响应 private,no-store；OIDC 入口已按精确 PATCH 开放（批次18），其它方法/子路径保持 503';
  }
  if (route === '/azure-voices') {
    return 'BYOK Azure Speech voice-list 查询：OIDC handler 要求数据库-backed 用户 session 和非 viewer 写操作边界、PostgreSQL 5 次/60 秒用户限流、16 KiB 请求和 1 MiB 响应上限；只允许官方 Azure Speech regional/resource 主机、HTTPS 默认端口、根路径及固定 voice-list GET，连接时 DNS 固定公网地址；不合成音频。legacy 保留原自定义 endpoint 行为；0001–0004 已通过隔离 PG16.15 migrator/恢复演练；OIDC 入口已按精确 POST 开放（批次7），其它方法/子路径保持 503';
  }
  if (route.startsWith('/classroom-media/')) {
    return '课堂媒体：Node handler 对 OIDC 用户按存储 classroom 的 owner/tenant 校验（foreign/missing 404）并设 private,no-store，含路径穿越与 symlink 逃逸防护；旧文件无 owner 时拒绝；入口已按精确 GET（仅 media|audio 子目录）开放（批次6），读取按政策不限流；发布态跨用户共享策略另行验收；其它方法/子目录保持 503';
  }
  if (route === '/classroom') {
    if (method === 'GET') {
      return '课堂读取：OIDC 入口已按精确 GET 开放（批次5）；Node 层仅允许本人同 tenant 读取，foreign/missing/tenant mismatch 均 404 且 private,no-store；跨 owner 的 published/public 读取规则待验收；读取为低成本存储操作，不限流；legacy 分享链接行为保留';
    }
    if (method === 'POST') {
      return '课堂创建：handler 要求服务端 owner identity，服务端生成课堂 ID 并将 owner/tenant 写入存储；OIDC 入口已按精确 POST 开放（批次5），带每用户 5 次/60 秒限流（迁移 0012）';
    }
    return '课堂存储：未审查方法在 OIDC 下保持 503';
  }
  if (route === '/comfyui-workflows') {
    return '静态 workflow 文件索引：应用 session（数据库复核，含 viewer）+ no-store；只列 public 下文件名和展示名，不返回 workflow 内容';
  }
  if (route === '/server-providers') {
    return '只读部署能力元数据：应用 session（数据库复核，含 viewer）+ no-store；仅 provider IDs、模型 allowlist、disabled 标记和并发上限，不含密钥、base URL 或代理地址';
  }
  if (route === '/provider/probe-models') {
    return 'BYOK 模型探测：已认证用户 + 非 viewer 写操作 + 用户级数据库限流 + 严格公网 SSRF/DNS pinning + 有界请求/响应；不存储密钥';
  }
  if (route === '/verify-model') {
    return 'LLM 连接验证：应用用户 + 5 次/60 秒用户限流 + 每用户 UTC 月 LLM 配额 + 有界调用；BYOK 目标严格 SSRF/DNS pinning；proxy provider 暂保持关闭；不返回 provider 原始响应';
  }
  if (route === '/verify-image-provider') {
    return 'OIDC handler 仅支持 BYOK OpenRouter：数据库-backed user session/非匿名 owner、每用户 5 次/60 秒 PostgreSQL 限流、固定 HTTPS /key GET、严格公网 DNS pinning、拒绝重定向、1 MiB 响应上限并丢弃上游响应；不会提交生成请求，其他 image provider 503。迁移 0007 PG16.15 正式 migrator/恢复演练已通过；用户已按该策略验收，middleware 仅精确开放 POST';
  }
  if (route === '/verify-video-provider') {
    return 'OIDC handler 仅支持 BYOK OpenRouter：数据库-backed user session/非匿名 owner、每用户 5 次/60 秒 PostgreSQL 限流、固定 HTTPS /key GET、严格公网 DNS pinning、拒绝重定向、1 MiB 响应上限并丢弃上游响应；不会提交视频任务，其他 video provider 503。迁移 0008 PG16.15 正式 migrator/恢复演练已通过；用户已按该策略验收，middleware 仅精确开放 POST';
  }
  if (route === '/verify-pdf-provider') {
    return 'OIDC handler 已实现且仅支持 AliDocMind：应用 session/非 viewer + 每用户 5 次/60 秒限流；BYOK 严格公网 DNS pinning，managed endpoint 按 operator 网络策略；使用不提交解析任务的状态查询，错误净化；其它 PDF providers 在 OIDC 下 503。迁移 0005 的 PG16.15 正式 migrator、失败回滚、修复重试与幂等演练通过；OIDC 入口已按精确 POST 开放（批次8），其它方法/子路径保持 503';
  }
  if (route === '/extract-document') {
    return '同步课程材料抽取：OIDC handler 使用数据库 session/Origin/非 viewer owner boundary，响应 private,no-store；asset-id 输入按 verified user 解析资产 principal，legacy persistence credential 不作为 OIDC 身份；入口已按精确 POST 开放（批次4），带每用户 5 次/60 秒限流（迁移 0011）；managed provider 成本归属与 DNS-pinned extractor transport 仍随模态策略演进';
  }
  if (route === '/parse-pdf') {
    return '同步 PDF 解析：OIDC handler 要求数据库 session、Origin 和非 viewer owner boundary，响应 private,no-store 并净化 OIDC 错误；OIDC multipart 声明体积与 PDF 文件体积上限（50 MiB）在实际解析前 fail-closed；每次 provider 解析前消耗 parse_pdf 每用户 5 次/60 秒固定窗（迁移 0014）；客户端 provider baseUrl 沿用 extract-document 同一严格 public-only SSRF 前置校验（extractor transport DNS pinning 与 managed 成本归属随模态策略演进）；OIDC 入口已按精确 POST 开放（批次10），其它方法/子路径保持 503';
  }
  if (route === '/chat/pi') {
    return 'Pi 导演回合：认证主体 + Pi Chat 功能开关 + 每用户 chat_pi 5 次/60 秒固定窗（迁移 0016）+ LLM token 月配额；单回合驱动多步服务端导演循环（多次模型调用），OIDC 入口已按精确 POST 开放（批次13），其它方法/子路径保持 503';
  }
  if (route === '/chat/pi/whiteboard-visibility') {
    return '白板可见性回调：认证主体 + persistence principal 双闸；只结算本次 /chat/pi 回合内进程内存中待决的可见性查询（按 learnerKey 匹配），无 provider 成本故不限流；OIDC 入口已按精确 POST 开放（批次13），其它方法/子路径保持 503';
  }
  if (route.startsWith('/generate-classroom')) {
    return '课堂生成任务：提交记录和新写入 classroom 文件保存 owner/tenant，worker 更新与轮询按二者校验；OIDC 入口已按精确 POST（提交，带每用户 5 次/60 秒限流，迁移 0012）与 GET /:jobId（轮询，不限流）开放（批次5）；classroom-media 读取仍 503 待归属规则验收；其它方法/子路径保持 503';
  }
  if (route === '/skills/:id') {
    return '技能下载：所有下载要求应用 session；内置技能对已认证主体可用，用户技能仅资源 owner 可下载';
  }
  if (route.startsWith('/auth/')) {
    return 'OIDC protocol: login/callback state validation, session read, or CSRF-checked logout';
  }
  if (
    route.startsWith('/stages') ||
    route.startsWith('/stage-meta') ||
    route.startsWith('/folders') ||
    route.startsWith('/materials') ||
    route === '/server-providers' ||
    route.startsWith('/persistence') ||
    route.startsWith('/agent/')
  ) {
    return '资源级：认证主体 + 资源 owner/公开状态 + 子资源策略';
  }
  if (route.startsWith('/export-video/')) {
    if (route === '/export-video/capability') {
      return '渲染能力探测：仅返回 enabled/accepting，不暴露渲染服务地址或凭据；读取上游 health，仅允许已认证应用会话';
    }
    return '视频渲染任务：app 侧已持久绑定 job→owner（迁移 0009）且入口已开放；渲染服务 job store 为进程内存，compose 关闭 per-client 活跃任务限额；终态默认保留 30 分钟；每 (owner,tenant) 提交并发上限 3、计数窗口 15 分钟（软上限、滑窗自愈、超限 429+Retry-After、store 不可用 503 fail-closed）';
  }
  if (route === '/usage') return '用量级：认证主体 + 用户/租户范围，不接受客户端归属';
  if (
    route.startsWith('/generate') ||
    route.startsWith('/chat') ||
    route.startsWith('/pbl/') ||
    route === '/classroom' ||
    route.startsWith('/generate-classroom') ||
    route === '/parse-pdf' ||
    route === '/extract-document' ||
    route === '/transcription' ||
    route === '/web-search' ||
    route === '/quiz-grade' ||
    route === '/proxy-media'
  ) {
    return '计算/成本：认证主体 + 限流/预算 + 请求归属；临时公开例外需记录';
  }
  if (route.startsWith('/verify-') || route === '/provider/probe-models') {
    return '供应商配置：认证主体 + 限流；密钥和探测结果不可跨用户读取';
  }
  return '待人工定案：确认公开例外或补充认证、授权与成本策略';
}

function oidcGateFor(route, method) {
  if (route === '/health') return '公开 GET：仅健康探针';
  if (route === '/health/live')
    return '精确 GET/HEAD：公开进程存活探针；其他方法和子路径仍受默认拒绝';
  if (route === '/health/ready')
    return '精确 GET/HEAD：公开应用就绪探针；其他方法和子路径仍受默认拒绝';
  if (route.startsWith('/auth/')) return 'OIDC 协议入口：各处理器验证 state/session/origin';
  if (route === '/access-code/status') {
    return method === 'GET'
      ? '精确 GET（批次12 已验收）：签名应用会话 + middleware 精确放行（未登 401）；OIDC 下访问码通道永久停用，handler 返回 enabled:false、authenticated:false 且不读取或签发任何凭据，响应 private,no-store；其它方法与 /access-code/verify 保持 503'
      : 'OIDC 下 503：仅受控 GET 已开放（批次12）';
  }
  if (route === '/access-code/verify') {
    return 'OIDC 下 503：访问码签发的 openmaic_access cookie 在 OIDC 下无法放行任何业务路由，通道永久关闭（批次12）';
  }

  if (route === '/tenant/members' && method === 'GET') {
    return '精确 GET（批次15 已验收）：签名应用会话 + withTenantPermission 的 tenant.member.read 判定（未登 401 并清除失效 cookie、存储不可用 503、非 OIDC 503 fail-closed；member/viewer 403）；租户取自 session，只列本租户成员；响应 private,no-store；其它方法/子路径保持 503';
  }
  if (
    route === '/tenant/members/:userId' &&
    (method === 'PUT' || method === 'PATCH' || method === 'DELETE')
  ) {
    return '精确 PUT/PATCH/DELETE（批次15/19 已验收）：签名应用会话 + withTenantPermission 的 tenant.member.manage 判定（未登 401、member/viewer 403）+ 写方法同源校验（跨 Origin 403 INVALID_ORIGIN）；事务内按租户 advisory lock 串行化，秩守卫拒绝越权授予与同秩降级，保护最后一个 active owner（409），跨租户/未知/停用 subject 统一 404 无 oracle；实际变更写 tenant_role_audit（source=api，迁移 0017）；PUT 绑定角色、PATCH 暂停/恢复成员、DELETE 移除；响应 private,no-store；其它方法/子路径保持 503';
  }
  if (route === '/tenant/audit' && method === 'GET') {
    return '精确 GET（批次15 已验收）：签名应用会话 + withTenantPermission 的 tenant.audit.read 判定（未登 401、member/viewer 403）；租户取自 session，limit 有界；响应 private,no-store；其它方法/子路径保持 503';
  }
  if (route === '/tenant' && method === 'GET') {
    return '精确 GET（批次18 已验收）：签名应用会话（允许 tenant-required）+ 自作用域（按 session userId 查询）；只列本人成员关系及租户 status，不枚举他人；响应 private,no-store；其它方法保持 503';
  }
  if (route === '/tenant/:tenantId' && method === 'PATCH') {
    return '精确 PATCH（批次18 已验收）：签名应用会话 + owner-only tenant.settings.manage；路径租户必须等于 session 当前租户（其它/未知一律 404 无 oracle）+ 写方法同源校验；每次实际变更写 tenant_role_audit（source=api）；响应 private,no-store；其它方法/子路径保持 503';
  }
  if (route === '/tenant/active' && method === 'POST') {
    return '精确 POST（批次17 已验收）：签名应用会话（允许 tenant-required）+ 同源校验 + 存储内复核目标成员关系后切换 active_tenant_id；切换到当前租户为幂等 no-op；未登 401、跨 Origin 403、非成员 404；响应 private,no-store；其它方法保持 503';
  }
  if (route === '/tenant/leave' && method === 'POST') {
    return '精确 POST（批次19 已验收）：签名应用会话（允许 tenant-required）+ 自作用域（userId 取自 session）；存储拒绝末位 active owner（409）、非本租户 active 成员统一 404 无 oracle，并解除该用户会话的活动租户钉定；响应 private,no-store；其它方法保持 503';
  }
  if (route.startsWith('/tenant/')) {
    return 'OIDC 下 503：仅受控的成员/审计/租户设置 verb+path 已开放（批次15–19）';
  }

  if (route === '/parse-pdf' && method === 'POST') {
    return '精确 POST（批次10 已验收）：签名应用会话 + handler 内 withRequestOwnerId 边界、未启用匿名公读（未登 401、viewer 写 403、跨 Origin 403）；OIDC multipart 声明体积与 PDF 文件（50 MiB）上限在解析前 fail-closed；消耗 parse_pdf 每用户固定窗 5 次/60 秒（429+Retry-After、存储不可用 503 fail-closed，迁移 0014）；响应 private,no-store 且 OIDC 错误净化；客户端 provider baseUrl 走与 extract-document 相同的严格 public-only SSRF 守卫；其它方法/子路径保持 503';
  }
  if (route === '/parse-pdf') {
    return 'OIDC 下 503：仅受控 POST handler 已开放（批次10）';
  }

  if (
    method === 'GET' &&
    (/^\/stages\/:id(?:\/(?:scenes|manifest|status))?$/.test(route) ||
      /^\/stage-meta\/:stageId$/.test(route) ||
      /^\/persistence\/:\.\.\.path$/.test(route))
  ) {
    if (route.startsWith('/persistence/')) {
      return '仅 /documents 精确资源 GET 与 /assets/:id/content 可匿名候选；Node 层校验 owner/public/tombstone；其他路径需会话或 503';
    }
    return '匿名 GET 候选：Node 层必须确认资源未删除且为公开内容；其他请求需应用会话';
  }

  if (
    route === '/agent/runtime' ||
    route === '/agent/owner-events' ||
    route.startsWith('/agent/sessions') ||
    route.startsWith('/agent/skills') ||
    route.startsWith('/folders') ||
    route.startsWith('/materials') ||
    route.startsWith('/stages') ||
    route.startsWith('/stage-meta') ||
    route === '/comfyui-workflows' ||
    route === '/server-providers' ||
    route === '/export-video/capability' ||
    route === '/azure-voices' ||
    route === '/provider/probe-models' ||
    route === '/verify-model' ||
    route === '/verify-pdf-provider' ||
    route === '/verify-image-provider' ||
    route === '/verify-video-provider' ||
    route === '/usage' ||
    route.startsWith('/skills') ||
    /^\/persistence\/:\.\.\.path$/.test(route)
  ) {
    if (route === '/usage') {
      return method === 'GET'
        ? '精确 GET：签名应用会话 + Node 层数据库 session/成员资格复核；只返回当前用户在 session 所处租户的用量（owner + tenant 双过滤），legacy anonymous owner 拒绝'
        : 'OIDC 下 503：仅受控 GET 已开放';
    }
    if (route === '/agent/runtime') return '签名应用会话；仅返回非用户特定的功能状态';
    if (route === '/export-video/capability') {
      return method === 'GET'
        ? '精确 GET：签名应用会话；仅返回渲染能力是否可用，不暴露服务地址或凭据'
        : 'OIDC 下 503：仅受控 GET 已开放';
    }
    if (route === '/azure-voices') {
      return method === 'POST'
        ? '精确 POST（批次7 已验收）：签名应用会话 + handler 内 withRequestOwnerId（未登 401、viewer 写 403、跨 Origin 403）；user: 分支带 azure_voices 每用户 5 次/60 秒固定窗（429+Retry-After、存储不可用 503，迁移 0004）、官方 Azure Speech 主机白名单 + HTTPS 默认端口 + 根路径校验、DNS-pinned 公网-only transport、拒重定向、16 KiB 请求上限与净化错误；其它方法/子路径保持 503'
        : 'OIDC 下 503：仅受控 POST handler 已实现';
    }
    if (route === '/comfyui-workflows') {
      return '精确 GET：签名应用会话 + Node 层数据库 session/成员资格复核；只列 public workflow 文件名/展示名，响应 no-store';
    }
    if (route === '/server-providers') {
      return '精确 GET：签名应用会话 + Node 层数据库 session/成员资格复核；包含 viewer 的只读能力元数据，响应 no-store';
    }
    if (route === '/provider/probe-models') {
      return method === 'POST'
        ? '精确 POST：签名应用会话 + Node 层数据库 session/非 viewer 复核；BYOK；逐用户 PostgreSQL 限流；严格公网 SSRF/DNS pinning；输入和响应上限；响应 no-store'
        : 'OIDC 下 503：仅受控 POST 已开放';
    }
    if (route === '/verify-model') {
      return method === 'POST'
        ? '精确 POST：签名应用会话 + Node 层数据库 session/非 viewer 复核；owner-scoped callLLM 个人配额；5 次/用户/60 秒限流；严格 BYOK SSRF/DNS pinning；单次 30 秒、响应 1 MiB 上限；proxy provider 保持关闭；不返回原始 provider 文本'
        : 'OIDC 下 503：仅受控 POST 已开放';
    }
    if (route === '/verify-pdf-provider') {
      return method === 'POST'
        ? '精确 POST（批次8 已验收）：签名应用会话 + Node 层数据库 session/非 viewer 复核（非 user: owner 即 401）；每用户 verify_pdf_provider 5 次/60 秒（429+Retry-After、存储不可用 503，迁移 0005）；16 KiB 请求上限、HTTPS 默认端口端点归一化、BYOK 严格公网 DNS 校验（5 秒预算）与 DNS-pinned 验证客户端；错误净化、private,no-store；仅 AliDocMind，其它 PDF providers 由 handler 拒绝；其它方法/子路径保持 503'
        : 'OIDC 下 503：仅受控 POST handler 已实现';
    }
    if (route === '/verify-image-provider') {
      return method === 'POST'
        ? '精确 POST：签名应用会话 + Node 层数据库 session/非匿名 owner 复核；仅 BYOK OpenRouter 固定 /key GET；每用户 5 次/60 秒；严格公网 DNS pinning；拒绝重定向；1 MiB 响应上限并丢弃 body；不执行生成，其他 provider 由 handler 拒绝'
        : 'OIDC 下 503：仅受控 POST handler 已实现';
    }
    if (route === '/verify-video-provider') {
      return method === 'POST'
        ? '精确 POST：签名应用会话 + Node 层数据库 session/非匿名 owner 复核；仅 BYOK OpenRouter 固定 /key GET；每用户 5 次/60 秒；严格公网 DNS pinning；拒绝重定向；1 MiB 响应上限并丢弃 body；不创建视频任务，其他 provider 由 handler 拒绝'
        : 'OIDC 下 503：仅受控 POST handler 已实现';
    }
    if (route.startsWith('/skills/')) {
      return '签名应用会话；用户技能再由 Node 层按 owner 查验，内置技能为静态内容';
    }
    if (route.startsWith('/persistence/')) {
      if (method === 'POST') {
        return '仅 /documents、/runtime 与 /assets collection；assets 用内部用户 principal 分区';
      }
      return '仅 /documents、/runtime 子路径；assets 只允许 owner/public content GET/HEAD；替换、删除及其他子路径 503';
    }
    return '应用会话 + Node 层数据库会话复核 + 本路由 owner/资源授权';
  }

  // Entries admitted by name in middleware.ts `isOwnerScopedOidcApi` that the
  // coarse admit list above does not enumerate; keep in sync with the gate.
  if (
    method === 'POST' &&
    (route === '/generate/image' || route === '/generate/video' || route === '/generate/tts')
  ) {
    return '精确 POST：签名应用会话 + handler 内 withRequestOwnerId 边界（非 GET/跨 Origin/ viewer 拒绝）+ 每用户分模态月额度 reserve→settle（超限 429、存储不可用 503 fail-closed）；仅创建、不按 id 读取';
  }
  if (route === '/export-video/render' && method === 'POST') {
    return '精确 POST：签名应用会话；转发上游前先按 (owner,tenant) 计滑窗在途 job 数（上限 3、窗口 15 分钟），超限 429+Retry-After、store 不可用 503 fail-closed、legacy anon owner 跳过；随后校验 job id 形状并把 job→owner 绑定写入 app Postgres（绑定失败则取消上游、绝不广告未绑定 job）';
  }
  if (
    (route === '/export-video/render/:jobId' && (method === 'GET' || method === 'DELETE')) ||
    (route === '/export-video/render/:jobId/download' && method === 'GET')
  ) {
    return '精确方法：签名应用会话；handler 前置 job→owner 归属闸（未拥有→与缺失逐字节相同的 404、store 不可用→503），无存在性 oracle';
  }
  if (route === '/chat' && method === 'POST') {
    return '精确 POST：签名应用会话 + handler 内 withRequestOwnerId 边界（未登 401、viewer 写 403、跨 Origin 403）；每用户 api_chat 固定窗 5 次/60 秒（超限 429+Retry-After、限流存储不可用 503 fail-closed，迁移 0010）+ LLM token 月配额；无状态 SSE，课堂聊天入口；/chat/pi 与 /chat/pi/whiteboard-visibility 已在批次13 单独开放，其余 /chat 子路径保持 503';
  }
  if (route === '/chat/pi' && method === 'POST') {
    return '精确 POST（批次13 已验收）：签名应用会话 + handler 内 withRequestOwnerId 边界（未登 401、viewer 写 403、跨 Origin 403）；回合开始（任何 provider 调用之前）消耗 chat_pi 每用户固定窗 5 次/60 秒（429+Retry-After、存储不可用 503 fail-closed，迁移 0016）；无状态 SSE，单回合驱动多步服务端 Pi 导演循环（多次模型调用），仍受 Pi Chat 功能开关约束（关闭时 404）；其它方法/子路径保持 503';
  }
  if (route === '/chat/pi/whiteboard-visibility' && method === 'POST') {
    return '精确 POST（批次13 已验收）：签名应用会话 + handler 内 withRequestOwnerId 边界（未登 401、viewer 写 403、跨 Origin 403）+ persistence principal 双闸；只结算同一次 /chat/pi 回合在进程内存中待决的 whiteboard 可见性查询（按 learnerKey 匹配），无 provider 成本故不设独立限流；非本人或无待决查询统一 404 无 oracle；其它方法/子路径保持 503';
  }
  if (route === '/chat/pi' || route === '/chat/pi/whiteboard-visibility') {
    return 'OIDC 下 503：仅受控 POST 已开放（批次13）';
  }
  if (
    method === 'POST' &&
    (route === '/generate/voice' || route === '/quiz-grade' || route === '/generate/agent-profiles')
  ) {
    return '精确 POST：签名应用会话 + handler 内 withRequestOwnerId 边界（未登 401、viewer 写 403、跨 Origin 403）；每用户固定窗 5 次/60 秒（429+Retry-After、存储不可用 503，迁移 0010），quiz-grade/agent-profiles 另走 LLM token 月配额；voice 另有严格 public-only SSRF 入口守卫；其它方法/子路径保持 503';
  }
  if (
    method === 'POST' &&
    (route === '/generate/scene-content' ||
      route === '/generate/scene-actions' ||
      route === '/generate/scene-outlines-stream')
  ) {
    return '精确 POST：签名应用会话 + handler 内 withRequestOwnerId 边界（未登 401、viewer 写 403、跨 Origin 403）；每用户按路由固定窗 5 次/60 秒（429+Retry-After、存储不可用 503，迁移 0010）+ LLM token 月配额；无状态场景生成，按 stage 归属写回；其它方法/子路径保持 503';
  }
  if (
    method === 'POST' &&
    (route === '/pbl/v2/instructor' ||
      route === '/pbl/v2/evaluate' ||
      route === '/pbl/v2/open-task' ||
      route === '/pbl/v2/simulator' ||
      route === '/pbl/v2/task/update')
  ) {
    return '精确 POST：签名应用会话 + handler 内 withRequestOwnerId 边界（未登 401、viewer 写 403、跨 Origin 403）；每用户按路由固定窗 5 次/60 秒（429+Retry-After、存储不可用 503，迁移 0010）+ LLM token 月配额；无状态 PBL 导师回合，project 状态由客户端往返、补丁客户端应用；/pbl/v2 其它路径保持 503';
  }
  if (method === 'POST' && (route === '/extract-document' || route === '/transcription')) {
    return '精确 POST：签名应用会话 + handler 内 withRequestOwnerId 边界（未登 401、viewer 写 403、跨 Origin 403）；每用户按路由固定窗 5 次/60 秒（429+Retry-After、存储不可用 503，迁移 0011）；extract-document 走服务端资产解析+SSRF 守卫、transcription 客户端 BYOK baseUrl 走严格 public-only 守卫；其它方法/子路径保持 503';
  }
  if (
    (route === '/classroom' && (method === 'GET' || method === 'POST')) ||
    (route === '/generate-classroom' && method === 'POST') ||
    (route === '/generate-classroom/:jobId' && method === 'GET')
  ) {
    return 'Batch 5（已验收）精确 verb+path：签名应用会话 + handler 内 withRequestOwnerId 边界、未启用匿名公读（未登 401、viewer 写 403、跨 Origin 403）；两条 POST 带每用户固定窗 5 次/60 秒（429+Retry-After、存储不可用 503，迁移 0012），GET 读取不限流（只读、owner/tenant 私有的 classroom 数据）；classroom GET 对 foreign/missing/tenant 不符统一 404 无 oracle；其它方法/子路径保持 503';
  }
  if (route.startsWith('/classroom-media/') && method === 'GET') {
    return 'Batch 6（已验收）精确 GET（仅 media|audio 子目录）：签名应用会话 + handler 内 withRequestOwnerId 边界、未启用匿名公读（未登 401）；按存储 classroom 的 owner/tenant 校验，foreign/missing 统一 404 无 oracle，user owner 响应 private,no-store；路径穿越与 symlink 逃逸防护在 handler；媒体字节读取按政策不限流；其它方法/子目录保持 503';
  }

  if (route === '/web-search' && method === 'POST') {
    return '精确 POST（批次9 已验收）：签名应用会话 + handler 内 withRequestOwnerId 边界、未启用匿名公读（未登 401、viewer 写 403、跨 Origin 403）；每次 provider 调用前消耗 web_search 每用户固定窗 5 次/60 秒（429+Retry-After、存储不可用 503 fail-closed，迁移 0013）；provider 选择、managed/BYOK 密钥优先级与 SearXNG operator-only baseUrl 均在 handler 内；其它方法/子路径保持 503';
  }
  if (route === '/proxy-media' && method === 'POST') {
    return '精确 POST（批次11 已验收）：签名应用会话 + handler 内 withRequestOwnerId 边界、未启用匿名公读（未登 401、viewer 写 403、跨 Origin 403）；高频媒体代理消耗 proxy_media 每用户 60 次/60 秒固定窗（429+Retry-After、存储不可用 503 fail-closed，迁移 0015）；每跳保留 SSRF 守卫与 pinned dispatcher、25 MiB 上限；成功响应 private,max-age=3600（媒体可缓存）；其它方法/子路径保持 503';
  }
  if (route === '/proxy-media') {
    return 'OIDC 下 503：仅受控 POST handler 已开放（批次11）';
  }

  return 'OIDC 下 503：尚未接通应用身份、资源授权与成本策略';
}

const files = (await collectRoutes(apiRoot)).sort();
const rows = await Promise.all(
  files.map(async (file) => {
    const source = await readFile(file, 'utf8');
    const route = routePath(file);
    return {
      route,
      methods: routeMethods(source),
      source,
    };
  }),
);

const actionFiles = [];
for (const base of ['app', 'components', 'lib', 'packages']) {
  if (!(await pathExists(path.join(root, base)))) continue;
  const files = await collectSourceFiles(path.join(root, base));
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    if (/^\s*['"]use server['"]/m.test(source)) {
      actionFiles.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (
        entry.isDirectory() &&
        ['.next', 'build', 'dist', 'node_modules', '.turbo'].includes(entry.name)
      ) {
        return [];
      }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(fullPath);
      return entry.isFile() ? [fullPath] : [];
    }),
  );
  return files.flat();
}

async function pathExists(target) {
  try {
    await readdir(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

const methodCount = rows.reduce((count, row) => count + row.methods.length, 0);
const lines = [
  '# Enterprise identity and route inventory',
  '',
  `Generated from \`app/api/**/route.ts\` by \`node scripts/audit-enterprise-routes.mjs\`. Routes: ${rows.length}; explicitly exported HTTP methods: ${methodCount}.`,
  '',
  '> This is a static coverage inventory, not proof that a route is secure. Legacy anonymous owners partition data by a client-held cookie and do not authenticate a person.',
  '> The OIDC gate column is method-specific. Public candidates still depend on the Node handler and storage layer enforcing owner/public/tombstone policy; this generated file does not prove that behavior.',
  '',
  '| Route | Method | Current identity evidence | OIDC gate | Required enterprise policy |',
  '|---|---|---|---|---|',
  ...rows.map((row) =>
    row.methods
      .map(
        (method) =>
          `| \`${row.route}\` | \`${method}\` | ${currentIdentity(row.source, row.route, method)} | ${oidcGateFor(row.route, method)} | ${policyFor(row.route, method)} |`,
      )
      .join('\n'),
  ),
  '',
  '## Server Action entry points',
  '',
  ...actionFiles
    .sort()
    .map((file) =>
      file === 'lib/workbench/workspace-actions.ts'
        ? `- \`${file}\` — \`deleteWorkspaceSession\`: OIDC database session + exact Origin + non-viewer check, then owner-scoped soft delete; legacy mode retains anonymous owner behavior.`
        : `- \`${file}\` — audit every exported action as a direct request entry point; middleware alone is not an authorization boundary.`,
    ),
  '',
  '## Initial findings',
  '',
  '- Routes using the anonymous owner wrapper have useful legacy partitioning but are not authenticated user identities.',
  '- Routes without a recognized identity helper are classified by function and must either gain trusted identity and authorization or be recorded as an explicit public exception.',
  '- Job status, event-stream, cancellation and download methods each need resource-owner enforcement; access to a job identifier is not authorization.',
  '- Routes outside the OIDC allowlist return 503. Update this inventory and add an authorization test before exposing another business route.',
  '',
];

await import('node:fs/promises').then(({ mkdir }) =>
  mkdir(path.dirname(outputPath), { recursive: true }),
);
await writeFile(outputPath, lines.join('\n'));
process.stdout.write(
  `Wrote ${path.relative(root, outputPath)} (${rows.length} routes, ${methodCount} methods).\n`,
);
