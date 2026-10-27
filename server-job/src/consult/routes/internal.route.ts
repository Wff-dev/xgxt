/**
 * 咨询模块 · 服务间内部接口
 * ════════════════════════════════════════════════════════════
 * 路径前缀：/api/consult/student/internal
 *
 * 【为什么单开一个文件 + 单开一个挂载点】
 *   咨询侧所有接口都要求登录态（Bearer token），而班主任属于**班级模块**的用户，
 *   他的 token 在咨询侧解不出咨询岗位，直接调 /api/consult/student/* 会被 401/403。
 *
 *   但业务上「试学结束 → 班主任发起补费 → 转正式」这个动作必须由班主任发起，
 *   所以要有一条**服务间通道**：只认 x-internal-token（与 class 侧 /auto-receive 对称）。
 *
 *   ⚠️ 挂载必须排在同前缀的登录态路由【之前】（见 app.ts），否则先被 authMiddleware 拦掉。
 *   ⚠️ 本文件所有接口都不做「数据范围」校验 —— 调用方（班级模块）已在校验
 *      「这个学生是不是我班上的」，这里只按学号认人。
 * ════════════════════════════════════════════════════════════
 *
 * 【试学闭环口径（2026-10-20 用户口径）】
 *   交试学费 → 分配班级 → 试学中
 *     ├─ 试学有问题 ──→ 退学（走班级模块的退学审批链，通过后回写本模块为「流失」）
 *     └─ 试学通过 ───→ 班主任发起补费 → 补缴到账 → 正式在读
 */

import { Router } from 'express';
import { z } from 'zod';
import { BizCode, ConsultState, CONSULT_STATE_NAME, FULL_FEE_TYPES, FEE_TYPE_NAME, StudentStatus, nameOf } from 'shared-types/consult';
import { db } from '../utils/db';
import { ok } from '../utils/response';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
import { STUDENT_TABLE, addHistory, today } from '../services/student.service';
import { changeState } from '../services/state.service';
import { getSupplementPlan, isFullFeeSettled, advanceStudentStateOnArrival, FEE_ORDER_TABLE } from '../services/fee-order.service';
import { terminateStudentPlans } from '../services/installment.service';
// ★ 2026-10-27 方案 A：接收建档后把班级补进该学生名下的历史单据（只补空、不覆盖）
import { syncClassSnapshot } from '../services/class-snapshot.service';
import { config } from '../config';
import { REFUND_TABLE } from '../services/refund.service';

export const consultInternalRouter = Router();

/**
 * 服务间令牌校验（与 class 侧 authAllowSync 同一口径、同一令牌来源）
 *
 * ⚠️ 本路由**不挂** consultAuth，所以必须自己把关：
 *    没有这道校验，任何人不带 token 就能把学生改成「流失」。
 */
consultInternalRouter.use((req, res, next) => {
  const got = String(req.header('x-internal-token') || '');
  const expected = String(config.internalToken || '');
  if (!expected || got !== expected) {
    return res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '内部令牌校验失败', data: null });
  }
  next();
});

/**
 * 按「跨模块认人键」找学生
 *
 * 认人键 = 咨询侧 student_no（没有学号时退回本表主键），
 * 与 class 侧 t_class_student.source_id 完全同源（咨询推送时写入）。
 */
async function findByConsultNo(consultNo: string): Promise<Record<string, any>> {
  const key = String(consultNo || '').trim();
  if (!key) throw new BizError(BizCode.PARAM_ERROR, '缺少学号（consultNo）');

  const row = await db(STUDENT_TABLE)
    .where({ is_deleted: false })
    .andWhere((qb: any) => qb.where('student_no', key).orWhere('id', key))
    .first();

  if (!row) {
    throw new BizError(
      BizCode.STUDENT_NOT_FOUND,
      `咨询侧未找到学号为「${key}」的学生，无法联动（该生可能不是从咨询导入的）`,
    );
  }
  return row;
}

/** 该生是否还停在「试学」阶段（可退学 / 可发起补费） */
function assertInTrial(stu: Record<string, any>, actionName: string): void {
  const state = Number(stu.consult_state);
  if (state !== ConsultState.TRIAL) {
    throw new BizError(
      BizCode.INVALID_STATUS,
      `「${stu.student_name}」当前状态为「${nameOf(CONSULT_STATE_NAME, state)}」，只有「试学中」的学生才能${actionName}`,
    );
  }
}

/* ============================================================
 * 0. ★ 2026-10-23 批量查学生状态（服务间内部接口）
 *    POST /api/consult/student/internal/states-by-nos
 *    body: { nos: string[] }  →  { items: [{ studentNo, consultState, stateName, studentStatus }] }
 *
 * 【为什么需要】
 *   用户口径：「转正式的按钮删掉，状态同步咨询那边的学生状态」。
 *   转正不再由班主任手动发起，档案页的状态要跟咨询侧走 ——
 *   但档案页一次要显示一页学生，只能**批量**问一次，不可能一个个 GET。
 *
 * 【认人键】student_no（= 教学侧学号；接收建档时 receive-ack 会把学号回写到这里）。
 *   查不到的学号直接不返回（教学侧自己新建的学生，没有咨询记录，属正常）。
 * ============================================================ */
consultInternalRouter.post(
  '/states-by-nos',
  validate(z.object({ nos: z.array(z.string().min(1)).max(200, '单次最多 200 个学号') })),
  wrap(async (req, res) => {
    const { nos } = (req as any).validated as { nos: string[] };
    const keys = [...new Set(nos.map((s) => String(s).trim()).filter(Boolean))];
    if (!keys.length) {
      res.json(ok({ items: [] }, '查询成功'));
      return;
    }

    const rows = (await db(STUDENT_TABLE)
      .where({ is_deleted: false })
      .whereIn('student_no', keys)
      .select('student_no', 'consult_state', 'student_status')) as Array<Record<string, any>>;

    res.json(
      ok({
        items: rows.map((r) => ({
          studentNo: String(r.student_no),
          consultState: Number(r.consult_state ?? 0),
          stateName: nameOf(CONSULT_STATE_NAME, Number(r.consult_state ?? 0)),
          studentStatus: r.student_status == null ? null : Number(r.student_status),
        })),
      }),
    );
  }),
);

/* ============================================================
 * 1. 试学转正 · 补费预览
 *    GET /api/consult/student/internal/trial-plan?consultNo=S20260012
 *
 * 班主任点「转正式（补费）」时，班级模块先调这里拿：
 *   应缴合计 / 已到账 / 还差多少 / 差哪几项
 * ============================================================ */
consultInternalRouter.get(
  '/trial-plan',
  validate(z.object({ consultNo: z.string().min(1, '缺少学号') })),
  wrap(async (req, res) => {
    const { consultNo } = (req as any).validated as { consultNo: string };
    const stu = await findByConsultNo(consultNo);

    const plan = await getSupplementPlan(String(stu.id), FULL_FEE_TYPES);

    res.json(
      ok({
        consultNo,
        consultStudentId: stu.id,
        studentName: stu.student_name,
        consultState: Number(stu.consult_state),
        consultStateName: nameOf(CONSULT_STATE_NAME, Number(stu.consult_state)),
        className: stu.class_name ?? null,
        totalAmount: plan.totalAmount,
        arrivedAmount: plan.arrivedAmount,
        missingAmount: plan.missingAmount,
        missingTypes: plan.missing,
        missingTypeNames: plan.missing.map((t: number) => nameOf(FEE_TYPE_NAME, t)),
        items: plan.items,
        allArrived: plan.allArrived,
      }),
    );
  }),
);

/* ============================================================
 * 2. 班主任发起补费（试学 → 待缴全款）
 *    POST /api/consult/student/internal/trial-supplement
 *
 * 只改状态 + 留痕，**不建收费单**。
 * 原因：本系统「缴费必须有凭证」（钱已到手才建单），
 *       班主任发起的只是「该收这笔钱了」的任务，真正收款仍由咨询老师上传凭证、
 *       财务核对到账 —— 到账后 fee-order.service 会自动把状态推进到「正式在读」。
 * ============================================================ */
consultInternalRouter.post(
  '/trial-supplement',
  validate(
    z.object({
      consultNo: z.string().min(1, '缺少学号'),
      operatorName: z.string().min(1, '缺少操作人'),
      operatorTitle: z.string().optional().default('班主任'),
    }),
  ),
  wrap(async (req, res) => {
    const b = (req as any).validated as {
      consultNo: string;
      operatorName: string;
      operatorTitle: string;
    };
    const stu = await findByConsultNo(b.consultNo);

    /* 幂等：已经发起过补费（全款待缴）→ 直接告诉他「在等钱」，不要报错。
     * 班主任容易连点两次，报错会让人以为流程坏了。 */
    if (Number(stu.consult_state) === ConsultState.FULL_FEE_PENDING) {
      const plan0 = await getSupplementPlan(String(stu.id), FULL_FEE_TYPES);
      return res.json(
        ok(
          {
            consultNo: b.consultNo,
            consultStudentId: stu.id,
            studentName: stu.student_name,
            missingAmount: Number(plan0.missingAmount),
            missingTypes: plan0.missing,
            missingTypeNames: plan0.missing.map((t: number) => nameOf(FEE_TYPE_NAME, t)),
            consultState: ConsultState.FULL_FEE_PENDING,
            consultStateName: nameOf(CONSULT_STATE_NAME, ConsultState.FULL_FEE_PENDING),
            duplicate: true,
          },
          `「${stu.student_name}」已在补费中（待缴 ¥${(Number(plan0.missingAmount) / 100).toFixed(2)}），请等待财务确认到账`,
        ),
      );
    }

    assertInTrial(stu, '发起补费');

    const plan = await getSupplementPlan(String(stu.id), FULL_FEE_TYPES);

    if (plan.allArrived || Number(plan.missingAmount) <= 0) {
      /* 钱已经齐了（可能是老师先收了费），不该再走补费流程 ——
       * 直接把人推到「待分班 / 正式」，避免卡在试学中。 */
      const next = stu.class_id ? ConsultState.FORMAL : ConsultState.TRIAL_WAIT_CLASS;
      if (Number(stu.consult_state) !== next) {
        await changeState(String(stu.id), next, {
          byName: b.operatorName,
          byTitle: b.operatorTitle,
          action: 'TRIAL_TO_FORMAL',
          historyText: `班主任 ${b.operatorName} 发起转正：全款费用已到齐，无需补缴，状态→${nameOf(CONSULT_STATE_NAME, next)}`,
        });
      }
      return res.json(
        ok(
          {
            consultNo: b.consultNo,
            alreadyPaid: true,
            missingAmount: 0,
            nextState: next,
            nextStateName: nameOf(CONSULT_STATE_NAME, next),
          },
          '该生费用已缴清，已直接转为正式在读',
        ),
      );
    }

    const missingYuan = (Number(plan.missingAmount) / 100).toFixed(2);
    const typeNames = plan.missing.map((t: number) => nameOf(FEE_TYPE_NAME, t)).join('、');

    await changeState(String(stu.id), ConsultState.FULL_FEE_PENDING, {
      byName: b.operatorName,
      byTitle: b.operatorTitle,
      action: 'TRIAL_SUPPLEMENT',
      historyText:
        `班主任 ${b.operatorName} 发起试学转正补费：应补缴 ¥${missingYuan}（${typeNames}），` +
        '请咨询老师到「收款与缴费」发起收费，到账后自动转为正式在读',
    });

    res.json(
      ok(
        {
          consultNo: b.consultNo,
          consultStudentId: stu.id,
          studentName: stu.student_name,
          missingAmount: Number(plan.missingAmount),
          missingTypes: plan.missing,
          missingTypeNames: plan.missing.map((t: number) => nameOf(FEE_TYPE_NAME, t)),
          consultState: ConsultState.FULL_FEE_PENDING,
          consultStateName: nameOf(CONSULT_STATE_NAME, ConsultState.FULL_FEE_PENDING),
        },
        `已发起补费 ¥${missingYuan}（${typeNames}），待财务确认到账后自动转为正式在读`,
      ),
    );
  }),
);

/* ============================================================
 * 3. 试学退学 · 回写咨询状态
 *    POST /api/consult/student/internal/quit
 *
 * 班级模块的退学审批链（班主任发起 → 学管 → 校长）通过后调用。
 * 本接口只负责「咨询侧别再挂着试学中」，退费另走退费流程。
 *
 * ⚠️ 幂等：已经是流失 / 退费流程中的，直接返回 skipped，不报错。
 * ============================================================ */
consultInternalRouter.post(
  '/quit',
  validate(
    z.object({
      consultNo: z.string().min(1, '缺少学号'),
      reason: z.string().max(300).optional().nullable(),
      operatorName: z.string().optional().default('班级模块'),
      operatorTitle: z.string().optional().default('系统'),
    }),
  ),
  wrap(async (req, res) => {
    const b = (req as any).validated as {
      consultNo: string;
      reason?: string | null;
      operatorName: string;
      operatorTitle: string;
    };
    const stu = await findByConsultNo(b.consultNo);
    const cur = Number(stu.consult_state);

    /* 退费流程中 / 已流失 / 已退费：不要覆盖，退费流程自己会把状态走完 */
    const SKIP_STATES = [
      ConsultState.REFUND_MGR,
      ConsultState.REFUND_FINANCE,
      ConsultState.REFUNDED,
      ConsultState.LOST,
    ];
    if (SKIP_STATES.includes(cur)) {
      return res.json(
        ok(
          {
            consultNo: b.consultNo,
            skipped: true,
            consultState: cur,
            consultStateName: nameOf(CONSULT_STATE_NAME, cur),
          },
          `咨询侧当前状态为「${nameOf(CONSULT_STATE_NAME, cur)}」，无需重复处理`,
        ),
      );
    }

    /** 试学费分期还在收的，退学就终止，别再催尾款 */
    try {
      await terminateStudentPlans(String(stu.id), `退学：${b.reason || '试学未通过'}`);
    } catch (e: any) {
      console.warn('[consult internal quit] 终止分期计划失败', e?.message);
    }

    await changeState(String(stu.id), ConsultState.LOST, {
      byName: b.operatorName,
      byTitle: b.operatorTitle,
      action: 'QUIT',
      historyText: `退学申请已审批通过，学生退学${b.reason ? `：${b.reason}` : ''}（由班级模块同步）`,
      extraFields: { loss_reason: b.reason || '试学未通过，退学' },
    });

    await addHistory(
      String(stu.id),
      b.operatorName,
      '提示：该生已退学，如涉及退费请到「退费管理」发起退费申请',
      b.operatorTitle,
      'QUIT',
    );

    res.json(
      ok(
        {
          consultNo: b.consultNo,
          consultState: ConsultState.LOST,
          consultStateName: nameOf(CONSULT_STATE_NAME, ConsultState.LOST),
        },
        '已同步咨询侧：学生状态转为「流失」',
      ),
    );
  }),
);

/* ============================================================
 * 4. 班主任接收入班 · 学籍落点预览
 *    GET /api/consult/student/internal/receive-plan?consultNo=S20260012
 *
 * 【什么时候调】班级侧班主任点「接收」，在建档**之前**调一次，
 *   用来决定学籍落「试学中(3)」还是「正式在读(5)」：
 *     · 只交过试学费            → 试学中，后续由班主任发起补费转正
 *     · 学费等全款已到账 / 分期  → 正式在读，不用再点「转正式」
 *   这与「收费与缴费」页的补费口径同源（`isFullFeeSettled`）。
 *
 * 【为什么由咨询侧回答】
 *   钱和费用单一律在咨询库，班级侧看不到。与其在班级侧复制一份判断，
 *   不如让咨询侧算完直接给结论 —— 少一处会失真的口径。
 * ============================================================ */
consultInternalRouter.get(
  '/receive-plan',
  validate(z.object({ consultNo: z.string().min(1, '缺少学号') })),
  wrap(async (req, res) => {
    const { consultNo } = (req as any).validated as { consultNo: string };
    const stu = await findByConsultNo(consultNo);
    const cur = Number(stu.consult_state);
    const fullSettled = await isFullFeeSettled(String(stu.id));

    /* 已经是正式在读的（历史数据），接收后当然还是正式在读 */
    const studentStatus =
      cur === ConsultState.FORMAL || fullSettled ? StudentStatus.STUDYING : StudentStatus.TRIAL;

    res.json(
      ok({
        consultNo,
        consultStudentId: stu.id,
        studentName: stu.student_name,
        consultState: cur,
        consultStateName: nameOf(CONSULT_STATE_NAME, cur),
        className: stu.class_name ?? null,
        fullSettled,
        studentStatus,
        studentStatusName: studentStatus === StudentStatus.STUDYING ? '正式在读' : '试学中',
      }),
    );
  }),
);

/* ============================================================
 * 5. 班主任接收入班 · 回写咨询状态
 *    POST /api/consult/student/internal/receive-ack
 *
 * 【什么时候调】班级侧建档**成功之后**调，两个学段（初高 / 大学部）都走这里。
 *
 * 用户口径（2026-10-20）：
 *   「初高班主任在班级侧点了接收之后，系统会在初高学籍表建档，并回写咨询侧状态。
 *     大学侧和初高中一样，都需要老师接收之后入班」
 *
 *   → 咨询侧在推送后停在「待分班(4)」，班主任接收这一刻才推进：
 *       只交试学费  → 试学中(5)
 *       全款已到账  → 正式在读(7)
 *
 * ⚠️ 幂等：状态已经不是「待分班」的（重复点、或已被别的流程推进），
 *    只回当前状态 + 学籍落点，不重复写状态历史。
 * ⚠️ 不阻断建档：本接口失败只让咨询侧状态落后一步，不影响学生已经入班，
 *    调用方（班级模块）按「记日志继续」处理。
 * ============================================================ */
consultInternalRouter.post(
  '/receive-ack',
  validate(
    z.object({
      consultNo: z.string().min(1, '缺少学号'),
      className: z.string().max(100).optional().nullable(),
      operatorName: z.string().optional().default('班主任'),
      operatorTitle: z.string().optional().default('班主任'),
      /**
       * ★ 2026-10-22：教学侧建档生成的学号
       *   回写到咨询学生表，后续「补费」建单就能直接带上真学号，
       *   不会再去兜 `ZX...` 临时号（临时号在财务侧推不进教学台账）。
       */
      studentNo: z.string().max(32).optional().nullable(),
    }),
  ),
  wrap(async (req, res) => {
    const b = (req as any).validated as {
      consultNo: string;
      className?: string | null;
      operatorName: string;
      operatorTitle: string;
      studentNo?: string | null;
    };
    const stu = await findByConsultNo(b.consultNo);

    /* ★ 2026-10-22：把教学侧建档生成的学号回写咨询学生表
     *
     * 为什么必须在下面「状态是否已推进」的判断【之前】：
     *   状态已经是试学中/正式在读时会提前 return，
     *   但学号可能还没写进去（首次调用失败、或老数据补写），
     *   所以要有独立于状态的补写通道。
     *
     * 口径：只补空，不覆盖。
     *   咨询学生表一旦已有学号（人工维护或历史数据），不拿新学号冲掉。
     *
     * 不回写的后果（真实踩点）：
     *   后续「补费」建单会走 `stu.student_no || tempStudentNo(id)`，
     *   兜出 `ZX...` 临时号 → 同一学生补费单学号和已入班单据对不上，
     *   而且临时号在财务侧回查不到教学学生，缴费台账推不出去。
     */
    const noFromTeaching = String(b.studentNo || '').trim();
    if (noFromTeaching && !String(stu.student_no || '').trim()) {
      await db(STUDENT_TABLE)
        .where({ id: stu.id })
        .update({ student_no: noFromTeaching, update_time: new Date() });
      stu.student_no = noFromTeaching;
      // eslint-disable-next-line no-console
      console.log(`[consult] 学号回写：${String(stu.student_name)} → ${noFromTeaching}`);
    }

    const cur = Number(stu.consult_state);
    const fullSettled = await isFullFeeSettled(String(stu.id));
    const studentStatus =
      cur === ConsultState.FORMAL || fullSettled ? StudentStatus.STUDYING : StudentStatus.TRIAL;
    const className = String(b.className || stu.class_name || '').trim();

    /* 哪些状态可以被「接收」推进
     *
     * ★ 2026-10-22 用户口径：**允许跳过「分配 / 面试」** ——
     *   咨询师录完学生直接收费分班时，学生可能还停在待分配(1)/待面试(2)，
     *   这时接收也必须能推进，否则永远卡在待分配。
     *
     * ⚠️ 退费中(8/9)、已退费(10)、流失(12)、未通过(13) 不在集合里：
     *    这些状态不该被接收动作往前推（也防状态倒退）。
     */
    const RECEIVE_ADVANCEABLE: ConsultState[] = [
      ConsultState.WAIT_ASSIGN,
      ConsultState.WAIT_INTERVIEW,
      ConsultState.TRIAL_FEE_PENDING,
      ConsultState.TRIAL_WAIT_CLASS,
    ];
    if (!RECEIVE_ADVANCEABLE.includes(cur)) {
      return res.json(
        ok(
          {
            consultNo: b.consultNo,
            changed: false,
            consultState: cur,
            consultStateName: nameOf(CONSULT_STATE_NAME, cur),
            studentStatus,
            fullSettled,
          },
          `「${stu.student_name}」当前状态为「${nameOf(CONSULT_STATE_NAME, cur)}」，无需再推进`,
        ),
      );
    }

    const next = fullSettled ? ConsultState.FORMAL : ConsultState.TRIAL;

    await changeState(String(stu.id), next, {
      byName: b.operatorName,
      byTitle: b.operatorTitle,
      action: 'ASSIGN_CLASS',
      historyText:
        `${b.operatorTitle} ${b.operatorName} 已在班级侧接收并入班${className ? `「${className}」` : ''}；` +
        (fullSettled
          ? '学费等全款已缴清，状态→正式在读'
          : '仅缴试学费，状态→试学中（试学结束后由班主任发起补费转正）'),
      extraFields: {
        class_name: className || null,
        /**
         * ★ 2026-10-23 进班日一律落下来（试学 / 直接转正式都写）
         *
         * 原来只在「→试学中」时写 trial_start，缴全款直接转「正式在读」的学生
         * 这里是空的。退费按天算要从进班日起，缺了这一天前端日历没有下限，
         * 能一路翻到几个月前，试学天数算成 80 天、多扣住宿餐费。
         * 已经有值的不覆盖（首次进班日才是基准）。
         */
        ...(!stu.trial_start ? { trial_start: today() } : {}),
      },
    });

    /**
     * ★ 2026-10-27（方案 A）：接收建档时把班级补进该学生名下的历史单据
     *
     *   与「咨询端分班」同一个补丁，两条入班路径都要覆盖（否则走接收那条
     *   依然会出现「分班了但缴费单还写未分班」）。
     *   口径：只补空、不覆盖；失败不影响接收主流程。
     */
    try {
      await syncClassSnapshot(String(stu.id), className);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[consult] 接收建档后补单据班级失败', err);
    }

    res.json(
      ok(
        {
          consultNo: b.consultNo,
          changed: true,
          consultState: next,
          consultStateName: nameOf(CONSULT_STATE_NAME, next),
          studentStatus,
          fullSettled,
        },
        `已回写咨询侧：「${stu.student_name}」→ ${nameOf(CONSULT_STATE_NAME, next)}`,
      ),
    );
  }),
);

/* ============================================================
 * ★ 2026-10-22 财务核对到账 → 立即回推咨询侧推进学生状态
 *
 * POST /api/consult/student/internal/fee-arrived
 * body: { financeFeeId }
 *
 * 【为什么需要】
 *   财务核对只把咨询收款单 status 直接改成了「已到账」，
 *   但「学生状态推进 + 学籍同步」挂在 advanceStudentStateOnArrival 上，
 *   原来要等咨询老师打开「收款与缴费」列表触发 syncFromFinance 才跑。
 *   用户口径：核对补学费后，教学侧学生状态应当立刻从「试学中」变「正式在读」。
 *
 * 【为什么按 financeFeeId 而不是 orderId】
 *   财务侧只有自己的缴费单 id，咨询收款单 id 它不知道（两边各自主键）。
 *   用 finance_fee_id 反查是唯一稳定的关联键。
 * ============================================================ */
consultInternalRouter.post(
  '/fee-arrived',
  validate(z.object({ financeFeeId: z.string().min(1, '缺少财务缴费单 id') })),
  wrap(async (req, res) => {
    const { financeFeeId } = (req as any).validated as { financeFeeId: string };

    const row = (await db(FEE_ORDER_TABLE)
      .where({ finance_fee_id: financeFeeId, is_deleted: false })
      .first()) as Record<string, any> | undefined;

    if (!row) {
      // 不是咨询发起的单（教务/班级直建），没有学生状态要推进
      res.json(ok({ synced: 0 }, '该财务单不是咨询发起的，无需同步'));
      return;
    }

    // 推进本身幂等：状态不满足前置条件的会直接返回，不会重复写历史
    await advanceStudentStateOnArrival(row);

    res.json(ok({ synced: 1, orderNo: row.order_no }, '已推进咨询侧学生状态'));
  }),
);

/* ============================================================
 * 财务退费出款回写（2026-10-26）
 *
 * POST /api/consult/student/internal/refund-finance-paid
 *   header: x-internal-token
 *   body: { refundId, financeRefundId?, financeRefundNo?, billNo?, payTime?, payMethod? }
 *
 * 【为什么要有】
 *   财务 `payRefund()` 出款成功后会调上游回写，让上游自动变「已退费」。
 *   教学域早就有 `/api/teaching/refund/internal/finance-paid`，
 *   但财务的 `notifyUpstreamPaid()` 里第一行是
 *   `if (row.source_module !== 'teaching') return;` —— 咨询单一直被跳过。
 *
 *   实测后果（2026-10-26）：财务出款成功、生成 ZT 账单，
 *   但咨询学生**永远停在「退费·待财务打款(9)」**，退费单也停在待审批。
 * ============================================================ */
consultInternalRouter.post(
  '/refund-finance-paid',
  wrap(async (req, res) => {
    const b = req.body || {};
    const refundId = String(b.refundId || b.id || '').trim();
    if (!refundId) throw new BizError(BizCode.PARAM_ERROR, '缺少退费单 id');

    const row = (await db(REFUND_TABLE).where({ id: refundId, is_deleted: false }).first()) as
      | Record<string, any>
      | undefined;
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '咨询退费单不存在');

    const now = new Date();
    // 退费单：已退费(6) + 回填财务单号/出款信息
    await db(REFUND_TABLE).where({ id: refundId }).update({
      status: 6,
      finance_refund_id: b.financeRefundId ? String(b.financeRefundId) : row.finance_refund_id,
      finance_refund_no: b.financeRefundNo ? String(b.financeRefundNo) : row.finance_refund_no,
      pay_at: b.payTime ? String(b.payTime) : now,
      pay_method: b.payMethod != null ? Number(b.payMethod) : row.pay_method,
      pay_ref: b.billNo ? String(b.billNo) : row.pay_ref,
      update_time: now,
    });

    /**
     * 学生：走 changeState（会写跟进历史 + 同步财务冻结/解冻）。
     *
     * ★ 2026-10-26 修：原来是 `ConsultState.LOST`（流失 12）。
     *   用户实测：财务退费出款后，学生档案（学籍）仍停在「试学中」——
     *   因为 12→11 流失 不在学籍同步目标里，等于没同步。
     *   退费完成在咨询侧本来就该是「已退费(10)」，映射到学籍 7「退学」，
     *   这样教学档案才会跟着变（见 teaching/student/service.ts 的 CONSULT_SYNC_TARGETS）。
     */
    let synced = false;
    try {
      const r = await changeState(row.consult_student_id, ConsultState.REFUNDED, {
        byName: '财务出款',
        byTitle: '系统',
        historyText: `财务已出款（${b.financeRefundNo || row.finance_refund_no || '退费单'}），学生置为「已退费」`,
        action: 'refund-paid',
      } as any);
      synced = !!r?.synced;
    } catch (e) {
      // 状态已是流失等情况不阻断回写
      synced = false;
    }

    res.json(
      ok(
        { refundId, synced },
        `财务出款已回写：退费单 ${row.refund_no}，学生状态已更新`,
      ),
    );
  }),
);
