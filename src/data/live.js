// 生态实时数据层：页面打开与每 30 秒轮询时从本机服务拉取，适配成图谱数据形状。
// 全部经 vite 代理同源访问；任一服务不可达时对应域为空数组，页面不崩。

async function getJSON(url, ms = 4000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {signal: ctl.signal});
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function alive(url) {
  try { await getJSON(url, 2500); return true; } catch { return false; }
}

export const STATUS_ZH = {pending: '待办', dispatched: '已派', doing: '进行中', waiting_confirm: '待确认', review: '待复核'};

// WebView2 宿主通知（壁纸模式中文输入的关键）：input 聚焦时把输入框的屏幕矩形（设备像素）发给
// LivelyMod 播放器，播放器在原地浮一个原生输入框——原生窗口拿真实前台，系统输入法（IME）挂得上，
// 中文可输；普通浏览器里 window.chrome.webview 不存在，静默无副作用。
export const wvFocus = el => { try {
  const w = window.chrome?.webview; if (!w) return;
  if (el && el.getBoundingClientRect) {
    const r = el.getBoundingClientRect();
    const k = (window.screen.width || window.innerWidth) / Math.max(window.innerWidth, 1);   // CSS px → 设备 px
    w.postMessage(JSON.stringify({type: 'star-input-focus', x: Math.round(r.x * k), y: Math.round(r.y * k), w: Math.round(r.width * k), h: Math.round(r.height * k)}));
  } else w.postMessage('star-input-focus');
} catch {} };
export const wvBlur = () => { try { window.chrome?.webview?.postMessage('star-input-blur'); } catch {} };

// 一次全量拉取：工作站实体 + KB 现场 + memorycore 状态 + 核心服务探测 + 累计完成任务（vite 只读直查 hub.db）。
export async function fetchEcosystem() {
  const [ent, kb, mem, done] = await Promise.allSettled([
    getJSON('/api/entities'),   // 8331 已脱钩（用户令 10-15）：vite 中间件只读直查 hub.db，8331 停了星图照常
    getJSON('/api/kb-graph', 8000),
    getJSON('/api/memory-state', 2500),
    getJSON('/api/hub-done', 5000)
  ]);
  const entities = ent.status === 'fulfilled' && ent.value?.ok ? ent.value : null;
  const data = entities?.data || {};
  const notes = kb.status === 'fulfilled' ? (kb.value?.notes || []) : [];
  const memState = mem.status === 'fulfilled' && mem.value?.ok ? mem.value : null;
  const doneRows = done.status === 'fulfilled' && done.value?.ok ? (done.value.rows || []) : [];

  // 服务舱：核心端点独立探测 + 常驻工作者（来自实体心跳，cron 型不进，避免一片红）
  // 10-16 终局：8331 面板退役只剩引擎宿主（vite 子进程），两探活合一；不再展示"备用面板"卡
  const [hubOK, kbOK] = await Promise.all([
    alive('/hub/api/ping'),   // 引擎宿主在线与否独立 ping（断了只红卡片，不影响星图读数据）
    alive('/kb/healthz')   // kbserve 根路由是 404，健康探测必须打 /healthz（实测 200），否则在线服务被误报离线
  ]);
  const services = [
    {id: 'hub', name: '引擎宿主 8331', ok: hubOK, group: 'core', desc: '5引擎+写API（vite子进程，10-16引擎并轨）'},
    {id: 'kbserve', name: '检索服务 8342', ok: kbOK, group: 'core', desc: 'KB 语义+关键词混合检索'},
    ...(data.workers || []).filter(w => !w.retired && w.type === 'resident')
      .map(w => ({id: w.id, name: `${w.emoji || '🔧'} ${w.name}`, ok: w.hb_state === 'ok', group: 'worker', desc: w.desc || '', state: w.hb_state, url: w.ui || undefined}))   // ui→url（批C）：registry 里 VPN路由 8321/驾驶舱(备用8331)/RAG检索 8341 等网页入口接进服务舱；悬浮球已退役(10-16)
  ];

  return {
    tasks: [...(data.tasks?.open || []), ...doneRows],   // 未结 + 累计完成（done 行带 status='done'/done_at，任务流分类钻取用）
    commands: data.commands || [],        // 指令台账 M-xxx（10-16 批2：任务流钻取"指令台账"卡）
    decisions: data.decisions || [],
    memories: memState?.items || [],        // memorycore 池条目（降级候选摘要）
    memState,                               // 池状态摘要（updated/pool_n/defer_n/sync）
    services,
    notes,
    events: data.events || [],              // 生态流水：工作站事件表投影（id/ts/kind/actor/action/detail）
    vitals: data.vitals || null
  };
}

// 任务写操作：走 vite 代理 /panel→8331 引擎宿主（本机回环免口令）。
// op 取值与面板一致：done 完成 / doing 进行中 / wait 待确认 / reopen 退回待办 / dispatch 派发；
// note 改备注（note 字段全量覆盖）/ due 调截止（due 字段，空串=清除）——额外字段原样透传。
export async function taskAction({op, id, ...rest}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch('/panel/api/task', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({op, id, ...rest}),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 拍板收口：approved 走执行链（自动建任务+派 AI 会话），rejected/resolved 仅销账留痕。
export async function decideAction({id, to, choice}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch('/panel/api/decide', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id, to, choice}),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 通用写通道（10-16 批1/批2）：/panel/api/action {op,args} —— 引擎宿主 actions.py 的 OPS 表
// （task_add / decide_add / review_accept / review_reject / cmd_add / cmd rerun…全走 hub.py 同一写路径）
export async function panelAction(op, args, ms = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch('/panel/api/action', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({op, args: args || {}}),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 指令台账操作：rerun 一键重跑 / confirm 确认派发 / reject 驳回（走旧 /api/command 端点）
export async function cmdAction(payload) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch('/panel/api/command', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 附件上传（10-16 批1 新建任务模态）：{id, name, data_b64} → 引擎宿主落 attachments/<tid>/，
// 图片触发后台视觉解析自动回填 notes（面板同链路）。
export async function attachAction({id, name, data_b64}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch('/panel/api/attach', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id, name, data_b64}),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
