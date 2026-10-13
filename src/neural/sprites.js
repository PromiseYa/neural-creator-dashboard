// 预渲染光斑精灵：径向/球体渐变按颜色只画一次，动画循环里全部换成 drawImage 贴图，
// 消除每帧数百次 createRadialGradient 造成的临时对象分配（GC 抖动是卡顿主因）。
const norm = c => {
  if (!c.startsWith('#')) return c;
  const m = c.slice(1).match(/../g);
  return m ? m.map(x => parseInt(x, 16)).join(',') : c;
};

const glowCache = new Map();
export function glowSprite(color) {
  const key = norm(color);
  let s = glowCache.get(key);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = 64;
  const x = s.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, `rgba(${key},1)`);
  g.addColorStop(1, `rgba(${key},0)`);
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  glowCache.set(key, s);
  return s;
}

const orbCache = new Map();
export function orbSprite(color, light) {
  const key = norm(color) + '|' + light;
  let s = orbCache.get(key);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = 64;
  const x = s.getContext('2d');
  // 与现场绘制同参数：高光圆心偏 (-0.35r, -0.35r)，主体色到边缘减淡
  const g = x.createRadialGradient(32 - 32 * .35, 32 - 32 * .35, 0, 32, 32, 32);
  g.addColorStop(0, light);
  g.addColorStop(.45, color);
  g.addColorStop(1, color + 'aa');
  x.fillStyle = g;
  x.beginPath();
  x.arc(32, 32, 32, 0, 7);
  x.fill();
  orbCache.set(key, s);
  return s;
}
