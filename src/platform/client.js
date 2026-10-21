// 平台连接器共用的本地 API 客户端。模块文件不直接写 fetch 细节。
async function request(url, {method = 'GET', body, ms = 5000} = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      method,
      signal: ctl.signal,
      ...(body === undefined ? {} : {
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export const getJSON = (url, ms) => request(url, {ms});
export const postJSON = (url, body, ms) => request(url, {method: 'POST', body, ms});
export async function alive(url, ms = 2500) {
  try { await getJSON(url, ms); return true; } catch { return false; }
}