// 个性化配置：换成你自己的品牌名、账号和头像，其余代码不用改。
// Personal settings: swap in your own brand, account and avatar; nothing else needs to change.
export const CONFIG = {
  brand: {name: 'PROMISE', sub: 'ECOSYSTEM', tagline: '个人生态神经网', taglineEn: 'Personal ecosystem, live'},
  // 图谱中心节点的名字
  workspace: '我的数字生态',
  // 头像放在 public/ 下，填相对路径
  avatar: 'avatar.svg',
  footer: {zh: '每一个系统，都是网络里的一个节点。', en: 'Every system is a node in the network.'},
  // 选题、草稿与目标保存在浏览器 localStorage 里的键名前缀
  storagePrefix: 'neural-dashboard'
};

// public/ 下的素材路径（兼容部署在子路径，如 GitHub Pages）
export const asset = path => import.meta.env.BASE_URL + path;
