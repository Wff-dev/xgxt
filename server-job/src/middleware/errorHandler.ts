/**
 * 统一错误处理中间件
 *
 * ⚠️ 作用：
 *   1. 把所有异常统一成 {code, message, data} 格式
 *   2. 把技术错误翻译成人话，不让用户看到堆栈
 *
 * 必须在 app.ts 里最后注册：app.use(errorHandler)
 */

import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { BizCode, ApiResponse } from 'shared-types';
import { config } from '../config';

/**
 * ★ 2026-10-04 班级模块并入时新增：
 *   班级模块有自己的 BizError（class/http/response.ts），和我们这个**同名不同类**。
 *   这里用「鸭子类型」识别，不 import 它的类（避免两套模块互相依赖）：
 *   特征 = name === 'BizError' 且有数字型 code / httpStatus。
 */
function isClassBizError(err: any): boolean {
  return (
    !!err &&
    err.name === 'BizError' &&
    typeof err.code === 'number' &&
    typeof err.httpStatus === 'number'
  );
}

/** 业务异常（在代码里 throw new BizError(...) 即可） */
export class BizError extends Error {
  code: BizCode;
  httpStatus: number;

  constructor(code: BizCode, message: string, httpStatus = 200) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // ---- 业务异常：直接返回约定好的码和提示 ----
  if (err instanceof BizError) {
    const body: ApiResponse<null> = { code: err.code, message: err.message, data: null };
    res.status(err.httpStatus).json(body);
    return;
  }

  // ---- ★ 班级模块的业务异常（同名不同类，见上方说明）----
  if (isClassBizError(err)) {
    const body: ApiResponse<null> = { code: err.code, message: err.message, data: null };
    res.status(err.httpStatus).json(body);
    return;
  }

  // ---- ★ 参数校验失败（班级模块的 validate 中间件抛 ZodError）----
  if (err instanceof ZodError) {
    const first = err.errors[0];
    const prefix = first?.path?.length ? `${first.path.join('.')}：` : '';
    const body: ApiResponse<null> = {
      code: BizCode.PARAM_ERROR,
      message: `${prefix}${first?.message || '参数校验失败'}`,
      data: null,
    };
    res.status(200).json(body);
    return;
  }

  // ---- 数据库常见错误：翻译成人话 ----
  const dbMessage = translateDbError(err);
  if (dbMessage) {
    console.error('[DB ERROR]', req.method, req.url, err.code);
    const body: ApiResponse<null> = {
      code: BizCode.DB_ERROR,
      message: dbMessage,
      data: null,
    };
    res.status(200).json(body);
    return;
  }

  // ---- 其他未知错误 ----
  console.error('[UNHANDLED ERROR]', req.method, req.url, err);

  const body: ApiResponse<null> = {
    code: BizCode.INTERNAL_ERROR,
    message: config.env === 'development'
      ? `服务器错误：${err.message}`   // 开发环境给详细信息，方便排查
      : '服务器开小差了，请稍后重试',      // 生产环境不暴露细节
    data: null,
  };
  res.status(200).json(body);
}

/** 把 MySQL 的错误码翻译成中文提示（导出仅为单测用：server-job/tools/verify-db-error-hint.mjs） */
export function translateDbError(err: any): string | null {
  if (!err || !err.code) return null;

  /* ★ 2026-10-19：P8 之后教学域老表已 DROP，这条报错的真正常见原因不再是
       「没跑迁移」，而是「某处仓储漏切读、还在查老表」。把表名带出来，
       排查时一眼能定位到是哪个域。

     ★ 2026-10-26：光说「应走 t_uni_*」也会把人带偏 —— 实测最常见的其实是
       **本地库比代码旧**（队友加了表只写 sql/init、没写 knex 迁移，
       见根目录《数据库变更约定.md》复盘）。所以先把自检命令顶到最前面，
       三种可能按「查一次就能分辨」的顺序写清楚。 */
  if (err.code === 'ER_NO_SUCH_TABLE') {
    const table = /Table '([^']+)' doesn't exist/i.exec(String(err.sqlMessage || err.message || ''))?.[1];
    return (
      `数据表不存在${table ? `：${table}` : ''} —— ` +
      '先跑 `cd server-job && npm run db:schema-diff` 分辨是哪种：' +
      '① 自检报「库里缺」→ 本地库比代码旧，按《数据库变更约定.md》补表补列（npm run migrate 补不出这类表）；' +
      '② 自检库里齐全 → 代码还在读已废弃的老表，应改走 t_uni_*；' +
      '③ 报的库名与预期不符 → 跨库 SQL 漏写库名前缀（要写成 sms_xxx.t_yyy）'
    );
  }

  /* ★ 2026-10-23：字段不存在也要点名是哪张表哪一列。
   *
   * 【为什么】2026-10-23 用户报「阶段方案保存不了」，前端只看到
   *   「数据库字段/表不存在（可能是迁移脚本没跑）」——
   *   不看 MySQL 原文根本不知道该补什么。真实原因是
   *   `Unknown column 'stage_code' in 'field list'`：
   *   迁移 20261022_001_add_scheme_stage_code 没执行（不是表没了，也不是代码写错）。
   */
  if (err.code === 'ER_BAD_FIELD_ERROR') {
    const raw = String(err.sqlMessage || err.message || '');
    const col = /Unknown column '([^']+)'/i.exec(raw)?.[1];
    const table = /\b(?:from|into|update)\s+`?([a-z0-9_]+)`?/i.exec(raw)?.[1];
    return (
      `数据库缺少字段${col ? `「${col}」` : ''}${table ? `（表 ${table}）` : ''} —— ` +
      '多半是迁移脚本没跑：cd server-job && npm run migrate'
    );
  }

  const map: Record<string, string> = {
    ER_DUP_ENTRY: '数据已存在，请勿重复添加',
    ER_NO_REFERENCED_ROW_2: '关联的数据不存在',
    ER_ROW_IS_REFERENCED_2: '该数据被其他记录引用，无法删除',
    ER_ACCESS_DENIED_ERROR: '数据库账号或密码错误',
    ECONNREFUSED: '无法连接数据库，请检查数据库是否启动',
    ER_DATA_TOO_LONG: '输入的内容太长了',
  };

  return map[err.code] || null;
}
