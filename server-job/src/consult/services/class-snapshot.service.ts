/**
 * 班级快照回写（分班后补历史单据）
 *
 * ============================================================
 * 【解决什么问题】
 *   收款单 / 财务缴费单 / 财务账单里的 `class_name` 都是**建单那一刻的快照**。
 *   分班（班主任接收建档）只回写 `t_consult_student`，历史单据一个字段都不会变 ——
 *   于是分班前建的试学费单，在「收款与缴费」「缴费管理」里永远显示「未分班」。
 *
 *   用户 2026-10-27 实测：金牙好已 LZQ19001 / Q19、状态正式在读，
 *   但 SK20261026-004 那张单的 class_name 还是 NULL。
 *
 * 【口径：只补空，不覆盖】（方案 A —— 用户 2026-10-27 拍板）
 *   · 只更新 `class_name IS NULL OR class_name = ''` 的行；
 *   · 已有班级的历史单据保持原样 —— 那是当时的对账快照，转班后也不该被冲掉；
 *   · 因此本函数**幂等**：重复调用不会产生额外变化。
 *
 * 【为什么把财务两张表也一起补】
 *   财务「缴费管理」的班级列和**筛选**（`q.className` 精确匹配 class_name）
 *   都读单据快照。只补咨询单不补财务单，财务那边依旧空白，
 *   而且会出现「筛 Q19 查不到、行上却显示 Q19」的矛盾 —— 所以一起补。
 *   ⚠️ 财务缴费单/账单的 `student_id` 存的是**咨询学生 id**（跨模块唯一关联键之一），
 *      不是学籍 id，这里按它匹配。
 *
 * 【调用时机】
 *   · 咨询端「分班」把班级记回学生表之后（routes/student.route.ts）
 *   · 班级侧接收建档回调 `receive-ack` 之后（routes/internal.route.ts）
 *   ⚠️ 调用方必须 try/catch —— 补快照失败不能影响分班本身。
 * ============================================================
 */

import { db } from '../utils/db';

export interface SnapshotSyncResult {
  orders: number;
  financeFees: number;
  financeBills: number;
}

/** 「空班级」条件：NULL 或空串都算没分班 */
function blankClass(qb: any) {
  return qb.where((w: any) => w.whereNull('class_name').orWhere('class_name', ''));
}

/**
 * 把某个咨询学生名下**还没记班级**的单据补上班级
 *
 * @param consultStudentId 咨询学生 id（sms_consult.t_consult_student.id）
 * @param className        班级名（如 Q19）；为空则直接跳过
 */
export async function syncClassSnapshot(
  consultStudentId: string,
  className?: string | null,
): Promise<SnapshotSyncResult> {
  const name = String(className || '').trim();
  const result: SnapshotSyncResult = { orders: 0, financeFees: 0, financeBills: 0 };
  if (!consultStudentId || !name) return result;

  /* ---------- 1. 咨询侧收款单 ---------- */
  try {
    const n = await blankClass(
      db('t_consult_fee_order').where({ consult_student_id: consultStudentId, is_deleted: false }),
    ).update({ class_name: name, update_time: new Date() });
    result.orders = Number(n) || 0;
  } catch (err) {
    console.warn('[class-snapshot] 收款单补班级失败', err);
  }

  /* ---------- 2. 财务缴费单 ---------- */
  try {
    const n = await blankClass(
      db('t_finance_fee').withSchema('sms_finance').where({ student_id: consultStudentId, is_deleted: false }),
    ).update({ class_name: name, update_time: new Date() });
    result.financeFees = Number(n) || 0;
  } catch (err) {
    console.warn('[class-snapshot] 财务缴费单补班级失败', err);
  }

  /* ---------- 3. 财务账单（已核对的缴费会产生账单，也是快照） ---------- */
  try {
    const n = await blankClass(
      db('t_finance_bill').withSchema('sms_finance').where({ student_id: consultStudentId, is_deleted: false }),
    ).update({ class_name: name, update_time: new Date() });
    result.financeBills = Number(n) || 0;
  } catch (err) {
    console.warn('[class-snapshot] 财务账单补班级失败', err);
  }

  if (result.orders || result.financeFees || result.financeBills) {
    // eslint-disable-next-line no-console
    console.log(
      `[class-snapshot] 学生 ${consultStudentId} 补班级「${name}」：` +
        `收款单 ${result.orders} / 财务单 ${result.financeFees} / 账单 ${result.financeBills}`,
    );
  }
  return result;
}
