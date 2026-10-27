/**
 * 操作日志「操作对象」的显示清洗
 *
 * ============================================================
 * 【背景】2026-10-26 用户截图反馈
 *   操作日志的「操作对象」列出现 `咨询 #4d4b4781-857c-43b4-999e-a57667a59cb9`、
 *   `班级 #5d06d652-b7df-45a9-9b2d-a9a61679eb66` —— 一串字母加连字符。
 *   那是数据库主键（UUID），对使用者毫无意义：读不出是哪条记录，也没法拿去搜索。
 *
 *   根因有两处，都已处理：
 *     ① 写入端 `middleware/auditLog.ts` 的 `buildTarget()` 以前无条件拼 `资源 #id`，
 *        而教学/班级/考勤那些接口的请求体只传 id、不传名称 → 只剩乱码。
 *        现在 UUID / 长 hash 一律不进日志，只保留业务短编号（#S001、#FEE-26006-3）。
 *     ② 库里已有 29 条历史脏数据（生成时目标记录多已被 e2e 清理，无法还原名称）。
 *        写入端修好不影响存量，所以这里给**读取端**再加一道兜底：
 *        列表 / 详情 / 导出统一走 sanitizeTargetObj，界面不会再露出机器 ID。
 *        存量数据另有一次性清洗脚本 `scripts/_clean_log_targets.mts`。
 *
 * ============================================================
 * 【清洗规则】只删「# + 机器 ID」这一段，资源名和中文名一律保留：
 *   `班级 #5d06d652-…`            → `班级`
 *   `学员 #c5e89e3f-… 张三`       → `学员 张三`
 *   `缴费 #FEE-U26006-3`          → 原样保留（业务编号是给人看的）
 */

/** `#` + UUID，或 `#` + 16 位以上裸十六进制 hash */
const OPAQUE_SEG =
  /\s*#(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})(?![0-9a-z])/gi;

/**
 * 把「操作对象」里残留的机器 ID 去掉
 * @param v 库里的原始 target_obj（可能为空）
 */
export function sanitizeTargetObj(v: string | null | undefined): string {
  if (!v) return '';
  return String(v)
    .replace(OPAQUE_SEG, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 判断一个值本身是不是机器 ID（写入端也用同一套判定，避免两边口径漂移） */
const OPAQUE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[0-9A-Za-z_-]{32,})$/i;

export function isOpaqueId(v: string | null | undefined): boolean {
  if (!v) return false;
  return OPAQUE_ID.test(String(v).trim());
}

export default sanitizeTargetObj;
