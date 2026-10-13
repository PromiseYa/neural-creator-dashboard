import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {fetchEcosystem, taskAction, decideAction} from '../data/live';
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

// 阅读全文（R21）：按需拉 /api/note-raw 全文，本地轻量渲染（markdown.js）；
// [[双链]] 渲染成按钮，点击在星图内跳到那篇笔记（按标题/文件名匹配，找不到关弹窗回星图）。
function Reader({node, graph, onJump, onClose}) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let stop = false;
    setData(null);
    setErr(false);
    const nid = node.path || String(node.id).replace(/^note:/, '');   // 图谱 id 带 note: 前缀，接口要 KB 相对路径
    fetch(`/api/note-raw?id=${encodeURIComponent(nid)}`)
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
        <span className="quiet">{node.path}</span>
        {meta.updated && <span className="chip static mini">更新 {meta.updated}</span>}
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

function App() {
  const [focus, setFocus] = useState({mod: null, sel: null});
  const [modal, setModal] = useState(null);
  const [readNode, setReadNode] = useState(null);
  const [toast, setToast] = useState('');
  const [eco, setEco] = useState(null);
  const [deciding, setDeciding] = useState(null);   // 待确认的拍板动作（弹窗替代原生 confirm，内嵌浏览器里原生框不渲染）
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  const pullRef = useRef(null);
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const e = await fetchEcosystem();
        if (!stop) setEco(e);
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
    const mod = {task: 'tasks', note: 'kb', decision: 'decisions', memory: 'memory', service: 'services'}[n?.kind];
    // 落到笔记真实所在目录层（分区 + 完整子路径）
    if (mod) setFocus({mod, zone: mod === 'kb' && String(n.folder || '').startsWith('f:kb:')
      ? [n.folder.slice(5), n.subzone].filter(Boolean).join('/') || null : null, sel: id});
  };
  const onAction = useCallback(a => {
    if (a.type === 'read') setReadNode(graph.index.get(a.id));
    if (a.type === 'station') window.open('http://127.0.0.1:8331/', '_blank');
    if (a.type === 'taskOp') {
      setToast(`${a.id} 执行中…`);
      taskAction(a).then(r => {
        setToast(r?.ok ? (r.msg || '已执行') : `失败：${r?.msg || '未知错误'}`);
        if (r?.ok) pullRef.current?.();
      }).catch(() => setToast('写接口不可达（8330）'));
    }
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
    }).catch(() => setToast('写接口不可达（8330）'));
  }, []);

  return <div className="neural page-home">
    <header className="topbar">
      <a className="brand" href={asset('')} onClick={e => { e.preventDefault(); setFocus({mod: null, sel: null}); }}>
        <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 28" width="18" height="21"><path fill="#7d7f7c" d="m14 1 8 7-2 12-7 7-10-5L1 12 8 4Z"/><path fill="#d8d9d6" d="m14 1-3 10 2 16 7-7 2-12Z"/><path fill="#ecd9a6" d="m14 1-3 10 11-3Z"/><path fill="#a9aba7" d="m1 12 10-1 2 16-10-5Z"/></svg></span>
        <span className="brand-text">{CONFIG.brand.name} <b>/ {CONFIG.brand.sub}</b><small>{CONFIG.brand.tagline} · {CONFIG.brand.taglineEn}</small></span>
      </a>
      <div className="top-actions">
        {v && <span className="pill glass" title="工作站生命体征（30 秒轮询）">
          <Icon name="agent" size={13}/>任务 <b><Count value={v.open_tasks}/></b> · 拍板 <b><Count value={v.pending_decisions}/></b> · 工者 <b>{v.workers_ok}</b><em style={{color: '#98a6a1'}}>/{v.workers_ok + v.workers_late + v.workers_down}</em>
        </span>}
        <button className="avatar" onClick={() => setModal('about')} aria-label="关于本图与数据来源"><img src={asset(CONFIG.avatar)} alt=""/></button>
      </div>
    </header>

    <main>
      <Home graph={graph} layout={layout} focus={focus} setFocus={setFocus} onAction={onAction} onAbout={() => setModal('about')} reduced={reduced}/>
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
          <li><b>任务流 Tasks</b>：工作站未结任务（T-xxx），来自 8331 实体投影；详情栏显示任务内容/调度溯源，可直接改状态（完成/进行/待确认/退回）。</li>
          <li><b>知识库 Knowledge</b>：本地知识库 markdown 笔记现场扫描，[[双链]] 与话题标签自动连线；分区 → 子目录 → 笔记逐层钻入，长清单用滚轮往下平移；详情栏看正文预览，「阅读全文」渲染 markdown（标题/表格/代码块/图片），双链可点在图内跳转。</li>
          <li><b>拍板台 Decisions</b>：三门槛落账的待拍板事项（D-xxx），详情栏就地收口（批准走执行链，多方案可选）。</li>
          <li><b>记忆池 Memory</b>：memorycore 池条目实时状态（降级候选摘要）。</li>
          <li><b>服务舱 Services</b>：核心服务健康探测 + 常驻工作者心跳。</li>
        </ul>
        <p>当前：{s.content} 条内容 · {s.links} 条连接 · {s.mutual} 组双向 · {s.ghosts} 个未创建双链。</p>
        <p className="quiet">数据全部本机，不外发；任务与拍板都能在详情栏直接收口，驾驶舱留作备用入口。<em>Local first, nothing is published.</em></p>
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
    {readNode && <Reader node={readNode} graph={graph} onJump={id => { setReadNode(null); openInGraph(id); }} onClose={() => setReadNode(null)}/>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
