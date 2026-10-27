/**
 * 操作日志路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/log
 *
 *  GET /list             日志列表（分页）
 *  GET /detail?id=xxx    日志详情
 *  GET /overview         日志 KPI（5 个，均可点击筛选）
 *  GET /export           导出日志（不分页）
 *
 * ⚠️ 日志只读：本模块不提供 add / update / delete 接口。
 *    写入由后端在关键动作处自动完成（见 services/perm.service.ts 的 addLog()）。
 *    这是刻意的 —— 日志一旦能被前端写，就不再是证据。
 */

import { Router } from 'express';
import { z } from 'zod';
import { BizCode, LogResult } from 'shared-types/perm';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
import { resolveLogRoleLabels } from '../services/perm.service';
import { sanitizeTargetObj } from '../utils/logTarget';

export const logRouter = Router();

const TABLE = 't_perm_log';

/**
 * 行 → 接口对象
 * @param roleLabel 已解析好的中文职位名（见 resolveLogRoleLabels）
 *
 * ★ 2026-10-20：`所属职位` 以前直接吐 `operator_role` 原值，
 *   于是列表里出现 `SYS_STAFF` 这种英文编码（门户 token 只有粗粒度身份，
 *   写日志时既没映射到业务职位、也没有备选来源）。现在统一走解析层：
 *   编码→中文名，空值/门户级编码→按操作人现查真实职位。
 */
function toLogItem(r: any, roleLabel?: string) {
  return {
    id: r.id,
    logTime: r.log_time,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    operatorRole: roleLabel ?? r.operator_role,
    moduleName: r.module_name,
    actionType: r.action_type,
    /* ★ 2026-10-26：历史数据里残留的 `资源 #<UUID>` 在这里统一洗掉，
     *   列表 / 详情 / 导出都不要再把机器 ID 吐到界面上（口径见 utils/logTarget.ts） */
    targetObj: sanitizeTargetObj(r.target_obj),
    beforeValue: r.before_value,
    afterValue: r.after_value,
    ip: r.ip,
    result: r.result,
    /* ★ 2026-10-22 全系统留痕新增：接口 / 方法 / 状态 / 耗时 / 设备
     *   权限板块内部的老日志这几列是 NULL，前端按空值降级显示 */
    apiPath: r.api_path || '',
    httpMethod: r.http_method || '',
    statusCode: r.status_code ?? null,
    durationMs: r.duration_ms ?? null,
    userAgent: r.user_agent || '',
    createTime: r.create_time,
    createBy: r.create_by,
    isDeleted: !!r.is_deleted,
  };
}

/** 批量转接口对象（职位名一次解析，避免每行查两次库） */
async function toLogItems(rows: any[]) {
  const labels = await resolveLogRoleLabels(rows);
  return rows.map((r, i) => toLogItem(r, labels[i]));
}

/** 组装筛选条件（列表 / 导出 / KPI 复用，保证口径一致） */
function applyFilters(q: any) {
  const query = db(TABLE).where('is_deleted', false);

  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('operator_name', 'like', `%${q.keyword}%`)
        .orWhere('target_obj', 'like', `%${q.keyword}%`)
        .orWhere('operator_role', 'like', `%${q.keyword}%`);
      // ★ 2026-10-26：按用户要求，界面上不再展示「IP 地址」与「访问接口」，
      //   所以关键词搜索也同步去掉 ip / api_path 两个匹配维度 ——
      //   否则用户按 IP 搜到结果，明细里却看不到 IP，只会徒增困惑。
    });
  }
  if (q.moduleName) query.andWhere('module_name', q.moduleName);
  if (q.actionType) query.andWhere('action_type', q.actionType);
  if (q.result) query.andWhere('result', q.result);
  if (q.operatorName) query.andWhere('operator_name', 'like', `%${q.operatorName}%`);
  if (q.startDate) query.andWhere('log_time', '>=', `${q.startDate} 00:00:00`);
  if (q.endDate) query.andWhere('log_time', '<=', `${q.endDate} 23:59:59`);

  return query;
}

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().optional(),
  moduleName: z.string().optional(),
  actionType: z.string().optional(),
  result: z.string().optional(),
  operatorName: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

/* ============================================================
 * 1. 日志列表
 *    GET /api/perm/log/list?page=1&size=20&actionType=登录&result=失败
 * ============================================================ */

logRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = applyFilters(q);
    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy('log_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(await toLogItems(rows), Number(total), q));
  }),
);

/* ============================================================
 * 2. 日志详情
 *    GET /api/perm/log/detail?id=LG0001
 * ============================================================ */

logRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.LOG_NOT_FOUND, '日志不存在');
    const [roleLabel] = await resolveLogRoleLabels([row]);
    res.json(ok(toLogItem(row, roleLabel)));
  }),
);

/* ============================================================
 * 3. 日志 KPI（5 个）
 *    GET /api/perm/log/overview
 * ============================================================ */

logRouter.get(
  '/overview',
  wrap(async (_req, res) => {
    const [all, success, fail, login, approve] = await Promise.all([
      db(TABLE).where('is_deleted', false).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, result: LogResult.SUCCESS }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, result: LogResult.FAIL }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, action_type: '登录' }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, action_type: '审批' }).count({ n: '*' }),
    ]);

    res.json(
      ok({
        logTotal: Number(all[0]?.n || 0),
        successTotal: Number(success[0]?.n || 0),
        failTotal: Number(fail[0]?.n || 0),
        loginTotal: Number(login[0]?.n || 0),
        approveTotal: Number(approve[0]?.n || 0),
      }),
    );
  }),
);

/* ============================================================
 * 3.5 操作人字典（全系统留痕后必须补）
 *    GET /api/perm/log/operators
 *
 * 【为什么需要】
 *   以前日志只有权限板块自己产生，一页 10 条里操作人基本就那么几个，
 *   前端用「当前页去重」凑下拉就够了。
 *   现在全系统每个账号的写操作都进来，一页 10 条可能 10 个不同的人，
 *   下拉里选不到「上周那个财务」，筛选就形同虚设。
 *   这里按操作次数倒序给出全部操作人，一次查询、前端缓存。
 * ============================================================ */

logRouter.get(
  '/operators',
  wrap(async (_req, res) => {
    const rows = (await db(TABLE)
      .where('is_deleted', false)
      .select('operator_name')
      .count({ n: '*' })
      .groupBy('operator_name')
      .orderBy('n', 'desc')
      .limit(300)) as { operator_name: string; n: number | string }[];

    res.json(
      ok(
        rows
          .filter((r) => r.operator_name)
          .map((r) => ({ name: r.operator_name, count: Number(r.n) })),
      ),
    );
  }),
);

/* ============================================================
 * 4. 导出日志（不分页）
 *    GET /api/perm/log/export?actionType=审批
 * ============================================================ */

logRouter.get(
  '/export',
  validate(listSchema.omit({ page: true, size: true })),
  wrap(async (req, res) => {
    const q = (req as any).validated as Record<string, string | undefined>;
    const rows = await applyFilters(q).select('*').orderBy('log_time', 'desc').limit(10000);
    const list = await toLogItems(rows);
    res.json(ok({ total: list.length, list }));
  }),
);

export default logRouter;
