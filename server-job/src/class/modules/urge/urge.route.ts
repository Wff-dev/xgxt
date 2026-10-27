import { Router } from 'express';
import { z } from 'zod';
import { Knex } from 'knex';
import { FeeType, PayStatus, PermAction, SourceSystem, SyncMode, SyncResult } from 'shared-types/class';
import { commonDb, db } from '../../db';
import { Errors, ok, pageData } from '../../http/response';
import { pageQuerySchema, q, validate } from '../../lib/validate';
import { baseInsert, notDeleted, paginate } from '../../lib/repo';
import { requirePerm } from '../../lib/permGuard';
import { rowsToCamel } from '../../lib/case';
import { now, today } from '../../lib/ids';
import { FeeTypeName, PayStatusName } from '../../lib/dict';
// ★ 2026-10-26 催费名单数据源改为「财务账单到期日」
import { listUrgeByExpire, getUrgeAheadDays } from '../../../finance/services/urge.service';
// ★ 2026-10-26 其余字段以学生档案为准
import { lookupStudentArchive } from '../../../teaching/shared/studentArchive';
import { applySyncScope } from '../shared/syncScope';
import { resolveSyncStudentId } from '../shared/studentRef';
import { wrap } from '../../middleware/error';
import { tbl, tblTrx, tblInsTrx, uniUpdCols } from '../../../teaching/shared/uniTable';
import { boolFlag } from '../../../utils/query';
import { checkPayDate, saveVoucherImage, PAY_METHOD, PAY_METHOD_NAME } from '../../../utils/feeVoucher';
import { actorId, actorIds, isActor } from '../../../utils/actor';
// ★ 2026-10-23 登记缴费反写财务（待缴 → 已缴），与财务 attachVoucher 同口径
import { pushVoucherToFinance } from '../../../finance/utils/voucher-push';

/**
 * ★ 第 10 批：催费域切读
 *
 * 【为什么 SRC 是 sms_common 而不是 sms_class】
 *   `t_class_urge_sync`（催费副本）和 `t_class_urge_log`（催费流水）
 *   本来就住在共享库 sms_common —— 它们是「教务推给我们」的只读副本，
 *   不是三学段各自的业务表。
 *   `t_class_urge_log` 例外：它住在 sms_class（我们自己产生的流水）。
 *
 * 【⚠️ 关于 edu_stage 隔离的一个行为变化，必须知情】
 *   老表模式下 `t_class_urge_sync` 是**一张表装着三个学段的行**，
 *   `/urge/list` 不加学段过滤 → 能查到全部。
 *   切读后 `tbl()` 注入 `edu_stage='class'` → 只看大学学段。
 *   这与前9 个域的行为变化完全一致（切读 = 按学段隔离），
 *   且实测「一张共享表混三个学段、谁都能看到全部」本身就是数据越权。
 */
const SRC_COMMON = 'sms_common';
const SRC_CLASS = 'sms_class';
const STAGE = 'class' as const;

const SYNC_T = 't_class_urge_sync';
const LOG_T = 't_class_urge_log';

const SYNC = () => tbl(commonDb, SRC_COMMON, SYNC_T, STAGE);
const LOG = () => tbl(db, SRC_CLASS, LOG_T, STAGE);

/**
 * 催费管理（需求二：同步教务管理的催费信息）
 *
 * 边界：
 *  - 催费记录本身**由教务管理推过来**，本模块只保存只读副本（sms_common.t_class_urge_sync）
 *  - 本模块可以执行「催收动作」，动作记录写在自己的业务库（t_class_urge_log），不回写上游
 */
export const urgeRouter = Router();

const urgeItemSchema = z.object({
  sourceId: z.string().min(1, '上游主键不能为空'),
  /**
   * 学生 ID —— ★ 2026-10-05 由【必填】改为【可选】
   *
   * ⚠️ 原因：上游（教务 sms_edu）只有**学号**，拿不到本模块的学生 ID。
   *    没传时由收方按学号回查本模块 t_class_student —— 见 shared/studentRef.ts。
   */
  studentId: z.string().optional().nullable(),
  studentNo: z.string().min(1, '学号不能为空'),
  studentName: z.string().min(1, '姓名不能为空'),
  classId: z.string().optional().nullable(),
  className: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  parentPhone: z.string().optional().nullable(),
  headTeacherId: z.string().optional().nullable(),
  headTeacherName: z.string().optional().nullable(),
  feeType: z.coerce.number().int('欠费类型不能为空'),
  amount: z.coerce.number().int('欠费金额（分）不能为空'),
  expireDate: z.string().min(1, '到期日期不能为空'),
  payStatus: z.coerce.number().int().default(PayStatus.UNPAID),
  urgeCount: z.coerce.number().int().optional().nullable(),
  lastUrgeTime: z.string().optional().nullable(),
});

const urgeSyncSchema = z.object({
  sourceSystem: z.string().default(SourceSystem.EDU),
  syncMode: z.string().default(SyncMode.INCREMENT),
  batchNo: z.string().min(1, '批次号不能为空'),
  sourceUpdateTime: z.string().optional().nullable(),
  items: z.array(urgeItemSchema).max(500, '单批最多 500 条'),
});

/**
 * @openapi
 * /api/class/urge/sync:
 *   post:
 *     tags: [催费管理]
 *     summary: 2.1 催费信息同步（教务管理 → 学管）
 *     description: 幂等键 `(sourceSystem + sourceId)`：重复推送只更新、不新增。写入共享库只读副本。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [batchNo, items]
 *             properties:
 *               batchNo: { type: string }
 *               items: { type: array, items: { type: object } }
 *     responses:
 *       200: { description: 同步结果 }
 */
urgeRouter.post(
  '/sync',
  validate({ body: urgeSyncSchema }),
  wrap(async (req, res) => {
    const body = req.body as z.infer<typeof urgeSyncSchema>;
    const sourceSystem = String(body.sourceSystem || SourceSystem.EDU);
    const result: SyncResult = {
      accepted: body.items.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      batchNo: body.batchNo,
      finishTime: '',
    };

    await commonDb.transaction(async (trx) => {
      for (const item of body.items) {
        try {
          const existed = (await tblTrx(trx, SRC_COMMON, SYNC_T, STAGE)
            .where({ source_system: sourceSystem, source_id: item.sourceId })
            .first()) as Record<string, unknown> | undefined;

          // ★ 2026-10-05：上游只带学号时，在这里回查本模块的学生 ID
          const studentId = await resolveSyncStudentId(item);

          const fields: Record<string, unknown> = {
            student_id: studentId,
            student_no: item.studentNo,
            student_name: item.studentName,
            class_id: item.classId ?? null,
            class_name: item.className ?? null,
            phone: item.phone ?? null,
            parent_phone: item.parentPhone ?? null,
            head_teacher_id: item.headTeacherId ?? null,
            head_teacher_name: item.headTeacherName ?? null,
            fee_type: item.feeType,
            amount: item.amount,
            expire_date: item.expireDate,
            pay_status: item.payStatus,
            urge_count: item.urgeCount ?? 0,
            last_urge_time: item.lastUrgeTime ?? null,
            source_system: sourceSystem,
            source_id: item.sourceId,
            source_batch_no: body.batchNo,
            source_update_time: body.sourceUpdateTime ?? now(),
            sync_status: 2,
          };

          if (existed) {
            // ★ 铁律⑨：update 路径必须过 uniUpdCols（insert 有翻译、update 没有）
            const patch = await uniUpdCols(commonDb, SRC_COMMON, SYNC_T, {
              ...fields,
              update_time: now(),
            });
            await tblTrx(trx, SRC_COMMON, SYNC_T, STAGE)
              .where({ id: existed.id as string })
              .update(patch as never);
            result.updated += 1;
          } else {
            await tblInsTrx(trx, SRC_COMMON, SYNC_T, STAGE, {
              ...baseInsert(undefined, undefined),
              ...fields,
            });
            result.inserted += 1;
          }
        } catch (e) {
          result.failed += 1;
          result.errors.push({
            sourceId: item.sourceId,
            studentNo: item.studentNo,
            reason: `写入失败：${(e as Error).message}`,
          });
        }
      }

      if (String(body.syncMode) === SyncMode.FULL) {
        const incoming = body.items.map((i) => i.sourceId);
        const upd = tblTrx(trx, SRC_COMMON, SYNC_T, STAGE)
          .where({ source_system: sourceSystem, is_deleted: 0 })
          .update(
            (await uniUpdCols(commonDb, SRC_COMMON, SYNC_T, { is_deleted: 1, update_time: now() })) as never,
          );
        if (incoming.length) upd.whereNotIn('source_id', incoming);
        await upd;
      }
    });

    result.finishTime = now();
    return ok(res, result, `催费同步完成：新增 ${result.inserted} 条，更新 ${result.updated} 条`);
  }),
);

/* ------------------------------ 列表 ------------------------------ */

const urgeListSchema = z.object({
  ...pageQuerySchema.shape,
  classId: z.string().optional(),
  feeType: z.coerce.number().int().optional(),
  payStatus: z.coerce.number().int().optional(),
  // ★ 2026-10-20：显式布尔解析（z.coerce.boolean 会把 "false" 当 true，
  //   前端把「仅看紧急」关掉后仍然只出逾期的）
  onlyOverdue: boolFlag.optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  keyword: z.string().optional(),
});

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * @openapi
 * /api/class/urge/list:
 *   get:
 *     tags: [催费管理]
 *     summary: 2.2 催费列表（欠费明细）
 *     description: |
 *       逾期天数由后端按当前日期计算后返回（`overdueDays`）。
 *       金额以「分」存储，同时返回「元」字段便于直接展示。
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: onlyOverdue, schema: { type: boolean }, description: 只看已逾期 }
 *     responses:
 *       200: { description: 分页列表 }
 */
urgeRouter.get(
  '/list',
  validate({ query: urgeListSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof urgeListSchema>>(req);
    const t = today();

    /**
     * ★ 2026-10-26 用户口径：大学部催费名单也改为**以财务账单到期日为准**
     *   （与初高同一套：只催餐费/住宿费/保险费，提前 N 天，N 在财务费用标准页配置）
     */
    const aheadDays = await getUrgeAheadDays();
    // ★ 2026-10-26 必须按部门过滤，否则三个部门页签会看到同一批人
    const fin = await listUrgeByExpire(aheadDays, {
      keyword: query.keyword,
      feeType: query.feeType,
      deptCode: 2, // 大学部
    });

    // 匹配本地催缴副本行（执行催收 / 登记缴费要拿行 id）
    /**
     * ★ 2026-10-26 双键匹配：财务账单的 studentId（`FSB-U26005`）与本地催缴副本的
     *   student_id（`seed-ustu-05` / 学号）不是一套 id，只按 studentId 查 →
     *   一条都匹配不上 → 行 id 退化成合成 id（`fin-xxx`）→ 点「上传缴费凭证」报「单不存在」。
     */
    const stuIds = [...new Set(fin.rows.map((r) => r.studentId))].filter(Boolean);
    const stuNos = [...new Set(fin.rows.map((r) => r.studentNo))].filter(Boolean);
    const syncMap = new Map<string, any>();
    if (stuIds.length || stuNos.length) {
      const rows = (await notDeleted(SYNC())
        .where((b: any) => {
          b.whereIn('student_id', stuIds.length ? stuIds : [''])
            .orWhereIn('student_no', stuNos.length ? stuNos : ['']);
        })
        .select('*')) as any[];
      for (const r of rows) {
        syncMap.set(`${r.student_id}::${r.fee_type}`, r);
        if (r.student_no) syncMap.set(`${r.student_no}::${r.fee_type}`, r);
      }
    }

    let list = fin.rows.map((r) => {
      const local =
        syncMap.get(`${r.studentId}::${r.feeType}`) ??
        (r.studentNo ? syncMap.get(`${r.studentNo}::${r.feeType}`) : undefined);
      const payStatus = r.remainDays < 0 ? PayStatus.OVERDUE : PayStatus.UNPAID;
      const amount = Number(local?.amount ?? r.suggestAmount ?? 0);
      return {
        // 有本地副本就用它的 id（催收/登记能落库），没有就合成一个只读 id
        id: local?.id ?? `fin-${r.studentId}-${r.feeType}`,
        studentId: r.studentId,
        studentNo: r.studentNo,
        studentName: r.studentName,
        classId: r.classId ?? null,
        className: r.className ?? null,
        feeType: r.feeType,
        feeTypeName: FeeTypeName[r.feeType] ?? '未知',
        amount,
        amountYuan: (amount / 100).toFixed(2),
        payStatus,
        payStatusName: PayStatusName[payStatus] ?? '未知',
        expireDate: r.expireDate,
        remainDays: r.remainDays,
        overdueDays: r.remainDays < 0 ? -r.remainDays : 0,
        isOverdue: r.remainDays < 0,
        payMethod: local?.pay_method ?? null,
        payMethodName:
          local?.pay_method != null ? PAY_METHOD_NAME[Number(local.pay_method)] ?? '' : '',
        paidAmount: local?.paid_amount ?? null,
        payDate: local?.pay_date ?? null,
        voucherUrl: local?.voucher_url ?? null,
        urgeCount: Number(local?.urge_count ?? 0),
      };
    });

    /**
     * ★ 2026-10-26 用户口径：催费行里除「费用信息」外的字段，一律以**学生档案**为准
     *   （姓名/学号/班级/部门/手机号/家长手机号/班主任）。
     *   财务账单上的这些是建单快照，学生换班改号后不会更新。
     */
    const arch = await lookupStudentArchive(
      list.map((x: any) => ({ studentId: x.studentId, studentNo: x.studentNo })),
    );
    list = list.map((x: any) => {
      const a = arch[x.studentId] ?? (x.studentNo ? arch[x.studentNo] : undefined);
      if (!a) return x;
      return {
        ...x,
        studentNo: a.studentNo || x.studentNo,
        studentName: a.studentName || x.studentName,
        classId: a.classId ?? x.classId,
        className: a.className ?? x.className,
        deptCode: a.deptCode ?? x.deptCode,
        phone: a.phone,
        parentPhone: a.parentPhone,
        headTeacherName: a.headTeacherName,
      };
    });

    // ---- 与原来同口径的筛选（状态/日期/仅看紧急/班级）----
    if (query.classId) list = list.filter((x) => x.classId === query.classId);
    if (query.payStatus) list = list.filter((x) => x.payStatus === query.payStatus);
    const sd = query.startDate;
    const ed = query.endDate;
    if (sd) list = list.filter((x) => x.expireDate >= sd);
    if (ed) list = list.filter((x) => x.expireDate <= ed);
    if (query.onlyOverdue) list = list.filter((x) => x.remainDays < 0);

    const total = list.length;
    const pageNo = Number(query.page || 1);
    const size = Number(query.size || 20);
    const paged = list.slice((pageNo - 1) * size, pageNo * size);

    return ok(
      res,
      pageData(total, pageNo, size, paged),
      `查询成功（按财务账单到期日，提前 ${aheadDays} 天）`,
    );
  }),
);

/* ------------------------------ 执行催收 ------------------------------ */

const urgeDoSchema = z.object({
  urgeId: z.string().min(1, '缺少催费记录ID'),
  channel: z.enum(['phone', 'sms', 'wechat'], {
    errorMap: () => ({ message: '催收渠道只能是 phone / sms / wechat' }),
  }),
  remark: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/urge/do:
 *   post:
 *     tags: [催费管理]
 *     summary: 2.3 执行一次催收（记本地催费流水）
 *     description: |
 *       催费记录属于教务管理，本模块**不回写上游**，只在自己的库记一条催收动作流水，
 *       并把副本里的催费次数 +1，便于前端立即看到效果。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [urgeId, channel]
 *             properties:
 *               urgeId: { type: string }
 *               channel: { type: string, enum: [phone, sms, wechat] }
 *               remark: { type: string }
 *     responses:
 *       200: { description: 催收记录已保存，返回累计催费次数 }
 */
urgeRouter.post(
  '/do',
  requirePerm('urge', PermAction.ADD),
  validate({ body: urgeDoSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof urgeDoSchema>;

    const rec = (await notDeleted(SYNC()).where('id', b.urgeId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!rec) throw Errors.param('催费记录不存在或已失效');

    const channelName: Record<string, string> = { phone: '电话', sms: '短信', wechat: '微信' };
    const nextCount = Number(rec.urge_count ?? 0) + 1;
    const t = now();

    await db.transaction(async (trx) => {
      await tblInsTrx(trx, SRC_CLASS, LOG_T, STAGE, {
        ...baseInsert(user),
        student_id: rec.student_id as string,
        student_no: rec.student_no as string,
        student_name: rec.student_name as string,
        amount: rec.amount as number,
        channel: b.channel,
        remark: b.remark ?? null,
        operator_id: actorId(user),
        operator_name: user.userName,
        urge_time: t,
      });
    });

    // 副本上的催费次数 +1（只影响本地展示，不回写教务）
    await SYNC().where({ id: b.urgeId }).update(
      (await uniUpdCols(commonDb, SRC_COMMON, SYNC_T, {
        urge_count: nextCount,
        last_urge_time: t,
        update_time: t,
      })) as never,
    );

    return ok(res, { urgeId: b.urgeId, urgeCount: nextCount }, `已记录${channelName[b.channel] ?? ''}催收`);
  }),
);

/**
 * @openapi
 * /api/class/urge/log/list:
 *   get:
 *     tags: [催费管理]
 *     summary: 2.4 催收流水（本模块执行过的催收动作）
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: studentId, schema: { type: string } }
 *     responses:
 *       200: { description: 分页列表 }
 */
urgeRouter.get(
  '/log/list',
  validate({
    query: z.object({ ...pageQuerySchema.shape, studentId: z.string().optional() }),
  }),
  wrap(async (req, res) => {
    const query = q<{ page: number; size: number; studentId?: string }>(req);
    const base = LOG();
    notDeleted(base);
    if (query.studentId) base.where('student_id', query.studentId);
    base.orderBy('urge_time', 'desc');

    const paged = await paginate(base, query, async (qb) =>
      rowsToCamel(await qb as Array<Record<string, unknown>>),
    );
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/* ------------------------------ 登记缴费（对齐初高） ------------------------------ */

/**
 * ★ 2026-10-21 用户要求：催费页里**大学**要与初高功能对齐。
 *
 * 【为什么要这个接口】
 *   初高的行早就能「上传缴费凭证（登记缴费）」，大学催缴副本原来只有 pay_status，
 *   钱怎么交的、交了多少、哪天交的、有没有凭证一概没有 → 页面上操作列只能显示「—」。
 *
 * 【写哪里】
 *   主写本模块自己的副本 `sms_common.t_class_urge_sync`（pay_method / paid_amount /
 *   pay_date / voucher_url / pay_remark + pay_status）。
 *   ★ 2026-10-23 起**另做一步有限的财务反写**：这张副本如果是财务推来的
 *   （`source_system='finance'` + `source_id`），把凭证/日期/备注 + 状态「待缴(1) → 已缴(2)」
 *   推回那**一张**财务单 —— 否则财务侧仍是待缴，点「核对」会被拦「尚未缴费，无法核对」，
 *   催费就永远停在「已缴」到不了「已核对」。
 *   边界：只推收款事实 + 1→2，**绝不**替财务写 3 已核对，也不碰其它财务单。
 *
 * 【状态怎么变】
 *   未结清（待缴 1 / 逾期 4）→ 已缴 2；已缴 / 已核对保持原状，只补登记信息。
 */
const urgeVoucherSchema = z.object({
  urgeId: z.string().min(1, '缺少催缴记录ID'),
  /** 缴费方式 1微信支付 2支付宝 3现金 */
  payMethod: z.coerce.number().int().min(1).max(3, '缴费方式只能是 微信支付 / 支付宝 / 现金'),
  /** 实缴金额（分）；允许与应缴不同（部分缴），必须为正 */
  paidAmount: z.coerce.number().int().positive('缴费金额必须大于 0'),
  payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '缴费时间格式应为 YYYY-MM-DD'),
  remark: z.string().max(200, '备注最多 200 字').optional(),
  /** 缴费截图；现金可不传（见 saveVoucherImage 的调用处） */
  dataUrl: z.string().optional(),
});

urgeRouter.post(
  '/voucher',
  requirePerm('urge', PermAction.ADD),
  validate({ body: urgeVoucherSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof urgeVoucherSchema>;

    const dateErr = checkPayDate(b.payDate);
    if (dateErr) throw Errors.param(dateErr);

    const rec = (await notDeleted(SYNC()).where('id', b.urgeId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!rec) throw Errors.param('催费记录不存在或已失效');

    /* ---- 截图：现金不强制，微信/支付宝必须有 ---- */
    let voucherUrl: string | null = null;
    if (b.dataUrl) {
      const saved = saveVoucherImage(b.dataUrl, 'urge');
      if (!saved.ok) throw Errors.param(saved.message);
      voucherUrl = saved.voucherUrl;
    } else if (b.payMethod !== PAY_METHOD.CASH) {
      throw Errors.param('请上传缴费截图（微信支付 / 支付宝需要凭证，现金可不传）');
    }

    const rawStatus = Number(rec.pay_status ?? PayStatus.UNPAID);
    // ★ 2026-10-25：核对失败(6) 重新登记 = 重传凭证 → 回到已缴，等财务再核一遍
    const nextStatus =
      rawStatus === PayStatus.UNPAID ||
      rawStatus === PayStatus.OVERDUE ||
      rawStatus === PayStatus.REJECTED
        ? PayStatus.PAID
        : rawStatus;

    const patch: Record<string, unknown> = {
      pay_method: b.payMethod,
      paid_amount: b.paidAmount,
      pay_date: b.payDate,
      pay_remark: b.remark ?? null,
      pay_status: nextStatus,
      update_time: now(),
    };
    // 现金且没传截图：保留原来的凭证，不要把它清空
    if (voucherUrl) patch.voucher_url = voucherUrl;
    /**
     * ★ 2026-10-25：重新登记 → 清掉「已上传财务时间」，让它重新回到
     *   「批量上传到财务」候选（详见 class-jh/routes/fee.route.ts 同款注释）。
     *   ⚠️ 只清时间，不清 `finance_fee_id`（那是财务那张单的唯一凭据，
     *      清掉会再建一张新单 → 财务重复记账）。
     */
    if (rec.finance_fee_id) patch.finance_transfer_time = null;

    await SYNC()
      .where({ id: b.urgeId })
      .update((await uniUpdCols(commonDb, SRC_COMMON, SYNC_T, patch)) as never);

    /**
     * ★ 2026-10-23：反写财务缴费单（best-effort，失败不阻断登记）
     *
     * 这行如果是财务推下来的（`source_system='finance'` + `source_id`），
     * 财务那张单初始可能还是「待缴(1)」→ 财务点「核对」会被拦「尚未缴费」。
     * 所以把凭证/日期/备注 + 状态（仅 1 → 2）推到财务，与财务 `attachVoucher()` 同口径。
     * 「只读副本」的边界仍然守：**只推这一张单的收款事实，不改财务的任何其它状态（3 已核对必须财务自己写）**。
     */
    const srcRow = rec as Record<string, any>;
    /**
     * ★ 2026-10-25 修：财务单定位改以 `finance_fee_id` 为准（老口径兜底）。
     *
     *   10-23 的 ID 统一之后，新单据只写 `finance_fee_id`，`source_id` 恒为空；
     *   而这里原来判的是 `source_system === 'finance' && source_id`、
     *   并且用 `source_id` 当财务单号 → **条件永远不成立、同步从未执行**，
     *   表现就是「登记缴费后催费变已缴、财务单还是待缴，财务点不动核对」。
     *   与文件里判重/口径统一（finance_fee_id 为准）保持一致。
     */
    const financeFeeId =
      String(srcRow.finance_fee_id ?? '').trim() ||
      (srcRow.source_system === 'finance' && srcRow.source_id ? String(srcRow.source_id) : '');
    if (financeFeeId) {
      await pushVoucherToFinance({
        financeFeeId,
        voucherUrl: voucherUrl ?? null,
        payDate: b.payDate,
        remark: b.remark ?? null,
        operatorId: user.userId,
      });
    }

    return ok(
      res,
      {
        urgeId: b.urgeId,
        voucherUrl: voucherUrl ?? (rec.voucher_url ?? null),
        payStatus: nextStatus,
        payMethodName: PAY_METHOD_NAME[b.payMethod] ?? '',
      },
      '缴费登记成功',
    );
  }),
);
