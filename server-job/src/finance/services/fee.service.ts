/**
 * 缴费管理 · 业务逻辑
 * 负责人：周铭（财务管理）
 *
 * ⚠️ 把业务逻辑写在 service 里、路由里只做「取参 → 调 service → 返回」，
 *    这样逻辑才能被复用，也才能单独测试。
 */

import { randomUUID } from 'crypto';
import { Knex } from 'knex';
import {
  BizCode,
  FEE_TYPE_NAME,
  PAY_STATUS_NAME,
  DEPT_NAME,
  FeeType,
  PayStatus,
  StudentStatus,
  SourceModule,
  SOURCE_MODULE_NAME,
  FEE_SOURCE_MODULE,
  VOUCHER_REUSABLE_FEE_TYPES,
} from 'shared-types/finance';
// ★ 2026-10-21 财务核对后要回写咨询侧收款单状态（跨库同进程，全限定名更新）
import { ConsultFeeStatus } from 'shared-types/consult';
import { db, knexRaw } from '../utils/db';
import { BizError } from '../middleware/errorHandler';
import { nextBillNoForPay } from '../utils/orderNo';
import { getStandard, isVoucherReusable, expectedSourceOf } from './fee-standard.service';
// ★ 2026-10-26 到期日计算抽公共（回填脚本 / 催费读侧走同一份规则）
import { computeExpireDate, expireUnitOf } from './expire';
import { findArchiveStudent } from './student-archive';
// ★ 2026-10-22 核对到账后立即回推咨询侧（推进学生状态 + 同步教学学籍）
import { remotePost } from '../../shared/http';

export const FEE_TABLE = 't_finance_fee';
export const BILL_TABLE = 't_finance_bill';

/** 分 → 元（字符串，保留两位小数） */
function centToYuan(cent: number): string {
  return ((Number(cent) || 0) / 100).toFixed(2);
}

/** 日期格式化 YYYY-MM-DD（knex 取出的 date 可能是 Date 对象） */
export function toDateStr(v: any): string | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 时间格式化 YYYY-MM-DD HH:mm:ss */
export function toTimeStr(v: any): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * ★ 2026-10-22 咨询阶段的「临时学号」（ZX + 数字）
 *
 * 业务口径（用户反馈）：
 *   学生还没分班时，交试学费 / 正式学费都还没有真实学号；
 *   咨询侧为了让「财务建单学号必填」走得通，先塞了个 ZX 临时号占位。
 *   但财务在缴费核对台看到的学号应该是空的（前端显示「—」），
 *   分班建档后由 applyArchiveToFeeRows 把档案里的真实学号覆盖上来。
 *
 * ⚠️ 只做「展示口径」过滤，不动库里的值：
 *   student_no 是财务侧对账 / 凭证共用的键，抹掉会连累其它判断。
 */
const TEMP_STUDENT_NO_RE = /^ZX\d+$/i;

export function isTempStudentNo(no?: string | null): boolean {
  return !!no && TEMP_STUDENT_NO_RE.test(String(no).trim());
}

/**
 * 缴费行 → 前端契约格式
 *
 * ⚠️ 关键约定：
 *    - 枚举双返回：feeType + feeTypeName
 *    - 金额保持「分」，不在后端换算，前端 ÷100 显示
 *    - 字段名用 shared-types 里定义的那些，不许自创
 */
export function toFeeListItem(r: any) {
  return {
    id: r.id,
    studentId: r.student_id,
    // ★ 2026-10-22 未分班（只有 ZX 临时号）→ 学号留空，前端显示「—」
    studentNo: isTempStudentNo(r.student_no) ? '' : r.student_no,
    studentName: r.student_name,
    classId: r.class_id ?? undefined,
    className: r.class_name ?? undefined,
    deptCode: r.dept_code ?? undefined,
    deptName: r.dept_code ? DEPT_NAME[r.dept_code] : undefined,
    headTeacherName: r.head_teacher_name ?? undefined,
    feeType: r.fee_type,
    feeTypeName: FEE_TYPE_NAME[r.fee_type] || '',
    /**
     * ★ 2026-10-26 合并单的全部费用类型名（用户要求「缴费类型全写上」）
     *
     * 合并单的 `fee_type` 只是第一项（学费），光看它会以为整笔都是学费。
     * 这里把 item_detail 里的类型名全部取出来，前端直接拼「学费、餐费、住宿费…」。
     * 单项单返回 undefined，前端继续用 feeTypeName（不改变原有单类型显示）。
     */
    feeTypeNames: (() => {
      const items = parseItemDetail(r.item_detail);
      if (items.length <= 1) return undefined;
      const names = items
        .map((i: any) => i.feeTypeName || FEE_TYPE_NAME[Number(i.feeType)] || '')
        .filter(Boolean);
      return names.length > 1 ? names : undefined;
    })(),
    amount: Number(r.amount),
    /**
     * ★ 2026-10-26 应缴 / 优惠（用户口径：缴费管理里要看到「应缴、实缴、优惠」）
     *
     * 老单据在迁移里已回填 standard_amount = amount，所以优惠显示 0；
     * 万一是迁移前遗留的 NULL，这里也按「应缴=实缴」兜底，不显示空。
     * 优惠取 max(0, ...)：实缴超过应缴属于异常数据，不显示负数误导人。
     */
    standardAmount: r.standard_amount != null ? Number(r.standard_amount) : Number(r.amount),
    discount: Math.max(
      0,
      (r.standard_amount != null ? Number(r.standard_amount) : Number(r.amount)) - Number(r.amount),
    ),
    sourceModule: r.source_module ?? undefined,
    sourceModuleName: r.source_module
      ? SOURCE_MODULE_NAME[r.source_module]
      : undefined,
    // 该费用类型是否允许「多人共用一张凭证」（餐费为 true）
    voucherReusable: VOUCHER_REUSABLE_FEE_TYPES.includes(Number(r.fee_type)),
    payStatus: r.pay_status,
    payStatusName: PAY_STATUS_NAME[r.pay_status] || '',
    payDate: toDateStr(r.pay_date),
    expireDate: toDateStr(r.expire_date),
    hasVoucher: !!r.voucher_url,
    voucherNo: r.voucher_no ?? undefined,
    /**
     * 默认值：一张凭证只覆盖本单（后续 list/detail 会用真实聚合结果覆盖）。
     * ⚠️ 之所以给默认值而不是留空，是为了让「没查到 / 只有一单」的情况
     *    前端也能直接按「共 1 笔 = 本单金额」渲染，不用写一堆判空。
     */
    voucherGroupCount: 1,
    voucherGroupAmount: Number(r.amount),
    /**
     * ★ 2026-10-19 用户口径：「一张凭证 = 交的总金额，总金额下面列小项」
     *    合计单（一次交多类费用）会把分项存在 item_detail，
     *    列表用它显示「含 N 项」，详情用它渲染子表。
     *    单项单没有明细 → 默认 1 项、金额即本单金额。
     */
    itemCount: parseItemDetail(r.item_detail).length || 1,
    /**
     * 可核对 = 待核对(status=2) + 未核对 + 未被打回。
     *
     * ⚠️ 为什么可以用 pay_status===PAID 判定？
     *    因为「上传凭证」这个动作会同步把状态推到 PAID（见 addFee / attachVoucher），
     *    所以 status=PAID 就等价于「钱已到、等财务核对」。
     *    若以后新增别的写凭证入口，务必同步维护这个不变量。
     *
     * ★ 2026-10-23：**不再要求有凭证**。现金/线下收款没有转账截图，
     *   但钱确实到账了，财务必须能核对入账（否则教学侧转交过来的单
     *   在财务里既看不到、也核不了）。有凭证的单行为完全不变。
     */
    canVerify: r.pay_status === PayStatus.PAID && !r.is_verified && !r.is_rejected,
  };
}

/**
 * 解析「合计单包含的费用项」
 *
 * ⚠️ 兼容三种存法（历史数据不统一，读的时候尽量宽容）：
 *    · null / ''            → []
 *    · JSON 字符串数组       → 解析
 *    · 已是数组（内存对象）  → 直接用
 * 单条结构：{ feeType, feeTypeName, amount, standardAmount, discount }（单位：分）
 */
export function parseItemDetail(raw: any): Array<{
  feeType: number;
  feeTypeName: string;
  amount: number;
  amountYuan: string;
  standardAmount: number;
  standardAmountYuan: string;
  discount: number;
  discountYuan: string;
  /** ★ 2026-10-27 补费里住宿费/餐费的月数（保险费为年数），用于算到期日 */
  months?: number;
  /** ★ 2026-10-27 优惠名目（学费才有） */
  discountReason?: string;
}> {
  if (!raw) return [];
  let arr: any[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      return [];
    }
  }
  return arr
    .filter((i) => i && Number(i.feeType) > 0)
    .map((i) => {
      const amount = Number(i.amount) || 0;
      const std = i.standardAmount != null ? Number(i.standardAmount) : amount;
      const discount = i.discount != null ? Number(i.discount) : std - amount;
      return {
        feeType: Number(i.feeType),
        feeTypeName: i.feeTypeName || FEE_TYPE_NAME[Number(i.feeType)] || '',
        amount,
        amountYuan: centToYuan(amount),
        standardAmount: std,
        standardAmountYuan: centToYuan(std),
        discount,
        discountYuan: centToYuan(discount),
        months: i.months != null ? Number(i.months) : undefined,
        discountReason: i.discountReason || undefined,
      };
    });
}

/** 缴费行 → 详情格式（在列表项基础上追加详情字段） */
export function toFeeDetail(r: any) {
  const items = parseItemDetail(r.item_detail);
  return {
    ...toFeeListItem(r),
    /**
     * 合计单的费用项（总金额下面列的那个小列）。
     * 单项单没有 item_detail → 用本单自身兜一个，前端可以无脑渲染。
     */
    items: items.length
      ? items
      : [
          {
            feeType: Number(r.fee_type),
            feeTypeName: FEE_TYPE_NAME[r.fee_type] || '',
            amount: Number(r.amount),
            amountYuan: centToYuan(Number(r.amount)),
            standardAmount: Number(r.amount),
            standardAmountYuan: centToYuan(Number(r.amount)),
            discount: 0,
            discountYuan: centToYuan(0),
          },
        ],
    voucherUrl: r.voucher_url ?? undefined,
    voucherTime: toTimeStr(r.voucher_time),
    voucherBy: r.voucher_by ?? undefined,
    isVerified: !!r.is_verified,
    verifiedByName: r.verified_by_name ?? undefined,
    verifiedTime: toTimeStr(r.verified_time),
    isRejected: !!r.is_rejected,
    rejectReason: r.reject_reason ?? undefined,
    isInBill: !!r.is_in_bill,
    period: r.period ?? undefined,
    remark: r.remark ?? undefined,
    createTime: toTimeStr(r.create_time) || '',
  };
}

/**
 * 构造列表查询条件（列表和导出共用）
 *
 * ⚠️⚠️ 财务侧【硬约束】共两条：
 *    ① 只查「已上传凭证 **或** 已收款」的缴费单
 *    ② 排除「冻结」状态的单据（2026-10-15 用户指令）
 *
 * 为什么（2026-10-04 用户指令）：
 *    缴费管理是财务的【核对工作台】，不是全量缴费台账。
 *    财务的职责链是：学生交钱 → 上游传凭证 → 财务核对凭证 → 入账。
 *    所以「还没传凭证、也还没收钱」的单子（待缴）对财务毫无意义 ——
 *    它们是上游（咨询/教务）该跟学生催缴的事，财务侧不该看到。
 *
 * ★★ 2026-10-23 用户反馈后放宽：「大学部批量上传到财务后，财务那里没有对应信息」
 *   【真因】不是转交没写库 —— 财务单建出来了、部门/班级/班主任/实收金额都对，
 *     唯独 `voucher_url` 是空的：**现金收款本来就没有转账截图**（教学侧登记缴费
 *     允许现金不传图）。而这条硬约束是「必须有凭证」→ 单子在核对台里查不到，
 *     等于「转交成功但财务看不见」，两边对不上账。
 *   【口径】把「已收款」也算进核对台：现金/线下的钱财务同样要核对入账，
 *     没有电子凭证不等于没这笔钱。未收款（待缴 1）仍然不出现 —— 原意图不变。
 *   【为什么不改成「全部单据」】待缴单是上游该催的，漏进来只会干扰财务视线。
 *
 * 这个约束写死在 buildFeeQuery 里（而不是交给前端传参），
 * 是故意的：这样列表、统计、导出三条路径自动一致，
 * 也不存在「前端漏传参数就漏数据」的可能。
 */
export function buildFeeQuery(q: any): Knex.QueryBuilder {
  const query = db(FEE_TABLE).where('is_deleted', false);

  /**
   * ---- 硬约束1：有凭证，或已收款（已缴 / 已核对） ----
   *
   * ⚠️ 必须整组用 `andWhere(回调)` 包起来：外面还有「排除冻结」等条件，
   *    直接 `orWhereIn` 会把它们全部变成「或」，冻结单、他部门的单都会漏进来。
   */
  query.andWhere((qb: any) => {
    qb.where((sub: any) => {
      sub.whereNotNull('voucher_url').andWhereNot('voucher_url', '');
    }).orWhereIn('pay_status', [PayStatus.PAID, PayStatus.VERIFIED]);
  });

  /**
   * ---- 硬约束2：冻结中的单据不出现在缴费管理 ----
   *
   * ⭐ 2026-10-15 用户指令：「冻结的不会出现在缴费管理中」。
   *    冻结单据（学生休学自动冻结的餐费/住宿费）属于学籍冻结范畴，
   *    不是财务的核对对象，留在核对台只会干扰财务视线。
   *
   * ⚠️ 写在这里而不是前端过滤：这样列表 / 统计 / 导出三条路径自动一致。
   */
  query.whereNot('pay_status', PayStatus.FROZEN);

  if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.classId) query.andWhere('class_id', q.classId);
  /**
   * 班级名筛选（精确）。
   *
   * ⚠️ 为什么同时支持 classId 和 className？
   *    - classId 是理想口径，但历史上（尤其是咨询模块建单的试学单）
   *      很多记录【只写了班级名、没写 class_id】，只按 classId 查会漏数据。
   *    - 所以下拉选出来的班级名直接按 class_name 精确匹配，命中率最高。
   */
  if (q.className) query.andWhere('class_name', q.className);
  if (q.deptCode) query.andWhere('dept_code', q.deptCode);
  /**
   * ★ 2026-10-26 类型筛选要能命中「合并单里包含该费用」的单据
   *
   * 合并单的 fee_type 只是第一项（学费），按 feeType=餐费 筛会漏掉
   * 「学费+餐费」这种单。所以除了 fee_type 精确匹配，再匹配 item_detail 里的分项。
   * （item_detail 是 TEXT 存 JSON，用 LIKE 匹配 `"feeType":N`，N 为 1~8 不会歧义）
   */
  if (q.feeType) {
    const ft = Number(q.feeType);
    query.andWhere((b: any) => {
      b.where('fee_type', ft).orWhereRaw('item_detail LIKE ?', [`%"feeType":${ft}%`]);
    });
  }
  if (q.sourceModule) query.andWhere('source_module', q.sourceModule);
  if (q.payStatus) query.andWhere('pay_status', q.payStatus);
  if (q.startDate) query.andWhere('pay_date', '>=', q.startDate);
  if (q.endDate) query.andWhere('pay_date', '<=', q.endDate);
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_no', 'like', `%${q.keyword}%`)
        .orWhere('student_name', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

/**
 * 构造「全量缴费台账」查询条件（**不含**有凭证硬约束）
 *
 * 💡 什么时候用它：
 *    需要看整个缴费盘子（含没交钱的单子）时，比如数据统计、对账。
 *    缴费管理列表【不要】用它，那是财务核对台，只该看有凭证的。
 *
 * ⚠️ 目前没有调用方，先留着做语义分界；要用时再显式选，
 *    避免以后有人随手改 buildFeeQuery 把财务的核对台口径弄坏。
 */
export function buildFeeLedgerQuery(q: any): Knex.QueryBuilder {
  const query = db(FEE_TABLE).where('is_deleted', false);

  if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.classId) query.andWhere('class_id', q.classId);
  if (q.className) query.andWhere('class_name', q.className);
  if (q.deptCode) query.andWhere('dept_code', q.deptCode);
  /**
   * ★ 2026-10-26 类型筛选要能命中「合并单里包含该费用」的单据
   *
   * 合并单的 fee_type 只是第一项（学费），按 feeType=餐费 筛会漏掉
   * 「学费+餐费」这种单。所以除了 fee_type 精确匹配，再匹配 item_detail 里的分项。
   * （item_detail 是 TEXT 存 JSON，用 LIKE 匹配 `"feeType":N`，N 为 1~8 不会歧义）
   */
  if (q.feeType) {
    const ft = Number(q.feeType);
    query.andWhere((b: any) => {
      b.where('fee_type', ft).orWhereRaw('item_detail LIKE ?', [`%"feeType":${ft}%`]);
    });
  }
  if (q.sourceModule) query.andWhere('source_module', q.sourceModule);
  if (q.payStatus) query.andWhere('pay_status', q.payStatus);
  if (q.startDate) query.andWhere('pay_date', '>=', q.startDate);
  if (q.endDate) query.andWhere('pay_date', '<=', q.endDate);
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_no', 'like', `%${q.keyword}%`)
        .orWhere('student_name', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

/* ============================================================
 * 下拉字典 & 统计（2026-10-03 用户指令新增）
 * ============================================================ */

/**
 * 班级字典 —— 「所有拥有的班级」
 *
 * 数据来源：缴费单表 + 学生表（左右合并）。
 *
 * ⚠️ 为什么不能只从「缴费单」取？
 *    缴费单里只有「有人缴过费」的班级；某个班一个人都没缴费时，
 *    下拉里就看不到它 —— 用户反馈的「看不到所有拥有的班级」正是这个原因。
 *    所以这里把 t_student_base 也并进来（学生表才是「拥有」的权威口径）。
 *
 * 💡 部门从 dept_code 直读（权威）；dept_code 缺失时才用班级名兜底推断：
 *      「大学部XX班」→ 大学部，其余 → 二三期。
 *    这样即使某个班没写 dept_code，也不会被错分到二三期而漏掉。
 *
 * @param deptCode 可选：只要某个部门的班级
 */
export async function listFeeClasses(deptCode?: number) {
  /**
   * 班级字典的两个来源：
   *   ① t_finance_fee —— 只统计【有凭证或已收款】的单，口径与缴费管理列表严格一致
   *      （★ 2026-10-23 与 buildFeeQuery 同步放宽，否则下拉的 N 会小于列表实际条数），
   *      这样下拉里「班级名 (N)」的 N 就是选完这个班后列表会出现的条数，不会有落差。
   *   ② t_student_base —— 学生表是「拥有班级」的权威口径。
   *      它只用来补「有名额但还没有任何已传凭证单据」的班级（保证下拉不缺点），
   *      不参与 count（避免把学生数混进单据数里，让 N 失去意义）。
   *
   * ⚠️ 表不存在也不能拖垮下拉（catch 兜底为空）。
   */
  const [feeRows, stuRows] = await Promise.all([
    db(FEE_TABLE)
      .where('is_deleted', false)
      .andWhere((qb: any) => {
        qb.where((sub: any) => {
          sub.whereNotNull('voucher_url').andWhereNot('voucher_url', '');
        }).orWhereIn('pay_status', [PayStatus.PAID, PayStatus.VERIFIED]);
      })
      .whereNotNull('class_name')
      .whereNot('class_name', '')
      .select('class_name', 'class_id', 'dept_code'),
    db('t_student_base')
      .where('is_deleted', false)
      .whereNotNull('class_name')
      .whereNot('class_name', '')
      .select('class_name', 'class_id', 'dept_code')
      .catch(() => [] as any[]),
  ]);

  const map = new Map<string, { className: string; classId?: string; deptCode: number; count: number }>();

  /** 累加「有凭证单据数」（只有费用表的数据走这里） */
  const absorbFee = (r: any) => {
    const name = String(r.class_name || '').trim();
    if (!name) return;
    const hit = map.get(name);
    if (hit) {
      hit.count += 1;
      if (!hit.classId && r.class_id) hit.classId = r.class_id;
      if (hit.deptCode == null && r.dept_code != null) hit.deptCode = Number(r.dept_code);
      return;
    }
    map.set(name, {
      className: name,
      classId: r.class_id ?? undefined,
      deptCode: r.dept_code != null ? Number(r.dept_code) : inferDeptCode(name),
      count: 1,
    });
  };

  /** 只补班级、不计数的来源（学生表走这里） */
  const absorbStu = (r: any) => {
    const name = String(r.class_name || '').trim();
    if (!name) return;
    const hit = map.get(name);
    if (hit) {
      if (!hit.classId && r.class_id) hit.classId = r.class_id;
      if (hit.deptCode == null && r.dept_code != null) hit.deptCode = Number(r.dept_code);
      return;
    }
    map.set(name, {
      className: name,
      classId: r.class_id ?? undefined,
      deptCode: r.dept_code != null ? Number(r.dept_code) : inferDeptCode(name),
      count: 0,
    });
  };

  feeRows.forEach(absorbFee);
  stuRows.forEach(absorbStu);

  let list = [...map.values()].map((c) => ({
    className: c.className,
    classId: c.classId,
    deptCode: c.deptCode,
    deptName: DEPT_NAME[c.deptCode] || '',
    count: c.count,
  }));

  if (deptCode != null) list = list.filter((c) => c.deptCode === deptCode);

  // 排序：先部门（1 二三期 → 2 大学部），再按班级名，保证下拉顺序稳定
  list.sort((a, b) =>
    a.deptCode !== b.deptCode
      ? a.deptCode - b.deptCode
      : a.className.localeCompare(b.className, 'zh-Hans-CN'),
  );

  return list;
}

/**
 * 班级名 → 部门编码（dept_code 缺失时的兜底）
 *
 * 约定：班级名以「大学部」开头 → 大学部(2)，其余 → 初高部(1)。
 */
export function inferDeptCode(cls: string): number {
  return cls.startsWith('大学部') ? 2 : 1;
}

/**
 * 按筛选条件聚合缴费状态统计（全量口径，不是当前页）
 *
 * ⚠️ 前端原来只能在「当前页」上数张数，页数一多就不准。
 *    这里用 SQL 一次聚合，工具栏上的数字才是真数。
 *
 * ⭐ 2026-10-04 口径调整（配合「财务只看有凭证单据」的硬约束）：
 *    既然 buildFeeQuery 已经只取有凭证的单子，原来的「待缴费」「待传凭证」
 *    两个计数器恒为 0（没凭证的单子根本不进结果集），留着只会让人困惑。
 *    所以换成财务核对台真正关心的三个数：
 *      · waitVerify 待核对 —— 有凭证、还没核对（财务的待办量）
 *      · verified   已缴   —— 已核对入账
 *      · rejected   已打回 —— 打回过、等上游重传凭证
 *
 * 💡 实现注意：
 *    1. 别名直接写在 raw SQL 里（`... END) as waitVerify`），
 *       因为本工程的 knex 类型里 `db.raw(...)` 没有 `.as()` 方法。
 *    2. 不要用 count({别名: raw}) —— knex 会把值当列名包 backtick，
 *       塞 raw 进去会踩 `Cannot read properties of undefined (reading 'raw')`。
 *    3. ⚠️ 必须用 knexRaw.raw，不能用 db.raw ！
 *       db.raw 只是 utils/db.ts 里做的一层「裸转发」（`db.raw = _knex.raw`），
 *       丢了 this 绑定。而 knex 的 raw 是依赖 this.context 的 getter，
 *       脱离实例调用必然抛 `Cannot read properties of undefined (reading 'raw')`。
 *       （该问题已在 utils/db.ts 用 .bind() 修掉，但这里沿用 knexRaw 更直白。）
 */
export async function statsFee(q: any) {
  const sum = (alias: string, cond: string, bindings: any[] = []) =>
    knexRaw.raw(`SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) as ${alias}`, bindings);

  const [row] = await buildFeeQuery(q)
    .clone()
    .select(
      knexRaw.raw('COUNT(*) as total'),
      // 待核对：有凭证 且 未核对 且 未打回
      sum(
        'waitVerify',
        'is_verified = 0 AND is_rejected = 0',
      ),
      // 已缴：核对通过
      sum('verified', 'is_verified = 1'),
      // 已打回：等上游重传凭证
      sum('rejected', 'is_rejected = 1'),
      sum('frozen', 'pay_status = ?', [PayStatus.FROZEN]),
    );

  const n = (v: any) => Number(v) || 0;
  return {
    total: n(row?.total),
    waitVerify: n(row?.waitVerify),
    verified: n(row?.verified),
    rejected: n(row?.rejected),
    frozen: n(row?.frozen),
  };
}

/**
 * 【核心】财务核对通过
 *
 * 做三件事（在一个事务里，要么全成功要么全回滚）：
 *   1. 校验：必须是「已缴 + 有凭证 + 未核对」的单子
 *   2. 生成缴费账单号，写入 t_finance_bill（账单明细）
 *   3. 回写缴费单：pay_status=已核对、is_verified=true、is_in_bill=true
 *
 * 💡 为什么第二步不能省？
 *    「核对」在业务上的含义就是「钱真的到账了，记进账本」，
 *    账本就是 t_finance_bill。只改状态不记账 = 账实不符。
 *
 * @returns 生成的账单号
 */
/**
 * ★ 2026-10-26 算这张缴费单的「到期日」（餐费 / 住宿费 / 保险费）
 *
 * 用户口径：
 *   · 缴费金额 ÷ 该费用的缴费标准 = 增加的时长，按月计算
 *   · 保险费的缴费标准是**年费**（180 元/年），所以按年算、再折成月份
 *   · 起点从**财务核对日**算；但如果该生该费用还有未到期的余量，
 *     从上次到期日往后接（续费不重叠、不回退）
 *
 * 学费 / 押金 / 校服 / 试学费 / 补费 没有到期概念 → 返回 null。
 *
 * @param t       事务（要和账单插入同一个事务，避免账单有、到期日没写）
 * @param row     缴费单
 * @param payDate 本次核对日 YYYY-MM-DD
 */
async function calcExpireDate(
  t: Knex.Transaction,
  row: any,
  payDate: string,
  /**
   * ★ 2026-10-27 已知周期（补费明细里的月数/年数）
   *
   * 补费是「按月补」的：老师填了 6 个月就补 6 个月，金额也是 450 × 6 算出来的。
   * 用「金额 ÷ 标准价」反推月数在标准价改过之后会算错（本来 6 个月的账算成 5 个月），
   * 所以明细里带了月数就直接用，不再反推。
   *
   *   · 餐费 / 住宿费：传月数
   *   · 保险费：传年数（与 unit === 'Y' 的口径一致）
   */
  monthsHint?: number,
): Promise<string | null> {
  const feeType = Number(row.fee_type);
  // 没有到期概念的费用（学费/试学费/押金/校服/补费…）直接返回
  // ★ 口径统一在 services/expire.ts（核对入账与历史回填走同一份，避免两套规则）
  const unit = expireUnitOf(feeType);
  if (!unit) return null;

  /**
   * ★ 2026-10-27 补费明细里带了周期（住宿/餐费=月，保险=年）→ 直接用，不再反推
   *
   * 「金额 ÷ 标准价」在标准价改过之后会算错月数（本来 6 个月的账算成 5 个月），
   * 所以明细里给了月数就以月数为准，这时连标准价都不用查。
   */
  const hint = Number(monthsHint) || 0;
  let std = 0;
  if (!hint) {
    // 取该费用在该部门的标准价（没有标准就算不出来，留空而不是瞎算）
    try {
      const s = await getStandard(feeType, Number(row.dept_code ?? 1));
      std = Number(s.amount) || 0;
    } catch {
      std = 0;
    }
    if (std <= 0) return null;
  }

  // 该生该费用「已入账」账单里最晚的到期日 —— 续费从这里接
  const prev = await t(BILL_TABLE)
    .where({
      student_id: row.student_id,
      fee_type: feeType,
      is_deleted: false,
      bill_type: 1,
    })
    .whereNotNull('expire_date')
    .max('expire_date as d')
    .first();

  const prevDate = prev?.d ? toDateStr(prev.d) : undefined;
  // ★ 计算规则统一在 services/expire.ts（回填脚本走同一份，避免两套口径）
  return computeExpireDate({
    feeType,
    amount: Number(row.amount) || 0,
    payDate,
    stdAmount: std,
    prevExpire: prevDate,
    // 补费给了明确周期 → 按周期算（保险费填的是年，先折成月，与 unit 的 M/Y 口径一致）
    ...(hint ? { months: unit === 'Y' ? hint * 12 : hint } : {}),
  });
}

export async function verifyFee(
  id: string,
  operator: { userId: string; userName: string },
  remark?: string,
  trx?: Knex.Transaction,
): Promise<string> {
  const run = async (t: Knex.Transaction): Promise<string> => {
    const row = await t(FEE_TABLE).where({ id, is_deleted: false }).first();
    if (!row) {
      throw new BizError(BizCode.PARAM_ERROR, '缴费单不存在或已被删除');
    }

    // ---- 状态校验（给出人话提示，不要只报「参数错误」）----
    if (row.is_verified) {
      throw new BizError(BizCode.PARAM_ERROR, '该缴费单已核对过，请勿重复核对');
    }
    if (row.pay_status === PayStatus.UNPAID) {
      throw new BizError(BizCode.PARAM_ERROR, '该缴费单尚未缴费，无法核对');
    }
    /**
     * ★ 2026-10-23：**不再要求必须有凭证**。
     *
     * 现金/线下收款（教学侧「登记缴费」允许现金不传截图）没有电子凭证，
     * 但钱是收到了的 —— 财务必须能核对入账，否则：
     *   · 催费页显示「已上传到财务」；
     *   · 财务缴费管理里能看到这张单（列表已放宽）；
     *   · 却点不了「核对」→ 这张单永远挂账，两边对不上。
     * 无凭证时在账单备注里写明「无电子凭证（现金/线下收款）」，账本自解释。
     */

    // ---- 生成账单号 ----
    const billNo = await nextBillNoForPay();
    const now = new Date();
    const payDate = toDateStr(row.pay_date) || toDateStr(now)!;

    /**
     * ★ 2026-10-27 补费单：一个「补学费」单里装着学费/住宿费/餐费/保险费，
     *   核对时要拆到各自那一栏，并且每栏的备注只写自己那一项
     *   （用户口径：「备注自动匹到财务里的每一栏儿」）。
     *
     * ★ 2026-10-26 合并单按分项拆账
     *
     * 一次缴清多类费用（学费 + 餐费 + 住宿费…）时，缴费单只有 1 个 `fee_type`
     * （取第一项）和 1 个合计 `amount`，明细存在 `item_detail`。
     * 如果账单也按合计记一条，就会出两个问题（用户 2026-10-26 实测反馈）：
     *   · 账单明细里整笔钱全进「学费缴费记录」，餐费/住宿、杂费组永远是空；
     *   · 到期日只能按学费算（无到期日），餐费/住宿的到期信息彻底丢失。
     *
     * 所以核对时按分项拆成多条账单：
     *   · 第 1 条沿用主账单号，其余 `ZD...-2 / -3`（bill_no 有唯一索引，不能重复）
     *   · 每条按自己的 fee_type 归组、各自算到期日
     *   · 各条金额之和 = 缴费单合计（对账口径不变）
     */
    const parts: Array<{
      feeType: number;
      amount: number;
      /** 这一项自己的备注文案（补费才写；正式收费的合并单保持原样，不逐项改备注） */
      text?: string;
      /** 已知周期（住宿费/餐费的月数、保险费的年数），优先用它算到期日 */
      months?: number;
    }> = (() => {
      const items = parseItemDetail(row.item_detail);
      /** 补费单才按分项写「自己那一栏」的备注，正式收费保持现状 */
      const isSupplement = Number(row.fee_type) === FeeType.SUPPLEMENT;
      if (items.length > 1) {
        return items
          .map((it: any) => {
            const feeType = Number(it.feeType ?? it.fee_type ?? 0);
            const amount = Number(it.amount ?? 0);
            const std = Number(it.standardAmount ?? amount);
            const discount = Number(it.discount ?? std - amount);
            return {
              feeType,
              amount,
              months: it.months != null ? Number(it.months) : undefined,
              text: isSupplement
                ? `${FEE_TYPE_NAME[feeType] || it.feeTypeName || ''} ¥${centToYuan(amount)}` +
                  (it.months ? `（${Number(it.months)} 个月）` : '') +
                  (discount > 0
                    ? `（应缴 ¥${centToYuan(std)}，优惠 ¥${centToYuan(discount)}${
                        it.discountReason ? `·${it.discountReason}` : ''
                      }）`
                    : '')
                : undefined,
            };
          })
          .filter((p) => p.feeType > 0 && p.amount > 0);
      }
      return [{ feeType: Number(row.fee_type), amount: Number(row.amount) || 0 }];
    })();

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // ---- 到期日：按「这一项」的金额/月数算，不是按合计 ----
      //    学费不写到期日（没有时间限制）；住宿费/餐费/保险费从缴费完成那次核对起算
      const expireDate = await calcExpireDate(
        t,
        { ...row, fee_type: part.feeType, amount: part.amount },
        payDate,
        part.months,
      );
      const subBillNo = i === 0 ? billNo : `${billNo}-${i + 1}`;

      await t(BILL_TABLE).insert({
        id: randomUUID(),
        create_time: now,
        create_by: operator.userId,
        is_deleted: false,
        bill_no: subBillNo,
        bill_type: 1, // 缴费账单
        source_id: row.id,
        source_no: row.voucher_no ?? null,
        student_id: row.student_id,
        student_no: row.student_no,
        student_name: row.student_name,
        class_id: row.class_id ?? null,
        class_name: row.class_name ?? null,
        dept_code: row.dept_code ?? null,
        head_teacher_name: row.head_teacher_name ?? null,
        fee_type: part.feeType,
        amount: part.amount,
        bill_date: payDate,
        // ★ 2026-10-26 餐费/住宿/保险的到期日（其他费用为 null）
        expire_date: expireDate,
        operator_id: operator.userId,
        operator_name: operator.userName,
        voucher_no: row.voucher_no ?? null,
        pay_method: null,
        /**
         * ★ 2026-10-27 备注拆到「各自那一栏」
         *
         * 补费单原来的备注是「学费…/住宿费…/餐费…/保险费…」一长串，
         * 拆账后每一栏都挂着同一段长文，财务在住宿费栏看到学费的事。
         * 现在每栏只写自己那一项（「补费分项 2/4｜住宿费 ¥2700.00（6 个月）」）。
         */
        remark:
          remark ??
          (part.text
            ? `补费分项 ${i + 1}/${parts.length}｜${part.text}`
            : `缴费核对入账（${FEE_TYPE_NAME[part.feeType] || ''}）` +
              (parts.length > 1 ? ` · 合并单分项 ${i + 1}/${parts.length}` : '')) +
            (row.voucher_url ? '' : ' · 无电子凭证（现金/线下收款）'),
      });
    }

    // ---- 回写缴费单 ----
    await t(FEE_TABLE).where({ id }).update({
      pay_status: PayStatus.VERIFIED,
      is_verified: true,
      verified_by: operator.userId,
      verified_by_name: operator.userName,
      verified_time: now,
      is_rejected: false,
      reject_reason: null,
      is_in_bill: true,
      update_time: now,
      update_by: operator.userId,
    });

    /**
     * ★ 2026-10-21 回写咨询侧收款单（财务核对 → 咨询「已到账」）
     *
     * 背景（E2E 实测发现的 P0 缺陷）：核对成功只改了财务侧，
     *   咨询侧收款单永远停在「待财务确认」→ 分班入档的前置校验
     *   （consult 单 status=ARRIVED）永远不满足，「缴费→分班」主链路断裂。
     *
     * 做法：两个库在同一个服务进程、同一个 MySQL 实例、同一个连接里，
     *   直接用全限定名更新 sms_consult（与教务 sms_edu 跨库同一套路）。
     *   按 finance_fee_id 反查（不是 consult_student_id）—— 一张财务单
     *   只对应一张咨询单，反查最准；查不到（非咨询来源）时静默跳过。
     */
    await t('sms_consult.t_consult_fee_order')
      .where({ finance_fee_id: id })
      .update({
        status: ConsultFeeStatus.ARRIVED,
        update_time: now,
        update_by: operator.userId,
      });

    return billNo;
  };

  // 支持外部传入事务（批量核对时共用一个事务）
  const billNo = trx ? await run(trx) : await db.transaction(run);

  /**
   * ★ 2026-10-22 立刻回推咨询侧（推进学生状态 + 同步教学学籍）
   *
   * 必须放在事务【外】：咨询侧处理时会回查财务单的 pay_status，
   * 事务还没提交的话它读到旧值，会被判成「还没核对」而不推进。
   *
   * 非阻断：核对已经入账成功，回推失败最多让状态晚一点推进（列表刷新会补），
   * 不能因此把已经核好的账回滚。
   */
  await notifyConsultFeeArrived(id);

  return billNo;
}

/**
 * 回推咨询侧「这张缴费单已到账」
 *
 * 走内部令牌通道（财务侧没有咨询岗位的登录态）。
 * 对方按 financeFeeId 反查收款单 → 推进学生状态 → 补学费时同步教学学籍为「正式在读」。
 */
async function notifyConsultFeeArrived(financeFeeId: string): Promise<void> {
  try {
    const token = String(process.env.INTERNAL_TOKEN || '');
    if (!token) return; // 没配内部令牌就当没这回事，不要让核对报错
    await remotePost(
      'consult',
      '/api/consult/student/internal/fee-arrived',
      { financeFeeId },
      { headers: { 'x-internal-token': token }, timeout: 8000 },
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[finance→consult] 到账回推失败（不影响核对，列表刷新会补）：${(e as Error).message}`);
  }
}

/** 财务打回（凭证有问题，退回班主任重新上传） */
export async function rejectFee(
  id: string,
  rejectReason: string,
  operator: { userId: string; userName: string },
): Promise<void> {
  const row = await db(FEE_TABLE).where({ id, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.PARAM_ERROR, '缴费单不存在或已被删除');
  }
  if (row.is_verified) {
    throw new BizError(BizCode.PARAM_ERROR, '该缴费单已核对入账，无法打回');
  }
  if (!rejectReason || !rejectReason.trim()) {
    throw new BizError(BizCode.REQUIRED_FIELD_MISSING, '打回原因必填');
  }

  await db(FEE_TABLE).where({ id }).update({
    // 打回后退回「已缴」，等班主任重新上传凭证
    pay_status: PayStatus.PAID,
    is_rejected: true,
    reject_reason: rejectReason.trim(),
    is_verified: false,
    update_time: new Date(),
    update_by: operator.userId,
  });

  // ★ 2026-10-21 同步咨询侧为「已驳回」（与 verifyFee 的回写对称，非咨询来源时静默跳过）
  await db('sms_consult.t_consult_fee_order')
    .where({ finance_fee_id: id })
    .update({ status: ConsultFeeStatus.REJECTED, update_time: new Date(), update_by: operator.userId });
}

/**
 * 批量核对
 *
 * ⚠️ 用「一个事务包住全部」还是「每条一个事务」？
 *    这里选【每条一个事务】：某一条失败不影响其他条，
 *    最后返回成功条数，体验上比「一条不合法就全不干」更好。
 */
export async function batchVerifyFee(
  ids: string[],
  operator: { userId: string; userName: string },
): Promise<{ successCount: number; billNos: string[]; failed: { id: string; reason: string }[] }> {
  const billNos: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const id of ids) {
    try {
      const billNo = await verifyFee(id, operator);
      billNos.push(billNo);
    } catch (e: any) {
      failed.push({ id, reason: e?.message || '核对失败' });
    }
  }

  return { successCount: billNos.length, billNos, failed };
}

/**
 * 同步学生状态到缴费单（跨模块调用时用）
 *
 * 场景：学生休学 → 未缴/已缴但未核对的餐费、住宿费 → 置为「冻结」
 *      学生复学 → 冻结中的 → 恢复为原状态（这里统一恢复为「待缴」）
 */
export async function freezeFeeByStudent(
  studentId: string,
  frozen: boolean,
  operator: { userId: string; userName: string },
): Promise<number> {
  const now = new Date();

  if (frozen) {
    const affected = await db(FEE_TABLE)
      .where({ student_id: studentId, is_deleted: false })
      .whereIn('fee_type', [FeeType.ACCOMMODATION, FeeType.MEAL])
      .whereIn('pay_status', [PayStatus.UNPAID, PayStatus.PAID])
      .update({
        pay_status: PayStatus.FROZEN,
        update_time: now,
        update_by: operator.userId,
      });
    return Number(affected) || 0;
  }

  const affected = await db(FEE_TABLE)
    .where({ student_id: studentId, is_deleted: false, pay_status: PayStatus.FROZEN })
    .whereIn('fee_type', [FeeType.ACCOMMODATION, FeeType.MEAL])
    .update({
      pay_status: PayStatus.UNPAID,
      update_time: now,
      update_by: operator.userId,
    });
  return Number(affected) || 0;
}

/** 学生是否存在（跨模块拉数据失败时的兜底：允许手工传学生快照） */
export async function studentExists(studentId: string): Promise<boolean> {
  try {
    const row = await db('t_student_base').where({ id: studentId, is_deleted: false }).first('id');
    return !!row;
  } catch {
    // t_student_base 是示例表，没有也不该阻塞财务模块
    return true;
  }
}

/* ============================================================
 * 规则校验（用户定的规则2、3）
 * ============================================================ */

/**
 * 【规则3-①】校验来源模块是否和费用类型匹配
 *
 * 规则：咨询模块 → 试学费 / 正式学费；教务模块 → 餐费 / 住宿费 / 保险费
 *
 * 不传 sourceModule 时按映射表自动推断（默认信任上游），
 * 传了但和费用类型对不上就拒绝 —— 防止上游标错来源导致对账错乱。
 */
export function resolveSourceModule(
  feeType: number,
  given?: number,
): number {
  const expected = expectedSourceOf(feeType);
  if (!expected) return given ?? SourceModule.FINANCE;

  if (given == null) return expected;   // 没传 → 按规则推断

  if (Number(given) !== expected) {
    throw new BizError(
      BizCode.SOURCE_MODULE_MISMATCH,
      `${FEE_TYPE_NAME[feeType] || '该费用'}应由「${SOURCE_MODULE_NAME[expected]}」发起，` +
        `不能标成「${SOURCE_MODULE_NAME[given] || '未知来源'}」`,
    );
  }
  return Number(given);
}

/**
 * 【规则3-②】校验凭证能否使用
 *
 * 规则：餐费可以多人共用一张凭证；其他费用（学费/住宿费/保险费/试学费）一人一张。
 *
 * 实现：非可复用类型下，查同一 voucher_url 是否已被别的单据占用，
 *      占用就报错并告诉对方「被谁的什么费用占用了」，方便上游直接定位。
 *
 * ★ 2026-10-15 用户口径补充（重要）：
 *    正式学费改成「一次勾选六项」（学费/住宿费/押金/保险/餐费/校服）后，
 *    家长通常【一笔转账】，自然也只有【一张截图】，
 *    但这张图要挂到同一个学生的 6 张单据上 —— 若按「一人一张」拦，第二张起必失败。
 *
 *    所以规则细化为：「同一学生自己的多张单据允许共用一张凭证」，
 *    「跨学生」（同一张图贴给张三又贴给李四）仍然严格禁止 ——
 *    这才是「一人一张凭证」真正要防的事（防止多个学生共用一张费用截图一票多报）。
 *
 * @param excludeId 编辑场景下要排除自己
 * @param studentNo 当前单据所属学生的学号；传了则允许同一学生跨单据共用
 */
export async function assertVoucherAvailable(
  feeType: number,
  voucherUrl: string | undefined | null,
  excludeId?: string,
  studentNo?: string,
  studentId?: string,
): Promise<void> {
  if (!voucherUrl) return;                    // 没传凭证，不用校验
  if (isVoucherReusable(feeType)) return;     // 餐费：允许共用

  const q = db(FEE_TABLE)
    .where({ voucher_url: voucherUrl, is_deleted: false });
  if (excludeId) q.whereNot('id', excludeId);

  const occupied = await q.first();
  if (!occupied) return;

  // ★ 同一学生的多张单据共用一张转账截图：允许（2026-10-15 规则细化）
  //   学号可能为空（咨询阶段学生还没正式学号），所以再用 student_id 兜一次底
  if (studentNo && occupied.student_no && occupied.student_no === studentNo) {
    return;
  }
  if (studentId && occupied.student_id && occupied.student_id === studentId) {
    return;
  }

  throw new BizError(
    BizCode.VOUCHER_DUPLICATED,
    `该凭证已被「${occupied.student_name}」的${FEE_TYPE_NAME[occupied.fee_type] || '费用'}占用` +
      `（单据 ${occupied.id.slice(0, 8)}）。` +
      `${FEE_TYPE_NAME[feeType] || '该费用'}不允许不同学生共用一张凭证，请更换凭证或联系被占用的学生处理。`,
  );
}

/**
 * 查询同一张凭证还被哪些单据共用（餐费场景下展示用）
 */
export async function findVoucherSharers(
  voucherUrl: string | undefined,
  excludeId?: string,
) {
  if (!voucherUrl) return [];
  const q = db(FEE_TABLE).where({ voucher_url: voucherUrl, is_deleted: false });
  if (excludeId) q.whereNot('id', excludeId);
  const rows = await q.select('id', 'student_name', 'student_no', 'fee_type');
  return rows.map((r: any) => ({
    id: r.id,
    studentName: r.student_name,
    // ★ 2026-10-22 与列表同口径：未分班的 ZX 临时号不展示（前端显示「—」）
    studentNo: isTempStudentNo(r.student_no) ? '' : r.student_no,
    feeTypeName: FEE_TYPE_NAME[r.fee_type] || '',
  }));
}

/* ============================================================
 * ★ 2026-10-19 凭证覆盖范围（一次转账 = 多张单据）
 * ============================================================ */

/**
 * 批量统计「每张凭证覆盖了几笔单据、合计多少钱」
 *
 * 业务背景（用户反馈「缴费凭证和实缴金额对不上」）：
 *   一次缴清多项费用时，家长只转一笔钱、只给一张截图，截图要挂到
 *   学费/住宿费/押金/保险费/餐费/校服多张单据上。
 *   每张单据的 amount 只是其中一项，凭证截图却是合计 ——
 *   财务单看一行，就会觉得「凭证金额 ≠ 本单金额，数据错了」。
 *
 * 所以列表里一次性把这批凭证的「笔数 + 合计」查出来，
 * 前端就能在凭证列显示「共 N 笔 · 合计 ¥X」，把一对多关系讲明白。
 *
 * @param voucherUrls 本页出现过的凭证地址（去重后传入，避免 N+1）
 * @returns Map<凭证地址, { count: 单据笔数, amount: 合计金额（分） }>
 *
 * ⚠️ 口径说明：统计包含冻结单与已核对单 —— 它们同样是「这张凭证覆盖的钱」，
 *    排除掉反而会让合计对不上截图。is_deleted 仍然排除（已删单不算）。
 */
export async function voucherGroupMap(
  voucherUrls: Array<string | null | undefined>,
): Promise<Map<string, { count: number; amount: number }>> {
  const urls = [...new Set(voucherUrls.filter(Boolean) as string[])];
  const map = new Map<string, { count: number; amount: number }>();
  if (!urls.length) return map;

  const rows = await db(FEE_TABLE)
    .where({ is_deleted: false })
    .whereIn('voucher_url', urls)
    .select('voucher_url')
    .select(knexRaw.raw('COUNT(*) as cnt'), knexRaw.raw('COALESCE(SUM(amount), 0) as total'))
    .groupBy('voucher_url');

  for (const r of rows as any[]) {
    map.set(String(r.voucher_url), {
      count: Number(r.cnt) || 0,
      amount: Number(r.total) || 0,
    });
  }
  return map;
}

/** 单张凭证的覆盖范围（详情页用；没有凭证时返回 0/0） */
export async function voucherGroupOf(
  voucherUrl: string | null | undefined,
): Promise<{ count: number; amount: number }> {
  const map = await voucherGroupMap([voucherUrl]);
  return map.get(String(voucherUrl)) || { count: 0, amount: 0 };
}

/**
 * 新增缴费单
 *
 * 会执行两条规则校验（用户定的规则2、3）：
 *   ① amount 不传 → 自动从「费用标准」取（规则2）
 *   ② sourceModule 校验（规则3-①）
 *   ③ voucherUrl 唯一性校验（规则3-②）
 */
/* ============================================================
 * ★ 2026-10-19 作废缴费单（上游发起错了 / 重复发起时撤销）
 * ============================================================ */

/**
 * 作废一张还没入账的缴费单（软删）
 *
 * 背景：
 *   上游模块（咨询）没有作废能力时，老师发现「多发起了一笔」只能再发起一次去覆盖，
 *   结果同一学生同一费用项堆出好几张单 —— 账面看起来像交了好几次钱。
 *   这里补上撤销通道：未核对入账的单可以作废，已入账的必须走退费。
 *
 * ⚠️ 只软删（is_deleted=1），保留流水痕迹；调用方（咨询）负责把本地单据一起作废。
 */
export async function cancelFee(
  id: string,
  reason: string,
  operator: { userId: string; userName: string },
): Promise<void> {
  const row = await db(FEE_TABLE).where({ id, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.PARAM_ERROR, '缴费单不存在或已被作废');
  }
  if (row.is_verified || row.is_in_bill) {
    throw new BizError(
      BizCode.INVALID_STATUS,
      '该缴费单已核对入账，不能作废；如需撤销请走「退费」流程',
    );
  }

  const note = reason?.trim() ? reason.trim() : '上游重复发起';
  await db(FEE_TABLE).where({ id }).update({
    is_deleted: true,
    update_time: new Date(),
    update_by: operator.userId,
    remark: [row.remark, `作废：${note}（${operator.userName}）`].filter(Boolean).join(' | '),
  });
}

export async function addFee(
  body: any,
  operator: { userId: string; userName: string },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  /**
   * ★ 2026-10-20：学生属性以学生档案为准（档案里能查到这个人时）
   *
   * 用户口径：「学生档案有的字段按学生档案的数据走」。
   * 上游（咨询/教务）传过来的姓名/班级可能是建单那一刻的快照，
   * 学生后来换班或改名就会脱节。只要档案里能对上（先按 id、再按学号），
   * 落库一律用档案当前值，不信任调用方传的那几个字段。
   *
   * ⚠️ 档案里查不到时**保持原样**：报名前的咨询收费单，学生还没进学籍档案，
   *    这是正常业务状态，不能因此拒绝建单。
   *
   * ★ 2026-10-22 用户口径：**学号不再自动填充**
   *   上游（咨询/教务）传什么学号就用什么，即使学生档案里能查到更新的学号，
   *   也不覆盖。财务单据的学号必须与上游建单一致，否则「单据学号」与
   *   「来源单学号」会对不上，对账时无法按学号回查。
   *   传空则落库为空串（见下面 insert 的 student_no），不做任何推断。
   */
  const archived = await findArchiveStudent(body.studentId, body.studentNo);
  if (archived) {
    if (archived.name) body.studentName = archived.name;
    if (archived.classId) body.classId = archived.classId;
    if (archived.className) body.className = archived.className;
    if (archived.deptCode != null) body.deptCode = archived.deptCode;
  }

  /* ---------- 规则2：金额没传就取财务标准 ---------- */
  let amount: number = body.amount;
  /**
   * ★ 2026-10-26 应缴金额（standard_amount）
   *
   * 用户口径：缴费管理要看到「应缴 / 实缴 / 优惠」三列（优惠 = 应缴 - 实缴）。
   * 取值优先级：调用方显式传 > 该部门该费用标准价 > 实缴金额（拿不到标准时视为无优惠）。
   * 历史单据已在迁移里回填成「应缴=实缴」，所以老数据优惠显示 0。
   */
  let standardAmount: number | null =
    body.standardAmount != null ? Number(body.standardAmount) : null;

  if (amount == null) {
    if (body.deptCode == null) {
      throw new BizError(
        BizCode.REQUIRED_FIELD_MISSING,
        '未传金额时，必须提供 deptCode 才能按费用标准取值',
      );
    }
    const std = await getStandard(body.feeType, body.deptCode);
    amount = std.amount;
    if (standardAmount == null) standardAmount = std.amount;
  } else if (standardAmount == null && body.deptCode != null) {
    // 传了实缴但没传应缴 → 按标准价补上。取不到标准就留 null（下面兜底成实缴）
    try {
      const std = await getStandard(body.feeType, body.deptCode);
      standardAmount = std.amount;
    } catch {
      standardAmount = null;
    }
  }

  /**
   * ★ 2026-10-26 合并单的应缴要按分项汇总，不能取「第一项的标准价」
   *
   * 一次缴学费 + 餐费 + 住宿时，`fee_type` 只是第一项（学费），
   * 拿它的标准价 26000 当应缴 → 实缴 27580 就显得「多交了 1580」，
   * 优惠被算成 0、应缴金额也失真。正确口径是各项应缴之和。
   */
  if (
    Array.isArray(body.itemDetail) &&
    body.itemDetail.length > 1 &&
    body.standardAmount == null
  ) {
    const sum = body.itemDetail.reduce(
      (s: number, it: any) => s + Number(it?.standardAmount ?? it?.amount ?? 0),
      0,
    );
    if (sum > 0) standardAmount = sum;
  }

  /* ---------- 规则3-①：来源模块校验 ---------- */
  const sourceModule = resolveSourceModule(body.feeType, body.sourceModule);

  /* ---------- 规则3-②：凭证唯一性校验 ---------- */
  // ★ 传 body.studentNo：同一学生的多张单据可共用一张转账截图（2026-10-15）
  await assertVoucherAvailable(body.feeType, body.voucherUrl, undefined, body.studentNo);

  /**
   * ⚠️ 状态与凭证一致性（2026-10-04 用户指令）
   *
   * 缴费管理的口径是「有凭证的单 = 财务待核对的单」。
   * 如果建单时就带了凭证，但状态还是「待缴」，就会出现
   * 「财务看得到这张单、却点不了核对」的中间态（历史踩过的坑，见 attachVoucher）。
   *
   * 所以这里统一推断：带了凭证 → 至少是「待核对(PAID)」，等财务核对后升级为「已缴(VERIFIED)」。
   * 只有「没带凭证」时才落回调用方传的 payStatus（默认待缴）。
   */
  const resolvedPayStatus: number = body.voucherUrl
    ? PayStatus.PAID
    : (body.payStatus ?? PayStatus.UNPAID);

  await db(FEE_TABLE).insert({
    id,
    create_time: now,
    create_by: operator.userId,
    is_deleted: false,
    student_id: body.studentId,
    student_no: body.studentNo ?? '',
    student_name: body.studentName,
    class_id: body.classId ?? null,
    class_name: body.className ?? null,
    dept_code: body.deptCode ?? null,
    head_teacher_id: body.headTeacherId ?? null,
    head_teacher_name: body.headTeacherName ?? null,
    fee_type: body.feeType,
    amount,
    // ★ 2026-10-26 应缴金额（拿不到标准/没传时视为无优惠，= 实缴）
    standard_amount: standardAmount ?? amount,
    source_module: sourceModule,
    pay_status: resolvedPayStatus,
    pay_date: body.payDate ?? (body.voucherUrl ? now : null),
    expire_date: body.expireDate ?? null,
    period: body.period ?? null,
    voucher_url: body.voucherUrl ?? null,
    voucher_no: body.voucherNo ?? null,
    voucher_by: body.voucherUrl ? operator.userId : null,
    voucher_time: body.voucherUrl ? now : null,
    is_verified: false,
    is_rejected: false,
    is_in_bill: false,
    remark: body.remark ?? null,
    /**
     * ★ 2026-10-19 合计单的分项明细
     *    上游（咨询）一次交多类费用时，只建一张「合计单」，
     *    金额 = 各项之和，各项明细存在这里，供财务看到「这笔钱包含什么」。
     *    单项单不传 → NULL。
     */
    item_detail:
      body.itemDetail == null
        ? null
        : typeof body.itemDetail === 'string'
          ? body.itemDetail
          : JSON.stringify(body.itemDetail),
  });

  return id;
}

/** 学生状态枚举的「休学」值（语义化，避免代码里裸写 6） */
export const SUSPENDED_STATUS = StudentStatus.SUSPENDED;

/* ============================================================
 * 上游模块回传凭证（规则3-②）
 * ============================================================ */

/**
 * ★ 2026-10-22 新增：上游「登记缴费」结果回写财务（催费页「批量上传到财务」用）
 *
 * 【为什么不能直接用 attachVoucher】
 *   attachVoucher 只有凭证一个参数：
 *     · 现金收的款**没有截图**（按业务规则可以不传），attachVoucher 没法调；
 *     · 实缴金额可能与应缴不同（部分缴），attachVoucher 不改金额；
 *     · 缴费方式在财务表里没有列，只能写进 remark。
 *   用户原话：「主要就是把上传缴费凭证的人的凭证传到财务，财务更新凭证信息」——
 *   所以要一个能同时吃「凭证 + 方式 + 实缴 + 日期」的入口。
 *
 * 【更新哪些字段】
 *   voucher_url       有凭证才写（现金没截图时**不动**原凭证，不能把它清空）
 *   voucher_by/time   有凭证才写
 *   pay_status        未结清(待缴/逾期) → 已缴(PAID，等财务核对)；已核对/冻结不动
 *   pay_date          传了才写
 *   remark            追加一行「方式·实缴·缴费日」，保留原有备注（财务核对时看得出钱怎么收的）
 *
 * ⚠️ 与 attachVoucher 一致的两条保护：
 *   · 已核对且已有凭证 → 拒绝改图（要改先让财务打回）；
 *   · 同一张凭证的复用规则走 assertVoucherAvailable。
 *
 * @returns 更新后的财务单 id（调用方用它记「已转交」）
 */
export async function syncPaymentFromUpstream(
  feeId: string,
  body: {
    voucherUrl?: string | null;
    payMethodName?: string | null;
    paidAmount?: number | null;
    payDate?: string | null;
    remark?: string | null;
  },
  operator: { userId: string; userName: string },
): Promise<string> {
  const row = await db(FEE_TABLE).where({ id: feeId, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.FEE_NOT_FOUND, `缴费单 ${feeId} 不存在`);
  }

  const voucherUrl = body.voucherUrl ? String(body.voucherUrl) : '';

  if (voucherUrl && row.is_verified && row.voucher_url) {
    throw new BizError(
      BizCode.INVALID_STATUS,
      '该缴费单已核对通过，如需修改凭证请先在财务侧「打回」',
    );
  }
  if (voucherUrl) {
    await assertVoucherAvailable(row.fee_type, voucherUrl, feeId, row.student_no, row.student_id);
  }

  /** 「方式 · 实缴 X 元 · 缴费日 Y」——财务核对时一眼看出这笔钱怎么收的 */
  const parts: string[] = [];
  if (body.payMethodName) parts.push(String(body.payMethodName));
  if (body.paidAmount != null) parts.push(`实缴 ${(Number(body.paidAmount) / 100).toFixed(2)} 元`);
  if (body.payDate) parts.push(`缴费日 ${body.payDate}`);
  if (body.remark) parts.push(String(body.remark));
  const note = parts.length ? `【教学侧登记】${parts.join(' · ')}` : '';
  const oldRemark = String(row.remark || '');
  const remark = note ? (oldRemark ? `${oldRemark}\n${note}` : note) : oldRemark || null;

  const patch: Record<string, any> = {
    remark,
    // 未结清 → 已缴（等财务核对）；已核对 / 冻结 不动
    pay_status:
      Number(row.pay_status) === PayStatus.VERIFIED || Number(row.pay_status) === PayStatus.FROZEN
        ? Number(row.pay_status)
        : PayStatus.PAID,
  };
  if (voucherUrl) {
    patch.voucher_url = voucherUrl;
    patch.voucher_by = operator.userId;
    patch.voucher_time = new Date();
    patch.is_rejected = false;
    patch.reject_reason = null;
  }
  if (body.payDate) patch.pay_date = body.payDate;

  await db(FEE_TABLE).where({ id: feeId }).update(patch);
  return String(row.id);
}

/**
 * 上游回传凭证（原接口，只传凭证、不传金额/方式）
 *
 * 业务背景：
 *   上游模块（咨询/教务）建单时往往还没拿到缴费截图，学生是「先建单 → 再交钱 → 再上传」。
 *   所以上游上传截图后，需要把凭证回传到财务侧，财务才能核对。
 *
 * ⚠️ 会重新执行凭证唯一性校验（规则3-②）：
 *    非餐费类型下，同一张凭证不能挂在多条单据上。
 *
 * @returns 是否成功更新
 */
export async function attachVoucher(
  feeId: string,
  voucherUrl: string,
  voucherNo: string | undefined,
  operator: { userId: string; userName: string },
): Promise<void> {
  const row = await db(FEE_TABLE).where({ id: feeId, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.FEE_NOT_FOUND, `缴费单 ${feeId} 不存在`);
  }

  // 已核对/已入账单：已有凭证时不允许再改（账已核对，防止事后换图）；
  // 但缺凭证的历史单允许补传，否则「缴费单后边的凭证都得能查看」永远补不齐。
  if (row.is_verified && row.voucher_url) {
    throw new BizError(
      BizCode.INVALID_STATUS,
      '该缴费单已核对通过，如需修改凭证请先在财务侧「打回」',
    );
  }

  // 规则3-②：重新校验凭证唯一性（换凭证时排除自己）
  // ★ 传 student_no + student_id：同一学生的多张单据可共用一张转账截图（2026-10-15）
  await assertVoucherAvailable(row.fee_type, voucherUrl, feeId, row.student_no, row.student_id);

  await db(FEE_TABLE).where({ id: feeId }).update({
    voucher_url: voucherUrl,
    voucher_no: voucherNo ?? null,
    voucher_by: operator.userId,
    voucher_time: new Date(),
    is_rejected: false,
    reject_reason: null,
    // 传了凭证 → 状态推到「待核对(PAID)」，等财务核对后才是「已缴(VERIFIED)」
    // ⚠️ 只把「待缴」这类未收款状态往上推，不动已核对/已入账的单
    pay_status: row.pay_status === PayStatus.UNPAID ? PayStatus.PAID : row.pay_status,
  });
}
