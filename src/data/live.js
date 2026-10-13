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

// 一次全量拉取：工作站实体 + KB 现场 + memorycore 状态 + 核心服务探测。
export async function fetchEcosystem() {
  const [ent, kb, mem] = await Promise.allSettled([
    getJSON('/hub/api/entities'),
    getJSON('/api/kb-graph', 8000),
    getJSON('/api/memory-state', 2500)
  ]);
  const entities = ent.status === 'fulfilled' && ent.value?.ok ? ent.value : null;
  const data = entities?.data || {};
  const notes = kb.status === 'fulfilled' ? (kb.value?.notes || []) : [];
  const memState = mem.status === 'fulfilled' && mem.value?.ok ? mem.value : null;

  // 服务舱：四个核心端点探测 + 常驻工作者（来自实体心跳，cron 型不进，避免一片红）
  const [hubOK, panelOK, kbOK] = await Promise.all([
    Promise.resolve(!!entities),
    alive('/panel/api/status'),
    alive('/kb/')
  ]);
  const services = [
    {id: 'hub', name: '工作站 8331', ok: hubOK, desc: '任务/拍板/实体投影（本图主数据源）'},
    {id: 'panel', name: '老面板 8330', ok: panelOK, desc: '现役写接口所在'},
    {id: 'kbserve', name: '检索服务 8342', ok: kbOK, desc: 'KB 语义+关键词混合检索'},
    ...(data.workers || []).filter(w => !w.retired && w.type === 'resident')
      .map(w => ({id: w.id, name: `${w.emoji || '🔧'} ${w.name}`, ok: w.hb_state === 'ok', desc: w.desc || '', state: w.hb_state}))
  ];

  return {
    tasks: data.tasks?.open || [],
    decisions: data.decisions || [],
    memories: memState?.items || [],        // memorycore 池条目（降级候选摘要）
    memState,                               // 池状态摘要（updated/pool_n/defer_n/sync）
    services,
    notes,
    vitals: data.vitals || null
  };
}

// 任务写操作：直连 8330 /api/task（经 vite 代理；本机回环免口令）。
// op 取值与面板一致：done 完成 / doing 进行中 / wait 待确认 / reopen 退回待办 / dispatch 派发。
export async function taskAction({op, id}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch('/panel/api/task', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({op, id}),
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
