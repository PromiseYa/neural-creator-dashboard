// 兼容出口：旧引用仍从 data/live.js 进来；真实实现已拆到 platform/connectors。
export {fetchPlatform as fetchEcosystem} from '../platform/connectors';
export {taskAction, cmdAction, attachAction, panelAction} from '../platform/connectors/tasks';
export {decideAction} from '../platform/connectors/decisions';

// WebView2 宿主通知（壁纸模式中文输入的关键）：input 聚焦时把输入框的屏幕矩形（设备像素）发给
// LivelyMod 播放器，播放器在原地浮一个原生输入框——原生窗口拿真实前台，系统输入法（IME）挂得上，
// 中文可输；普通浏览器里 window.chrome.webview 不存在，静默无副作用。
// 星图 10-18 二轮：原生输入框不再只服务底部搜索框——wvFocus 记住当前聚焦的真实输入框，
// LivelyMod 回车提交时（__starNativeSubmit）文本写回该输入框（React 受控兼容：原生 value setter
// + input 事件），带 data-wv-submit="form" 的（底部搜索/追问框）再顺带触发所属表单。
// 任何弹窗/面板/编辑器输入框壁纸模式都能打字，与底部搜索框同体验。
let wvEl = null, wvLast = null;   // wvLast=最后聚焦过的输入框（blur 不清）：LivelyMod 先发 blur 再发提交时仍能落笔
const wvNode = a => a && a.getBoundingClientRect ? a : (a && a.target && a.target.getBoundingClientRect ? a.target : null);
export const wvFocus = el => {
  wvEl = wvLast = wvNode(el);   // 调用点两种姿势都要接住：onFocus={wvFocus} 传事件对象 / onFocus={e => wvFocus(e.target)} 传元素
  try {
    const w = window.chrome?.webview; if (!w) return;
    if (wvEl) {
      const r = wvEl.getBoundingClientRect();
      const k = (window.screen.width || window.innerWidth) / Math.max(window.innerWidth, 1);
      w.postMessage(JSON.stringify({type: 'star-input-focus', x: Math.round(r.x * k), y: Math.round(r.y * k), w: Math.round(r.width * k), h: Math.round(r.height * k)}));
    } else w.postMessage('star-input-focus');
  } catch {}
};
export const wvBlur = () => {
  try { wvEl?.blur?.(); } catch {}
  wvEl = null;
  try { window.chrome?.webview?.postMessage('star-input-blur'); } catch {}
};
if (typeof window !== 'undefined') {
  window.__starNativeSubmit = text => {
    if (text == null) return;
    const el = (wvEl && wvEl.isConnected) ? wvEl : ((wvLast && wvLast.isConnected) ? wvLast : null);
    if (!el) return;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(text));
    el.dispatchEvent(new Event('input', {bubbles: true}));   // React onChange 同步收到
    if (el.dataset?.wvSubmit === 'form' && el.form) setTimeout(() => { try { el.form.requestSubmit(); } catch {} }, 0);   // 下一拍再提交：等 React 把 state 提交完
  };
  window.__starNativeBlur = () => { try { wvEl?.blur?.(); } catch {} wvEl = null; };
}