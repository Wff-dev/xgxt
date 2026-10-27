/**
 * 催费管理 路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/fee-call
 * 表：t_job_fee_call
 * 字段依据：斌哥 2026-09-30 拍板
 *
 * ============================================================
 * 【业务规则（斌哥 2026-09-30 拍板）】
 * ============================================================
 *   1. 发起人 = 教务老师（ROLE_EDU_ADMIN）
 *   2. 类别   = 住宿费 / 保险费 / 餐费（★ 没有学费）
 *   3. 发起后【发站内信】推给该学生的班主任
 *   4. 班主任【只看自己的班】
 *   5. 班主任催完 → 标记「已催缴」→ 学生交了就标「已缴清」
 *
 * ============================================================
 * 【⚠️ 这个模块不收款】
 * ============================================================
 *   它只是"催办工单"——教务发起、班主任去催、标记结果。
 *   真正的收费/账目在财务模块（8005），本模块不碰钱。
 *
 * ⚠️ 铁律：逻辑删除，禁物理删除。
 * ⚠️ 铁律：金额一律存「分」（整数）。
 * ⚠️ 铁律：枚举双返回（feeType + feeTypeName）。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  FeeCallCategory,
  FEE_CALL_CATEGORY_NAME,
  FeeCallStatus,
  FEE_CALL_STATUS_NAME,
  DEPT_NAME,
  FEE_TYPE_NAME,
  PAY_STATUS_NAME,
  PayStatus,
  RoleCode,
  StudentStatus,
  ClassStatus,
  hasRole,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { today, fmtDate, fmtDateTime } from '../utils/date';
import { validate } from '../middleware/validate';
import { boolFlag } from '../utils/query';
import { BizError } from '../middleware/errorHandler';
import { sendNotice, NOTICE_TYPE } from '../utils/notice';
// ★ 阶段隔离（班主任只看大学 / 项目经理只看实训）
import { applyTrainingScope, myTrainingClassIds, operatorOf } from '../utils/stageScope';
// ★ 信息流转：催费单新增/处理 → 推送班级管理模块（只读副本）
import { syncFeeCallToClass } from '../services/urge-sync.service';
// ★ P3 切读层：本文件三张表（t_job_fee_call / t_student_base / t_job_class）都已归一，
//   全部走 tbl()/tblInsTrx() 路由（student-options 的别名 join 走 tblAs()/tblRef()）；
//   开关关时与原实现等价。
import { tbl, tblAs, tblInsTrx, tblRef } from '../teaching/shared/uniTable';
import { checkPayDate, saveVoucherImage, PAY_METHOD, PAY_METHOD_NAME } from '../utils/feeVoucher';
// ★ 2026-10-23 登记缴费反写财务（待缴 → 已缴），与财务 attachVoucher 同口径
import { pushVoucherToFinance } from '../finance/utils/voucher-push';
// ★ 2026-10-26 催费名单数据源改为「财务账单到期日」
import { listUrgeByExpire, getUrgeAheadDays } from '../finance/services/urge.service';
// ★ 2026-10-26 其余字段以学生档案为准
import { lookupStudentArchive } from '../teaching/shared/studentArchive';

export const feeCallRouter = Router();

/** 表名常量 */
const TABLE = 't_job_fee_call';
const STUDENT_TABLE = 't_student_base';
const CLASS_TABLE = 't_job_class';

/** ★ 统一表 edu_stage 取值（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 可发起催费的学生状态（在校生都行）*/
const ALLOW_STATUS: number[] = [
  StudentStatus.TRIAL,
  StudentStatus.PRE_STUDY,
  StudentStatus.STUDYING,
  StudentStatus.TRAINING,
];

/** 合法费用类别（只有这三类）*/
const VALID_FEE_TYPES: number[] = [
  FeeCallCategory.ACCOMMODATION, // 住宿费 2
  FeeCallCategory.INSURANCE,     // 保险费 4
  FeeCallCategory.MEAL,          // 餐费 3
];

/* ============================================================
 * 内部工具
 * ============================================================ */

function getOperator(req: any) {
  const u = req.user || {};
  return {
    userId: u.userId || u.id || '',
    userName: u.userName || u.name || '',
    roles: u.roles || [],
  };
}

/** 分 → 元字符串（如 120000 → "1,200.00"）*/
function fenToYuanText(fen: number | null | undefined): string | null {
  if (fen === null || fen === undefined) return null;
  const yuan = (Number(fen) / 100).toFixed(2);
  const [int, dec] = yuan.split('.');
  const withComma = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${withComma}.${dec}`;
}

/** 是否已逾期 */
function isOverdue(dueDate: any, callStatus: number): boolean {
  if (!dueDate) return false;
  // 已缴清不算逾期
  if (callStatus === FeeCallStatus.PAID) return false;
  const due = fmtDate(dueDate);
  return !!due && due < today();
}

/**
 * 生效的缴费状态（★ 2026-10-22 三部门统一口径）
 *
 * 用户原话：「逾期怎么判，所有部门：未缴清 + 过了应缴日」。
 * 财务侧**从不写 4**（它的枚举里没有「逾期」这个值），所以：
 *   · 库里存的是 1 待缴 + 过了应缴日 → 展示成 4 逾期（派生）；
 *   · 库里如果本来就是 4（人工或迁移回填过）→ 保持 4；
 *   · 已缴 2 / 已核对 3 / 冻结 5 → 一律不判逾期。
 * 这条与初高 `effectivePayStatus()`、大学 urge.route.ts 的派生逻辑完全同源。
 */
function effectivePayStatus(row: any): number {
  const raw = row.pay_status == null ? null : Number(row.pay_status);
  // 老数据还没回填 pay_status 时，按 call_status 折算兜底
  const base = raw ?? (Number(row.call_status) === FeeCallStatus.PAID ? PayStatus.PAID : PayStatus.UNPAID);
  // ★ 2026-10-25：核对失败(6) 原样返回 —— 钱交过了、只是凭证被财务打回，
  //   不能掉进下面的「未结清 → 逾期」分支里变成 4
  if (base === PayStatus.REJECTED) return PayStatus.REJECTED;
  if (base === PayStatus.PAID || base === PayStatus.VERIFIED || base === PayStatus.FROZEN) return base;
  if (base === PayStatus.OVERDUE) return PayStatus.OVERDUE;
  // 未结清 + 过了应缴日 → 逾期
  const due = fmtDate(row.due_date);
  if (due && due < today()) return PayStatus.OVERDUE;
  return PayStatus.UNPAID;
}

/**
 * 谁能登记缴费（★ 2026-10-22 用户口径：班主任、学管、校长）
 *
 * 原来只有「本人是该生班主任」或系统管理员，
 * 现在补上学管主任（TEACH_DEAN）与校长（RM_PRINCIPAL）——
 * 与初高 / 大学的登记缴费权限对齐（那两边的写码给了班主任/学管/校长）。
 */
const FEE_CALL_WRITE_ROLES: string[] = [
  RoleCode.TEACH_HEAD,
  RoleCode.TEACH_DEAN,
  RoleCode.RM_PRINCIPAL,
  RoleCode.PROJECT_MANAGER,
  RoleCode.SYS_ADMIN,
];

function canRegisterPayment(row: any, operator: { userId: string; roles: string[] }): boolean {
  // 本人是该生班主任，或持有写角色（学管/校长/项目经理/管理员）
  const isHeadTeacher = row.head_teacher_id === operator.userId;
  const hasWriteRole = (operator.roles || []).some((r) => FEE_CALL_WRITE_ROLES.includes(r as RoleCode));
  // SUPER_TEST 是测试账号，允许登记（历史上就在放行，别丢）
  const isSuperTest = (operator.roles || []).includes('SUPER_TEST');
  return isHeadTeacher || hasWriteRole || isSuperTest;
}

/** 催费单行 → 输出结构 */
function decorate(row: any, operator: { userId: string; roles: string[] }): any {
  const canHandle = canRegisterPayment(row, operator);
  const payStatus = effectivePayStatus(row);

  return {
    id: row.id,
    feeType: row.fee_type,
    /**
     * ★ 2026-10-22：改用全量的 FEE_TYPE_NAME。
     *   原来用的是就业自有的三类字典（只有住宿费/餐费/保险费），
     *   但催费单现在从财务同步过来，财务那边有学费/试学费等 →
     *   用三类字典会出现「缴费类型」列空白。先查全量字典，取不到再回落三类。
     */
    feeTypeName: FEE_TYPE_NAME[row.fee_type] || FEE_CALL_CATEGORY_NAME[row.fee_type] || '',

    studentId: row.student_id,
    studentNo: row.student_no || null,
    studentName: row.student_name || null,
    phone: row.phone || null,
    parentPhone: row.parent_phone || null,

    classId: row.class_id || null,
    className: row.class_name || null,
    deptCode: row.dept_code ?? null,
    deptName: row.dept_code ? DEPT_NAME[row.dept_code] || null : null,
    headTeacherId: row.head_teacher_id || null,
    headTeacherName: row.head_teacher_name || null,

    feeAmount: row.fee_amount ?? null,
    feeAmountText: fenToYuanText(row.fee_amount),
    dueDate: fmtDate(row.due_date),
    overdue: isOverdue(row.due_date, row.call_status),
    callReason: row.call_reason || null,

    callStatus: row.call_status,
    callStatusName: FEE_CALL_STATUS_NAME[row.call_status] || '',
    /**
     * ★ 2026-10-22：三部门统一用 payStatus（1待缴 2已缴 3已核对 4逾期 5冻结）。
     * 前端催费页三个部门共用一套状态列/筛选，就业不再自己折算 callStatus。
     * callStatus 仍然返回，只作为「催收进度」备查（挂 tooltip）。
     */
    payStatus,
    payStatusName: PAY_STATUS_NAME[payStatus] || '',
    handleTime: fmtDateTime(row.handle_time),
    handleRemark: row.handle_remark || null,

    /* ★ 2026-10-21：登记缴费五列（与初高 t_class_fee 同口径）——
       催费页里就业的行也要能显示 实缴金额 / 缴费方式 / 缴费日期 / 凭证 */
    payMethod: row.pay_method ?? null,
    payMethodName: row.pay_method != null ? PAY_METHOD_NAME[Number(row.pay_method)] ?? '' : '',
    paidAmount: row.paid_amount ?? null,
    paidAmountText: row.paid_amount == null ? null : fenToYuanText(row.paid_amount),
    payDate: fmtDate(row.pay_date),
    voucherUrl: row.voucher_url || null,
    payRemark: row.pay_remark || null,

    applicantId: row.applicant_id || null,
    applicantName: row.applicant_name || null,

    remark: row.remark || null,
    createTime: fmtDateTime(row.create_time),
    canHandle,
  };
}

/* ============================================================
 * 1. 列表
 *    GET /api/job/fee-call/page
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().optional(),
  feeType: z.coerce.number().int().optional(),
  classId: z.string().optional(),
  /**
   * 催费单状态：1 待催缴 / 2 催缴中 / 3 已缴清
   *
   * ★ 2026-10-20：支持多值（逗号分隔，如 `1,2`）。
   *   催费页的「缴费状态」已统一成初高/大学那套（待缴/已缴/已核对/逾期/冻结），
   *   其中「待缴」= 待催缴 + 催缴中 两种催费单状态，单选传不进来。
   *   单值仍然照旧可用（`3` 就是只看已缴清），不影响就业模块自己的调用。
   */
  callStatus: z.union([z.coerce.number().int(), z.string()]).optional(),
  /**
   * 统一缴费状态（催费页用，与初高/大学同一套码：1待缴 2已缴 3已核对 4逾期 5冻结）
   *
   * ★ 2026-10-20：催费页「缴费状态」三部门统一后，就业侧不能再让前端自己折算
   *   （「待缴」还要排掉已过期的、「逾期」要按应缴日派生），这里按展示口径翻译成
   *   call_status + due_date 条件：
   *     1 待缴 → call_status 1,2 且未过应缴日
   *     2 已缴 → call_status 3（已缴清）
   *     4 逾期 → call_status 1,2 且已过应缴日
   *     3 已核对 / 5 冻结 → 就业没有这些状态 → 不出数据（不是忽略条件）
   */
  payStatus: z.coerce.number().int().optional(),
  onlyMine: z.coerce.boolean().optional(),
  // ★ 2026-10-20：「仅看紧急」对就业也要生效 ——
  //   就业行的 isUrgent 就是 overdue（逾期未缴清），这里按同一口径过滤。
  onlyOverdue: boolFlag.optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

feeCallRouter.get(
  '/page',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    /**
     * ★ 2026-10-26 用户口径：就业部催费名单也改为**以财务账单到期日为准**
     *   （与初高/大学同一套：只催餐费/住宿费/保险费，提前 N 天）
     *
     * 实现方式：财务名单是「该催谁」的唯一依据；
     *   本地 `t_job_fee_call` 只在有对应行时补催收进度（call_status）等业务字段，
     *   没有本地行的，按「待催缴」构造一条只读行（处理催费单仍需要本地行，会提示不存在）。
     */
    const aheadDays = await getUrgeAheadDays();
    // ★ 2026-10-26 必须按部门过滤，否则三个部门页签会看到同一批人
    const fin = await listUrgeByExpire(aheadDays, {
      keyword: q.keyword,
      feeType: q.feeType,
      deptCode: 3, // 就业部
    });
    if (!fin.rows.length) {
      res.json(page([], 0, q));
      return;
    }
    const finKey = new Set(fin.rows.map((r) => `${r.studentId}::${r.feeType}`));
    const finStuIds = [...new Set(fin.rows.map((r) => r.studentId))].filter(Boolean);
    const finStuNos = [...new Set(fin.rows.map((r) => r.studentNo))].filter(Boolean);

    const base = tbl(db, DB, TABLE, STAGE)
      .where('is_deleted', false)
      // ★ 2026-10-26 双键：财务 studentId（FSB-xxx）与本地 student_id 不是一套 id，学号兜底
      .where((b: any) => {
        b.whereIn('student_id', finStuIds.length ? finStuIds : [''])
          .orWhereIn('student_no', finStuNos.length ? finStuNos : ['']);
      })
      // 2 住宿费 / 3 餐费 / 4 保险费（只有这三类有到期概念）
      .whereIn('fee_type', [2, 3, 4]);

    if (q.classId) base.andWhere('class_id', q.classId);

    // ★ 班主任 / 项目经理数据范围（与原实现同口径）
    const isAdmin = hasRole(operator.roles, RoleCode.SYS_ADMIN);
    const isPM = hasRole(operator.roles, RoleCode.PROJECT_MANAGER);
    const isHeadTeacher = hasRole(operator.roles, RoleCode.TEACH_HEAD);
    const isEduAdmin = hasRole(operator.roles, RoleCode.ACAD_STAFF);

    if (!isAdmin && isPM && !isEduAdmin) {
      const myClasses = await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ project_manager_id: operator.userId, is_deleted: false })
        .select('id');
      const ids = myClasses.map((c: any) => c.id);
      if (ids.length === 0) base.whereRaw('1 = 0');
      else base.whereIn('class_id', ids);
    } else if (isHeadTeacher && !isAdmin && !isEduAdmin) {
      base.andWhere('head_teacher_id', operator.userId);
    } else if (q.onlyMine) {
      base.andWhere('head_teacher_id', operator.userId);
    }

    const localRows = (await base.select('*')) as any[];
    const localMap = new Map<string, any>();
    for (const l of localRows) {
      localMap.set(`${l.student_id}::${l.fee_type}`, l);
      if (l.student_no) localMap.set(`${l.student_no}::${l.fee_type}`, l);
    }

    let list: any[] = [];
    for (const r of fin.rows) {
      const k = `${r.studentId}::${r.feeType}`;
      if (!finKey.has(k)) continue;
      const l = localMap.get(k) ?? (r.studentNo ? localMap.get(`${r.studentNo}::${r.feeType}`) : undefined);
      if (l) {
        // 有本地行：以财务到期日为准，其余业务字段用本地的
        const merged = {
          ...l,
          due_date: r.expireDate,
          pay_status: r.remainDays < 0 ? PayStatus.OVERDUE : PayStatus.UNPAID,
        };
        list.push(decorate(merged, operator));
      } else {
        // 无本地行：构造只读行（call_status 固定「待催缴」）
        list.push(
          decorate(
            {
              id: `fin-${r.studentId}-${r.feeType}`,
              student_id: r.studentId,
              student_no: r.studentNo,
              student_name: r.studentName,
              class_id: r.classId ?? null,
              class_name: r.className ?? null,
              dept_code: r.deptCode ?? null,
              fee_type: r.feeType,
              fee_amount: r.suggestAmount ?? 0,
              due_date: r.expireDate,
              call_status: 1,
              pay_status: r.remainDays < 0 ? PayStatus.OVERDUE : PayStatus.UNPAID,
              phone: null,
              parent_phone: null,
              head_teacher_id: null,
              head_teacher_name: null,
            },
            operator,
          ),
        );
      }
    }

    /**
     * ★ 2026-10-26 除费用信息外，其余字段以**学生档案**为准（与初高/大学一致）
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

    // ---- 与原来同口径的筛选 ----
    if (q.payStatus !== undefined) list = list.filter((x: any) => x.payStatus === q.payStatus);
    if (q.onlyOverdue) list = list.filter((x: any) => Number(x.overdueDays ?? 0) > 0);
    if (q.callStatus !== undefined && q.callStatus !== '') {
      const arr = String(q.callStatus)
        .split(',')
        .map((s: string) => Number(s.trim()))
        .filter((n: number) => Number.isInteger(n) && n > 0);
      if (arr.length) list = list.filter((x: any) => arr.includes(Number(x.callStatus)));
    }
    if (q.startDate) list = list.filter((x: any) => String(x.dueDate || '') >= q.startDate);
    if (q.endDate) list = list.filter((x: any) => String(x.dueDate || '') <= q.endDate);
    list.sort((a: any, b: any) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));

    const total = list.length;
    const pageNo = Number(q.page || 1);
    const size = Number(q.size || 20);
    const paged = list.slice((pageNo - 1) * size, pageNo * size);

    res.json(page(paged, total, q));
  }),
);

/* ============================================================
 * 2. 详情
 *    GET /api/job/fee-call/detail
 * ============================================================ */

feeCallRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '催费单ID必传') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.FEE_CALL_NOT_FOUND, '催费单不存在');

    const history = await tbl(db, DB, TABLE, STAGE)
      .where({ student_id: row.student_id, is_deleted: false })
      .whereNot('id', id)
      .orderBy('create_time', 'desc')
      .limit(20);

    res.json(
      ok({
        ...decorate(row, operator),
        history: history.map((h: any) => ({
          id: h.id,
          feeType: h.fee_type,
          feeTypeName: FEE_CALL_CATEGORY_NAME[h.fee_type] || '',
          dueDate: fmtDate(h.due_date),
          callStatus: h.call_status,
          callStatusName: FEE_CALL_STATUS_NAME[h.call_status] || '',
          createTime: fmtDateTime(h.create_time),
        })),
      }),
    );
  }),
);

/* ============================================================
 * 3. 可选学生（教务发起时选人）
 *    GET /api/job/fee-call/student-options
 * ============================================================ */

feeCallRouter.get(
  '/student-options',
  validate(
    z.object({
      keyword: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;

    const query = tblAs(db, DB, STUDENT_TABLE, STAGE, 's')
      .leftJoin(`${tblRef(DB, CLASS_TABLE)} as c`, 's.class_id', 'c.id')
      .where('s.is_deleted', false)
      .whereIn('s.student_status', ALLOW_STATUS);

    if (q.keyword) {
      query.andWhere((x: any) => {
        x.where('s.student_name', 'like', `%${q.keyword}%`).orWhere('s.student_no', 'like', `%${q.keyword}%`);
      });
    }

    const rows = await query
      .select(
        's.id as student_id',
        's.student_no',
        's.student_name',
        's.phone',
        's.parent_phone',
        'c.class_name',
        'c.dept_code',
        'c.head_teacher_id',
        'c.head_teacher_name',
      )
      .orderBy('s.student_no', 'asc')
      .limit(q.limit);

    res.json(
      ok(
        rows.map((r: any) => ({
          studentId: r.student_id,
          studentNo: r.student_no,
          studentName: r.student_name,
          className: r.class_name || null,
          deptCode: r.dept_code ?? null,
          deptName: r.dept_code ? DEPT_NAME[r.dept_code] || null : null,
          headTeacherId: r.head_teacher_id || null,
          headTeacherName: r.head_teacher_name || null,
          phone: r.phone || null,
          parentPhone: r.parent_phone || null,
        })),
      ),
    );
  }),
);

/* ============================================================
 * 4. 新建催费单
 *    POST /api/job/fee-call/create
 *
 * ⚠️ 只有教务老师能发起（管理员也可）。
 * ★ 发起后自动发站内信给班主任。
 * ============================================================ */

const createSchema = z.object({
  feeType: z.coerce.number().int(),
  studentId: z.string().min(1, '学生必传'),
  feeAmount: z.coerce.number().int().min(0).optional().nullable(),
  dueDate: z.string().min(1, '到期时间必填'),
  callReason: z.string().max(500).optional().nullable(),
  remark: z.string().max(500).optional().nullable(),
});

feeCallRouter.post(
  '/create',
  validate(createSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    // ① 只有教务老师/管理员能发起
    const allowed =
      operator.roles.includes(RoleCode.ACAD_STAFF) || operator.roles.includes(RoleCode.SYS_ADMIN);
    if (!allowed) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有教务老师能发起催费');
    }

    // ② 类别必须是三类之一
    if (!VALID_FEE_TYPES.includes(body.feeType)) {
      throw new BizError(BizCode.PARAM_ERROR, '费用类别只能是住宿费/保险费/餐费');
    }

    // ③ 学生校验
    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    if (!ALLOW_STATUS.includes(stu.student_status)) {
      throw new BizError(BizCode.STUDENT_STATUS_NOT_ALLOW, '该学生当前状态不允许发起催费');
    }

    // ④ 到期日不能早于今天
    if (body.dueDate < today()) {
      throw new BizError(BizCode.FEE_DUE_DATE_INVALID, '到期时间不能早于今天');
    }

    // ⑤ 同类费用不能有未完成的重复催费
    const dup = await tbl(db, DB, TABLE, STAGE)
      .where({ student_id: stu.id, fee_type: body.feeType, is_deleted: false })
      .whereNot('call_status', FeeCallStatus.PAID)
      .first();
    if (dup) {
      throw new BizError(
        BizCode.FEE_CALL_DUPLICATE,
        `该学生已有同类未完成的催费单`,
      );
    }

    // ⑥ 班级信息
    let cls: any = null;
    if (stu.class_id) cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: stu.class_id, is_deleted: false }).first();

    const id = randomUUID();
    const now = new Date();

    await db.transaction(async (trx) => {
      await tblInsTrx(trx, DB, TABLE, STAGE, {
        id,
        create_time: now,
        create_by: operator.userId,
        is_deleted: false,

        fee_type: body.feeType,

        student_id: stu.id,
        student_no: stu.student_no || null,
        student_name: stu.student_name || null,
        phone: stu.phone || null,
        parent_phone: stu.parent_phone || null,

        class_id: cls?.id || stu.class_id || null,
        class_name: cls?.class_name || stu.class_name || null,
        dept_code: cls?.dept_code ?? stu.dept_code ?? null,
        head_teacher_id: cls?.head_teacher_id || stu.head_teacher_id || null,
        head_teacher_name: cls?.head_teacher_name || stu.head_teacher_name || null,

        fee_amount: body.feeAmount ?? null,
        due_date: body.dueDate,
        call_reason: body.callReason || null,
        remark: body.remark || null,

        call_status: FeeCallStatus.PENDING,
        applicant_id: operator.userId,
        applicant_name: operator.userName,
      });

      // ★ 发站内信给班主任
      const receiverId = cls?.head_teacher_id || stu.head_teacher_id;
      if (receiverId) {
        await sendNotice(
          {
            noticeType: NOTICE_TYPE.SYSTEM,
            title: `【催费】${stu.student_name || ''} 的${FEE_CALL_CATEGORY_NAME[body.feeType] || ''}需催缴`,
            content:
              `${stu.student_name || ''}（${stu.student_no || ''}）的` +
              `${FEE_CALL_CATEGORY_NAME[body.feeType] || ''}需催缴，到期时间 ${body.dueDate}。` +
              (body.callReason ? `说明：${body.callReason}` : ''),
            receiverId,
            receiverName: cls?.head_teacher_name || stu.head_teacher_name || '班主任',
            receiverRole: RoleCode.TEACH_HEAD,
            senderId: operator.userId,
            senderName: operator.userName,
            bizType: 'feeCall',
            bizId: id,
            classId: cls?.id || stu.class_id,
            className: cls?.class_name || stu.class_name,
            studentId: stu.id,
            studentName: stu.student_name,
          },
          trx,
        );
      }
    });

    // ★ 2026-10-05：教务点「发起催费」→ 推给班级管理（班级「催费管理」页读只读副本）
    //    非阻断：失败只记日志，不能让催费单本身建不出来
    await syncFeeCallToClass(id);

    res.json(ok({ id }));
  }),
);

/* ============================================================
 * 5. 处理（班主任催完了 / 学生交钱了）
 *    POST /api/job/fee-call/handle
 *
 * ⚠️ 只有该学生的班主任本人（或管理员）能处理。
 * ============================================================ */

feeCallRouter.post(
  '/handle',
  validate(
    z.object({
      id: z.string().min(1, '催费单ID必传'),
      callStatus: z.coerce.number().int().min(2).max(3),
      handleRemark: z.string().max(500).optional().nullable(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.FEE_CALL_NOT_FOUND, '催费单不存在');

    /**
     * 权限：该生班主任，或 学管主任 / 校长（★ 2026-10-22 用户口径：
     * 「谁能登记缴费 —— 班主任、学管、校长」，三部门一致）
     */
    if (!canRegisterPayment(row, operator)) {
      throw new BizError(
        BizCode.NO_OPERATION_PERMISSION,
        '只有该学生的班主任、学管主任或校长能处理此催费单',
      );
    }

    if (row.call_status === FeeCallStatus.PAID) {
      throw new BizError(BizCode.FEE_CALL_STATUS_NOT_ALLOW, '该催费单已完成，不能重复处理');
    }

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      call_status: body.callStatus,
      handle_time: new Date(),
      handle_remark: body.handleRemark || null,
      update_time: new Date(),
      update_by: operator.userId,
    });

    // ★ 2026-10-05：催缴状态变了 → 把最新状态推给班级管理（只读副本）
    await syncFeeCallToClass(body.id);

    res.json(ok({ callStatus: body.callStatus }));
  }),
);

/* ============================================================
 * 5.5 登记缴费（对齐初高 · ★ 2026-10-21 用户要求）
 *    POST /api/job/fee-call/voucher
 *
 * 【在做什么】
 *   初高的催费行早就能「上传缴费凭证（登记缴费）」：缴费方式 / 实缴金额 /
 *   缴费时间 / 备注 / 截图，五样一起落库。就业的催费单原来只有一个 call_status，
 *   「钱怎么交的」完全没记录 → 催费页里就业的行操作列只能显示「—」。
 *   本接口把那五项补到 t_job_fee_call（迁移 20261021_001）。
 *
 * 【状态怎么变】
 *   登记成功 → call_status 置 3（已缴清），同时写 handle_time / handle_remark 留痕
 *   （等于「班主任催完了、钱收到了」，与 /handle 的终态一致，但不覆盖原有催缴说明）。
 *
 * ⚠️ 仍然不产生财务账目：本模块只是催办工单，不写 sms_finance。
 *    凭证只存在这张单上，供催费页「查看」和家长缴费核对用。
 * ============================================================ */

feeCallRouter.post(
  '/voucher',
  validate(
    z.object({
      id: z.string().min(1, '催费单ID必传'),
      /** 缴费方式 1微信支付 2支付宝 3现金 */
      payMethod: z.coerce.number().int().min(1).max(3, '缴费方式只能是 微信支付 / 支付宝 / 现金'),
      /** 实缴金额（分）；允许与应缴（fee_amount）不同 */
      paidAmount: z.coerce.number().int().positive('缴费金额必须大于 0'),
      payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '缴费时间格式应为 YYYY-MM-DD'),
      remark: z.string().max(200, '备注最多 200 字').optional(),
      /** 缴费截图；现金可不传 */
      dataUrl: z.string().optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const dateErr = checkPayDate(body.payDate);
    if (dateErr) throw new BizError(BizCode.PARAM_ERROR, dateErr);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.FEE_CALL_NOT_FOUND, '催费单不存在');

    // 权限与 /handle 同款：该生班主任、学管主任、校长（三部门统一口径）
    if (!canRegisterPayment(row, operator)) {
      throw new BizError(
        BizCode.NO_OPERATION_PERMISSION,
        '只有该学生的班主任、学管主任或校长能登记此催费单的缴费',
      );
    }

    /* ---- 截图：现金不强制，微信/支付宝必须有（与初高同规则） ---- */
    let voucherUrl: string | null = null;
    if (body.dataUrl) {
      const saved = saveVoucherImage(body.dataUrl, 'call');
      if (!saved.ok) throw new BizError(BizCode.PARAM_ERROR, saved.message);
      voucherUrl = saved.voucherUrl;
    } else if (body.payMethod !== PAY_METHOD.CASH) {
      throw new BizError(BizCode.PARAM_ERROR, '请上传缴费截图（微信支付 / 支付宝需要凭证，现金可不传）');
    }

    const patch: Record<string, any> = {
      pay_method: body.payMethod,
      paid_amount: body.paidAmount,
      pay_date: body.payDate,
      pay_remark: body.remark || null,
      // 催收进度：已缴清（就业自有的这套仍然维护，用于「催收进度」展示）
      call_status: FeeCallStatus.PAID,
      /**
       * ★ 2026-10-22：缴费状态同步置「已缴」。
       *   三部门现在统一看 pay_status（与初高同码），只改 call_status 的话
       *   催费列表的「缴费状态」列对就业行就永远显示「待缴」。
       *   已经是 3 已核对 / 5 冻结 的不动（那两种状态不能被登记缴费覆盖）。
       */
      pay_status:
        Number(row.pay_status) === PayStatus.VERIFIED || Number(row.pay_status) === PayStatus.FROZEN
          ? Number(row.pay_status)
          : PayStatus.PAID,
      handle_time: new Date(),
      handle_remark: body.remark || row.handle_remark || null,
      update_time: new Date(),
      update_by: operator.userId,
    };
    // 现金且没传截图：保留原来的凭证，不要把它清空
    if (voucherUrl) patch.voucher_url = voucherUrl;
    /**
     * ★ 2026-10-25：重新登记 → 清掉「已上传财务时间」，让它重新回到
     *   「批量上传到财务」候选（详见 class-jh/routes/fee.route.ts 同款注释）。
     *   ⚠️ 只清时间，不清 `finance_fee_id`（清掉会再建一张财务单 → 重复记账）。
     */
    if (row.finance_fee_id) patch.finance_transfer_time = null;

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update(patch);

    /**
     * ★ 2026-10-23：反写财务缴费单（best-effort，失败不阻断登记）
     *
     * 这张催费单如果是财务推来的（`source_system='finance'` + `source_id`），
     * 财务那张单可能还是「待缴(1)」→ 财务点「核对」会被拦「尚未缴费，无法核对」，
     * 就业催费就永远停在「已缴(2)」到不了「已核对(3)」。
     * 只推收款事实 + 1→2，与财务 `attachVoucher()` 同口径；不改其它状态。
     */
    const srcRow = row as Record<string, any>;
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
        payDate: body.payDate,
        remark: body.remark || null,
        operatorId: operator.userId,
      });
    }

    // 催缴状态变了 → 推给班级管理（只读副本），与 /handle 同口径
    await syncFeeCallToClass(body.id);

    res.json(
      ok(
        {
          id: body.id,
          voucherUrl: voucherUrl ?? (row.voucher_url || null),
          callStatus: FeeCallStatus.PAID,
          callStatusName: FEE_CALL_STATUS_NAME[FeeCallStatus.PAID] || '',
          payStatus: patch.pay_status,
          payStatusName: PAY_STATUS_NAME[Number(patch.pay_status)] || '',
          payMethodName: PAY_METHOD_NAME[body.payMethod] ?? '',
        },
        '缴费登记成功',
      ),
    );
  }),
);

/* ============================================================
 * 6. 作废（发起人可以作废自己的）
 *    POST /api/job/fee-call/void
 *
 * ⚠️ 实现方式 = 逻辑删除（is_deleted=true）。
 *    为什么不用状态字段：FeeCallStatus 只有 1待催缴/2催缴中/3已缴清，
 *    没有"作废"。为了一个作废去动公共枚举不划算，
 *    而且"作废"本质就是"这条单子不要了" = 逻辑删除，语义正好对上。
 * ============================================================ */

feeCallRouter.post(
  '/void',
  validate(z.object({ id: z.string().min(1, '催费单ID必传') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.FEE_CALL_NOT_FOUND, '催费单不存在');

    const isApplicant = row.applicant_id === operator.userId;
    const isAdmin = operator.roles.includes(RoleCode.SYS_ADMIN);
    // ★ 万能测试号（SUPER_TEST）：验证「发起 → 作废」链路，业务验证用全放行
    if (!isApplicant && !isAdmin && !operator.roles.includes('SUPER_TEST')) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有发起人能作废此催费单');
    }
    if (row.call_status === FeeCallStatus.PAID) {
      throw new BizError(BizCode.FEE_CALL_STATUS_NOT_ALLOW, '已缴清的催费单不能作废');
    }

    await tbl(db, DB, TABLE, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: operator.userId,
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 7. 统计
 *    GET /api/job/fee-call/summary
 * ============================================================ */

feeCallRouter.get(
  '/summary',
  wrap(async (req, res) => {
    const operator = getOperator(req);

    const base = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);

    // 班主任只看自己的班
    const isHeadTeacher = operator.roles.includes(RoleCode.TEACH_HEAD);
    const isAdmin = operator.roles.includes(RoleCode.SYS_ADMIN);
    const isEduAdmin = operator.roles.includes(RoleCode.ACAD_STAFF);
    if (isHeadTeacher && !isAdmin && !isEduAdmin) {
      base.andWhere('head_teacher_id', operator.userId);
    }

    const [{ c: total }] = (await base.clone().count({ c: '*' })) as Array<{ c: number }>;
    const [{ c: pending }] = (await base.clone().andWhere('call_status', FeeCallStatus.PENDING).count({ c: '*' })) as Array<{ c: number }>;
    const [{ c: calling }] = (await base.clone().andWhere('call_status', FeeCallStatus.CALLING).count({ c: '*' })) as Array<{ c: number }>;
    const [{ c: done }] = (await base.clone().andWhere('call_status', FeeCallStatus.PAID).count({ c: '*' })) as Array<{ c: number }>;
    const [{ c: overdue }] = (await base
      .clone()
      .whereNot('call_status', FeeCallStatus.PAID)
      .andWhere('due_date', '<', today())
      .count({ c: '*' })) as Array<{ c: number }>;

    res.json(
      ok({
        total: Number(total),
        // 前端卡片用的名字保持通用
        pending: Number(pending) + Number(calling), // 待处理 = 待催缴+催缴中
        called: Number(calling),
        done: Number(done),
        overdue: Number(overdue),
        // 细分
        pendingOnly: Number(pending),
        calling: Number(calling),
      }),
    );
  }),
);

export default feeCallRouter;
