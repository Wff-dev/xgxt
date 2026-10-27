/**
 * 清洗操作日志里残留的机器 ID（UUID / 长 hash）
 *
 * 用法：
 *   npx tsx scripts/_clean_log_targets.mts           # 只预览，不改库
 *   npx tsx scripts/_clean_log_targets.mts --apply   # 备份后落库
 *
 * 背景（2026-10-26）：
 *   用户截图反映操作日志的「操作对象」列出现
 *   `咨询 #4d4b4781-857c-43b4-999e-a57667a59cb9` 这种一串字母加连字符。
 *   写入端（middleware/auditLog.ts 的 buildTarget）已经不再拼 UUID，
 *   但库里已有存量脏数据。本脚本把它们洗成可读文本。
 *
 * 覆盖两列（同一批日志里两列是同一个值，必须一起洗，否则详情前后矛盾）：
 *   · target_obj   —— 界面「操作对象」列
 *   · before_value —— 「修改 / 审批」类日志存的旧对象副本
 *
 * 规则：只删「# + UUID/hash」这一段，资源名与中文名保留
 *   `班级 #5d06d652-…`            → `班级`
 *   `缴费 #FEE-U26006-3`          → 不动（业务编号是给人看的）
 *
 * 安全：
 *   ① 默认只预览，必须显式 --apply 才写库；
 *   ② 写库前把命中行原样导出到 数据库备份/log-targets-<时间戳>.json，可回灌；
 *   ③ 只动这两列，其余字段一个字节都不碰。
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { db } from '../src/perm/utils/db';
import { sanitizeTargetObj } from '../src/perm/utils/logTarget';

const APPLY = process.argv.includes('--apply');

/** 与 utils/logTarget.ts 同一条正则，SQL 侧先用它粗筛 */
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

interface Row {
  id: string;
  log_time: string;
  module_name: string;
  action_type: string;
  target_obj: string | null;
  before_value: string | null;
}

async function main(): Promise<void> {
  const rows: Row[] = await db('t_perm_log')
    .where('is_deleted', false)
    .whereRaw(`target_obj REGEXP '${UUID_RE}' OR before_value REGEXP '${UUID_RE}'`)
    .select('id', 'log_time', 'module_name', 'action_type', 'target_obj', 'before_value')
    .orderBy('log_time', 'desc');

  console.log(`\n命中 ${rows.length} 条含 UUID 的日志\n`);
  if (!rows.length) {
    console.log('没有需要清洗的数据。');
    return;
  }

  const changes = rows.map((r) => {
    const t0 = r.target_obj ?? '';
    const b0 = r.before_value ?? '';
    let t1 = t0 ? sanitizeTargetObj(t0) : t0;
    let b1 = b0 ? sanitizeTargetObj(b0) : b0;

    /**
     * 兜底：少数 before_value 存的不是「对象名」而是请求体 JSON 片段
     * （如 `{"gradeId":"4ce69a33-…"}`），去掉 `#UUID` 也洗不干净。
     * 这类值对界面毫无意义（详情页也只展示对象与结果），
     * 统一退化成对象名 —— 语义上「修改前的对象」就是该对象本身。
     */
    const hasUuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    if (hasUuid.test(t1)) t1 = b1 && !hasUuid.test(b1) ? b1 : '';
    if (hasUuid.test(b1)) b1 = t1 || '';

    return { id: r.id, targetBefore: t0, targetAfter: t1, beforeBefore: b0, beforeAfter: b1 };
  });

  const show = changes.filter((c) => c.targetBefore !== c.targetAfter || c.beforeBefore !== c.beforeAfter);
  console.table(
    show.slice(0, 40).map((c) => ({
      对象_清洗前: c.targetBefore,
      对象_清洗后: c.targetAfter,
      前值_清洗前: c.beforeBefore === c.targetBefore ? '（同对象）' : c.beforeBefore,
      前值_清洗后: c.beforeBefore === c.targetBefore ? '（同对象）' : c.beforeAfter,
    })),
  );
  if (show.length > 40) console.log(`… 仅展示前 40 条，共 ${show.length} 条`);

  if (!APPLY) {
    console.log('\n预览模式，未改库。确认无误后加 --apply 执行。');
    return;
  }

  /* ---- 备份 ---- */
  const dir = path.resolve('../数据库备份');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `log-targets-${Date.now()}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      rows.map((r) => ({
        id: r.id,
        log_time: r.log_time,
        target_obj: r.target_obj,
        before_value: r.before_value,
      })),
      null,
      1,
    ),
    'utf8',
  );
  console.log(`\n已备份到 ${file}`);

  /* ---- 落库 ---- */
  let done = 0;
  for (const c of changes) {
    const patch: Record<string, string> = {};
    if (c.targetBefore !== c.targetAfter) patch.target_obj = c.targetAfter;
    if (c.beforeBefore !== c.beforeAfter) patch.before_value = c.beforeAfter;
    if (!Object.keys(patch).length) continue;
    await db('t_perm_log').where('id', c.id).update(patch);
    done += 1;
  }
  console.log(`已清洗 ${done} 条。`);

  /* ---- 复核 ---- */
  const [{ n }]: any = await db('t_perm_log')
    .where('is_deleted', false)
    .whereRaw(`target_obj REGEXP '${UUID_RE}' OR before_value REGEXP '${UUID_RE}'`)
    .count({ n: '*' });
  console.log(`复核：仍含 UUID 的日志 = ${Number(n)} 条`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('清洗失败：', e);
    process.exit(1);
  });
