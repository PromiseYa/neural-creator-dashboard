import React, {useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback} from 'react';
import {MODULES, KINDS, stats, askGraph, moduleOf, STATUS_ZH, PRIO_ZH, nodeBadge, TASK_OPS, ST_COLOR} from './graph';
import {Icon} from './icons';
import {NetworkCanvas} from './NetworkCanvas';
import {Analysis} from './Analysis';
import {T} from './theme';
import {CONFIG} from '../config';
import {wvFocus, wvBlur} from '../data/live';
import {glowSprite} from './sprites';

const FLIP = {tasks: 1, kb: -1, decisions: -1, memory: 1, services: -1};
export const MOD_STYLE = Object.fromEntries(Object.entries(T.modules).map(([id, m]) => [id, {...m, flip: FLIP[id]}]));

export const split = n => ({out: n.out - n.mutual, back: n.in - n.mutual, both: n.mutual});
const fmt = v => v == null ? '—' : Number(v).toLocaleString('zh-CN');

// 生态流水（左侧竖条）：从水母列/水母环下方一点垂到屏幕底部，越往下越虚无（mask 渐隐）；
// 无边框无底色，行样式参考右上图例（小圆点+文字）；30 秒轮询，新到事件金色高亮。
const ACT_COLOR = {dispatch: '#a9d3e4', task: '#c3bcf2', decide: '#e8c48c', decision: '#e8c48c', alarm: '#ff7385', cmd: '#7ddc9a', event: '#98a6a1'};
function EcoStream({events, top}) {
  const [freshIds, setFreshIds] = useState(() => new Set());
  const seenMax = useRef(null);
  useEffect(() => {
    if (!events.length) return;
    const maxId = Math.max(...events.map(e => e.id || 0));
    if (seenMax.current == null) { seenMax.current = maxId; return; }   // 首轮只记录水位，不标新
    const news = events.filter(e => (e.id || 0) > seenMax.current);
    seenMax.current = maxId;
    if (news.length) {
      setFreshIds(new Set(news.map(e => e.id)));
      const t = setTimeout(() => setFreshIds(new Set()), 6000);
      return () => clearTimeout(t);
    }
  }, [events]);
  if (!events.length) return null;
  return <div className="ecostream" style={{top}} aria-label="生态流水">
    <h3>生态流水 <em>Stream</em><b>{events.length}</b></h3>
    <div className="eco-list">
      {events.slice(0, 14).map(e => (
        <div key={e.id ?? (e.ts + (e.detail || ''))} className={`eco-item${freshIds.has(e.id) ? ' fresh' : ''}`}>
          <i style={{'--ec': ACT_COLOR[e.kind] || ACT_COLOR.event}}/>
          <span className="eco-ts">{String(e.ts || '').slice(5, 16)}</span>
          <span className="eco-txt" title={e.detail || ''}>{e.detail || `${e.actor || ''} ${e.action || ''}`}</span>
        </div>
      ))}
    </div>
  </div>;
}

// 知识库按真实目录层级钻取（文件浏览器语义）：zone=null 显示分区层；
// zone='工作区' 或更深 '工作区/子目录/xx' 时，每层都显示 [子目录卡 + 直接放在本层的笔记] 混排，
// 目录卡篇数 = 该子树的全部笔记数。清单不设上限，往下延伸用滚轮平移。
export function moduleItems(graph, modId, zone) {
  const m = MODULES.find(x => x.id === modId);
  if (!m) return [];
  if (m.kind === 'note' && zone !== undefined) {
    if (!zone) {
      const zones = graph.nodes.filter(n => n.kind === 'folder' && n.id.startsWith('f:kb:'));
      return zones.map(n => ({...n, count: graph.links.filter(l => l.kind === 'contain' && l.a === n.id).length, path: n.title}))
        .sort((a, b) => b.count - a.count);
    }
    const [z0, ...rest] = zone.split('/');
    const prefix = rest.join('/');
    const inZone = graph.nodes.filter(n => n.kind === 'note' && n.folder === 'f:kb:' + z0);
    const dirs = new Map(), roots = [];
    for (const n of inZone) {
      const sz = n.subzone || '';
      // 把 subzone 折算成相对当前层的余段：本层笔记为 ''，更深层取下一段目录名
      let rel = null;
      if (!prefix) rel = sz;
      else if (sz === prefix) rel = '';
      else if (sz.startsWith(prefix + '/')) rel = sz.slice(prefix.length + 1);
      if (rel === null) continue;
      if (!rel) roots.push(n);
      else dirs.set(rel.split('/')[0], (dirs.get(rel.split('/')[0]) || 0) + 1);
    }
    const dirCards = [...dirs].map(([name, count]) => ({id: 'f:kb:' + zone + '/' + name, kind: 'folder', title: name, short: name,
      count, path: zone + '/' + name, level: 3}));
    return [...dirCards.sort((a, b) => b.count - a.count),
      ...roots.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))];
  }
  // 任务流两级钻取（与知识库/服务舱同款语法）：第一层=待办/今日完成/累计完成三张分类卡，
  // 第二层=对应任务清单（done 任务带"完成"徽章，可点开详情，状态扇形可切回待办）
  if (m.kind === 'task' && zone !== undefined) {
    const all = graph.nodes.filter(n => n.kind === 'task');
    const today = new Date().toISOString().slice(0, 10);
    const doneList = all.filter(n => n.task?.status === 'done');
    const byDone = (a, b) => String(b.task?.done_at || '').localeCompare(String(a.task?.done_at || ''));
    if (!zone) {
      const open = all.filter(n => n.task?.status !== 'done');
      const card = (id, title, list) => ({id, kind: 'folder', title, short: title, count: list.length, unit: '条', path: title, level: 2});
      return [card('f:task:open', '待办', open), card('f:task:today', '今日完成', doneList.filter(n => String(n.task?.done_at || '').slice(0, 10) === today)), card('f:task:all', '累计完成', doneList)];
    }
    if (zone === '待办') return all.filter(n => n.task?.status !== 'done')
      .sort((a, b) => String(b.task?.updated_at || '').localeCompare(String(a.task?.updated_at || '')));
    if (zone === '今日完成') return doneList.filter(n => String(n.task?.done_at || '').slice(0, 10) === today).sort(byDone);
    const doneMs = n => Date.parse(String(n.task?.done_at || '').replace(' ', 'T')) || 0;
    if (zone === '累计完成') {
      // 第三层：按完成时间滚动窗口分类（1天⊂3天⊂一周⊂一月⊂所有）
      const now = Date.now();
      const win = d => doneList.filter(n => now - doneMs(n) <= d * 864e5).length;
      const card = (t, cnt) => ({id: 'f:task:w' + t, kind: 'folder', title: t, short: t, count: cnt, unit: '条', path: '累计完成/' + t, level: 3});
      return [card('最近1天', win(1)), card('最近3天', win(3)), card('最近一周', win(7)), card('最近一月', win(30)), card('所有', doneList.length)];
    }
    if (zone.startsWith('累计完成/')) {
      const d = {'最近1天': 1, '最近3天': 3, '最近一周': 7, '最近一月': 30}[zone.split('/')[1]];
      return (d ? doneList.filter(n => Date.now() - doneMs(n) <= d * 864e5) : doneList).sort(byDone);
    }
    return [];
  }
  // 服务舱两级钻取（与知识库分区同款语法）：第一层=核心服务/常驻工作者两张分类卡，
  // 第二层=该分类下的服务卡。分类用中文标题当 zone（面包屑显示用），服务归属靠 service.group。
  if (m.kind === 'service' && zone !== undefined) {
    const all = graph.nodes.filter(n => n.kind === 'service');
    if (!zone) {
      const grp = g => all.filter(n => n.service?.group === g);
      const card = (id, title, list) => ({id, kind: 'folder', title, short: title, count: list.length,
        online: list.filter(n => n.service?.ok).length, path: title, level: 2});
      return [card('f:svc:core', '核心服务', grp('core')), card('f:svc:worker', '常驻工作者', grp('worker'))];
    }
    const g = zone === '核心服务' ? 'core' : zone === '常驻工作者' ? 'worker' : null;
    return all.filter(n => n.service?.group === g);
  }
  const list = graph.nodes.filter(n => n.kind === m.kind);
  if (m.kind === 'post') list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (m.kind === 'task') list.sort((a, b) => String(b.task?.updated_at || '').localeCompare(String(a.task?.updated_at || '')));
  if (m.kind === 'note') list.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  return list;
}

function moduleSummary(graph, m) {
  // 服务舱/任务流进了分类层后 items 是分类卡：水母上的计数始终按本体统计
  if (m.id === 'services') {
    const S = graph.nodes.filter(n => n.kind === 'service');
    return {count: S.length, sub: [S.filter(n => n.service?.ok).length, '在线', 'online']};
  }
  if (m.id === 'tasks') {
    const T = graph.nodes.filter(n => n.kind === 'task');
    const open = T.filter(n => n.task?.status !== 'done');
    return {count: open.length, sub: [open.filter(n => n.task?.status === 'doing').length || open.length, '未结', 'open']};
  }
  const items = moduleItems(graph, m.id);
  const sub = {
    tasks: () => [items.filter(n => n.task?.status === 'doing').length || items.length, '未结', 'open'],
    kb: () => [graph.links.filter(l => l.kind === 'wiki').length, '双链', 'wikilinks'],
    decisions: () => [items.filter(n => n.decision?.status === 'pending').length, '待拍', 'pending'],
    memory: () => [items.length, '条目', 'items'],
    services: () => [items.filter(n => n.service?.ok).length, '在线', 'online']
  }[m.id]();
  return {count: items.length, sub};
}

const HB_ZH = {ok: '心跳正常', noreport: '无心跳', late: '心跳迟到'};

function itemMeta(n) {
  const d = split(n);
  switch (n.kind) {
    case 'folder': return [[n.unit || (n.online != null ? '服务' : '篇数'), n.unit ? '' : (n.online != null ? 'Services' : 'Notes'), n.count || 0], n.online != null ? ['在线', 'Online', n.online] : ['', '', ''], ['', '', '']];
    case 'task': return [[STATUS_ZH[n.task?.status] || n.task?.status || '—', '', ''], [PRIO_ZH[n.task?.priority] || n.task?.priority || '—', '', ''], ['↔', '', d.both]];
    case 'note': return [['出链', 'Out', d.out], ['反链', 'In', d.back], ['↔', '', d.both]];
    case 'decision': return [[n.decision?.status || '—', '', ''], [String(n.decision?.created_at || '').slice(5, 10) || '—', '', ''], ['↔', '', d.both]];
    case 'memory': return [[n.updated ? `更新 ${String(n.updated).slice(5)}` : '记忆池', '', ''], ['↔', '', d.both], ['', '', '']];
    case 'service': return [[n.service?.ok ? '在线' : (n.service?.state === 'noreport' ? '无心跳' : '离线'), '', ''], [HB_ZH[n.service?.state] || '', '', ''], ['', '', '']];
    case 'post': return [['观看', 'Views', fmt(n.post.views)], ['收藏', 'Saves', fmt(n.post.saves)], ['↔', '', d.both]];
    case 'idea': return [[n.idea.priority, 'Priority', ''], [n.idea.status, '', ''], ['↔', '', d.both]];
    case 'draft': return [['字', 'Chars', fmt((n.body || '').length)], ['↔', '', d.both], ['', '', '']];
    case 'concept': return [['提及', 'Mentions', n.in], ['↔', '', d.both], ['', '', '']];
    default: return [];
  }
}

// —— 布局目标 ——
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function targets(L, t) {
  const {w: W, h: H} = L.size, st = L.stage, narrow = W < 760;
  const swim = L.reduced ? 0 : 1;
  const res = {orb: {}, jelly: {}, fan: null, chain: null, pfan: null};
  if (st === 'hub') {
    const s = narrow ? clamp(W * .56, 180, 280) : clamp(Math.min(W, H) * .5, 250, 440);
    const cy = narrow ? H * .47 : H * .53;
    res.orb = {x: W / 2, y: cy, s};
    const rx = narrow ? W * .36 : Math.min(W * .36, 540), ry = narrow ? H * .21 : Math.min(H * .32, 262);
    MODULES.forEach((m, i) => {
      const a = (m.angle + swim * 7 * Math.sin(t * .17 + i * 1.7)) * Math.PI / 180;
      const r = 1 + swim * .04 * Math.sin(t * .23 + i);
      res.jelly[m.id] = {x: W / 2 + Math.cos(a) * rx * r, y: cy + Math.sin(a) * ry * r + swim * 9 * Math.sin(t * .9 + i * 2.1), s: narrow ? 92 : clamp(W * .12, 120, 184), o: 1, tilt: swim * 6 * Math.sin(t * .6 + i)};
    });
  } else if (narrow) {
    res.orb = {x: 40, y: 156, s: 86};
    MODULES.forEach((m, i) => {
      const sel = m.id === L.mod, k = slotOf(L.mod, m.id);
      res.jelly[m.id] = {x: 104 + k * (W - 136) / 4, y: 152 + swim * 4 * Math.sin(t * .9 + i * 2), s: sel ? 76 : 54, o: sel ? 1 : .55, tilt: swim * 3 * Math.sin(t * .6 + i)};
    });
    const n = L.items.length, gap = clamp((H - 330) / Math.max(n - 1, 1), 22, 54);
    res.fan = {x: 34, y0: 286, gap};
  } else {
    const ox = Math.max(124, W * .09), cy = H * .53;
    res.orb = {x: ox, y: cy, s: 178};
    const colX = ox + 158, gap = Math.min(122, (H - 150) / 5);
    MODULES.forEach((m, i) => {
      const sel = m.id === L.mod, k = slotOf(L.mod, m.id);
      // 慢速左右摇摆漂浮（幅 9px / 周期约 24s，各水母相位错开）；选中的稍向右凸出
      res.jelly[m.id] = {x: colX + (sel ? 16 : 0) + swim * 9 * Math.sin(t * .26 + i * 1.7), y: cy + (k - 2) * gap + swim * 5 * Math.sin(t * .9 + i * 2), s: sel ? 128 : 92, o: sel ? 1 : .6, tilt: swim * 3 * Math.sin(t * .6 + i)};
    });
    // 伞状条目以右侧分析栏为基准排在它左边约 90px 处（条目最宽约 270px），触须拉长、画面左右均衡；
    // 模块层和打开笔记后位置相同，右侧栏滑入时伞不跳动。
    // 长清单不压缩间距：固定间距往下排，超出视口的部分用滚轮平移（panY），像一张往下无限延伸的画布。
    const panelLeft = W - clamp(W * .30, 360, 440) - 44;
    const n = L.items.length;
    // 清单间距自适应：卡少（分类层 2-3 张）时舒张开（≤120px），长清单回到 54px 密排——
    // 固定 54px 时两张分类卡叠在一起，触须开角小显得别扭（知识库多卡伞状才不显）
    const fgap = clamp((H - 380) / Math.max(n, 1), 54, 120);
    // 扇形第一列贴水母标签右缘约 190px（与其他列 200px 间距一致）：
    // 旧公式用 panelLeft 反推，宽屏会把清单推得离水母很远（视觉脱节）；详情面板让位交给笔记模式的整组缩放
    const originX = colX + 16 + 176 + 12;
    const fanBase = Math.min(originX + 190, panelLeft - 280);
    const selOpen = L.stage === 'note';
    // kb 目录钻取（宽屏）：每一层完整复刻"水母层"语法——选中卡调换到中间放大当该列主角（同选中水母居中），
    // 同层兄弟卡保持原尺寸、变暗排在上下（同未选水母 o=.6；深列放不下才缩），下一层在右侧下一个槽位
    // 按原尺寸完整展开（同点知识库后生出的那层）；连线=上一列选中卡右缘→下一列各卡，逐列接棒。
    // 打开笔记时：整个构图（光球+水母列+祖先列+文件列）作为同一刚体向左平移+整体缩小给详情页让位——
    // 结构原样、无人消失、无重排，ESC 原样放大还原。
    const zchain = L.zonePath || [];
    const zdRaw = zchain.length > 1 ? zchain.length - 1 : 0;   // kb 与 services 都走层级链（zonePath 只有这两个模块有值）
    const zd = Math.min(zdRaw, 2);
    const SX = [fanBase, fanBase + 200, fanBase + 400];
    const fit = !zd || SX[zd] + 270 <= W - 24;
    const span = Math.max(0, n - 1) * fgap;
    // 清单顶部让位：不越过最上方水母（其下方留 70px）——鼠标点水母不被细项卡挡住，触须也更舒展
    const topJelly = cy - 2 * gap;
    let x = fanBase, y0 = Math.max(cy - span / 2, topJelly + 70), fg2 = fgap, fsc = 1;
    res.acols = null;
    if (zd && fit) {
      x = SX[zd];
      res.acols = (L.ancLevels || []).slice(0, zd).map((cards, k) => {
        const pz = zchain[k + 1]?.zone;
        const pi = Math.max(0, cards.findIndex(c => c.path === pz));
        const pos = new Array(cards.length);
        const nSib = cards.length - 1;
        const sg = nSib ? clamp((H - 320) / nSib, 30, 110) : 54;   // 兄弟卡间距同理：少则舒展（≤110），多则密排
        const sd = Math.min(1, sg / 46);   // 兄弟卡尽量保持原尺寸（文字不缩），只有深列排不下才等比缩
        let ay = cy - (sg - 8), by = cy + (sg - 8), j = 0;
        for (let i = 0; i < cards.length; i++) {
          if (i === pi) { pos[pi] = {x: SX[k], y: cy, s: 1, path: true}; continue; }
          pos[i] = j % 2 === 0 ? {x: SX[k], y: ay, s: sd, dim: true} : {x: SX[k], y: by, s: sd, dim: true};
          if (j % 2 === 0) ay -= sg; else by += sg;
          j++;
        }
        return pos;
      });
      if (selOpen) {
        // 整体缩小+向左平移（同一刚体变换）：以光球左缘为锚，把 水母列/祖先列/文件列 一起压缩到详情页左侧。
        // g 按笔记模式标题收窄后的实际卡宽估（160+边距≈200），面板已收窄让位 → 缩得更少
        const AX = 125, g = Math.min(1, (panelLeft - 20 - AX) / (SX[zd] - AX + 200));
        const mx = v => AX + (v - AX) * g;
        res.noteG = g;
        res.orb.x = mx(res.orb.x); res.orb.s *= g;
        for (const id in res.jelly) { const jj = res.jelly[id]; jj.x = mx(jj.x); jj.y = cy + (jj.y - cy) * g; jj.s *= g; }
        res.acols = res.acols.map(col => col.map(p => p && ({x: mx(p.x), y: cy + (p.y - cy) * g, s: p.s * g, path: p.path, dim: p.dim})));
        x = mx(x); y0 = cy + (y0 - cy) * g; fg2 = fgap * g; fsc = g;
      }
    }
    res.fan = {x, y0, gap: fg2, scale: fsc, panMax: Math.max(0, y0 + span * fsc + 70 - H)};
  }
  return res;
}

// 选中的模块排在列的正中间（第 2 格），其余模块按原顺序分列上下，触须从中间向上下对称展开。
function slotOf(selId, id) {
  const others = MODULES.filter(m => m.id !== selId).map(m => m.id);
  const order = [others[0], others[1], selId, others[2], others[3]];
  const k = order.indexOf(id);
  return k < 0 ? MODULES.findIndex(m => m.id === id) : k;
}

function spring(st, target, dt, k = 62) {
  const c = 2 * Math.sqrt(k);
  st.v += (-k * (st.x - target) - c * st.v) * dt;
  st.x += st.v * dt;
  return st.x;
}
const sp = x => ({x, v: 0});
// 光球边缘向外飘散的光点（光球本地坐标，画布 1012×1012，中心 506）
const DUST = Array.from({length: 110}, (_, i) => ({a: i * 2.39996, v: .035 + (i * 37 % 100) / 100 * .06, o: (i * .618034) % 1, w: (i % 2 ? 1 : -1) * (.15 + (i % 7) * .05), s: .7 + (i % 5) * .32, b: .45 + (i % 3) * .25, c: T.dust[i % T.dust.length]}));
// 光球与水母的视频逐帧画到 <canvas> 上显示：部分内置 / 嵌入式浏览器不合成 <video> 画面（解码正常但页面上是空的），
// 画布在所有浏览器里都能显示。视频本身透明地留在原位负责播放；未加载好时先画封面图。
const posterCache = new Map();
const posterOf = url => { if (!posterCache.has(url)) { const img = new Image(); img.src = url; posterCache.set(url, img); } return posterCache.get(url); };
function paintVideo(pair) {
  const {video, canvas} = pair;
  if (!video || !canvas) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!cw || !ch) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  const resized = canvas.width !== W || canvas.height !== H;
  if (resized) { canvas.width = W; canvas.height = H; }
  const ready = video.readyState >= 2 && video.videoWidth;
  const src = ready ? video : posterOf(video.poster);
  const sw0 = ready ? video.videoWidth : src.naturalWidth, sh0 = ready ? video.videoHeight : src.naturalHeight;
  if (!sw0 || !sh0) return;
  const stamp = ready ? video.currentTime : -1;
  if (!resized && stamp === pair.stamp && ready === pair.ready) return;
  pair.stamp = stamp; pair.ready = ready;
  // 等同 object-fit: cover
  const k = Math.max(W / sw0, H / sh0), sw = W / k, sh = H / k;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(src, (sw0 - sw) / 2, (sh0 - sh) / 2, sw, sh, 0, 0, W, H);
}

const bez = (p0, p1, p2, p3, u) => { const m = 1 - u; return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3; };

function Scene({graph, items, onModule, onItem, onAction, onHome, live, sel, zonePath, ancLevels, zone}) {
  const dustRef = useRef(null);
  const orbRef = useRef(null), jellyRefs = useRef({}), innerRefs = useRef({}), labelRefs = useRef({}), threadRefs = useRef({}), pulseRefs = useRef({}), sceneRef = useRef(null);
  const itemRefs = useRef([]), fanRefs = useRef([]), fanPulseRefs = useRef([]);
  const aItemRefs = useRef([]), aThreadRefs = useRef([]), aThreadPulseRefs = useRef([]);
  const vids = useRef({});
  const vidRef = (id, part) => el => { (vids.current[id] ||= {})[part] = el; };
  const summaries = useMemo(() => Object.fromEntries(MODULES.map(m => [m.id, moduleSummary(graph, m)])), [graph]);

  useLayoutEffect(() => { live.current.fanStart = performance.now(); }, [items, live]);

  useEffect(() => {
    let raf, last = performance.now();
    const S = live.current.springs;
    const step = now => {
      const L = live.current;
      // rAF 给的是帧开始时间，可能早于上面记录的 last；负的 dt 会让后续计算出现 NaN，所以限制为 ≥ 0
      const dt = Math.max(0, Math.min(1 / 30, (now - last) / 1000)); last = Math.max(last, now);
      if (!L.paused) L.time += dt;
      const t = L.time, since = (now - L.t0) / 1000;
      const T = targets(L, t);
      L.noteG = T.noteG || 1;   // 笔记模式整组缩放系数：水母标签同步缩放（文本框不缩会挤压且线条起点错位）
      if (T.fan) L.fanMeta = {panMax: T.fan.panMax || 0, n: L.items.length};
      const intro = L.stage === 'hub' && !L.reduced;
      // 光球
      const orbS = intro && since < .15 ? T.orb.s * .35 : T.orb.s;
      const ox = spring(S.orb.x, T.orb.x, dt), oy = spring(S.orb.y, T.orb.y, dt), os = spring(S.orb.s, orbS, dt, 40), oo = spring(S.orb.o, intro && since < .1 ? 0 : 1, dt, 30);
      L.orb = {x: ox, y: oy, s: os};
      if (orbRef.current) { orbRef.current.style.transform = `translate3d(${ox - os / 2}px,${oy - os / 2}px,0) scale(${os / 460})`; orbRef.current.style.opacity = clamp(oo, 0, 1); }
      const dust = dustRef.current;
      if (dust) {
        const di = clamp(spring(S.dust, L.stage === 'hub' ? .3 : 1, dt, 18), 0, 1);
        const ctx = dust.getContext('2d');
        ctx.clearRect(0, 0, 1012, 1012);
        if (!L.reduced && di > .02) {
          const sc = Math.max(os / 460, .2);
          ctx.globalCompositeOperation = 'lighter';
          for (const p of DUST) {
            const ph = ((t * p.v + p.o) % 1 + 1) % 1, r = 150 + ph * 340, a = p.a + ph * p.w;
            const x = 506 + Math.cos(a) * r, y = 506 + Math.sin(a) * r * .96;
            const al = di * Math.pow(Math.max(0, Math.sin(ph * Math.PI)), 1.3) * p.b, rad = p.s / sc * 2.2;
            ctx.globalAlpha = al;
            ctx.drawImage(glowSprite(p.c), x - rad, y - rad, rad * 2, rad * 2);
          }
          ctx.globalAlpha = 1;
        }
      }
      // 水母
      MODULES.forEach((m, i) => {
        const j = S.jelly[m.id], tg = T.jelly[m.id];
        const gated = intro && since < 1 + i * .17;
        const x = spring(j.x, gated ? ox : tg.x, dt), y = spring(j.y, gated ? oy : tg.y, dt), s = spring(j.s, gated ? 24 : tg.s, dt), o = spring(j.o, gated ? 0 : tg.o, dt, 40);
        const lo = spring(j.lo, intro && since < 2 + i * .1 ? 0 : tg.o, dt, 40);
        j.cur = {x, y, s};
        const el = jellyRefs.current[m.id], inner = innerRefs.current[m.id], lab = labelRefs.current[m.id];
        if (el) { el.style.transform = `translate3d(${x - s / 2}px,${y - s * .375}px,0) scale(${s / 200})`; el.style.opacity = clamp(o, 0, 1); }
        if (inner) inner.style.transform = `rotate(${tg.tilt}deg) scaleX(${MOD_STYLE[m.id].flip})`;
        if (lab) {
          const lw = lab.offsetWidth, lh = lab.offsetHeight, ng = L.noteG || 1;
          const hub = L.stage === 'hub', narrow = L.size.w < 760;
          // 侧列时标签放在水母右边缘之外再空 10px，触须不压标签；笔记模式整组缩放时标签同步缩放
          const lx = hub ? x - lw / 2 : narrow ? x - lw / 2 : x + s * .5 + 10;
          const ly = hub ? y + s * .36 : narrow ? y + s * .36 : y - lh / 2;
          lab.style.transformOrigin = 'left center';
          lab.style.transform = `translate3d(${lx}px,${ly}px,0) scale(${ng})`;
          lab.style.opacity = clamp(narrow && !hub && m.id !== L.mod ? 0 : lo, 0, 1);
          j.label = {x: lx, y: ly, w: lw * ng, h: lh * ng};   // w/h 记缩放后的视觉宽：连线起点才不会错位
        }
        // 光球 → 水母：神经丝与往返脉冲
        const g = threadRefs.current[m.id];
        if (g) {
          let x1, y1, x2, y2, c1x, c1y, c2x, c2y;
          if (L.stage === 'hub') {
            const dx = x - ox, dy = y - oy, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
            x1 = ox + ux * os * .2; y1 = oy + uy * os * .2; x2 = x - ux * s * .22; y2 = y - uy * s * .1;
            const bend = 26 * Math.sin(t * .5 + i);
            c1x = x1 + dx * .35 - uy * bend; c1y = y1 + dy * .35 + ux * bend; c2x = x1 + dx * .7 + uy * bend; c2y = y1 + dy * .7 - ux * bend;
          } else {
            x1 = ox + os * .3; y1 = oy; x2 = x - s * .34; y2 = y;
            const dx = x2 - x1; c1x = x1 + dx * .55; c1y = y1; c2x = x2 - dx * .55; c2y = y2;
          }
          const d = `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`;
          const active = m.id === L.mod || m.kind === L.hover;
          g.glow.setAttribute('d', d); g.core.setAttribute('d', d);
          const vis = clamp(o, 0, 1) * (L.stage === 'hub' ? 1 : active ? 1 : .45);
          g.glow.style.opacity = vis * (active ? .9 : .45); g.core.style.opacity = vis;
          const pulses = pulseRefs.current[m.id] || [];
          pulses.forEach((c, k) => {
            if (!c) return;
            const inbound = k === 2;
            let u = ((t * (inbound ? .23 : .31) + k * .5 + i * .17) % 1);
            if (inbound) u = 1 - u;
            c.setAttribute('cx', bez(x1, c1x, c2x, x2, u)); c.setAttribute('cy', bez(y1, c1y, c2y, y2, u));
            c.style.opacity = L.reduced || L.paused ? 0 : vis * Math.sin(u * Math.PI);
          });
        }
      });
      // 层级递进列（kb 钻取）：卡片弹簧状态按节点 id 全局缓存（Map）——钻深/回退时同一张卡在
      // "当前列 ↔ 祖先列"之间换角色而位置连续（旧列原地等比缩小、回退时原地放大，不重生长不闪跳）。
      // 每列的触须都从上一列"钻入卡"右缘扇形展开（首列由水母标签喂养）——"水母→下一层"同一模式逐级复用
      const sj = L.mod && S.jelly[L.mod];
      const vis = L.vis || (L.vis = new Map());
      const touched = new Set();   // 本帧渲染到的卡片（祖先列/当前列），没触到的置 off——重进当前列时从源头重生
      const cardState = (id, sx, sy, ss) => {
        let st = vis.get(id);
        if (!st) { st = {x: sp(sx), y: sp(sy), s: sp(ss), o: sp(0), seen: false}; vis.set(id, st); }
        return st;
      };
      let feed = sj?.label ? {x: sj.label.x + sj.label.w + 6, y: sj.cur.y, o: 1} : null;   // 当前列的喂养源：一路接棒到最深祖先列的选中卡
      (T.acols || []).forEach((col, k) => {
        const cards = ancLevels[k];
        if (!cards) return;
        const src = feed;   // 本列触须源头=上一列选中卡（首列=水母标签），本列选中卡稍后接棒
        col.forEach((tp, i) => {
          if (!tp) return;
          const n = cards[i];
          const st = cardState(n.id, src ? src.x : tp.x, src ? src.y : tp.y, tp.s);
          st.role = 'anc'; touched.add(n.id);
          const ready = L.reduced || now - L.chainStart > 60 + (k * 6 + i) * Math.min(50, 900 / Math.max(cards.length, 1));
          if (clamp(st.o.x, 0, 1) > .6) st.seen = true;
          const x = spring(st.x, tp.x, dt, 62), y = spring(st.y, tp.y + (L.reduced ? 0 : Math.sin(t * .6 + i * .8 + k * 1.3) * 3), dt, 62);
          const s = spring(st.s, tp.s, dt, 62), o = spring(st.o, st.seen || ready ? (tp.dim ? .62 : 1) : 0, dt, 40);
          const el = aItemRefs.current[k]?.[i];
          const sc = clamp(s, .2, 1);
          if (el) { el.style.transformOrigin = 'top left'; el.style.transform = `translate3d(${x}px,${y}px,0) scale(${sc})`; el.style.opacity = clamp(o, 0, 1); el.style.pointerEvents = clamp(o, 0, 1) > .6 ? '' : 'none'; }
          if (tp.path && el) {
            feed = {x: x + el.offsetWidth * sc + 6, y: y + 15 * sc, o: clamp(o, 0, 1)};   // 文件触须源头=最深祖先列选中卡右缘（整组缩放后文件列仍在右侧，右缘出线不穿自家兄弟卡）
          }
          const p = aThreadRefs.current[k]?.[i];
          if (p && src) {
            const ey = y + 15 * sc, mx = (src.x + x) / 2;
            p.setAttribute('d', `M${src.x},${src.y} C${mx},${src.y} ${mx},${ey} ${x - 4},${ey}`);
            p.style.opacity = clamp(Math.min(o, src.o), 0, 1) * (tp.path ? .85 : .4);
            // 链线上的流动脉冲（与扇形触须同款）：水母→分类→内容 逐级接力，链路"活"起来
            const pc = aThreadPulseRefs.current[k]?.[i];
            if (pc) {
              const u = (t * .22 + i * .37 + k * .5) % 1;
              pc.setAttribute('cx', bez(src.x, mx, mx, x - 4, u));
              pc.setAttribute('cy', bez(src.y, src.y, ey, ey, u));
              pc.style.opacity = L.reduced || L.paused ? 0 : clamp(Math.min(o, src.o), 0, 1) * Math.sin(u * Math.PI) * (tp.path ? .9 : .35);
            }
          } else if (p) p.style.opacity = 0;
        });
      });
      // 选中模块 → 多篇笔记（触须式扇形展开）；kb 钻取时触须从最深祖先列的"钻入卡"右缘长出
      if (T.fan && sj?.label) {
        const narrow = L.size.w < 760;
        let ox2 = narrow ? sj.label.x + sj.label.w / 2 : sj.label.x + sj.label.w + 6, oy2 = narrow ? sj.label.y + sj.label.h + 4 : sj.cur.y;
        if (T.acols && feed && feed.o > .5) { ox2 = feed.x; oy2 = feed.y; }   // 钻取时触须从最深祖先列选中卡右缘长出（线条连接对应的文本框）
        items.forEach((n, i) => {
          const st = cardState(n.id, ox2, oy2, T.fan.scale || 1);
          // 触须一根一根依次长出（20 条约 1.8 秒），形成伞状开花的节奏；panY=滚轮平移量（长清单画布）。
          // 卡片重进当前列（ESC 回退/重访）时弹簧重置到源头重生——不是从旧位置平移拉过去，始终是"生出下一层"
          if (st.role !== 'cur') { st.x = sp(ox2); st.y = sp(oy2); st.s = sp(T.fan.scale || 1); st.o = sp(0); st.seen = false; }
          st.role = 'cur'; touched.add(n.id);
          const ready = L.reduced || now - L.fanStart > 160 + i * Math.min(90, 1800 / Math.max(items.length, 1));
          if (clamp(st.o.x, 0, 1) > .6) st.seen = true;
          const grow = st.seen || ready;
          const pan = L.panY || 0;
          const tx = T.fan.x, ty = T.fan.y0 + i * T.fan.gap - pan + (L.reduced ? 0 : Math.sin(t * .8 + i * .9) * 2);
          const x = spring(st.x, grow ? tx : ox2, dt, 70), y = spring(st.y, grow ? ty : oy2, dt, 70), o = spring(st.o, grow ? 1 : 0, dt, 50);
          const sc = clamp(spring(st.s, T.fan.scale || 1, dt, 62), .3, 1);   // 笔记模式整组缩放时文件卡同步缩
          const el = itemRefs.current[i];
          if (el) { el.style.transformOrigin = 'top left'; el.style.transform = `translate3d(${x}px,${y - 15}px,0) scale(${sc})`; el.style.opacity = clamp(o, 0, 1); }
          const p = fanRefs.current[i];
          if (p) {
            const dx = x - ox2, sway = L.reduced ? 0 : Math.sin(t * 1.1 + i * .7) * 7;
            const c1x = ox2 + dx * .5, c1y = oy2 + sway, c2x = x - dx * .45, c2y = y - sway * .5;
            p.setAttribute('d', `M${ox2},${oy2} C${c1x},${c1y} ${c2x},${c2y} ${x},${y}`);
            const on = sel === n.id;
            p.style.opacity = clamp(o, 0, 1) * (sel ? (on ? 1 : .35) : .8);
            p.style.strokeWidth = on ? 1.8 : 1;
            (fanPulseRefs.current[i] || []).forEach((c, k) => {
              if (!c) return;
              let u = (t * (k ? .27 : .36) + i * .13 + k * .5) % 1;
              if (k) u = 1 - u;
              c.setAttribute('cx', bez(ox2, c1x, c2x, x, u)); c.setAttribute('cy', bez(oy2, c1y, c2y, y, u));
              c.style.opacity = L.reduced || L.paused ? 0 : clamp(o, 0, 1) * Math.sin(u * Math.PI) * (sel && !on ? .3 : 1);
            });
          }
        });
      }
      // 本帧没渲染到的卡片置 off（离开当前列/祖先列），下次再进当前列时从源头重生
      for (const [id, st] of vis) if (!touched.has(id)) st.role = 'off';
      // 光球与水母的视频画面
      for (const pair of Object.values(vids.current)) paintVideo(pair);
    };
    // 每帧先排好下一帧再执行：某一帧出错也不会让光球和水母停住
    let warned = false;
    const frame = now => { raf = requestAnimationFrame(frame); try { step(now); } catch (err) { if (!warned) { warned = true; console.error(err); } } };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [items, live, sel]);

  // 暂停时一并暂停视频
  useEffect(() => {
    const sync = () => document.querySelectorAll('.scene video').forEach(v => { if (live.current.paused || live.current.reduced || document.hidden) v.pause(); else v.play().catch(() => {}); });
    live.current.syncVideo = sync; sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [live]);

  const hub = live.current.stage === 'hub';
  // 静态兜底位置：渲染帧（rAF）冻结时（如窗口被遮挡）各元素也按最终布局可见可点，正常时 rAF 接管动画
  const t0 = targets(live.current, 0);
  return <div className={`scene stage-${live.current.stage}`} ref={sceneRef}>
    <div className="orb clickable" ref={orbRef} role="button" tabIndex={-1} aria-label="回到星图主页" title="回到星图主页"
      onClick={() => onHome()} onPointerEnter={() => { live.current.hover = 'core'; }} onPointerLeave={() => { live.current.hover = null; }}>
      <div className="orb-halo"/>
      <video className="vsrc" ref={vidRef('orb', 'video')} src={T.media.orb} poster={T.media.orbPoster} muted loop playsInline autoPlay preload="auto"/>
      <canvas className="vid" ref={vidRef('orb', 'canvas')}/>
      <canvas className="orb-dust" ref={dustRef} width="1012" height="1012"/>
    </div>
    <svg className="threads" aria-hidden="true">
      <defs>
        <filter id="thread-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.2"/></filter>
        <radialGradient id="pulse-out"><stop offset="0" stopColor={T.pulse.out[0]}/><stop offset=".4" stopColor={T.pulse.out[1]}/><stop offset="1" stopColor={T.pulse.out[1]} stopOpacity="0"/></radialGradient>
        <radialGradient id="pulse-in"><stop offset="0" stopColor={T.pulse.in[0]}/><stop offset=".4" stopColor={T.pulse.in[1]}/><stop offset="1" stopColor={T.pulse.in[1]} stopOpacity="0"/></radialGradient>
      </defs>
      {MODULES.map(m => <g key={m.id} style={{color: MOD_STYLE[m.id].color}}>
        <path ref={el => { threadRefs.current[m.id] = {...threadRefs.current[m.id], glow: el}; }} className="thread-glow" filter="url(#thread-blur)"/>
        <path ref={el => { threadRefs.current[m.id] = {...threadRefs.current[m.id], core: el}; }} className="thread-core"/>
        {[0, 1, 2].map(k => <circle key={k} r={k === 2 ? 4.5 : 5.5} fill={`url(#${k === 2 ? 'pulse-in' : 'pulse-out'})`} ref={el => { (pulseRefs.current[m.id] ||= [])[k] = el; }}/>)}
      </g>)}
      {(t0.acols ? ancLevels || [] : []).map((lvl, k) => lvl.map((n, i) => <g key={'at' + k + n.id}>
        <path className="chain-thread dim" ref={el => { (aThreadRefs.current[k] ||= [])[i] = el; }}/>
        <circle r="4" fill="url(#pulse-out)" ref={el => { (aThreadPulseRefs.current[k] ||= [])[i] = el; }}/>
      </g>))}
      {items.map((n, i) => <g key={n.id} style={{color: KINDS[n.kind].color}}>
        <path className="fan-thread" ref={el => { fanRefs.current[i] = el; }}/>
        {[0, 1].map(k => <circle key={k} r={k ? 3.5 : 4.5} fill={`url(#${k ? 'pulse-in' : 'pulse-out'})`} ref={el => { (fanPulseRefs.current[i] ||= [])[k] = el; }}/>)}
      </g>)}
    </svg>
    {MODULES.map(m => {
      const sum = summaries[m.id], active = live.current.mod === m.id;
      return <React.Fragment key={m.id}>
        <button className={`jelly ${active ? 'active' : ''}`} ref={el => { jellyRefs.current[m.id] = el; }} onClick={() => onModule(m.id)}
          onPointerEnter={() => { live.current.hover = m.kind; }} onPointerLeave={() => { live.current.hover = null; }}
          aria-label={`${m.title} ${m.en}，${sum.count} 条`}>
          <div className="jelly-inner" ref={el => { innerRefs.current[m.id] = el; }} style={{filter: MOD_STYLE[m.id].filter}}>
            <video className="vsrc" ref={vidRef(m.id, 'video')} src={T.media.jelly} poster={T.media.jellyPoster} muted loop playsInline autoPlay preload="auto"
              onLoadedMetadata={e => { e.currentTarget.currentTime = (MODULES.indexOf(m) * 1.37) % 6; }}/>
            <canvas className="vid" ref={vidRef(m.id, 'canvas')}/>
          </div>
        </button>
        <button className={`jelly-label ${active ? 'active' : ''} ${hub ? 'below' : 'side'}`} ref={el => { labelRefs.current[m.id] = el; }} onClick={() => onModule(m.id)} tabIndex={-1}
          onPointerEnter={() => { live.current.hover = m.kind; }} onPointerLeave={() => { live.current.hover = null; }} style={{'--mod': MOD_STYLE[m.id].color}}>
          <span className="jl-icon"><Icon name={m.icon} size={14}/></span>
          <span className="jl-count">{sum.count}</span>
          <span className="jl-name">{m.title}<em>{m.en}</em></span>
          <span className="jl-sub">{sum.sub[0]} {sum.sub[1]} <em>{sum.sub[2]}</em></span>
        </button>
      </React.Fragment>;
    })}
    {(t0.acols || []).map((col, k) => col.map((tp, i) => {
      // 祖先列卡片（水母列语法）：选中卡放大居中当主角，兄弟卡缩小排上下；点击任意卡切回该层
      const n = (ancLevels || [])[k]?.[i];
      if (!n || !tp) return null;
      const meta = itemMeta(n), bd = nodeBadge(n);
      return <button key={n.id} className={`fan-item mini${tp.path ? ' active' : ''}`} ref={el => { (aItemRefs.current[k] ||= [])[i] = el; }}
        onClick={() => onItem(n)} style={{'--kc': KINDS[n.kind].color, transform: `translate3d(${tp.x}px,${tp.y}px,0) scale(${tp.s})`, transformOrigin: 'top left', opacity: tp.dim ? .62 : .9}}
        aria-label={`${n.title}${n.count != null ? '，' + n.count + ' 篇' : ''}`}>
        <span className="fi-dot"/>
        <span className="fi-body">
          <span className="fi-title">{n.short || n.title}</span>
          <span className="fi-meta">{meta.map(([kk, en, v], j) => <span key={j} className={kk === '↔' ? 'mutual' : ''}>{kk}{en && <em>{en}</em>} {v !== '' && <b>{v}</b>}</span>)}</span>
        </span>
        {bd && <span className="fi-badge" style={{'--b': bd.color}}>{bd.text}</span>}
      </button>;
    }))}
    {items.map((n, i) => {
      const meta = itemMeta(n), fp = t0.fan, bd = nodeBadge(n);
      return <button key={n.id} className={`fan-item ${sel === n.id ? 'active' : ''} kind-${n.kind}`} ref={el => { itemRefs.current[i] = el; }} onClick={() => onItem(n)} style={{'--kc': KINDS[n.kind].color, transform: `translate3d(${fp.x}px,${fp.y0 + i * fp.gap - 15}px,0) scale(${fp.scale || 1})`, transformOrigin: 'top left'}} aria-label={`打开 ${n.title} 的分析`}>
        <span className="fi-dot"/>
        <span className="fi-body">
          <span className="fi-title">{n.short || n.title}</span>
          <span className="fi-meta">{meta.map(([k, en, v], j) => <span key={j} className={k === '↔' ? 'mutual' : ''}>{k}{en && <em>{en}</em>} {v !== '' && <b>{v}</b>}</span>)}</span>
        </span>
        {n.kind === 'task' && bd ? (
          // 状态徽章悬停后按"下一层连线"语法展开：五条发光触须各自连出一张状态小卡，
          // 右向弧形张开（-24°~+24°），不与上下任务卡重叠；卡片本身是 button，内部用 span role=button 防嵌套
          <span className="st-swap" onClick={e => e.stopPropagation()}>
            <span className="fi-badge" style={{'--b': bd.color}}>{bd.text}</span>
            {TASK_OPS.map(([zh, target, op], k) => {
              const cur = n.task?.status === target;
              const ang = -24 + k * 12;                       // -24° ~ +24° 扇形张开
              const rad = ang * Math.PI / 180;
              const len = 54 + Math.abs(k - 2) * 4;           // 中间稍短，弧顶收拢
              const ex = Math.round(Math.cos(rad) * len), ey = Math.round(Math.sin(rad) * len);
              const fire = () => { if (!cur) onAction({type: 'taskOp', id: n.task?.id, op}); };
              return <React.Fragment key={target}>
                <span className="st-line" style={{'--b': ST_COLOR[target], '--ang': rad + 'rad', '--len': len + 'px', '--d': k}}/>
                <span role="button" tabIndex={cur ? -1 : 0} aria-disabled={cur}
                  className={`st-node${cur ? ' cur' : ''}`} style={{'--b': ST_COLOR[target], '--d': k, left: `calc(100% + ${ex - 4}px)`, top: `calc(50% + ${ey}px)`}}
                  onClick={ev => { ev.stopPropagation(); fire(); }}
                  onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); fire(); } }}>
                  {cur ? '✓ ' : ''}{zh}
                </span>
              </React.Fragment>;
            })}
          </span>
        ) : bd && <span className="fi-badge" style={{'--b': bd.color}}>{bd.text}</span>}
      </button>;
    })}
  </div>;
}

function Dock({graph, onGo}) {
  const s = useMemo(() => stats(graph), [graph]);
  const [q, setQ] = useState('');
  const [cards, setCards] = useState(null);
  const [asking, setAsking] = useState(false);   // 输入框聚焦：壁纸模式输入法挂不上，提示改走窗口输入
  const typing = useRef(null);
  const ask = text => { if (text.trim()) setCards({q: text, list: askGraph(graph, text)}); };
  const typeAsk = text => {
    clearInterval(typing.current);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setQ(text); ask(text); return; }
    let i = 0; setQ('');
    typing.current = setInterval(() => { i++; setQ(text.slice(0, i)); if (i >= text.length) { clearInterval(typing.current); setTimeout(() => ask(text), 220); } }, 45);
  };
  useEffect(() => () => clearInterval(typing.current), []);
  const kpis = [['内容节点', 'Notes', s.content], ['连接', 'Links', s.links], ['双向共振', 'Mutual', s.mutual], ['未创建', 'Unresolved', s.ghosts]];
  return <div className="dock">
    {cards && <section className="ask-results glass" aria-live="polite">
      <header><span><Icon name="spark" size={14}/>图谱分析 <em>Graph analysis</em></span><small>本地规则检索 · Local rules, no AI</small><button className="icon-btn" aria-label="关闭分析" onClick={() => setCards(null)}><Icon name="close" size={14}/></button></header>
      <div className="ask-cards">{cards.list.map((c, i) => <article key={i} className={`ask-card tone-${c.tone}`} style={{animationDelay: i * 90 + 'ms'}}>
        <h4>{c.title} <em>{c.en}</em></h4>
        <p>{c.text}</p>
        {c.items?.length > 0 && <div className="chip-row">{c.items.slice(0, 8).map((id, k) => <button key={id} className="chip" style={{'--kc': KINDS[graph.index.get(id)?.kind]?.color}} onClick={() => onGo(id)}>{c.names[k]}{c.meta?.[k] && <small>{c.meta[k]}</small>}</button>)}</div>}
        {c.pairs && <div className="pair-list">{c.pairs.map(([a, b, why], k) => <button key={k} onClick={() => onGo(a)}><span>{graph.index.get(a)?.short}</span><i>⇄</i><span>{graph.index.get(b)?.short}</span><small>{why}</small></button>)}</div>}
      </article>)}</div>
    </section>}
    <div className="dock-panel glass">
      <div className="dock-kpis">{kpis.map(([k, en, v]) => <div key={k}><span>{k} <em>{en}</em></span><strong>{v}</strong></div>)}</div>
      <form className="ask" onSubmit={e => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={e => setQ(e.target.value)} onFocus={() => { setAsking(true); wvFocus(); }} onBlur={() => { setAsking(false); wvBlur(); }} placeholder="问问你的生态图谱… Ask your graph" aria-label="向图谱提问"/>
        <button className="send" aria-label="提交问题"><Icon name="send" size={16}/></button>
      </form>
      {asking && <div className="ask-hint">
        <span><Icon name="info" size={12}/>壁纸模式打不了中文（输入法进不去）——英文数字可用，或点选下方问题</span>
        <button type="button" onClick={() => window.open('http://127.0.0.1:5173/', '_blank')}>在窗口中打开<Icon name="outlink" size={11}/></button>
      </div>}
      <div className="dock-chips">
        <span className="me"><Icon name="agent" size={13}/>我的图谱 <em>My graph</em></span>
        {['未结任务有哪些？', '待拍板', '服务健康', '最核心的内容', '记忆池', '未创建的笔记'].map(x => <button key={x} onClick={() => typeAsk(x)}>{x}</button>)}
      </div>
    </div>
  </div>;
}

export function Home({graph, layout, focus, setFocus, onAction, onAbout, reduced, ecoEvents = []}) {
  const stageRef = useRef(null);
  const [size, setSize] = useState({w: 1280, h: 760});
  const [paused, setPaused] = useState(false);
  const [panned, setPanned] = useState(false);   // 用户滚过一次后隐藏平移提示（提示用完即走）
  const {mod, zone, sel} = focus;
  const stage = sel ? 'note' : mod ? 'module' : 'hub';
  const items = useMemo(() => moduleItems(graph, mod, mod === 'kb' || mod === 'services' || mod === 'tasks' ? (zone || '') : undefined), [graph, mod, zone]);
  // 层级卡链：按 zone 的真实目录层级逐级展开（任意深度），每张卡篇数 = 该层子树全部笔记数；
  // 旧层缩小靠上保留（完整层名+篇数），点击直接回退到该层
  const zoneChain = useMemo(() => {
    if ((mod !== 'kb' && mod !== 'services' && mod !== 'tasks') || !zone) return null;
    if (mod === 'tasks') {
      // 任务流链：→ 分类（待办/今日完成/累计完成）→ 累计完成下再按时间窗（1天/3天/一周/一月/所有）
      const T = graph.nodes.filter(x => x.kind === 'task');
      const today = new Date().toISOString().slice(0, 10);
      const done = T.filter(x => x.task?.status === 'done');
      const parts = zone.split('/');
      const doneMs = x => Date.parse(String(x.task?.done_at || '').replace(' ', 'T')) || 0;
      const winCnt = d => done.filter(x => Date.now() - doneMs(x) <= d * 864e5).length;
      if (parts[0] === '累计完成' && parts.length > 1) {
        const d = {'最近1天': 1, '最近3天': 3, '最近一周': 7, '最近一月': 30}[parts[1]];
        return [
          {name: '任务流', zone: null, n: T.length - done.length},
          {name: '累计完成', zone: '累计完成', n: done.length},
          {name: parts[1], zone, n: d ? winCnt(d) : done.length}
        ];
      }
      const n = zone === '待办' ? T.length - done.length
        : zone === '今日完成' ? done.filter(x => String(x.task?.done_at || '').slice(0, 10) === today).length
        : done.length;
      return [
        {name: '任务流', zone: null, n: T.length - done.length},
        {name: zone, zone, n}
      ];
    }
    if (mod === 'services') {
      // 服务舱两级链：服务舱 → 分类（核心服务/常驻工作者），计数=服务本体（含离线）
      const S = graph.nodes.filter(x => x.kind === 'service');
      const grp = zone === '核心服务' ? 'core' : 'worker';
      return [
        {name: '服务舱', zone: null, n: S.length},
        {name: zone, zone, n: S.filter(x => x.service?.group === grp).length}
      ];
    }
    const parts = zone.split('/');
    const zoneNotes = graph.nodes.filter(x => x.kind === 'note' && x.folder === 'f:kb:' + parts[0]);
    const chain = [
      {name: '知识库', zone: null, n: graph.nodes.filter(x => x.kind === 'note').length},
      {name: parts[0], zone: parts[0], n: zoneNotes.length}
    ];
    let sub = '';
    for (let i = 1; i < parts.length; i++) {
      sub = sub ? sub + '/' + parts[i] : parts[i];              // subzone 相对分区，不含分区段
      const pref = sub + '/';
      chain.push({name: parts[i], zone: parts.slice(0, i + 1).join('/'),
        n: zoneNotes.filter(x => { const s = x.subzone || ''; return s === sub || s.startsWith(pref); }).length});
    }
    return chain;
  }, [graph, mod, zone]);
  // 画布层级链：完整各级（含"知识库"首级）；笔记选中（note 阶段）保持挂载，由 rAF 淡出而非瞬间卸载
  const zonePath = zoneChain || null;
  // 祖先列清单：钻取路径上每一层的内容（k=0=分区卡列，…），与当前列一起层层递进；
  // 每列的"钻入卡"= 下一层的 zone（高亮 + 喂养下一列触须）
  const ancLevels = useMemo(() => {
    if ((mod !== 'kb' && mod !== 'services' && mod !== 'tasks') || !zoneChain) return [];
    const out = [];
    for (let k = 0; k < zoneChain.length - 1; k++) out.push(moduleItems(graph, mod, zoneChain[k].zone));
    return out;
  }, [graph, mod, zoneChain]);
  const live = useRef(null);
  if (!live.current) {
    const now = performance.now();
    live.current = {t0: now, time: 0, stage, mod, items, size, reduced, paused: false, hover: null, fanStart: now,
      chainStart: 0, zonePath: null, vis: new Map(), orb: {x: 640, y: 380, s: 400},
      springs: {dust: sp(.3), orb: {x: sp(size.w / 2), y: sp(size.h / 2), s: sp(120), o: sp(0)}, jelly: Object.fromEntries(MODULES.map(m => [m.id, {x: sp(size.w / 2), y: sp(size.h / 2), s: sp(20), o: sp(0), lo: sp(0)}]))}};
    let seen = false;
    try { seen = !!sessionStorage.getItem('neural-intro-seen'); } catch {}
    live.current.introSeen = reduced || seen;
    if (live.current.introSeen) live.current.t0 = now - 6000;
  }
  Object.assign(live.current, {stage, mod, items, size, reduced, paused, zonePath, ancLevels});
  useLayoutEffect(() => {
    const el = stageRef.current;
    const measure = () => {
      const w = el.clientWidth, h = el.clientHeight, L = live.current, S = L.springs;
      // 开场刚开始时把光球和水母的起点放到真实中心（默认尺寸的中心在大屏上偏左上，开场会像从旁边飞进来）
      if (L.stage === 'hub' && performance.now() - L.t0 < 300) {
        const o = targets({...L, size: {w, h}}, 0).orb;
        Object.assign(S.orb, {x: sp(o.x), y: sp(o.y)});
        for (const m of MODULES) Object.assign(S.jelly[m.id], {x: sp(o.x), y: sp(o.y)});
        L.orb = {...L.orb, x: o.x, y: o.y};
      }
      setSize({w, h});
    };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { try { sessionStorage.setItem('neural-intro-seen', '1'); } catch {} }, []);
  useEffect(() => { live.current.syncVideo?.(); }, [paused]);
  // 换层时清单平移归零（重新从顶部看起），平移提示也复位；递进列的入场节奏重新计时
  // （卡片弹簧状态按 id 存在 vis Map 里不重置——钻深/回退时旧列原地缩小/放大，位置连续）
  useEffect(() => { live.current.panY = 0; setPanned(false); live.current.chainStart = performance.now(); }, [mod, zone, live]);
  // 滚轮 = 平移长清单画布（module/note 视图且内容超出视口时）。
  // 页面失焦/后台时渲染管线冻结（rAF、ResizeObserver 回调都不送达），挂载瞬间的陈旧尺寸会一直留着；
  // 所以这里同步补测 clientWidth/Height 并按需重算 panMax（targets 是纯函数），滚轮路径不依赖渲染帧。
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = e => {
      const L = live.current;
      // 信息栏（最右详情块）/弹窗/搜索结果内部是原生滚动区：事件落在里面就放行，不劫持成平移
      if (e.target?.closest?.('.analysis-wrap, .veil, .ask-results')) return;
      const w = el.clientWidth, h = el.clientHeight;
      if (w && (L.size.w !== w || L.size.h !== h)) { L.size = {w, h}; setSize({w, h}); }
      if (L.stage === 'hub') return;   // module 和 note（笔记开着）都允许滚轮平移清单——否则点开一篇后长清单被锁死没法选其他篇
      const panMax = targets(L, 0).fan?.panMax || 0;
      if (!panMax) return;
      e.preventDefault();
      L.panY = clamp((L.panY || 0) + e.deltaY, 0, panMax);
      if (e.deltaY > 0) setPanned(true);
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    // 触屏单指拖动 = 平移长清单（触控板双指=滚轮走上面；信息栏内同样放行原生滚动）
    let touchPt = null;
    const onTouchMove = e => {
      const L = live.current;
      if (e.touches.length !== 1 || e.target?.closest?.('.analysis-wrap, .veil, .ask-results')) { touchPt = null; return; }
      const t = e.touches[0];
      if (touchPt && L.stage !== 'hub') {
        const panMax = targets(L, 0).fan?.panMax || 0;
        if (panMax) { e.preventDefault(); L.panY = clamp((L.panY || 0) + (touchPt.y - t.clientY), 0, panMax); setPanned(true); }
      }
      touchPt = {x: t.clientX, y: t.clientY};
    };
    const onTouchEnd = () => { touchPt = null; };
    el.addEventListener('touchmove', onTouchMove, {passive: false});
    el.addEventListener('touchend', onTouchEnd);
    // 记录光标位置：键盘上下键按光标悬停区域路由（信息栏=滚面板/画布=平移清单）。
    // 鼠标按住拖拽平移已按用户要求移除（劫持 mousedown 干扰点击与下拉交互），平移走滚轮、键盘、触屏单指。
    const onMouseMove = e => { live.current.cursor = {x: e.clientX, y: e.clientY}; };
    window.addEventListener('mousemove', onMouseMove);
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('touchmove', onTouchMove); el.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('mousemove', onMouseMove); };
  }, []);
  useEffect(() => {
    const key = e => {
      if (e.isComposing || document.querySelector('.veil')) return;
      // 键盘平移长清单（壁纸模式 Lively 转发键盘后即可用；焦点在桌面才转发，不影响别处打字）
      if (e.key !== 'Escape') {
        const L = live.current;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
        if (document.activeElement?.tagName === 'BUTTON' && (e.key === ' ' || e.key.startsWith('Arrow'))) return;   // 焦点在卡上时方向键留给无障碍导航
        // 光标悬在信息栏上时，上下键滚面板本身（与滚轮/拖拽同款路由），否则平移清单
        const cur = L.cursor;
        const panelEl = cur && document.elementFromPoint(cur.x, cur.y)?.closest?.('.analysis-wrap');
        if (panelEl) {
          const sc = panelEl.querySelector('.an-scroll');
          const pstep = {ArrowDown: 120, PageDown: 400, ArrowUp: -120, PageUp: -400}[e.key] || 0;
          if (sc && pstep) { e.preventDefault(); sc.scrollTop += pstep; return; }
        }
        if (L.stage === 'hub') return;
        const panMax = targets(L, 0).fan?.panMax || 0;
        if (!panMax) return;
        const step = {ArrowDown: 120, PageDown: 400, ArrowUp: -120, PageUp: -400}[e.key] || 0;
        if (step) { e.preventDefault(); L.panY = clamp((L.panY || 0) + step, 0, panMax); setPanned(true); return; }
        if (e.key === 'Home') { e.preventDefault(); L.panY = 0; return; }
        if (e.key === 'End') { e.preventDefault(); L.panY = panMax; setPanned(true); }
        return;
      }
      if (sel) setFocus({mod, zone, sel: null});
      else if (zone) setFocus(zone.includes('/') ? {mod, zone: zone.split('/').slice(0, -1).join('/') || null} : {mod, zone: null});
      else if (mod) setFocus({mod: null, sel: null});
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [mod, zone, sel, setFocus]);

  const go = useCallback(id => {
    const n = graph.index.get(id), m = moduleOf(n);
    if (!m) return;
    // 落到笔记真实所在的目录层（分区 + 完整子路径），层卡链与面包屑随之完整展开
    // 落到内容真实所在层：笔记=KB 目录层；已完成任务=累计完成层（跳转/搜索点过来不迷路）
    const z = n.kind === 'note' && String(n.folder || '').startsWith('f:kb:')
      ? [n.folder.slice(5), n.subzone].filter(Boolean).join('/') || null
      : n.kind === 'task' && n.task?.status === 'done' ? '累计完成' : null;
    setFocus({mod: m.id, zone: m.id === 'kb' || m.id === 'tasks' ? z : null, sel: id});
  }, [graph, setFocus]);
  const replay = () => {
    const L = live.current, now = performance.now();
    L.t0 = now; L.time = 0;
    const S = L.springs;
    S.orb.s.x = 120; S.orb.o.x = 0;
    for (const m of MODULES) Object.assign(S.jelly[m.id], {x: sp(L.orb.x), y: sp(L.orb.y), s: sp(20), o: sp(0), lo: sp(0)});
    setFocus({mod: null, sel: null});
  };
  const node = sel ? graph.index.get(sel) : null;
  const m = MODULES.find(x => x.id === mod);
  const s = stats(graph);

  return <section ref={stageRef} className={`home-stage stage-${stage} ${live.current.introSeen ? 'intro-done' : ''}`} aria-label="创作神经图谱">
    <div className="stage-bg"/>
    <NetworkCanvas graph={graph} layout={layout} live={live} reduced={reduced}/>
    <Scene graph={graph} items={stage === 'hub' ? [] : items} sel={sel} live={live} zonePath={zonePath} ancLevels={ancLevels} zone={zone}
      onAction={onAction} onHome={() => setFocus({mod: null, sel: null})}
      onModule={id => setFocus({mod: id === mod && stage !== 'hub' ? mod : id, zone: null, sel: null})} onItem={n => {
      if (n.kind === 'folder' && (mod === 'kb' || mod === 'services' || mod === 'tasks')) {   // 分区/子目录/服务与任务分类卡：按卡上的完整路径往里钻一层
        setFocus({mod, zone: n.path, sel: null});
      } else if (n.kind !== 'ghost') {
        setFocus({mod, zone, sel: n.id});
      }
    }}/>

    <div className="hub-copy" aria-hidden={stage !== 'hub'}>
      <p className="eyebrow">{CONFIG.brand.name} · {CONFIG.brand.sub} <span>{CONFIG.brand.tagline}</span></p>
      <h1>人间有味是清欢。</h1>
      <p className="hub-en">My ecosystem, rendered live.</p>
      <p className="hub-meta">{MODULES.length} 个模块 <em>modules</em> · {s.content} 条内容 <em>notes</em> · {s.links} 条连接 <em>links</em></p>
      <p className="hub-hint">点击水母，展开模块 · <em>Tap a jellyfish to expand</em></p>
    </div>

    {stage !== 'hub' && <nav className="crumbs" aria-label="图谱路径">
      <button className="crumb-back" onClick={() => setFocus(sel ? {mod, zone, sel: null} : zone ? (zone.includes('/') ? {mod, zone: zone.split('/').slice(0, -1).join('/') || null} : {mod, zone: null}) : {mod: null, sel: null})} aria-label="返回上一层"><Icon name="back" size={16}/></button>
      <button onClick={() => setFocus({mod: null, sel: null})}>创作空间 <em>Core</em></button>
      <span>/</span>
      <button onClick={() => setFocus({mod, zone: null, sel: null})} style={{color: MOD_STYLE[mod].color}}>{m.title} <em>{m.en}</em></button>
      {zone && <><span>/</span>
        {zone.split('/').map((seg, i) => {
          const z = zone.split('/').slice(0, i + 1).join('/');
          return <React.Fragment key={z}>{i > 0 && <span>/</span>}
            <button onClick={() => setFocus({mod, zone: z, sel: null})}>{seg}</button>
          </React.Fragment>;
        })}</>}
      {node && <><span>/</span><b>{node.short || node.title}</b></>}
    </nav>}

    <div className="stage-tools glass" role="toolbar" aria-label="动画控制">
      <button onClick={replay} title="重播开场 Replay"><Icon name="replay" size={15}/><span>重播 <em>Replay</em></span></button>
      <button onClick={() => setPaused(!paused)} title={paused ? '继续 Resume' : '暂停 Pause'} aria-pressed={paused}><Icon name={paused ? 'play' : 'pause'} size={15}/><span>{paused ? '继续' : '暂停'} <em>{paused ? 'Resume' : 'Pause'}</em></span></button>
      <button onClick={onAbout} title="关于图谱 About"><Icon name="info" size={15}/><span>数据来源 <em>Sources</em></span></button>
    </div>

    {stage === 'hub' && <div className="legend glass" aria-label="图例">
      <h3>图例 <em>Legend</em></h3>
      {['task', 'note', 'decision', 'memory', 'service', 'tag', 'ghost'].map(k => <div key={k}><i style={{'--kc': KINDS[k].color}} className={k === 'ghost' ? 'ghost' : ''}/>{KINDS[k].label} <em>{KINDS[k].en}</em><b>{graph.nodes.filter(n => n.kind === k).length}</b></div>)}
      <div className="legend-lines"><span><i className="ln mutual"/>双向 <em>Mutual</em></span><span><i className="ln one"/>单向 <em>One-way</em></span></div>
    </div>}
    {stage === 'hub' && <Dock graph={graph} onGo={go}/>}
    {/* 流水：hub=左上文案下方起（红框位置），一路垂到屏幕底填满左侧；模块/笔记=选中水母正下方一点起。
        层级在光球场景之下（文字不压光球），底部渐隐虚无。 */}
    <EcoStream events={ecoEvents} top={stage === 'hub'
      ? Math.round(Math.max(360, size.h * .3))
      : Math.round(size.h * .53 + 96)}/>
    {/* 宽屏 kb 钻取时层级轨迹已由画布上的横排胶囊承担，这里只在窄屏显示，避免两套面包屑重复 */}
    {zoneChain && stage === 'module' && size.w < 760 && <div className="zone-trail" aria-label="层级轨迹">
      {zoneChain.map((c, i) => (
        <React.Fragment key={c.zone || 'root'}>
          {i > 0 && <span className="zt-arrow">›</span>}
          <button className={`zt-card${i === zoneChain.length - 1 ? ' cur' : ''}`}
            onClick={() => setFocus({mod, zone: c.zone, sel: null})}>
            <b>{c.name}</b><em>{c.n} 篇</em>
          </button>
        </React.Fragment>
      ))}
    </div>}
    {stage === 'module' && !panned && (targets(live.current, 0).fan?.panMax || 0) > 0 && <div className="pan-hint" aria-hidden="true">▼ 滚轮往下平移清单 <em>{items.length} 条</em></div>}

    {stage === 'module' && <p className="module-hint">{mod === 'kb' && !zone ? '选择一个分区进入' : mod === 'services' && !zone ? '选择一个分类进入服务舱' : mod === 'tasks' && !zone ? '选择一个分类进入任务流' : mod === 'kb' ? '点目录进入下一层 · 点笔记查看全部分析' : '选择一篇笔记查看全部分析'} · <em>Select to explore</em></p>}

    {node && <aside className="analysis-wrap" key={sel}>
      <Analysis graph={graph} node={node} module={m} onGo={go} onAction={onAction} onClose={() => setFocus({mod, zone, sel: null})}/>
    </aside>}
  </section>;
}
