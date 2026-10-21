import {useEffect, useRef, useState} from 'react';
import {fetchPlatform} from './connectors';
import {MODULE_DATA_KEYS, emptyPlatformData} from './modules';

function mergeByModule(prev, next, states) {
  const out = emptyPlatformData();
  for (const [id, keys] of Object.entries(MODULE_DATA_KEYS)) {
    const source = states[id]?.status === 'ready' || !prev ? next : prev;
    for (const key of keys) out[key] = source[key] ?? (key === 'memState' || key === 'vitals' ? null : []);
  }
  return out;
}

export function usePlatform() {
  const [eco, setEco] = useState(null);
  const [moduleStates, setModuleStates] = useState(() => Object.fromEntries(
    Object.keys(MODULE_DATA_KEYS).map(id => [id, {status: 'loading', updatedAt: 0, error: ''}])
  ));
  const sigRef = useRef('');
  const pullRef = useRef(null);

  useEffect(() => {
    let stopped = false;
    const pull = async () => {
      try {
        const next = await fetchPlatform();
        if (stopped) return;
        setModuleStates(next.moduleStates);
        setEco(prev => {
          const merged = {...mergeByModule(prev, next, next.moduleStates), moduleStates: next.moduleStates};
          const v = merged.vitals || {};
          const sig = JSON.stringify([
            merged.tasks, merged.commands, merged.decisions, merged.memories, merged.memState,
            merged.services, merged.notes, merged.events,
            v.open_tasks, v.pending_decisions, v.review_tasks, v.workers_ok, v.workers_late, v.workers_down
          ]);
          if (sig === sigRef.current) return prev;
          sigRef.current = sig;
          return merged;
        });
      } catch {
        // fetchPlatform 内部已按模块降级；这里保留上一次可用数据，30 秒后重试。
      }
    };
    pullRef.current = pull;
    pull();
    const timer = setInterval(pull, 30000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  return {eco, moduleStates, refresh: () => pullRef.current?.()};
}