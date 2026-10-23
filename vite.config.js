import {defineConfig} from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';

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
// 2026-10-21 修复：kbserve 索引的语料不全在 Obsidian 仓库下——微信/邮件/工作管理/专案文档都在外面，
// readKb 命中后点击全文被 insideKB 一刀切挡成 400（前端误报"全文读取失败/引擎宿主不可达"）。
// 白名单扩到 kbsearch 实际语料根（与 kbsearch/config.py 同源），仍逐根 startsWith + sep 防目录穿越。
const KB_EXTRA_ROOTS = [
  'D:/Portable/Documents/工作管理/LoopDeck/workers/kbsearch',  // sources_wechat/mail/office
  'D:/Project/SEASCN25006/EAP',                                 // 威尔高 spec/参考/设备商
  'D:/Portable/Documents/工作管理',                             // 中富/恒美/威尔高专案 md
  'D:/Portable/Documents/EAP相关专案问题整理',
  'C:/Users/ocean.xu/.zcode/experience',
  'C:/Users/ocean.xu/.zcode/cli/memories/projects',   // ZCode memory 真身（kbsearch 同样索引）
  'C:/Users/ocean.xu/Documents/xwechat_files',
  'D:/Deltabox',
  'D:/Project/CERTW-002106',
  'D:/Project/DTANJ-000414',
].map(r => path.resolve(r).toLowerCase());
const insideKB = p => {
  if (!p || p.includes('\0')) return null;
  // kbserve 传绝对路径；/api/kb-graph 的 path 是 KB 相对路径，必须相对 KB_ROOT 解析
  // （不能裸 path.resolve，那会相对 vite cwd=项目目录，导致全部笔记 400）
  let full = path.isAbsolute(p) ? path.resolve(p) : path.resolve(KB_ROOT, p);
  // kbserve 索引里 KB 语料的路径是 junction 路径 C:/Users/ocean.xu/KnowledgeBase/...，
  // realpath 归一到 D:/Portable/KnowledgeBase，否则点击搜索结果仍被白名单挡成 400
  try { full = fs.realpathSync(full); } catch {}
  const fl = full.toLowerCase();
  if (fl === kbRootAbs) return null;
  if (fl.startsWith(kbRootAbs + path.sep)) return full;
  for (const r of KB_EXTRA_ROOTS) {
    if (fl.startsWith(r + path.sep)) return full;
  }
  return null;
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
        // 10-21：命中语料两成是 .txt（EAP 排错记录/memorycore defer 包/使用说明）——此前非 .md 一律 400，
        // 前端表现"阅读全文打开失败"；txt 是纯文本，直接放行（docx/pdf 等二进制仍挡，由前端分流提示）
        const ext = path.extname(id).toLowerCase();
        if (!full || !['.md', '.txt'].includes(ext)) return json(res, 400, {ok: false});
        try {
          const raw = fs.readFileSync(full, 'utf8');
          json(res, 200, {ok: true, id, ext, dir: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '', raw});
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
            const rows = db.prepare("SELECT id,title,done_at,'done' AS status,source,source_ref FROM tasks WHERE status='done' ORDER BY done_at DESC").all();
            attachSrcInfo(db, rows);
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

// ---- 8331 脱钩（用户令 10-15）：实体快照不再依赖 8331 进程，中间件只读直查 hub.db + registry.json ----
// 字段形状逐项对齐 LoopDeck web/api/store.py 的投影（tasks/decisions/workers/events/vitals）；
// 服务舱 8331 卡片改为独立 ping 探测——在线与否仍是事实，但星图数据不再跟着 8331 断。
const REGISTRY = 'D:/Portable/Documents/工作管理/LoopDeck/workers/registry.json';
const HB_DEFAULT_IV = 900, HB_GRACE_X = 2.0;
const TASK_OPEN = ['pending', 'waiting_confirm', 'dispatched', 'doing', 'review'];  // 10-16 +review：待验收队列进星图
const hbState = (ts, iv) => {   // 心跳行 → ok/late/down 三态（只认数字 epoch，与 store._hb_state 同口径）
  const age = Date.now() / 1000 - Number(ts);
  if (!Number.isFinite(age)) return 'unknown';
  if (!(iv > 0)) iv = HB_DEFAULT_IV;
  return age <= iv ? 'ok' : age <= iv * HB_GRACE_X ? 'late' : 'down';
};
const parseOpts = raw => {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
  catch { return String(raw).split('|').filter(Boolean); }
};
// 任务来源行键 → 来源文件实物（星图 10-21 用户令「哪个 Excel 哪个页签」）：
// source_ref 形如 src{N}:…，N=sources 表 id；给任务行附带 src_name（来源名）、src_sheet（页签）、src_path（文件路径）。
// 只读直查，纯加字段；/api/entities、/api/platform/tasks、/api/platform/tasks/full、/api/hub-done 共用。
const attachSrcInfo = (db, rows) => {
  if (!rows || !rows.length) return rows;
  let srcs = null;
  try { srcs = db.prepare('SELECT id,name,path,sheet FROM sources').all(); } catch { return rows; }
  const byId = new Map((srcs || []).map(s => [s.id, s]));
  for (const t of rows) {
    const m = /^src(\d+):/.exec(String(t.source_ref || ''));
    if (!m) continue;
    const s = byId.get(parseInt(m[1], 10));
    if (!s) continue;
    t.src_name = s.name || null;
    t.src_sheet = s.sheet || null;
    t.src_path = s.path || null;
  }
  return rows;
};
function entitiesPlugin() {
  return {
    name: 'hub-entities',
    configureServer(server) {
      server.middlewares.use('/api/entities', async (req, res) => {
        const json = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
        try {
          const {DatabaseSync} = await import('node:sqlite');
          const db = new DatabaseSync(HUB_DB, {readOnly: true});
          try {
            // source_ref（星图 10-20 五轮）：带上任务来源行键，图谱任务节点 → 档案页可按 src{id} 追溯到具体来源文件
            // 10-21：attachSrcInfo 再附 src_name/src_sheet/src_path——任务卡/详情直接显示「哪个 Excel 哪个页签」
            // 10-23：补 notes——任务内容随轮询直出（用户令「拉取完整任务信息」，不再只看到完成度和日期）
            const open = db.prepare(`SELECT id,title,status,priority,due,source,source_ref,notes,attachments,created_at,updated_at FROM tasks
                                     WHERE status IN (?,?,?,?,?) ORDER BY updated_at DESC`).all(...TASK_OPEN);
            attachSrcInfo(db, open);
            const doneToday = db.prepare(`SELECT id,title,done_at FROM tasks WHERE status='done'
                                          AND date(done_at)=date('now','localtime') ORDER BY done_at DESC`).all();
            // 指令台账 M-xxx（10-16 批2：星图任务流钻取层"指令台账"卡数据源，未软删的最近 60 条）
            const commands = db.prepare(`SELECT id,prompt,source,status,task_id,rerun_of,created_at,updated_at
                                         FROM commands WHERE is_deleted=0 ORDER BY id DESC LIMIT 60`).all();
            const decisions = db.prepare(`SELECT id,title,status,created_at,options FROM decisions
                                          WHERE status='pending' ORDER BY created_at`).all();
            for (const r of decisions) r.options = parseOpts(r.options);
            const events = db.prepare(`SELECT id,ts,kind,actor,action,detail,task_id FROM events
                                       ORDER BY id DESC LIMIT 40`).all();
            // 工作者：registry.json（唯一注册表）× heartbeats 每名字取最新一行
            let entries = [];
            try { entries = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).workers || []; } catch {}
            const latest = new Map();
            for (const r of db.prepare('SELECT name, ts, expected_interval FROM heartbeats').all()) {
              const old = latest.get(r.name);
              if (old == null || (r.ts || 0) > (old.ts || 0)) latest.set(r.name, r);
            }
            const workers = entries.map(w => {
              const hb = latest.get(w.id);
              const iv = hb?.expected_interval || HB_DEFAULT_IV;
              return {id: w.id, name: w.name, type: w.type, emoji: w.emoji, desc: w.desc, ui: w.ui || null,
                retired: !!w.retired, hb_ts: hb?.ts ?? null,
                hb_state: hb ? hbState(hb.ts, iv) : 'noreport'};
            });
            const openTasks = db.prepare(`SELECT count(*) c FROM tasks WHERE status IN (?,?,?,?,?)`).get(...TASK_OPEN).c;
            const reviewN = db.prepare(`SELECT count(*) c FROM tasks WHERE status='review'`).get().c;
            const pendDec = db.prepare(`SELECT count(*) c FROM decisions WHERE status='pending'`).get().c;
            const actAlarms = db.prepare(`SELECT count(*) c FROM alarms WHERE status='active'`).get().c;
            const maxEv = db.prepare('SELECT coalesce(max(id),0) m FROM events').get().m;
            const hbs = workers.filter(w => !w.retired).map(w => w.hb_state);
            json(200, {ok: true, data: {
              tasks: {open, done_today: doneToday},
              commands, decisions, workers, events,
              vitals: {open_tasks: openTasks, pending_decisions: pendDec, review_tasks: reviewN, active_alarms: actAlarms,
                workers_ok: hbs.filter(s => s === 'ok').length,
                workers_late: hbs.filter(s => s === 'late').length,
                workers_down: hbs.filter(s => s === 'down' || s === 'noreport').length,
                last_event_id: maxEv, ts: Date.now() / 1000}
            }});
          } finally { db.close(); }
        } catch (e) {
          json(500, {ok: false, err: String(e && e.message || e)});
        }
      });
    }
  };
}

// platformApiPlugin: module-scoped read APIs. Each page owns its own data slice;
// a failing connector cannot take down the whole station snapshot.
function platformApiPlugin() {
  return {
    name: 'platform-modules',
    configureServer(server) {
      const json = (res, code, obj) => {
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(obj));
      };
      const withDb = async (res, fn) => {
        try {
          const {DatabaseSync} = await import('node:sqlite');
          const db = new DatabaseSync(HUB_DB, {readOnly: true});
          try { json(res, 200, {ok: true, data: fn(db)}); }
          finally { db.close(); }
        } catch (e) {
          json(res, 500, {ok: false, err: String(e && e.message || e)});
        }
      };
      server.middlewares.use('/api/platform/tasks', (req, res, next) => {
        // 完整 tasks 表（星图 10-20 六轮，用户令「要的是 tasks 表这个东西」）：按需拉取全表（含已完成），
        // 字段对齐 8331 引擎 overview_counts（schedule.py）——id/title/status/priority/due/source/source_ref/notes/…
        // connect use(path) 匹配后会把匹配前缀从 req.url 剥掉：/api/platform/tasks/full 在这里是 /full。
        // 放行给下一个 /full 专属中间件（完整 tasks 表），其余 /api/platform/tasks* 由本中间件处理。
        if (req.url.startsWith('/full')) return next();
        withDb(res, db => {
          // source_ref（星图 10-20 五轮）：带上任务来源行键，档案页「实际数据」可按 src{id} 追溯到具体来源文件
          // 10-21：attachSrcInfo 附 src_name/src_sheet/src_path——任务卡/详情显示「哪个 Excel 哪个页签」
          // 10-23：补 notes（与 /api/entities 同步，任务内容进轮询）
          const open = db.prepare(`SELECT id,title,status,priority,due,source,source_ref,notes,attachments,created_at,updated_at FROM tasks
                                   WHERE status IN (?,?,?,?,?) ORDER BY updated_at DESC`).all(...TASK_OPEN);
          attachSrcInfo(db, open);
          const doneToday = db.prepare(`SELECT id,title,done_at FROM tasks WHERE status='done'
                                        AND date(done_at)=date('now','localtime') ORDER BY done_at DESC`).all();
          const commands = db.prepare(`SELECT id,prompt,source,status,task_id,rerun_of,created_at,updated_at
                                       FROM commands WHERE is_deleted=0 ORDER BY id DESC LIMIT 60`).all();
          const events = db.prepare(`SELECT id,ts,kind,actor,action,detail,task_id FROM events
                                     ORDER BY id DESC LIMIT 40`).all();
          return {tasks: {open, done_today: doneToday}, commands, events};
        });
      });
      server.middlewares.use('/api/platform/tasks/full', (req, res) => withDb(res, db => {
        // 全任务表（含已完成，最近 500 条）：档案页「完整 tasks 表」按需拉一次，不进 30 秒轮询
        const rows = db.prepare(`SELECT id,title,status,priority,due,source,source_ref,notes,created_at,updated_at,done_at
                                 FROM tasks ORDER BY updated_at DESC, id DESC LIMIT 500`).all();
        attachSrcInfo(db, rows);
        return {tasks: rows};
      }));
      server.middlewares.use('/api/platform/decisions', (req, res) => withDb(res, db => {
        const decisions = db.prepare(`SELECT id,title,status,created_at,options FROM decisions
                                      WHERE status='pending' ORDER BY created_at`).all();
        for (const r of decisions) r.options = parseOpts(r.options);
        return {decisions};
      }));
      server.middlewares.use('/api/platform/services', (req, res) => withDb(res, db => {
        let entries = [];
        try { entries = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).workers || []; } catch {}
        const latest = new Map();
        for (const r of db.prepare('SELECT name, ts, expected_interval FROM heartbeats').all()) {
          const old = latest.get(r.name);
          if (old == null || (r.ts || 0) > (old.ts || 0)) latest.set(r.name, r);
        }
        return {workers: entries.map(w => {
          const hb = latest.get(w.id), iv = hb?.expected_interval || HB_DEFAULT_IV;
          return {id: w.id, name: w.name, type: w.type, emoji: w.emoji, desc: w.desc, ui: w.ui || null,
            retired: !!w.retired, hb_ts: hb?.ts ?? null, hb_state: hb ? hbState(hb.ts, iv) : 'noreport'};
        })};
      }));
      server.middlewares.use('/api/platform/vitals', (req, res) => withDb(res, db => {
        let workers = [];
        try { workers = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).workers || []; } catch {}
        const latest = new Map();
        for (const r of db.prepare('SELECT name, ts, expected_interval FROM heartbeats').all()) {
          const old = latest.get(r.name);
          if (old == null || (r.ts || 0) > (old.ts || 0)) latest.set(r.name, r);
        }
        const states = workers.filter(w => !w.retired).map(w => {
          const hb = latest.get(w.id);
          return hb ? hbState(hb.ts, hb.expected_interval || HB_DEFAULT_IV) : 'noreport';
        });
        return {
          open_tasks: db.prepare(`SELECT count(*) c FROM tasks WHERE status IN (?,?,?,?,?)`).get(...TASK_OPEN).c,
          pending_decisions: db.prepare(`SELECT count(*) c FROM decisions WHERE status='pending'`).get().c,
          review_tasks: db.prepare(`SELECT count(*) c FROM tasks WHERE status='review'`).get().c,
          active_alarms: db.prepare(`SELECT count(*) c FROM alarms WHERE status='active'`).get().c,
          workers_ok: states.filter(x => x === 'ok').length,
          workers_late: states.filter(x => x === 'late').length,
          workers_down: states.filter(x => x === 'down' || x === 'noreport').length,
          last_event_id: db.prepare('SELECT coalesce(max(id),0) m FROM events').get().m,
          ts: Date.now() / 1000
        };
      }));
      // 数据源实物（星图 10-20 用户令「数据来源指向实物」）：sources 表实况 + 文件存在性 +
      // tfssync 取新状态（变更集/最后成功/待补扫）——任务源头=TFS 工作区 Excel，此处直接给出实物。
      server.middlewares.use('/api/platform/sources', (req, res, next) => {
        // 写操作（来源管理：add/set/del/scan）走 /api/platform/sources/action → proxy 到引擎 8331 /api/source；
        // 本中间件只读，放行该路径避免前缀匹配截胡。
        if (req.url.startsWith('/api/platform/sources/action')) return next();
        return withDb(res, db => {
        const TFSYNC_STATE = 'D:/Portable/Documents/工作管理/LoopDeck/workers/tfssync/state.json';
        const sources = db.prepare(`SELECT id,name,kind,path,sheet,owner,enabled,last_scan_at,last_count,scan_min,cols,created_at
                                    FROM sources ORDER BY id`).all();
        for (const s of sources) { try { s.exists = fs.existsSync(s.path); } catch { s.exists = false; } }
        // 按来源通道的任务实时计数（10-21）：大白话「任务从哪来」直接显示 每条通道 多少条/未结几条
        const taskCounts = db.prepare(`SELECT source, COUNT(*) n, SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) open
                                       FROM tasks GROUP BY source ORDER BY n DESC`).all()
          .map(r => ({source: r.source, n: r.n, open: r.open}));
        let tfssync = null;
        try { tfssync = JSON.parse(fs.readFileSync(TFSYNC_STATE, 'utf8')); } catch {}
        return {sources, taskCounts, tfssync};
      })});
    }
  };
}

// ecosystemPlugin（批3 生态体检数据源，全只读）：/api/now-md 直读 brain/NOW.md 在办热状态；
// /api/schedule = Windows 计划任务清单（PowerShell UTF-8 输出，5 分钟缓存）+ LoopDeck recurring.json AI 定时。
const NOW_MD = 'D:/Portable/KnowledgeBase/brain/NOW.md';
const RECURRING = 'D:/Portable/Documents/工作管理/LoopDeck/tasks/recurring.json';
const DISPATCHER_PY = 'D:/Portable/Documents/工作管理/LoopDeck/hub/dispatcher.py';
const KBBAK_LATEST = 'D:/Portable/Documents/工作管理/LoopDeck/workers/kbbak/latest';
const KBBAK_ONEDRIVE = 'D:/DeltaBox/OneDrive - Delta Electronics, Inc/KBBackup/latest';
const WXWATCH_HEART = 'D:/Portable/Documents/工作管理/LoopDeck/workers/wxwatch/heart.log';
// 生态在线服务全景（与生态运行手册地址簿同源；星图自身直接标在线）
const ECO_PORTS = [
  {name: '星图', port: 5173, self: true, desc: 'vite dev + 7 只读中间件 + 引擎看护'},
  {name: '引擎宿主', port: 8331, desc: 'LoopDeck server.py --engines（写操作唯一入口+dispatcher）'},
  {name: 'kbserve 检索', port: 8342, desc: '知识库 RAG 检索（语义+关键词混合）'},
  {name: 'VPN路由', port: 8321, desc: 'VpnRouter（内网通道）'}
];
const tcpOk = (port, timeout = 800) => new Promise(res => {
  const s = net.connect({port, host: '127.0.0.1'});
  const done = ok => { s.destroy(); res(ok); };
  s.setTimeout(timeout, () => done(false));
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
});
const fmtTs = v => {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n > 1e11 ? n : n * 1000);
    const p = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return String(v || '').slice(0, 16);
};
const dirNewest = p => {
  try {
    let m = 0;
    // 含目录：kbbak 用 robocopy 保留源文件时间戳，文件 mtime=内容时间；目录 mtime=备份动作时间，
    // 取二者最大才是"备份多久没跑"的正确口径（10-23 实证：文件最新 10-11、目录 10-22 21:00）
    for (const f of fs.readdirSync(p)) {
      const st = fs.statSync(path.join(p, f));
      if (st.mtimeMs > m) m = st.mtimeMs;
    }
    return m ? fmtTs(m / 1000) : null;
  } catch { return null; }
};
function ecosystemPlugin() {
  return {
    name: 'eco-check',
    configureServer(server) {
      const json = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
      server.middlewares.use('/api/now-md', (req, res) => {
        try {
          const raw = fs.readFileSync(NOW_MD, 'utf8');
          const mt = fs.statSync(NOW_MD).mtime;
          json(res, 200, {ok: true, raw, mtime: mt.toISOString().slice(0, 16).replace('T', ' ')});
        }
        catch (e) { json(res, 200, {ok: false, err: String(e && e.message || e)}); }
      });
      let cache = null, cacheAt = 0;
      // 体检快照（模块级，vite 进程存活期内）：上次打开体检时的定时资产+在办数，供"变化对比"。
      let ecoPrev = null, ecoPrevAt = 0;
      const loadSchedule = () => new Promise(resolve => {
        // 「我的定时资产」口径（10-19 修，用户令"只显示自己手动建立的"）：旧逻辑=排除 \Microsoft\ 后全收，
        // 把 IT/第三方软件任务（Bitlocker Probe、OneDrive、Adobe 等）也当成"我的"。改为生态白名单前缀
        // （与引擎宿主 api/schedule.py SCHTASK_PREFIXES 同源扩充）；禁用的自建任务滤出计数，不入列。
        const MINE_PREFIX = ['LoopDeck', 'KnowledgeBase', 'MemoryCore', 'ZRunner', 'WxWatch', 'KBSearch',
          'VpnRouter', 'StarMap', 'WorkerKeeper', 'FeishuBridge', 'ClipAlpha', 'StallMonitor', 'OutlookMail', 'CodexRProxy'];
        const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ScheduledTask | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; '{0}|{1}|{2}|{3}' -f $_.TaskName, $_.TaskPath, $_.State, ([string]$i.NextRunTime) }`;
        execFile('powershell', ['-NoProfile', '-Command', ps], {timeout: 25000, maxBuffer: 4 * 1024 * 1024, windowsHide: true}, (err, out) => {
          const mine = [], systemNames = new Set();
          let disabledMine = 0;
          if (!err) for (const line of String(out).split(/\r?\n/)) {
            const [name, tpath, state, next] = line.split('|');
            if (!name || !name.trim()) continue;
            const row = {name: name.trim(), path: (tpath || '').trim(), state: (state || '').trim(), next: (next || '').trim()};
            if (row.path.startsWith('\\Microsoft\\')) { systemNames.add(row.name); continue; }
            if (!MINE_PREFIX.some(p => row.name.startsWith(p))) { systemNames.add(row.name); continue; }  // IT/第三方=系统自带口径
            if (row.state === 'Disabled') { disabledMine++; continue; }
            mine.push(row);
          }
          let recurring = [];
          try {
            const r = JSON.parse(fs.readFileSync(RECURRING, 'utf8')).tasks || {};
            recurring = Object.entries(r).map(([key, v]) => ({key, enabled: !!v.enabled, prompt: String(v.prompt || '').slice(0, 60)}));
          } catch {}
          resolve({ok: !err, tasks: mine.sort((a, b) => a.name.localeCompare(b.name)),
            system_count: systemNames.size, disabled_count: disabledMine, recurring,
            err: err ? String(err.message || err) : null});
        });
      });
      server.middlewares.use('/api/schedule', async (req, res) => {
        if (cache && Date.now() - cacheAt < 300000) return json(res, 200, cache);
        cache = await loadSchedule(); cacheAt = Date.now();
        json(res, 200, cache);
      });
      // /api/eco-live（10-23 生态体检实况，纯本地零 AI）：端口探测 + dispatcher 剧本实况（live 解析
      // dispatcher.py PLAYBOOKS 注册表，不用静态副本防漂移）+ 代谢节律最近结果 + 备份双份新鲜度 + 微信哨兵心跳。
      let liveCache = null, liveAt = 0;
      server.middlewares.use('/api/eco-live', async (req, res) => {
        if (liveCache && Date.now() - liveAt < 30000) return json(res, 200, liveCache);
        const playbooks = [];
        try {
          const src = fs.readFileSync(DISPATCHER_PY, 'utf8');
          // dispatcher.py 是 Python：布尔值 True/False 大写开头
          const re = /"([\w_]+)":\s*\{"name":\s*"([^"]+)",\s*"risk":\s*"(\w+)",\s*"routine":\s*(True|False)/g;
          for (const m of src.matchAll(re)) playbooks.push({id: m[1], name: m[2], risk: m[3], routine: m[4] === 'True'});
        } catch {}
        const out = {
          ports: ECO_PORTS.map(p => ({...p})),
          dispatcher: {interval_min: 15, last_beat: null, last_runs: []},
          playbooks,
          metabolism: {},
          backup: {kbbak: dirNewest(KBBAK_LATEST), kbbak_onedrive: dirNewest(KBBAK_ONEDRIVE)},
          wxwatch_heart: null,
          sources: []
        };
        await Promise.all(out.ports.map(async p => { if (!p.self) p.ok = await tcpOk(p.port); }));
        try {
          const {DatabaseSync} = await import('node:sqlite');
          const db = new DatabaseSync(HUB_DB, {readOnly: true});
          try {
            const hb = db.prepare(`SELECT ts FROM heartbeats WHERE name='dispatcher' ORDER BY ts DESC LIMIT 1`).get();
            out.dispatcher.last_beat = hb ? fmtTs(hb.ts) : null;
            out.dispatcher.last_runs = db.prepare(`SELECT ts, detail FROM events WHERE kind='dispatch' AND action='run'
                                                    ORDER BY ts DESC LIMIT 14`).all()
              .map(r => ({ts: fmtTs(r.ts), text: String(r.detail || '')}));
            // 代谢节律：每个关键剧本取最近一次结果（蒸馏/周同步/KB推送/记忆备份/备份新鲜度/中枢冒烟/体检门控/TFS取新）
            for (const key of ['memorycore_distill', 'memorycore_weeklysync', 'kb_git_push', 'zcode_mem_backup',
                               'kb_backup_check', 'smoke_test', 'syscheck_gate', 'tfssync', 'health_probe']) {
              const r = db.prepare(`SELECT ts, detail FROM events WHERE kind='dispatch' AND action='run'
                                    AND detail LIKE ? ORDER BY ts DESC LIMIT 1`).get('[' + key + ']%');
              if (r) out.metabolism[key] = {ts: fmtTs(r.ts), msg: String(r.detail || '').replace(/^\[[^\]]+\]/, '').slice(0, 140)};
            }
            out.sources = db.prepare(`SELECT id,name,sheet,enabled,last_scan_at,last_count FROM sources ORDER BY id`).all();
          } finally { db.close(); }
        } catch {}
        try { out.wxwatch_heart = fmtTs(fs.statSync(WXWATCH_HEART).mtime / 1000); } catch {}
        liveCache = {ok: true, ...out}; liveAt = Date.now();
        json(res, 200, liveCache);
      });
      // 体检对比基线：POST 记录当前快照（打开体检时调用），GET 返回上次快照与现在的 diff。
      // vite 重启后第一次=无基线，第二次打开起有对比。放内存不放盘——体检是"体感"不是台账。
      server.middlewares.use('/api/eco-baseline', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', c => { body += c; });
          req.on('end', () => {
            try { ecoPrev = JSON.parse(body); ecoPrevAt = Date.now(); json(res, 200, {ok: true}); }
            catch { json(res, 400, {ok: false}); }
          });
          return;
        }
        json(res, 200, {ok: true, prev: ecoPrev, prev_at: ecoPrevAt || null, now: Date.now()});
      });
    }
  };
}

// base 用相对路径，构建产物可以直接部署在任意子路径。
// server.proxy：所有外部服务只经 /api/platform/* 同源前缀进页面（模块化边界，UI 不认识 8331/8342）：
//   /api/platform/actions/* → 8331 引擎宿主（task/decide/command/attach/ops 写操作）
//   /api/platform/task-detail|attach-asset|engine-ping → 8331（任务详情/附件/探活）
//   /api/platform/engine-overview|engine-workers → 8331（引擎核心：实时队列/完成/告警 + 工作者活跃，生态体检用）
//   /api/platform/kb-search|kb-health → 8342 检索服务（语义/关键词混合查询）

// enginePlugin：vite 起服务时拉起工作站引擎宿主（web/server.py --engines）作子进程并全程看护。
// 2026-10-16 拍板：引擎并 :5173——保活链 StarMap-keep(2min)→vite→本子进程；子进程持 hub 单例锁，
// 双开后起者自动退出（无双引擎）；面板随进程自带 :8331=备用 UI。仅 dev server 生效（build 不拉引擎）。
const ENGINE_DIR = 'D:/Portable/Documents/工作管理/LoopDeck/web';
const ENGINE_PY = ['C:/Users/ocean.xu/AppData/Local/Programs/Python/Python312/pythonw.exe',
                   'D:/Portable/python312/pythonw.exe'];

function enginePlugin() {
  return {
    name: 'loopdeck-engine-sidecar',
    apply: 'serve',
    configureServer(server) {
      const py = ENGINE_PY.find(p => fs.existsSync(p));
      if (!py) { console.error('[engine] pythonw 不存在，引擎未启动'); return; }
      const out = fs.openSync(path.join(ENGINE_DIR, 'server_stdout.log'), 'a');
      const err = fs.openSync(path.join(ENGINE_DIR, 'server_stderr.log'), 'a');
      let child = null, lastStart = 0, stopped = false;
      // 拉起前先探 8331：已有活引擎（比如另一个 vite 实例——端口被占退化成"僵尸 vite"也会跑本插件）
      // 就不拉。Windows 下 http.server SO_REUSEADDR 双绑 8331 能共存，2026-10-21 实测双引擎竞态双过
      // 单例锁（调度器/闹钟双跑根因）；探活前置把竞态掐死在源头
      const engineAlive = () => new Promise(res => {
        const req = http.get('http://127.0.0.1:8331/api/ping', r => { res(r.statusCode === 200); r.resume(); });
        req.setTimeout(1500, () => { req.destroy(); res(false); });
        req.on('error', () => res(false));
      });
      const start = () => {
        lastStart = Date.now();
        engineAlive().then(alive => {
          if (stopped) return;
          if (alive) { console.log('[engine] 8331 已有活引擎，本实例不重复拉起'); return; }
          child = spawn(py, ['-X', 'utf8', path.join(ENGINE_DIR, 'server.py'), '--engines'], {
            cwd: ENGINE_DIR, stdio: ['ignore', out, err], windowsHide: true,
            env: Object.assign({}, process.env, {PYTHONUNBUFFERED: '1'})
          });
          child.on('exit', code => console.log(`[engine] sidecar 退出 code=${code}`));
          console.log(`[engine] sidecar 已拉起 pid=${child.pid}`);
        });
      };
      start();
      const timer = setInterval(() => {          // 看护：子进程死了 ≥60s 后重拉，防崩溃环
        if (stopped || (child && child.exitCode === null)) return;
        if (Date.now() - lastStart < 60000) return;
        start();
      }, 30000);
      const stop = () => {
        stopped = true;
        clearInterval(timer);
        if (child && child.exitCode === null) { try { child.kill(); } catch (e) {} }
      };
      server.httpServer.on('close', stop);
      process.on('exit', stop);
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [kbGraphPlugin(), memoryStatePlugin(), detailPlugin(), platformApiPlugin(), entitiesPlugin(), ecosystemPlugin(), enginePlugin()],
  server: {
    watch: {ignored: ['**/.artifacts/**', '**/.vite/**']},
    proxy: {
      '/api/platform/actions/task': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/actions\/task/, '/api/task')},
      '/api/platform/actions/decide': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/actions\/decide/, '/api/decide')},
      '/api/platform/actions/command': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/actions\/command/, '/api/command')},
      '/api/platform/actions/attach': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/actions\/attach/, '/api/attach')},
      '/api/platform/actions/ops': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/actions\/ops/, '/api/action')},
      '/api/platform/task-detail': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/task-detail/, '/api/task')},
      '/api/platform/attach-asset': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/attach-asset/, '/attach')},
      '/api/platform/engine-ping': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/engine-ping/, '/api/ping')},
      '/api/platform/engine-overview': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/engine-overview/, '/api/overview')},
      '/api/platform/engine-workers': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/engine-workers/, '/api/workers')},
      '/api/platform/kb-search': {target: 'http://127.0.0.1:8342', rewrite: p => p.replace(/^\/api\/platform\/kb-search/, '/search')},
      '/api/platform/kb-ask': {target: 'http://127.0.0.1:8342', rewrite: p => p.replace(/^\/api\/platform\/kb-ask/, '/ask')},
      '/api/platform/kb-health': {target: 'http://127.0.0.1:8342', rewrite: p => p.replace(/^\/api\/platform\/kb-health/, '/healthz')},
      '/api/platform/source-op': {target: 'http://127.0.0.1:8331', rewrite: p => p.replace(/^\/api\/platform\/source-op/, '/api/source')}
    }
  }
});
