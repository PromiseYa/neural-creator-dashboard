import {getJSON, postJSON} from '../client';

export async function fetchDecisions() {
  const d = await getJSON('/api/platform/decisions', 4000);
  return {decisions: d.data?.decisions || []};
}

export const decideAction = payload => postJSON('/api/platform/actions/decide', payload, 10000);
