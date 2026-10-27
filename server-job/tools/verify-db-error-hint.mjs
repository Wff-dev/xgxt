/**
 * ★ 2026-10-26 校验「数据表不存在」错误提示的三种分流是否说清楚
 *
 * 背景：2026-10-26 用户报障「市场咨询 → 学生管理」弹
 *   「数据表不存在：sms_consult.t_consult_installment_plan」。
 *   旧文案只说「教学域老表已 DROP，应走 t_uni_*」，把人带去改代码，
 *   实际原因却是本地库比代码旧（缺表）。为了让下一个人第一步就能分辨，
 *   文案改成「先跑 npm run db:schema-diff，再按三种情况分头处理」。
 *
 * 跑法（必须在 server-job 目录下，config 依赖 .env）：
 *   cd server-job && npx tsx tools/verify-db-error-hint.mjs
 */

import { translateDbError } from '../src/middleware/errorHandler.ts';

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

console.log('== 1. ER_NO_SUCH_TABLE（带表名）==');
const msg1 = translateDbError({
  code: 'ER_NO_SUCH_TABLE',
  sqlMessage: "Table 'sms_consult.t_consult_installment_plan' doesn't exist",
});
console.log(`  实际文案：${msg1}`);
check('点名了缺失的表', msg1?.includes('sms_consult.t_consult_installment_plan'));
check('第一步给出自检命令 db:schema-diff', msg1?.includes('db:schema-diff'));
check('提示「库里缺 = 本地库比代码旧」', msg1?.includes('库里缺') && msg1?.includes('本地库比代码旧'));
check('指向《数据库变更约定.md》', msg1?.includes('数据库变更约定'));
check('保留了「代码读废弃老表 → 走 t_uni_*」这一支', msg1?.includes('t_uni_*'));
check('补了「跨库漏写库名前缀」这一支', msg1?.includes('sms_xxx.t_yyy'));
check('不再单独甩「请执行 npm run migrate」当结论', !/再执行 npm run migrate$/.test(msg1 || ''));
check('说明 migrate 补不出这类表', msg1?.includes('npm run migrate 补不出这类表'));

console.log('\n== 2. ER_NO_SUCH_TABLE（解析不到表名）==');
const msg2 = translateDbError({ code: 'ER_NO_SUCH_TABLE', message: 'weird error' });
check('仍然可读、没有 "：undefined"', !!msg2 && !msg2.includes('undefined') && msg2.includes('数据表不存在'));

console.log('\n== 3. ER_BAD_FIELD_ERROR（缺列）==');
const msg3 = translateDbError({
  code: 'ER_BAD_FIELD_ERROR',
  sqlMessage: "Unknown column 'item_detail' in 'field list'",
});
check('点名缺的列', msg3?.includes('item_detail'));
check('给出迁移提示', msg3?.includes('npm run migrate'));

console.log('\n== 4. 其他错误码按既有映射走、不误伤 ==');
check(
  'ECONNREFUSED → 连不上库的提示（原有映射保留）',
  translateDbError({ code: 'ECONNREFUSED' })?.includes('无法连接数据库'),
);
check('未收录的错误码返回 null', translateDbError({ code: 'ER_SOMETHING_NEW' }) === null);
check('空对象返回 null', translateDbError({}) === null);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
