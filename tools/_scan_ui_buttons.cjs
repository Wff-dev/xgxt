/**
 * 前端按钮清点器（只读）
 * 扫描指定 vue 文件的 template 部分，抽出：
 *   · el-tab-pane 的 label（子页签 = 页面内的功能分区）
 *   · el-button 的文案 + 同行/上文的 v-if 条件
 *   · v-readonly-hide 标记（只读角色隐藏 = 写操作）
 * 输出到 ../输出/ui-buttons.txt
 */
const fs = require('fs');
const path = require('path');

const FILES = process.argv.slice(2);
const out = [];

for (const rel of FILES) {
  const p = path.resolve(rel);
  if (!fs.existsSync(p)) {
    out.push(`=== ${rel} === (缺失)`);
    continue;
  }
  const src = fs.readFileSync(p, 'utf8');
  const tplEnd = src.indexOf('<script');
  const tpl = tplEnd > 0 ? src.slice(0, tplEnd) : src;

  out.push(`\n=== ${rel} ===`);

  // 页签
  const tabs = [...tpl.matchAll(/<el-tab-pane([^>]*)>/g)];
  if (tabs.length) {
    out.push('  [TABS]');
    tabs.forEach((m) => {
      const attrs = m[1];
      const label = (attrs.match(/label="([^"]*)"/) || [])[1] || '?';
      const vif = (attrs.match(/v-if="([^"]*)"/) || [])[1];
      out.push(`    · ${label}${vif ? `   (v-if: ${vif})` : ''}`);
    });
  }

  // 按钮（含多行写法）
  const btns = [];
  const re = /<el-button\b([\s\S]{0,400}?)(\/?)>/g;
  let m;
  while ((m = re.exec(tpl))) {
    const attrs = m[1];
    const start = m.index + m[0].length;
    const rest = tpl.slice(start, start + 220);
    let text = '';
    if (!m[2]) {
      // 无自闭合 → 取到 </el-button>
      const close = tpl.indexOf('</el-button>', start);
      if (close > 0) text = tpl.slice(start, close);
    } else {
      // 自闭合但紧跟文本（如 <el-button xxx /> 少见）忽略
      text = '';
    }
    text = text.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const vif = (attrs.match(/v-if="([^"]*)"/) || [])[1];
    const readonlyHide = /v-readonly-hide/.test(attrs);
    const disabled = (attrs.match(/:disabled="([^"]*)"/) || [])[1];
    if (!text && !vif) continue;
    btns.push({ text, vif, readonlyHide, disabled });
  }
  out.push('  [BUTTONS]');
  const seen = new Set();
  btns.forEach((b) => {
    const key = `${b.text}|${b.vif || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const flags = [
      b.readonlyHide ? 'readonly-hide' : '',
      b.disabled ? `:disabled=${b.disabled}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    out.push(`    · ${b.text || '(无文案)'}${b.vif ? `   (v-if: ${b.vif})` : ''}${flags ? '  {' + flags + '}' : ''}`);
  });
}

const dir = path.resolve(__dirname, '../输出');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'ui-buttons.txt'), out.join('\n'), 'utf8');
console.log('OK ->', path.join(dir, 'ui-buttons.txt'));
