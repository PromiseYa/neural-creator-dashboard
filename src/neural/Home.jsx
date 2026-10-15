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

// 任务状态快捷切换：悬停徽章 → 其余四张状态小卡在右侧垂直依次弹出（当前状态不重复展示，徽章已经是它）；
// 连线与"层别触须"同款：贝塞尔曲线 + 沿线流动的光点。鼠标移开 2 秒后收起（有空隙可穿行），悬停期间锁定不消失。
class TaskStatusFan extends React.Component {
  constructor(props) {
    super(props);
    this.state = {mounted: false, open: false};   // mounted=open 期间才挂 SVG/节点，283 张卡不留闲置动画
    this.timer = null; this.untimer = null;
  }
  componentWillUnmount() { clearTimeout(this.timer); clearTimeout(this.untimer); }
  enter = () => {
    clearTimeout(this.timer); clearTimeout(this.untimer);
    if (!this.state.mounted) this.setState({mounted: true}, () => requestAnimationFrame(() => this.setState({open: true})));
    else this.setState({open: true});
  };
  leave = () => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.setState({open: false});
      this.untimer = setTimeout(() => this.setState({mounted: false}), 450);
    }, 1000);
  };
  render() {
    const {badge, task, onAction} = this.props;
    const ops = TASK_OPS.filter(([, target]) => task?.status !== target);   // 当前状态不进扇形（徽章已展示）
    const dx = 58;
    return <span className={`st-swap${this.state.open ? ' open' : ''}`} onClick={e => e.stopPropagation()} onPointerEnter={this.enter} onPointerLeave={this.leave}>
      <span className="fi-badge" style={{'--b': badge.color}}>{badge.text}</span>
      {this.state.mounted && <svg className="st-svg" viewBox="-2 -60 72 120" aria-hidden="true">
        {ops.map(([, target], k) => {
          const dy = (k - (ops.length - 1) / 2) * 28;                   // 四张卡垂直居中排开
          const d = `M2 0 C${dx * .55} 0 ${dx * .55} ${dy} ${dx - 8} ${dy}`;   // 与层别触须同款 S 形曲线
          return <React.Fragment key={target}>
            <path className="st-line" style={{'--b': ST_COLOR[target], '--d': k}} d={d}/>
            <circle className="st-pulse" style={{'--b': ST_COLOR[target]}} r="2.8">
              <animateMotion dur="2.4s" begin={`${k * .35}s`} repeatCount="indefinite" path={d}/>
            </circle>
          </React.Fragment>;
        })}
      </svg>}
      {ops.map(([zh, target, op], k) => {
        const dy = (k - (ops.length - 1) / 2) * 28;
        return <span role="button" tabIndex={0} key={target}
          className="st-node" style={{'--b': ST_COLOR[target], '--d': k, left: `calc(100% + ${dx - 6}px)`, top: `calc(50% + ${dy}px)`}}
          onClick={ev => { ev.stopPropagation(); onAction({type: 'taskOp', id: task?.id, op}); }}
          onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); onAction({type: 'taskOp', id: task?.id, op}); } }}>
          {zh}
        </span>;
      })}
    </span>;
  }
}

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
    <h3>生态流水 <em>Stream</em> · <b>{events.length} 条动态</b></h3>
    <div className="eco-list">
      {events.map(e => (
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
  // 服务舱平铺（用户令 10-15：不再分类）：核心服务在前、常驻工作者在后，一级直接显示全部服务卡。
  // 有 url 的服务（工作站/老面板）卡上带可打开链接；worker 数据源暂无地址字段，后续补 url 即自动显示。
  if (m.kind === 'service') {
    const all = graph.nodes.filter(n => n.kind === 'service');
    return [...all.filter(n => n.service?.group === 'core'), ...all.filter(n => n.service?.group === 'worker')];
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
    case 'task': {
      // 截止日上卡：超期=警报红、≤3 天临期=高亮金、更远=中性（done 不再显示）——待办清单扫一眼即知轻重缓急
      const meta = [[PRIO_ZH[n.task?.priority] || n.task?.priority || '—', '', '']];
      const due = n.task?.due;
      if (due && n.task?.status !== 'done') {
        const dd = Math.ceil((new Date(String(due).slice(0, 10) + 'T23:59:59') - Date.now()) / 864e5);
        meta.push(dd < 0 ? ['超期', '', `${-dd} 天`, 'due-over']
          : dd === 0 ? ['截止', '', '今天', 'due-soon']
          : dd <= 3 ? ['截止', '', `${dd} 天`, 'due-soon']
          : ['截止', '', String(due).slice(5), 'due-ok']);
      }
      meta.push(['↔', '', d.both]);
      return meta;
    }
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
    // 自由游弋（宽屏 hub）：摆脱"钉在椭圆上小幅摆动"——每只水母带独立速度慢速漫游，
    // 方向随机掉头（不会一直一个方向）、屏幕边界反弹、成对相撞互换法向速度弹开；
    // 头与触手随移动方向倾倒，被光标吸引时头转向光标（atan2(dx,-dy)：光标正上方=0°不歪头）
    const dt = Math.min(L.dt || 0, .05);
    const RM = L.roam || (L.roam = {});
    const base = MODULES.map((m, i) => {
      const a = (m.angle + swim * 10 * Math.sin(t * .22 + i * 1.7)) * Math.PI / 180;
      const rr = 1 + swim * .07 * Math.sin(t * .3 + i);
      return {x: W / 2 + Math.cos(a) * rx * rr, y: cy + Math.sin(a) * ry * rr};
    });
    const js = MODULES.map((m, i) => {
      const rm = RM[m.id] || (RM[m.id] = {x: 0, y: 0, vx: 4, vy: 0, ang: Math.random() * 6.28, spd: 6, turnAt: 0, targetAng: 0, targetSpd: 7});
      if (swim) {
        if (t >= rm.turnAt) { rm.turnAt = t + 4.5 + Math.random() * 6.5; rm.targetAng = Math.random() * Math.PI * 2; rm.targetSpd = 2.2 + Math.random() * 5; }   // 随机掉头（整体放缓：目标速度上限 13→7.2，转向间隔拉长）
        let da = rm.targetAng - rm.ang; da = Math.atan2(Math.sin(da), Math.cos(da));
        rm.ang += clamp(da, -.75 * dt, .75 * dt);   // 受限角速度=转弯更柔（1.1→0.75）
        rm.spd += (rm.targetSpd - rm.spd) * Math.min(1, dt * .5);
        rm.vx += (Math.cos(rm.ang) * rm.spd - rm.vx) * Math.min(1, dt * .8);
        rm.vy += (Math.sin(rm.ang) * rm.spd * .4 - rm.vy) * Math.min(1, dt * .8);
        rm.x += rm.vx * dt; rm.y += rm.vy * dt;
        const dHome = Math.hypot(rm.x, rm.y);   // 远超 600px 才有极弱归心（防集体漂到一侧，平时感知不到）
        if (dHome > 600) { rm.x -= rm.x / dHome * (dHome - 600) * dt * .5; rm.y -= rm.y / dHome * (dHome - 600) * dt * .5; }
      }
      return {rm, bx: base[i].x, by: base[i].y};
    });
    js.forEach(({rm, bx, by}) => {   // 边界反弹（按绝对位置）
      const ax = bx + rm.x, ay = by + rm.y;
      if (ax < 100) { rm.x = 100 - bx; rm.vx = Math.abs(rm.vx); rm.ang = Math.PI - rm.ang; }
      if (ax > W - 100) { rm.x = W - 100 - bx; rm.vx = -Math.abs(rm.vx); rm.ang = Math.PI - rm.ang; }
      if (ay < 90) { rm.y = 90 - by; rm.vy = Math.abs(rm.vy); rm.ang = -rm.ang; }
      if (ay > H - 90) { rm.y = H - 90 - by; rm.vy = -Math.abs(rm.vy); rm.ang = -rm.ang; }
    });
    for (let i = 0; i < js.length; i++) for (let k = i + 1; k < js.length; k++) {   // 成对相撞：互换法向速度+位置各退一半重叠
      const A = js[i], B = js[k];
      const dx = (A.bx + A.rm.x) - (B.bx + B.rm.x), dy = (A.by + A.rm.y) - (B.by + B.rm.y);
      const d = Math.hypot(dx, dy), minD = 150;
      if (d > 0.01 && d < minD) {
        const nx = dx / d, ny = dy / d, push = (minD - d) / 2;
        A.rm.x += nx * push; A.rm.y += ny * push; B.rm.x -= nx * push; B.rm.y -= ny * push;
        const dv = (A.rm.vx - B.rm.vx) * nx + (A.rm.vy - B.rm.vy) * ny;
        if (dv < 0) {
          A.rm.vx -= nx * dv; A.rm.vy -= ny * dv; B.rm.vx += nx * dv; B.rm.vy += ny * dv;   // 仅相互接近时弹开
          // 轻碰也可见：分离速度不足 14px/s 时沿法线补足（真实水母相触后的缓慢推开）
          const dv2 = (A.rm.vx - B.rm.vx) * nx + (A.rm.vy - B.rm.vy) * ny;
          if (dv2 < 14) { const add = (14 - dv2) / 2; A.rm.vx += nx * add; A.rm.vy += ny * add; B.rm.vx -= nx * add; B.rm.vy -= ny * add; }
        }
      }
    }
    // 主神经（光球↔各水母的神经丝）也是实体：游进别的神经丝走廊=被碰到——沿法线弹出+速度反射，
    // 并把漫游目标角刷新到反弹方向（否则转向加速度会立刻把它压回神经丝上反复蹭线）；
    // 自己的神经丝终点在自己身上，跳过。神经丝画的是微弯贝塞尔，直线段近似误差 ≤13px 在碰撞阈值内
    const ocx = W / 2, ocy = cy, jsz = narrow ? 92 : clamp(W * .12, 120, 184);
    const abs = js.map(({rm, bx, by}) => [bx + rm.x, by + rm.y]);
    for (let i = 0; i < js.length; i++) {
      const rm = js[i].rm;
      for (let k = 0; k < js.length; k++) {
        if (k === i) continue;
        const ex = abs[k][0] - ocx, ey = abs[k][1] - ocy, elen = Math.hypot(ex, ey) || 1;
        const ux = ex / elen, uy = ey / elen;
        const proj = clamp((abs[i][0] - ocx) * ux + (abs[i][1] - ocy) * uy, 0, elen);   // 线上最近点（含两端）
        const px = ocx + ux * proj, py = ocy + uy * proj;
        const dx = abs[i][0] - px, dy = abs[i][1] - py, d = Math.hypot(dx, dy), minD = jsz * .72 + 30;
        if (d > 0.01 && d < minD) {
          const nx = dx / d, ny = dy / d, push = minD - d;
          rm.x += nx * push; rm.y += ny * push; abs[i][0] += nx * push; abs[i][1] += ny * push;
          const vn = rm.vx * nx + rm.vy * ny;
          if (vn < 0) { const vAbs = Math.max(9, -vn); rm.vx += nx * (vAbs + vn); rm.vy += ny * (vAbs + vn); rm.ang = Math.atan2(rm.vy, rm.vx); rm.targetAng = rm.ang + (Math.random() - .5) * .8; rm.turnAt = t + 2 + Math.random() * 3; }   // 轻擦神经丝也有可见反弹（法向反射速度保底 9px/s）
        }
      }
    }
    MODULES.forEach((m, i) => {
      const {rm, bx, by} = js[i];
      // 左右摆动严格对称 + 姿态随移动方向动态倾倒；惯性余波（脱钩后 calmT 窗口内摆幅渐大渐收）
      const swayAmp = 5 + Math.min(3, Math.abs(rm.vx) * .3) + (rm.calmT && t < rm.calmT ? 5 * (rm.calmT - t) / 2.2 : 0);
      const velTilt = clamp(rm.vx * .9, -11, 11);
      const jj = {x: bx + rm.x, y: by + rm.y + swim * 14 * Math.sin(t * .8 + i * 2.1), s: narrow ? 92 : clamp(W * .12, 120, 184), o: 1,
        tilt: swim * (swayAmp * Math.sin(t * 1.35 + i * 1.3) + velTilt), pull: 0};
      // 鼠标交互（用户令 10-15 四轮）：外圈渐进吸附（越近越强、循序渐进）、内层提起跟随；
      // 拖动脱钩后沿拖动方向漫游；拖动位置出屏/压进别的神经走廊=反弹脱钩（内层 s*.5 进、外圈 150 出迟滞）
      if (L.smx != null) {
        const adx = L.smx - jj.x, ady = L.smy - jj.y, add = Math.hypot(adx, ady);
        if (!rm.att && add < jj.s * .5) { rm.att = true; rm.ax = null; rm.ay = null; }
        if (rm.att) {
          const detach = (nx, ny) => {   // 脱钩：位置写回漫游坐标；反弹=给定法线初速，自然脱钩=拖动惯性延续（卸力飘逸）
            rm.att = false; rm.ax = null; rm.ay = null;
            rm.x = jj.x - bx; rm.y = jj.y - by;
            const mvSpd = Math.hypot(L.mvx || 0, L.mvy || 0);
            if (nx != null) { const bs = 26; rm.vx = nx * bs; rm.vy = ny * bs * .8; }
            else if (mvSpd > 40) {
              // 惯性初速=拖动速度延续（8~55px/s），targetSpd 低+turnAt 长保持=先飘逸后缓收（卸力感）
              const dr = Math.min(55, Math.max(8, mvSpd * .02));
              rm.ang = Math.atan2(L.mvy, L.mvx); rm.vx = Math.cos(rm.ang) * dr; rm.vy = Math.sin(rm.ang) * dr * .45;
              rm.spd = dr; rm.targetSpd = 3;
            }
            else { rm.vx = (L.mvx || 0) * .012; rm.vy = (L.mvy || 0) * .012; }
            rm.ang = Math.atan2(rm.vy, rm.vx); rm.targetAng = rm.ang; rm.turnAt = t + 2.6;
            rm.calmT = t + 2.2;   // 惯性余波窗口：脱钩后摆幅渐大渐收（触手甩回的余韵）
            jj.x = bx + rm.x; jj.y = by + rm.y;
          };
          if (add > 150) detach(null, null);   // 拉出感应圈：带惯性卸力，沿拖动方向飘逸漫游
          else {
            const k = Math.min(1, (L.dt || 0) * 3.2);
            rm.ax = rm.ax == null ? jj.x : rm.ax + (L.smx - rm.ax) * k;
            rm.ay = rm.ay == null ? jj.y : rm.ay + (L.smy - rm.ay) * k;
            // 头顶抓取（用户令五轮）：鼠标抓的是水母头，身体/触手垂在拖动方向后方——拖拽感；
            // 静止悬停时头朝上（视频原生方向），中心垂在鼠标下方
            const mSp = Math.hypot(L.mvx || 0, L.mvy || 0);
            const dxn = mSp > 26 ? (L.mvx || 0) / mSp : 0, dyn = mSp > 26 ? (L.mvy || 0) / mSp : -1;
            jj.x = rm.ax - dxn * jj.s * .33;
            jj.y = rm.ay - dyn * jj.s * .33;
            jj.pull = Math.max(jj.pull, .55); jj.s *= 1.05; jj.att = true;
            // 硬约束（用户令）：不出屏幕、不压别的神经丝走廊——碰到即反弹脱钩回漫游
            const PAD = 92;
            let bn = null;
            if (jj.x < PAD) bn = [1, 0]; else if (jj.x > W - PAD) bn = [-1, 0];
            else if (jj.y < PAD - 10) bn = [0, 1]; else if (jj.y > H - PAD + 10) bn = [0, -1];
            if (!bn) for (let k2 = 0; k2 < abs.length; k2++) {
              if (k2 === i) continue;
              const ex = abs[k2][0] - ocx, ey = abs[k2][1] - ocy, el2 = Math.hypot(ex, ey) || 1;
              const ux = ex / el2, uy = ey / el2;
              const proj = clamp((jj.x - ocx) * ux + (jj.y - ocy) * uy, 0, el2);
              const ddx = jj.x - (ocx + ux * proj), ddy = jj.y - (ocy + uy * proj), dd2 = Math.hypot(ddx, ddy);
              if (dd2 < jsz * .72 + 30 && dd2 > .01) { bn = [ddx / dd2, ddy / dd2]; break; }   // 靠近走廊边缘即反弹（用户令六轮：提前量 .48+12 → .72+30）
            }
            if (bn) detach(bn[0], bn[1]);
          }
        } else if (add < 150 && add > 2) { const u = 1 - add / 150; const f = Math.pow(u, 1.8) * 60; jj.x += adx / add * f; jj.y += ady / add * f; jj.s *= 1 - u * .2; jj.pull = u; }
      } else rm.att = false;
      jj.tilt = clamp(jj.tilt, -26, 26);
      res.jelly[m.id] = jj;
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
      // 第二形态（点击水母进模块后，用户令）：摆动/漂浮幅度降到 25%——"不能乱动"；零均值对称摆
      const F2 = .25;
      const jj = {x: colX + (sel ? 16 : 0) + swim * 12 * Math.sin(t * .26 + i * 1.7) * F2, y: cy + (k - 2) * gap + swim * 9 * Math.sin(t * .9 + i * 2) * F2, s: sel ? 128 : 92, o: sel ? 1 : .6,
        tilt: (swim * 3 * Math.sin(t * .6 + i) + swim * 4 * Math.cos(t * .26 + i * 1.7)) * F2, pull: 0};
      res.jelly[m.id] = jj;
    });
    // 伞状条目以右侧分析栏为基准排在它左边约 90px 处（条目最宽约 270px），触须拉长、画面左右均衡；
    // 模块层和打开笔记后位置相同，右侧栏滑入时伞不跳动。
    // 长清单不压缩间距：固定间距往下排，超出视口的部分用滚轮平移（panY），像一张往下无限延伸的画布。
    const panelLeft = W - clamp(W * .30, 360, 440) - 44;
    const n = L.items.length;
    // 清单垂直间距自适应（用户令 10-15：最后一层内容默认居中放置）：短清单保持 80px 节奏，
    // 长清单（如服务舱 13 项）压缩到 42~80px 让整列垂直居中进一屏——不再从顶部起排靠滚轮找
    const fgap = clamp((H - 300) / Math.max(n - 1, 1), 42, 80);
    const selOpen = L.stage === 'note';
    // kb 目录钻取（宽屏）：每一层完整复刻"水母层"语法——选中卡调换到中间放大当该列主角（同选中水母居中），
    // 同层兄弟卡保持原尺寸、变暗排在上下（同未选水母 o=.6；深列放不下才缩），下一层在右侧下一个槽位
    // 按原尺寸完整展开（同点知识库后生出的那层）；连线=上一列选中卡右缘→下一层各卡，逐列接棒。
    // 打开笔记时：整个构图（光球+水母列+祖先列+文件列）作为同一刚体向左平移+整体缩小给详情页让位——
    // 结构原样、无人消失、无重排，ESC 原样放大还原。
    const zchain = L.zonePath || [];
    const zdRaw = zchain.length > 1 ? zchain.length - 1 : 0;   // kb 与 services 都走层级链（zonePath 只有这两个模块有值）
    const zd = Math.min(zdRaw, 2);
    // 列间距 240：卡宽 160+触须空隙——间距不足时上一列卡片右缘压到下一列起点，
    // 触须被迫向左折回交织（核心服务→工作站那层"线条扭在一起"的根源）。
    // 水母层→首列与其他层同节奏：标签移到水母正下方（不占连线路径），触须从伞体右缘+6px 出发，
    // 伞体右缘 → 首列 = 80px（76 线）——不再隔着一个 132~176px 宽的标签（旧观感总间距 ~286px）。
    // 锚点用当帧水母真实位置（含游弋漂移）——列跟水母同组微漂，线长恒定
    const sjx = L.mod && res.jelly[L.mod] ? res.jelly[L.mod] : null;
    const bodyRight = (sjx ? sjx.x : colX + 16) + (sjx ? sjx.s : 128) * .5;
    const fanBase = Math.min(bodyRight + 80, panelLeft - 280);
    const SX = [fanBase, fanBase + 240, fanBase + 480];
    const fit = !zd || SX[zd] + 300 <= W - 20;   // 300=内容卡实际最宽(~310 含徽章)，层级整体离屏右缘留 20px 呼吸
    const span = Math.max(0, n - 1) * fgap;
    // 清单顶部只让位顶栏（水母已置顶压在内容上，清单可延伸到水母下方——居中优先）
    let x = fanBase, y0 = Math.max(cy - span / 2, 90), fg2 = fgap, fsc = 1;
    res.acols = null;
    if (zd && fit) {
      x = SX[zd];
      res.acols = (L.ancLevels || []).slice(0, zd).map((cards, k) => {
        const pz = zchain[k + 1]?.zone;
        const pi = Math.max(0, cards.findIndex(c => c.path === pz));
        const pos = new Array(cards.length);
        const nSib = cards.length - 1;
        const sg = 80;   // 祖先列兄弟卡与当前列同款统一间距
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
        const AX = 125, g = Math.min(1, (panelLeft - 36 - AX) / (SX[zd] - AX + 250));   // 250=笔记态卡宽上限(标题160+徽章)，层级整体与详情栏恒留 36px 不压栏
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
  const ripRefs = useRef({}), sparkRefs = useRef({}), gravRef = useRef(null);   // 引力可见化：水波纹/吸入光丝/光标视界环
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
      L.dt = dt;   // 供水母自由游弋物理积分（targets 内使用）
      if (!L.paused) L.time += dt;
      const t = L.time, since = (now - L.t0) / 1000;
      // 鼠标吸引的缓速跟随点（用户令 10-15 升级）：前置预测追逐 + 速度自适应——
      // 鼠标速度指数平滑后沿速度方向领先一个时距（上限 90px，快移预测多、慢移趋零），
      // 跟随系数随速度放大（快→跟得紧，慢→绵柔丝滑），从公式上消除"追不上"与"过冲弹跳"
      if (L.mx == null) { L.smx = null; L.mvx = 0; L.mvy = 0; }
      else if (L.smx == null) { L.smx = L.mx; L.smy = L.my; L.pmx = L.mx; L.pmy = L.my; L.mvx = 0; L.mvy = 0; }
      else {
        const idt = Math.max(dt, .001);
        const sm = Math.min(1, dt * 9);
        L.mvx = (L.mvx || 0) + ((L.mx - (L.pmx ?? L.mx)) / idt - (L.mvx || 0)) * sm;
        L.mvy = (L.mvy || 0) + ((L.my - (L.pmy ?? L.my)) / idt - (L.mvy || 0)) * sm;
        L.pmx = L.mx; L.pmy = L.my;
        const spd = Math.hypot(L.mvx, L.mvy);
        const lead = Math.min(90, Math.sqrt(spd) * 2.3);
        const px = L.mx + (spd > 1 ? L.mvx / spd * lead : 0), py = L.my + (spd > 1 ? L.mvy / spd * lead : 0);
        const e = Math.min(1, dt * (1.5 + 2.5 * Math.min(1, spd / 1400)));
        L.smx += (px - L.smx) * e; L.smy += (py - L.smy) * e;
      }
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
        // 随机闪烁（生命感）：各自错峰的 1.1s 正弦脉冲，间隔 4~11s 随机；无障碍减弱动效时关闭
        const FL = L.flash || (L.flash = {});
        let fl = FL[m.id];
        if (!fl) fl = FL[m.id] = {until: 0, next: t + 2 + Math.random() * 6};
        if (!L.reduced && t >= fl.next) { fl.until = t + 1.1; fl.next = t + 4 + Math.random() * 7; }
        const fv0 = !L.reduced && t < fl.until ? Math.sin((1 - (fl.until - t) / 1.1) * Math.PI) : 0;
        // 吸积增亮：光标逼近（黑洞视界）时水母自体光亮抬升——先被点亮再被吞入
        let fv = fv0;
        if (!L.reduced && L.smx != null) { const ddx = L.smx - x, ddy = L.smy - y; const dd = Math.hypot(ddx, ddy); if (dd < 150) fv = Math.max(fv, (1 - dd / 150) * .6); }
        if (el) el.style.setProperty('--fl', fv.toFixed(3));
        // 头转向（灵动弹簧）：被拖动时头朝拖动方向、触手在后跟随（全角度+最短路径旋转，用户令四轮）；
        // 平时朝向光标（±38° 内），弹簧带轻微过冲=脉冲式转向的活物感
        const hyS = j.hyS || (j.hyS = {x: 0, v: 0});
        const mSpd = Math.hypot(L.mvx || 0, L.mvy || 0);
        const dragging = tg.att && mSpd > 26;
        let yawT;
        if (dragging) {
          let yd = Math.atan2(L.mvy, L.mvx) * 180 / Math.PI + 90 - 8;   // +90=视频头朝上的补偿；-8=身体滞后微后仰（拖拽感）
          yawT = hyS.x + (((yd - hyS.x) % 360) + 540) % 360 - 180;  // 归一到最短旋转路径
        } else yawT = tg.pull ? clamp(Math.atan2(L.smx - x, -(L.smy - y)) * 180 / Math.PI, -38, 38) * Math.min(1, tg.pull * 1.4) : 0;
        const hy = spring(hyS, yawT, dt, 16);
        const tremor = tg.pull && !dragging ? 2.2 * Math.sin(t * 2.6 + i) * Math.min(1, tg.pull * 1.5) : 0;
        // 姿态角乘 flip 补偿镜像（kb/decisions/services 是 scaleX(-1) 水母）：保证群体倾倒同向、左右等幅
        const flipX = MOD_STYLE[m.id].flip;
        const rot = dragging ? (hy + tg.tilt * .4) * flipX : clamp((tg.tilt + hy + tremor) * flipX, -30, 30);
        if (inner) inner.style.transform = `rotate(${rot}deg) scaleX(${flipX}) scaleY(${L.stage === 'hub' ? 1 : .92})`;
        if (lab) {
          const lw = lab.offsetWidth, lh = lab.offsetHeight, ng = L.noteG || 1;
          const hub = L.stage === 'hub', narrow = L.size.w < 760;
          // 标签统一放水母正下方（hub 同款）：不占右侧连线路径，触须直接从伞体右缘出发
          const lx = x - lw / 2;
          const ly = y + s * .36;
          lab.style.transformOrigin = 'left center';
          lab.style.transform = `translate3d(${lx}px,${ly}px,0) scale(${ng})`;
          lab.style.opacity = clamp(narrow && !hub && m.id !== L.mod ? 0 : lo, 0, 1);
          j.label = {x: lx, y: ly, w: lw * ng, h: lh * ng};   // w/h 记缩放后的视觉宽
        }
        // —— 光标引力可见化：位移吸引在 targets 里已算好，这里按弹簧后的真实位置重算拉力强度，
        // 驱动三层特效——水母伞缘水波纹（拉得越强纹越密）、吸入光丝（光点漂向光标）、光标吸积环 ——
        let pu = 0;
        if (L.smx != null && !L.reduced) {
          const R = 150;
          const gdx = L.smx - x, gdy = L.smy - y, gdd = Math.hypot(gdx, gdy);
          if (gdd < R && gdd > 2) pu = 1 - gdd / R;
        }
        j.pu = pu;
        // 空闲零开销：无拉力且无在途动画时整段跳过（不写任何 DOM）——帧预算全留给水母本体；
        // 波纹周期 2.2s 慢扩散（用户令"再慢一点"），拉力越强发得越密
        const rips = ripRefs.current[m.id] || [];
        const spks = sparkRefs.current[m.id] || [];
        const ripLive = c => c && c._t && t - c._t < 3.5;
        const sparkLive = c => c && c._t && t - c._t < 1.15;
        if (pu > .02 || rips.some(ripLive) || spks.some(sparkLive)) {
          if (pu > .02 && t >= (j.ripNext || 0)) {
            j.ripNext = t + Math.max(.5, 1 - pu * .55);
            const rc = rips.find(c => !ripLive(c));
            if (rc) rc._t = t;
          }
          // 波浪线水纹（用户令 10-15）：圆形涟漪改为边缘带正弦起伏的波浪环，
          // 相位缓慢滚动、扩散周期 3.4s、峰值透明度调柔——水面波纹感而非声呐圈
          rips.forEach((c, ri) => {
            if (!c) return;
            const ph = t - (c._t || -9) > 0 ? Math.min(1, (t - c._t) / 3.4) : 1;
            const on = c._t && ph < 1 && pu > .02;
            if (!on) { if (c.style.opacity !== '0') c.style.opacity = 0; return; }
            const rr = s * .34 + s * .82 * (1 - Math.pow(1 - ph, 2.4));
            const amp = 2.5 + 4.5 * Math.sin(Math.min(1, ph * 1.25) * Math.PI);   // 振幅先增后衰
            const roll = t * .9 + ri * 2.1;
            let d = '';
            for (let k = 0; k <= 48; k++) {
              const a = k / 48 * Math.PI * 2;
              const r2 = rr + Math.sin(a * 5 + roll) * amp;
              d += (k ? 'L' : 'M') + (x + Math.cos(a) * r2).toFixed(1) + ',' + (y + Math.sin(a) * r2 * .92).toFixed(1);
            }
            c.setAttribute('d', d + 'Z');
            c.style.opacity = (1 - ph) * .34 * Math.min(1, pu * 3.5);
          });
          spks.forEach((c, k) => {
            if (!c) return;
            if (!c._t || t - c._t > 1.1) {
              if (pu > .12) { c._t = t + .12 + k * .5 + Math.random() * .3; c._a = Math.random() * Math.PI * 2; }
              else { c.style.opacity = 0; return; }
            }
            const ph = (t - c._t) / 1.05;
            if (ph < 0) { c.style.opacity = 0; return; }
            const e = ph * ph * (3 - 2 * ph);   // smoothstep：先缓后急，被"吸进去"
            const rim = s * .4, sa = c._a || 0;
            const sx0 = x + Math.cos(sa) * rim, sy0 = y + Math.sin(sa) * rim;
            const cx0 = (sx0 + L.mx) / 2 + Math.sin(sa + 1.7) * 24, cy0 = (sy0 + L.my) / 2 + Math.cos(sa + 1.2) * 24;
            c.setAttribute('cx', bez(sx0, cx0, cx0, L.mx, e));
            c.setAttribute('cy', bez(sy0, cy0, cy0, L.my, e));
            c.style.opacity = pu > .04 ? Math.sin(Math.min(1, ph) * Math.PI) * .8 : 0;
          });
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
            let u = ((t * (inbound ? .45 : .55) + k * .5 + i * .17) % 1);   // 提速一圈 1.8~2.2s（用户令：光路不能像卡住）
            if (inbound) u = 1 - u;
            c.setAttribute('cx', bez(x1, c1x, c2x, x2, u)); c.setAttribute('cy', bez(y1, c1y, c2y, y2, u));
            c.style.opacity = L.reduced || L.paused ? 0 : vis * Math.sin(u * Math.PI);
          });
        }
      });
      // 光标=黑洞视界：低通跟随点上的吸积双环+暗核，靠近任何水母时淡入（引力场可见）；
      // 同款空闲零开销——不可见且淡出完毕后不再写 DOM
      const gv = gravRef.current;
      if (gv) {
        let best = 0;
        MODULES.forEach(mm => { best = Math.max(best, S.jelly[mm.id].pu || 0); });
        const target = L.smx != null && !L.reduced ? clamp((best - .04) * 3, 0, 1) : 0;
        const cur = gv._op == null ? 0 : gv._op;
        if (target > 0 || cur > .004) {
          gv._op = Math.max(target, cur - dt * 1.4);   // 淡入直接跟、淡出走平滑
          gv.style.opacity = gv._op.toFixed(3);
          gv.style.transform = `translate3d(${L.mx || 0}px,${L.my || 0}px,0)`;   // 零延迟直跟鼠标（用户令：黑洞不能有延迟），平滑只给水母跟随点
          const r1 = gv.children[0], r2 = gv.children[1];
          if (r1) r1.style.strokeDashoffset = -((t * 26) % 43);
          if (r2) r2.style.strokeDashoffset = (t * 17) % 27;
        }
      }
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
      let feed = sj?.cur ? {x: sj.cur.x + sj.cur.s * .5 + 6, y: sj.cur.y, o: 1} : null;   // 当前列的喂养源=伞体右缘：一路接棒到最深祖先列的选中卡
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
            const csw = L.reduced ? 0 : Math.sin(t * .7 + i * .9 + k * 1.3) * 5;   // 链线同款慢漂浮（端点钉死、只摆中段）
            p.setAttribute('d', `M${src.x},${src.y} C${mx},${src.y + csw} ${mx},${ey - csw} ${x + 2},${ey}`);   // 终点插入卡内 2px，接住卡首圆点
            p.style.opacity = clamp(Math.min(o, src.o), 0, 1) * (tp.path ? .85 : .4);
            // 链线上的流动脉冲（与扇形触须同款）：水母→分类→内容 逐级接力，链路"活"起来
            const pc = aThreadPulseRefs.current[k]?.[i];
            if (pc) {
              const u = (t * .22 + i * .37 + k * .5) % 1;
              pc.setAttribute('cx', bez(src.x, mx, mx, x - 4, u));
              pc.setAttribute('cy', bez(src.y, src.y + csw, ey - csw, ey, u));
              pc.style.opacity = L.reduced || L.paused ? 0 : clamp(Math.min(o, src.o), 0, 1) * Math.sin(u * Math.PI) * (tp.path ? .9 : .35);
            }
          } else if (p) p.style.opacity = 0;
        });
      });
      // 选中模块 → 多篇笔记（触须式扇形展开）；kb 钻取时触须从最深祖先列的"钻入卡"右缘长出
      if (T.fan && sj?.label) {
        const narrow = L.size.w < 760;
        let ox2 = narrow ? sj.label.x + sj.label.w / 2 : sj.cur.x + sj.cur.s * .5 + 6, oy2 = narrow ? sj.label.y + sj.label.h + 4 : sj.cur.y;
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
            const dx = x - ox2, sway = L.reduced ? 0 : Math.sin(t * .9 + i * .7) * 9 + Math.sin(t * .47 + i * 1.9) * 4;   // 双频纵摆=活物感
            const c1x = ox2 + dx * .5 + (L.reduced ? 0 : Math.sin(t * .6 + i) * 6), c1y = oy2 + sway, c2x = x - dx * .45, c2y = y - sway * .5;
            p.setAttribute('d', `M${ox2},${oy2} C${c1x},${c1y} ${c2x},${c2y} ${x + 2},${y}`);   // 终点插入卡内，接住卡首圆点
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
      // 光球与水母的视频画面；水母第二形态（module/note）游动速度减半——视觉上"安静下来的水母"
      for (const [vid, pair] of Object.entries(vids.current)) {
        if (pair.video) pair.video.playbackRate = vid === 'orb' ? 1 : (L.stage === 'hub' ? 1 : .5);
        paintVideo(pair);
      }
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
  return <>
    <div className={`scene stage-${live.current.stage}`} ref={sceneRef}>
    <div className="orb clickable" ref={orbRef} role="button" tabIndex={-1} aria-label="回到星图主页"
      onClick={() => onHome()} onPointerEnter={() => { live.current.hover = 'core'; }} onPointerLeave={() => { live.current.hover = null; }}>
      <div className="orb-halo"/>
      <video className="vsrc" ref={vidRef('orb', 'video')} src={T.media.orb} poster={T.media.orbPoster} muted loop playsInline autoPlay preload="auto"/>
      <canvas className="vid" ref={vidRef('orb', 'canvas')}/>
      <canvas className="orb-dust" ref={dustRef} width="1012" height="1012"/>
    </div>
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
          <span className="fi-meta">{meta.map(([kk, en, v, cls], j) => <span key={j} className={cls || (kk === '↔' ? 'mutual' : '')}>{kk}{en && <em>{en}</em>} {v !== '' && <b>{v}</b>}</span>)}</span>
        </span>
        {bd && <span className="fi-badge" style={{'--b': bd.color}}>{bd.text}</span>}
      </button>;
    }))}
    {items.map((n, i) => {
      const meta = itemMeta(n), fp = t0.fan, bd = nodeBadge(n);
      // folder 性质的卡（分区/分类/子目录/时间窗）当前列也定宽 160——与祖先列同宽：
      // 卡宽跨层恒定（钻取前后不跳变），列距 240=160 卡+80 线的节奏对所有模块成立
      // （自适应宽时任务流卡仅 ~100px、服务舱 ~209px，线后空隙 40~140px 忽长忽短）
      return <button key={n.id} className={`fan-item ${n.kind === 'folder' ? 'mini ' : ''}${sel === n.id ? 'active' : ''} kind-${n.kind}`} ref={el => { itemRefs.current[i] = el; }} onClick={() => onItem(n)} style={{'--kc': KINDS[n.kind].color, transform: `translate3d(${fp.x}px,${fp.y0 + i * fp.gap - 15}px,0) scale(${fp.scale || 1})`, transformOrigin: 'top left'}} aria-label={`打开 ${n.title} 的分析`}>
        <span className="fi-dot"/>
        <span className="fi-body">
          <span className="fi-title">{n.short || n.title}</span>
          <span className="fi-meta">{meta.map(([k, en, v, cls], j) => <span key={j} className={cls || (k === '↔' ? 'mutual' : '')}>{k}{en && <em>{en}</em>} {v !== '' && <b>{v}</b>}</span>)}</span>
        </span>
        {n.kind === 'task' && bd ? <TaskStatusFan badge={bd} task={n.task} onAction={onAction}/>
          : <>{n.service?.url && <span className="fi-link" role="link" tabIndex={-1} title={n.service.url}
              onClick={e => { e.stopPropagation(); window.open(n.service.url, '_blank'); }}>打开 ↗</span>}
            {bd && <span className="fi-badge" style={{'--b': bd.color}}>{bd.text}</span>}</>}
      </button>;
    })}
    </div>
    {/* 水母独立顶层（用户令 10-15 三轮）：.scene 是 z-index:2 的层叠上下文，水母困在里面永远被
        z=8 的面板压住——移出 scene 放进 jelly-layer(z=20)，真正压过搜索框/图例/详情栏等一切内容。
        坐标系同 scene（absolute inset 0），rAF 写 transform 的逻辑不变；含静态兜底位（rAF 冻结保底可见） */}
    <div className="jelly-layer">
      {/* 线条随水母同层置顶（用户令 10-15 四轮）：神经丝/脉冲/波纹/触须不再被面板压住 */}
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
          {[0, 1, 2].map(k => <path key={'rip' + k} className="jelly-rip" ref={el => { (ripRefs.current[m.id] ||= [])[k] = el; }}/>)}
          {[0, 1].map(k => <circle key={'spk' + k} className="jelly-spark" r="2.2" ref={el => { (sparkRefs.current[m.id] ||= [])[k] = el; }}/>)}
        </g>)}
        <g className="grav" ref={gravRef} aria-hidden="true">
          <circle className="grav-ring" r="30"/>
          <circle className="grav-ring2" r="21"/>
          <circle className="grav-core" r="8"/>
        </g>
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
        const j0 = t0.jelly[m.id] || {x: 100, y: 100, s: 92, o: 1};
        return <React.Fragment key={m.id}>
          <button className={`jelly ${active ? 'active' : ''}`} ref={el => { jellyRefs.current[m.id] = el; }} onClick={() => onModule(m.id)}
            onPointerEnter={() => { live.current.hover = m.kind; }} onPointerLeave={() => { live.current.hover = null; }}
            style={{'--mod': MOD_STYLE[m.id].color, transform: `translate3d(${j0.x - j0.s / 2}px,${j0.y - j0.s * .375}px,0) scale(${j0.s / 200})`, opacity: j0.o}}
            aria-label={`${m.title} ${m.en}，${sum.count} 条`}>
            <div className="jelly-inner" ref={el => { innerRefs.current[m.id] = el; }} style={{filter: MOD_STYLE[m.id].filter}}>
              <video className="vsrc" ref={vidRef(m.id, 'video')} src={T.media.jelly} poster={T.media.jellyPoster} muted loop playsInline autoPlay preload="auto"
                onLoadedMetadata={e => { e.currentTarget.currentTime = (MODULES.indexOf(m) * 1.37) % 6; }}/>
              <canvas className="vid" ref={vidRef(m.id, 'canvas')}/>
            </div>
          </button>
          <button className={`jelly-label ${active ? 'active' : ''} ${hub || live.current.size.w >= 760 ? 'below' : 'side'}`} ref={el => { labelRefs.current[m.id] = el; }} onClick={() => onModule(m.id)} tabIndex={-1}
            onPointerEnter={() => { live.current.hover = m.kind; }} onPointerLeave={() => { live.current.hover = null; }}
            style={{'--mod': MOD_STYLE[m.id].color, transform: `translate3d(${j0.x - 66}px,${j0.y + j0.s * .36}px,0)`, opacity: j0.o}}>
            <span className="jl-icon"><Icon name={m.icon} size={14}/></span>
            <span className="jl-count">{sum.count}</span>
            <span className="jl-name">{m.title}<em>{m.en}</em></span>
            <span className="jl-sub">{sum.sub[0]} {sum.sub[1]} <em>{sum.sub[2]}</em></span>
          </button>
        </React.Fragment>;
      })}
    </div>
    </>;
}

function Dock({graph, onGo}) {
  const s = useMemo(() => stats(graph), [graph]);
  const [q, setQ] = useState('');
  const [cards, setCards] = useState(null);
  const typing = useRef(null);
  const ask = text => { if (text.trim()) setCards({q: text, list: askGraph(graph, text)}); };
  const typeAsk = text => {
    clearInterval(typing.current);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setQ(text); ask(text); return; }
    let i = 0; setQ('');
    typing.current = setInterval(() => { i++; setQ(text.slice(0, i)); if (i >= text.length) { clearInterval(typing.current); setTimeout(() => ask(text), 220); } }, 45);
  };
  useEffect(() => () => clearInterval(typing.current), []);
  // 壁纸模式原生输入框（LivelyMod 提供，IME 中文可用）回填通道：提交=直接检索，失焦=关输入态
  useEffect(() => {
    window.__starNativeSubmit = text => { setQ(text); ask(text); };
    window.__starNativeBlur = () => document.querySelector('.ask input')?.blur();
    return () => { delete window.__starNativeSubmit; delete window.__starNativeBlur; };
  }, [graph]);
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
        <input value={q} onChange={e => setQ(e.target.value)} onFocus={e => wvFocus(e.target)} onBlur={() => wvBlur()} placeholder="问问你的生态图谱… Ask your graph" aria-label="向图谱提问"/>
        <button className="send" aria-label="提交问题"><Icon name="send" size={16}/></button>
      </form>
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
      // 服务舱单级链（平铺后无分类层）
      const S = graph.nodes.filter(x => x.kind === 'service');
      return [{name: '服务舱', zone: null, n: S.length}];
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
      // 信息栏（最右详情块）/弹窗/搜索结果/生态流水内部是原生滚动区：事件落在里面就放行，不劫持成平移
      if (e.target?.closest?.('.analysis-wrap, .veil, .ask-results, .ecostream')) return;
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
      if (e.touches.length !== 1 || e.target?.closest?.('.analysis-wrap, .veil, .ask-results, .ecostream')) { touchPt = null; return; }
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
    // 记录光标位置：键盘上下键按光标悬停区域路由（信息栏=滚面板/画布=平移清单）；
    // 同时记录场景内坐标（L.mx/my）供水母鼠标吸引使用，离开场景即清（水母游回原位）。
    // 鼠标按住拖拽平移已按用户要求移除（劫持 mousedown 干扰点击与下拉交互），平移走滚轮、键盘、触屏单指。
    let sceneRect = null;
    const onMouseMove = e => { const L = live.current; L.cursor = {x: e.clientX, y: e.clientY};
      if (!sceneRect) sceneRect = el.getBoundingClientRect();
      L.mx = e.clientX - sceneRect.left; L.my = e.clientY - sceneRect.top;
      // 流水显形判定：scene 层盖在流水上（z-index 2>1），CSS :hover 收不到——用坐标直接点亮 .lit
      const es = document.querySelector('.ecostream');
      if (es) { const r = es.getBoundingClientRect(); es.classList.toggle('lit', e.clientX >= r.left - 10 && e.clientX <= r.right + 10 && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8); } };
    const onSceneLeave = () => { live.current.mx = null; sceneRect = null; document.querySelector('.ecostream')?.classList.remove('lit'); };
    window.addEventListener('mousemove', onMouseMove);
    el.addEventListener('pointerleave', onSceneLeave);
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('touchmove', onTouchMove); el.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('mousemove', onMouseMove); el.removeEventListener('pointerleave', onSceneLeave); };
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
    // 落到内容真实所在层，层级链完整展开：水母 → 分类 → 清单 → 选中项（不再只停在水母+第一层）
    // 笔记=KB 分区+完整子路径；任务=所在清单（待办/今日完成/累计完成-所有）；服务=所在分类
    let z = null;
    if (n.kind === 'note' && String(n.folder || '').startsWith('f:kb:'))
      z = [n.folder.slice(5), n.subzone].filter(Boolean).join('/') || null;
    else if (n.kind === 'task') {
      const today = new Date().toISOString().slice(0, 10);
      z = n.task?.status !== 'done' ? '待办'
        : String(n.task?.done_at || '').slice(0, 10) === today ? '今日完成'
        : '累计完成/所有';
    }
    else if (n.kind === 'service')
      z = n.service?.group === 'worker' ? '常驻工作者' : '核心服务';
    setFocus({mod: m.id, zone: m.id === 'kb' || m.id === 'tasks' || m.id === 'services' ? z : null, sel: id});
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

  // 流水顶部：贴着左上提示行"点击水母，展开模块"的下方（实测其底缘+间距，随窗口缩放复量）
  const [streamTop, setStreamTop] = useState(360);
  useEffect(() => {
    const calc = () => {
      const h = document.querySelector('.hub-hint');
      if (h && h.getBoundingClientRect().bottom > 0) setStreamTop(Math.round(h.getBoundingClientRect().bottom + 14));
    };
    calc();
    const t = setTimeout(calc, 900);   // 首帧后标题/字体定稿再复量一次
    window.addEventListener('resize', calc);
    return () => { clearTimeout(t); window.removeEventListener('resize', calc); };
  }, []);

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
      <p className="hub-en">The truest flavor of life is its quiet joys.</p>
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
    {/* 流水：全视图固定左侧，顶部贴左上提示行下方；面板内可滚（滚轮/触屏，滚动条隐藏），底部渐隐 */}
    {/* 流水只在主页常驻：平时重度虚化隐入背景（突出神经网络动画），光标移上去才显形；
        点进模块后整体退场——把画面完全让给水母形态与层级动画（R43 用户拍板） */}
    {stage === 'hub' && <EcoStream events={ecoEvents} top={streamTop}/>}
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
