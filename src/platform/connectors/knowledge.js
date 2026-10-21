import {getJSON} from '../client';

// 知识库模块：只关心 Markdown 图谱，不知道工作站任务和记忆池。
export async function fetchKnowledge() {
  const d = await getJSON('/api/kb-graph', 8000);
  return {notes: d.notes || []};
}