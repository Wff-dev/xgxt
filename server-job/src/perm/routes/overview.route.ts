/**
 * 权限总览路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/overview
 *
 *  GET /get   首屏 KPI + 最近操作动态
 *
 * ⚠️ 口径说明（几个容易被问到的数字）：
 *    · deptTotal = 6 —— 校级直属的一级部门（市场咨询部 / 教学部 / 就业部 / 教务部 /
 *      财务管理部 / 行政），不含校级本身，也不含下设子部门；
 *    · stageTotal = 5 —— 下设子部门：教学部的 初中部 / 高中部 / 大学部，
 *      就业部的 实训管理 / 就业管理。
 *      ★ 2026-10-20 起按 dept_level 统计（原来硬编码 3 个学段 id，就业部并进来后就漏了）。
 *    · permPointTotal = 185 —— 2026-10-02「实训-教学」补到 10 个功能点后，由 157 更新；
 *      「教质/学术审批」是父功能点，下挂 休学/退学审批 + 退费审批 两个二级功能点，
 *      各 3 个动作（查看/同意/驳回），父项自身不挂动作，故合计不重复。
 *    · moduleTotal = 8 / itemTotal = 53（只算顶级功能点，二级功能点并入父项）。
 */

import { Router } from 'express';
import { ok } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { RoleStatus, UserStatus } from 'shared-types/perm';
import { countDeptTotal, countStageTotal, getTreeStats, resolveLogRoleLabels } from '../services/perm.service';
import { sanitizeTargetObj } from '../utils/logTarget';

export const overviewRouter = Router();

/* ============================================================
 * ★ 2026-10-26：「最近操作动态」改为「按天取样」，不再取全表最新 6 条
 *
 * 【为什么改】
 *   原来的写法是 `ORDER BY log_time DESC LIMIT 6`。这条 SQL 本身没有
 *   「只查当天」的条件，但日志量上来之后（单日 300+ 条），最新 6 条必然
 *   全部落在同一天的某个几分钟里 —— 界面上看起来就变成了「只显示当天的」，
 *   而操作日志页（/api/perm/log/list）能看到 1900+ 条历史，两边观感割裂。
 *
 *   实测（2026-10-26）：全表 1967 条，最近 6 条集中在同一天 14:06~14:13，
 *   而最近 4 个「有记录的日子」分别是 364 / 248 / 284 / 686 条 ——
 *   历史数据一直都在，只是被 LIMIT 6 挡在视野外。
 *
 * 【现在的口径】
 *   最近一个有日志的日子取 6 条（保证「最新几笔」完整），
 *   再往前每个有日志的日子各取 2 条，最多覆盖 4 天共 12 条。
 *   → 总览既能看当下，也能一眼看到前几天的操作痕迹。
 * ============================================================ */

/** 覆盖最近几个「有日志的日子」 */
const RECENT_DAY_COUNT = 4;
/** 最近一天取几条（保留原来「最新 6 笔」的语义） */
const RECENT_TODAY_LIMIT = 6;
/** 更早的日子每天取几条 */
const RECENT_OTHER_LIMIT = 2;

/**
 * 取「最近操作动态」：按天取样 + 全表总数
 *
 * ⚠️ 这里用 ROW_NUMBER() 在库里直接算出「每天第几笔」，
 *    不做「先全查回来再在内存里分组」—— 后者的传输量随日志增长线性膨胀。
 *    MySQL 8.0+ 才支持窗口函数（本项目基线就是 8.x，见 README）。
 */
async function fetchRecentLogs(): Promise<{ rows: any[]; total: number }> {
  const dayExpr = "DATE_FORMAT(log_time, '%Y-%m-%d')";

  const [dayRows, totalRows] = await Promise.all([
    db('t_perm_log')
      .where('is_deleted', false)
      .select(db.raw(`${dayExpr} AS d`))
      .count({ n: '*' })
      .groupByRaw(dayExpr)
      .orderBy('d', 'desc')
      .limit(RECENT_DAY_COUNT),
    db('t_perm_log').where('is_deleted', false).count({ n: '*' }),
  ]);

  const total = Number((totalRows as any)[0]?.n ?? 0);
  const days = (dayRows as any[]).map((r) => String(r.d));
  if (!days.length) return { rows: [], total };

  // 各按天取前 N 条：最近一天 6 条，其余每天 2 条（rn 由窗口函数给出）
  const marks = days.map(() => '?').join(', ');
  const [rows] = await db.raw(
    `SELECT * FROM (
       SELECT l.*,
              ROW_NUMBER() OVER (
                PARTITION BY DATE(l.log_time)
                ORDER BY l.log_time DESC, l.id DESC
              ) AS rn
         FROM t_perm_log l
        WHERE l.is_deleted = 0
          AND DATE_FORMAT(l.log_time, '%Y-%m-%d') IN (${marks})
     ) t
     WHERE t.rn <= IF(DATE_FORMAT(t.log_time, '%Y-%m-%d') = ?, ?, ?)
     ORDER BY t.log_time DESC, t.id DESC`,
    [...days, days[0], RECENT_TODAY_LIMIT, RECENT_OTHER_LIMIT],
  );

  return { rows: rows as any[], total };
}

overviewRouter.get(
  '/get',
  wrap(async (_req, res) => {
    const [
      roleTotal,
      roleEnabled,
      userTotal,
      userNormal,
      deptTotal,
      stageTotal,
      stats,
      recent,
    ] = await Promise.all([
      db('t_perm_role').where('is_deleted', false).count({ n: '*' }),
      db('t_perm_role').where({ is_deleted: false, role_status: RoleStatus.ENABLED }).count({ n: '*' }),
      db('t_perm_user').where('is_deleted', false).count({ n: '*' }),
      db('t_perm_user').where({ is_deleted: false, user_status: UserStatus.NORMAL }).count({ n: '*' }),
      countDeptTotal(),
      countStageTotal(),
      getTreeStats(),
      fetchRecentLogs(),
    ]);

    const recentLogs = recent.rows;

    // ★ 2026-10-20：最近日志的「所属职位」同样要中文（口径见 services/perm.service.ts
    //   resolveLogRoleLabels 的注释：token 里只有 SYS_ADMIN/SYS_STAFF，得按操作人现查）
    const recentRoleLabels = await resolveLogRoleLabels(recentLogs as any[]);

    res.json(
      ok({
        roleTotal: Number(roleTotal[0]?.n || 0),
        roleEnabled: Number(roleEnabled[0]?.n || 0),
        userTotal: Number(userTotal[0]?.n || 0),
        userNormal: Number(userNormal[0]?.n || 0),
        permPointTotal: stats.actionCount,
        moduleTotal: stats.modCount,
        itemTotal: stats.itemCount,
        deptTotal,
        stageTotal,
        /**
         * ★ 2026-10-26：全表日志总条数
         *
         * ⚠️ 前端「权限总览」已改用 `/api/perm/log/list` 渲染**完整日志列表**
         *   （与操作日志页共用 components/LogTable.vue），不再读这里的
         *   logTotal / recentLogs。两个字段保留是为了接口兼容与既有回归脚本
         *   （scripts/_test-log-role-name.mjs 会校验最近日志的职位名解析）。
         */
        logTotal: recent.total,
        recentLogs: recentLogs.map((r: any, i: number) => ({
          id: r.id,
          logTime: r.log_time,
          operatorName: r.operator_name,
          operatorRole: recentRoleLabels[i] ?? r.operator_role,
          moduleName: r.module_name,
          actionType: r.action_type,
          targetObj: sanitizeTargetObj(r.target_obj),
          beforeValue: r.before_value,
          afterValue: r.after_value,
          ip: r.ip,
          result: r.result,
        })),
      }),
    );
  }),
);

export default overviewRouter;
