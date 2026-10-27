/**
 * 清理 E2E / 自检 测试残留
 *
 * 用法：npx tsx scripts/_clean_residue.mts [--apply]
 *
 * 安全约束：
 *   ① 只匹配「名称类文本字段」，明确排除 id / *_id / create_by / update_by /
 *     role_code / action_code / module_key / api_path 等代码类字段 ——
 *     否则 UUID 里恰好出现 e2e 三个字符就会误删真数据（实测 t_perm_role_perm 中招 7 行）。
 *   ② 删前把命中行整行导出到 数据库备份/residue-<时间戳>.json，可回灌。
 *   ③ 默认只预览，加 --apply 才真删。
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { db } from '../src/perm/utils/db';

const APPLY = process.argv.includes('--apply');

const TARGETS: [string, string][] = [
  ['sms_common', 't_uni_approval_main'],
  ['sms_common', 't_uni_approval_log'],
  ['sms_common', 't_uni_dorm_room'],
  ['sms_common', 't_uni_dorm_bed'],
  ['sms_common', 't_uni_dorm_change'],
  ['sms_common', 't_uni_dorm_resident'],
  ['sms_common', 't_uni_fee'],
  ['sms_common', 't_uni_notify'],
  ['sms_common', 't_uni_urge'],
  ['sms_common', 't_uni_urge_log'],
  ['sms_common', 't_uni_exam_field'],
  ['sms_common', 't_uni_student'],
  ['sms_common', 't_uni_class'],
  ['sms_finance', 't_finance_refund'],
  ['sms_perm', 't_perm_log'],
];

/** 代码类字段：绝不用来匹配测试字样 */
const EXCLUDE = new Set([
  'id',
  'create_by',
  'update_by',
  'role_code',
  'action_code',
  'module_key',
  'api_path',
  'http_method',
  'operator_role',
  'role_id',
  'menu_id',
  'user_id',
  'student_id',
  'class_id',
  'dept_id',
  'biz_id',
  'applicant_id',
  'exam_id',
  'fee_id',
  'role_type',
  'biz_type',
  'status',
]);

const PATTERNS = [`%自检%`, `E2E-%`, `%E2E-%`];

(async () => {
  const backup: Record<string, any[]> = {};
  const lines: string[] = [];

  for (const [d, t] of TARGETS) {
    let cols: any[] = [];
    try {
      const r: any = await db.raw(
        `SELECT COLUMN_NAME c, DATA_TYPE ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`,
        [d, t],
      );
      cols = r[0].filter(
        (c: any) =>
          ['varchar', 'char', 'text', 'longtext'].includes(c.ty) &&
          !EXCLUDE.has(c.c) &&
          !/_id$/.test(c.c) &&
          !/^id_/.test(c.c),
      );
    } catch (e: any) {
      lines.push(`${d}.${t}: 取列失败 ${e.message}`);
      continue;
    }
    if (!cols.length) continue;

    const conds: string[] = [];
    for (const c of cols) for (const p of PATTERNS) conds.push(`\`${c.c}\` LIKE ?`);
    const args = cols.flatMap(() => PATTERNS);

    try {
      const rows: any = await db.raw(
        `SELECT * FROM \`${d}\`.\`${t}\` WHERE ${conds.join(' OR ')}`,
        args,
      );
      if (!rows[0].length) continue;
      backup[`${d}.${t}`] = rows[0];
      lines.push(`${d}.${t}: ${rows[0].length} 行`);
    } catch (e: any) {
      lines.push(`${d}.${t}: 查询失败 ${e.message}`);
    }
  }

  console.log(lines.join('\n') || '（没有命中）');
  const total = Object.values(backup).reduce((n, v) => n + v.length, 0);
  console.log(`\n合计 ${total} 行`);

  if (!APPLY) {
    console.log('\n（预览模式，加 --apply 才删除）');
    await db.destroy();
    return;
  }
  if (!total) {
    await db.destroy();
    return;
  }

  const dir = path.resolve('../数据库备份');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `residue-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(backup, null, 1), 'utf8');
  console.log(`已备份：${file}`);

  let deleted = 0;
  for (const key of Object.keys(backup)) {
    const [d, t] = key.split('.');
    const ids = backup[key].map((r: any) => r.id).filter(Boolean);
    if (!ids.length) continue;
    const n: any = await db.raw(`DELETE FROM \`${d}\`.\`${t}\` WHERE id IN (?)`, [ids]);
    const cnt = Array.isArray(n[0]) ? n[0].affectedRows : 0;
    deleted += cnt;
    console.log(`  ${key}: 删除 ${cnt}`);
  }
  console.log(`\n共删除 ${deleted} 行`);
  await db.destroy();
})();
