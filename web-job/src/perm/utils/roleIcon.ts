/**
 * 职位图标（原型 ROLE_ICON）
 *
 * 原型的 ROLE_ICON 按【职位 id】取图标；开发版职位 id 是 UUID，
 * 所以改按角色标识（roleCode）对应。列表 / 弹窗 / 详情三处共用这一份，
 * 避免同一个映射表在多个 .vue 里各抄一遍、改一处漏一处。
 */

const ROLE_ICON_BY_CODE: Record<string, string> = {
  MKT_CONSULT: '📞',
  MKT_MANAGER: '📈',
  TEACH_HEAD: '🧑‍🏫',
  TEACH_TUTOR: '👨‍🏫',
  TEACH_ASSIST: '🧑‍💼',
  TEACH_QTY: '📊',
  ACAD_MANAGER: '🎓',
  TEACH_DEAN: '📋',
  ACAD_STAFF: '🗂️',
  FIN_STAFF: '💰',
  JOB_STAFF: '💼',
  RM_PROJECT: '📁',
  RM_PRINCIPAL: '👑',
  SYS_ADMIN: '🔧',
};

/**
 * 学部副本（自建职位）的编码前缀 → 沿用母职位的图标。
 * ★ 2026-10-26：BZR_G / BZR_U（班主任高中部·大学部）这类副本是自建职位，
 *   编码不在上表里，原来看起来全是 👤，与母职位（🧑‍🏫）不一致。
 *   这里按前缀归到同一职位族，保证「班主任 ×3」「教员 ×3」的图标一致。
 */
const ICON_BY_CODE_PREFIX: [string, string][] = [
  ['BZR_', '🧑‍🏫'],
  ['JY_', '👨‍🏫'],
  ['ZJ_', '🧑‍💼'],
  ['JZJL_', '📊'],
  ['XSJL_', '🎓'],
];

/** 角色标识（roleCode）→ 图标（查不到时统一兜 👤）
 *  ★ 2026-10-26：不再按「是否预置」区分兜底图标（预置🔧 / 自建👤）——
 *    系统里已没有预置/自建的概念，统一兜 👤，避免同一列表里出现两套默认图标。 */
export function roleIconOf(r: { roleCode?: string; isSys?: boolean }): string {
  const code = String(r?.roleCode || '');
  if (!code) return '👤';
  const exact = ROLE_ICON_BY_CODE[code];
  if (exact) return exact;
  for (const [prefix, icon] of ICON_BY_CODE_PREFIX) {
    if (code.startsWith(prefix)) return icon;
  }
  return '👤';
}

export default roleIconOf;
