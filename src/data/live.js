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

  // 服务舱：三个核心端点独立探测 + 常驻工作者（来自实体心跳，cron 型不进，避免一片红）
  const [hubOK, panelOK, kbOK] = await Promise.all([
    alive('/hub/api/ping'),   // 8331 数据已脱钩：在线与否独立 ping（断了只红卡片，不影响星图数据）
    alive('/panel/api/status'),
    alive('/kb/healthz')   // kbserve 根路由是 404，健康探测必须打 /healthz（实测 200），否则在线服务被误报离线
  ]);
  const services = [
    {id: 'hub', name: '工作站 8331', ok: hubOK, group: 'core', desc: '工作站底座（星图已直读 hub.db 脱钩）', url: 'http://127.0.0.1:8331/'},
    {id: 'panel', name: '老面板 8330', ok: panelOK, group: 'core', desc: '现役写接口所在', url: 'http://127.0.0.1:8330/'},
    {id: 'kbserve', name: '检索服务 8342', ok: kbOK, group: 'core', desc: 'KB 语义+关键词混合检索'},
    ...(data.workers || []).filter(w => !w.retired && w.type === 'resident')
      .map(w => ({id: w.id, name: `${w.emoji || '🔧'} ${w.name}`, ok: w.hb_state === 'ok', group: 'worker', desc: w.desc || '', state: w.hb_state, url: w.ui || undefined}))   // ui→url（批C）：registry 里 VPN路由 8321/驾驶舱 8330/悬浮球 float.html/RAG检索 8341 四个网页入口接进服务舱
  ];

  return {
    tasks: [...(data.tasks?.open || []), ...doneRows],   // 未结 + 累计完成（done 行带 status='done'/done_at，任务流分类钻取用）
    decisions: data.decisions || [],
    memories: memState?.items || [],        // memorycore 池条目（降级候选摘要）
    memState,                               // 池状态摘要（updated/pool_n/defer_n/sync）
    services,
    notes,
    events: data.events || [],              // 生态流水：工作站事件表投影（id/ts/kind/actor/action/detail）
    vitals: data.vitals || null
  };
}

// 任务写操作：直连 8330 /api/task（经 vite 代理；本机回环免口令）。
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
