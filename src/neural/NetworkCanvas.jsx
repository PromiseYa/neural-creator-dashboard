import React, {useEffect, useRef} from 'react';
import {KINDS} from './graph';
import {T} from './theme';
import {glowSprite, orbSprite} from './sprites';

const P = T.canvas;
const ADD = P.additive ? 'lighter' : 'source-over';

// 背景神经网络：从光球蔓延出的全部笔记、话题与概念；双向连接以金色脉冲往返传递。
export function NetworkCanvas({graph, layout, live, reduced}) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current, ctx = canvas.getContext('2d');
    let raf, W = 0, H = 0, dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(canvas);

    // 按与创作空间的链接层数决定蔓延顺序。
    const depth = new Map([['core', 0]]), q = ['core'];
    while (q.length) {
      const id = q.shift();
      for (const l of graph.links) {
        const o = l.a === id ? l.b : l.b === id ? l.a : null;
        if (o && !depth.has(o)) { depth.set(o, depth.get(id) + 1); q.push(o); }
      }
    }
    // 节点过多时随机采样保上限（结构节点 folder/tag 全留，内容节点按稳定种子采样）——
    // 星云保持密度感又不至于节点数千时糊成一片；已完成任务不进背景星云（还原最初版观感）
    const allNodes = graph.nodes.filter(n => n.kind !== 'core' && !(n.kind === 'task' && n.task?.status === 'done'));
    const CAP = 400;
    const rnd = id => { let s = 0; for (const c of id) s = (s * 131 + c.charCodeAt(0)) >>> 0; return (s % 9973) / 9973; };
    const nodes = (allNodes.length > CAP
      ? allNodes.filter(n => n.kind === 'folder' || n.kind === 'tag' || rnd(n.id) < (CAP - allNodes.filter(x => x.kind === 'folder' || x.kind === 'tag').length) / allNodes.length)
      : allNodes)
      .map((n, i) => ({
      n, p: layout[n.id], d: depth.get(n.id) ?? 4, seed: (i * 9301 + 49297) % 233280 / 233280,
      r: n.kind === 'folder' ? 3.2 : n.kind === 'tag' ? 1.6 : n.kind === 'concept' ? 2.4 : n.kind === 'ghost' ? 2 : 2.2 + Math.min(n.deg, 14) * .22
    }));
    const byId = new Map(nodes.map(x => [x.n.id, x]));
    // 骨架化渲染：目录归属线（contain）只在布局里起作用，画布上不画——背景只留双链/话题脉络。
    const links = graph.links.filter(l => l.kind !== 'contain' && byId.has(l.a) && byId.has(l.b)).map((l, i) => ({l, A: byId.get(l.a), B: byId.get(l.b), seed: (i * 7919 % 997) / 997}));
    // 深层记忆链：每个目录锚点挑连接度最高的几个内容节点，平时淡画一条归属线——
    // 锚点背后还有"更深一层记忆体"的暗示（第二层信息光点），若隐若现不抢水母
    const byFolder = new Map();
    for (const l of graph.links) if (l.kind === 'contain' && byId.has(l.a) && byId.has(l.b)) {
      if (!byFolder.has(l.a)) byFolder.set(l.a, []);
      byFolder.get(l.a).push(l);
    }
    const deepLinks = [], deepNodes = new Set();
    for (const ls of byFolder.values()) {
      ls.sort((a, b) => (byId.get(b.b).n.deg || 0) - (byId.get(a.b).n.deg || 0));
      for (const l of ls.slice(0, 5)) { deepLinks.push({A: byId.get(l.a), B: byId.get(l.b)}); deepNodes.add(l.b); }
    }
    const sparks = Array.from({length: 90}, (_, i) => ({a: i / 90 * Math.PI * 2 + Math.sin(i * 12.9) * .3, v: .35 + (i * 37 % 100) / 100, s: 1 + (i * 13 % 7) / 3}));

    // 标签收纳：默认只画目录锚点名；hover 某类时只补该类连接度前 16 的节点名，明细一律进水母面板看。
    const labelDefault = new Set(graph.nodes.filter(n => n.kind === 'folder').map(n => n.id));
    const hoverLabels = new Map();
    for (const n of graph.nodes) {
      if (!hoverLabels.has(n.kind)) hoverLabels.set(n.kind, []);
      hoverLabels.get(n.kind).push(n);
    }
    for (const [kind, list] of hoverLabels) {
      hoverLabels.set(kind, new Set(list.sort((a, b) => (b.deg + b.mutual) - (a.deg + a.mutual)).slice(0, 16).map(n => n.id)));
    }

    // hover 高亮集合只在悬停对象变化时重建，不再每帧重算
    let hlKey = null, hl = null, hlLabel = null;

    const draw = now => {
      const L = live.current;
      const t = Math.max(0, (now - L.t0) / 1000);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // 相机投影（星图 10-21 无限画布）：光球在世界原点，星云作为世界内容随相机平移/缩放——
      // 屏幕位置=屏幕中心+(世界-相机)×z，缩放系数同步乘 z（拉远星云收拢、拉近散开，与内容环同一景深）
      const cam = L.camView || {x: L.orb.x, y: L.orb.y, z: 1};
      const cx = W / 2 + (L.orb.x - cam.x) * cam.z, cy = H / 2 + (L.orb.y - cam.y) * cam.z;
      const sc = (L.orb.s / 440) * Math.min(W * .37 / 380, H * .36 / 300) * (L.stage === 'hub' ? 1 : .55) * cam.z;
      const hover = L.hover;
      if (hover !== hlKey) {
        hlKey = hover;
        hl = hover ? new Set(graph.nodes.filter(n => n.kind === hover).map(n => n.id)) : null;
        if (hl) for (const l of graph.links) { if (hl.has(l.a) && l.kind !== 'contain') hl.add(l.b); }
        hlLabel = hover ? (hoverLabels.get(hover) || null) : null;
      }
      const grow = reduced ? 1 : Math.min(1, Math.max(0, (t - .35) / 2.2));
      const prog = x => reduced ? 1 : Math.min(1, Math.max(0, (t - .4 - x.d * .32 - x.seed * .35) / .9));
      const pos = x => {
        const p = prog(x), e = 1 - Math.pow(1 - p, 3);
        const sway = reduced || L.paused ? 0 : Math.sin(t * .5 + x.seed * 6.28) * 3;
        return [cx + x.p[0] * sc * e + sway, cy + x.p[1] * sc * e + Math.cos(t * .4 + x.seed * 9) * (reduced || L.paused ? 0 : 2.5), p];
      };
      for (const x of nodes) x.s = pos(x);

      // 光球点亮时的粒子迸发
      if (!reduced && t < 2.2) {
        const k = t / 2.2;
        ctx.globalCompositeOperation = ADD;
        for (const s of sparks) {
          const d = (40 + s.v * 420) * (1 - Math.pow(1 - k, 2.4)) * (L.orb.s / 440);
          const a = Math.max(0, 1 - k) * .9;
          const x = cx + Math.cos(s.a) * d, y = cy + Math.sin(s.a) * d;
          const g = ctx.createLinearGradient(cx + Math.cos(s.a) * d * .6, cy + Math.sin(s.a) * d * .6, x, y);
          g.addColorStop(0, `rgba(${P.spark[0]},0)`); g.addColorStop(1, `rgba(${P.spark[1]},${a})`);
          ctx.strokeStyle = g; ctx.lineWidth = s.s;
          ctx.beginPath(); ctx.moveTo(cx + Math.cos(s.a) * d * .6, cy + Math.sin(s.a) * d * .6); ctx.lineTo(x, y); ctx.stroke();
          ctx.globalAlpha = a; ctx.drawImage(glowSprite(P.spark[2]), x - s.s, y - s.s, s.s * 2, s.s * 2); ctx.globalAlpha = 1;
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      // 连线
      for (const k of links) {
        const [x1, y1, p1] = k.A.s, [x2, y2, p2] = k.B.s;
        const p = Math.min(p1, p2) * grow;
        if (p <= .02) continue;
        const on = !hl || (hl.has(k.l.a) && hl.has(k.l.b));
        let a = (k.l.both ? .32 : k.l.kind === 'wiki' ? .3 : k.l.kind === 'contain' ? .16 : .11) * p * (on ? 1 : .18) * (hl && on ? 2.6 : 1);
        ctx.strokeStyle = k.l.both ? `rgba(${P.mutual},${a})` : k.l.kind === 'wiki' ? `rgba(${P.wiki},${a})` : `rgba(${P.link},${a})`;
        ctx.lineWidth = k.l.both ? .6 + Math.min(k.l.w, 6) * .22 : .7;
        ctx.beginPath(); ctx.moveTo(x1, y1);
        if (k.l.both) { const mx = (x1 + x2) / 2 + (y2 - y1) * .12, my = (y1 + y2) / 2 - (x2 - x1) * .12; ctx.quadraticCurveTo(mx, my, x2, y2); }
        else ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // 深层记忆链（第二层信息光点）：慢呼吸的极淡归属线，神经末梢伸进记忆体
      for (const k of deepLinks) {
        const [x1, y1, p1] = k.A.s, [x2, y2, p2] = k.B.s;
        const p = Math.min(p1, p2) * grow;
        if (p <= .02) continue;
        const on = !hl || hl.has(k.A.n.id) || hl.has(k.B.n.id);
        const breath = reduced || L.paused ? 1 : .68 + .32 * Math.sin(t * .45 + (k.A.seed + k.B.seed) * 3.1);
        ctx.strokeStyle = `rgba(${P.link},${(.13 * (on ? 1.5 : 1) * p * breath).toFixed(3)})`;
        ctx.lineWidth = .6;
        ctx.beginPath(); ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo((x1 + x2) / 2, (y1 + y2) / 2 + 7, x2, y2);
        ctx.stroke();
      }

      // 神经脉冲：单向连接只朝出链方向，双向连接往返传递。
      if (!reduced && !L.paused && grow > .6) {
        ctx.globalCompositeOperation = ADD;
        for (const k of links) {
          if (k.l.kind === 'contain' || k.l.kind === 'tag') continue;
          const on = !hl || (hl.has(k.l.a) && hl.has(k.l.b));
          const speed = k.l.both ? .16 : .12;
          const lanes = k.l.both ? [0, 1] : [0];
          for (const lane of lanes) {
            const u = ((t * speed + k.seed + lane * .5) % 1);
            const fwd = lane === 0 ? (k.l.s === k.l.a) : !(k.l.s === k.l.a);
            const [x1, y1] = fwd ? k.A.s : k.B.s, [x2, y2] = fwd ? k.B.s : k.A.s;
            let x = x1 + (x2 - x1) * u, y = y1 + (y2 - y1) * u;
            if (k.l.both) { const mx = (k.A.s[0] + k.B.s[0]) / 2 + (k.B.s[1] - k.A.s[1]) * .12, my = (k.A.s[1] + k.B.s[1]) / 2 - (k.B.s[0] - k.A.s[0]) * .12; const uu = fwd ? u : 1 - u; x = (1 - uu) ** 2 * k.A.s[0] + 2 * (1 - uu) * uu * mx + uu * uu * k.B.s[0]; y = (1 - uu) ** 2 * k.A.s[1] + 2 * (1 - uu) * uu * my + uu * uu * k.B.s[1]; }
            const a = Math.sin(u * Math.PI) * (on ? .95 : .2);
            const c = k.l.both ? (lane ? P.mutualIn : P.mutual) : P.pulseOne;
            ctx.globalAlpha = a; ctx.drawImage(glowSprite(c), x - 6, y - 6, 12, 12); ctx.globalAlpha = 1;
          }
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      // 节点
      for (const x of nodes) {
        const [px, py, p] = x.s;
        if (p <= 0) continue;
        const on = !hl || hl.has(x.n.id);
        const color = KINDS[x.n.kind].color;
        const a = p * (on ? 1 : .15);
        const r = x.r * (hl && on ? 1.45 : 1);
        const deep = deepNodes.has(x.n.id);
        ctx.globalAlpha = a * (deep ? .5 + (reduced || L.paused ? 0 : .16 * Math.sin(t * .6 + x.seed * 6.28)) : .4); // 第二层记忆点自带微呼吸光晕
        ctx.globalCompositeOperation = ADD;
        const GR = r * 5;
        ctx.drawImage(glowSprite(color), px - GR, py - GR, GR * 2, GR * 2);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = a;
        if (x.n.kind === 'ghost') { ctx.setLineDash([2, 2]); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, r + 1, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
        else ctx.drawImage(orbSprite(color, P.light), px - r, py - r, r * 2, r * 2);
        if (L.stage === 'hub' && p > .9 && (x.n.kind === 'folder' || x.n.kind === 'tag' || (hlLabel && hlLabel.has(x.n.id) && on))) {
          // tag 话题词平时也带名字（初版 concept 标签的复刻）：第二层"记忆体"有自己的名字才像信息，
          // 38 个真实主题词淡浮在星云里；淡于 folder 锚点、亮于普通星点
          ctx.globalAlpha = a * (x.n.kind === 'folder' ? .85 : x.n.kind === 'tag' ? .52 : .9);
          ctx.fillStyle = P.label; ctx.font = `${x.n.kind === 'folder' ? 11.5 : 10.5}px -apple-system, "PingFang SC", sans-serif`;
          ctx.shadowColor = 'rgba(0, 0, 0, .75)'; ctx.shadowBlur = 3;   // 悬停第二层信息标签：衬底微影，星光里也读得清
          ctx.fillText((x.n.short || x.n.title).slice(0, 14), px + r + 5, py + 3.5);
          ctx.shadowBlur = 0;
        }
        ctx.globalAlpha = 1;
      }
    };
    // 每帧先排好下一帧再绘制：某一帧出错也不会让背景网络停住；
    // 星云整体 ~33fps 足够（星点/脉冲都是慢运动），把帧预算让给水母/光球的 60fps 丝滑
    let warned = false, lastDraw = -1e9;
    const frame = now => { raf = requestAnimationFrame(frame); if (now - lastDraw < 30) return; lastDraw = now; try { draw(now); } catch (err) { if (!warned) { warned = true; console.error(err); } } };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [graph, layout, live, reduced]);
  return <canvas ref={ref} className="network-canvas" aria-hidden="true"/>;
}
