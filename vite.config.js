import {defineConfig} from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// KB 现场扫描：页面每次请求 /api/kb-graph 时实时读知识库 markdown（正本零写入），
// 返回标题/分区/标签/双链/摘要。跳过附件区与 brain 构建区。
const KB_ROOT = 'D:/Portable/KnowledgeBase';
const SKIP_DIRS = new Set(['99-附件', 'brain']);

function parseNote(file, rel, zone) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');   // 去 BOM：带 BOM 的文件 frontmatter 会整个失效（标题/标签/摘要全污染）
  let fm = {}, body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
      if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
    }
    // YAML 多行数组：  tags:\n  - a\n  - b
    const arr = m[1].match(/^tags\s*:\s*\r?\n((?:\s+-\s.*\r?\n?)+)/m);
    if (arr) fm.tags = arr[1].split(/\r?\n/).map(x => x.replace(/^\s+-\s*/, '').trim()).filter(Boolean).join(',');
  }
  const tags = String(fm.tags || '')
    .replace(/^\[|\]$/g, '')          // YAML 流式数组 tags: [a, b]
    .split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const h1 = body.match(/^#\s+(.+)$/m);
  const title = String(fm.title || h1?.[1] || path.basename(rel, '.md')).replace(/\.md$/, '');
  const wikilinks = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map(x => x[1].split('|')[0].split('#')[0].split('/').pop().trim()).filter(Boolean);
  const segs = rel.replace(/\\/g, '/').split('/');
  return {
    id: rel.replace(/\\/g, '/'),
    title, zone,
    subzone: segs.length > 2 ? segs.slice(1, -1).join('/') : '',   // 分区名与文件名之间的完整子路径（根层笔记为空；层级任意深）
    path: rel.replace(/\\/g, '/'),
    tags,
    updated: fm.updated || fm.created || '',
    wikilinks,
    body: body.replace(/\s+/g, ' ').trim().slice(0, 600)
  };
}

function kbGraphPlugin() {
  return {
    name: 'kb-graph',
    configureServer(server) {
      server.middlewares.use('/api/kb-graph', (req, res) => {
        const notes = [];
        const walk = (dir, zone) => {
          let entries;
          try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
          for (const e of entries) {
            if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (SKIP_DIRS.has(e.name)) continue;
              walk(p, zone || e.name.replace(/\.md$/, ''));
            } else if (e.name.toLowerCase().endsWith('.md')) {
              try { notes.push(parseNote(p, path.relative(KB_ROOT, p), zone || '根区')); } catch {}
            }
          }
        };
        walk(KB_ROOT, '');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({notes}));
      });
    }
  };
}

// memorycore 状态直读（只读）：state 目录 + memlazy 池。
// 记忆池水母的数据源；memorycore 本体（MCP stdio）零打扰。
const MC_STATE = 'D:/Portable/KnowledgeBase/brain/memorycore/state';
const MC_POOL = 'D:/Portable/Documents/工作管理/共用工具/memlazy/pool.json';

// ZCode memory 目录（memorycore 降级候选的真身文件）：按文件名建索引，
// frontmatter 的中文 description 当标题、文件 mtime 当更新日期——记忆池中文化 + 阅读全文的数据源。
const MEM_ROOT = 'C:/Users/ocean.xu/.zcode/cli/memories/projects';
let memIdxCache = null, memIdxAt = 0;
function memIndex() {
  if (memIdxCache && Date.now() - memIdxAt < 300000) return memIdxCache;
  const out = new Map();
  let projects = [];
  try { projects = fs.readdirSync(MEM_ROOT, {withFileTypes: true}).filter(d => d.isDirectory()); } catch {}
  for (const p of projects) {
    const dir = path.join(MEM_ROOT, p.name, 'memory');
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')); } catch { continue; }
    for (const f of files) {
      if (out.has(f)) continue;
      try {
        const full = path.join(dir, f);
        const raw = fs.readFileSync(full, 'utf8');
        const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const desc = fm ? ((fm[1].match(/^description:\s*(.+)$/m) || [])[1] || '') : '';
        const mt = fs.statSync(full).mtime;
        out.set(f, {file: full, title: desc.trim().replace(/^['"]|['"]$/g, '').slice(0, 80),
          updated: mt.toISOString().slice(0, 10)});
      } catch {}
    }
  }
  memIdxCache = out; memIdxAt = Date.now();
  return out;
}

function memoryState() {
  const out = {ok: true, updated: '', pool_n: 0, defer_n: 0, sync: '', items: []};
  try {
    const st = JSON.parse(fs.readFileSync(`${MC_STATE}/memory_state.json`, 'utf8'));
    out.updated = st.updated || '';
    const idx = memIndex();
    out.items = (st.demote_candidates_report_only || []).slice(0, 12)
      .map(s => String(s).split(') — '))                      // "name.md) — 摘要" 格式
      .filter(p => p.length >= 2)
      .map(p => {
        const name = p[0].replace(/\.md$/, '').trim();
        const meta = idx.get(name + '.md');
        return {id: name, title: meta?.title || name, body: p.slice(1).join(' — ').slice(0, 200),
          updated: meta?.updated || '', md: meta ? name + '.md' : ''};
      });
  } catch {}
  try { out.pool_n = JSON.parse(fs.readFileSync(MC_POOL, 'utf8')).length; } catch {}
  try { out.defer_n = fs.readdirSync(`${MC_STATE}/defer`).filter(f => f.endsWith('.txt')).length; } catch {}
  try {
    const rep = fs.readdirSync('D:/Portable/KnowledgeBase/brain/memorycore/reports').filter(f => f.startsWith('sync_')).sort();
    out.sync = rep.at(-1) || '';
  } catch {}
  return out;
}

function memoryStatePlugin() {
  return {
    name: 'memory-state',
    configureServer(server) {
      server.middlewares.use('/api/memory-state', (req, res) => {
        try {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(memoryState()));
        } catch {
          res.statusCode = 500;
          res.end('{"ok":false}');
        }
      });
      // 记忆全文：按文件名在 ZCode memory 目录索引中定位（只索引内文件，basename 防穿越）
      server.middlewares.use('/api/mem-raw', (req, res) => {
        const fname = path.basename((q(req).get('id') || ''));
        const meta = memIndex().get(fname);
        const json = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
        if (!meta || !fname.toLowerCase().endsWith('.md')) return json(400, {ok: false});
        try {
          json(200, {ok: true, id: fname, raw: fs.readFileSync(meta.file, 'utf8')});
        } catch { json(404, {ok: false}); }
      });
    }
  };
}

// ---- 详情数据三通道（R21，全部只读、按需拉取，不进 30 秒轮询）----
// /api/note-raw?id=<rel>   KB 笔记全文（阅读弹窗打开时拉一次；kb-graph 里的 body 是 600 字摘要）
// /api/kb-asset?p=<rel>    KB 内图片文件二进制（含 99-附件；白名单扩展名 + 路径必须在 KB_ROOT 内防穿越）
// /api/hub-detail?t=|d=    hub.db 单条明细：8331 列表投影裁掉了 tasks.notes/source_ref 与
//                          decisions.proposal/why/impact 等长文本，这里用 node:sqlite 只读连接按需补，
//                          不动 8330/8331 一行、不给星图开任何写权限。
const HUB_DB = 'D:/Portable/Documents/工作管理/LoopDeck/hub/hub.db';
const IMG_MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif'};
const kbRootAbs = path.resolve(KB_ROOT).toLowerCase();
const insideKB = p => {
  if (!p || p.includes('\0')) return null;
  const full = path.resolve(KB_ROOT, p);
  return full.toLowerCase().startsWith(kbRootAbs + path.sep) ? full : null;
};
const q = req => new URL(req.url, 'http://local').searchParams;

function detailPlugin() {
  return {
    name: 'kb-detail',
    configureServer(server) {
      const json = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
      server.middlewares.use('/api/note-raw', (req, res) => {
        const id = (q(req).get('id') || '').replace(/\\/g, '/');
        const full = insideKB(id);
        if (!full || !id.toLowerCase().endsWith('.md')) return json(res, 400, {ok: false});
        try {
          const raw = fs.readFileSync(full, 'utf8');
          json(res, 200, {ok: true, id, dir: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '', raw});
        } catch { json(res, 404, {ok: false}); }
      });
      server.middlewares.use('/api/kb-asset', (req, res) => {
        const p = (q(req).get('p') || '').replace(/\\/g, '/');
        const full = insideKB(p);
        const ext = path.extname(full || '').toLowerCase();
        if (!full || !IMG_MIME[ext]) return json(res, 400, {ok: false});
        try {
          res.setHeader('Content-Type', IMG_MIME[ext]);
          res.setHeader('Cache-Control', 'no-cache');
          res.end(fs.readFileSync(full));
        } catch { json(res, 404, {ok: false}); }
      });
      server.middlewares.use('/api/hub-done', async (req, res) => {
        // 累计完成任务清单（任务流分类钻取的数据源；只读直查，不进 8331 投影）
        try {
          const {DatabaseSync} = await import('node:sqlite');
          const db = new DatabaseSync(HUB_DB, {readOnly: true});
          try {
            const rows = db.prepare("SELECT id,title,done_at,'done' AS status FROM tasks WHERE status='done' ORDER BY done_at DESC").all();
            json(res, 200, {ok: true, rows});
          } finally { db.close(); }
        } catch { json(res, 500, {ok: false}); }
      });
      server.middlewares.use('/api/hub-detail', async (req, res) => {
        const id = q(req).get('t') || q(req).get('d') || '';
        if (!/^[TD]-[\w-]+$/.test(id)) return json(res, 400, {ok: false});   // 拍板号可带字母后缀（D-989A/D-TEST1），纯数字校验会误杀
        try {
          const {DatabaseSync} = await import('node:sqlite');
          const db = new DatabaseSync(HUB_DB, {readOnly: true});
          try {
            const row = id[0] === 'T'
              ? db.prepare('SELECT id,title,status,priority,due,source,source_ref,notes,attachments,confidence,risk_level,rollback_ref,deliverables,created_at,updated_at FROM tasks WHERE id=?').get(id)
              : db.prepare('SELECT id,title,proposal,why,impact,source,status,choice,decided_at,options,created_at FROM decisions WHERE id=?').get(id);
            if (row && row.options != null && typeof row.options === 'string') {
              try {
                const v = JSON.parse(row.options);
                row.options = Array.isArray(v) ? v : [row.options];
              } catch { row.options = row.options.split('|').filter(Boolean); }
            }
            json(res, 200, {ok: true, row: row || null});
          } finally { db.close(); }
        } catch (e) { json(res, 500, {ok: false, err: String(e && e.message || e)}); }
      });
    }
  };
}

// base 用相对路径，构建产物可以直接部署在任意子路径。
// server.proxy：把本机三个现役服务挂成同源路径，页面零跨域直连：
//   /hub/*   → 8331 工作站新底座（任务/拍板/工作者实体，只读）
//   /panel/* → 8330 老面板（写操作走这里）
//   /kb/*    → 8342 检索服务（语义/关键词混合查询）
export default defineConfig({
  base: './',
  plugins: [kbGraphPlugin(), memoryStatePlugin(), detailPlugin()],
  server: {
    proxy: {
      '/hub': {target: 'http://127.0.0.1:8331', changeOrigin: true, rewrite: p => p.replace(/^\/hub/, '')},
      '/panel': {target: 'http://127.0.0.1:8330', changeOrigin: true, rewrite: p => p.replace(/^\/panel/, '')},
      '/kb': {target: 'http://127.0.0.1:8342', changeOrigin: true, rewrite: p => p.replace(/^\/kb/, '')}
    }
  }
});
