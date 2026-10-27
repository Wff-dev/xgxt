/**
 * ============================================================
 * 职位列表的统一排序规则（单一事实来源）
 * ============================================================
 *
 * 【为什么单独抽出来】
 *   职位列表在四个地方各查各的：
 *     · 职位管理          role.route.ts  GET /role/list（服务端分页）
 *     · 职位权限分配左栏   assign.route.ts GET /assign/role-list
 *     · 页面管理左栏       rolePage.service.ts loadRoles()
 *     · 职位导出          role.route.ts GET /role/export + export.route.ts
 *   以前各自只写了 `orderBy('sort_no')`，学部副本与母职位 sort_no 相同 →
 *   同分的行顺序由 MySQL 随意决定，于是出现「班主任（高中部）在前、
 *   （初中部）在后」这种反直觉的排法，而且三个页面看到的顺序还不一样。
 *
 * 【2026-10-26 用户要求的口径】
 *   同一个职位族内按学部先后排：初中部 → 高中部 → 大学部，即
 *     班主任（初中部）→ 班主任（高中部）→ 班主任（大学部）→
 *     教员（初中部）→ 教员（高中部）→ 教员（大学部）→ 助教（…）→ …
 *   职位族之间仍按 `sort_no`（也就是职位表里的固有顺序：
 *   咨询老师/咨询经理/班主任/教员/助教/学管主任/教质经理/学术经理/教务老师/…）。
 *
 * 【实现要点】
 *   学部副本的 sort_no 是**故意与母职位相同**的（BZR_G、BZR_U 都是 3），
 *   所以「族内顺序」不能再靠 sort_no，而是用 role_name 里的学部字样做次级排序。
 *   这样不用改动任何数据，也不用给 t_perm_role 加列。
 */

import { db } from '../perm/utils/db';

/** 学部先后：初中部 → 高中部 → 大学部；名字里不含学部的（学管主任、校长…）rank=0，排在本族最前 */
export const ROLE_STAGE_RANK_SQL = `CASE
    WHEN role_name LIKE '%初中部%' THEN 1
    WHEN role_name LIKE '%高中部%' THEN 2
    WHEN role_name LIKE '%大学部%' THEN 3
    ELSE 0 END`;

/**
 * 给职位查询挂上统一排序（就地修改并返回同一个 query builder）
 *
 * 顺序：职位族(sort_no) → 学部(初中/高中/大学) → 创建时间（兜底稳定）
 *
 * ★ 2026-10-26：去掉了原来的「预置优先」这一级 —— 系统里已不再区分预置/自建职位，
 *   留着它会让「同族同学部」的两行仍按预置标记暗中决定先后。
 */
export function orderRoles<T>(query: T): T {
  const q = query as any;
  q.orderBy('sort_no', 'asc');
  q.orderByRaw(ROLE_STAGE_RANK_SQL);
  q.orderBy('create_time', 'asc');
  return query;
}

/**
 * 新增职位时推断 sort_no
 *
 * 名字形如「班主任（大学部）」→ 沿用「班主任」这一族的 sort_no，
 * 这样新加的学部副本会直接落到族内正确位置，而不是掉到列表末尾（默认 99）。
 */
export async function inferRoleSortNo(roleName: string): Promise<number> {
  const name = String(roleName || '').trim();
  const m = /^(.+?)[（(][^）)]*部[）)]$/.exec(name);
  if (!m) return 99;
  const base = m[1].trim();
  if (!base) return 99;

  // 母职位的名字本身也可能带学部（库里「班主任（初中部）」才是母职位，没有裸名「班主任」），
  // 所以先找同名，再找「base（…）」开头的同族职位，取 sort_no 最小的那个
  const rows: any[] = await db('t_perm_role')
    .where('is_deleted', false)
    .select('role_name', 'sort_no');

  const exact = rows.find((r) => r.role_name === base);
  if (exact) return Number(exact.sort_no);

  const family = rows.filter(
    (r) => String(r.role_name).startsWith(`${base}（`) || String(r.role_name).startsWith(`${base}(`),
  );
  if (!family.length) return 99;
  // ★ 2026-10-26：原先还拿 is_sys 当第一排序键，预置概念取消后只按 sort_no 取
  family.sort((a, b) => Number(a.sort_no) - Number(b.sort_no));
  return Number(family[0].sort_no);
}
