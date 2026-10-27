<script setup lang="ts">
/**
 * 学员档案弹窗（多 Tab）—— ★ 2026-10-02 从 ClassList.vue 抽出成**公共组件**
 *
 * 【为什么要抽】
 *   「班级信息管理」和「信息档案」两个页面都要看同一个学生的档案，
 *   原来只有 ClassList 里有一份。抽出来后两侧共用，**改一次两边都生效**。
 *
 * 【谁在用】
 *   · views/ClassList.vue        班级信息管理（实训侧·我带的班）
 *   · views/archive/BasicInfo.vue 信息档案（就业侧·全量学生）
 *
 * 【用法】
 *   <StudentProfileDialog
 *     v-model:visible="profileVisible"
 *     :student-id="profileStudentId"
 *     :initial-edit-mode="profileEditMode"
 *     @updated="loadList"
 *   />
 *
 * 【Tab 数量是动态的】
 *   一般学生 7 个；「待就业 / 已就业」的学生多出**就业日志**和**复盘记录**两个（共 9 个）。
 *
 * ⚠️ 数据来自 GET /api/job/class-info/detail；缴费记录单独懒加载（跨模块调财务 8005）。
 */
import { ref, reactive, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { RoleCode, StudentStatus, EDUCATION_LEVELS } from 'shared-types';
import type {
  ClassInfoDetail,
  ClassInfoFeeRecords,
  ClassInfoUpdatePayload,
} from 'shared-types';
import {
  fetchFeeRecords,
  fetchClassInfoDetail,
  updateClassInfoStudent,
} from '@/api/classInfo';
// ★ 2026-10-02：修改里可以直接换宿舍（宿舍 + 床位 两级选）
import { fetchDormList, fetchBedOptions } from '@/api/dorm';
import { isReadOnlyUser, isSuperTest, myRoles } from '@/store/permission';
// ★ 2026-10-04：学习阶段改走字典（原来这里写死 1~3「第一~第三阶段」，
//   而大学部学生实际是 201~206 —— 下拉里一个都对不上，选了就把学生阶段改错）
import { useDictStore } from '@/class/stores/dict';

/* ============================================================
 * props / emits
 * ============================================================ */
const props = withDefaults(
  defineProps<{
    /** 弹窗显隐（v-model:visible） */
    visible: boolean;
    /** 要看哪个学生（必传；变化时会自动重新加载） */
    studentId: string;
    /** 打开时是否**直接进编辑态**（列表上的「修改」入口传 true） */
    initialEditMode?: boolean;
  }>(),
  { initialEditMode: false },
);

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void;
  /** 弹窗里保存过内容 → 通知父页面刷新列表 */
  (e: 'updated'): void;
}>();

/* ============================================================
 * 能不能编辑（口径与列表页完全一致）
 *
 * ⚠️ 前端只是"不碍眼"，真正的拦截在后端（classInfo.route.ts 的 assertCanWrite）
 * ============================================================ */
const canOperate = computed(() => {
  if (isSuperTest.value) return true; // ★ 万能测试号：业务验证用，全部放行
  if (isReadOnlyUser.value) return false; // 系统管理员：全局只读
  if (myRoles.value.includes(RoleCode.ACAD_STAFF)) return false; // 教务老师：本页只读
  if (myRoles.value.includes(RoleCode.JOB_STAFF)) return false; // 就业老师：只读（档案归实训侧管）
  return true;
});

/* ============================================================
 * 选项常量（只被本弹窗用到，所以随组件一起走）
 * ============================================================ */
const GENDER_OPTIONS = [
  { value: 1, label: '男' },
  { value: 2, label: '女' },
];

/** ★ 2026-10-04：学历统一走 shared-types 的 EDUCATION_LEVELS（三处字面量曾不一致） */
const EDU_OPTIONS = EDUCATION_LEVELS;

/**
 * 学习阶段下拉（★ 2026-10-04 改为读字典）
 *
 * 【原来错在哪】这里写死 `[1,2,3] = 第一/二/三阶段`，
 *   但**大学部学生的 stage 是 201~206**（班级库那套编号）。
 *   后果：编辑档案时「学习阶段」下拉一片空白（当前值 20x 不在选项里），
 *   老师一选就可能把学生阶段改成 1/2/3 —— 数据直接被改坏。
 *
 * 【现在怎么拿】走 /api/class/meta/dict 的 stage + stageByDept，
 *   和「班级管理」页建班/改班用的是同一份数据，不会再各写一套。
 *
 * ⚠️ 升实训后 stage 会变成 13（系统自动流转，不在 stageByDept 里），
 *   所以要把「该学生当前值」也并进选项，否则实训学生打开编辑还是空白。
 */
const dict = useDictStore();

/** 大学部（dept_code=2）的阶段 + 该学生当前所处阶段（可能是实训 13） */
const STAGE_OPTIONS = computed(() => {
  const base = dict.stagesOf(2);
  const cur = basicForm.stage;
  if (cur == null || base.some((o) => o.value === cur)) return base;
  return [...base, { value: cur, label: dict.label('stage', cur) }].sort((a, b) => a.value - b.value);
});

/* ============================================================
 * ↓↓↓ 以下逻辑搬自 ClassList.vue（2026-10-02 抽取时逐行搬过来，仅改触发方式）
 * ============================================================ */

/* ============================================================
 * 缴费记录（★ 本轮从列表按钮**移进「详情」的 Tab** 里）
 *
 * ⚠️ 跨模块调财务 8005 —— 财务模块还没做，返回 available:false + 提示文案（不是报错）
 * ⚠️ 懒加载：切到该 Tab 才拉，避免每次打开详情都白等一次跨模块超时
 * ============================================================ */
const feeLoading = ref(false);
const feeData = ref<ClassInfoFeeRecords | null>(null);
/** 本次打开详情是否已经拉过（换学生要重置） */
const feeLoaded = ref(false);

async function loadFee(studentId: string): Promise<void> {
  feeLoading.value = true;
  feeData.value = null;
  try {
    feeData.value = await fetchFeeRecords(studentId);
    feeLoaded.value = true;
  } catch (e: any) {
    ElMessage.error(e?.message || '缴费记录加载失败');
  } finally {
    feeLoading.value = false;
  }
}

/* ============================================================
 * 操作②③：学员档案（详情 / 修改 打开的是同一个弹窗）
 * ============================================================ */
// ★ 2026-10-02 抽成公共组件后：显隐由**父组件**控制（v-model:visible），这里转一层
const detailVisible = computed({
  get: () => props.visible,
  set: (v: boolean) => emit('update:visible', v),
});
const detailLoading = ref(false);
const detail = ref<ClassInfoDetail | null>(null);
const detailTab = ref('basic');
/** 基础信息是否处于「编辑态」（默认是展示态，仿参考页的卡片样式） */
const basicEditMode = ref(false);
const saving = ref(false);

/** 弹窗标题：姓名 · 学员详情 */
const detailTitle = computed(() => {
  if (!detail.value) return '学员详情';
  return `${detail.value.basic.studentName} · 学员详情`;
});

/** 基础信息表单（编辑态用） */
const basicForm = reactive({
  studentId: '',
  studentName: '',
  gender: undefined as number | undefined,
  age: undefined as number | undefined,
  education: '',
  phone: '',
  parentPhone: '',
  birthDate: '',
  nativePlace: '',
  graduateSchool: '',
  homeAddress: '',
  stage: undefined as number | undefined,
  remark: '',
  // ★ 2026-10-02：换宿舍用（宿舍 → 床位 两级选；都不选 = 不改宿舍）
  dormId: '',
  bedId: '',
});

/* ============================================================
 * ★ 2026-10-02（斌哥）：修改里可以直接换宿舍
 *
 * 【为什么改了这条规矩】
 *   原设计里"宿舍"属于**不可改字段**（要走「宿舍管理」模块，换宿还得教务审批）。
 *   但老师日常调整个床位很频繁，每次都绕一圈太重，所以放开成"修改里直接改"。
 *   ⚠️ **只支持换床位，不支持在这里退宿** —— 退宿涉及费用结算，仍走宿舍管理的审批流程。
 *
 * 【交互】宿舍（可选，按学生性别过滤、只列还有空床的）→ 床位（选了宿舍才拉）
 *   两个都不选 = 不动宿舍（安全默认）
 * ============================================================ */
const dormOptions = ref<Array<{ id: string; label: string }>>([]);
const bedOptions = ref<Array<{ id: string; label: string }>>([]);
const dormOptLoading = ref(false);
const bedOptLoading = ref(false);

/** 拉可选宿舍（按性别过滤 + 只列还有空床的） */
async function loadDormOptions(gender?: number | null): Promise<void> {
  dormOptLoading.value = true;
  try {
    const res: any = await fetchDormList({ page: 1, size: 200, dormStatus: 1, onlyFree: true });
    const list: any[] = res?.list || [];
    dormOptions.value = list
      // 性别：宿舍不限(0) 或 与学生性别一致
      .filter((d) => !gender || !d.dormGender || d.dormGender === gender)
      .map((d) => ({
        id: d.id,
        label: `${d.dormNo}（${d.building}）· 空 ${d.freeCount} 床`,
      }));
  } catch {
    dormOptions.value = [];
  } finally {
    dormOptLoading.value = false;
  }
}

/** 拉某个宿舍的空闲床位 */
async function loadBedOptions(dormId: string): Promise<void> {
  if (!dormId) {
    bedOptions.value = [];
    return;
  }
  bedOptLoading.value = true;
  try {
    const list: any[] = (await fetchBedOptions({ dormId })) as any[];
    bedOptions.value = list.map((b) => ({ id: b.id, label: `${b.dormNo} · ${b.bedNo}` }));
  } catch {
    bedOptions.value = [];
  } finally {
    bedOptLoading.value = false;
  }
}

/** 选了宿舍 → 清掉旧床位选择 + 重新拉床位 */
function onDormChange(dormId: string): void {
  basicForm.bedId = '';
  loadBedOptions(dormId);
}

/** 把详情数据灌进表单 */
function fillBasicForm(d: ClassInfoDetail): void {
  const b = d.basic;
  basicForm.studentId = b.studentId;
  basicForm.studentName = b.studentName || '';
  basicForm.gender = b.gender ?? undefined;
  basicForm.age = b.age ?? undefined;
  basicForm.education = b.education || '';
  basicForm.phone = b.phone || '';
  basicForm.parentPhone = b.parentPhone || '';
  basicForm.birthDate = b.birthDate || '';
  basicForm.nativePlace = b.nativePlace || '';
  basicForm.graduateSchool = b.graduateSchool || '';
  basicForm.homeAddress = b.homeAddress || '';
  basicForm.stage = b.stage ?? undefined;
  basicForm.remark = b.remark || '';
  // ★ 换宿舍：默认"不改"（不预选任何宿舍/床位），界面另外提示当前住哪
  basicForm.dormId = '';
  basicForm.bedId = '';
  bedOptions.value = [];
}

/**
 * 打开档案 → 自动加载
 *
 * ★ 2026-10-02 抽成公共组件后，触发方式变了：
 *   不再是"页面上点某一行"，而是 **父组件给了 studentId + visible=true 就加载**。
 *   这样「班级信息管理」和「信息档案」两个页面能共用同一套档案界面。
 *
 * ★ 保留原来的设计（斌哥 2026-09-30）：
 *   「详情」和「修改」打开的是**同一个弹窗**，区别只在**初始是不是编辑态** ——
 *     · 详情 → 只读（基础信息是字段卡片，要看/改再点右上角「修改」）
 *     · 修改 → 直接进编辑态（输入框摊开）
 */
watch(
  () => [props.visible, props.studentId] as const,
  async ([vis, sid]) => {
    if (!vis || !sid) return;
    detailLoading.value = true;
    detailTab.value = 'basic';
    // ★ 2026-10-04：先把枚举字典拉上，否则「学习阶段」下拉是空的
    //   （字典是幂等加载 + 全站共用，这里 await 一下不影响性能）
    void dict.ensure();
    // ★ 双保险：只读角色（教务 / 只读管理员 / 就业老师）无论从哪个入口调进来，
    //   都强制停在只读态 —— 万一以后加了新入口忘了判断，这里也不会漏。
    basicEditMode.value = !!props.initialEditMode && canOperate.value;
    detail.value = null;
    // 换人了 → 缴费记录要重新拉
    feeLoaded.value = false;
    feeData.value = null;
    try {
      const d = await fetchClassInfoDetail(sid);
      detail.value = d;
      fillBasicForm(d);
    } catch (e: any) {
      ElMessage.error(e?.message || '学员档案加载失败');
      detailVisible.value = false;
    } finally {
      detailLoading.value = false;
    }
  },
  { immediate: true },
);

/** 切到「缴费记录」Tab 时才去调财务模块（懒加载） */
watch(detailTab, (tab) => {
  if (tab === 'fee' && !feeLoaded.value && detail.value) {
    loadFee(detail.value.basic.studentId);
  }
});

/** 点「修改」→ 进入编辑态 */
function startBasicEdit(): void {
  basicEditMode.value = true;
  // ★ 2026-10-02：顺手拉一下可选宿舍（按学生性别过滤），换宿舍时不用等
  loadDormOptions(detail.value?.basic.gender ?? undefined);
}

/** 取消编辑 → 还原表单 + 回展示态 */
function cancelBasicEdit(): void {
  if (detail.value) fillBasicForm(detail.value);
  basicEditMode.value = false;
}

/** 保存基础信息 */
async function saveBasic(): Promise<void> {
  if (!basicForm.studentName.trim()) {
    ElMessage.warning('姓名不能为空');
    return;
  }
  saving.value = true;
  try {
    // ⚠️ 数字字段：没填就**不传**（传空串会被解析成 0）
    const payload: ClassInfoUpdatePayload = {
      studentId: basicForm.studentId,
      studentName: basicForm.studentName.trim(),
      education: basicForm.education,
      phone: basicForm.phone,
      parentPhone: basicForm.parentPhone,
      birthDate: basicForm.birthDate,
      nativePlace: basicForm.nativePlace,
      graduateSchool: basicForm.graduateSchool,
      homeAddress: basicForm.homeAddress,
      remark: basicForm.remark,
    };
    if (basicForm.gender !== undefined && basicForm.gender !== null) {
      payload.gender = basicForm.gender;
    }
    if (basicForm.age !== undefined && basicForm.age !== null) {
      payload.age = basicForm.age;
    }
    if (basicForm.stage !== undefined && basicForm.stage !== null) {
      payload.stage = basicForm.stage;
    }
    // ★ 2026-10-02：换宿舍 —— 选了床位才传（不传 = 不动宿舍）
    if (basicForm.bedId) {
      payload.bedId = basicForm.bedId;
    }

    await updateClassInfoStudent(payload);
    ElMessage.success('保存成功');
    basicEditMode.value = false;
    // 重新拉一次详情（拿到最新的双返回字段），并刷新列表
    detail.value = await fetchClassInfoDetail(basicForm.studentId);
    fillBasicForm(detail.value);
    // 通知父页面（列表）刷新
    emit('updated');
  } catch {
    // 错误提示由请求层统一弹
  } finally {
    saving.value = false;
  }
}

/** 照片区：本期只做展示位，不接上传 */
function onPhotoClick(label: string): void {
  ElMessage.info(`${label}上传功能待开放（需要文件存储方案确定后接入）`);
}

/** 关闭弹窗时重置状态，避免下次打开残留编辑态 */
function onDetailClosed(): void {
  basicEditMode.value = false;
  detail.value = null;
  feeData.value = null;
  feeLoaded.value = false;
}
</script>

<template>
    <!-- ============ 弹窗：学员档案（7 个 Tab） ============ -->
    <el-dialog
      v-model="detailVisible"
      width="1120px"
      top="4vh"
      class="profile-dialog"
      @closed="onDetailClosed"
    >
      <!-- 头部：姓名 · 学员详情  学号 | 班级 | 状态 -->
      <template #header>
        <div class="pf-head">
          <span class="pf-name">{{ detailTitle }}</span>
          <span v-if="detail" class="pf-meta">
            {{ detail.basic.studentNo }} | {{ detail.basic.className || '—' }} |
            {{ detail.basic.studentStatusName || '—' }}
          </span>
        </div>
      </template>

      <div v-loading="detailLoading" class="pf-body">
        <el-tabs v-if="detail" v-model="detailTab" class="pf-tabs">
          <!-- ==================== ① 基础信息 ==================== -->
          <el-tab-pane label="基础信息" name="basic">
            <div class="sec-title">
              <span class="bar"></span>基础信息
              <el-button
                v-if="!basicEditMode && canOperate"
                link
                type="primary"
                class="sec-action"
                @click="startBasicEdit"
              >
                修改
              </el-button>
            </div>

            <!-- 展示态（仿参考页的字段卡片） -->
            <div v-if="!basicEditMode" class="field-grid">
              <div class="field"><div class="fl">姓名</div><div class="fv">{{ detail.basic.studentName || '—' }}</div></div>
              <div class="field"><div class="fl">学号</div><div class="fv">{{ detail.basic.studentNo || '—' }}</div></div>
              <div class="field"><div class="fl">性别</div><div class="fv">{{ detail.basic.genderName || '—' }}</div></div>
              <div class="field"><div class="fl">年龄</div><div class="fv">{{ detail.basic.age ?? '—' }}</div></div>
              <div class="field"><div class="fl">班级</div><div class="fv">{{ detail.basic.className || '—' }}</div></div>
              <div class="field"><div class="fl">学历</div><div class="fv">{{ detail.basic.education || '—' }}</div></div>
              <div class="field"><div class="fl">手机号</div><div class="fv">{{ detail.basic.phone || '—' }}</div></div>
              <div class="field"><div class="fl">家长手机号</div><div class="fv">{{ detail.basic.parentPhone || '—' }}</div></div>
              <div class="field"><div class="fl">入学时间</div><div class="fv">{{ detail.basic.enrollDate || '—' }}</div></div>
              <div class="field"><div class="fl">出生日期</div><div class="fv">{{ detail.basic.birthDate || '—' }}</div></div>
              <div class="field"><div class="fl">籍贯</div><div class="fv">{{ detail.basic.nativePlace || '—' }}</div></div>
              <div class="field"><div class="fl">毕业院校</div><div class="fv">{{ detail.basic.graduateSchool || '—' }}</div></div>
              <div class="field span2"><div class="fl">家庭住址</div><div class="fv">{{ detail.basic.homeAddress || '—' }}</div></div>
              <div class="field span2"><div class="fl">备注（综合素质）</div><div class="fv">{{ detail.basic.remark || '—' }}</div></div>
            </div>

            <!-- 编辑态 -->
            <el-form v-else :model="basicForm" label-position="top" class="basic-form">
              <div class="edit-grid">
                <el-form-item label="姓名">
                  <el-input v-model="basicForm.studentName" maxlength="32" placeholder="必填" />
                </el-form-item>
                <el-form-item label="学号（不可改）">
                  <el-input :model-value="detail.basic.studentNo" disabled />
                </el-form-item>
                <el-form-item label="性别">
                  <el-select v-model="basicForm.gender" clearable placeholder="请选择" style="width: 100%">
                    <el-option v-for="g in GENDER_OPTIONS" :key="g.value" :label="g.label" :value="g.value" />
                  </el-select>
                </el-form-item>
                <el-form-item label="年龄">
                  <el-input-number v-model="basicForm.age" :min="0" :max="120" controls-position="right" style="width: 100%" />
                </el-form-item>
                <el-form-item label="班级（不可改）">
                  <el-input :model-value="detail.basic.className || ''" disabled />
                </el-form-item>
                <el-form-item label="学历">
                  <el-select v-model="basicForm.education" clearable placeholder="请选择" style="width: 100%">
                    <el-option v-for="e in EDU_OPTIONS" :key="e" :label="e" :value="e" />
                  </el-select>
                </el-form-item>
                <el-form-item label="手机号">
                  <el-input v-model="basicForm.phone" maxlength="20" placeholder="学生本人手机号" />
                </el-form-item>
                <el-form-item label="家长手机号">
                  <el-input v-model="basicForm.parentPhone" maxlength="20" placeholder="家长手机号" />
                </el-form-item>
                <el-form-item label="入学时间（不可改）">
                  <el-input :model-value="detail.basic.enrollDate || ''" disabled />
                </el-form-item>
                <el-form-item label="出生日期">
                  <el-date-picker
                    v-model="basicForm.birthDate"
                    type="date"
                    value-format="YYYY-MM-DD"
                    placeholder="选择日期"
                    style="width: 100%"
                  />
                </el-form-item>
                <el-form-item label="籍贯">
                  <el-input v-model="basicForm.nativePlace" maxlength="64" placeholder="如 黑龙江哈尔滨" />
                </el-form-item>
                <el-form-item label="毕业院校">
                  <el-input v-model="basicForm.graduateSchool" maxlength="128" placeholder="如 哈尔滨市第三中学" />
                </el-form-item>
                <el-form-item label="家庭住址" class="span2">
                  <el-input v-model="basicForm.homeAddress" maxlength="255" placeholder="详细地址" />
                </el-form-item>
                <!-- ★ 2026-10-02（斌哥）：宿舍原来属于"不可改字段"，现在可以直接换床位 -->
                <el-form-item label="宿舍">
                  <el-select
                    v-model="basicForm.dormId"
                    clearable
                    filterable
                    :loading="dormOptLoading"
                    :placeholder="
                      detail?.dorm
                        ? `当前：${detail.dorm.dormNo} ${detail.dorm.bedNo || ''}（不改就不选）`
                        : '未分配（可不选）'
                    "
                    style="width: 100%"
                    @change="onDormChange"
                  >
                    <el-option v-for="d in dormOptions" :key="d.id" :label="d.label" :value="d.id" />
                  </el-select>
                </el-form-item>
                <el-form-item label="床位">
                  <el-select
                    v-model="basicForm.bedId"
                    clearable
                    :loading="bedOptLoading"
                    :disabled="!basicForm.dormId"
                    :placeholder="basicForm.dormId ? '请选择床位' : '请先选宿舍'"
                    style="width: 100%"
                  >
                    <el-option v-for="b in bedOptions" :key="b.id" :label="b.label" :value="b.id" />
                  </el-select>
                </el-form-item>
                <el-form-item label="学习阶段">
                  <el-select v-model="basicForm.stage" clearable placeholder="请选择" style="width: 100%">
                    <el-option v-for="s in STAGE_OPTIONS" :key="s.value" :label="s.label" :value="s.value" />
                  </el-select>
                </el-form-item>
                <el-form-item label="备注（综合素质）" class="span2">
                  <el-input
                    v-model="basicForm.remark"
                    type="textarea"
                    :rows="2"
                    maxlength="500"
                    show-word-limit
                    placeholder="学习情况、综合素质、需关注事项等"
                  />
                </el-form-item>
              </div>
              <div class="edit-tip">
                ⚠️ <b>学号、班级、学生状态、入学日期、末班次数</b> 不在这里改 ——
                分别走入学、班级交接、休学退学审批、成绩管理。<br />
                ✅ <b>宿舍 / 床位</b>可以直接改（选完保存即生效，会同步床位表）；
                <b>退宿</b>请到「宿舍管理」发起申请（走教务审批）。
              </div>
            </el-form>

            <!-- 照片区（本期只做展示位，不接上传） -->
            <div class="photo-row">
              <div class="photo-col">
                <div class="sec-title"><span class="bar"></span>身份证照片</div>
                <div class="photo-box" @click="onPhotoClick('身份证照片')">
                  <div class="photo-ph">待上传</div>
                  <div class="photo-hint">点击上传（功能待开放）</div>
                </div>
              </div>
              <div class="photo-col">
                <div class="sec-title"><span class="bar"></span>户口本照片</div>
                <div class="photo-box" @click="onPhotoClick('户口本照片')">
                  <div class="photo-ph">待上传</div>
                  <div class="photo-hint">点击上传（功能待开放）</div>
                </div>
              </div>
            </div>
          </el-tab-pane>

          <!-- ==================== ② 市场信息 ==================== -->
          <el-tab-pane label="市场信息" name="market">
            <div class="sec-title"><span class="bar"></span>市场信息</div>
            <el-table :data="[detail.basic]" border size="small">
              <el-table-column prop="studentName" label="姓名" width="110" />
              <el-table-column prop="studentNo" label="学号" width="130" />
              <el-table-column label="招生老师" width="120">
                <template #default="{ row }">
                  {{ detail.market.admissionTeacher || '—' }}
                </template>
              </el-table-column>
              <el-table-column label="招生老师电话号" width="150">
                <template #default="{ row }">
                  {{ detail.market.admissionTeacherPhone || '—' }}
                </template>
              </el-table-column>
              <el-table-column label="咨询老师" width="120">
                <template #default="{ row }">
                  {{ detail.market.consultTeacher || '—' }}
                </template>
              </el-table-column>
              <el-table-column label="咨询老师电话号">
                <template #default="{ row }">
                  {{ detail.market.consultTeacherPhone || '—' }}
                </template>
              </el-table-column>
            </el-table>
            <div class="tab-tip">
              招生 / 咨询老师由<b>大学部升阶</b>时带来，这里只读展示。
            </div>
          </el-tab-pane>

          <!-- ==================== ③ 末班 ==================== -->
          <el-tab-pane label="末班" name="repeat">
            <div class="sec-title">
              <span class="bar"></span>末班记录
              <span class="sec-sub">
                累计
                <b :class="{ 'repeat-warn': detail.repeat.repeatCount > 0 }">
                  {{ detail.repeat.repeatCount }}
                </b>
                次
              </span>
            </div>
            <el-table v-if="detail.repeat.records.length" :data="detail.repeat.records" border size="small">
              <el-table-column prop="examName" label="考试名称" width="150" />
              <el-table-column prop="examTypeName" label="考试类型" width="110" />
              <el-table-column prop="examTime" label="考试时间" width="160" />
              <el-table-column label="综合成绩" width="100" align="center">
                <template #default="{ row }">
                  <span class="score-blue">{{ row.totalScore ?? '—' }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="className" label="当时班级" min-width="140" />
              <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
            </el-table>
            <el-empty v-else description="暂无末班记录（考试未通过才会有）" :image-size="80" />
            <div class="tab-tip">
              末班 = 考试成绩不合格，转到别的班级重修。记录由<b>成绩管理</b>页判定后自动产生。
            </div>
          </el-tab-pane>

          <!-- ==================== ④ 宿舍 ==================== -->
          <el-tab-pane label="宿舍" name="dorm">
            <div class="sec-title"><span class="bar"></span>住宿信息</div>
            <template v-if="detail.dorm">
              <div class="field-grid">
                <!-- ★ 宿舍有两套（实训基地 / 就业基地），先标清楚是哪一套 -->
                <div class="field">
                  <div class="fl">宿舍来源</div>
                  <div class="fv">
                    <el-tag
                      size="small"
                      effect="plain"
                      :type="detail.dorm.dormSource === 'employment' ? 'success' : 'info'"
                    >
                      {{ detail.dorm.dormSourceName || '—' }}
                    </el-tag>
                  </div>
                </div>
                <div class="field"><div class="fl">宿舍号</div><div class="fv">{{ detail.dorm.dormNo || '—' }}</div></div>
                <div class="field">
                  <div class="fl">床位号</div>
                  <div class="fv">
                    {{
                      detail.dorm.bedNo ||
                      (detail.dorm.dormSource === 'employment' ? '不分床位' : '—')
                    }}
                  </div>
                </div>
                <div class="field"><div class="fl">楼栋</div><div class="fv">{{ detail.dorm.building || '—' }}</div></div>
                <div class="field"><div class="fl">房间</div><div class="fv">{{ detail.dorm.roomNo || '—' }}</div></div>
                <div class="field"><div class="fl">宿舍性别</div><div class="fv">{{ detail.dorm.dormGenderName || '—' }}</div></div>
                <div class="field">
                  <div class="fl">床位占用</div>
                  <div class="fv">
                    {{ detail.dorm.usedCount ?? '—' }} / {{ detail.dorm.bedCount ?? '—' }}
                  </div>
                </div>
                <div class="field"><div class="fl">入住日期</div><div class="fv">{{ detail.dorm.checkInDate || '—' }}</div></div>
              </div>
            </template>
            <el-empty v-else description="该学生目前没有住宿记录" :image-size="80" />
            <div class="tab-tip">
              <template v-if="detail.dorm?.dormSource === 'employment'">
                就业基地宿舍由<b>「就业基地宿舍」</b>页直接分派（<b>不走审批</b>）；如需调整请到那里操作。
              </template>
              <template v-else>
                调换宿舍 / 退宿请到<b>宿舍管理</b>页发起申请（走教务审批），这里只读展示。
              </template>
            </div>
          </el-tab-pane>

          <!-- ==================== ⑤ 考试信息 ==================== -->
          <el-tab-pane label="考试信息" name="exams">
            <el-alert type="info" :closable="false" class="exam-note">
              <template #title>
                技术考试只显示最近 <b>{{ detail.exams.limit }}</b> 次 考试成绩；学员由初高中升学时，
                升学时的成绩信息随档案一并保存。 综合成绩 = 笔试 ×
                {{ detail.exams.writtenWeight }}% + 面试 × {{ detail.exams.interviewWeight }}% ，
                由系统自动计算。
              </template>
            </el-alert>
            <div class="sec-title">
              <span class="bar"></span>技术考试（最近 {{ detail.exams.limit }} 次）
            </div>
            <el-table v-if="detail.exams.list.length" :data="detail.exams.list" border size="small">
              <el-table-column label="姓名 / 学号" width="168">
                <template #default>
                  {{ detail.basic.studentName }} / {{ detail.basic.studentNo }}
                </template>
              </el-table-column>
              <el-table-column prop="examName" label="考试名称" width="128" />
              <el-table-column prop="examTime" label="考试时间" width="152" />
              <el-table-column label="综合成绩" width="88" align="center">
                <template #default="{ row }">
                  <span class="score-blue">{{ row.totalScore ?? '—' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="笔试分数" width="84" align="center">
                <template #default="{ row }">{{ row.writtenAvg ?? '—' }}</template>
              </el-table-column>
              <el-table-column label="面试分数" width="84" align="center">
                <template #default="{ row }">{{ row.interviewScore ?? '—' }}</template>
              </el-table-column>
              <el-table-column label="素质分析（非必填）" min-width="160" show-overflow-tooltip>
                <template #default="{ row }">{{ row.qualityAnalysis || '—' }}</template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="暂无考试记录" :image-size="80" />
            <div class="tab-tip">
              成绩录入 / 修改请到<b>成绩管理</b>页操作（那里按考试批量录入），这里只读展示。
            </div>
          </el-tab-pane>

          <!-- ==================== ⑥ 班级信息 ==================== -->
          <el-tab-pane label="班级信息" name="classinfo">
            <div class="sec-title"><span class="bar"></span>当前班级</div>
            <div class="field-grid">
              <div class="field"><div class="fl">班级名称</div><div class="fv">{{ detail.classInfo.className || '—' }}</div></div>
              <div class="field"><div class="fl">班级编码</div><div class="fv">{{ detail.classInfo.classCode || '—' }}</div></div>
              <div class="field"><div class="fl">部门</div><div class="fv">{{ detail.classInfo.deptName || '—' }}</div></div>
              <div class="field"><div class="fl">学习阶段</div><div class="fv">{{ detail.classInfo.stageName || '—' }}</div></div>
              <div class="field"><div class="fl">班级状态</div><div class="fv">{{ detail.classInfo.classStatusName || '—' }}</div></div>
              <div class="field"><div class="fl">教室</div><div class="fv">{{ detail.classInfo.classroom || '—' }}</div></div>
              <div class="field"><div class="fl">班主任</div><div class="fv">{{ detail.classInfo.headTeacherName || '—' }}</div></div>
              <div class="field"><div class="fl">教员</div><div class="fv">{{ detail.classInfo.teacherName || '—' }}</div></div>
              <div class="field"><div class="fl">助教</div><div class="fv">{{ detail.classInfo.assistantName || '—' }}</div></div>
              <div class="field"><div class="fl">班级人数</div><div class="fv">{{ detail.classInfo.studentCount }} 人</div></div>
            </div>

            <div class="sec-title" style="margin-top: 16px">
              <span class="bar"></span>班级流转历史
            </div>
            <el-table v-if="detail.classInfo.history.length" :data="detail.classInfo.history" border size="small">
              <el-table-column prop="className" label="班级" min-width="140" />
              <el-table-column prop="joinDate" label="入班日期" width="110" align="center" />
              <el-table-column prop="joinTypeName" label="入班方式" width="100" align="center" />
              <el-table-column label="在班状态" width="90" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.status === 1 ? 'success' : 'info'" size="small">
                    {{ row.statusName || '—' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="leaveDate" label="离班日期" width="110" align="center">
                <template #default="{ row }">{{ row.leaveDate || '—' }}</template>
              </el-table-column>
              <el-table-column prop="leaveTypeName" label="离班方式" width="100" align="center">
                <template #default="{ row }">{{ row.leaveTypeName || '—' }}</template>
              </el-table-column>
              <el-table-column prop="leaveReason" label="离班原因" min-width="140" show-overflow-tooltip>
                <template #default="{ row }">{{ row.leaveReason || '—' }}</template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="暂无流转记录" :image-size="80" />
          </el-tab-pane>

          <!-- ==================== ⑦ 缴费记录（★ 本轮从列表按钮移进来的） ==================== -->
          <!-- ========== ★ 就业日志 / 复盘记录：只有「已转就业」的学生才显示 ==========
               （斌哥 2026-10-02：学生转出去之后，班主任仍然要能看到他的就业情况） -->
          <el-tab-pane
            v-if="detail.employment"
            label="就业日志"
            name="employment-log"
          >
            <div class="sec-title"><span class="bar"></span>就业日志</div>
            <el-table
              v-if="detail.employment.logs.length"
              :data="detail.employment.logs"
              border
              size="small"
            >
              <el-table-column prop="logDate" label="日志日期" width="110" />
              <el-table-column prop="resumeCount" label="投递" width="70" align="center" />
              <el-table-column prop="interviewInvite" label="邀约" width="70" align="center" />
              <el-table-column prop="interviewCount" label="面试" width="70" align="center" />
              <el-table-column label="公司" min-width="170" show-overflow-tooltip>
                <template #default="{ row }">{{ row.company || '—' }}</template>
              </el-table-column>
              <el-table-column label="岗位" width="150" show-overflow-tooltip>
                <template #default="{ row }">{{ row.position || '—' }}</template>
              </el-table-column>
              <el-table-column label="薪资" width="100" align="right">
                <template #default="{ row }">
                  {{ row.salary !== null ? `¥${row.salary}` : '—' }}
                </template>
              </el-table-column>
              <el-table-column label="面试时间" width="120">
                <template #default="{ row }">{{ row.interviewTime || '—' }}</template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="暂无就业日志" :image-size="80" />

            <!-- 面试情况文字较长，单独一块展示（塞进表格会很难看） -->
            <div v-if="detail.employment.logs.length" class="emp-cards">
              <div v-for="log in detail.employment.logs" :key="log.id" class="emp-card">
                <div class="ec-head">{{ log.logDate }} · 面试情况</div>
                <div class="ec-body">{{ log.interviewSituation || '—' }}</div>
              </div>
            </div>

            <div class="tab-tip">
              数据来自<b>就业模块</b>的就业日志；如需补充或修改，请到<b>就业日志</b>页操作。
            </div>
          </el-tab-pane>

          <el-tab-pane
            v-if="detail.employment"
            label="复盘记录"
            name="employment-review"
          >
            <div class="sec-title"><span class="bar"></span>复盘记录</div>
            <el-table
              v-if="detail.employment.reviews.length"
              :data="detail.employment.reviews"
              border
              size="small"
            >
              <el-table-column prop="reviewTime" label="复盘时间" width="155" />
              <el-table-column label="岗位" width="150" show-overflow-tooltip>
                <template #default="{ row }">{{ row.position || '—' }}</template>
              </el-table-column>
              <el-table-column label="工资" width="90" align="right">
                <template #default="{ row }">
                  {{ row.salary !== null ? `¥${row.salary}` : '—' }}
                </template>
              </el-table-column>
              <el-table-column label="面试结论" width="115">
                <template #default="{ row }">
                  <el-tag v-if="row.interviewConclusionName" size="small" effect="plain">
                    {{ row.interviewConclusionName }}
                  </el-tag>
                  <span v-else>—</span>
                </template>
              </el-table-column>
              <el-table-column label="复盘结论" width="125">
                <template #default="{ row }">
                  <el-tag
                    v-if="row.reviewConclusionName"
                    size="small"
                    type="success"
                    effect="plain"
                  >
                    {{ row.reviewConclusionName }}
                  </el-tag>
                  <span v-else>—</span>
                </template>
              </el-table-column>
              <el-table-column label="复盘详情" min-width="240" show-overflow-tooltip>
                <template #default="{ row }">{{ row.detail || '—' }}</template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="暂无复盘记录" :image-size="80" />

            <div class="tab-tip">
              数据来自<b>就业模块</b>的复盘填写；如需补充，请到<b>复盘填写</b>页操作。
            </div>
          </el-tab-pane>

          <el-tab-pane label="缴费记录" name="fee">
            <div class="sec-title"><span class="bar"></span>缴费记录</div>
            <div v-loading="feeLoading">
              <template v-if="feeData">
                <el-alert
                  v-if="!feeData.available"
                  :title="feeData.message || '财务管理暂无该学员的缴费记录'"
                  type="info"
                  :closable="false"
                  show-icon
                />
                <template v-else>
                  <el-alert
                    v-if="feeData.degraded"
                    :title="feeData.message || '财务管理暂不可用，以下为最近一次同步的缴费记录'"
                    type="warning"
                    :closable="false"
                    show-icon
                    style="margin-bottom: 10px"
                  />

                  <div v-if="feeData.summary" class="fee-kpi">
                    <span>应缴合计 <b>¥{{ feeData.summary.totalAmountYuan }}</b></span>
                    <span>已缴合计 <b class="ok">¥{{ feeData.summary.totalPaidYuan }}</b></span>
                    <span>
                      待缴合计
                      <b :class="Number(feeData.summary.totalUnpaid) > 0 ? 'bad' : 'ok'">
                        ¥{{ feeData.summary.totalUnpaidYuan }}
                      </b>
                    </span>
                  </div>

                  <el-table :data="feeData.records" border size="small">
                    <el-table-column type="index" label="序号" width="56" align="center" />
                    <el-table-column prop="feeTypeName" label="缴费类型" width="96" />
                    <el-table-column label="费用周期" width="96" align="center">
                      <template #default="{ row }">{{ row.period || '—' }}</template>
                    </el-table-column>
                    <el-table-column prop="deptName" label="部门" width="86" align="center" />
                    <el-table-column label="应缴（元）" width="106" align="right">
                      <template #default="{ row }">{{ row.amountYuan }}</template>
                    </el-table-column>
                    <el-table-column label="已缴（元）" width="106" align="right">
                      <template #default="{ row }">
                        <span :class="{ paid: Number(row.paidAmount) > 0 }">{{ row.paidAmountYuan }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column prop="payStatusName" label="状态" width="118" align="center" />
                    <el-table-column label="缴费日期" width="120" align="center">
                      <template #default="{ row }">{{ row.payDate || '—' }}</template>
                    </el-table-column>
                    <el-table-column label="到期日期" width="120" align="center">
                      <template #default="{ row }">{{ row.expireDate || '—' }}</template>
                    </el-table-column>
                  </el-table>
                </template>
              </template>
              <el-empty v-else-if="!feeLoading" description="暂无数据" :image-size="80" />
            </div>
            <div class="tab-tip">
              缴费数据来自<b>财务管理 · 缴费管理</b>；催缴记录请到<b>缴费管理</b>页查看。
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>

      <template #footer>
        <div class="pf-footer">
          <span v-if="basicEditMode" class="foot-tip">操作后请点击保存</span>
          <span v-else class="foot-tip"></span>
          <div>
            <el-button @click="detailVisible = false">关闭</el-button>
            <el-button v-if="basicEditMode" @click="cancelBasicEdit">取消</el-button>
            <el-button
              v-if="canOperate"
              type="primary"
              :disabled="!basicEditMode"
              :loading="saving"
              @click="saveBasic"
            >
              保存
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>

</template>

<style scoped>

.class-info-page {
  /* ⚠️ 不要用 flex column —— 卡片宽度会收缩成内容宽度，右侧留一大片空白。
     用普通块布局，宽度天然撑满，卡片之间用 margin 拉开。 */
  width: 100%;
}

.class-info-page :deep(.el-card) {
  width: 100%;
}

.class-info-page :deep(.el-card + .el-card) {
  margin-top: 12px;
}

.head-card :deep(.el-card__body) {
  padding: 16px 20px;
}

.head-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.class-name {
  font-size: 17px;
  font-weight: 600;
  color: #3E3230;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.stat {
  background: #FBF7F4;
  border-radius: 8px;
  padding: 12px 16px;
}

.stat-num {
  font-size: 24px;
  font-weight: 600;
  color: #CD3A33;
  line-height: 1.2;
}

.stat-num.warn {
  color: #C9852E;
}

.stat-num.danger {
  color: #CD3A33;
}

.unit {
  font-size: 13px;
  font-weight: 400;
  margin-left: 2px;
}

.stat-label {
  margin-top: 4px;
  font-size: 12.5px;
  color: #9C8D88;
}

.sub {
  color: #B3A69F;
}

.filter-card :deep(.el-card__body) {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
}

.table-card :deep(.el-card__body) {
  padding: 12px 20px 16px;
}

.empty-alert {
  margin-bottom: 12px;
}

.empty-hint {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.9;
  color: #A66A1F;
}

.empty-hint strong {
  color: #8A6A24;
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}

.repeat-warn {
  color: #C9852E;
  font-weight: 600;
}

/* ============================================================
 * 学员档案弹窗
 * ============================================================ */
.profile-dialog :deep(.el-dialog__header) {
  padding: 14px 20px;
  margin-right: 0;
  border-bottom: 1px solid #F1EAE5;
}

.profile-dialog :deep(.el-dialog__body) {
  padding: 0 20px;
  /* 弹窗内部滚动，避免超高 */
  max-height: calc(84vh - 130px);
  overflow-y: auto;
}

.profile-dialog :deep(.el-dialog__footer) {
  padding: 10px 20px;
  border-top: 1px solid #F1EAE5;
}

.pf-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.pf-name {
  font-size: 16px;
  font-weight: 600;
  color: #3E3230;
}

.pf-meta {
  font-size: 12.5px;
  color: #9C8D88;
}

.pf-body {
  min-height: 320px;
}

.pf-tabs :deep(.el-tabs__header) {
  margin-bottom: 14px;
}

/* 区块标题（参考页那条橙色竖条） */
.sec-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: #3E3230;
  margin: 6px 0 12px;
}

.sec-title .bar {
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: #C9852E;
}

.sec-action {
  margin-left: auto;
}

.sec-sub {
  margin-left: 10px;
  font-size: 12.5px;
  font-weight: 400;
  color: #9C8D88;
}

/* 字段卡片（4 列网格，仿参考页） */
.field-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.field {
  background: #FAF7F4;
  border-radius: 6px;
  padding: 10px 12px;
  min-height: 58px;
}

.field.span2 {
  grid-column: span 2;
}

.fl {
  font-size: 12px;
  color: #9C8D88;
  margin-bottom: 5px;
}

.fv {
  font-size: 14px;
  color: #3E3230;
  font-weight: 500;
  word-break: break-all;
}

/* 编辑态表单 */
.edit-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0 12px;
}

.edit-grid .span2 {
  grid-column: span 2;
}

.basic-form :deep(.el-form-item) {
  margin-bottom: 12px;
}

.resume-stu {
  font-size: 14px;
  font-weight: 600;
  color: #443432;
}
.resume-class-tip {
  font-size: 13px;
  color: #A2938E;
  line-height: 1.6;
}
.resume-class-tip b {
  color: #CD3A33;
}
.resume-stu .sub-text {
  font-weight: 400;
  margin-left: 6px;
}
.edit-tip {
  margin-top: 4px;
  padding: 8px 12px;
  background: #FBF3E5;
  border-radius: 6px;
  font-size: 12.5px;
  line-height: 1.7;
  color: #A66A1F;
}

/* 照片区 */
.photo-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 18px;
}

.photo-box {
  height: 110px;
  border: 1px dashed #D4C9C3;
  border-radius: 6px;
  background: #FAF7F4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
}

.photo-box:hover {
  border-color: #C4B8B2;
  background: #F6F3EF;
}

.photo-ph {
  font-size: 14px;
  color: #B3A69F;
}

.photo-hint {
  margin-top: 4px;
  font-size: 12px;
  color: #C4B8B2;
}

/* 成绩高亮 */
.score-blue {
  color: #CD3A33;
  font-weight: 600;
}

.exam-note {
  margin-bottom: 14px;
}

.tab-tip {
  margin-top: 12px;
  font-size: 12.5px;
  line-height: 1.7;
  color: #9C8D88;
}

/* ============ ★ 2026-10-06 缴费记录 Tab：汇总 KPI ============ */
.fee-kpi {
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
}
.fee-kpi > span {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
  font-size: 13px;
  color: var(--el-text-color-secondary);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.fee-kpi b {
  font-size: 15px;
  color: var(--el-text-color-primary);
}
.fee-kpi b.ok,
.paid {
  color: var(--el-color-success);
}
.fee-kpi b.bad {
  color: var(--el-color-danger);
}
.paid {
  font-weight: 600;
}

/* ============ 就业日志 Tab：面试情况卡片 ============ */
/* 面试情况是长文本，塞进表格列会挤成一坨，所以单独铺在下面 */
.emp-cards {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.emp-card {
  border: 1px solid #F1EAE5;
  border-radius: 6px;
  padding: 10px 14px;
  background: #FAF7F4;
}
.ec-head {
  font-size: 12.5px;
  font-weight: 600;
  color: #8A7B76;
  margin-bottom: 5px;
}
.ec-body {
  font-size: 13px;
  line-height: 1.75;
  color: #5F5350;
  white-space: pre-wrap;
  word-break: break-word;
}

.pf-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.foot-tip {
  font-size: 12.5px;
  color: #B3A69F;
}

/* ============================================================
 * 结业转就业（2026-10-01 新增）
 * 顶部右侧按钮 + 结业确认弹窗
 * ============================================================ */
.head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grad-body {
  min-height: 180px;
}

.grad-alert {
  margin-bottom: 16px;
}

.grad-tip {
  font-size: 13px;
  line-height: 1.9;
  color: #6B5C58;
}

.grad-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}

.grad-label {
  font-size: 13px;
  color: #6B5C58;
}

.grad-stat {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.grad-stat .gs {
  background: #F6F3EF;
  border-radius: 8px;
  padding: 12px 8px;
  text-align: center;
}

.gs-num {
  font-size: 22px;
  font-weight: 500;
  line-height: 1.2;
  color: #443432;
}

.gs-num.ok {
  color: #4E9A6C;
}

.gs-num.warn {
  color: #A66A1F;
}

.gs-num.danger {
  color: #CD3A33;
}

.gs-label {
  font-size: 12px;
  color: #9C8D88;
  margin-top: 4px;
}

.grad-skipped {
  margin-top: 14px;
  font-size: 13px;
  color: #6B5C58;
  line-height: 1.9;
}

.gs-title {
  margin-right: 8px;
}

.gs-item {
  display: inline-block;
  margin-right: 8px;
  color: #A66A1F;
}

</style>
