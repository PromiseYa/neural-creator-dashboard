import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {fetchEcosystem, taskAction, decideAction, panelAction, cmdAction, attachAction, wvFocus, wvBlur} from '../data/live';
import {CONFIG, asset} from '../config';
import {buildGraph, forceLayout, stats, KINDS} from './graph';
import {renderMarkdown, stripFrontmatter} from './markdown';
import {Home} from './Home';
import {Count} from './Analysis';
import {Icon} from './icons';
import './neural.css';

// 生态星图：数据来自工作站实体(8331)+KB 现场扫描+服务探测，30 秒轮询刷新。
function Modal({title, en, onClose, children, wide}) {
  const ref = useRef(null), closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus({preventScroll: true});
    const key = e => {
      if (e.key === 'Escape' && !e.isComposing) closeRef.current();
      if (e.key === 'Tab') {
        const list = [...ref.current.querySelectorAll('button,input,textarea,select,a[href]')].filter(n => !n.disabled);
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (before?.isConnected) before.focus(); };
  }, []);
  return <div className="veil" onClick={onClose}>
    <section ref={ref} tabIndex={-1} className={`modal glass ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
      <header><h2>{title} <em>{en}</em></h2><button className="icon-btn" onClick={onClose} aria-label="关闭弹窗"><Icon name="close" size={16}/></button></header>
      {children}
    </section>
  </div>;
}

// 阅读全文（R21）：笔记按需拉 /api/note-raw、记忆条目拉 /api/mem-raw，本地轻量渲染（markdown.js）；
// [[双链]] 渲染成按钮，点击在星图内跳到那篇笔记（按标题/文件名匹配，找不到关弹窗回星图）。
function Reader({node, graph, onJump, onClose}) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let stop = false;
    setData(null);
    setErr(false);
    // note 的图谱 id 带 note: 前缀，接口要 KB 相对路径；memory 走 ZCode memory 目录全文接口（按文件名）
    const url = node.kind === 'memory'
      ? `/api/mem-raw?id=${encodeURIComponent(node.memory?.md || '')}`
      : `/api/note-raw?id=${encodeURIComponent(node.path || String(node.id).replace(/^note:/, ''))}`;
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status)))
      .then(d => { if (!stop && d?.ok) setData(d); else if (!stop) setErr(true); })
      .catch(() => { if (!stop) setErr(true); });
    return () => { stop = true; };
  }, [node.id]);

  const {meta, body} = useMemo(() => data ? stripFrontmatter(data.raw) : {meta: {}, body: ''}, [data]);
  const rendered = useMemo(() => data ? renderMarkdown(body, data.dir) : null, [data, body]);
  const tags = useMemo(() => String(meta.tags || '').replace(/^\[|\]$/g, '').split(/[,，]/).map(s => s.trim()).filter(Boolean), [meta]);

  const jump = e => {
    const b = e.target.closest?.('[data-wiki]');
    if (!b) return;
    const want = b.dataset.wiki;
    const n = graph.nodes.find(x => x.kind === 'note' && (x.title === want || String(x.path || '').endsWith(want + '.md')));
    if (n) onJump(n.id);
    else onClose();
  };

  return <Modal title={node.short || node.title} en={KINDS[node.kind].en} onClose={onClose} wide>
    <div className="reader" onClick={jump}>
      <p className="md-meta">
        <span className="quiet">{node.kind === 'memory' ? `memorycore · ${node.memory?.id || ''}` : node.path}</span>
        {(meta.updated || node.updated) && <span className="chip static mini">更新 {(meta.updated || node.updated)}</span>}
        {meta.created && <span className="chip static mini">建于 {meta.created}</span>}
        {data && <span className="chip static mini">{body.replace(/\s/g, '').length} 字</span>}
        {rendered?.images > 0 && <span className="chip static mini">{rendered.images} 图</span>}
        {tags.map(t => <span key={t} className="chip static mini tag">#{t}</span>)}
      </p>
      {err && <p className="quiet">全文读取失败（本地文件不可达）。</p>}
      {!data && !err && <p className="quiet">读取全文…</p>}
      {rendered && <article className="reader-md" dangerouslySetInnerHTML={{__html: rendered.html}}/>}
    </div>
  </Modal>;
}

// ＋新建任务（10-16 批1）：标题/优先级/截止/备注 + 截图粘贴或选择上传——
// task_add 走引擎宿主 actions（hub.add_task 同写路径），附件逐张 /api/attach（图片触发后台视觉解析回填）。
function TaskModal({onClose, onDone}) {
  const [title, setTitle] = useState('');
  const [prio, setPrio] = useState('mid');
  const [due, setDue] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const addFiles = list => {
    for (const f of Array.from(list || [])) {
      if (!/^(image|video)\//.test(f.type || '')) continue;
      if (f.size > 60 * 1024 * 1024) continue;
      const r = new FileReader();
      r.onload = () => setFiles(prev => [...prev, {name: f.name || `粘贴_${Date.now()}.png`, b64: String(r.result).split(',')[1] || ''}]);
      r.readAsDataURL(f);
    }
  };
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await panelAction('task_add', {title: title.trim(), source: 'star-map', prio, due: due || null, notes: notes.trim() || null});
      if (!r?.ok || !r.id) { setErr(r?.error || r?.msg || '建任务失败'); setBusy(false); return; }
      for (const f of files) await attachAction({id: r.id, name: f.name, data_b64: f.b64}).catch(() => {});
      onDone(r.id, files.length);
    } catch { setErr('写接口不可达（引擎宿主）'); setBusy(false); }
  };
  return <Modal title="新建任务" en="New task" onClose={onClose}>
    <div className="form-box" onPaste={e => { addFiles(e.clipboardData?.files); }}>
      <label>标题 <em>必填</em><input value={title} onChange={e => setTitle(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="一句话说清要做什么…" autoFocus/></label>
      <div className="form-row">
        <label>优先级<select value={prio} onChange={e => setPrio(e.target.value)} onFocus={wvFocus} onBlur={wvBlur}>
          <option value="high">高</option><option value="mid">中</option><option value="low">低</option>
        </select></label>
        <label>截止日期<input type="date" value={due} onChange={e => setDue(e.target.value)} onFocus={wvFocus} onBlur={wvBlur}/></label>
      </div>
      <label>备注<textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="补充说明、把握、回滚点…"/></label>
      <label>截图/视频附件
        <div className="paste-zone">
          <input type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm" onChange={e => addFiles(e.target.files)} onFocus={wvFocus} onBlur={wvBlur}/>
          <p className="quiet">点选择文件，或在弹窗内直接 Ctrl+V 粘贴截图（图片上传后自动视觉解析回填任务内容）</p>
          {files.length > 0 && <div className="paste-files">{files.map((f, i) => <span key={i} className="chip static">{f.name}<button onClick={() => setFiles(files.filter((_, k) => k !== i))} aria-label="移除">×</button></span>)}</div>}
        </div>
      </label>
      {err && <p className="form-err">{err}</p>}
      <div className="confirm-actions">
        <button className="primary" disabled={!title.trim() || busy} onClick={submit}>{busy ? '提交中…' : '记入任务池'} <em>Add</em></button>
        <button onClick={onClose}>取消 <em>Cancel</em></button>
      </div>
    </div>
  </Modal>;
}

// ＋登记拍板（10-16 批1）：三门槛落账走 hub.decide add 同路径，落账即推微信（hub 内建）。
function DecisionModal({onClose, onDone}) {
  const [title, setTitle] = useState('');
  const [proposal, setProposal] = useState('');
  const [why, setWhy] = useState('');
  const [impact, setImpact] = useState('');
  const [opts, setOpts] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true); setErr('');
    const opt = opts.split(/\n+/).map(s => s.trim()).filter(Boolean);
    try {
      const r = await panelAction('decide_add', {title: title.trim(), proposal: proposal.trim(), why: why.trim(), impact: impact.trim(), opt: opt.length ? opt : null});
      if (!r?.ok) { setErr(r?.error || r?.msg || '落账失败'); setBusy(false); return; }
      onDone(r.msg || '已落账并推微信');
    } catch { setErr('写接口不可达（引擎宿主）'); setBusy(false); }
  };
  return <Modal title="登记拍板" en="New decision" onClose={onClose}>
    <div className="form-box">
      <label>拍板事项 <em>必填</em><input value={title} onChange={e => setTitle(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="要拍什么板，一句话" autoFocus/></label>
      <label>方案<textarea rows={3} value={proposal} onChange={e => setProposal(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="推荐方案全文…"/></label>
      <div className="form-row">
        <label>拍板理由<textarea rows={2} value={why} onChange={e => setWhy(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="为什么是这个方案"/></label>
        <label>影响与代价<textarea rows={2} value={impact} onChange={e => setImpact(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="不做/做的代价"/></label>
      </div>
      <label>备选方案（每行一个，格式 A|描述）<textarea rows={2} value={opts} onChange={e => setOpts(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder={'A|描述一\nB|描述二'}/></label>
      {err && <p className="form-err">{err}</p>}
      <div className="confirm-actions">
        <button className="primary" disabled={!title.trim() || busy} onClick={submit}>{busy ? '提交中…' : '落账并推微信'} <em>Add</em></button>
        <button onClick={onClose}>取消 <em>Cancel</em></button>
      </div>
    </div>
  </Modal>;
}

// 生态体检（10-16 批3）：定时任务资产 + AI 定时 + 推送/派发链路（服务舱心跳）+ NOW.md 当前在办——
// 打开才拉（schtasks 5 分钟缓存），一次看全个人生态的健康面。
function EcoCheckModal({onClose, eco}) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let stop = false;
    Promise.all([fetch('/api/schedule').then(r => r.json()).catch(() => null), fetch('/api/now-md').then(r => r.json()).catch(() => null)])
      .then(([sch, now]) => { if (!stop) setD({sch, now}); });
    return () => { stop = true; };
  }, []);
  const v = eco?.vitals;
  const svcs = eco?.services || [];
  const links = [
    {name: '微信推送链路', key: 'wecompush', desc: 'done/拍板/告警即时推'},
    {name: '飞书指令桥', key: 'feishu', desc: 'feishu-bridge 常驻工作者'},
    {name: 'ZCode 派发执行', key: 'zrunner', desc: '领单执行 AI 定时'},
    {name: '微信哨兵', key: 'wxwatch', desc: '群消息三分拣'}
  ];
  for (const l of links) { const w = svcs.find(s => String(s.id || '').startsWith(l.key) || String(s.desc || '').includes(l.key)); l.ok = w ? w.ok : null; }
  return <Modal title="生态体检" en="Ecosystem check" onClose={onClose} wide>
    <div className="ecocheck">
      <section><h3>生命体征 <em>Vitals</em></h3>
        <div className="eco-kpis">
          <div><b>{v?.open_tasks ?? '—'}</b><span>未结任务</span></div>
          <div><b>{v?.pending_decisions ?? '—'}</b><span>待拍板</span></div>
          <div><b>{v?.review_tasks ?? 0}</b><span>待验收</span></div>
          <div><b>{v?.workers_ok ?? '—'}/{(v?.workers_ok || 0) + (v?.workers_late || 0) + (v?.workers_down || 0)}</b><span>工作者在线</span></div>
        </div>
      </section>
      <section><h3>推送 / 派发链路 <em>Channels</em></h3>
        <ul className="eco-list">{links.map(l => <li key={l.name}><i className={l.ok ? 'on' : l.ok === false ? 'off' : 'na'}/>{l.name}<small>{l.desc}</small></li>)}</ul>
      </section>
      <section><h3>定时生态 <em>Schedule</em></h3>
        {!d && <p className="quiet">读取中（schtasks 枚举约 2~5 秒）…</p>}
        {d?.sch?.ok === false && <p className="quiet">计划任务枚举失败：{d.sch.err}</p>}
        {d?.sch?.recurring?.length > 0 && <p className="eco-sub">AI 定时（dispatcher · recurring.json）</p>}
        {d?.sch?.recurring?.map(r => <div key={r.key} className="eco-row"><i className={r.enabled ? 'on' : 'off'}/>{r.key}<small>{r.prompt}</small></div>)}
        {d?.sch?.tasks && <>
          <p className="eco-sub">Windows 计划任务 {d.sch.tasks.length} 个（未禁用）</p>
          <ul className="eco-list compact">{d.sch.tasks.map(t => <li key={t.name}><i className="on"/>{t.name}{t.next && <small>下次 {String(t.next).slice(0, 16)}</small>}</li>)}</ul>
        </>}
      </section>
      <section><h3>当前在办 <em>NOW · hot state</em></h3>
        {d?.now?.ok
          ? <pre className="eco-now">{String(d.now.raw || '').split('\n').filter(l => l.trim() && !l.startsWith('<!--')).slice(0, 12).join('\n')}</pre>
          : <p className="quiet">{d ? 'NOW.md 不可达' : '读取中…'}</p>}
      </section>
    </div>
  </Modal>;
}

// review 打回（10-16 批2）：hub.review reject 必填原因，弹窗输入而非原生 prompt。
function ReviewRejectModal({id, onClose, onDone}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title={`打回 ${id}`} en="Reject review" onClose={onClose}>
    <div className="confirm-box">
      <p className="confirm-line">打回后任务回到待办，原因会写进事件留痕（必填）。</p>
      <textarea className="reject-reason" rows={3} value={reason} onChange={e => setReason(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="哪里不达标、要改什么…"/>
      <div className="confirm-actions">
        <button className="primary danger" disabled={!reason.trim() || busy} onClick={async () => {
          setBusy(true);
          const r = await panelAction('review_reject', {id, reason: reason.trim()}).catch(() => null);
          onDone(r?.ok ? `${id} 已打回` : `失败：${r?.error || '写接口不可达'}`);
        }}>{busy ? '提交中…' : '确认打回'} <em>Reject</em></button>
        <button onClick={onClose}>取消 <em>Cancel</em></button>
      </div>
    </div>
  </Modal>;
}

// 页面级错误边界（10-14 审查短板②，10-16 壁纸黑屏案后补上）：任何组件崩溃只显示错误卡+重载按钮，
// 不再整树卸载把壁纸/页面变黑屏（ReferenceError: useRef 案=点附件图全屏黑，root 直接清空）。
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = {err: null}; }
  static getDerivedStateFromError(err) { return {err}; }
  componentDidCatch(err) { try { console.error('[ErrorBoundary]', err); } catch {} }
  render() {
    if (!this.state.err) return this.props.children;
    return <div className="eb-fallback" role="alert">
      <h2>页面出了个错 <em>Something broke</em></h2>
      <p>{String(this.state.err?.message || this.state.err)}</p>
      <button className="pill primary" onClick={() => location.reload()}>刷新页面 <em>Reload</em></button>
      <p className="quiet">错误已拦下没有黑屏；若反复出现请带着上面这行报错找 AI。</p>
    </div>;
  }
}

function App() {
  // URL 定位参数 ?mod=tasks&zone=累计完成：可分享/可书签直达某层（也供无头截图验证壁纸端真实渲染）
  const [focus, setFocus] = useState(() => {
    const q = new URLSearchParams(location.search);
    const mod = q.get('mod'), zone = q.get('zone');
    return mod ? {mod, zone: zone || '', sel: null} : {mod: null, sel: null};
  });
  const [modal, setModal] = useState(null);
  const [readNode, setReadNode] = useState(null);
  const [toast, setToast] = useState('');
  const [eco, setEco] = useState(null);
  const [deciding, setDeciding] = useState(null);   // 待确认的拍板动作（弹窗替代原生 confirm，内嵌浏览器里原生框不渲染）
  const [rejecting, setRejecting] = useState(null); // review 打回（必填原因）
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  const ecoSigRef = useRef('');
  const pullRef = useRef(null);
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const e = await fetchEcosystem();
        if (stop) return;
        // 数据零变化跳过：setEco 会触发 buildGraph+forceLayout 全量重算（几百节点 O(N²)×520 轮，
        // 主线程秒级占死 = 壁纸周期性冻住，10-14 深夜 10s 探针实测坐实）。
        // 比对口径=喂给图与顶栏的全部字段；vitals 只取渲染用的 5 个计数——
        // 排除 vitals.ts 等每轮必变但不上屏的字段，否则跳过永不生效。
        const vv = e.vitals || {};
        const sig = JSON.stringify([e.tasks, e.decisions, e.memories, e.memState, e.services, e.notes, e.events,
          vv.open_tasks, vv.pending_decisions, vv.workers_ok, vv.workers_late, vv.workers_down]);
        if (sig === ecoSigRef.current) return;
        ecoSigRef.current = sig;
        setEco(e);
      } catch { /* 单次失败保静默，下轮再试 */ }
    };
    pullRef.current = pull;
    pull();
    const iv = setInterval(pull, 30000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2800); return () => clearTimeout(t); }, [toast]);

  const close = useCallback(() => setModal(null), []);
  const graph = useMemo(() => buildGraph(eco || {}), [eco]);
  const layout = useMemo(() => forceLayout(graph), [graph]);
  const s = stats(graph);
  const v = eco?.vitals;

  const openInGraph = id => {
    const n = graph.index.get(id);
    const mod = {task: 'tasks', note: 'kb', decision: 'decisions', memory: 'memory', service: 'services', command: 'tasks'}[n?.kind];
    // 落到内容真实所在的目录层（笔记=分区+子路径；任务=所在清单层；服务=所在分类层），
    // 层级链完整展开：水母 → 分类 → 清单 → 选中项，不再只停在水母+第一层
    let z = null;
    if (mod === 'kb' && String(n.folder || '').startsWith('f:kb:'))
      z = [n.folder.slice(5), n.subzone].filter(Boolean).join('/') || null;
    else if (mod === 'tasks') {
      const today = new Date().toISOString().slice(0, 10);
      z = n.kind === 'command' ? '指令台账'
        : n.task?.status === 'review' ? '待验收'
        : n.task?.status !== 'done' ? '待办'
        : String(n.task?.done_at || '').slice(0, 10) === today ? '今日完成'
        : '累计完成/所有';
    }
    else if (mod === 'services')
      z = null;   // 服务舱已平铺（10-15），无分类层
    if (mod) setFocus({mod, zone: z, sel: id});
  };
  const onAction = useCallback(a => {
    if (a.type === 'read') setReadNode(graph.index.get(a.id));
    if (a.type === 'taskOp') {
      setToast(`${a.id} 执行中…`);
      taskAction(a).then(r => {
        setToast(r?.ok ? (r.msg || '已执行') : `失败：${r?.msg || '未知错误'}`);
        if (r?.ok) pullRef.current?.();
      }).catch(() => setToast('写接口不可达（引擎宿主）'));
    }
    if (a.type === 'reviewOp') {
      if (a.op === 'accept') {
        setToast(`${a.id} 验收中…`);
        panelAction('review_accept', {id: a.id}).then(r => {
          setToast(r?.ok ? (r.msg || `${a.id} 已验收`) : `失败：${r?.error || r?.msg || '未知'}`);
          if (r?.ok) pullRef.current?.();
        }).catch(() => setToast('写接口不可达（引擎宿主）'));
      } else setRejecting(a.id);   // 打回必填原因 → 小弹窗
    }
    if (a.type === 'cmdOp' && a.op === 'rerun') {
      setToast(`${a.id} 重跑中…`);
      cmdAction({action: 'rerun', id: a.id}).then(r => {
        setToast(r?.ok ? (r.msg || '已重跑') : `失败：${r?.msg || '未知错误'}`);
        if (r?.ok) pullRef.current?.();
      }).catch(() => setToast('写接口不可达（引擎宿主）'));
    }
    if (a.type === 'addTask') setModal('task');
    if (a.type === 'addDecision') setModal('decision');
    if (a.type === 'ecoCheck') setModal('eco');
    if (a.type === 'decideOp') {
      setDeciding(a);
    }
  }, [graph]);

  const runDecide = useCallback(a => {
    setDeciding(null);
    setToast(`${a.id} 收口中…`);
    decideAction(a).then(r => {
      setToast(r?.ok ? (r.msg || '已收口') : `失败：${r?.msg || '未知错误'}`);
      if (r?.ok) pullRef.current?.();
    }).catch(() => setToast('写接口不可达（引擎宿主）'));
  }, []);

  return <div className="neural page-home">
    <header className="topbar">
      <a className="brand" href={asset('')} onClick={e => { e.preventDefault(); setFocus({mod: null, sel: null}); }}>
        <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 28" width="18" height="21"><path fill="#7d7f7c" d="m14 1 8 7-2 12-7 7-10-5L1 12 8 4Z"/><path fill="#d8d9d6" d="m14 1-3 10 2 16 7-7 2-12Z"/><path fill="#ecd9a6" d="m14 1-3 10 11-3Z"/><path fill="#a9aba7" d="m1 12 10-1 2 16-10-5Z"/></svg></span>
        <span className="brand-text">{CONFIG.brand.name} <b>/ {CONFIG.brand.sub}</b><small>{CONFIG.brand.tagline} · {CONFIG.brand.taglineEn}</small></span>
      </a>
      <div className="top-actions">
        {v && <div className="pill-group glass" role="status" title="工作站生命体征 · 点击直达">
          <button onClick={() => setFocus({mod: 'tasks', zone: '待办', sel: null})}><Icon name="agent" size={13}/>任务 <b><Count value={v.open_tasks}/></b></button>
          {(v.review_tasks || 0) > 0 && <button className="hot" onClick={() => setFocus({mod: 'tasks', zone: '待验收', sel: null})} title="待验收队列">验收 <b>{v.review_tasks}</b></button>}
          <button onClick={() => setFocus({mod: 'decisions', zone: '', sel: null})}>拍板 <b><Count value={v.pending_decisions}/></b></button>
          <button onClick={() => setFocus({mod: 'services', zone: '', sel: null})}>工者 <b>{v.workers_ok}</b><em>/{v.workers_ok + v.workers_late + v.workers_down}</em></button>
        </div>}
        <button className="avatar eco-avatar" onClick={() => setModal('eco')} aria-label="生态体检：定时任务/链路/在办一览" title="生态体检">🩺</button>
        <button className="avatar" onClick={() => setModal('about')} aria-label="关于本图与数据来源"><img src={asset(CONFIG.avatar)} alt=""/></button>
      </div>
    </header>

    <main>
      <Home graph={graph} layout={layout} focus={focus} setFocus={setFocus} onAction={onAction} onAbout={() => setModal('about')} reduced={reduced} ecoEvents={eco?.events || []}/>
    </main>

    <footer className="site-foot">
      <button onClick={() => setModal('about')}><Icon name="info" size={13}/>数据来源：工作站实体投影 + 知识库现场扫描 · 任务·拍板就地收口 <em>Local &amp; live</em></button>
      <span>{CONFIG.footer.zh}<em>{CONFIG.footer.en}</em></span>
    </footer>

    {toast && <div className="toast glass" role="status"><Icon name="check" size={15}/>{toast}</div>}

    {modal === 'about' && <Modal title="关于这张生态星图" en="About the ecosystem" onClose={close}>
      <div className="about">
        <p>中心 <em>Core</em>：<strong>{CONFIG.workspace}</strong> · 数据每 30 秒从本机服务实时拉取。</p>
        <hr/>
        <h3>五个模块的数据来源 <em>Where the data comes from</em></h3>
        <ul>
          <li><b>任务流 Tasks</b>：工作站任务（T-xxx，含待验收/指令台账钻取），vite 直读 hub.db；详情栏显示任务内容/执行时间线/截图视频附件，可改状态、接受验收、重跑指令。</li>
          <li><b>知识库 Knowledge</b>：本地知识库 markdown 笔记现场扫描，[[双链]] 与话题标签自动连线；分区 → 子目录 → 笔记逐层钻入，长清单用滚轮往下平移；详情栏看正文预览，「阅读全文」渲染 markdown（标题/表格/代码块/图片），双链可点在图内跳转。</li>
          <li><b>拍板台 Decisions</b>：三门槛落账的待拍板事项（D-xxx），详情栏就地收口（批准走执行链，多方案可选）。</li>
          <li><b>记忆池 Memory</b>：memorycore 池条目实时状态（降级候选摘要，中文标题）；可点「阅读全文」看整条记忆。</li>
          <li><b>服务舱 Services</b>：核心服务与常驻工作者两级分类；健康探测 + 心跳，卡片右侧直接看在线状态。</li>
          <li><b>生态流水 Stream</b>：左下角工作站最近事件（派发/状态/拍板），30 秒轮询，新到的金色高亮。</li>
        </ul>
        <p>当前：{s.content} 条内容 · {s.links} 条连接 · {s.mutual} 组双向 · {s.ghosts} 个未创建双链。</p>
        <p className="quiet">数据全部本机，不外发；任务/拍板/验收/指令全部在星图内闭环（顶栏 🩺=生态体检）。<em>Local first, nothing is published.</em></p>
      </div>
    </Modal>}
    {deciding && <Modal title="拍板确认" en="Confirm decision" onClose={() => setDeciding(null)}>
      {(() => {
        const d = graph.nodes.find(n => n.decision?.id === deciding.id)?.decision || {};
        const TO_ZH = {approved: '批准', rejected: '否决', resolved: '销账（已处理）'};
        return <div className="confirm-box">
          <p className="confirm-line"><b>{deciding.id}</b>{d.title ? ` · ${d.title}` : ''}</p>
          <p className="confirm-line">动作：<b>{TO_ZH[deciding.to] || deciding.to}</b>{deciding.choice ? `（方案 ${deciding.choice}）` : ''}</p>
          {deciding.to === 'approved' && <p className="quiet">批准会走执行链：自动建关联任务并派 AI 执行会话。</p>}
          <div className="confirm-actions">
            <button className="primary" onClick={() => runDecide(deciding)}>确认执行 <em>Confirm</em></button>
            <button onClick={() => setDeciding(null)}>取消 <em>Cancel</em></button>
          </div>
        </div>;
      })()}
    </Modal>}
    {modal === 'task' && <TaskModal onClose={close} onDone={(tid, natt) => {
      setModal(null);
      setToast(natt ? `${tid} 已入池（${natt} 附件解析中，约 20 秒回填）` : `${tid} 已入池`);
      pullRef.current?.();
    }}/>}
    {modal === 'decision' && <DecisionModal onClose={close} onDone={msg => {
      setModal(null);
      setToast(msg || '已落账并推微信');
      pullRef.current?.();
    }}/>}
    {modal === 'eco' && <EcoCheckModal onClose={close} eco={eco}/>}
    {rejecting && <ReviewRejectModal id={rejecting} onClose={() => setRejecting(null)} onDone={msg => {
      setRejecting(null);
      setToast(msg);
      pullRef.current?.();
    }}/>}
    {readNode && <Reader node={readNode} graph={graph} onJump={id => { setReadNode(null); openInGraph(id); }} onClose={() => setReadNode(null)}/>}
  </div>;
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><App/></ErrorBoundary>);

// 壁纸模式标记（WebView2 宿主里才存在 chrome.webview）：底部元素避让任务栏区，
// 浏览器窗口模式无任务栏遮挡不受影响
if (window.chrome?.webview) document.body.classList.add('wallpaper-mode');

// FPS 诊断浮层（?fps=1 开启）：量化"卡不卡"——实时帧率/超 20ms 帧占比/最差帧耗时；
// 不带参数时零开销，平时不渲染
if (new URLSearchParams(location.search).get('fps')) {
  const el = document.createElement('div');
  el.className = 'fps-badge';
  document.body.appendChild(el);
  let n = 0, slow = 0, worst = 0, t0 = performance.now(), last = t0;
  const tick = now => {
    requestAnimationFrame(tick);
    const dt = now - last; last = now; n++;
    if (dt > 20) slow++;
    if (dt < 2000 && dt > worst) worst = dt;
    if (now - t0 >= 1000) {
      el.textContent = `${Math.round(n * 1000 / (now - t0))} fps · 超时帧 ${Math.round(slow / n * 100)}% · 最差 ${Math.round(worst)}ms`;
      n = 0; slow = 0; worst = 0; t0 = now;
    }
  };
  requestAnimationFrame(tick);
}
