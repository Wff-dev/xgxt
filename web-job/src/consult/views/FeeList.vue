<script setup lang="ts">
/**
 * 收款与缴费
 *
 * 规则在此页的体现：
 *   - 规则2：发起收费时金额由财务按「费用标准」取值，页面只展示预览值，不让手填
 *   - 规则3-①：只能发起咨询模块负责的费用类型（学费 / 试学费），其他类型调用会被拒
 *   - 规则3-②：上传凭证时，非餐费一人一张；重复时财务拒绝并提示占用方
 */

import { ref, onMounted, computed, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type {
  ConsultFeeOrder,
  ConsultFeeStats,
  ConsultInstallmentPlan,
  ConsultInstallmentItem,
  ConsultSupplementPlan,
  FinanceStandardView,
  ConsultStudentListItem,
} from 'shared-types/consult';
import {
  FeeType,
  FEE_TYPE_NAME,
  CONSULT_FEE_STATUS_NAME,
  ConsultFeeStatus,
  ConsultState,
  PAY_METHODS,
  // ★ 2026-10-26 优惠名目字典（奖学金 / 活动优惠 / 困难减免…）
  DISCOUNT_REASONS,
} from 'shared-types/consult';
import {
  fetchFeeList,
  fetchFeeStats,
  createFees,
  uploadFile,
  uploadVoucher,
  resubmitOrder,
  // ★ 2026-10-19 作废（重复发起 / 发起错了的撤销通道）
  cancelFeeOrders,
  fetchStandardBatch,
  fetchStudentList,
  // ★ 2026-10-20 补费（试学转正尾款 / 差额补收）
  createSupplementFee,
  fetchSupplementPlan,
  // ★ 2026-10-16 分期付款（发起收费已取消分期，仅保留分期计划查询/补缴）
  payInstallmentStage,
  fetchInstallmentDetail,
} from '@/consult/api/consult';
import { useAuthStore } from '@/consult/stores/auth';

const auth = useAuthStore();

/* ---------- 列表 ---------- */
const loading = ref(false);
const list = ref<ConsultFeeOrder[]>([]);
const total = ref(0);

/** 分页总页数（原型 pager 里的「第 N/M 页」） */
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / (size.value || 20))));
const page = ref(1);
const size = ref(10);
const query = ref({
  keyword: '',
  feeType: undefined as number | undefined,
  status: undefined as number | undefined,
});

const stats = ref<ConsultFeeStats | null>(null);

async function load() {
  loading.value = true;
  try {
    const [res, st] = await Promise.all([
      fetchFeeList({
        page: page.value,
        size: size.value,
        keyword: query.value.keyword || undefined,
        feeType: query.value.feeType,
        status: query.value.status,
      }),
      fetchFeeStats(),
    ]);
    list.value = res.list;
    total.value = res.total;
    stats.value = st;
  } finally {
    loading.value = false;
  }
}

function search() {
  page.value = 1;
  load();
}

function resetQuery() {
  query.value = { keyword: '', feeType: undefined, status: undefined };
  page.value = 1;
  load();
}

/* ---------- 发起收费 ---------- */
/**
 * ★ 2026-10-15 用户口径改造：
 *   ① 收费类型二选一：试学费（整档）/ 正式学费（多选，合计自动算）
 *   ② 缴费方式改下拉选择：微信支付 / 支付宝支付 / 银行卡转账 / 现金 / 其他
 *   ③ 凭证就在这个弹窗里上传，不用建完单再去列表二次操作
 *
 * ★ 2026-10-26 用户口径：「取消掉试学费」——
 *   收费类型二选一整个去掉，发起收费只有正式学费（多选明细 + 自动合计）。
 */

/**
 * ★ 2026-10-23 用户口径：费用类型筛选只留 3 个 —— 学费 / 试学费 / 补学费
 *
 * 住宿费 / 餐费 / 保险费 / 押金 / 校服 是「学费里的明细项」，
 * 发起收费时作为勾选项（见 FORMAL_FEE_ITEMS），不再作为独立费用类型出现在筛选里。
 *
 * ⚠️ 历史单据里仍有「试学费」，筛选项保留，否则老数据查不出来。
 */
const FEE_TYPE_FILTER_OPTIONS = [FeeType.TUITION, FeeType.TRIAL_FEE, FeeType.SUPPLEMENT].map(
  (v) => ({ value: v, label: FEE_TYPE_NAME[v] }),
);

/**
 * 正式学费的可选项（6 项）
 *
 * ⚠️ fallback 只是【财务标准取不到时的兜底展示值】（单位：元），
 *    真实金额一律以 t_finance_fee_standard 为准（规则2：金额由财务取值，不让手填）。
 *    calc 是给老师看的算式说明（如住宿费 = 450 × 6 个月）。
 *
 * ★ 2026-10-26 用户口径：
 *    ① 「试学费默认 5000，可以自己设置，还有正式学费」——
 *       本弹窗顶部有「收费类型」二选一：试学费（单收一笔，金额可改）/ 正式学费（勾选下列各项）。
 *       试学费不是这里的勾选项，它走独立的金额输入（见 trialAmount）。
 *    ② 「住宿费一个月 450，默认缴纳 6 个月，可以自己选择缴纳几个月」——
 *       住宿费不是固定 2700，而是「月单价 × 月数」，见 accommodationMonths。
 */
const FORMAL_FEE_ITEMS = [
  { feeType: FeeType.TUITION, label: '学费', calc: '', fallback: 28000 },
  { feeType: FeeType.ACCOMMODATION, label: '住宿费', calc: '', fallback: 2700 },
  { feeType: FeeType.DEPOSIT, label: '押金', calc: '', fallback: 200 },
  { feeType: FeeType.INSURANCE, label: '保险费', calc: '', fallback: 150 },
  { feeType: FeeType.MEAL, label: '餐费', calc: '', fallback: 850 },
  { feeType: FeeType.UNIFORM, label: '校服', calc: '', fallback: 500 },
];

/**
 * ★ 2026-10-26 住宿费按月计价
 *
 * 财务「住宿费」标准价是【6 个月】的价（2700 = 450 × 6），
 * 所以月单价 = 标准价 ÷ 6；老师选几个月就乘几个月。
 */
const ACCOMMODATION_BASE_MONTHS = 6;
/** 住宿月数：默认 6 个月，可改成 1~12 个月 */
const accommodationMonths = ref(ACCOMMODATION_BASE_MONTHS);
/** 住宿费月单价（元）：财务标准 ÷ 6，取不到标准用 450 兜底 */
const accommodationUnitPrice = computed(() => {
  const std = standardMap.value[FeeType.ACCOMMODATION];
  return std == null ? 450 : std / 100 / ACCOMMODATION_BASE_MONTHS;
});
/** 住宿费应缴（元）= 月单价 × 月数 */
const accommodationAmount = computed(() => accommodationUnitPrice.value * accommodationMonths.value);

/**
 * ★ 2026-10-27 学费实收金额（元）
 *
 * 用户口径：「发起收费这里的正式学费里的学费可以修改，优惠是学费里的」
 *
 *   null = 老师没改过 → 学费按财务标准价（默认 28000）；
 *   有值 = 老师填的谈定价（可小于标准，差额就是学费优惠；不允许高于标准）。
 *
 * ⚠️ 为什么不再单独搞一个「实缴金额」输入框：
 *    两套减免入口（改学费 / 改实缴）容易双算，账面对不上。
 *    现在减免只有一个来源 —— 学费。
 *
 * ★ 2026-10-27 用户口径：「应缴不变，实缴优惠保持现状」
 *    改学费只影响「实缴」和「优惠」，**不改应缴**：
 *      应缴 = 各项财务标准之和（学费 28000 + 住宿 …），始终是标准价；
 *      优惠 = 学费标准 − 学费实收；
 *      实缴 = 应缴 − 优惠 = 合计 = 本次实际收取。
 *    这样账面恒等（28000 − 2000 = 26000），也和库里
 *    standardAmount / amount / discount 三个字段一一对应。
 */
const tuitionAmount = ref<number | null>(null);

/** 学费财务标准价（元） */
const tuitionStd = computed(() => amountYuan(FeeType.TUITION, 28000));

/** 学费金额输入框：没改过时显示标准价，改了就用老师的；不能高于标准 */
const tuitionInput = computed({
  get: () => tuitionAmount.value ?? tuitionStd.value,
  set: (v: number) => {
    if (!Number.isFinite(v)) {
      tuitionAmount.value = null;
      return;
    }
    tuitionAmount.value = Math.max(0, Math.min(Number(v), tuitionStd.value));
  },
});

/* ============================================================
 * ★ 2026-10-26 收费类型：试学费 / 正式学费（用户口径恢复试学费）
 *
 * 「发起收费哪里，费用类型，试学费默认 5000 可以自己设置，还有正式学费」
 *   · 试学费：单收一笔，金额默认取财务标准（5000），老师可以改成实际谈定的数；
 *   · 正式学费：勾选费用项目（学费/住宿费/押金/保险费/餐费/校服），走优惠规则。
 *
 * 默认选「正式学费」—— 日常绝大多数是正式收费，试学费是少数场景，
 * 默认落在试学费上容易误建单。
 * ============================================================ */
type FeeCategory = 'TRIAL' | 'FORMAL';

/** 试学费默认金额兜底（元）：财务标准取不到时用 5000 */
const TRIAL_FEE_FALLBACK = 5000;

/**
 * 试学费实收金额（元）
 *
 * null = 老师没改过 → 跟随财务标准（默认 5000）；
 * 有值 = 老师本次填的金额（试学费常按家长谈定的数收，所以必须能改）。
 */
const trialAmount = ref<number | null>(null);

/** 试学费金额输入框：没改过时显示标准值，改了就用老师的 */
const trialAmountInput = computed({
  get: () => trialAmount.value ?? amountYuan(FeeType.TRIAL_FEE, TRIAL_FEE_FALLBACK),
  set: (v: number) => {
    trialAmount.value = Number.isFinite(v) ? v : null;
  },
});

const createVisible = ref(false);
const creating = ref(false);
const createForm = ref<{
  consultStudentId: string;
  /** ★ 2026-10-26 收费类型：试学费 / 正式学费 */
  category: FeeCategory;
  formalFeeTypes: number[];
  payMethod: string;
  /** 弹窗内选择的凭证（base64 预览/上传用） */
  dataUrl: string;
  voucherNo: string;
  /**
   * ★ 2026-10-26 优惠名目（有优惠时必选）
   *
   * 用户口径：「优惠金额要有明确的名目」—— 优惠不能只是一个差额，
   * 必须说明是按什么名目少的（奖学金 / 活动优惠 / 困难减免…）。
   */
  discountReason: string;
}>({
  consultStudentId: '',
  category: 'FORMAL',
  formalFeeTypes: [],
  payMethod: '',
  dataUrl: '',
  voucherNo: '',
  discountReason: '',
});

/* ---------- 学生选择（★ 2026-10-08：必填项由「学生ID」改为「学生姓名」） ---------- */
const studentOptions = ref<Array<{ consultStudentId: string; studentName: string; consultStateName?: string }>>([]);
const studentSearching = ref(false);

/**
 * 远程搜索学生（按姓名/学号模糊匹配）
 *
 * ★ 2026-10-22 用户口径：「发起收费那里，学生姓名不允许有正式学生，
 *    只有咨询中的学生，所有的咨询中学生可以选择」——
 *    候选收窄为 consultState = 咨询中(3)，已分班/试学中/正式在读都不再出现在这里。
 *
 * ⚠️ 试用场景不受影响：从列表行内点「收款 / 补费」时由 openCreate 直接把
 *    该学生塞进候选（见下面 openCreate），已分班学生的补费照旧能发起。
 */
async function searchStudents(keyword: string) {
  studentSearching.value = true;
  try {
    const res = await fetchStudentList({
      page: 1,
      size: 20,
      keyword: keyword || undefined,
      // ★ 只列「咨询中」——正式在读/试学中不可再发起首次收费
      consultState: ConsultState.TRIAL_FEE_PENDING,
    });
    studentOptions.value = res.list.map((s: ConsultStudentListItem) => ({
      consultStudentId: s.consultStudentId,
      studentName: s.studentName,
      consultStateName: s.consultStateName,
    }));
  } catch {
    studentOptions.value = [];
  } finally {
    studentSearching.value = false;
  }
}

/**
 * 费用标准（金额单位：分），key = feeType
 *
 * ⚠️ 打开弹窗时一次性把「试学费 + 正式学费六项」全拉下来，
 *    勾选时即时算合计，不用每次勾选都跑一趟接口。
 */
const standardMap = ref<Record<number, number>>({});

async function loadStandards() {
  try {
    const res = await fetchStandardBatch([
      FeeType.TRIAL_FEE,
      ...FORMAL_FEE_ITEMS.map((i) => i.feeType),
    ]);
    const map: Record<number, number> = {};
    (res.list || []).forEach((s: FinanceStandardView) => {
      map[s.feeType] = s.amount;
    });
    standardMap.value = map;
  } catch {
    // 取不到就走兜底展示值，不阻塞老师操作
    standardMap.value = {};
  }
}

/** 某项费用的金额（单位：元）：优先财务标准，取不到用兜底值 */
function amountYuan(feeType: number, fallback: number): number {
  const std = standardMap.value[feeType];
  return std == null ? fallback : std / 100;
}

/** 金额展示：整数不带小数尾巴（450 而不是 450.00） */
function fmtYuan(n: number): string {
  return String(Number(n.toFixed(2)));
}

/**
 * 单项费用的【应缴】金额（元）
 *
 * ★ 2026-10-26 住宿费按月计价：应缴 = 月单价 × 月数（默认 6 个月）；
 *    其余各项仍按财务费用标准取值。
 * ★ 2026-10-27 学费这里取【财务标准价】—— 应缴不随谈定价变化，
 *    改学费只体现在下面的「实缴 / 优惠」两行。
 */
function itemAmount(item: { feeType: number; fallback: number }): number {
  if (item.feeType === FeeType.ACCOMMODATION) return accommodationAmount.value;
  if (item.feeType === FeeType.TUITION) return tuitionStd.value;
  return amountYuan(item.feeType, item.fallback);
}

/** 单项费用的算式说明（住宿费显示「450 × 6 个月」） */
function itemCalc(item: { feeType: number }): string {
  if (item.feeType !== FeeType.ACCOMMODATION) return '';
  return `${fmtYuan(accommodationUnitPrice.value)} × ${accommodationMonths.value} 个月`;
}

/**
 * 本次发起的合计金额（单位：元）
 *
 * ★ 2026-10-26 试学费：合计 = 老师填的试学费金额（试学费没有优惠概念）。
 * ★ 2026-10-27 正式学费：合计 = 实缴 = 应缴 − 优惠（优惠已在学费里减掉）。
 */
const createTotal = computed(() =>
  createForm.value.category === 'TRIAL' ? trialAmountInput.value : formalActual.value,
);

/** 正式学费的【应缴】合计（元）：勾选各项的财务标准之和（住宿费按月数） */
const formalDue = computed(() =>
  createForm.value.formalFeeTypes.reduce((sum, ft) => {
    const item = FORMAL_FEE_ITEMS.find((i) => i.feeType === ft);
    return sum + (item ? itemAmount(item) : 0);
  }, 0),
);

/**
 * 正式学费的【优惠】（元）= 学费标准价 − 学费实收价
 *
 * 用户口径：「优惠是学费里的」—— 减免只能来自学费，其他项不参与。
 * 学费输入框已钳制 ≤ 标准价，所以这里恒 ≥ 0，不会出现「补收」。
 */
const formalDiscount = computed(() => {
  if (!createForm.value.formalFeeTypes.includes(FeeType.TUITION)) return 0;
  return Math.max(0, tuitionStd.value - tuitionInput.value);
});

/**
 * 正式学费的【实缴】合计（元）= 应缴 − 优惠
 *
 * 用户口径：「应缴不变，实缴优惠保持现状」—— 应缴是标准价合计，
 * 实缴才是本次真正要收的钱，也是单据金额。
 */
const formalActual = computed(() => Math.max(0, formalDue.value - formalDiscount.value));

/** 是否勾了学费（只有勾了学费才可能产生优惠） */
const canDiscount = computed(() => createForm.value.formalFeeTypes.includes(FeeType.TUITION));

/** 改勾选 / 改住宿月数 / 切换收费类型时，学费金额回到「按标准」 */
watch(
  () => [
    createForm.value.category,
    createForm.value.formalFeeTypes.join(','),
    accommodationMonths.value,
  ],
  () => {
    tuitionAmount.value = null;
  },
);

/**
 * 本次实际要发起的费用类型列表
 *
 * ★ 2026-10-26 试学费 → 只发一张试学费单；正式学费 → 勾选的那些项。
 */
const currentFeeTypes = computed<FeeType[]>(() =>
  createForm.value.category === 'TRIAL'
    ? [FeeType.TRIAL_FEE]
    : (createForm.value.formalFeeTypes as FeeType[]),
);

/** 弹窗里的凭证选文件 → 转 base64 */
function onCreateFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('图片不能超过 5MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    createForm.value.dataUrl = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

function openCreate(row?: ConsultFeeOrder) {
  createForm.value = {
    consultStudentId: row?.consultStudentId || '',
    // ★ 2026-10-26 每次打开默认「正式学费」
    category: 'FORMAL',
    formalFeeTypes: [],
    payMethod: '',
    dataUrl: '',
    voucherNo: '',
    // ★ 2026-10-26 优惠名目每次打开都清空（不能把上一单的名目带过来）
    discountReason: '',
  };
  // 每次打开都回到「按标准取值」，不把上一次手填的学费带过来
  tuitionAmount.value = null;
  // ★ 2026-10-26 试学费金额回到财务标准（默认 5000），不记住上一单的手填值
  trialAmount.value = null;
  // ★ 2026-10-26 住宿月数默认 6 个月（财务标准价对应的月数）
  accommodationMonths.value = ACCOMMODATION_BASE_MONTHS;
  // 从行内带出学生：把该学生放进候选，保证下拉能显示姓名
  studentOptions.value = row?.consultStudentId
    ? [{ consultStudentId: row.consultStudentId, studentName: row.studentName }]
    : [];
  createVisible.value = true;
  loadStandards();
}

async function submitCreate() {
  const f = createForm.value;
  if (!f.consultStudentId) {
    ElMessage.warning('请选择学生');
    return;
  }
  if (!f.payMethod) {
    ElMessage.warning('请选择缴费方式');
    return;
  }
  const feeTypes = currentFeeTypes.value;
  if (f.category === 'FORMAL' && !feeTypes.length) {
    ElMessage.warning('请至少勾选一项费用');
    return;
  }
  /**
   * ★ 2026-10-15 凭证必填：
   *    列表与详情都取消了补传入口，这里不传，单据会永远停在「待上传凭证」。
   */
  if (!f.dataUrl) {
    ElMessage.warning('请先上传缴费凭证截图');
    return;
  }

  /**
   * ★ 2026-10-26 金额怎么传：
   *   ① 试学费：金额由老师填（默认 5000），原样传给后端，不算优惠、不要名目；
   *   ② 正式学费：住宿费按「月单价 × 月数」计价 → 传 accommodationMonths；
   *      学费可改（谈定价），改小的差额就是优惠，只传「学费」这一项的自定义金额，
   *      其余各项一律按财务标准全额，不参与优惠。
   */
  const amountByType: Record<number, number> = {};
  let diff = 0;

  if (f.category === 'TRIAL') {
    const trialYuan = Number(trialAmountInput.value);
    if (!Number.isFinite(trialYuan) || trialYuan <= 0) {
      ElMessage.warning('请填写试学费金额（需大于 0）');
      return;
    }
    amountByType[FeeType.TRIAL_FEE] = Math.round(trialYuan * 100);
  } else {
    /**
     * ★ 2026-10-27 用户口径：「正式学费里的学费可以修改，优惠是学费里的」
     *
     * 学费在弹窗里直接改（默认财务标准价），改小 → 差额记为学费优惠，必须选名目；
     * 其他费用项不可改，一律按标准全额（优惠只能来自学费）。
     */
    const due = Number(formalDue.value);
    if (!Number.isFinite(due) || due <= 0) {
      ElMessage.warning('请至少勾选一项费用，并确认金额大于 0');
      return;
    }
    diff = Number(formalDiscount.value);
    if (diff > 0) {
      if (!f.discountReason) {
        ElMessage.warning('请选择优惠名目（奖学金 / 活动优惠 / 困难减免…）');
        return;
      }
      amountByType[FeeType.TUITION] = Math.round(Number(tuitionInput.value) * 100);
    }
    /** 应缴是标准价，真正要收的是实缴 —— 减免到 0 元也建不了单 */
    if (formalActual.value <= 0) {
      ElMessage.warning('实缴金额需大于 0，请检查学费金额与优惠');
      return;
    }
  }

  creating.value = true;
  try {
    /**
     * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
     *
     * 顺序改成「先传凭证拿 url → 再建单」，凭证随建单一起落库：
     *   原来「先建单、再绑凭证」一旦第二步失败（如截图被占用），
     *   就会留一张没有凭证的单据，财务永远看不到。
     */
    const up = await uploadFile(f.dataUrl, 'voucher');

    const res = await createFees({
      consultStudentId: f.consultStudentId,
      feeTypes,
      payMethod: f.payMethod,
      amountByType: Object.keys(amountByType).length ? amountByType : undefined,
      // ★ 2026-10-26 住宿费月数（只有正式学费勾了住宿费才传）
      accommodationMonths:
        f.category === 'FORMAL' && f.formalFeeTypes.includes(FeeType.ACCOMMODATION)
          ? accommodationMonths.value
          : undefined,
      // ★ 2026-10-26 优惠名目（没优惠就不传，别给单据挂个空名目）
      discountReason: diff > 0 ? f.discountReason || undefined : undefined,
      voucherUrl: up.url,
      voucherNo: f.voucherNo || undefined,
    });

    ElMessage.success(res.message || '已发起收费，凭证已上传，等待财务确认');
    createVisible.value = false;
    load();
  } catch (err: any) {
    ElMessage.error(err?.message || '发起收费失败');
  } finally {
    creating.value = false;
  }
}

/**
 * ★ 2026-10-19 已废弃 bindVoucher（「先建单、再绑凭证」的两步流）。
 *
 * 用户口径「只要缴费就要有凭证」→ 现在改成「先传凭证拿 url，再建单」，
 * 凭证随建单一起落库，不会再出现「单建了、凭证没绑上」的中间态。
 */

/* ============================================================
 * ★ 2026-10-20 补费（试学转正尾款 / 差额补收，金额自定义）
 *
 * 用户口径：「交了试学费的，后边在收款与缴费管理那儿操作里面
 *            添加一个补费功能，补费金额自定义。」
 *
 * 入口只挂在【试学费且已到账】那一行：还没交过试学费的学生不显示。
 * 金额默认带出「全款缺口」，老师可以改成实际收到的数（可能有优惠/只补一部分）。
 * ============================================================ */

const suppVisible = ref(false);
const suppRow = ref<ConsultFeeOrder | null>(null);
/** 全款缺口预览（调 /supplement-plan，失败不挡操作） */
const suppPlan = ref<ConsultSupplementPlan | null>(null);
const suppLoading = ref(false);
const suppSaving = ref(false);
const suppForm = ref({
  payMethod: '',
  remark: '试学转正补缴尾款',
  dataUrl: '',
  voucherNo: '',
});

/**
 * ★ 2026-10-27 补费明细（用户口径：「补费也要有具体明细」）
 *
 * 补费不再是一笔说不清来源的总额：把「还差的费用项」逐项列出来
 * （学费 / 住宿费 / 餐费 / 保险费），老师按实收填，合计就是补费单金额。
 * 明细随单据落库（item_detail），详情页会逐项显示，财务核对时有据可查。
 */
interface SuppItem {
  feeType: number;
  feeTypeName: string;
  /** 该项应补（缺口，元） */
  dueYuan: number;
  /** 本次补缴（元）：默认 = 缺口，可改小 */
  amountYuan: number;
  /** 没有缺口数据时的兜底行：允许自由填一笔（如全款已到账的追加补收） */
  custom?: boolean;
}

const suppItems = ref<SuppItem[]>([]);

/** 补费合计（元）= 明细各项之和；后端也会自己再加一遍，不信任前端 total */
const suppTotalYuan = computed(() =>
  suppItems.value.reduce((s, i) => s + (Number(i.amountYuan) || 0), 0),
);

/**
 * 该学生是否已经补过费
 *
 * ★ 2026-10-22 用户口径：同一学生**只能补费一次**（不是「一次在途」）。
 *   已到账的补费也算用掉了机会，否则试学费那一行永远能点补费，学生会被反复补费。
 *   只有被财务驳回的不算（钱没到账，允许改金额重来）。
 *
 * 后端 `createSupplementFee` 有同样的门槛兜底；这里只是把按钮提前藏掉。
 */
function alreadySupplemented(studentId: string): boolean {
  return list.value.some(
    (o) =>
      String(o.consultStudentId) === String(studentId) &&
      Number(o.feeType) === FeeType.SUPPLEMENT &&
      o.status !== ConsultFeeStatus.REJECTED,
  );
}

/** 已缴试学费、且还没补过费的行才给「补费」入口 */
function canSupplement(row: ConsultFeeOrder): boolean {
  if (Number(row.feeType) !== FeeType.TRIAL_FEE) return false;
  if (row.status !== ConsultFeeStatus.ARRIVED) return false;
  return !alreadySupplemented(row.consultStudentId);
}

async function openSupplement(row: ConsultFeeOrder) {
  suppRow.value = row;
  suppPlan.value = null;
  suppItems.value = [];
  suppForm.value = {
    payMethod: '',
    remark: '试学转正补缴尾款',
    dataUrl: '',
    voucherNo: '',
  };
  suppVisible.value = true;

  suppLoading.value = true;
  try {
    const plan = await fetchSupplementPlan(row.consultStudentId);
    suppPlan.value = plan;
    /**
     * 只列「还差」的项（未发起 / 已驳回）：
     *   · 已到账(ARRIVED)  → 不用补；
     *   · 在途(PENDING)    → 钱已经在路上，不能重复补，等财务确认。
     * 后端 `/supplement-plan` 已经把这两类算好了，直接用它的 missing。
     */
    const missing = new Set<number>(plan.missing || []);
    const rows: SuppItem[] = (plan.items || [])
      .filter((i) => missing.has(i.feeType) && Number(i.amount) > 0)
      .map((i) => ({
        feeType: i.feeType,
        feeTypeName: i.feeTypeName,
        dueYuan: Number(i.amount) / 100,
        amountYuan: Number(i.amount) / 100,
      }));

    /**
     * 兜底：缺口为 0（全款已到账/在途）时仍允许补一笔，
     * 这时没有明细可拆，就退化成一行「补学费」让老师自己填金额。
     */
    suppItems.value = rows.length
      ? rows
      : [
          {
            feeType: FeeType.SUPPLEMENT,
            feeTypeName: FEE_TYPE_NAME[FeeType.SUPPLEMENT] || '补学费',
            dueYuan: 0,
            amountYuan: 0,
            custom: true,
          },
        ];
  } catch {
    // 预览失败不影响补费：退化成一行自定义金额，老师照实收填
    suppItems.value = [
      {
        feeType: FeeType.SUPPLEMENT,
        feeTypeName: FEE_TYPE_NAME[FeeType.SUPPLEMENT] || '补学费',
        dueYuan: 0,
        amountYuan: 0,
        custom: true,
      },
    ];
  } finally {
    suppLoading.value = false;
  }
}

function onSuppFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('图片不能超过 5MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    suppForm.value.dataUrl = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function submitSupplement() {
  const row = suppRow.value;
  if (!row) return;

  /**
   * ★ 2026-10-27 明细校验（用户口径：「补费也要有具体明细」）
   *   每项可以留 0（这次先不补这项），但整单不能都是 0；
   *   合计由后端再算一遍，不信任前端传的 total。
   */
  const items = suppItems.value
    .map((i) => ({
      feeType: i.feeType,
      amount: Math.round((Number(i.amountYuan) || 0) * 100),
    }))
    .filter((i) => i.amount > 0);

  if (!items.length) {
    ElMessage.warning('请填写补费明细：至少一项金额要大于 0');
    return;
  }
  const totalAmount = items.reduce((s, i) => s + i.amount, 0);
  if (!suppForm.value.payMethod) {
    ElMessage.warning('请选择缴费方式');
    return;
  }
  if (!suppForm.value.dataUrl) {
    ElMessage.warning('请先上传缴费凭证截图');
    return;
  }

  suppSaving.value = true;
  try {
    // 先传图拿 url，再建单 —— 与「发起收费」同一顺序，凭证随单落库
    const up = await uploadFile(suppForm.value.dataUrl, 'voucher');
    const res = await createSupplementFee({
      consultStudentId: row.consultStudentId,
      // 明细优先：后端按明细加总，amount 只作兼容字段
      items,
      amount: totalAmount,
      voucherUrl: up.url,
      voucherNo: suppForm.value.voucherNo || undefined,
      payMethod: suppForm.value.payMethod,
      remark: suppForm.value.remark || undefined,
    });

    const yuanText = (totalAmount / 100).toFixed(2);
    ElMessage.success(
      res ? `补费 ¥${yuanText} 已发起，等待财务确认到账` : '补费已发起',
    );
    suppVisible.value = false;
    load();
  } catch (err: any) {
    ElMessage.error(err?.message || '发起补费失败');
  } finally {
    suppSaving.value = false;
  }
}

/* ---------- 上传凭证 ---------- */

/**
 * ★ 2026-10-15 一次缴清的多项费用在列表里是【一行】，但底下是 N 张单据。
 *    上传凭证 / 重新提交都要作用到这一行覆盖的全部单据上（一张截图挂多张单）。
 */
function orderIdsOf(row: ConsultFeeOrder): string[] {
  const ids = row.orderIds?.filter(Boolean) || [];
  return ids.length ? ids : [row.orderId];
}

/**
 * ★ 2026-10-15 用户口径：凭证只能在【发起收费】弹窗里上传。
 *    列表操作列、详情弹窗都不再提供独立的「上传凭证 / 重新上传」入口，
 *    相关的 voucherVisible / voucherForm / openVoucher / onFileChange / submitVoucher
 *    一并移除，避免出现「以为能在列表补传、其实入口不存在」的死胡同。
 *
 *    被驳回的单据如需换凭证：对该学生重新发起一次收费，在新弹窗里上传新截图。
 */

/* ---------- 重新提交 ---------- */
async function doResubmit(row: ConsultFeeOrder) {
  const ids = orderIdsOf(row);
  await ElMessageBox.confirm(
    ids.length > 1
      ? `确认重新提交单号 ${row.orderNo}（含 ${ids.length} 项费用）？提交后财务将重新核对。`
      : `确认重新提交单号 ${row.orderNo}？提交后财务将重新核对。`,
    '重新提交',
    { type: 'warning' },
  );
  for (const id of ids) {
    await resubmitOrder(id).catch(() => {});
  }
  ElMessage.success('已重新提交');
  load();
}

/* ---------- ★ 2026-10-19 作废（重复发起 / 发起错了） ---------- */
/**
 * 为什么要给老师这个入口：
 *   以前没有撤销通道，多发起一笔后只能再发起一次去「覆盖」，
 *   结果同一费用项堆出好几张单，账面像交了好几次钱。
 *
 * ⚠️ 整批作废：一张凭证可能覆盖多张单据（row.orderIds），只作废一张会留下半截。
 */
async function doCancel(row: ConsultFeeOrder) {
  const ids = orderIdsOf(row);
  try {
    await ElMessageBox.confirm(
      `确认作废单号 ${row.orderNo}（${row.feeTypeName} ¥${row.amountYuan}）？` +
        (ids.length > 1 ? `\n该行含 ${ids.length} 张单据，将整批作废。` : '') +
        `\n作废后财务侧同步撤销，不可恢复；如果这笔钱已经到账，请改走「退费」。`,
      '作废收款单',
      { type: 'warning', confirmButtonText: '确认作废', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  const res = await cancelFeeOrders(ids, '重复发起，人工作废');
  if (res.skipped?.length) {
    ElMessage.warning(
      `已作废 ${res.cancelled} 张；未作废：${res.skipped
        .map((s) => `${s.orderNo}（${s.reason}）`)
        .join('；')}`,
    );
  } else {
    ElMessage.success(`已作废 ${res.cancelled} 张单据`);
  }
  load();
}

/* ---------- 展示辅助 ---------- */
const fmtMoney = (cent?: number) => (cent == null ? '—' : `¥${(cent / 100).toFixed(2)}`);

const statusTag = (s: number) => {
  if (s === ConsultFeeStatus.ARRIVED) return 'success';
  if (s === ConsultFeeStatus.PENDING) return 'warning';
  if (s === ConsultFeeStatus.REJECTED) return 'danger';
  return 'info';
};

/**
 * ★ 2026-10-15 凭证直接在列表「缴费凭证」列以缩略图展示（点击放大），
 *    不再需要单独的看图弹窗 —— imgVisible / imgUrl / imgTitle / openVoucherImage 已移除。
 */

/* ---------- ★ 2026-10-15 收费单详情（操作列「查看」） ---------- */
/**
 * 缴费完成（已到账）后，老师主要想做的是「回看这一笔到底收了多少、凭证长啥样」，
 * 所以操作列统一给一个「查看」入口，弹出详情 + 缴费截图（点图可放大）。
 */
const detailVisible = ref(false);
const detailRow = ref<ConsultFeeOrder | null>(null);

function openDetail(row: ConsultFeeOrder) {
  detailRow.value = row;
  detailVisible.value = true;
}

/* ---------- ★ 2026-10-16 分期计划详情 ---------- */
const planVisible = ref(false);
const planLoading = ref(false);
const planRow = ref<ConsultInstallmentPlan | null>(null);

/** 从分期收款单打开所属计划 */
async function openPlan(row: ConsultFeeOrder) {
  if (!row.planId) return;
  planLoading.value = true;
  planVisible.value = true;
  try {
    planRow.value = await fetchInstallmentDetail(row.planId);
  } catch (err: any) {
    ElMessage.error(err?.message || '分期计划加载失败');
    planVisible.value = false;
  } finally {
    planLoading.value = false;
  }
}

/**
 * ★ 2026-10-16 用户口径：无论一次性还是分期，发起收款都要当场传凭证，
 *    传完状态直接「待确认（待财务确认）」。这里改成弹窗选图，不再只弹确认框。
 */
const stagePayVisible = ref(false);
const stagePaySubmitting = ref(false);
const stagePayItem = ref<ConsultInstallmentItem | null>(null);
const stagePayForm = ref({ dataUrl: '', voucherNo: '' });

function openPayStage(item: ConsultInstallmentItem) {
  if (!planRow.value) return;
  stagePayItem.value = item;
  stagePayForm.value = { dataUrl: '', voucherNo: '' };
  stagePayVisible.value = true;
}

function onStagePayFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('图片不能超过 5MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    stagePayForm.value.dataUrl = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function submitPayStage() {
  if (!planRow.value || !stagePayItem.value) return;
  if (!stagePayForm.value.dataUrl) {
    ElMessage.warning('请先上传缴费凭证截图');
    return;
  }
  stagePaySubmitting.value = true;
  try {
    const up = await uploadFile(stagePayForm.value.dataUrl, 'voucher');
    planRow.value = await payInstallmentStage({
      planId: planRow.value.planId,
      stageNo: stagePayItem.value.stageNo,
      voucherUrl: up.url,
      voucherNo: stagePayForm.value.voucherNo || undefined,
    });
    ElMessage.success(`第 ${stagePayItem.value.stageNo} 期收款单已发起，等待财务确认到账`);
    stagePayVisible.value = false;
    load();
  } catch (err: any) {
    ElMessage.error(err?.message || '发起失败');
  } finally {
    stagePaySubmitting.value = false;
  }
}

/** 期次状态 → Tag 类型 */
function stageTagType(item: ConsultInstallmentItem): string {
  if (item.status === 2) return 'success'; // 已到账
  if (item.status === 1) return 'warning'; // 待确认
  if (item.postponeCount) return 'warning'; // 顺延过（到期未缴自动后移）
  return 'info'; // 待缴
}

/**
 * ★ 2026-10-16 用户口径：分期单不再显示「待上传凭证」，
 *    但要在分期的操作处留一个「补缴凭证」入口 —— 分期是逐期发起收款的，
 *    历史单（或漏传的单据）如果一直没凭证，财务没法核对到账。
 */
const voucherVisible = ref(false);
const voucherSubmitting = ref(false);
const voucherTarget = ref<{
  orderId: string;
  /** 该行覆盖的全部单据（合并单可能不止一张） */
  orderIds?: string[];
  orderNo?: string;
  studentName: string;
  label: string;
} | null>(null);
const voucherForm = ref({ dataUrl: '', voucherNo: '' });

/** 从列表行打开（任何未到账、没凭证的单据） */
function openVoucher(row: ConsultFeeOrder) {
  if (!row.orderId) return;
  voucherTarget.value = {
    orderId: row.orderId,
    orderIds: orderIdsOf(row),
    orderNo: row.orderNo,
    studentName: row.studentName,
    label: row.stageText ? `${row.stageText} · ${row.feeTypeName}` : row.feeTypeName,
  };
  voucherForm.value = { dataUrl: '', voucherNo: '' };
  voucherVisible.value = true;
}

/** 从分期计划弹窗的期次行打开 */
function openVoucherForItem(item: ConsultInstallmentItem) {
  if (!item.feeOrderId || !planRow.value) return;
  voucherTarget.value = {
    orderId: item.feeOrderId,
    orderIds: [item.feeOrderId],
    orderNo: item.orderNo,
    studentName: planRow.value.studentName,
    label: `第 ${item.stageNo} 期应收 ¥${item.dueAmountYuan}`,
  };
  voucherForm.value = { dataUrl: '', voucherNo: '' };
  voucherVisible.value = true;
}

function onVoucherFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    ElMessage.error('图片不能超过 5MB');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    voucherForm.value.dataUrl = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function submitVoucher() {
  if (!voucherTarget.value) return;
  if (!voucherForm.value.dataUrl) {
    ElMessage.warning('请先上传缴费凭证截图');
    return;
  }
  voucherSubmitting.value = true;
  try {
    const up = await uploadFile(voucherForm.value.dataUrl, 'voucher');
    const ids = voucherTarget.value.orderIds?.length
      ? voucherTarget.value.orderIds
      : [voucherTarget.value.orderId];
    for (const id of ids) {
      await uploadVoucher(id, up.url, voucherForm.value.voucherNo || undefined);
    }
    ElMessage.success(`凭证已上传（${ids.length} 张单据），状态 → 待财务确认`);
    voucherVisible.value = false;
    if (planRow.value) {
      planRow.value = await fetchInstallmentDetail(planRow.value.planId);
    }
    load();
  } catch (err: any) {
    ElMessage.error(err?.message || '凭证上传失败');
  } finally {
    voucherSubmitting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <!-- 统计 -->
    <div v-if="stats" class="stats">
      <el-card shadow="never" class="stat">
        <div class="stat-label">收款单总数</div>
        <div class="stat-value">{{ stats.voucherCount + stats.pendingCount + stats.arrivedCount }}</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="stat-label">被驳回</div>
        <div class="stat-value warn">{{ stats.rejectedCount }}</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="stat-label">待财务确认</div>
        <div class="stat-value warn">{{ stats.pendingCount }}</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="stat-label">已到账金额</div>
        <div class="stat-value ok">{{ fmtMoney(stats.arrivedAmount) }}</div>
      </el-card>
    </div>

    <!-- 列表（单卡片通栏：条件行 + 工具条 + 表格 + 分页，与财务模块版式一致） -->
    <el-card shadow="never" class="table-card card-flush">
      <!-- 条件行 -->
      <div class="filter-row">
        <el-input
          v-model="query.keyword"
          placeholder="搜索学生姓名 / 咨询老师 / 班级 / 单号"
          clearable
          style="max-width: 280px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="query.feeType" placeholder="全部费用类型" clearable style="width: 150px">
          <!-- ★ 2026-10-23 只留学费 / 试学费 / 补学费（明细项不单独筛） -->
          <el-option
            v-for="opt in FEE_TYPE_FILTER_OPTIONS"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </el-select>
        <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 140px">
          <el-option
            v-for="(name, val) in CONSULT_FEE_STATUS_NAME"
            :key="val"
            :value="Number(val)"
            :label="name"
          />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
      </div>

      <!-- 工具条：左主按钮，右统计 -->
      <div class="table-toolbar">
        <div class="tools">
          <el-button type="primary" @click="openCreate()">＋ 发起收费</el-button>
        </div>
        <div class="tools">
          <span class="stat-line">共 <b>{{ total }}</b> 条收费单 · 待财务确认 <b>{{ stats?.pendingCount ?? 0 }}</b> 笔</span>
        </div>
      </div>

      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column label="学生" min-width="140">
          <template #default="{ row }">
            <div class="stu-name">{{ row.studentName }}</div>
            <div class="stu-sub">{{ row.className || '未分班' }}</div>
          </template>
        </el-table-column>

        <el-table-column prop="orderNo" label="单号" width="160" />

        <!-- ★ 2026-10-15 一次缴清的多项费用不再分多条列，只显示「包含哪些」 -->
        <el-table-column label="费用类型" min-width="170">
          <template #default="{ row }">
            <el-tag size="small">{{ row.feeTypeName }}</el-tag>
            <!-- 老的多单合并行 & 新的「一张合计单」都要显示包含哪些 -->
            <div v-if="row.included && row.included.length > 1" class="fee-included">
              含：{{ row.included.map((i: any) => i.feeTypeName).join('、') }}
            </div>
            <!-- ★ 2026-10-16 分期：标出这是第几期，点击可看整个分期计划 -->
            <el-tag
              v-if="row.stageText"
              size="small"
              type="warning"
              class="stage-tag"
              @click="openPlan(row)"
            >
              {{ row.stageText }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="金额" width="130">
          <template #default="{ row }">
            {{ row.amountYuan }}
            <div v-if="row.stageText && row.totalDueAmountYuan" class="fee-included">
              整单应收 {{ row.totalDueAmountYuan }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="咨询侧状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row.status)">{{ row.statusName }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="财务侧状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.financePayStatusName" size="small" type="info">
              {{ row.financePayStatusName }}
            </el-tag>
            <span v-else class="stu-sub">—</span>
          </template>
        </el-table-column>

        <!--
          ★ 2026-10-22 用户口径：「财务侧状态和操作人不对」
            操作人 / 操作时间改为随状态走：
              · 财务已核对 → 财务核对人 + 核对时间（后端 operatorName / operatorTime）
              · 还没核对   → 咨询发起人 + 发起时间
            想看「发起人是谁」可以去详情弹窗，那里两个都列出来了。
        -->
        <el-table-column label="操作人" width="110">
          <template #default="{ row }">
            <span v-if="row.operatorName">{{ row.operatorName }}</span>
            <span v-else class="stu-sub">—</span>
          </template>
        </el-table-column>

        <el-table-column label="操作时间" width="170">
          <template #default="{ row }">
            <span v-if="row.operatorTime">{{ row.operatorTime }}</span>
            <span v-else class="stu-sub">—</span>
          </template>
        </el-table-column>

        <!-- ★ 缴费凭证直接显示缩略图，点击放大 -->
        <el-table-column label="缴费凭证" width="110" align="center">
          <template #default="{ row }">
            <el-image
              v-if="row.voucherUrl"
              :src="row.voucherUrl"
              :preview-src-list="[row.voucherUrl]"
              fit="cover"
              :initial-index="0"
              class="voucher-thumb"
              preview-teleported
            >
              <template #error>
                <div class="thumb-fail" title="凭证文件缺失，请重新发起收费并上传">缺</div>
              </template>
            </el-image>
            <span v-else class="stu-sub">未上传</span>
          </template>
        </el-table-column>

        <el-table-column prop="lastAction" label="最近操作" min-width="200" show-overflow-tooltip />

        <el-table-column label="操作" width="370" fixed="right">
          <template #default="{ row }">
            <!-- ★ 2026-10-15 任何状态都能「查看」：详情里含缴费截图，点图可放大 -->
            <el-button link type="primary" @click="openDetail(row)">查看</el-button>
            <!--
              ★ 2026-10-20 补费（用户口径）：
                只对「已缴试学费」的行开放 —— 试学结束后补缴尾款 / 补差额，
                金额老师自定义。补费单单独记「补学费」，不占用学费额度。
            -->
            <el-button v-if="canSupplement(row)" link type="success" @click="openSupplement(row)">
              补费
            </el-button>
            <el-button
              v-if="row.status === ConsultFeeStatus.REJECTED"
              link
              type="warning"
              @click="doResubmit(row)"
            >
              重新提交
            </el-button>
            <!--
              ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
                任何还没有凭证的单据（含历史单、分期单，甚至已到账但漏图的），
                都必须留补传入口 —— 否则这张单的凭证永远打不开。
            -->
            <el-button
              v-if="!row.voucherUrl"
              link
              type="warning"
              @click="openVoucher(row)"
            >
              上传凭证
            </el-button>
            <!--
              ★ 2026-10-19 作废入口（重复发起 / 发起错了）：
                以前没有撤销通道，老师只能「再发起一次」去覆盖，
                结果同一费用项堆了好几张单 → 学生档案里出现两组一样的金额。
                已到账的不给作废（要走退费），所以这里按状态隐藏。
            -->
            <el-button
              v-if="row.status !== ConsultFeeStatus.ARRIVED"
              link
              type="danger"
              @click="doCancel(row)"
            >
              作废
            </el-button>
            <!--
              ★ 2026-10-15 用户口径：
                · 缴费完成之后操作是「查看」；
                · 「分班」不在这个页面 —— 已到账的学生去【学生管理】里分班；
                · 「上传凭证」也不在这里 —— 凭证只能在【发起收费】弹窗里上传
                  （驳回的单据如需换凭证，请对该学生重新发起一次收费并上传新截图）。
            -->
          </template>
        </el-table-column>
      </el-table>

      <div class="pager-bar">
        <span>共 {{ total }} 条记录，第 {{ page }}/{{ totalPages }} 页</span>
        <el-pagination
          v-model:current-page="page"
        v-model:page-size="size"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="sizes, prev, pager, next"
        @current-change="load"
        @size-change="search"
        />
      </div>
    </el-card>

    <!-- ============ 发起收费 ============ -->
    <!-- ★ 2026-10-26 用户口径：收费类型分「试学费（金额可自定义）/ 正式学费」；取消分期；优惠只能抵扣学费；住宿费按月计缴 -->
    <el-dialog v-model="createVisible" title="发起收费" width="640px">
      <el-alert type="info" :closable="false" show-icon class="mb">
        <template #title>
          <b>试学费</b>金额默认取财务标准（5000），可按实际谈定的数修改（不算优惠）；
          <b>正式学费</b>金额由财务按「费用标准」自动取值，勾选多项时合计自动计算
          （住宿费按「月单价 × 月数」计，默认 6 个月）。
          <b>缴费凭证请在这里一并上传</b> —— 建单后列表里没有补传入口。
        </template>
      </el-alert>

      <el-form label-width="110px">
        <el-form-item label="学生姓名" required>
          <el-select
            v-model="createForm.consultStudentId"
            filterable
            remote
            clearable
            reserve-keyword
            :remote-method="searchStudents"
            :loading="studentSearching"
            placeholder="输入学生姓名搜索选择（仅咨询中学生）"
            style="width: 100%"
          >
            <el-option
              v-for="s in studentOptions"
              :key="s.consultStudentId"
              :value="s.consultStudentId"
              :label="s.consultStateName ? `${s.studentName}（${s.consultStateName}）` : s.studentName"
            />
          </el-select>
        </el-form-item>

        <!-- ★ 2026-10-26 收费类型：试学费 / 正式学费 -->
        <el-form-item label="收费类型" required>
          <el-radio-group v-model="createForm.category">
            <el-radio value="TRIAL">试学费</el-radio>
            <el-radio value="FORMAL">正式学费</el-radio>
          </el-radio-group>
          <span v-if="createForm.category === 'TRIAL'" class="fee-note">
            单收一笔试学费，金额默认 ¥{{ fmtYuan(amountYuan(FeeType.TRIAL_FEE, TRIAL_FEE_FALLBACK)) }}，可按实际谈定的数修改
          </span>
        </el-form-item>

        <!-- 试学费：金额可自定义（默认 5000，直接改数字即可） -->
        <el-form-item v-if="createForm.category === 'TRIAL'" label="试学费金额" required>
          <el-input-number
            v-model="trialAmountInput"
            :min="0"
            :step="100"
            :precision="2"
            style="width: 200px"
          />
          <span class="fee-note">
            默认按财务标准取值（¥{{ amountYuan(FeeType.TRIAL_FEE, TRIAL_FEE_FALLBACK).toFixed(2) }}），
            实收金额不同可直接修改；试学费不参与优惠，谈定多少就收多少
          </span>
        </el-form-item>

        <!-- 费用项目：卡片式多选框 + 自动算合计 -->
        <el-form-item v-if="createForm.category === 'FORMAL'" required>
          <template #label>
            费用项目
            <span class="fee-lbl-hint">可多选</span>
          </template>
          <el-checkbox-group v-model="createForm.formalFeeTypes" class="fee-grid">
            <el-checkbox v-for="i in FORMAL_FEE_ITEMS" :key="i.feeType" :value="i.feeType">
              <span class="fee-name">{{ i.label }}</span>
              <b class="fee-amt">¥{{ itemAmount(i).toFixed(2) }}</b>
              <!-- ★ 2026-10-27 学费可改：在卡片上标一句，老师一眼知道这项能谈价 -->
              <span v-if="i.feeType === FeeType.TUITION" class="fee-calc">可修改</span>
              <span v-else-if="itemCalc(i)" class="fee-calc">{{ itemCalc(i) }}</span>
            </el-checkbox>
          </el-checkbox-group>
          <div v-if="!createForm.formalFeeTypes.length" class="stu-sub mt8">
            勾选本次要缴的费用项（可多选），合计会自动计算
          </div>
        </el-form-item>

        <!--
          ★ 2026-10-27 用户口径：「正式学费里的学费可以修改，优惠是学费里的」
            学费单独给一个金额输入（勾了学费才出现），默认财务标准价；
            改小 → 差额就是学费优惠（下面「优惠金额」自动算，必须选名目）。
            其他费用项不可改，一律按标准全额。
        -->
        <el-form-item
          v-if="createForm.category === 'FORMAL' && createForm.formalFeeTypes.includes(FeeType.TUITION)"
          label="学费金额"
          required
        >
          <el-input-number
            v-model="tuitionInput"
            :min="0"
            :max="tuitionStd"
            :step="500"
            :precision="2"
            style="width: 200px"
          />
          <span class="fee-note">
            财务标准 ¥{{ tuitionStd.toFixed(2) }}，可按谈定价修改；改小即为学费优惠 —— <b>应缴不变</b>，
            实缴 = 应缴 − 优惠（其他费用项不参与优惠）
          </span>
        </el-form-item>

        <!-- ★ 2026-10-26 住宿费按月缴纳：默认 6 个月，可自选 1~12 个月 -->
        <el-form-item
          v-if="createForm.category === 'FORMAL' && createForm.formalFeeTypes.includes(FeeType.ACCOMMODATION)"
          label="住宿月数"
          required
        >
          <el-input-number
            v-model="accommodationMonths"
            :min="1"
            :max="12"
            :step="1"
            :precision="0"
            style="width: 140px"
          />
          <span class="fee-note">
            月单价 ¥{{ fmtYuan(accommodationUnitPrice) }}（财务标准价 ¥{{
              amountYuan(FeeType.ACCOMMODATION, 2700).toFixed(2)
            }} ÷ 6 个月），本次缴 {{ accommodationMonths }} 个月 → 住宿费合计 ¥{{
              accommodationAmount.toFixed(2)
            }}
          </span>
        </el-form-item>

        <!-- 应缴 / 实缴 / 优惠（仅正式学费：试学费是谈定价，没有应缴/优惠的概念） -->
        <el-form-item v-if="createForm.category === 'FORMAL'" label="应缴金额">
          <b class="amount-strong">¥{{ formalDue.toFixed(2) }}</b>
          <span class="fee-note">各项按财务标准价合计（学费改价不影响应缴）</span>
        </el-form-item>
        <!--
          ★ 2026-10-27 用户口径：「应缴不变，实缴优惠保持现状」
            应缴恒为标准价合计；改学费只落到实缴和优惠两行。
            实缴 = 应缴 − 优惠，也就是本次单据金额 / 合计。
        -->
        <el-form-item v-if="createForm.category === 'FORMAL'" label="实缴金额">
          <b class="amount-strong">¥{{ formalActual.toFixed(2) }}</b>
          <span class="fee-note">= 应缴 − 优惠</span>
        </el-form-item>
        <el-form-item v-if="createForm.category === 'FORMAL'" label="优惠金额">
          <b :class="formalDiscount > 0 ? 'discount-strong' : 'amount-strong'">
            ¥{{ formalDiscount.toFixed(2) }}
          </b>
          <span v-if="formalDiscount <= 0" class="fee-note">无优惠</span>
          <!-- ★ 2026-10-26 优惠只能抵扣学费，其他费用项一律按标准全额收 -->
          <span v-else-if="!canDiscount" class="fee-note danger-text">
            优惠只能抵扣学费，但本次没勾「学费」—— 请勾选学费后再改学费金额
          </span>
          <span v-else class="fee-note">
            学费标准 ¥{{ tuitionStd.toFixed(2) }} − 实收 ¥{{ tuitionInput.toFixed(2) }}，其余费用项不参与优惠
          </span>
        </el-form-item>

        <!--
          ★ 2026-10-26 用户口径：「优惠金额要有明确的名目，优惠只能优惠学费」
            有优惠才出现，且必选 —— 财务核对时要知道这笔少收的钱按什么批的。
        -->
        <el-form-item v-if="createForm.category === 'FORMAL' && formalDiscount > 0 && canDiscount" label="优惠名目" required>
          <el-select
            v-model="createForm.discountReason"
            placeholder="请选择优惠名目"
            style="width: 240px"
          >
            <el-option v-for="r in DISCOUNT_REASONS" :key="r" :label="r" :value="r" />
          </el-select>
          <span class="fee-note">名目会写进单据，财务按此核对减免</span>
        </el-form-item>

        <el-form-item label="合计金额">
          <b class="amount-strong">¥{{ createTotal.toFixed(2) }}</b>
          <span class="fee-note">
            {{ createForm.category === 'TRIAL' ? '本次实际收取（= 试学费金额）' : '本次实际收取（= 实缴）' }}
          </span>
        </el-form-item>

        <!-- ★ 2026-10-26 用户口径：「分期付款这个可以取消掉」—— 收款方式整块去掉，一律一次性缴清 -->

        <el-form-item label="缴费方式" required>
          <el-select
            v-model="createForm.payMethod"
            placeholder="请选择缴费方式"
            style="width: 100%"
          >
            <el-option v-for="m in PAY_METHODS" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>

        <!--
          ★ 2026-10-15：凭证就在这里上传，建完单自动绑到新单据上。
          ★ 必填 —— 列表与详情都已不再提供补传入口，不在这里传就永远传不了。
        -->
        <el-form-item label="缴费凭证" required>
          <input type="file" accept="image/*" @change="onCreateFileChange" />
          <div class="stu-sub mt8">
            必填。一张转账截图可以覆盖本次勾选的多项费用（不超过 5MB）
          </div>
          <div v-if="createForm.dataUrl" class="preview">
            <img :src="createForm.dataUrl" alt="凭证预览" />
          </div>
        </el-form-item>

        <el-form-item label="转账单号">
          <el-input v-model="createForm.voucherNo" placeholder="如微信/支付宝交易单号（选填）" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">确认发起</el-button>
      </template>
    </el-dialog>

    <!-- ============ ★ 2026-10-20 补费（试学转正尾款 / 差额补收，金额自定义） ============ -->
    <el-dialog v-model="suppVisible" title="补费" width="620px">
      <el-alert type="success" :closable="false" show-icon class="mb">
        <template #title>
          补费<strong>按费用项逐项填</strong>（默认带出还差多少，可按实收调小）。
          补费单在列表里单独显示为「补学费」，明细随单保存、详情页可逐项回看；
          财务确认到账后，试学中的学员会自动转为正式在读。
        </template>
      </el-alert>

      <el-descriptions v-if="suppRow" :column="2" border size="small" class="mb">
        <el-descriptions-item label="学生">{{ suppRow.studentName }}</el-descriptions-item>
        <el-descriptions-item label="班级">{{ suppRow.className || '未分班' }}</el-descriptions-item>
        <el-descriptions-item label="已缴试学费">¥{{ suppRow.amountYuan }}</el-descriptions-item>
        <el-descriptions-item label="试学费单号">{{ suppRow.orderNo }}</el-descriptions-item>
        <template v-if="suppPlan">
          <el-descriptions-item label="全款应缴">
            ¥{{ (suppPlan.totalAmount / 100).toFixed(2) }}
          </el-descriptions-item>
          <el-descriptions-item label="全款已到账">
            ¥{{ (suppPlan.arrivedAmount / 100).toFixed(2) }}
          </el-descriptions-item>
          <el-descriptions-item label="还差（参考）" :span="2">
            <b class="amount-strong">¥{{ (suppPlan.missingAmount / 100).toFixed(2) }}</b>
            <span v-if="suppPlan.missing.length" class="fee-note">
              （{{ suppPlan.missing.map((t: number) => FEE_TYPE_NAME[t] || t).join('、') }}）
            </span>
            <span v-if="suppPlan.inFlightAmount" class="fee-note">
              另有 ¥{{ (suppPlan.inFlightAmount / 100).toFixed(2) }} 在途，等财务确认
            </span>
          </el-descriptions-item>
        </template>
      </el-descriptions>
      <div v-if="suppPlan" class="stu-sub" style="margin: -4px 0 12px">
        全款 = 学费 + 住宿费 + 餐费 + 保险费；试学费单独收取、不抵扣全款。
      </div>

      <el-form v-loading="suppLoading" label-width="120px">
        <!-- ★ 2026-10-27 补费明细（用户口径：「补费也要有具体明细」） -->
        <el-form-item label="补费明细" required>
          <el-table :data="suppItems" size="small" border style="width: 100%">
            <el-table-column prop="feeTypeName" label="费用项" min-width="110" />
            <el-table-column label="应补（缺口）" width="120" align="right">
              <template #default="{ row }">
                {{ row.custom ? '自定义' : `¥${Number(row.dueYuan).toFixed(2)}` }}
              </template>
            </el-table-column>
            <el-table-column label="本次补缴（元）" width="180">
              <template #default="{ row }">
                <el-input-number
                  v-model="row.amountYuan"
                  :min="0"
                  :max="row.custom ? undefined : row.dueYuan"
                  :step="100"
                  :precision="2"
                  size="small"
                  controls-position="right"
                  style="width: 100%"
                />
              </template>
            </el-table-column>
          </el-table>
          <div class="stu-sub mt8">
            默认按缺口带出，可按实收金额调小（可少于缺口）；某项留 0 表示这次不补这一项。
          </div>
        </el-form-item>

        <el-form-item label="补费合计">
          <b class="amount-strong">¥{{ suppTotalYuan.toFixed(2) }}</b>
          <span class="fee-note">= 明细之和（落库为一张「补学费」单，明细随单保存）</span>
        </el-form-item>

        <el-form-item label="补费说明">
          <el-input
            v-model="suppForm.remark"
            maxlength="200"
            placeholder="如：试学转正补缴尾款 / 补差价"
          />
        </el-form-item>

        <el-form-item label="缴费方式" required>
          <el-select v-model="suppForm.payMethod" placeholder="请选择缴费方式" style="width: 100%">
            <el-option v-for="m in PAY_METHODS" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>

        <el-form-item label="缴费凭证" required>
          <input type="file" accept="image/*" @change="onSuppFileChange" />
          <div class="stu-sub mt8">必填，不超过 5MB。凭证随补费单一起落库，财务按它核对到账</div>
          <div v-if="suppForm.dataUrl" class="preview">
            <img :src="suppForm.dataUrl" alt="凭证预览" />
          </div>
        </el-form-item>

        <el-form-item label="转账单号">
          <el-input v-model="suppForm.voucherNo" placeholder="如微信/支付宝交易单号（选填）" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="suppVisible = false">取消</el-button>
        <el-button type="primary" :loading="suppSaving" @click="submitSupplement">确认补费</el-button>
      </template>
    </el-dialog>

    <!-- ============ ★ 2026-10-15 收费单详情（操作列「查看」） ============ -->
    <el-dialog v-model="detailVisible" title="收费单详情" width="720px">
      <el-descriptions v-if="detailRow" :column="2" border>
        <el-descriptions-item label="学生">
          {{ detailRow.studentName }}
          <span v-if="detailRow.consultStateName" class="stu-sub">（{{ detailRow.consultStateName }}）</span>
        </el-descriptions-item>
        <el-descriptions-item label="单号">{{ detailRow.orderNo }}</el-descriptions-item>

        <el-descriptions-item label="费用类型">{{ detailRow.feeTypeName }}</el-descriptions-item>
        <!-- ★ 2026-10-16 实缴 = 单据金额；有明细时额外展示应缴与优惠 -->
        <el-descriptions-item label="实缴金额">
          <b class="amount-strong">{{ detailRow.amountYuan }}</b>
        </el-descriptions-item>
        <el-descriptions-item v-if="detailRow.dueAmount != null" label="应缴金额">
          ¥{{ (detailRow.dueAmount / 100).toFixed(2) }}
        </el-descriptions-item>
        <el-descriptions-item v-if="detailRow.dueAmount != null" label="优惠金额">
          <b :class="(detailRow.discountAmount || 0) > 0 ? 'discount-strong' : 'amount-strong'">
            ¥{{ (Math.abs(detailRow.discountAmount || 0) / 100).toFixed(2) }}
          </b>
          <span class="fee-note">
            {{ (detailRow.discountAmount || 0) > 0 ? '优惠' : (detailRow.discountAmount || 0) < 0 ? '补收' : '无优惠' }}
          </span>
        </el-descriptions-item>
        <!-- ★ 2026-10-26 优惠名目：让看单的人知道这笔少收的钱按什么批的 -->
        <el-descriptions-item v-if="detailRow.discountReason" label="优惠名目">
          {{ detailRow.discountReason }}
        </el-descriptions-item>

        <el-descriptions-item label="缴费方式">{{ detailRow.payMethod || '—' }}</el-descriptions-item>
        <el-descriptions-item label="转账单号">{{ detailRow.voucherNo || '—' }}</el-descriptions-item>

        <el-descriptions-item label="咨询侧状态">
          <el-tag size="small" :type="statusTag(detailRow.status)">{{ detailRow.statusName }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="财务侧状态">
          <el-tag size="small" type="info">{{ detailRow.financePayStatusName || '—' }}</el-tag>
        </el-descriptions-item>

        <el-descriptions-item label="班级">{{ detailRow.className || '未分班' }}</el-descriptions-item>
        <!-- ★ 2026-10-22 详情里把「发起人」和「财务核对人」分开写清楚，避免和列表的操作人口径混淆 -->
        <el-descriptions-item label="发起人">{{ detailRow.createdByName || '—' }}</el-descriptions-item>

        <el-descriptions-item label="发起时间">{{ detailRow.createTime || '—' }}</el-descriptions-item>
        <el-descriptions-item label="财务确认时间">
          {{ detailRow.financeVerifiedTime || detailRow.paidTime || '—' }}
        </el-descriptions-item>

        <el-descriptions-item label="财务确认人" :span="2">
          {{ detailRow.financeVerifiedBy || detailRow.paidByName || '—（财务尚未确认到账）' }}
        </el-descriptions-item>
        <el-descriptions-item v-if="detailRow.rejectReason" label="驳回原因" :span="2">
          <span class="danger-text">{{ detailRow.rejectReason }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="最近操作" :span="2">{{ detailRow.lastAction || '—' }}</el-descriptions-item>
      </el-descriptions>

      <!-- ★ 一次缴清的多项费用：详情里把「包含哪些」逐项列出来 -->
      <div v-if="detailRow?.included?.length" class="mt">
        <div class="detail-label">
          本次包含费用（{{ detailRow.included.length }} 项，合计 {{ detailRow.amountYuan }}）
        </div>
        <el-table :data="detailRow.included" size="small" border>
          <el-table-column prop="feeTypeName" label="费用项" />
          <el-table-column prop="amountYuan" label="金额" width="120" />
          <el-table-column prop="statusName" label="状态" width="120" />
        </el-table>
      </div>

      <div v-if="detailRow" class="mt">
        <div class="detail-label">缴费截图</div>
        <div v-if="detailRow.voucherUrl" class="img-box img-box-col">
          <el-image
            :src="detailRow.voucherUrl"
            :preview-src-list="[detailRow.voucherUrl]"
            fit="contain"
            :initial-index="0"
          >
            <template #error>
              <div class="img-fail">
                凭证文件缺失（服务器上已找不到这张图）。
                <br />
                请对该学生重新发起一次收费并上传新截图。
              </div>
            </template>
          </el-image>
          <div class="stu-sub mt8">点击图片可放大查看</div>
        </div>
        <span v-else class="stu-sub">该单据暂未上传缴费截图</span>
      </div>

      <!--
        ★ 2026-10-15：这里不再放「上传凭证」按钮。
        凭证只在【发起收费】弹窗里上传，详情只负责查看。
      -->
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button v-if="detailRow?.planId" type="primary" @click="openPlan(detailRow)">
          查看分期计划
        </el-button>
      </template>
    </el-dialog>

    <!-- ============ ★ 2026-10-16 分期计划详情 ============ -->
    <el-dialog v-model="planVisible" title="分期计划" width="780px">
      <div v-loading="planLoading">
        <template v-if="planRow">
          <el-descriptions :column="4" border class="mb">
            <el-descriptions-item label="计划号">{{ planRow.planNo }}</el-descriptions-item>
            <el-descriptions-item label="学生">{{ planRow.studentName }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag size="small" :type="planRow.status === 2 ? 'success' : planRow.status === 3 ? 'info' : 'warning'">
                {{ planRow.statusName }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="期数">
              {{ planRow.paidStages }} / {{ planRow.stageCount }} 期已结清
            </el-descriptions-item>

            <el-descriptions-item label="应收">
              <b class="amount-strong">¥{{ planRow.totalAmountYuan }}</b>
            </el-descriptions-item>
            <el-descriptions-item label="已缴">
              <b class="discount-strong">¥{{ planRow.paidAmountYuan }}</b>
            </el-descriptions-item>
            <el-descriptions-item label="优惠">
              ¥{{ planRow.discountAmountYuan }}
            </el-descriptions-item>
            <el-descriptions-item label="待缴">
              <b :class="planRow.pendingAmount > 0 ? 'extra-strong' : 'amount-strong'">
                ¥{{ planRow.pendingAmountYuan }}
              </b>
            </el-descriptions-item>
          </el-descriptions>

          <div class="detail-label">期次明细</div>
          <el-table :data="planRow.items" size="small" border>
            <el-table-column label="期次" width="70" align="center">
              <template #default="{ row }">第 {{ row.stageNo }} 期</template>
            </el-table-column>
            <el-table-column label="本期应收" width="110">
              <template #default="{ row }">¥{{ row.dueAmountYuan }}</template>
            </el-table-column>
            <el-table-column label="到期日" width="120">
              <template #default="{ row }">
                {{ row.dueDate || '—' }}
                <div v-if="row.postponeCount" class="stage-postpone">
                  已顺延{{ row.postponeCount }}次
                </div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag size="small" :type="stageTagType(row)">
                  {{ row.overdue ? '已逾期' : row.statusName }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="关联单号" min-width="140">
              <template #default="{ row }">{{ row.orderNo || '—' }}</template>
            </el-table-column>
            <el-table-column label="到账时间" width="170">
              <template #default="{ row }">{{ row.payTime || '—' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="168" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.status === 0 || row.status === 3"
                  link
                  type="primary"
                  @click="openPayStage(row)"
                >
                  发起收款
                </el-button>
                <!--
                  ★ 2026-10-19 已发起收款但没绑凭证的期次：留补缴凭证入口。
                    已到账但漏图的期次（历史数据）也要能补，否则凭证列永远是空的。
                -->
                <el-button
                  v-if="row.feeOrderId && !row.voucherUrl"
                  link
                  type="warning"
                  @click="openVoucherForItem(row)"
                >
                  {{ row.status === 1 ? '补缴凭证' : '补凭证' }}
                </el-button>
                <span v-if="!row.feeOrderId && row.status !== 0 && row.status !== 3" class="stu-sub">
                  —
                </span>
              </template>
            </el-table-column>
          </el-table>

          <div v-if="planRow.itemDetail?.length" class="mt">
            <div class="detail-label">本次包含费用</div>
            <el-table :data="planRow.itemDetail" size="small" border>
              <el-table-column prop="feeTypeName" label="费用项" />
              <el-table-column label="应缴" width="110">
                <template #default="{ row }">
                  ¥{{ ((row.standardAmount ?? row.amount) / 100).toFixed(2) }}
                </template>
              </el-table-column>
              <el-table-column label="实缴" width="110">
                <template #default="{ row }">¥{{ (row.amount / 100).toFixed(2) }}</template>
              </el-table-column>
              <el-table-column label="优惠" width="110">
                <template #default="{ row }">
                  ¥{{ ((row.discount ?? 0) / 100).toFixed(2) }}
                </template>
              </el-table-column>
            </el-table>
          </div>

          <el-alert
            v-if="planRow.pendingAmount > 0"
            type="warning"
            :closable="false"
            show-icon
            class="mt"
          >
            <template #title>
              该学生尚有尾款 ¥{{ planRow.pendingAmountYuan }} 未缴清（首付到账即可分班，尾款继续催收）。
              待缴归零后计划自动变为「已完成」。
            </template>
          </el-alert>
        </template>
      </div>

      <template #footer>
        <el-button @click="planVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- ★ 2026-10-16 发起分期收款（必须当场传凭证 → 待财务确认） -->
    <el-dialog v-model="stagePayVisible" title="发起分期收款" width="480px">
      <el-descriptions v-if="stagePayItem" :column="2" size="small" border class="mb">
        <el-descriptions-item label="期次">第 {{ stagePayItem.stageNo }} 期</el-descriptions-item>
        <el-descriptions-item label="本期应收">¥{{ stagePayItem.dueAmountYuan }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="96px">
        <el-form-item label="缴费凭证" required>
          <div>
            <input type="file" accept="image/*" @change="onStagePayFileChange" />
            <div v-if="stagePayForm.dataUrl" class="preview">
              <img :src="stagePayForm.dataUrl" alt="凭证预览" />
            </div>
            <div class="fee-note">上传转账成功截图，财务将凭此核对到账</div>
          </div>
        </el-form-item>
        <el-form-item label="转账单号">
          <el-input v-model="stagePayForm.voucherNo" placeholder="如微信/支付宝交易单号（选填）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="stagePayVisible = false">取消</el-button>
        <el-button type="primary" :loading="stagePaySubmitting" @click="submitPayStage">
          发起收款
        </el-button>
      </template>
    </el-dialog>

    <!-- ★ 2026-10-19 上传缴费凭证（历史单 / 漏传的单据补张截图） -->
    <el-dialog v-model="voucherVisible" title="上传缴费凭证" width="480px">
      <el-descriptions v-if="voucherTarget" :column="1" size="small" border class="mb">
        <el-descriptions-item label="学生">{{ voucherTarget.studentName }}</el-descriptions-item>
        <el-descriptions-item label="单据">
          {{ voucherTarget.orderNo || '—' }}<span class="stu-sub"> （{{ voucherTarget.label }}）</span>
        </el-descriptions-item>
      </el-descriptions>
      <el-form label-width="96px">
        <el-form-item label="缴费凭证" required>
          <div>
            <input type="file" accept="image/*" @change="onVoucherFileChange" />
            <div v-if="voucherForm.dataUrl" class="preview">
              <img :src="voucherForm.dataUrl" alt="凭证预览" />
            </div>
            <div class="fee-note">上传转账成功截图，补缴后状态变为「待财务确认」</div>
          </div>
        </el-form-item>
        <el-form-item label="转账单号">
          <el-input v-model="voucherForm.voucherNo" placeholder="如微信/支付宝交易单号（选填）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="voucherVisible = false">取消</el-button>
        <el-button type="primary" :loading="voucherSubmitting" @click="submitVoucher">
          提交凭证
        </el-button>
      </template>
    </el-dialog>

    <!--
      ★ 2026-10-15：凭证已直接在列表里以缩略图展示（点击即放大），
        独立的「查看缴费截图」弹窗随之移除。
    -->

    <!--
      ★ 2026-10-15：独立的「上传缴费截图」弹窗已移除。
      用户口径「上传凭证只能在发起收费那里上传」——
      凭证统一在【发起收费】弹窗里选图，建单时一次性绑定。
    -->

    <!--
      ★ 2026-10-15：分班弹窗已从这里移除。
      用户口径「缴费完成之后学生管理那里分班，分班不能在收款与缴费那里」——
      分班统一去【学生管理】操作。
    -->
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.stat {
  text-align: center;
}

.stat-label {
  font-size: 12px;
  color: #A2938E;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  margin-top: 4px;
  color: #443432;
}

.stat-value.ok {
  color: #5FA36F;
}

.stat-value.warn {
  color: #C9852E;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.table-card {
  flex: 1;
}

.stu-name {
  font-weight: 600;
  color: #443432;
}

.stu-sub {
  font-size: 12px;
  color: #A2938E;
}

.std-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.std-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.voucher-info {
  display: flex;
  gap: 20px;
  padding: 10px 12px;
  background: #F6F3EF;
  border-radius: 6px;
  font-size: 13px;
}

.preview {
  margin-top: 8px;
}

.preview img {
  max-width: 220px;
  max-height: 220px;
  border: 1px solid #DCD2CB;
  border-radius: 6px;
}

.mb {
  margin-bottom: 12px;
}

.mt {
  margin-top: 12px;
}

.mt8 {
  margin-top: 8px;
}

/* ---- 正式学费：朴素多选框（无卡片外框） ---- */
.fee-lbl-hint {
  margin-left: 4px;
  font-size: 12px;
  font-weight: 400;
  color: #a8abb2;
}

.fee-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 24px;
  width: 100%;
}

/* 去掉每一项的外框/底色，只留勾选框 + 文字 */
.fee-grid :deep(.el-checkbox) {
  height: auto;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  align-items: flex-start;
}

.fee-grid :deep(.el-checkbox:hover),
.fee-grid :deep(.el-checkbox.is-checked) {
  border: none;
  background: transparent;
  box-shadow: none;
}

.fee-grid :deep(.el-checkbox__input) {
  margin-top: 3px;
}

/* 勾选框 = 正方形（默认圆角看着像单选，这里强制拉直） */
.fee-grid :deep(.el-checkbox__inner) {
  width: 15px;
  height: 15px;
  border-radius: 0 !important;
}

.fee-grid :deep(.el-checkbox__inner::after) {
  left: 4px;
  top: 1px;
  width: 3px;
  height: 7px;
}

.fee-grid :deep(.el-checkbox__label) {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 4px;
  padding-left: 8px;
  line-height: 1.5;
  font-size: 14px;
  white-space: normal;
  word-break: break-all;
}

.fee-name {
  color: #303133;
}

.fee-amt {
  color: #e6a23c;
  font-weight: 600;
}

.fee-calc {
  font-size: 12px;
  color: #909399;
}

/* 合计金额：口径上属于「要收多少钱」，用醒目样式区分只读预览值 */
.amount-strong {
  font-size: 20px;
  color: #f56c6c;
  font-weight: 700;
}

/* ★ 2026-10-16 优惠金额：绿色（省钱），补收用橙色区分 */
.discount-strong {
  font-size: 20px;
  color: #67c23a;
  font-weight: 700;
}

.extra-strong {
  font-size: 20px;
  color: #e6a23c;
  font-weight: 700;
}

/* ---------- ★ 2026-10-16 分期计划编辑区 ---------- */
.stage-box {
  width: 100%;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 8px;
  padding: 10px;
  background: var(--el-fill-color-lighter, #fafafa);
}

.stage-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  font-size: 13px;
}

.stage-sum {
  margin-left: auto;
  font-size: 13px;
  color: var(--el-text-color-secondary, #909399);
}

/* 期次到期日下方的「已顺延N次」小字 */
.stage-postpone {
  font-size: 11px;
  color: #c9852e;
  margin-top: 2px;
}

/* 列表里的「第 X 期 / 共 N 期」标签：可点，鼠标给手型提示 */
.stage-tag {
  cursor: pointer;
  margin-top: 2px;
}

/* ---- 凭证截图弹窗 ---- */
.img-box {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 220px;
}

/* 详情弹窗里：图在上、提示文字在下 */
.img-box.img-box-col {
  flex-direction: column;
  gap: 8px;
}

.img-box :deep(.el-image),
.img-box :deep(img) {
  max-width: 100%;
  max-height: 66vh;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
}

/* ---- 试学费金额可自定义：输入框旁的小字说明 ---- */
.fee-note {
  margin-left: 10px;
  font-size: 12px;
  color: #909399;
}

/* ---- 合并行：费用类型下方的「含：学费、住宿费…」 ---- */
.fee-included {
  margin-top: 2px;
  font-size: 12px;
  color: #909399;
  line-height: 1.4;
}

/* ---- 列表里的缴费凭证缩略图（点击放大） ---- */
.voucher-thumb {
  width: 48px;
  height: 48px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  cursor: pointer;
  vertical-align: middle;
}

/* 凭证文件在服务器上已不存在时的兜底（历史演示数据常见） */
.thumb-fail {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  font-size: 12px;
  color: #c0c4cc;
  background: #f5f7fa;
  border: 1px dashed #dcdfe6;
  border-radius: 4px;
}

.img-fail {
  padding: 24px;
  font-size: 13px;
  color: #909399;
  text-align: center;
  background: #f5f7fa;
  border: 1px dashed #dcdfe6;
  border-radius: 6px;
}

/* ---- 收费单详情 ---- */
.detail-label {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.danger-text {
  color: #f56c6c;
}
</style>
