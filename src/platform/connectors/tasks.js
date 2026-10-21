import {getJSON, postJSON} from '../client';

// 任务模块：任务、指令台账、事件和生命体征一起归入“单独管理的任务域”。
export async function fetchTasks() {
  const [base, done, vitals] = await Promise.allSettled([
    getJSON('/api/platform/tasks', 5000),
    getJSON('/api/hub-done', 5000),
    getJSON('/api/platform/vitals', 4000)
  ]);
  if (base.status !== 'fulfilled' || !base.value?.ok) throw new Error('task source unavailable');

  const d = base.value.data || {};
  const doneRows = done.status === 'fulfilled' && done.value?.ok ? (done.value.rows || []) : [];
  return {
    tasks: [...(d.tasks?.open || []), ...doneRows],
    commands: d.commands || [],
    events: d.events || [],
    vitals: vitals.status === 'fulfilled' && vitals.value?.ok ? vitals.value.data : null
  };
}

export const taskAction = payload => postJSON('/api/platform/actions/task', payload, 6000);
export const cmdAction = payload => postJSON('/api/platform/actions/command', payload, 10000);
export const attachAction = payload => postJSON('/api/platform/actions/attach', payload, 60000);
export const panelAction = (op, args, ms = 12000) => postJSON('/api/platform/actions/ops', {op, args: args || {}}, ms);