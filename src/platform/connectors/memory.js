import {getJSON} from '../client';

export async function fetchMemory() {
  const d = await getJSON('/api/memory-state', 3000);
  return {memories: d.items || [], memState: d};
}
