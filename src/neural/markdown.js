// 轻量 markdown 渲染（R21）：为"阅读全文"弹窗服务。
// 安全模型：笔记原文只做转义，输出里所有标签都是本文件生成的——不回灌笔记里的原始 HTML。
// 支持：标题/粗斜体/删除线/行内代码/代码块/引用/有序无序列表（缩进分级）/表格/分割线/
//       链接（仅 http(s)）/图片 ![](相对路径) 与 ![[图.png]]（经 /api/kb-asset 从 KB 取）/[[双链]] 可点跳转。

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

export function stripFrontmatter(raw) {
  const src = String(raw).replace(/^\uFEFF/, '');   // 去 BOM：否则 ^--- 匹配不到，frontmatter 会漏进正文
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return {meta: {}, body: src};
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const arr = m[1].match(/^tags\s*:\s*\r?\n((?:\s+-\s.*\r?\n?)+)/m);
  if (arr) meta.tags = arr[1].split(/\r?\n/).map(x => x.replace(/^\s+-\s*/, '').trim()).filter(Boolean).join(',');
  return {meta, body: src.slice(m[0].length)};
}

// KB 相对路径 → /api/kb-asset 图片地址（外链/data: 原样放行，让浏览器自己处理）
export const assetUrl = (dir, p) => {
  p = String(p).replace(/\\/g, '/').trim().replace(/^\.?\//, '');
  if (/^(https?:)?\/\//i.test(p) || p.startsWith('data:')) return p;
  const rel = (dir ? dir + '/' : '') + p;
  return '/api/kb-asset?p=' + rel.split('/').map(encodeURIComponent).join('/');
};

// 行内元素：单遍组合正则，避免"后一步替换改到前一步生成的标签"。
const INLINE = /(`[^`\n]+`)|(!\[\[[^\]\n]+\]\])|(!\[[^\]\n]*\]\([^)\n]+\))|(\[\[[^\]\n]+\]\])|(\[[^\]\n]*\]\((?:https?:\/\/|\/)[^)\n]+\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\s][^*\n]*\*)|(_[^_\s][^_\n]*_)/g;

function inline(text, res) {
  let out = '', last = 0;
  for (const m of String(text).matchAll(INLINE)) {
    out += esc(text.slice(last, m.index));
    const [full] = m;
    if (m[1]) out += `<code>${esc(m[1].slice(1, -1))}</code>`;
    else if (m[2]) {                                    // ![[嵌入]]：图片走 asset，笔记当双链
      const name = m[2].slice(3, -2).split('|')[0].trim();
      if (IMG_EXT.test(name)) { out += `<img src="${assetUrl(res.dir, name)}" alt="${esc(name)}" loading="lazy"/>`; res.images++; }
      else out += `<span class="md-wiki" data-wiki="${esc(name.replace(/\.md$/, ''))}">${esc(name)}</span>`;
    } else if (m[3]) {                                  // ![alt](path)
      const im = m[3].match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      out += `<img src="${assetUrl(res.dir, im[2])}" alt="${esc(im[1])}" loading="lazy"/>`; res.images++;
    } else if (m[4]) {                                  // [[双链]]
      const t = m[4].slice(2, -2).split('|');
      const target = t[0].split('#')[0].split('/').pop().replace(/\.md$/, '').trim();
      out += `<span class="md-wiki" data-wiki="${esc(target)}">${esc((t[1] || t[0]).trim())}</span>`;
    } else if (m[5]) {                                  // [text](http…)
      const lk = m[5].match(/^\[([^\]]*)\]\(([^)]+)\)$/);
      out += `<a href="${esc(lk[2])}" target="_blank" rel="noreferrer noopener">${esc(lk[1] || lk[2])}</a>`;
    } else if (m[6]) out += `<strong>${esc(m[6].slice(2, -2))}</strong>`;
    else if (m[7]) out += `<strong>${esc(m[7].slice(2, -2))}</strong>`;
    else if (m[8]) out += `<del>${esc(m[8].slice(2, -2))}</del>`;
    else if (m[9]) out += `<em>${esc(m[9].slice(1, -1))}</em>`;
    else if (m[10]) out += `<em>${esc(m[10].slice(1, -1))}</em>`;
    last = m.index + full.length;
  }
  return out + esc(text.slice(last));
}

export function renderMarkdown(body, dir) {
  const res = {dir, images: 0};
  const lines = String(body).replace(/\r\n?/g, '\n').split('\n');
  let html = '', i = 0;
  const para = [];
  const flush = () => { if (para.length) { html += `<p>${inline(para.join(' '), res)}</p>`; para.length = 0; } };
  const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  while (i < lines.length) {
    const L = lines[i];
    if (/^```/.test(L)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    const h = L.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); const n = h[1].length; html += `<h${n}>${inline(h[2], res)}</h${n}>`; i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(L)) { flush(); html += '<hr/>'; i++; continue; }
    if (/^>\s?/.test(L)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${inline(buf.join(' '), res)}</blockquote>`;
      continue;
    }
    if (/^\s*\|.+\|\s*$/.test(L) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const head = cells(L);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      html += '<table><thead><tr>' + head.map(c => `<th>${inline(c, res)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c, res)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
      continue;
    }
    const li = L.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        items.push({level: Math.min(2, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), text: m[3]});
        i++;
      }
      const tag = /\d/.test(li[2][0]) ? 'ol' : 'ul';
      html += `<${tag}>` + items.map(it => `<li${it.level ? ` class="lv${it.level}"` : ''}>${inline(it.text, res)}</li>`).join('') + `</${tag}>`;
      continue;
    }
    if (!L.trim()) { flush(); i++; continue; }
    para.push(L.trim());
    i++;
  }
  flush();
  return {html, images: res.images};
}

// 详情栏封面用：正文里第一张图的 asset 地址（没有图返回 null）
export function firstImage(body, dir) {
  const m = String(body).match(/!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\(([^)\n]+)\)/);
  if (!m) return null;
  const name = (m[1] || m[2] || '').split('|')[0].trim();
  return IMG_EXT.test(name) ? assetUrl(dir, name) : null;
}
