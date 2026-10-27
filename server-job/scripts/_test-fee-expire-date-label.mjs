/**
 * 回归守卫：教学「缴费」列表把「应缴日期」改叫「到期日期」（2026-10-26 用户要求）
 * ============================================================================
 *
 * 【背景】
 *   教学模块 · 缴费列表（TeachingFeeHub → class-jh/views/FeeList.vue）原来表头、
 *   筛选、导出都写「应缴日期」，而系统里同一字段（expire_date）在财务 / 大学催缴 /
 *   就业催费单等页面一直叫「到期日期」。用户要求统一成「到期日期」。
 *
 * 【本脚本钉住什么】
 *   ① 列表列标题、筛选标签、导出表头都必须是「到期日期」；
 *   ② 模板里不能再出现「应缴日期」（避免只改一处、旁边还留着旧叫法）；
 *   ③ 「应缴金额」列必须保留 —— 这次只改日期文案，不能把金额列一起改掉；
 *   ④ 日期仍绑定 expireDate，说明只改文案、没动取数字段；
 *   ⑤ 教学模块「缴费」页仍复用这份列表（改在 FeeList 才能生效）。
 *
 * 跑法：cd server-job && node scripts/_test-fee-expire-date-label.mjs
 *      纯静态检查，不依赖服务 / 数据库。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeChecker } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const { check, summary } = makeChecker();
const read = (rel) => readFileSync(path.join(ROOT, rel.split('/').join(path.sep)), 'utf8');

const feeSrc = read('web-job/src/class-jh/views/FeeList.vue');
const template = feeSrc.slice(feeSrc.indexOf('<template>'), feeSrc.lastIndexOf('</template>'));
const exportBlock = feeSrc.slice(feeSrc.indexOf('const EXPORT_HEADERS'), feeSrc.indexOf('function toExportRow'));

check(
  '★ 列表列标题已改为「到期日期」',
  feeSrc.includes('<el-table-column label="到期日期" width="120">'),
  '应缴日期 → 到期日期',
);
check(
  '★ 筛选标签已改为「到期日期」',
  template.includes('<el-form-item label="到期日期">'),
);
check(
  '★ 模板里不再出现旧叫法「应缴日期」',
  !template.includes('应缴日期'),
  template.includes('应缴日期') ? '页面文案仍有旧叫法' : '页面文案已统一',
);
check(
  '★ 筛选提示同步改为「到期日期 / 已过到期日」',
  template.includes('到期日期对全部部门') && template.includes('已过到期日'),
);
check(
  '★ 导出表头已改为「到期日期」',
  exportBlock.includes("'到期日期'") && !exportBlock.includes("'应缴日期'"),
);
check(
  '★ 「应缴金额」列保留（只改日期叫法，不改金额）',
  template.includes('label="应缴金额"') && exportBlock.includes("'应缴金额'"),
  '金额列不应被这次改名波及',
);
check(
  '★ 到期日期仍绑定 expireDate（只改文案，未改字段）',
  /label="到期日期"[\s\S]{0,200}formatDate\(row\.expireDate\)/.test(feeSrc),
);
check(
  '★ 教学模块「缴费」页仍复用这份列表',
  read('web-job/src/teaching/views/TeachingFeeHub.vue').includes("import('@/class-jh/views/FeeList.vue')"),
);

process.exitCode = summary() ? 0 : 1;
