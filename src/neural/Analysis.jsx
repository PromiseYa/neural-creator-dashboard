import React, {useEffect, useMemo, useState} from 'react';
import {KINDS, CONTENT, MODULES, neighbors, latent, askGraph, LINK_KINDS, LINK_EN, STATUS_ZH} from './graph';
import {Icon} from './icons';
import {stripFrontmatter, firstImage} from './markdown';

const fmt = (v, d = 0) => v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('zh-CN', {minimumFractionDigits: d, maximumFractionDigits: d});
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Count({value, decimals = 0, suffix = ''}) {
  const [v, setV] = useState(reducedMotion() ? value : 0);
  useEffect(() => {
    if (value == null || reducedMotion()) { setV(value); return; }
    let raf; const t0 = performance.now();
    const run = now => { const p = Math.min(1, (now - t0) / 1000); setV(value * (1 - Math.pow(1 - p, 3))); if (p < 1) raf = requestAnimationFrame(run); };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{fmt(v, decimals)}{value != null && suffix}</>;
}

function Bars({bars}) {
  const max = Math.max(...bars.map(b => b.v || 0), 1e-6);
  return <div className="bars" aria-hidden="true">{bars.map((b, i) => <i key={i} className={b.on ? 'on' : ''} title={b.label} style={{'--h': Math.max(.06, (b.v || 0) / max), animationDelay: 120 + i * 28 + 'ms'}}/>)}</div>;
}

function Metric({label, en, value, decimals = 1, suffix = '%', level, delta, deltaEn, bars}) {
  return <section className="an-metric">
    <header><span>{label} <em>{en}</em></span>{level && <b className={`lvl lvl-${level[2]}`}>{level[0]} <em>{level[1]}</em></b>}</header>
    <div className="an-metric-body">
      <strong><Count value={value} decimals={decimals} suffix={suffix}/></strong>
      {delta && <small className={delta.startsWith('-') ? 'down' : 'up'}>{delta}<em>{deltaEn}</em></small>}
      <Bars bars={bars}/>
    </div>
  </section>;
}

function Tiles({tiles}) {
  return <div className="an-tiles">{tiles.map(([icon, v, zh, en, d], i) => <div className="an-tile" key={zh} style={{animationDelay: 200 + i * 70 + 'ms'}}>
    <span className="t-icon"><Icon name={icon} size={16}/></span>
    <strong>{typeof v === 'number' ? <Count value={v} decimals={d || 0}/> : v}</strong>
    <p>{zh}<em>{en}</em></p>
  </div>)}</div>;
}

function Chip({graph, id, onGo, sub}) {
  const n = graph.index.get(id);
  if (!n) return null;
  const go = CONTENT.has(n.kind) || n.kind === 'concept' || ['task', 'decision', 'memory', 'service'].includes(n.kind);
  const body = <>{n.short || n.title}{sub && <small>{sub}</small>}</>;
  return go ? <button className="chip" style={{'--kc': KINDS[n.kind].color}} onClick={() => onGo(id)}>{body}</button>
    : <span className={`chip static ${n.kind === 'ghost' ? 'ghost' : ''}`} style={{'--kc': KINDS[n.kind].color}}>{body}</span>;
}

function Links({graph, node, onGo}) {
  const nb = useMemo(() => neighbors(graph, node.id), [graph, node.id]);
  const lat = useMemo(() => latent(graph, node.id).slice(0, 6), [graph, node.id]);
  const groups = [
    ['双向', 'Mutual', '⇄', nb.mutual.sort((a, b) => b.link.w - a.link.w), l => l.link.kind === 'resonance' ? `${l.link.w} 概念` : LINK_KINDS[l.link.kind]],
    ['出链', 'Outgoing', '→', nb.out, l => LINK_EN[l.link.kind]],
    ['反链', 'Backlinks', '←', nb.back, l => LINK_EN[l.link.kind]],
    ['二度关联', 'Latent', '⋯', lat, l => 'via ' + l.via.slice(0, 2).join('、')]
  ].filter(g => g[3].length);
  return <section className="an-section">
    <h3>双向链接 <em>Bidirectional links</em></h3>
    {groups.map(([zh, en, arrow, list, sub]) => <div className="link-group" key={zh}>
      <p><i>{arrow}</i>{zh} <em>{en}</em><b>{list.length}</b></p>
      <div className="chip-row">{list.slice(0, 14).map(l => <Chip key={l.id} graph={graph} id={l.id} onGo={onGo} sub={sub(l)}/>)}{list.length > 14 && <span className="chip static more">+{list.length - 14}</span>}</div>
    </div>)}
  </section>;
}

function Insights({items}) {
  if (!items.length) return null;
  return <section className="an-section">
    <h3><Icon name="spark" size={14}/>图谱分析 <em>Graph insights</em></h3>
    {items.map(([title, en, text, tone], i) => <article key={i} className={`insight tone-${tone || 'info'}`} style={{animationDelay: 380 + i * 90 + 'ms'}}>
      <h4>{title} <em>{en}</em></h4><p>{text}</p>
    </article>)}
  </section>;
}

// 相关知识：笔记详情栏就地向 8342 检索服务发起检索。
// kbserve 全库检索 10-30 秒是常态（embed 0.1s+全库扫描），异步渐进不阻塞详情栏交互；
// rerank=false 走纯向量快路，省精排模型开销。
function RelatedSearch({node}) {
  const [hits, setHits] = useState(null);
  useEffect(() => {
    let stop = false;
    setHits(null);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 35000);
    fetch(`/kb/search?q=${encodeURIComponent(node.title)}&top=5&rerank=false`, {signal: ctl.signal})
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(d => { if (!stop) setHits(d.hits || []); })
      .catch(() => { if (!stop) setHits([]); })
      .finally(() => clearTimeout(timer));
    return () => { stop = true; ctl.abort(); clearTimeout(timer); };
  }, [node.id]);
  if (!hits) return <section className="an-section"><h3>相关知识 <em>Related</em></h3><p className="quiet">检索中…</p></section>;
  if (!hits.length) return null;
  return <section className="an-section">
    <h3><Icon name="agent" size={14}/>相关知识 <em>Related · kbserve</em></h3>
    {hits.map((h, i) => {
      const src = String(h.meta?.source_path || '').split(/[\\/]/).pop().replace(/\.md$/, '') || `命中 ${i + 1}`;
      const doc = String(h.doc || '').replace(/\s+/g, ' ').trim();
      return <article key={i} className="insight tone-info" style={{animationDelay: 300 + i * 70 + 'ms'}}>
        <h4>{src} <em>{h.src?.join?.('+') || ''}</em></h4><p>{doc.slice(0, 150)}{doc.length > 150 ? '…' : ''}</p>
      </article>;
    })}
  </section>;
}

function AskBox({graph, node, onGo}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  return <div className="an-ask">
    {res && <div className="an-ask-res">{res.map((c, i) => <div key={i} className={`ask-card mini tone-${c.tone}`}>
      <h4>{c.title} <em>{c.en}</em></h4><p>{c.text}</p>
      {c.items?.length > 0 && <div className="chip-row">{c.items.slice(0, 6).map(id => <Chip key={id} graph={graph} id={id} onGo={onGo}/>)}</div>}
    </div>)}</div>}
    <form onSubmit={e => { e.preventDefault(); if (q.trim()) setRes(askGraph(graph, q, node.id)); }}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="追问这条内容… Ask about this note" aria-label="追问这条内容"/>
      <button aria-label="提交"><Icon name="send" size={15}/></button>
    </form>
    <div className="an-ask-foot"><span><Icon name="agent" size={13}/>我的图谱 <em>My graph</em></span><span><Icon name="spark" size={13}/>本地分析 <em>Local analysis</em></span></div>
  </div>;
}

const sharedConcepts = (a, b) => (a.shared || []).filter(x => (b.shared || []).includes(x));

// 详情补充数据（R21）：8331 列表投影裁掉的长文本（任务 notes/source_ref、拍板 proposal/why/impact、
// 笔记全文）按需从 vite 只读通道补——打开详情栏才拉一次，不进 30 秒轮询。
function useDetail(node) {
  const tid = node?.kind === 'task' ? node.task?.id : null;
  const did = node?.kind === 'decision' ? node.decision?.id : null;
  // note 的图谱 id 带 "note:" 前缀，全文接口要的是 KB 相对路径（node.path）
  const nid = node?.kind === 'note' ? (node.path || String(node.id).replace(/^note:/, '')) : null;
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    if (!tid && !did && !nid) return;
    let stop = false;
    const url = tid ? `/api/hub-detail?t=${encodeURIComponent(tid)}`
      : did ? `/api/hub-detail?d=${encodeURIComponent(did)}`
      : `/api/note-raw?id=${encodeURIComponent(nid)}`;
    fetch(url).then(r => r.json())
      .then(j => { if (!stop) setD(j?.ok ? j : {ok: false}); })
      .catch(() => { if (!stop) setD({ok: false}); });
    return () => { stop = true; };
  }, [tid, did, nid]);
  return d;
}

// 任务来源 → 中文（hub 的 source 取值：cron/ai/wechat/hub/manual/star-map…）
const SRC_ZH = {cron: '定时调度', ai: 'AI 会话', wechat: '微信指令', hub: '工作站', manual: '手动', 'star-map': '星图', oa: 'OA'};

const dueDays = due => {
  if (!due) return '';
  const dd = Math.ceil((new Date(String(due).slice(0, 10) + 'T23:59:59') - Date.now()) / 86400000);
  return dd > 0 ? `（剩 ${dd} 天）` : dd === 0 ? '（今天截止）' : `（已过 ${-dd} 天）`;
};

function analyze(graph, node, detail) {
  const C = graph.nodes.filter(n => CONTENT.has(n.kind));
  const nb = neighbors(graph, node.id);
  const d = {out: node.out - node.mutual, back: node.in - node.mutual, both: node.mutual};
  const top = [...nb.mutual].sort((a, b) => b.link.w - a.link.w)[0];
  const partner = top && graph.index.get(top.id);
  const resonance = partner ? [['双向共振最强', 'Strongest resonance', `与「${partner.short || partner.title}」互相呼应，共同提及：${sharedConcepts(node, partner).join('、') || LINK_KINDS[top.link.kind]}。`, 'gold']] : [];
  const connectivity = () => {
    const pct = 100 * C.filter(c => c.deg <= node.deg).length / C.length;
    const avg = C.reduce((s, c) => s + c.deg, 0) / C.length;
    const diff = node.deg - avg;
    return {label: '连接度', en: 'Connectivity', value: pct, decimals: 0, level: pct >= 80 ? ['枢纽', 'Hub', 'high'] : pct >= 50 ? ['活跃', 'Active', 'mid'] : ['边缘', 'Edge', 'low'],
      delta: `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} 条`, deltaEn: diff >= 0 ? 'above average' : 'below average',
      bars: [...C].sort((a, b) => a.deg - b.deg).map(c => ({v: c.deg, on: c.id === node.id, label: c.short}))};
  };

  if (node.kind === 'task') {
    const T = graph.nodes.filter(n => n.kind === 'task');
    const t = node.task || {};
    const full = detail?.row || {};                       // hub-detail 补的长文本字段
    const notes = String(full.notes || '');
    const st = STATUS_ZH[t.status] || t.status || '—';
    const same = T.filter(x => x.task?.status === t.status).length;
    const OPS = [['完成', 'Done', 'done', 'done'], ['进行中', 'Doing', 'doing', 'doing'], ['待确认', 'Wait', 'wait', 'waiting_confirm'], ['退回待办', 'Reopen', 'reopen', 'pending']];
    const extras = [];
    if (full.confidence) extras.push(['把握', 'Confidence', String(full.confidence), 'muted']);
    if (full.risk_level) extras.push(['风险级', 'Risk', String(full.risk_level), 'muted']);
    if (full.deliverables) extras.push(['交付物', 'Deliverables', String(full.deliverables), 'info']);
    if (full.rollback_ref) extras.push(['回滚点', 'Rollback', String(full.rollback_ref), 'muted']);
    return {
      badge: [st, 'Status'], status: `${t.id || ''} · 优先级 ${t.priority || '—'} · 截止 ${t.due || '—'}${dueDays(t.due)}`,
      ops: OPS.map(([zh, en, op, target]) => ({zh, en, op, cur: t.status === target})),
      action: ['驾驶舱（备用）', 'Station · backup', {type: 'station'}],
      metric: {label: '同状态任务', en: 'Same status', value: T.length ? 100 * same / T.length : 0, decimals: 0,
        level: t.status === 'doing' ? ['进行', 'Doing', 'high'] : t.status === 'waiting_confirm' ? ['待确认', 'Confirm', 'mid'] : ['排队', 'Queued', 'low'],
        delta: `${same}/${T.length}`, deltaEn: 'tasks', bars: T.map(x => ({v: 1, on: x === node, label: x.short}))},
      tiles: [['works', T.length, '未结任务', 'Open'], ['pulse', t.due ? 1 : 0, '有截止', 'Due'], ['file', notes.replace(/\s/g, '').length, '内容字数', 'Notes'], ['link', d.both, '关联', 'Links']],
      insights: [
        ['任务内容', 'Content', notes || '（这条任务没有补充内容，标题即全部——可在驾驶舱补备注。）', 'info'],
        ['调度与溯源', 'Origin', `来源 ${SRC_ZH[t.source] || t.source || '—'}${full.source_ref ? ` · 关联 ${full.source_ref}` : ''} · 创建 ${t.created_at || '—'} · 更新 ${t.updated_at || '—'}`, 'muted'],
        ...extras
      ]
    };
  }
  if (node.kind === 'decision') {
    const D = graph.nodes.filter(n => n.kind === 'decision');
    const dc = node.decision || {};
    const full = detail?.row || {};                       // hub-detail 补的 proposal/why/impact
    const opts = full.options?.length ? full.options : (dc.options || []);
    const settled = dc.status && dc.status !== 'pending';
    return {
      badge: [dc.status === 'pending' ? '待拍板' : (dc.status || '已收口'), 'Decision'], status: `${dc.id || ''} · 提出 ${String(dc.created_at || full.created_at || '').slice(0, 16) || '—'}${settled && full.decided_at ? ` · 裁决 ${String(full.decided_at).slice(0, 16)}` : ''}`,
      decideOps: (opts.length ? opts.map(o => ({zh: `批准 ${o.key || ''}`, en: 'Approve', to: 'approved', choice: o.key})) : [{zh: '批准执行', en: 'Approve', to: 'approved'}])
        .concat([{zh: '否决', en: 'Reject', to: 'rejected'}, {zh: '销账', en: 'Resolve', to: 'resolved'}]),
      action: ['驾驶舱（备用）', 'Station · backup', {type: 'station'}],
      metric: {label: '待拍板存量', en: 'Pending', value: D.length ? 100 * D.filter(x => x.decision?.status === 'pending').length / D.length : 0, decimals: 0,
        level: dc.status === 'pending' ? ['待办', 'Pending', 'high'] : ['已结', 'Settled', 'mid'],
        delta: `${D.length}`, deltaEn: 'decisions', bars: D.map(x => ({v: 1, on: x === node, label: x.short}))},
      tiles: [['idea', opts.length, '备选方案', 'Options'], ['works', D.length, '待拍总数', 'Pending'], ['link', d.both, '关联', 'Links'], ['file', String(full.proposal || '').replace(/\s/g, '').length, '方案字数', 'Chars']],
      insights: [
        ['拍板事项', 'Decision', dc.title || full.title || '—', 'info'],
        ...(full.proposal ? [['方案全文', 'Proposal', String(full.proposal), 'gold']] : []),
        ...(full.why ? [['拍板理由', 'Why', String(full.why), 'info']] : []),
        ...(full.impact ? [['影响与代价', 'Impact', String(full.impact), 'warn']] : []),
        ...(opts.length ? [['备选方案', 'Options', opts.map((o, i) => `${o.key || String.fromCharCode(65 + i)}. ${o.text || o}`).join('\n'), 'gold']] : [['备选方案', 'Options', '未登记选项，批准后走默认执行链。', 'muted']]),
        ...(settled ? [['裁决结果', 'Outcome', `已按「${dc.status}」收口${full.choice ? ` · 方案 ${full.choice}` : ''}。`, 'muted']] : [['三门槛', 'Gate', '收尾无答案 + 不拍板动不了 + 有实际代价，才落账到这里。', 'muted']])
      ]
    };
  }
  if (node.kind === 'memory') {
    const M = graph.nodes.filter(n => n.kind === 'memory');
    const mm = node.memory || {};
    return {
      badge: ['记忆条目', 'Memory item'], status: mm.id ? `memorycore · ${mm.id}` : 'memorycore 记忆池',
      metric: {label: '记忆池条目', en: 'Pool size', value: M.length, decimals: 0,
        level: M.length ? ['在线', 'Live', 'high'] : ['空池', 'Empty', 'low'], delta: `${M.length}`, deltaEn: 'items', bars: M.map(x => ({v: 1, on: x === node, label: x.short}))},
      tiles: [['file', (mm.body || node.body || '').length, '摘要字数', 'Chars'], ['link', d.both, '关联', 'Links'], ['spark', mm.id ? 1 : 0, '有条目', 'Item'], ['agent', M.length, '池条目', 'Pool']],
      insights: [['条目内容', 'Content', mm.body || node.body || '（无摘要）', 'info']]
    };
  }
  if (node.kind === 'service') {
    const S = graph.nodes.filter(n => n.kind === 'service');
    const sv = node.service || {};
    const ok = S.filter(x => x.service?.ok).length;
    return {
      badge: [sv.ok ? '在线' : '离线', sv.ok ? 'Online' : 'Offline'], status: sv.desc || sv.name || '',
      action: ['去驾驶舱看服务', 'Open station', {type: 'station'}],
      metric: {label: '服务在线率', en: 'Uptime', value: S.length ? 100 * ok / S.length : 0, decimals: 0,
        level: sv.ok ? ['健康', 'Healthy', 'high'] : ['异常', 'Down', 'low'],
        delta: `${ok}/${S.length}`, deltaEn: 'services online', bars: S.map(x => ({v: x.service?.ok ? 1 : 0.15, on: x === node, label: x.short}))},
      tiles: [['check', sv.ok ? 1 : 0, '健康', 'Health'], ['agent', S.length, '服务总数', 'Total'], ['pulse', sv.state ? 1 : 0, '有心跳', 'Beats'], ['link', d.both, '关联', 'Links']],
      insights: [
        ['服务说明', 'Description', sv.desc || '—', 'info'],
        ...(sv.ok ? [] : [['离线提示', 'Offline', '该服务当前探测失败，可能未启动或已下线。', 'warn']])
      ]
    };
  }
  if (node.kind === 'post') {
    const P = C.filter(n => n.kind === 'post').sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const p = node.post, rate = x => x.post.views ? x.post.saves / x.post.views * 100 : null;
    const r = rate(node), others = P.filter(x => x !== node).map(rate).filter(x => x != null);
    const avg = others.reduce((s, x) => s + x, 0) / (others.length || 1);
    const rank = [...P].sort((a, b) => b.post.views - a.post.views).indexOf(node) + 1;
    const engage = p.views ? (p.likes + p.comments + p.saves + p.shares) / p.views * 100 : null;
    const ideas = latent(graph, node.id).filter(x => graph.index.get(x.id).kind === 'idea');
    return {
      badge: ['已发布', 'Published'], status: `首发 First published ${p.date} · ${node.tags.length} 个话题 topics`,
      action: ['查看作品', 'Open in Works', {type: 'page', page: 'library', id: p.id}],
      metric: {label: '收藏率', en: 'Save rate', value: r, level: r >= 6 ? ['高', 'High', 'high'] : r >= 3 ? ['中', 'Moderate', 'mid'] : ['低', 'Low', 'low'],
        delta: `${r - avg >= 0 ? '+' : ''}${(r - avg).toFixed(1)}%`, deltaEn: 'vs. other works', bars: P.map(x => ({v: rate(x), on: x === node, label: x.short}))},
      tiles: [['eye', p.views, '观看', 'Views'], ['save', p.saves, '收藏', 'Saves'], ['user', p.follows ?? '—', '涨粉', 'Follows'], ['link', d.both, '双向共振', 'Mutual']],
      all: [['曝光', 'Impressions', fmt(p.impressions)], ['封面点击率', 'CTR', p.ctr == null ? '—' : p.ctr + '%'], ['平均观看', 'Avg. watch', p.duration == null ? '—' : p.duration + 's'], ['点赞', 'Likes', fmt(p.likes)], ['评论', 'Comments', fmt(p.comments)], ['分享', 'Shares', fmt(p.shares)], ['互动率', 'Engagement', engage == null ? '—' : engage.toFixed(1) + '%'], ['涨粉转化', 'Follow rate', p.follows == null || !p.views ? '—' : (p.follows / p.views * 1000).toFixed(1) + '‰']],
      insights: [
        ['表现排名', 'Ranking', `观看第 ${rank}/${P.length} 名；收藏率${r >= avg ? '高于' : '低于'}其他作品均值 ${Math.abs(r - avg).toFixed(1)} 个百分点。`, r >= avg ? 'gold' : 'info'],
        ...resonance,
        ...(ideas.length ? [['可延伸选题', 'Next ideas', ideas.slice(0, 2).map(x => `「${graph.index.get(x.id).short}」（共享：${x.via.join('、')}）`).join('；'), 'info']] : []),
        ...(p.updated ? [['数据时点', 'Snapshot', p.updated, 'muted']] : [['数据时点', 'Snapshot', '读取时累计值，缺失项保留为「—」。', 'muted']])
      ]
    };
  }
  if (node.kind === 'note') {
    const ghosts = nb.out.filter(x => graph.index.get(x.id).kind === 'ghost');
    const raw = detail?.ok ? detail.raw : null;
    const fm = raw ? stripFrontmatter(raw) : null;
    const chars = fm ? fm.body.replace(/\s/g, '').length : (node.body || '').length;
    const preview = fm ? fm.body.trim().replace(/\n{2,}/g, '\n').slice(0, 400) : String(node.body || '').slice(0, 300);
    return {
      badge: ['知识笔记', 'Knowledge note'], status: `${node.path}${fm?.meta.updated ? ` · 更新 ${fm.meta.updated}` : ''}`,
      cover: fm ? firstImage(fm.body, detail.dir) : null,
      action: ['阅读全文', 'Read note', {type: 'read', id: node.id}],
      metric: connectivity(),
      tiles: [['outlink', d.out, '出链', 'Outgoing'], ['back', d.back, '反链', 'Backlinks'], ['link', d.both, '双向共振', 'Mutual'], ['file', chars, '字数', 'Chars']],
      insights: [['正文预览', 'Preview', preview ? preview + (fm && fm.body.trim().length > 400 ? ' …（点"阅读全文"看剩余）' : '') : '（空笔记）', 'info'],
        ...resonance,
        ...(ghosts.length ? [['未创建的双链', 'Unresolved links', `${ghosts.length} 个 [[双链]] 指向尚未出现的笔记：${ghosts.slice(0, 3).map(x => graph.index.get(x.id).short).join('、')}${ghosts.length > 3 ? ' 等' : ''}。`, 'warn']] : []),
        ['话题标签', 'Topics', node.tags?.length ? node.tags.map(t => '#' + t).join('　') : '这篇笔记还没有标签。', 'info']]
    };
  }
  if (node.kind === 'idea') {
    const I = C.filter(n => n.kind === 'idea');
    const reach = x => 100 * latent(graph, x.id).length / Math.max(1, C.length - 1);
    const lat = latent(graph, node.id);
    const posts = lat.filter(x => graph.index.get(x.id).kind === 'post');
    const notes = lat.filter(x => graph.index.get(x.id).kind === 'note').length + nb.mutual.filter(x => graph.index.get(x.id).kind === 'note').length;
    const hasDraft = [...nb.out, ...nb.back, ...nb.mutual].some(x => graph.index.get(x.id).kind === 'draft');
    return {
      badge: [`优先级 ${node.idea.priority}`, 'Priority'], status: `${node.idea.status} · ${node.idea.platform}`,
      action: hasDraft ? ['打开草稿', 'Open draft', {type: 'ideaToDraft', idea: node.idea}] : ['转为草稿', 'To draft', {type: 'ideaToDraft', idea: node.idea}],
      action2: ['编辑选题', 'Edit', {type: 'editIdea', idea: node.idea}],
      metric: {label: '延伸潜力', en: 'Reach', value: reach(node), decimals: 0, level: posts.length >= 2 ? ['强', 'Strong', 'high'] : posts.length ? ['中', 'Fair', 'mid'] : ['弱', 'Weak', 'low'],
        delta: `${posts.length} 篇作品`, deltaEn: 'related works', bars: I.map(x => ({v: reach(x), on: x === node, label: x.short}))},
      tiles: [['concept', (node.tags || []).length, '话题标签', 'Topics'], ['works', posts.length, '关联作品', 'Works'], ['methods', notes, '关联笔记', 'Notes'], ['draft', hasDraft ? 1 : 0, '草稿', 'Drafts']],
      insights: [
        ['创作备注', 'Brief', node.idea.note || '还没有备注。', 'info'],
        ...(posts.length ? [['可以延伸的作品', 'Builds on', posts.slice(0, 3).map(x => `「${graph.index.get(x.id).short}」`).join('、') + ` · 共享：${[...new Set(posts.flatMap(x => x.via))].join('、')}`, 'gold']] : []),
        ...resonance
      ]
    };
  }
  if (node.kind === 'draft') {
    const src = [...nb.out, ...nb.mutual].find(x => graph.index.get(x.id).kind === 'idea');
    return {
      badge: ['正在写', 'Writing'], status: src ? `来自选题「${graph.index.get(src.id).short}」` : '独立草稿 · Standalone',
      action: ['继续写作', 'Continue', {type: 'page', page: 'drafts', id: node.draft.id}],
      metric: connectivity(),
      tiles: [['file', (node.body || '').length, '字数', 'Chars'], ['idea', src ? 1 : 0, '来源选题', 'Source'], ['concept', (node.tags || []).length, '话题标签', 'Topics'], ['link', graph.links.filter(l => l.kind === 'wiki' && l.s === node.id).length, '双链', 'Wikilinks']],
      insights: [...resonance, ['话题标签', 'Topics', node.tags?.length ? node.tags.map(t => '#' + t).join('　') : '正文还没有命中概念词，可以在创作台用 [[ ]] 链接笔记。', 'info']]
    };
  }
  // tag 话题
  const K = graph.nodes.filter(n => n.kind === 'tag');
  const who = nb.back.map(x => graph.index.get(x.id));
  const count = k => who.filter(n => n.kind === k).length;
  return {
    badge: ['话题', 'Topic'], status: `被 ${who.length} 条内容引用 · used by ${who.length}`,
    metric: {label: '覆盖率', en: 'Coverage', value: 100 * who.length / Math.max(1, C.length), decimals: 0, level: who.length >= 5 ? ['核心', 'Core', 'high'] : who.length >= 3 ? ['常用', 'Common', 'mid'] : ['少见', 'Rare', 'low'],
      delta: `${who.length}/${C.length}`, deltaEn: 'notes', bars: [...K].sort((a, b) => a.in - b.in).map(k => ({v: k.in, on: k === node, label: k.title}))},
    tiles: [['works', count('post'), '作品', 'Works'], ['methods', count('note'), '方法笔记', 'Notes'], ['idea', count('idea'), '选题', 'Ideas'], ['draft', count('draft'), '草稿', 'Drafts']],
    insights: [['共用的内容', 'Shared by', who.length ? who.slice(0, 6).map(n => n.short || n.title).join('、') : '暂无', 'info']]
  };
}

export function Analysis({graph, node, module, onGo, onAction, onClose}) {
  const detail = useDetail(node);
  const a = useMemo(() => analyze(graph, node, detail), [graph, node, detail]);
  const color = KINDS[node.kind].color;
  return <div className="analysis glass" style={{'--kc': color}} role="region" aria-label={`${node.title} 的分析`}>
    <p className="an-float">分析概览 <em>Analysis overview</em> · {module?.title} {module?.en}</p>
    <div className="an-scroll">
      <header className="an-head">
        <span className="an-cat"><span className="an-cat-icon"><Icon name={module?.icon || 'file'} size={15}/></span>{module?.title}<em>{module?.en}</em></span>
        <button className="icon-btn" onClick={onClose} aria-label="关闭分析"><Icon name="close" size={15}/></button>
      </header>
      <div className="an-title-row">
        <div>
          <h2>{node.short || node.title}</h2>
          {node.short && node.short !== node.title && <p className="an-full">{node.title}</p>}
        </div>
        {(a.cover || node.cover) && <img className="an-cover" src={a.cover || node.cover} alt=""/>}
      </div>
      <div className="an-status">
        <span className="badge">{a.badge[0]} <em>{a.badge[1]}</em></span>
        <p>{a.status}</p>
        <div className="an-actions">
          {a.ops && <div className="an-ops">
            {a.ops.map(o => (
              <button key={o.op} className={`an-explore ghost op-btn${o.cur ? ' cur' : ''}`} disabled={o.cur}
                onClick={() => onAction({type: 'taskOp', id: node.task?.id, op: o.op})}>
                {o.cur ? '✓ ' : ''}{o.zh} <em>{o.en}</em>
              </button>
            ))}
          </div>}
          {a.decideOps && <div className="an-ops">
            {a.decideOps.map(o => (
              <button key={o.to + (o.choice || '')} className={`an-explore ghost op-btn${o.to === 'rejected' ? ' danger' : ''}`}
                onClick={() => onAction({type: 'decideOp', id: node.decision?.id, to: o.to, choice: o.choice})}>
                {o.zh} <em>{o.en}</em>
              </button>
            ))}
          </div>}
          {a.action2 && <button className="an-explore ghost" onClick={() => onAction(a.action2[2])}>{a.action2[0]} <em>{a.action2[1]}</em></button>}
          {a.action && <button className="an-explore backup" onClick={() => onAction(a.action[2])}>{a.action[0]} <em>{a.action[1]}</em><Icon name="chevron" size={13}/></button>}
        </div>
      </div>
      <Metric {...a.metric}/>
      <Tiles tiles={a.tiles}/>
      {a.all && <section className="an-section"><h3>全部指标 <em>All metrics</em></h3><div className="an-all">{a.all.map(([zh, en, v]) => <div key={zh}><span>{zh}<em>{en}</em></span><b>{v}</b></div>)}</div></section>}
      <Insights items={a.insights}/>
      {node.kind === 'note' && <RelatedSearch node={node}/>}
      {node.tags?.length > 0 && <section className="an-section"><h3>话题标签 <em>Topics</em></h3><div className="chip-row">{node.tags.map(t => <span key={t} className="chip static" style={{'--kc': KINDS.tag.color}}>#{t}</span>)}</div></section>}
      <Links graph={graph} node={node} onGo={onGo}/>
    </div>
    <AskBox graph={graph} node={node} onGo={onGo}/>
  </div>;
}
