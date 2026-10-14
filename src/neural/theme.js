// 配色与素材路径：中性深灰底 + 银灰光球 + 黑底发光水母；点缀为银白与香槟金。只放颜色与素材，不含交互。
import {asset} from '../config';

export const T = {
  kinds: {core: '#ecd9a6', folder: '#d9b6c1', post: '#c0b8ef', note: '#8fe0c0', idea: '#e8c48c', draft: '#a9d3e4', concept: '#e4e6e8', tag: '#98a6a1', ghost: '#70746f', task: '#b9b0f5', decision: '#f0c27a', memory: '#9cc8ee', service: '#ecb8de'},
  modules: {
    // 每只水母独立染色（同一视频源用 hue/saturate/brightness 拉开）：紫罗兰/青绿/金橙/天蓝/浅粉紫；
    // 触须与卡片连线用同款 color，整组色系一致（服务舱银白与文字白撞色→玫瑰粉又偏深偏暖，再调浅调冷成粉紫，与其余冷色同族）
    tasks: {color: '#b9b0f5', filter: 'hue-rotate(215deg) saturate(2.4) brightness(.92)'},
    kb: {color: '#8fe0c0', filter: 'hue-rotate(130deg) saturate(2.2) brightness(.9)'},
    decisions: {color: '#f0c27a', filter: 'hue-rotate(-6deg) saturate(2.6) brightness(.98)'},
    memory: {color: '#9cc8ee', filter: 'hue-rotate(165deg) saturate(2.3) brightness(.92)'},
    services: {color: '#ecb8de', filter: 'hue-rotate(-60deg) saturate(2) brightness(1.06)'}
  },
  // palindrome 剪辑（正放+倒放拼接）：循环回到首帧时画面连续，消除播完一帧的跳变；原片保留作回退
  media: {orb: asset('media/orb_pal.mp4'), orbPoster: asset('media/orb.jpg'), jelly: asset('media/jellyfish_pal.mp4'), jellyPoster: asset('media/jellyfish.jpg')},
  pulse: {out: ['#fffaf0', '#ecd39e'], in: ['#ffffff', '#e3b3c4']},
  ring: ['#ecd9a6', '#c9cac5'],
  logo: ['#7d7f7c', '#d8d9d6', '#ecd9a6', '#a9aba7'],
  mini: {glow0: '#ffffff', core: '#c9d6e0', dot: '#f2f4f5', mutual: '#ecd39e', pulseOut: '#ffffff', pulseIn: '#e3b3c4'},
  dust: ['236,236,232', '230,207,152', '200,205,210', '255,255,255'],
  canvas: {additive: true, mutual: '236,206,146', mutualIn: '232,176,196', wiki: '172,224,206', link: '205,208,204', pulseOne: '190,230,215', label: '#e6e7e3', spark: ['200,205,210', '225,228,232', '255,236,200'], glow: '66', light: '#ffffff'}
  };
