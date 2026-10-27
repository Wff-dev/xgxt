/**
 * 财务 · 账单到期日计算（2026-10-26 抽公共）
 * ============================================================
 *
 * 【业务口径】只对「有到期概念」的三类费用算到期日：
 *   · 住宿费 / 餐费 → 标准价是**月费**，缴 N 个标准价 = N 个月
 *   · 保险费       → 标准价是**年费**，缴 N 个标准价 = N 年
 *   · 学费 / 试学费 / 押金 / 校服 / 补费 → 无到期概念，返回 null
 *
 * 【起点】从「本次缴费日」（财务核对日）算；若该生该费用还有未到期的余量，
 *   从上次到期日往后接 —— 续费不重叠、不回退。
 *
 * ⚠️ 为什么抽成公共函数：
 *   同一套规则有三个使用场景，之前只在 `fee.service.calcExpireDate`（核对入账时算）
 *   里实现了一份，导致**历史账单的到期日永远是空的** —— 催费名单
 *   (`urge.service.listUrgeByExpire`) 只认 `expire_date`，于是整页「暂无数据」。
 *   抽出来之后：核对入账、存量回填、读侧兜底 走同一份规则，不会再两套口径。
 */

import { FeeType } from 'shared-types/finance';
import { addMonths } from '../utils/dateMath';

/** 该费用类型的计价单位：M=月 / Y=年 / null=没有到期概念 */
export function expireUnitOf(feeType: number): 'M' | 'Y' | null {
  const t = Number(feeType);
  if (t === FeeType.MEAL || t === FeeType.ACCOMMODATION) return 'M';
  if (t === FeeType.INSURANCE) return 'Y';
  return null;
}

/** 参与到期日 / 催费的三类费用（对外复用，避免各模块各写一份） */
export const EXPIRE_FEE_TYPES: number[] = [
  FeeType.MEAL,
  FeeType.ACCOMMODATION,
  FeeType.INSURANCE,
];

/**
 * 由「缴费金额 ÷ 标准价」推到期日
 *
 * @param feeType   费用类型
 * @param amount    本次实缴金额（分）
 * @param payDate   本次缴费日 YYYY-MM-DD
 * @param stdAmount 该部门该费用标准价（分）；<=0 视为没配置 → 返回 null（不瞎算）
 * @param prevExpire 该生该费用「已入账」的最晚到期日（续费接续用）
 * @param months    ★ 2026-10-27 已知周期（**月**），给了就直接用，不再反推
 *                  （补费是「按 N 个月补」，老师填的月数就是准的；标准价改过以后
 *                   「金额÷标准价」会算错月份，所以有明确月数时以月数为准。
 *                   保险费按年填的，调用方先折算成月再传进来。）
 */
export function computeExpireDate(opts: {
  feeType: number;
  amount: number;
  payDate: string;
  stdAmount: number;
  prevExpire?: string | null;
  months?: number | null;
}): string | null {
  const unit = expireUnitOf(opts.feeType);
  if (!unit) return null;

  const hint = Number(opts.months) || 0;
  let months: number;
  if (hint > 0) {
    // 知道确切补了几个月 → 直接用（标准价没配也照样能算出来）
    months = hint;
  } else {
    const std = Number(opts.stdAmount) || 0;
    if (std <= 0) return null;

    const paid = Number(opts.amount) || 0;
    // 缴了钱至少给一个周期（优惠后不足一个标准价时，不能让到期日不动）
    let units = Math.floor(paid / std);
    if (units < 1) units = 1;
    months = unit === 'Y' ? units * 12 : units;
  }

  const payDate = String(opts.payDate || '').slice(0, 10);
  if (!payDate) return null;

  const prev = opts.prevExpire ? String(opts.prevExpire).slice(0, 10) : '';
  const base = prev && prev > payDate ? prev : payDate;
  return addMonths(base, months);
}
