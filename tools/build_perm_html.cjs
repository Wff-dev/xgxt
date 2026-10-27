/**
 * 把 输出/权限总表.json 打包成单文件 HTML（数据内联，双击即开）
 * 用法：node tools/build_perm_html.cjs
 */
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '../输出');
const data = JSON.parse(fs.readFileSync(path.join(dir, '权限总表.json'), 'utf8'));

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>良志学管系统 · 全系统权限总表</title>
<style>
  :root{
    --bg:#f5f6f8; --panel:#ffffff; --line:#e6e8eb; --line2:#eef0f3;
    --text:#1f2329; --sub:#646a73; --hint:#8f959e;
    --brand:#2b6cf6; --brand-soft:#eef4ff;
    --ok:#0f9d58; --warn:#e8871e; --danger:#d93f3f;
    --radius:10px;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;background:var(--bg);color:var(--text);
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .top{
    background:var(--panel);border-bottom:1px solid var(--line);
    padding:14px 20px;display:flex;flex-wrap:wrap;gap:14px;align-items:center;
    position:sticky;top:0;z-index:20;
  }
  .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}
  .brand .dot{width:9px;height:9px;border-radius:50%;background:var(--brand)}
  .stats{display:flex;gap:14px;color:var(--sub);font-size:13px;flex-wrap:wrap}
  .stats b{color:var(--text)}
  .grow{flex:1}
  input[type=search],select{
    height:32px;border:1px solid var(--line);border-radius:8px;padding:0 10px;
    background:#fff;color:var(--text);font-size:13px;outline:none;
  }
  input[type=search]{width:240px}
  input[type=search]:focus,select:focus{border-color:var(--brand)}
  .seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .seg button{
    border:0;background:#fff;padding:0 12px;height:30px;cursor:pointer;
    font-size:13px;color:var(--sub);
  }
  .seg button.on{background:var(--brand);color:#fff}
  .wrap{display:flex;gap:16px;padding:16px 20px 40px;align-items:flex-start}
  .side{
    width:320px;flex:none;background:var(--panel);border:1px solid var(--line);
    border-radius:var(--radius);padding:8px;position:sticky;top:78px;
    max-height:calc(100vh - 100px);overflow:auto;
  }
  .board{margin-bottom:6px}
  .board>.bh{
    display:flex;align-items:center;gap:8px;padding:8px 10px;font-weight:600;
    color:var(--sub);font-size:12px;letter-spacing:.4px;
  }
  .pg{
    display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;
    cursor:pointer;color:var(--text);
  }
  .pg:hover{background:#f7f8fa}
  .pg.on{background:var(--brand-soft);color:var(--brand);font-weight:600}
  .pg .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pg .ct{
    font-size:11px;color:var(--hint);background:#f2f3f5;border-radius:20px;
    padding:0 7px;line-height:18px;
  }
  .pg.on .ct{background:#dbe7ff;color:var(--brand)}
  .main{flex:1;min-width:0}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px}
  .ph{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}
  .ph h2{margin:0;font-size:19px}
  .ph .path{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--hint);background:#f5f6f8;border-radius:6px;padding:2px 7px}
  .desc{color:var(--sub);font-size:13px;margin:2px 0 14px}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
  .chip{font-size:12px;padding:2px 9px;border-radius:20px;background:#f2f3f5;color:var(--sub)}
  .chip.b{background:var(--brand-soft);color:var(--brand)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line2);vertical-align:top}
  th{white-space:nowrap}
  th{color:var(--hint);font-weight:600;font-size:12px;background:#fafbfc;position:sticky;top:0}
  td.n{color:var(--hint);width:36px}
  td.act{font-weight:600;min-width:120px;white-space:nowrap}
  .tag{display:inline-block;font-size:11.5px;padding:1px 7px;border-radius:5px;background:#f2f3f5;color:var(--sub);white-space:nowrap}
  td:nth-child(3){white-space:nowrap}
  .tag.view{background:#eef4ff;color:#2b6cf6}
  .tag.add{background:#eaf7ef;color:#0f9d58}
  .tag.edit{background:#fff5e8;color:#c9791a}
  .tag.del{background:#fdecec;color:#d93f3f}
  .tag.approve{background:#f3edff;color:#7c4dff}
  .tag.export{background:#e9f6f8;color:#0b8b9c}
  code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:#f5f6f8;padding:1px 5px;border-radius:4px}
  .who{display:flex;flex-wrap:wrap;gap:4px}
  .who .r{font-size:11.5px;background:#f7f8fa;border:1px solid var(--line2);border-radius:5px;padding:0 6px;color:var(--sub)}
  .who .r.hit{background:#eaf7ef;border-color:#cdebd8;color:#0f7c46;font-weight:600}
  .who .none{color:var(--danger);font-size:12px;font-weight:600}
  .empty{padding:40px;text-align:center;color:var(--hint)}
  .legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--hint);margin-top:16px}
  .foot{padding:0 20px 30px;color:var(--hint);font-size:12px}
  @media(max-width:980px){
    .wrap{flex-direction:column}
    .side{width:100%;position:static;max-height:none}
    input[type=search]{width:160px}
  }
</style>
</head>
<body>
<div class="top">
  <div class="brand"><span class="dot"></span>良志学管系统 · 全系统权限总表</div>
  <div class="stats" id="stats"></div>
  <div class="grow"></div>
  <input type="search" id="q" placeholder="搜页面 / 路由 / 动作…">
  <select id="role"><option value="">全部职位</option></select>
  <div class="seg" id="seg">
    <button data-v="all" class="on">全部动作</button>
    <button data-v="mine">只看该职位有权的</button>
  </div>
</div>

<div class="wrap">
  <aside class="side" id="side"></aside>
  <section class="main">
    <div class="card" id="main"></div>
    <div class="legend" id="legend"></div>
  </section>
</div>
<div class="foot" id="foot"></div>

<script>
const DATA = __DATA__;

const state = { pageKey:null, role:'', onlyMine:false, q:'' };
const elQ = document.getElementById('q');
const elRole = document.getElementById('role');
const elSeg = document.getElementById('seg');
const elSide = document.getElementById('side');
const elMain = document.getElementById('main');
const elStats = document.getElementById('stats');
const elFoot = document.getElementById('foot');

const ALL_PAGES = [];
DATA.boards.forEach(b => b.pages.forEach(p => ALL_PAGES.push({...p, board:b})));
const KEY = (b,p) => b.moduleKey + '/' + p.key;

/* 统计 */
const roleNames = DATA.roles.map(r=>r.name);
elStats.innerHTML = [
  '<span><b>'+DATA.stats.modCount+'</b> 板块</span>',
  '<span><b>'+DATA.stats.itemCount+'</b> 页面</span>',
  '<span><b>'+DATA.stats.actionCount+'</b> 动作</span>',
  '<span><b>'+DATA.roles.length+'</b> 职位</span>',
].join('');

/* 职位下拉 */
DATA.roles.forEach(r=>{
  const o=document.createElement('option');
  o.value=r.name; o.textContent=r.name+'（'+r.permCount+'）';
  elRole.appendChild(o);
});

/* 角色 → 有权页面集合 */
const rolePages = {};
DATA.roles.forEach(r=>{
  const set=new Set();
  r.pages.forEach(p=>set.add(p.moduleName+'||'+p.pageName));
  rolePages[r.name]=set;
});

function match(p){
  if(state.q){
    const q=state.q.toLowerCase();
    const hay=(p.name+' '+p.path+' '+p.actions.map(a=>a.name+' '+(a.ui||'')+' '+(a.ops||[]).join(' ')).join(' ')).toLowerCase();
    if(!hay.includes(q)) return false;
  }
  if(state.role && state.onlyMine){
    return rolePages[state.role].has(p.board.name+'||'+p.name);
  }
  if(state.role){
    // 有该职位的授权明细的页面才显示
    return p.actions.some(a=>a.roles.includes(state.role));
  }
  return true;
}

function renderSide(){
  elSide.innerHTML='';
  DATA.boards.forEach(b=>{
    const pages=b.pages.filter(p=>match({...p, board:b}));
    if(!pages.length) return;
    const bd=document.createElement('div'); bd.className='board';
    const bh=document.createElement('div'); bh.className='bh';
    bh.textContent=b.icon+' '+b.name+'（'+pages.length+' 页）';
    bd.appendChild(bh);
    pages.forEach(p=>{
      const row=document.createElement('div');
      row.className='pg'+(state.pageKey===KEY(b,p)?' on':'');
      const n=p.actions.filter(a=>!state.role||a.roles.includes(state.role)).length;
      row.innerHTML='<span class="nm">'+p.name+'</span><span class="ct">'+(state.role?n+'/'+p.actions.length:p.actions.length)+'</span>';
      row.onclick=()=>{ state.pageKey=KEY(b,p); renderSide(); renderMain(); };
      bd.appendChild(row);
    });
    elSide.appendChild(bd);
  });
  if(!elSide.children.length) elSide.innerHTML='<div class="empty">没有匹配的页面</div>';
}

const BASE_CLS={1:'view',2:'add',3:'edit',4:'del',5:'approve',6:'export'};

function renderMain(){
  if(!state.pageKey){
    elMain.innerHTML='<div class="empty">左侧选一个页面，或直接搜索动作名</div>';
    elLegend();
    return;
  }
  const p=ALL_PAGES.find(x=>KEY(x.board,x)===state.pageKey);
  if(!p){ elMain.innerHTML='<div class="empty">页面已不在台账里</div>'; return; }
  const acts=p.actions.filter(a=>!state.role||(state.onlyMine? a.roles.includes(state.role):true));
  const shown=acts.filter(a=>{
    if(!state.q) return true;
    const q=state.q.toLowerCase();
    return (a.name+' '+(a.ui||'')+' '+(a.ops||[]).join(' ')).toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
  });
  const granted=shown.filter(a=>state.role&&a.roles.includes(state.role)).length;

  let h='<div class="ph"><h2>'+p.name+'</h2><span class="path">'+p.path+'</span>'+
    (state.role?'<span class="chip b">'+state.role+'：'+granted+' / '+shown.length+'</span>':'')+'</div>';
  if(p.remark) h+='<div class="desc">'+p.remark+'</div>';
  h+='<div class="chips">';
  (p.pageCodes||[]).forEach(c=>h+='<span class="chip">页面码 '+c+'</span>');
  h+='<span class="chip">动作 '+p.actions.length+' 个</span>';
  h+='</div>';

  h+='<table><thead><tr><th>#</th><th>动作</th><th>类型</th><th>界面上在哪</th><th>后端操作码</th><th>已授权职位</th></tr></thead><tbody>';
  shown.forEach((a,i)=>{
    const ops=(a.ops&&a.ops.length)?a.ops.map(o=>'<code>'+o+'</code>').join('<br>'):'<span style="color:#8f959e">界面级</span>';
    const who=a.roles.length
      ? '<div class="who">'+roleNames.map(r=>'<span class="r'+(state.role===r?' hit':'')+'">'+r+'</span>').filter((s,i)=>a.roles.includes(roleNames[i])).join('')+'</div>'
      : '<span class="none">无人授权</span>';
    h+='<tr><td class="n">'+(i+1)+'</td><td class="act">'+a.name+'</td>'+
       '<td><span class="tag '+BASE_CLS[a.base]+'">'+a.baseName+'</span></td>'+
       '<td>'+(a.ui||'—')+'</td><td>'+ops+'</td><td>'+who+'</td></tr>';
  });
  h+='</tbody></table>';
  if(!shown.length) h+='<div class="empty">该页面下没有符合筛选条件的动作</div>';
  elMain.innerHTML=h;
  elLegend();
}

function elLegend(){
  const html='<span>图例：</span>'+
   ['view 查看','add 新增','edit 编辑','del 删除','approve 审批','export 导出']
    .map((t,i)=>'<span class="tag '+(['view','add','edit','del','approve','export'][i])+'">'+t.split(' ')[1]+'</span>').join('');
  document.getElementById('legend').innerHTML=html;
}

/* 事件 */
elQ.oninput=()=>{ state.q=elQ.value.trim(); renderSide(); renderMain(); };
elRole.onchange=()=>{ state.role=elRole.value; renderSide(); renderMain(); };
elSeg.querySelectorAll('button').forEach(b=>{
  b.onclick=()=>{
    elSeg.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    state.onlyMine = b.dataset.v==='mine';
    if(state.onlyMine && !state.role) elRole.focus();
    renderSide(); renderMain();
  };
});

elFoot.textContent='数据口径：permTree.ts 动作定义 + sms_perm 实时授权　｜　生成时间 '+DATA.generatedAt+'　｜　由 scripts/gen-perm-doc.ts 生成';

/* 默认选中第一个页面 */
state.pageKey = KEY(DATA.boards[0], DATA.boards[0].pages[0]);
renderSide(); renderMain();
</script>
</body>
</html>`;

fs.writeFileSync(path.join(dir, '权限总表.html'), HTML.replace('__DATA__', JSON.stringify(data)), 'utf8');
console.log('OK ->', path.join(dir, '权限总表.html'));
