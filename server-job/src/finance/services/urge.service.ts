/**
 * 财务 · 催费提醒（2026-10-26）
 * ============================================================
 *
 * 【规则变更】
 *   原来：教学侧按 `t_class_fee.expire_date` + 20 天窗口判断要不要催。
 *   现在（用户口径）：**以财务账单的到期日为准**，只管「餐费 / 住宿费 / 保险费」
 *   这三类有到期概念的费用 —— 学费/押金/校服没有到期日，不催。
 *
 *   到期日从哪来：财务核对入账时按「缴费金额 ÷ 该费用标准」算出来的
 *   （见 fee.service.ts 的 calcExpireDate，续费会自动接续）。
 *
 * 【判定】
 *   · 每个「学生 × 费用类型」只看**最晚的那笔到期日**（= 当前有效期到哪天）
 *   · 剩余天数 = 到期日 - 今天
 *   · 剩余 ≤ urgeAheadDays（默认 15，可在「费用标准 → 催费设置」里改）→ 进催费名单
 *   · 已逾期（剩余 < 0）照常进，越逾期越该催
 *
 * 【为什么实时查】
 *   用户明确要求「实时查财务库」。财务核对后到期日立刻可见，不需要等同步任务。
 */

import { db } from '../utils/db';
import { FeeType, FEE_TYPE_NAME } from 'shared-types/finance';
import { toDateStr } from './fee.service';
import { computeExpireDate, EXPIRE_FEE_TYPES } from './expire';

/** 财务配置表（KV） */
const SETTING_TABLE = 't_finance_setting';
const BILL_TABLE = 't_finance_bill';

/** 参与催费提醒的费用类型：餐费 / 住宿费 / 保险费 */
export const URGE_FEE_TYPES: number[] = EXPIRE_FEE_TYPES;

/** 默认提前天数 */
export const DEFAULT_AHEAD_DAYS = 15;

/** 读催费提前天数（缺失/非法 → 默认 15） */
export async function getUrgeAheadDays(): Promise<number> {
  try {
    const row = await db(SETTING_TABLE).where({ setting_key: 'urgeAheadDays' }).first();
    const n = Number(row?.setting_value);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AHEAD_DAYS;
  } catch {
    return DEFAULT_AHEAD_DAYS;
  }
}

/** 写催费提前天数（0~365） */
export async function saveUrgeAheadDays(days: number, operatorName?: string): Promise<number> {
  const n = Math.max(0, Math.min(365, Math.round(Number(days) || 0)));
  const exist = await db(SETTING_TABLE).where({ setting_key: 'urgeAheadDays' }).first();
  const payload = {
    setting_value: String(n),
    update_time: new Date(),
    update_by: operatorName ?? null,
  };
  if (exist) {
    await db(SETTING_TABLE).where({ setting_key: 'urgeAheadDays' }).update(payload);
  } else {
    await db(SETTING_TABLE).insert({ setting_key: 'urgeAheadDays', ...payload });
  }
  return n;
}

/** 今天零点的时间戳 */
function todayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 两个 YYYY-MM-DD 之间的天数差（to - from，按自然日） */
function diffDays(fromMs: number, toStr: string): number {
  const d = new Date(String(toStr).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return 0;
  return Math.round((d.getTime() - fromMs) / 86400000);
}

export interface UrgeRow {
  studentId: string;
  studentNo: string;
  studentName: string;
  classId?: string;
  className?: string;
  deptCode?: number;
  deptName?: string;
  feeType: number;
  feeTypeName: string;
  /** 当前有效期截止日（该生该费用最晚的一笔） */
  expireDate: string;
  /** 剩余天数（负数=已逾期） */
  remainDays: number;
  /** 建议续费金额（该部门该费用标准价，分） */
  suggestAmount?: number;
  /** 最近一次缴费日期 */
  latestPayDate?: string;
}

/**
 * ★ 2026-10-26 回填历史账单的到期日
 *
 * 【为什么需要】到期日原本只在「财务核对入账」那一刻算一次
 *   （`fee.service.verifyFee` → `calcExpireDate`）。这套逻辑是 2026-10-26 才上的，
 *   在此之前核对的账单 `expire_date` 全是 NULL；催费名单 `whereNotNull('expire_date')`
 *   一过滤 → **一条都不剩 → 页面整片「暂无数据」**（用户实测反馈的就是这个）。
 *
 * 【规则】与核对入账完全一致（`services/expire.ts`）：
 *   按 学生×费用类型 把空到期日的账单按缴费日升序排队，
 *   逐笔 `到期日 = max(上笔到期日, 本笔缴费日) + 缴费金额÷标准价 个月`。
 *
 * 【缺标准就跳过，不瞎算】标准价 <= 0（比如就业部还没配住宿费标准）时留空，
 *   并把 (费用类型, 部门) 记进 `missing`，由调用方决定怎么提示。
 *
 * 【幂等】只处理 `expire_date IS NULL` 的行，重复跑不会改已有值。
 */
export async function backfillExpireDates(): Promise<{
  filled: number;
  skipped: number;
  missing: Array<{ feeType: number; deptCode: number }>;
}> {
  const empty = (await db(BILL_TABLE)
    .where({ is_deleted: false, bill_type: 1 })
    .whereIn('fee_type', URGE_FEE_TYPES)
    .whereNull('expire_date')
    .select('id', 'student_id', 'fee_type', 'dept_code', 'amount', 'bill_date')
    .orderBy([
      { column: 'student_id', order: 'asc' },
      { column: 'fee_type', order: 'asc' },
      { column: 'bill_date', order: 'asc' },
    ])) as any[];

  const missing: Array<{ feeType: number; deptCode: number }> = [];
  if (!empty.length) return { filled: 0, skipped: 0, missing };

  // 标准价：只认「未删除 + 已启用」（与 getStandard 的校验口径一致）
  const stdRows = (await db('t_finance_fee_standard')
    .where({ is_deleted: false, is_enabled: true })
    .whereIn('fee_type', URGE_FEE_TYPES)
    .select('fee_type', 'dept_code', 'amount')) as any[];
  const stdMap = new Map<string, number>();
  for (const s of stdRows) {
    stdMap.set(`${Number(s.fee_type)}-${Number(s.dept_code)}`, Number(s.amount) || 0);
  }

  // 已到期账单里「该生该费用」的最晚到期日 —— 续费从这里接
  const prevRows = (await db(BILL_TABLE)
    .where({ is_deleted: false, bill_type: 1 })
    .whereIn('fee_type', URGE_FEE_TYPES)
    .whereNotNull('expire_date')
    .groupBy('student_id', 'fee_type')
    .select('student_id', 'fee_type')
    .max({ d: 'expire_date' })) as any[];
  const prevMap = new Map<string, string>();
  for (const p of prevRows) {
    const d = toDateStr(p.d);
    if (d) prevMap.set(`${p.student_id}::${p.fee_type}`, d);
  }

  const today = toDateStr(new Date())!;
  let filled = 0;
  let skipped = 0;
  const missingKeys = new Set<string>();

  for (const r of empty) {
    const feeType = Number(r.fee_type);
    const deptCode = Number(r.dept_code ?? 1);
    const std = stdMap.get(`${feeType}-${deptCode}`) ?? 0;
    const payDate = toDateStr(r.bill_date) || today;
    const key = `${r.student_id}::${feeType}`;

    const exp = computeExpireDate({
      feeType,
      amount: Number(r.amount) || 0,
      payDate,
      stdAmount: std,
      prevExpire: prevMap.get(key),
    });

    if (!exp) {
      skipped++;
      const mk = `${feeType}-${deptCode}`;
      if (!missingKeys.has(mk)) {
        missingKeys.add(mk);
        missing.push({ feeType, deptCode });
      }
      continue;
    }

    await db(BILL_TABLE).where({ id: r.id }).update({ expire_date: exp });
    prevMap.set(key, exp);
    filled++;
  }

  if (filled || skipped) {
    console.log(
      `[urge] 回填账单到期日：补齐 ${filled} 条，跳过 ${skipped} 条` +
        (missing.length
          ? `（缺费用标准：${missing
              .map((m) => `${FEE_TYPE_NAME[m.feeType] || m.feeType}/部门${m.deptCode}`)
              .join('、')}）`
          : ''),
    );
  }
  return { filled, skipped, missing };
}

/**
 * 读侧兜底：进入催费名单前先确保历史账单都有到期日
 *
 * 节流 60 秒（催费页三个部门 + 徽标各调一次列表，不能每次都全表扫）。
 * 失败绝不影响列表本身 —— 它只是「让老数据也能出现在名单里」的补偿手段。
 */
let lastEnsureAt = 0;
let ensurePromise: Promise<void> | null = null;
const ENSURE_INTERVAL_MS = 60_000;

export async function ensureExpireDates(): Promise<void> {
  // 并发请求（页面 + 徽标同时进来）共享同一次回填，避免第二个请求读到「还没补完」的空名单
  if (ensurePromise) return ensurePromise;
  if (Date.now() - lastEnsureAt < ENSURE_INTERVAL_MS) return;

  ensurePromise = (async () => {
    try {
      await backfillExpireDates();
    } catch (e: any) {
      console.warn('[urge] 回填到期日失败（不影响名单查询）：', e?.message || e);
    } finally {
      lastEnsureAt = Date.now();
      ensurePromise = null;
    }
  })();
  return ensurePromise;
}

/**
 * 催费名单：按账单到期日筛出「快到期 / 已逾期」的学生
 *
 * @param aheadDays 提前天数（默认取配置）
 * @param q         可选筛选（班级/关键字/费用类型）
 */
export async function listUrgeByExpire(
  aheadDays: number,
  q: { className?: string; keyword?: string; feeType?: number; deptCode?: number } = {},
): Promise<{ rows: UrgeRow[]; total: number; aheadDays: number }> {
  // ★ 历史账单（核对时还没有到期日逻辑的那批）先补上，否则名单永远是空的
  await ensureExpireDates();

  const base = db(BILL_TABLE)
    .where({ bill_type: 1, is_deleted: false })
    .whereIn('fee_type', URGE_FEE_TYPES)
    .whereNotNull('expire_date');

  if (q.feeType) base.where('fee_type', Number(q.feeType));
  if (q.deptCode) base.where('dept_code', Number(q.deptCode));
  if (q.className) base.where('class_name', q.className);
  if (q.keyword) {
    const kw = `%${q.keyword}%`;
    base.andWhere((b) => {
      b.where('student_name', 'like', kw).orWhere('student_no', 'like', kw);
    });
  }

  // 每个「学生 × 费用类型」取最晚到期日 + 最近缴费日
  const grouped = await base
    .groupBy('student_id', 'fee_type')
    .select('student_id', 'fee_type')
    .max({ expire_date: 'expire_date', bill_date: 'bill_date' })
    .select(
      db.raw('MAX(student_no) as student_no'),
      db.raw('MAX(student_name) as student_name'),
      db.raw('MAX(class_id) as class_id'),
      db.raw('MAX(class_name) as class_name'),
      db.raw('MAX(dept_code) as dept_code'),
    );

  const t0 = todayStart();
  const rows: UrgeRow[] = [];
  for (const g of grouped as any[]) {
    const exp = toDateStr(g.expire_date);
    if (!exp) continue;
    const remain = diffDays(t0, exp);
    // 只保留「剩余 ≤ 提前天数」的（含负数=逾期）
    if (remain > aheadDays) continue;
    const feeType = Number(g.fee_type);
    rows.push({
      studentId: String(g.student_id),
      studentNo: String(g.student_no ?? ''),
      studentName: String(g.student_name ?? ''),
      classId: g.class_id ?? undefined,
      className: g.class_name ?? undefined,
      deptCode: g.dept_code ?? undefined,
      feeType,
      feeTypeName: FEE_TYPE_NAME[feeType] || '',
      expireDate: exp,
      remainDays: remain,
      latestPayDate: g.bill_date ? toDateStr(g.bill_date) : undefined,
    });
  }

  // 排序：逾期最久 → 快到期
  rows.sort((a, b) => a.remainDays - b.remainDays);

  // 建议续费金额：按部门+类型取标准价（一次性查完，逐行填）
  try {
    const standards = await db('t_finance_fee_standard')
      .where({ is_deleted: false })
      .whereIn('fee_type', URGE_FEE_TYPES)
      .select('fee_type', 'dept_code', 'amount');
    const key = (t: number, d?: number | null) => `${t}-${d ?? ''}`;
    const map = new Map<string, number>();
    for (const s of standards as any[]) {
      map.set(key(Number(s.fee_type), s.dept_code), Number(s.amount) || 0);
    }
    for (const r of rows) {
      r.suggestAmount = map.get(key(r.feeType, r.deptCode)) ?? undefined;
    }
  } catch {
    /* 标准取不到不影响名单本身 */
  }

  return { rows, total: rows.length, aheadDays };
}
