import {PLATFORM_MODULES, emptyPlatformData} from '../modules';
import {fetchTasks} from './tasks';
import {fetchKnowledge} from './knowledge';
import {fetchDecisions} from './decisions';
import {fetchMemory} from './memory';
import {fetchServices} from './services';

const CONNECTORS = {tasks: fetchTasks, kb: fetchKnowledge, decisions: fetchDecisions, memory: fetchMemory, services: fetchServices};

// 一次轮询五个模块并行取数；单个连接器失败不影响其它模块。
export async function fetchPlatform() {
  const entries = await Promise.allSettled(PLATFORM_MODULES.map(async m => [m.id, await CONNECTORS[m.id]()]));
  const data = emptyPlatformData();
  const moduleStates = {};
  for (let i = 0; i < entries.length; i++) {
    const m = PLATFORM_MODULES[i], result = entries[i];
    if (result.status === 'fulfilled') {
      Object.assign(data, result.value[1]);
      moduleStates[m.id] = {status: 'ready', updatedAt: Date.now(), error: ''};
    } else {
      moduleStates[m.id] = {
        status: 'error', updatedAt: Date.now(),
        error: String(result.reason?.message || result.reason || '模块数据源不可达')
      };
    }
  }
  return {...data, moduleStates};
}