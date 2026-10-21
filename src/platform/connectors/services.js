import {getJSON, alive} from '../client';

export async function fetchServices() {
  const d = await getJSON('/api/platform/services', 5000);
  const [engineOK, kbOK] = await Promise.all([
    alive('/api/platform/engine-ping'),
    alive('/api/platform/kb-health')
  ]);
  const workers = d.data?.workers || [];
  return {
    services: [
      {id: 'hub', name: '执行引擎', ok: engineOK, group: 'core', desc: '任务写入与执行链路'},
      {id: 'kbserve', name: '检索服务', ok: kbOK, group: 'core', desc: 'KB 语义与关键词检索'},
      ...workers.filter(w => !w.retired && w.type === 'resident').map(w => ({
        id: w.id, name: `${w.emoji || '🔧'} ${w.name}`, ok: w.hb_state === 'ok', group: 'worker',
        desc: w.desc || '', state: w.hb_state, url: w.ui || undefined
      }))
    ]
  };
}