// 神经图谱数据：任务/拍板/记忆/服务来自工作站实时接口，知识库笔记来自本地现场扫描。
// 连接来源：笔记正文 [[双链]]、目录归属、话题标签（KB 标签自动聚类，概念词表已废弃）。
import {CONFIG} from '../config';
import {PLATFORM_MODULES} from '../platform/modules';
import {T} from './theme';

export const STATUS_ZH = {pending: '待办', dispatched: '已派', doing: '进行中', waiting_confirm: '待确认', review: '待复核', done: '完成'};
export const PRIO_ZH = {high: '高', mid: '中', low: '低'};
// 六状态徽章分色（与 8331 驾驶舱同口径）
export const ST_COLOR = {pending: '#98a6a1', dispatched: '#a9d3e4', doing: '#7ddc9a', waiting_confirm: '#e8c48c', review: '#c0b8ef', done: '#8fa396'};

// 任务状态快速切换表（8330 set_status 支持的五态；review 态只能由 AI 申报+验收产生，不进手动切换）
export const TASK_OPS = [
  ['待办', 'pending', 'reopen'],
  ['已派', 'dispatched', 'dispatch'],
  ['进行中', 'doing', 'doing'],
  ['待确认', 'waiting_confirm', 'wait'],
  ['完成', 'done', 'done']
];

// 卡片右侧状态徽章：任务/服务/拍板一眼看状态，记忆显示更新日期
export function nodeBadge(n) {
  if (n.kind === 'task') { const s = n.task?.status; return {text: STATUS_ZH[s] || s || '—', color: ST_COLOR[s] || '#98a6a1'}; }
  if (n.kind === 'service') {
    if (n.service?.ok) return {text: '在线', color: '#7ddc9a'};
    return n.service?.state === 'noreport' ? {text: '无心跳', color: '#98a6a1'} : {text: '离线', color: '#ff7385'};
  }
  if (n.kind === 'decision') return n.decision?.status === 'pending' ? {text: '待拍', color: '#e8c48c'} : {text: '已结', color: '#7ddc9a'};
  if (n.kind === 'memory') return n.updated ? {text: String(n.updated).slice(5), color: '#98a6a1'} : null;
  if (n.kind === 'command') { const s = n.command?.status; return {text: {queued: '排队', dispatched: '已派', done: '完成', failed: '失败', pending_confirm: '待确认'}[s] || s || '—', color: s === 'done' ? '#8fa396' : s === 'failed' ? '#ff7385' : '#7ddc9a'}; }
  return null;
}

export const KINDS = {
  core: {label: '数字生态', en: 'Core', color: T.kinds.core},
  folder: {label: '分区', en: 'Zone', color: T.kinds.folder},
  post: {label: '作品', en: 'Work', color: T.kinds.post},
  note: {label: '知识笔记', en: 'Knowledge note', color: T.kinds.note},
  idea: {label: '选题', en: 'Idea', color: T.kinds.idea},
  draft: {label: '草稿', en: 'Draft', color: T.kinds.draft},
  concept: {label: '概念', en: 'Concept', color: T.kinds.concept},
  tag: {label: '话题', en: 'Topic', color: T.kinds.tag},
  ghost: {label: '未创建', en: 'Unresolved', color: T.kinds.ghost},
  task: {label: '任务', en: 'Task', color: T.kinds.task},
  decision: {label: '拍板', en: 'Decision', color: T.kinds.decision},
  memory: {label: '记忆', en: 'Memory', color: T.kinds.memory},
  service: {label: '服务', en: 'Service', color: T.kinds.service},
  command: {label: '指令', en: 'Command', color: '#7ddc9a'}
};
export const LINK_KINDS = {
  contain: '目录归属',
  wiki: '[[双链]]',
  source: '选题来源',
  tag: '话题标签',
  mention: '正文提及',
  resonance: '双向共振'
};
export const LINK_EN = {contain: 'Contains', wiki: 'Wikilink', source: 'Source', tag: 'Topic', mention: 'Mention', resonance: 'Resonance'};
export const CONTENT = new Set(['post', 'note', 'idea', 'draft']);

const FOLDERS = [
  {id: 'f:tasks', title: '任务流', path: '工作站/任务', angle: 180},
  {id: 'f:kb', title: '知识库', path: 'KnowledgeBase', angle: 0},
  {id: 'f:decisions', title: '拍板台', path: '工作站/拍板', angle: 35},
  {id: 'f:memory', title: '记忆池', path: 'memorycore', angle: 145},
  {id: 'f:services', title: '服务舱', path: 'services', angle: -90}
];

// Platform modules are shared by jellyfish, navigation pages and graph anchors.
export const MODULES = PLATFORM_MODULES;
export const moduleOf = node => MODULES.find(m => m.kind === node?.kind)
  || (node?.kind === 'command' ? MODULES.find(m => m.id === 'tasks') : null);   // 指令 M-xxx 归任务流域（10-16 批2）

export const cleanTitle = t => String(t || '').replace(/^\d+[A-Z]?-☑️/, '').replace(/^\d+-/, '').replace(/_/g, ' · ');

export function buildGraph({tasks = [], decisions = [], memories = [], services = [], notes = [], commands = []} = {}) {
  const nodes = new Map();
  const add = n => { if (!nodes.has(n.id)) nodes.set(n.id, {tags: [], text: '', ...n}); return nodes.get(n.id); };
  const edges = new Map();
  const link = (s, t, kind, w = 1) => {
    if (!nodes.has(s) || !nodes.has(t) || s === t) return;
    const [a, b] = s < t ? [s, t] : [t, s];
    const key = a + '|' + b + '|' + kind;
    const e = edges.get(key) || {a, b, kind, ab: 0, ba: 0, w: 0};
    if (s === a) e.ab += 1; else e.ba += 1;
    e.w = Math.max(e.w, w);
    edges.set(key, e);
  };

  add({id: 'core', kind: 'core', title: CONFIG.workspace, path: '/', text: ''});
  for (const f of FOLDERS) { add({...f, kind: 'folder'}); link('core', f.id, 'contain'); }

  // 任务流：工作站实体投影（实时，只读）
  for (const t of tasks) {
    const id = 'task:' + t.id;
    // 10-23 搜索能命中任务内容：text 纳入 notes 与来源原文（微信 source_ref 尾段），各截 200 字防索引膨胀
    add({id, kind: 'task', title: `${t.id} ${t.title}`, short: t.title.length > 22 ? t.title.slice(0, 22) + '…' : t.title,
      path: `任务流/${t.id}`, folder: 'f:tasks',
      text: `${t.id} ${t.title} ${STATUS_ZH[t.status] || t.status || ''} ${t.priority || ''} ${String(t.notes || '').slice(0, 200)} ${String(t.source_ref || '').slice(0, 200)}`,
      task: t, date: t.updated_at});
    link('f:tasks', id, 'contain');
  }

  // 知识库：本地现场扫描的笔记，按一级分区挂子锚点
  for (const n of notes) {
    const zoneTitle = String(n.zone || '根区').replace(/^\d+-/, '');
    const zoneId = 'f:kb:' + zoneTitle;
    add({id: zoneId, kind: 'folder', title: zoneTitle, path: n.zone || 'KB', level: 2});
    link('f:kb', zoneId, 'contain');
    const id = 'note:' + n.id;
    add({id, kind: 'note', title: n.title, short: n.title.length > 22 ? n.title.slice(0, 22) + '…' : n.title,
      path: n.path, folder: zoneId, subzone: n.subzone || '', text: n.title + '\n' + (n.body || ''), body: n.body || '',
      tags: n.tags || [], updated: n.updated, wikilinks: n.wikilinks || []});
    link(zoneId, id, 'contain');
  }

  // 拍板台：待拍板清单（实时，只读）
  for (const dc of decisions) {
    const id = 'dec:' + dc.id;
    add({id, kind: 'decision', title: `${dc.id} ${dc.title || '未命名'}`, short: String(dc.title || '未命名').slice(0, 22),
      path: `拍板台/${dc.id}`, folder: 'f:decisions', text: `${dc.id} ${dc.title || ''} ${(dc.options || []).map(o => o.text || o.key || '').join(' ')}`, decision: dc, date: dc.created_at});
    link('f:decisions', id, 'contain');
  }

  // 记忆池：M2 接 memorycore 池状态（中文标题来自 ZCode memory 文件的 description）
  for (const mm of memories) {
    const id = 'mem:' + mm.id;
    add({id, kind: 'memory', title: mm.title || mm.id, short: String(mm.title || mm.id).slice(0, 22), path: `记忆池/${mm.id}`, folder: 'f:memory', text: `${mm.title || ''}\n${mm.body || ''}`, body: mm.body || '', updated: mm.updated || '', memory: mm});
    link('f:memory', id, 'contain');
  }

  // 服务舱：健康探测结果
  for (const s of services) {
    const id = 'svc:' + s.id;
    add({id, kind: 'service', title: s.name, short: s.name, path: `服务舱/${s.id}`, folder: 'f:services', text: `${s.name} ${s.desc || ''}`, service: s});
    link('f:services', id, 'contain');
  }

  // 指令台账 M-xxx（10-16 批2）：归任务流锚点方向，不参与力导向迭代（同 done 任务处理，防 O(N²) 膨胀）
  for (const cm of commands) {
    const id = 'cmd:' + cm.id;
    const brief = String(cm.prompt || '').replace(/\s+/g, ' ').trim();
    add({id, kind: 'command', title: `${cm.id} ${brief.slice(0, 20)}`, short: brief.length > 22 ? brief.slice(0, 22) + '…' : (brief || cm.id),
      path: `指令台账/${cm.id}`, folder: 'f:tasks', text: `${cm.id} ${brief} ${cm.status || ''} ${cm.source || ''}`, command: cm, date: cm.updated_at});
    link('f:tasks', id, 'contain');
  }

  // [[双链]]：优先用扫描时预抽取的链接清单，正文现场匹配兜底；找不到目标记为「未创建」。
  const byName = new Map();
  for (const n of nodes.values()) if (CONTENT.has(n.kind)) {
    byName.set(String(n.title).toLowerCase(), n.id);
    if (n.path) byName.set(String(n.path).split('/').pop().replace(/\.md$/, '').toLowerCase(), n.id);
  }
  for (const n of [...nodes.values()]) {
    if (n.kind !== 'note' && n.kind !== 'draft') continue;
    const targets = new Set(n.wikilinks || []);
    for (const m of (n.body || '').matchAll(/\[\[([^\]]+)\]\]/g)) targets.add(m[1].split('|')[0].split('#')[0].trim());
    for (const raw of targets) {
      const name = String(raw).split('/').pop().trim();
      if (!name || name.includes('{{')) continue;
      let id = byName.get(name.toLowerCase());
      if (!id) {
        id = 'ghost:' + name.toLowerCase();
        add({id, kind: 'ghost', title: name, short: cleanTitle(name), path: name + '.md', text: ''});
      }
      link(n.id, id, 'wiki');
    }
  }

  // 话题标签（大小写合并；只保留被 ≥3 篇共用的 tag，单笔记最多挂 4 个最高频 tag——连线瘦身后知识网络才读得清）。
  const tagFreq = new Map();
  for (const n of [...nodes.values()]) for (const tag of n.tags || []) {
    const k = tag.toLowerCase();
    tagFreq.set(k, (tagFreq.get(k) || 0) + 1);
  }
  for (const n of [...nodes.values()]) {
    const top = (n.tags || []).map(t => t.toLowerCase()).filter(k => tagFreq.get(k) >= 3)
      .sort((a, b) => tagFreq.get(b) - tagFreq.get(a)).slice(0, 4);
    for (const k of top) {
      const id = 'tag:' + k;
      add({id, kind: 'tag', title: '#' + k, short: '#' + k, text: '', freq: tagFreq.get(k)});
      link(n.id, id, 'tag');
    }
  }

  // 概念词表/正文提及/双向共振已随固定词表一起移除：KB 标签（tag 节点）承担概念聚类。
  const list = [...nodes.values()];
  const links = [...edges.values()].map(e => ({...e, both: e.ab > 0 && e.ba > 0, s: e.ab ? e.a : e.b, t: e.ab ? e.b : e.a}));
  for (const n of list) { n.out = 0; n.in = 0; n.deg = 0; n.mutual = 0; }
  const idx = new Map(list.map(n => [n.id, n]));
  for (const l of links) {
    const A = idx.get(l.a), B = idx.get(l.b);
    if (l.kind === 'contain') continue;
    A.deg++; B.deg++;
    if (l.both) { A.mutual++; B.mutual++; A.out++; B.out++; A.in++; B.in++; }
    else { idx.get(l.s).out++; idx.get(l.t).in++; }
  }
  return {nodes: list, links, index: idx};
}

// 同一对内容之间可能同时有多种连接（如互相双链 + 双向共振），每个对象只保留一条：双向优先，其次权重高的。
export function neighbors(graph, id) {
  const best = new Map();
  const rank = x => (x.dir === 'mutual' ? 100 : 0) + x.link.w;
  for (const l of graph.links) {
    if ((l.a !== id && l.b !== id) || l.kind === 'contain') continue;
    const other = l.a === id ? l.b : l.a;
    const item = {id: other, link: l, dir: l.both ? 'mutual' : l.s === id ? 'out' : 'back'};
    const prev = best.get(other);
    if (!prev || rank(item) > rank(prev)) best.set(other, item);
  }
  const lists = {out: [], back: [], mutual: []};
  for (const x of best.values()) lists[x.dir].push({id: x.id, link: x.link});
  return lists;
}

// 二度关联：没有直接相连，但共享概念或话题的内容。
export function latent(graph, id) {
  const near = new Set([id, ...graph.links.filter(l => l.a === id || l.b === id).map(l => l.a === id ? l.b : l.a)]);
  const hubs = graph.links.filter(l => (l.a === id || l.b === id) && l.kind === 'tag').map(l => l.a === id ? l.b : l.a);
  const score = new Map();
  for (const h of hubs) for (const l of graph.links) {
    if (l.a !== h && l.b !== h) continue;
    const other = l.a === h ? l.b : l.a;
    if (near.has(other) || !CONTENT.has(graph.index.get(other)?.kind)) continue;
    score.set(other, [...(score.get(other) || []), graph.index.get(h).title]);
  }
  return [...score].sort((a, b) => b[1].length - a[1].length).map(([other, via]) => ({id: other, via}));
}

export function stats(graph) {
  const content = graph.nodes.filter(n => CONTENT.has(n.kind));
  const real = graph.links.filter(l => l.kind !== 'contain');
  return {
    content: content.length,
    links: real.length,
    mutual: real.filter(l => l.both).length,
    wiki: graph.links.filter(l => l.kind === 'wiki').length,
    ghosts: graph.nodes.filter(n => n.kind === 'ghost').length,
    lonely: content.filter(n => !real.some(l => l.a === n.id || l.b === n.id)).length,
    backlinked: content.filter(n => n.in > 0).length
  };
}

// —— 布局 ——
function rng(seed) { let s = 0; for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rad = d => d * Math.PI / 180;

export function forceLayout(graph) {
  const all = graph.nodes, idx = graph.index;
  // 已完成任务与指令台账不参与力导向迭代（累计几百条会把 O(N²) 迭代拖到秒级），直接按锚点随机摆放
  const N = all.filter(n => !(n.kind === 'task' && n.task?.status === 'done') && n.kind !== 'command');
  const anchor = id => {
    const n = idx.get(id);
    if (n.kind === 'concept') return [0, -1];
    // kb 笔记与分区子锚不再全部归拢到知识库单点（会缩成远处一团，水母旁反而空）：
    // 按各自分区在知识库方向 ±58° 弧上散开——每个分区一团星点，贴着知识库水母可见，
    // 与任务/拍板/记忆/服务各自水母方向的星群同构（无锚点时随机散布，看不出模块归属）
    const f = n.folder || '';
    if (n.level === 2 || f.startsWith('f:kb')) {
      const kb = FOLDERS.find(x => x.id === 'f:kb');
      const base = rad(kb.angle);
      const zone = f === 'f:kb' ? id : f;   // 笔记→所在分区；分区锚点→自身
      let h = 0; for (const c of String(zone)) h = (h * 131 + c.charCodeAt(0)) % 9973;
      const ang = base + (h / 9973 - .5) * 116 * Math.PI / 180;
      return [Math.cos(ang), Math.sin(ang), 1];   // 第三位=紧贴标记：kb 团贴近水母（半径 240~300，别飘远）
    }
    const fd = FOLDERS.find(x => x.id === f) || FOLDERS.find(x => x.id === id);
    return fd ? [Math.cos(rad(fd.angle)), Math.sin(rad(fd.angle))] : null;
  };
  for (const n of all) {   // 初始化含 done 任务（弹簧段读它们的坐标，不初始化会 NaN 传染）
    const r = rng(n.id), a = anchor(n.id);
    const near = a && a[2];
    const R = n.kind === 'core' ? 0 : n.kind === 'folder' ? (n.level ? 300 : 210) : CONTENT.has(n.kind) ? (near ? 250 : 330) : 420;
    const base = a ? Math.atan2(a[1], a[0]) : r() * Math.PI * 2;
    const ang = base + (r() - .5) * (a ? (near ? .7 : 1.1) : 6.28);
    n.x = Math.cos(ang) * R * (0.8 + r() * .4); n.y = Math.sin(ang) * R * (0.8 + r() * .4); n.vx = 0; n.vy = 0;
  }
  const rest = {contain: 120, wiki: 95, source: 90, tag: 52, mention: 135, resonance: 170};
  const strength = {contain: .05, wiki: .06, source: .08, tag: .09, mention: .018, resonance: .006};
  for (let it = 0; it < 520; it++) {
    const alpha = 1 - it / 520;
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
      const A = N[i], B = N[j];
      let dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy || .01;
      const charge = (A.kind === 'tag' || B.kind === 'tag' ? 900 : 2600) * (A.kind === 'folder' && B.kind === 'folder' ? 3 : 1);
      const f = charge / d2 * alpha, d = Math.sqrt(d2);
      dx /= d; dy /= d;
      A.vx -= dx * f; A.vy -= dy * f; B.vx += dx * f; B.vy += dy * f;
    }
    for (const l of graph.links) {
      const A = idx.get(l.a), B = idx.get(l.b);
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || .01;
      const k = (d - rest[l.kind]) * strength[l.kind] * alpha;
      A.vx += dx / d * k; A.vy += dy / d * k; B.vx -= dx / d * k; B.vy -= dy / d * k;
    }
    for (const n of N) {
      const a = anchor(n.id);
      if (n.kind === 'folder' && a) { const R = n.level ? 300 : 230; n.vx += (a[0] * R - n.x) * .04; n.vy += (a[1] * R - n.y) * .04; }
      else if (a && a[2] && CONTENT.has(n.kind)) { n.vx += (a[0] * 265 - n.x) * .02; n.vy += (a[1] * 265 - n.y) * .02; }   // kb 团：中强引力贴水母
      else if (a && CONTENT.has(n.kind)) { n.vx += (a[0] * 380 - n.x) * .006; n.vy += (a[1] * 380 - n.y) * .006; }
      else if (a) { n.vx += (a[0] * 300 - n.x) * .004; n.vy += (a[1] * 300 - n.y) * .004; }
      n.vx -= n.x * .002; n.vy -= n.y * .002;
      if (n.kind === 'core') { n.x = 0; n.y = 0; n.vx = 0; n.vy = 0; continue; }
      n.x += n.vx; n.y += n.vy; n.vx *= .55; n.vy *= .55;
    }
  }
  return Object.fromEntries(all.map(n => [n.id, [n.x, n.y * .82]]));
}

// 放射层级：以创作空间为圆心，按链接层数排成同心环。
export function radialLayout(graph) {
  const depth = new Map([['core', 0]]), parent = new Map(), q = ['core'];
  const adj = new Map(graph.nodes.map(n => [n.id, []]));
  const order = {contain: 0, source: 1, wiki: 1, tag: 2, mention: 3, resonance: 4};
  for (const l of [...graph.links].sort((a, b) => order[a.kind] - order[b.kind])) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); }
  while (q.length) { const id = q.shift(); for (const o of adj.get(id)) if (!depth.has(o)) { depth.set(o, depth.get(id) + 1); parent.set(o, id); q.push(o); } }
  const pos = {core: [0, 0]};
  const kids = id => graph.nodes.filter(n => parent.get(n.id) === id).map(n => n.id);
  const leaves = id => { const k = kids(id); return k.length ? k.reduce((s, c) => s + leaves(c), 0) : 1; };
  const place = (id, a0, a1) => {
    const k = kids(id); let a = a0; const total = k.reduce((s, c) => s + leaves(c), 0) || 1;
    for (const c of k) {
      const span = (a1 - a0) * leaves(c) / total, mid = a + span / 2, R = [0, 150, 290, 410, 520][Math.min(depth.get(c), 4)];
      pos[c] = [Math.cos(mid) * R, Math.sin(mid) * R * .82];
      place(c, a, a + span); a += span;
    }
  };
  place('core', -Math.PI, Math.PI);
  for (const n of graph.nodes) if (!pos[n.id]) pos[n.id] = [0, 560];
  return pos;
}

// —— 本地图谱检索（规则匹配，未调用 AI）——
export function askGraph(graph, question, scope) {
  const q = question.trim();
  const C = graph.nodes.filter(n => CONTENT.has(n.kind));
  const real = graph.links.filter(l => l.kind !== 'contain');
  const name = id => graph.index.get(id)?.short || graph.index.get(id)?.title;
  const cards = [];
  if (/任务|未结|在办|待办/.test(q)) {
    const T = graph.nodes.filter(n => n.kind === 'task' && n.task?.status !== 'done');
    const bySt = {};
    for (const t of T) bySt[t.task.status] = (bySt[t.task.status] || 0) + 1;
    cards.push({tone: 'info', title: `未结任务 ${T.length} 条`, en: 'Open tasks', text: Object.entries(bySt).map(([k, v]) => `${STATUS_ZH[k] || k} ${v}`).join(' · ') || '当前没有未结任务。', items: T.map(n => n.id)});
  } else if (/拍板|决策/.test(q)) {
    const D = graph.nodes.filter(n => n.kind === 'decision');
    cards.push({tone: D.length ? 'warn' : 'info', title: `待拍板 ${D.length} 条`, en: 'Pending decisions', text: D.length ? '三门槛落账的待拍事项，点卡片直达。' : '当前没有待拍板事项。', items: D.map(n => n.id)});
  } else if (/服务|健康|在线/.test(q)) {
    const S = graph.nodes.filter(n => n.kind === 'service');
    const down = S.filter(n => !n.service.ok);
    cards.push({tone: down.length ? 'warn' : 'info', title: `服务健康 ${S.length - down.length}/${S.length}`, en: 'Services', text: down.length ? `离线：${down.map(n => n.title).join('、')}` : '全部在线。', items: S.map(n => n.id)});
  } else if (/孤|没有连接|没链接|零散|断开/.test(q)) {
    const lonely = C.filter(n => !real.some(l => l.a === n.id || l.b === n.id));
    const weak = C.filter(n => n.in === 0 && !lonely.includes(n));
    cards.push({tone: 'warn', title: '孤立内容', en: 'Isolated', text: lonely.length ? `${lonely.length} 条内容除了目录外没有任何连接。` : '没有完全孤立的内容。', items: lonely.map(n => n.id)});
    cards.push({tone: 'info', title: '没有反链的内容', en: 'No backlinks', text: `${weak.length} 条内容只向外链接，还没有被其他内容引用。`, items: weak.slice(0, 8).map(n => n.id)});
  } else if (/双向|互链|共振|互相/.test(q)) {
    const mutual = real.filter(l => l.both).sort((a, b) => b.w - a.w);
    cards.push({tone: 'gold', title: '双向连接', en: 'Bidirectional', text: `共 ${mutual.length} 组：互相 [[双链]] 的笔记对。`, pairs: mutual.slice(0, 8).map(l => [l.a, l.b, LINK_KINDS[l.kind]])});
  } else if (/未创建|空链|断链|缺/.test(q)) {
    const ghosts = graph.nodes.filter(n => n.kind === 'ghost');
    cards.push({tone: 'warn', title: '未创建的笔记', en: 'Unresolved links', text: `${ghosts.length} 个 [[双链]] 指向尚未在看板资料中出现的笔记，多来自生成模板。`, items: ghosts.map(n => n.id)});
  } else if (/核心|枢纽|中心|最重要|反链最多|被引用/.test(q)) {
    const top = [...C].sort((a, b) => (b.in + b.mutual) - (a.in + a.mutual) || b.deg - a.deg).slice(0, 6);
    cards.push({tone: 'gold', title: '连接最密的内容', en: 'Most connected', text: '按反链与双向连接数排序。', items: top.map(n => n.id), meta: top.map(n => `${n.deg} 条连接`)});
    const hubs = graph.nodes.filter(n => n.kind === 'tag').sort((a, b) => b.deg - a.deg).slice(0, 5);
    cards.push({tone: 'info', title: '最常用的话题', en: 'Top topics', text: hubs.map(h => `${h.title}（${h.deg}）`).join('、'), items: hubs.map(n => n.id)});
  } else if (/下一篇|写什么|选题|延伸/.test(q)) {
    for (const idea of C.filter(n => n.kind === 'idea')) {
      const rel = latent(graph, idea.id).filter(r => graph.index.get(r.id).kind === 'post');
      cards.push({tone: 'info', title: idea.short, en: 'Next piece', text: rel.length ? `可以延伸 ${rel.length} 篇已发布作品，共享：${[...new Set(rel.flatMap(r => r.via))].slice(0, 4).join('、')}` : '暂未与已发布作品共享概念，可补充正文后再看。', items: [idea.id, ...rel.slice(0, 3).map(r => r.id)]});
    }
  } else if (/表现|观看|最好|数据|收藏/.test(q)) {
    const ps = C.filter(n => n.kind === 'post').sort((a, b) => b.post.views - a.post.views);
    cards.push({tone: 'gold', title: '作品表现', en: 'Performance', text: `观看最高：${ps[0].short}（${ps[0].post.views}）。下面按观看排序。`, items: ps.map(n => n.id), meta: ps.map(n => `${n.post.views} 观看 · ${n.post.saves} 收藏`)});
  } else {
    const words = q.replace(/[？?。，,！!]/g, ' ').split(/\s+/).filter(w => w.length >= 1);
    const hits = graph.nodes.filter(n => n.kind !== 'core').map(n => {
      const hay = (n.title + ' ' + (n.text || '') + ' ' + (n.path || '')).toLowerCase();
      const score = words.reduce((s, w) => s + (n.title.toLowerCase().includes(w.toLowerCase()) ? 3 : hay.includes(w.toLowerCase()) ? 1 : 0), 0);
      return {n, score};
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
    cards.push(hits.length
      ? {tone: 'info', title: `与「${q}」相关`, en: 'Search', text: `在标题、正文和路径中找到 ${hits.length} 处匹配。点击可聚焦。`, items: hits.map(h => h.n.id)}
      : {tone: 'warn', title: '没有找到匹配', en: 'No match', text: '试试：孤立内容、双向连接、未创建的笔记、核心内容、下一篇写什么。', items: []});
  }
  if (scope) cards.forEach(c => { if (c.items) c.items.sort((a, b) => (b === scope) - (a === scope)); });
  return cards.map(c => ({...c, names: (c.items || []).map(name)}));
}

// 工作站混合命中卡（10-16 混合查询）：任务/拍板/指令/记忆/服务全域关键词匹配——
// 与 askGraph 规则卡、8342 KB 语义卡并列，查询框一次问出整个生态。
export function ecosystemAsk(graph, question) {
  const q = String(question || '').trim();
  if (!q) return null;
  const words = q.replace(/[？?。，,！!]/g, ' ').split(/\s+/).filter(w => w.length >= 1).map(w => w.toLowerCase());
  if (!words.length) return null;
  const KIND_ZH = {task: '任务', decision: '拍板', command: '指令', memory: '记忆', service: '服务'};
  const hits = graph.nodes.filter(n => n.kind in KIND_ZH && (n.task?.status !== 'done')).map(n => {
    const hay = (n.title + ' ' + (n.text || '')).toLowerCase();
    let score = 0;
    for (const w of words) score += n.title.toLowerCase().includes(w) ? 3 : hay.includes(w) ? 1 : 0;
    return {n, score};
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
  if (!hits.length) return null;
  const byKind = {};
  for (const h of hits) byKind[h.n.kind] = (byKind[h.n.kind] || 0) + 1;
  return {
    tone: 'gold', title: `工作站命中 ${hits.length} 条`, en: 'Workstation hits',
    text: Object.entries(byKind).map(([k, v]) => `${KIND_ZH[k]} ${v}`).join(' · '),
    items: hits.map(h => h.n.id), names: hits.map(h => h.n.short || h.n.title),
    meta: hits.map(h => KIND_ZH[h.n.kind])
  };
}

// kbserve 命中 → 统一可点击 items（匹配图谱节点的走 onGo 跳转，未匹配的走 readKb 阅读弹窗）
// 2026-10-21 修复：微信转写文件 basename=日期（如 2026-10-14.md），群名在父目录——
// 旧逻辑 chip 全是"2026-10-14"千篇一律；现在拼父目录短名，并带 chunk 摘要片段，
// 卡片不用点开就能判断沾不沾边。
export function kbHitsToItems(hits, graph) {
  const base = p => String(p || '').split(/[\\/]/).pop().replace(/\.md$/, '');
  const shortParent = path => {
    const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : '';
  };
  const looksLikeDate = s => /^\d{4}-\d{2}-\d{2}/.test(s || '');
  return (hits || []).map(h => {
    const path = h.meta?.source_path || '';
    const b = base(path);
    const nd = b && graph.nodes.find(n => n.kind === 'note' && base(n.path) === b);
    const sim = h.cosine != null ? Number(h.cosine).toFixed(2) : (h.src?.includes('bm25') ? '关键词' : '相关');
    const meta = typeof sim === 'string' ? sim : '相似 ' + sim;
    if (nd) return {id: nd.id, name: nd.short || nd.title, meta, isKb: false, kind: nd.kind};
    // 日期型文件名拼父目录（群名/邮件夹名），否则只留 basename；过长父名截 14 字
    const parent = shortParent(path);
    const name = (looksLikeDate(b) && parent)
      ? `${b}·${parent.length > 14 ? parent.slice(0, 14) + '…' : parent}`
      : (b || '命中');
    const snippet = String(h.doc || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    return {id: 'kb:' + path, name, meta, isKb: true, kind: 'note', path, doc: h.doc || '', snippet, cat: h.meta?.category || ''};
  });
}