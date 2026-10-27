/**
 * 全系统操作留痕（审计日志）
 *
 * ============================================================
 * 【要解决什么问题】
 *
 *   改造前，`sms_perm.t_perm_log` 只被「权限管理」板块内部的
 *   `addLog()` 写入 —— 也就是说操作日志里只能看到「谁改了权限」，
 *   而市场咨询新建学生、财务确认收款、班主任提交休学、教务导出名单……
 *   **一件都不留痕**。用户要求：
 *
 *     「操作日志要记录整个系统中的操作记录，
 *       每一个登录系统的账号在里面有过的操作就记录在操作日志页面」
 *
 * 【为什么做成全局中间件，而不是去每个接口里补 addLog】
 *
 *   全系统 300+ 个接口散落在 8 个模块里，逐个补一定会漏（而且以后
 *   新人加接口也不会记得补）。挂在最外层，**新增接口自动被覆盖**，
 *   这是唯一能做到「不漏」的写法。
 *
 * 【记录范围（这是刻意收窄的，不要随便放宽）】
 *
 *   ✅ 登录 / 登出（成功与失败都记 —— 失败登录是安全审计的重点）
 *   ✅ 所有写操作：POST / PUT / PATCH / DELETE
 *   ✅ 导出 / 下载（GET 也记，因为「谁把数据导走了」必须留痕）
 *   ✅ 少数敏感查询（查看完整手机号）
 *   ❌ 普通列表 / 详情 GET —— 不记。
 *      一进页面就会打十几个 GET，全记的话 90% 的日志是噪音，
 *      真正的操作反而被淹掉。
 *   ❌ `/api/perm/**` —— 权限管理板块内已有 40+ 处精细 `addLog()`
 *      （带变更前后的真实字段值），这里再记一遍会**双份**。
 *
 * 【写入方式】
 *
 *   不是每个请求插一条，而是先进内存队列，攒 600ms 或满 30 条批量 insert。
 *   `res.on('finish')` 之后才入队，**绝不阻塞用户请求**；
 *   写库失败只打日志，不影响业务（与 addLog 的口径一致）。
 *
 * 【操作人怎么认】
 *
 *   各模块的 `req.user` 字段并不统一：
 *     · 主鉴权（job/edu/teaching）→ userId=门户 UUID，另有 businessUserId=U004
 *     · 咨询                       → userId=咨询库 id
 *     · 财务 / 权限                → userId=门户 UUID
 *   而日志表要的是**权限库的 U 编号 + 中文职位名**（否则「所属职位」列
 *   又会显示 SYS_STAFF 这种英文）。所以这里统一用 `account`（登录名）
 *   回查 `t_perm_user`，结果缓存 60 秒 —— 同一账号的连续操作只查一次库。
 */

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../perm/utils/db';

const TABLE = 't_perm_log';

/* ============================================================
 * 一、哪些请求要记
 * ============================================================ */

/** 写方法：一律记录 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 整段跳过的前缀
 *
 * ⚠️ `/api/perm` 是刻意排除的 —— 权限板块每个写接口内部都有精细 addLog，
 *    全局再记一遍会变成两条一模一样的日志（一条带 before/after，一条只有请求参数）。
 */
const SKIP_PREFIXES = [
  '/health',
  '/api-docs',
  '/api/class/docs',
  '/uploads',
  '/api/perm',
];

/**
 * 敏感查询白名单：GET 也要记
 *
 * 这些是「看了不该看的东西」也算操作的接口（完整手机号、导出、下载）。
 */
const SENSITIVE_GET = [
  '/export',
  '/download',
  '/template',
  '/full-phone',
  '/fullphone',
  '/phone-full',
  '/reveal',
];

function shouldRecord(req: Request): boolean {
  const path = req.path;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS' || method === 'HEAD') return false;
  if (SKIP_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) return false;

  if (WRITE_METHODS.has(method)) return true;
  if (method === 'GET') {
    const lower = path.toLowerCase();
    return SENSITIVE_GET.some((k) => lower.includes(k)) && !lower.includes('/perm/log');
  }
  return false;
}

/* ============================================================
 * 二、路径 → 模块名 / 资源名 / 动作类型
 * ============================================================ */

/**
 * 模块名（与左侧菜单的板块叫法保持一致）
 *
 * ⚠️ 顺序敏感：`/api/class-jh` 必须排在 `/api/class` 前面，
 *    否则初高的日志会全被记成「班级管理」。
 */
const MODULE_BY_PREFIX: [string, string][] = [
  ['/api/portal', '系统门户'],
  ['/api/consult', '市场咨询'],
  ['/api/finance', '财务管理'],
  ['/api/perm', '权限管理'],
  ['/api/class-jh', '教学管理·初高'],
  ['/api/class', '班级管理'],
  ['/api/teaching', '教学管理'],
  ['/api/edu', '教务管理'],
  ['/api/job', '就业管理'],
];

function resolveModule(path: string): string {
  const hit = MODULE_BY_PREFIX.find(([prefix]) => path === prefix || path.startsWith(prefix + '/'));
  return hit ? hit[1] : '系统';
}

/**
 * 路径段 → 中文资源名
 *
 * 只做「词 → 中文」的映射，具体取哪一段由下面的 resolveResource 决定
 * （它会跳过 approve / reject 这类动作段，取真正的业务段再拼「审批」）。
 */
const RESOURCE_NAME: Record<string, string> = {
  account: '账号',
  approve: '审批',
  attendance: '出勤',
  bill: '账单',
  building: '楼栋',
  class: '班级',
  'class-info': '班级信息',
  'class-student': '班级学员',
  'class-transfer': '班级交接',
  consult: '咨询',
  dept: '部门',
  dorm: '宿舍',
  edu: '教务',
  'emp-dorm': '就业基地宿舍',
  'employment-log': '就业日志',
  exam: '考试',
  'exam-score': '成绩',
  fee: '缴费',
  'fee-call': '催费',
  freeze: '冻结名单',
  handover: '交接',
  installment: '分期付款',
  leave: '休退学',
  log: '操作日志',
  loss: '流失记录',
  menu: '权限点',
  notice: '通知',
  option: '字典',
  page: '页面',
  payment: '缴费',
  refund: '退费',
  review: '就业复盘',
  role: '职位',
  rule: '规则',
  score: '成绩',
  setting: '设置',
  standard: '费用标准',
  statistics: '就业统计',
  student: '学员',
  'student-leave': '休退学',
  upgrade: '升实训交接',
  user: '账号',
};

/**
 * 资源名：取路径里最深的一个业务段
 *
 * 例：`/api/consult/student/123/follow` → 学员
 *     `/api/teaching/refund/approve`    → 退费审批
 *     `/api/finance/fee/plan/save`      → 缴费
 *
 * ★ 2026-10-26：原来 `/api/teaching/refund/approve` 取最深段得到的是「审批」，
 *   日志里写成「审批 #uuid」，既看不出审批的是什么，现在 UUID 去掉后更只剩「审批」两个字。
 *   所以遇到 approve / reject 这类动作段时，要把它前面那个业务段带上 ——
 *   → 「退费审批」「休退学审批」「咨询审批」。一眼就知道批的是哪类单据。
 */
const APPROVE_SEG = new Set(['approve', 'reject', 'audit', 'approval', 'pass', 'refuse']);

function resolveResource(path: string): string {
  const segs = path
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  let biz = '';
  let hasApprove = false;
  for (const seg of segs) {
    if (APPROVE_SEG.has(seg)) {
      hasApprove = true;
      continue;
    }
    if (RESOURCE_NAME[seg]) biz = RESOURCE_NAME[seg];
  }

  if (hasApprove) return biz ? `${biz}审批` : '审批';
  return biz;
}

/** 路径里出现这些词 = 审批类动作（优先级最高，要压过「修改/新增」） */
const APPROVE_WORDS = [
  'approve',
  'reject',
  'audit',
  'refuse',
  'approval',
  '/pass',
  'transfer-approve',
];

/** 出现这些词 = 修改类（不是新增） */
const EDIT_WORDS = [
  'update',
  'edit',
  'save',
  'set-',
  '/set',
  'status',
  'reset',
  'copy',
  'revoke',
  'grant',
  'toggle',
  'enable',
  'disable',
  'bind',
  'unbind',
  'transfer',
  'assign',
  'sort',
  'publish',
  'claim',
  'allocate',
  'receive',
  'sync',
  'confirm',
  'finish',
  'close',
  'open',
  'restore',
  'checkin',
  'checkout',
];

const DELETE_WORDS = ['delete', '/del', 'remove', 'revoke-batch', 'batch-del'];

function resolveActionType(method: string, path: string): string {
  const p = path.toLowerCase();

  if (p.includes('/login')) return '登录';
  if (p.includes('/logout')) return '登出';
  if (APPROVE_WORDS.some((w) => p.includes(w))) return '审批';
  if (p.includes('export') || p.includes('download')) return '导出';
  if (p.includes('import') || p.includes('upload')) return '导入';

  if (method === 'DELETE') return '删除';
  if (DELETE_WORDS.some((w) => p.includes(w))) return '删除';
  if (method === 'PUT' || method === 'PATCH') return '修改';
  if (EDIT_WORDS.some((w) => p.includes(w))) return '修改';
  if (method === 'POST') return '新增';
  return '查询';
}

/* ============================================================
 * 三、请求体摘要（脱敏）
 * ============================================================ */

/** 这些字段一律打码，日志里不能留明文口令 */
const SECRET_KEY = /pass(word)?|pwd|token|secret|credential/i;

/**
 * 把请求体压成一行可读摘要
 *
 * ⚠️ 两个坑：
 *   ① 缴费凭证 / 复盘录音是 base64 dataURL，动辄几 MB —— 直接 JSON.stringify
 *      会写爆日志表，这里超过 120 字符的字符串一律折叠成 `[长文本 N 字符]`。
 *   ② 嵌套对象最多展开一层，太深的话摘要没人看得懂。
 */
function summarizeBody(body: any): string {
  if (body === null || body === undefined) return '';
  if (typeof body !== 'object') return String(body).slice(0, 120);

  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, any>)) {
    if (v === null || v === undefined || v === '') continue;

    if (SECRET_KEY.test(k)) {
      flat[k] = '***';
      continue;
    }

    if (typeof v === 'string') {
      if (v.length > 120) flat[k] = `[长文本 ${v.length} 字符]`;
      else if (/^data:/.test(v)) flat[k] = '[二进制数据]';
      else flat[k] = v;
      continue;
    }

    if (typeof v === 'object') {
      const s = JSON.stringify(v);
      flat[k] = s.length > 120 ? `[${Array.isArray(v) ? v.length + ' 项' : '对象'}]` : s;
      continue;
    }

    flat[k] = v;
  }

  const s = JSON.stringify(flat);
  return s.length > 900 ? s.slice(0, 900) + '…' : s;
}

/**
 * 机器 ID（UUID / 长 hash）识别
 *
 * ⚠️ 2026-10-26 用户反馈（截图）：操作日志的「操作对象」列出现
 *   `咨询 #4d4b4781-857c-43b4-999e-a57667a59cb9`
 *   `班级 #5d06d652-b7df-45a9-9b2d-a9a61679eb66`
 *   这种一串字母加连字符 —— 那是**数据库主键**，对使用者没有任何意义，
 *   既读不出是哪条记录，也没法拿去搜索（换台机器就不同）。
 *
 *   根因就在下面这两个函数：`pickTargetId()` 从请求体里抓 id，
 *   `buildTarget()` 无条件拼成 `资源 #id`。而当请求体里没有 name 类字段时
 *   （`/api/teaching/class/change-status`、`/api/class/student/update`
 *   `/api/teaching/refund/approve` … 都只传 id），界面上就只剩这串乱码。
 *
 *   现在：只保留「人类可读的业务编号」（#S001 / #FEE-26006-3 这类），
 *   UUID 一律不进日志。真正想精确到某条记录时，由业务路由设 `req.auditTarget`
 *   把中文名带上（见 buildTarget 下方说明）。
 */
const OPAQUE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[0-9A-Za-z_-]{32,})$/i;

/** 是不是一串不该出现在界面上的机器 ID */
function isOpaqueId(v: string): boolean {
  return OPAQUE_ID.test(String(v).trim());
}

/** 从请求体里挑「最能说明是哪条记录」的字段 */
function pickTargetName(body: any): string {
  if (!body || typeof body !== 'object') return '';
  const keys = [
    // 名称类
    'name',
    'studentName',
    'student_name',
    'userName',
    'user_name',
    'roleName',
    'role_name',
    'deptName',
    'dept_name',
    'className',
    'class_name',
    'examName',
    'exam_name',
    'courseName',
    'course_name',
    'itemName',
    'item_name',
    'batchName',
    'batch_name',
    'buildingName',
    'building_name',
    'roomName',
    'room_name',
    'dormName',
    'dorm_name',
    'title',
    'account',
    // ★ 2026-10-26 扩充：编号类字段同样是「人话」——
    //   缴费单号、学员编号、考试批次等，比裸 UUID 有用得多
    'no',
    'code',
    'orderNo',
    'order_no',
    'feeNo',
    'fee_no',
    'studentNo',
    'student_no',
    'examNo',
    'exam_no',
  ];
  for (const k of keys) {
    const v = (body as any)[k];
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim();
      // 字段本身也可能塞的是 ID，同样不能当名称用
      if (isOpaqueId(s)) continue;
      return s.slice(0, 40);
    }
  }
  return '';
}

function pickTargetId(body: any): string {
  if (!body || typeof body !== 'object') return '';
  const keys = ['id', 'studentId', 'student_id', 'classId', 'class_id', 'roleId', 'role_id', 'userId', 'user_id'];
  for (const k of keys) {
    const v = (body as any)[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).slice(0, 36);
  }
  return '';
}

/**
 * 操作对象：`学员 #S001 张三`
 *
 * 组成规则（按顺序，能拿到几段拼几段）：
 *   ① 资源名（如「班级」「退费」「学员」）
 *   ② 业务编号 —— **仅当它不是 UUID/hash 时**才带 `#` 显示
 *   ③ 中文名称
 *
 * 三段都没有时至少留资源名，绝不留空、也绝不出现主键。
 * 想更精确（例如「班级 高中一班（高二）」），业务路由可以在写库前设
 *   `(req as any).auditTarget = '班级 高中一班';`
 * 中间件会优先采用（见下方 targetObj 的取值）。
 */
function buildTarget(path: string, body: any): string {
  const resource = resolveResource(path) || '接口';
  const id = pickTargetId(body);
  const name = pickTargetName(body);
  const bizNo = id && !isOpaqueId(id) ? `#${id}` : '';
  return [resource, bizNo, name].filter(Boolean).join(' ').slice(0, 120);
}

/* ============================================================
 * 四、操作人解析（账号 → 权限库 U 编号 + 中文职位）
 * ============================================================ */

interface OperatorProfile {
  userId: string;
  userName: string;
  roleNames: string;
}

/** account → 解析结果（null 表示权限库里没这个人，例如纯门户账号） */
const profileCache = new Map<string, { at: number; value: OperatorProfile | null }>();
const PROFILE_TTL = 60_000;

/**
 * 把「操作人标识」解析成权限库的用户 id + 中文职位
 *
 * ⚠️ 为什么入参是 `keys` 而不是 `accounts`：
 *   各模块的 `req.user` 字段并不统一 —— 主鉴权（就业/教务/教学）**没有 account 字段**，
 *   只有 userName（如「刘会计」）。如果只用 account 去查，这些人一律解析失败，
 *   日志的「所属职位」列就会退回 `FIN_STAFF` / `RM_PRINCIPAL` 这种英文码（实测踩到）。
 *   所以：
 *     ① 先按 account 批量查；
 *     ② 没命中的，再按 user_name（姓名）批量查 —— 姓名是门户账号 ↔ 权限库唯一能对上的键。
 */
async function resolveProfiles(keys: string[]): Promise<Map<string, OperatorProfile | null>> {
  const out = new Map<string, OperatorProfile | null>();
  const now = Date.now();
  const need: string[] = [];

  for (const key of keys) {
    if (!key) continue;
    const hit = profileCache.get(key);
    if (hit && now - hit.at < PROFILE_TTL) out.set(key, hit.value);
    else need.push(key);
  }

  if (!need.length) return out;

  try {
    const uniq = Array.from(new Set(need)) as string[];
    const byKey = new Map<string, OperatorProfile>();

    /** 一次查询 → 把命中的行写进 byKey（按传入的 key 归一化） */
    const collect = async (rows: { id: string; account: string; user_name: string }[]) => {
      if (!rows.length) return;
      const ids = rows.map((u) => u.id);
      const links = (await db('t_perm_user_role as ur')
        .join('t_perm_role as r', 'r.id', 'ur.role_id')
        .whereIn('ur.user_id', ids)
        .where('ur.is_deleted', false)
        .where('r.is_deleted', false)
        .select('ur.user_id as uid', 'r.role_name as roleName')) as {
        uid: string;
        roleName: string;
      }[];

      const rolesOf = new Map<string, string[]>();
      links.forEach((l) => {
        const arr = rolesOf.get(l.uid) || [];
        if (l.roleName) arr.push(l.roleName);
        rolesOf.set(l.uid, arr);
      });

      rows.forEach((u) => {
        const profile: OperatorProfile = {
          userId: u.id,
          userName: u.user_name || u.account,
          roleNames: Array.from(new Set(rolesOf.get(u.id) || [])).join('、'),
        };
        byKey.set(u.account, profile);
        if (u.user_name) byKey.set(u.user_name, profile);
      });
    };

    const byAccount = (await db('t_perm_user')
      .whereIn('account', uniq)
      .where('is_deleted', false)
      .select('id', 'account', 'user_name')) as { id: string; account: string; user_name: string }[];
    await collect(byAccount);

    const stillMissing = uniq.filter((k) => !byKey.has(k));
    if (stillMissing.length) {
      const byName = (await db('t_perm_user')
        .whereIn('user_name', stillMissing)
        .where('is_deleted', false)
        .select('id', 'account', 'user_name')) as {
        id: string;
        account: string;
        user_name: string;
      }[];
      await collect(byName);
    }

    for (const key of uniq) {
      const value = byKey.get(key) ?? null;
      profileCache.set(key, { at: now, value });
      out.set(key, value);
    }
  } catch (e) {
    // 查库失败不能把日志丢掉：退化成「用 token 里的信息」，后续读日志时还会再解析一次
    console.error('[auditLog] 解析操作人失败：', (e as Error).message);
  }

  return out;
}

/* ============================================================
 * 五、设备识别
 * ============================================================ */

function describeDevice(ua: string): string {
  if (!ua) return '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '';
  const os = /Windows NT 10/.test(ua)
    ? 'Windows 10/11'
    : /Windows NT/.test(ua)
      ? 'Windows'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad/.test(ua)
            ? 'iOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  const parts = [browser, os].filter(Boolean);
  return parts.length ? parts.join(' / ') : '未知设备';
}

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket?.remoteAddress || '').replace('::ffff:', '');
}

/* ============================================================
 * 六、写入队列（批量 + 异步，绝不阻塞业务）
 * ============================================================ */

interface PendingLog {
  at: Date;
  account: string;
  /** 解析操作人用的键：优先登录名，没有就退化成姓名（见 resolveProfiles 的说明） */
  lookupKey: string;
  userId: string;
  userName: string;
  roleRaw: string;
  moduleName: string;
  actionType: string;
  targetObj: string;
  beforeValue: string;
  afterValue: string;
  ip: string;
  result: string;
  apiPath: string;
  httpMethod: string;
  statusCode: number;
  durationMs: number;
  device: string;
}

const queue: PendingLog[] = [];
let flushing = false;
let timer: NodeJS.Timeout | null = null;

/** 满 30 条立即刷，否则攒 600ms */
const BATCH_SIZE = 30;
const FLUSH_DELAY = 600;

function scheduleFlush(): void {
  if (timer || flushing) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_DELAY);
  // 不要让日志队列拖住进程退出
  (timer as any).unref?.();
}

async function flush(): Promise<void> {
  if (flushing || !queue.length) return;
  flushing = true;

  const batch = queue.splice(0, queue.length);
  try {
    const profiles = await resolveProfiles(batch.map((b) => b.lookupKey));
    const now = new Date();

    const rows = batch.map((b) => {
      const p = b.lookupKey ? profiles.get(b.lookupKey) : null;
      const operatorId = p?.userId || b.userId || 'system';
      return {
        id: randomUUID(),
        log_time: b.at,
        operator_id: operatorId,
        operator_name: (p?.userName || b.userName || b.account || '系统自动').slice(0, 50),
        // 已解析成中文的职位名直接落库；解析不到就留空，读日志时还会按 id 再兜底一次
        operator_role: (p?.roleNames || b.roleRaw || '').slice(0, 50),
        module_name: b.moduleName.slice(0, 32),
        action_type: b.actionType.slice(0, 20),
        target_obj: b.targetObj.slice(0, 128),
        before_value: (b.beforeValue || '—').slice(0, 1000),
        after_value: (b.afterValue || '').slice(0, 1000),
        ip: b.ip.slice(0, 64),
        result: b.result,
        api_path: b.apiPath.slice(0, 255),
        http_method: b.httpMethod.slice(0, 10),
        status_code: b.statusCode,
        duration_ms: b.durationMs,
        user_agent: b.device.slice(0, 255),
        is_deleted: false,
        create_time: now,
        create_by: operatorId.slice(0, 36),
      };
    });

    await db(TABLE).insert(rows);
  } catch (e) {
    console.error('[auditLog] 批量写日志失败：', (e as Error).message);
  } finally {
    flushing = false;
    if (queue.length) scheduleFlush();
  }
}

/* ============================================================
 * 七、中间件本体
 * ============================================================ */

/** 成功响应码：全系统统一是 200（各模块 BizCode.SUCCESS 同值） */
const SUCCESS_CODE = 200;

export function auditLog(req: Request, res: Response, next: NextFunction): void {
  if (!shouldRecord(req)) {
    next();
    return;
  }

  const startAt = Date.now();
  const at = new Date();
  const method = req.method.toUpperCase();
  const path = req.originalUrl.split('?')[0] || req.path;
  const actionType = resolveActionType(method, path);
  const moduleName = resolveModule(path);
  const isLogin = path.includes('/login');

  /** 捕获响应体：只有拿到 body 才能判断「业务上成没成功」（HTTP 200 也可能是失败） */
  let captured: any = null;
  const originalJson = res.json.bind(res);
  res.json = function patchedJson(body: any) {
    captured = body;
    return originalJson(body);
  } as typeof res.json;

  res.on('finish', () => {
    try {
      /**
       * ⚠️ 401 / 404 不记：
       *   401 = token 过期，前端会连打十几个请求全部 401，记下来就是刷屏；
       *   404 = 接口根本不存在（前端调错地址），那是开发期问题，不是「业务操作」。
       *   这两种进了日志只会把真实的操作淹掉。
       */
      if (res.statusCode === 401 || res.statusCode === 404) return;

      const httpOk = res.statusCode < 400;
      const bizCode = captured && typeof captured === 'object' ? captured.code : undefined;
      const success = httpOk && (bizCode === undefined || bizCode === SUCCESS_CODE);
      const bizMessage =
        captured && typeof captured === 'object' && typeof captured.message === 'string'
          ? String(captured.message)
          : '';

      // ---- 操作人：正常请求从 req.user 取；登录请求从请求体取账号 ----
      const u: any = (req as any).user || {};
      const account = String(
        u.account || (isLogin ? (req.body as any)?.account : '') || '',
      ).slice(0, 50);

      // 服务间调用（x-internal-token）没有登录态
      const isInternal = !!req.headers['x-internal-token'];

      const userId = String(u.businessUserId || u.userId || '');
      const userName = String(u.userName || account || '');
      const roleRaw = Array.isArray(u.roles) ? u.roles.join('、') : String(u.roles || '');
      /**
       * 解析操作人的键
       * ⚠️ 主鉴权的 req.user 没有 account 字段，只有 userName ——
       *    这种情况必须用姓名兜底，否则「所属职位」会退回 FIN_STAFF 这种英文码。
       */
      const lookupKey = account || userName;

      // ---- 请求体摘要 ----
      const summary = summarizeBody(req.body);
      /**
       * 操作对象
       *
       * ① 登录 → 固定「系统登录」
       * ② 业务路由可用 `(req as any).auditTarget = '班级 高中一班'` 显式指定（最精确）
       * ③ 否则按路径 + 请求体推导（**不会再输出 UUID**，见 buildTarget）
       */
      const explicitTarget = String((req as any).auditTarget || '').trim();
      const targetObj = isLogin
        ? '系统登录'
        : (explicitTarget || buildTarget(path, req.body)).slice(0, 120);

      // ---- 变更前 / 后 ----
      //    ⚠️ 通用中间件拿不到「数据库里的旧值」（那需要每个接口自己查一次），
      //       所以这里只保证「改成了什么」一定留痕，「原来是什么」由
      //       权限管理板块内部那些精细 addLog 负责（它们有真实 before）。
      let beforeValue = '—';
      let afterValue = summary;

      if (actionType === '删除') {
        beforeValue = summary || targetObj;
        afterValue = '已删除';
      } else if (actionType === '修改' && summary) {
        beforeValue = targetObj;
      } else if (actionType === '审批') {
        beforeValue = targetObj;
      } else if (actionType === '登录') {
        afterValue = success ? '登录成功' : `登录失败：${bizMessage || '账号或密码错误'}`;
      } else if (actionType === '导出') {
        afterValue = summary || '按当前筛选条件导出';
      }

      if (!success && actionType !== '登录') {
        afterValue = `操作失败：${bizMessage || '未知错误'}${summary ? ' | 参数 ' + summary : ''}`;
      }

      // 内部服务调用没有登录人，明确标出来，避免让人误以为是某个人干的
      if (isInternal && !account) {
        queue.push({
          at,
          account: '',
          lookupKey: '',
          userId: 'system',
          userName: '系统自动',
          roleRaw: '服务账号',
          moduleName,
          actionType,
          targetObj,
          beforeValue,
          afterValue,
          ip: clientIp(req),
          result: success ? '成功' : '失败',
          apiPath: path,
          httpMethod: method,
          statusCode: res.statusCode,
          durationMs: Date.now() - startAt,
          device: describeDevice(String(req.headers['user-agent'] || '')),
        });
        return;
      }

      queue.push({
        at,
        account,
        lookupKey,
        userId,
        userName,
        roleRaw,
        moduleName,
        actionType,
        targetObj,
        beforeValue,
        afterValue,
        ip: clientIp(req),
        result: success ? '成功' : '失败',
        apiPath: path,
        httpMethod: method,
        statusCode: res.statusCode,
        durationMs: Date.now() - startAt,
        device: describeDevice(String(req.headers['user-agent'] || '')),
      });

      if (queue.length >= BATCH_SIZE) void flush();
      else scheduleFlush();
    } catch (e) {
      // 审计自身绝不能把业务请求搞挂
      console.error('[auditLog] 收集日志失败：', (e as Error).message);
    }
  });

  next();
}

/** 进程退出前把队列刷完（tsx watch 重启时也能落库） */
let exiting = false;
async function flushOnExit(): Promise<void> {
  if (exiting) return;
  exiting = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
}
process.on('beforeExit', () => void flushOnExit());
process.on('SIGINT', () => void flushOnExit());
process.on('SIGTERM', () => void flushOnExit());
