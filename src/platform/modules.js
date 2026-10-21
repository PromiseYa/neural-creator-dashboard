// 个人工作平台模块注册表：新增一个外接系统时先在这里登记，
// 再实现同名 connector。UI 不直接认识某个外部服务的端口和路径。
export const PLATFORM_MODULES = [
  {id: 'tasks', title: '任务流', en: 'Tasks', kind: 'task', folder: 'f:tasks', angle: 180, icon: 'works'},
  {id: 'kb', title: '知识库', en: 'Knowledge', kind: 'note', folder: 'f:kb', angle: 0, icon: 'methods'},
  {id: 'decisions', title: '拍板台', en: 'Decisions', kind: 'decision', folder: 'f:decisions', angle: 35, icon: 'idea',
    desc: '拍板=AI 干活拿不准、要你拿主意的事（D-xxx）：收尾无答案＋不拍板动不了＋有实际代价，三门槛才落账；落账即推微信，批准自动建任务派工。'},
  {id: 'memory', title: '记忆池', en: 'Memory', kind: 'memory', folder: 'f:memory', angle: 145, icon: 'draft'},
  {id: 'services', title: '服务舱', en: 'Services', kind: 'service', folder: 'f:services', angle: -90, icon: 'concept'}
];

export const PLATFORM_MODULE_IDS = PLATFORM_MODULES.map(m => m.id);
export const platformModule = id => PLATFORM_MODULES.find(m => m.id === id);

// 每个模块独占的数据切片。一个模块失败时，只把该切片标记降级，不清空其它模块。
export const MODULE_DATA_KEYS = {
  tasks: ['tasks', 'commands', 'events', 'vitals'],
  kb: ['notes'],
  decisions: ['decisions'],
  memory: ['memories', 'memState'],
  services: ['services']
};

export function emptyPlatformData() {
  return {
    tasks: [], commands: [], decisions: [], memories: [], services: [], notes: [], events: [],
    memState: null, vitals: null
  };
}

// 顶栏分页徽标计数（App 导航与生态体检共用一份口径）。
export function moduleCount(id, eco) {
  const v = eco?.vitals;
  if (id === 'tasks') return v?.open_tasks;
  if (id === 'kb') return eco?.notes?.length;
  if (id === 'decisions') return v?.pending_decisions;
  if (id === 'memory') return eco?.memState?.pool_n;
  return eco?.services?.filter(x => x.ok).length;
}