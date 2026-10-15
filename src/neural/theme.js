// 配色与素材路径：中性深灰底 + 银灰光球 + 黑底发光水母；点缀为银白与香槟金。只放颜色与素材，不含交互。
import {asset} from '../config';

export const T = {
  kinds: {core: '#ecd9a6', folder: '#d9b6c1', post: '#c0b8ef', note: '#8fe0c0', idea: '#e8c48c', draft: '#a9d3e4', concept: '#e4e6e8', tag: '#98a6a1', ghost: '#70746f', task: '#b9b0f5', decision: '#f0c27a', memory: '#9cc8ee', service: '#e4e6e8'},
  modules: {
    // R71 样式回原版（用户令 10-15）：水母滤镜回上游 v0.2.0-original 的淡雅五色（饱和度 1.x，批A/R28 的 2.2~2.6 撤销）；
    // 按色调对应原版五值：tasks←works紫 / kb←methods绿 / decisions←ideas金 / memory←drafts蓝 / services←concepts银灰；
    // R73（用户令"粉红这个改成淡白"）：services 的 color 回上游 concepts 银白 #e2e5e8——五只里只有它粉线与银灰身体
    // 不一致；kinds.service 同步回 #e4e6e8（卡点与线同族）
    tasks: {color: '#b9b0f5', filter: 'hue-rotate(215deg) saturate(1.1)'},
    kb: {color: '#8fe0c0', filter: 'hue-rotate(118deg) saturate(1)'},
    decisions: {color: '#f0c27a', filter: 'saturate(1)'},
    memory: {color: '#9cc8ee', filter: 'hue-rotate(158deg) saturate(1.05)'},
    services: {color: '#e2e5e8', filter: 'hue-rotate(185deg) saturate(.3) brightness(1.15)'}
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
