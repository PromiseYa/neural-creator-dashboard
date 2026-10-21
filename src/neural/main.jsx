import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {taskAction, decideAction, panelAction, cmdAction, attachAction, wvFocus, wvBlur} from '../data/live';
import {usePlatform} from '../platform/usePlatform';
import {PLATFORM_MODULES} from '../platform/modules';
import {CONFIG, asset} from '../config';
import {buildGraph, forceLayout, stats, KINDS, STATUS_ZH, PRIO_ZH} from './graph';
import {renderMarkdown, stripFrontmatter} from './markdown';
import {Home} from './Home';
import {Lightbox, TaskContent, TaskExtra, SRC_ZH, DuePick} from './Analysis';
import {Icon} from './icons';
import './neural.css';

// 生态星图：数据来自工作站实体(8331)+KB 现场扫描+服务探测，30 秒轮询刷新。
// noCopy（星图 10-20）：弹窗自带更贴题的复制按钮时（如阅读全文的"复制全文"=正文原文），
// 关掉 header 这颗通用"复制本卡"——同一标题栏不再出现两颗复制图标。
function Modal({title, en, onClose, children, wide, actions, noCopy}) {
  const ref = useRef(null), closeRef = useRef(onClose);
  // 拖选文字防误关（10-18）：在弹窗内按住拖选、松手划出到遮罩上时，click 落到 veil 会整窗关掉、
  // 选区白选。记录 mousedown 是否起于遮罩空白——只有按下与松开都在遮罩上才算"点空白关闭"。
  const downOnVeil = useRef(false);
  // 一键复制（10-19 用户令"弹出的卡片文字没法选择复制"）：壁纸 WebView2 的鼠标是宿主合成转发的，
  // 原生拖选天然不工作（与壁纸模式打不了中文同根，10-18 的 user-select: text 只救得了普通浏览器）。
  // 每个 Modal header 常备复制按钮：整卡文字直接进剪贴板，不依赖选择手势。
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);
  const copyCard = async () => {
    const text = (ref.current?.innerText || '').trim();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1800);
  };
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus({preventScroll: true});
    const key = e => {
      if (e.key === 'Escape' && !e.isComposing) closeRef.current();
      if (e.key === 'Tab') {
        const list = [...ref.current.querySelectorAll('button,input,textarea,select,a[href]')].filter(n => !n.disabled);
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (before?.isConnected) before.focus(); };
  }, []);
  return <div className="veil" onMouseDown={e => { downOnVeil.current = e.target === e.currentTarget; }}
    onClick={e => { if (downOnVeil.current && e.target === e.currentTarget) onClose(); }}>
    <section ref={ref} tabIndex={-1} className={`modal glass ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
      <header><h2>{title} <em>{en}</em></h2><div className="modal-actions">
        {actions}
        {!noCopy && <button className="icon-btn" onClick={copyCard} aria-label="复制本卡全部文字" title="复制本卡全部文字（壁纸模式拖选不动，用这颗按钮）">{copied ? <Icon name="check" size={16}/> : <Icon name="copy" size={16}/>}</button>}
        <button className="icon-btn" onClick={onClose} aria-label="关闭弹窗"><Icon name="close" size={16}/></button>
      </div></header>
      {children}
    </section>
  </div>;
}

// 阅读全文（R21 → 10-18 大扩容）：笔记/记忆拉全文渲染 markdown；任务拉 task-detail（正文/就地编辑/
// 附件/时间线，"像知识库一样查看全文的方式显示编辑内容"）；拍板拉 hub-detail（方案/理由/影响全文）；
// 指令用图谱自带数据。通用：[[双链]] 点击直接进目标内容自己的阅读全文（带"返回上一篇"栈，不再退回
// 图谱再点一次）；正文/附件图片点击灯箱放大（滚轮缩放/拖拽平移）；右上"复制全文"一键复制原文。
function Reader({node, graph, onJump, onBack, canBack, onTaskOp, onClose}) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  const [zoom, setZoom] = useState(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(null);   // 任务就地编辑：{note:'…'} / {due:'YYYY-MM-DD'}
  const isTask = node.kind === 'task';
  const isDecision = node.kind === 'decision';
  const isCommand = node.kind === 'command';
  // txt 命中（EAP 排错记录/defer 包等）按纯文本展示，不走 markdown——单换行成段、日志缩进原样保留
  const isTxt = node.kind === 'note' && /\.txt$/i.test(node.path || '');
  useEffect(() => {
    let stop = false;
    setData(null); setErr(false); setEditing(null);
    if (isCommand) return;   // 指令数据图谱已带全（prompt/result），不拉详情
    // note 的图谱 id 带 note: 前缀，接口要 KB 相对路径；memory 走 ZCode memory 目录全文接口（按文件名）
    const url = node.kind === 'memory'
      ? `/api/mem-raw?id=${encodeURIComponent(node.memory?.md || '')}`
      : isTask ? `/api/platform/task-detail?id=${encodeURIComponent(node.task?.id || '')}`
      : isDecision ? `/api/hub-detail?d=${encodeURIComponent(node.decision?.id || '')}`
      : `/api/note-raw?id=${encodeURIComponent(node.path || String(node.id).replace(/^note:/, ''))}`;
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status)))
      .then(d => { if (!stop && d?.ok) setData(d); else if (!stop) setErr(true); })
      .catch(() => { if (!stop) setErr(true); });
    return () => { stop = true; };
  }, [node.id]);

  const {meta, body} = useMemo(() => data && (node.kind === 'note' || node.kind === 'memory')
    ? stripFrontmatter(data.raw || '') : {meta: {}, body: ''}, [data, node.kind]);
  const rendered = useMemo(() => (node.kind === 'note' || node.kind === 'memory') && data && !isTxt
    ? renderMarkdown(body, data.dir) : null, [data, body, node.kind, isTxt]);
  const tags = useMemo(() => String(meta.tags || '').replace(/^\[|\]$/g, '').split(/[,，]/).map(s => s.trim()).filter(Boolean), [meta]);
  const task = isTask ? (data?.task || node.task || {}) : {};
  const dec = isDecision ? (data?.row || {}) : {};
  const cm = isCommand ? (node.command || {}) : {};

  // 复制全文的原文：笔记/记忆=markdown 正文；任务=notes 全文；拍板/指令=结构化拼接
  const fullText = useMemo(() => {
    if (node.kind === 'note' || node.kind === 'memory') return body;
    if (isTask) return String(task.notes || '');
    if (isDecision) return [dec.title && `【拍板事项】${dec.title}`, dec.proposal && `【方案】${dec.proposal}`,
      dec.why && `【理由】${dec.why}`, dec.impact && `【影响】${dec.impact}`].filter(Boolean).join('\n\n');
    if (isCommand) return [cm.prompt && `【指令】${cm.prompt}`, cm.result && `【结果】${cm.result}`].filter(Boolean).join('\n\n');
    return '';
  }, [node.kind, body, task.notes, dec, cm]);
  const copyAll = async () => {
    const text = String(fullText || '');
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  // [[双链]] 目标解析（星图 10-18 三轮扩容）：不只笔记——记忆（标题/memory.id/md 文件名）、
  // 任务（T-xxx 或全标题）、拍板（D-xxx）、指令（M-xxx）都能直达各自的阅读全文；未命中保持打开
  const findTarget = want => {
    const w = String(want || '').trim().toLowerCase();
    if (!w) return null;
    let n = graph.nodes.find(x => x.kind === 'note' && (String(x.title).toLowerCase() === w || String(x.path || '').toLowerCase().endsWith(w + '.md')));
    if (n) return n;
    n = graph.nodes.find(x => x.kind === 'memory' && (String(x.title).toLowerCase() === w || String(x.memory?.id || '').toLowerCase() === w
      || String(x.memory?.md || '').toLowerCase().replace(/\.md$/, '') === w));
    if (n) return n;
    return graph.nodes.find(x =>
      (x.kind === 'task' && (String(x.task?.id).toLowerCase() === w || String(x.title).toLowerCase() === w))
      || (x.kind === 'decision' && String(x.decision?.id).toLowerCase() === w)
      || (x.kind === 'command' && String(x.command?.id).toLowerCase() === w)) || null;
  };

  // 正文点击委托：图片→灯箱放大；[[双链]]→直达目标阅读全文。
  // 星图 10-18 三轮「双击选词」：跳转延迟 260ms 且双击（e.detail>1 / dblclick）取消——
  // 双击选中链接文字不再误触跳转；原版"未命中就关弹窗"太突兀，改为保持打开
  const jumpTimer = useRef(null);
  useEffect(() => () => clearTimeout(jumpTimer.current), []);
  const click = e => {
    const img = e.target.closest?.('img');
    if (img?.src) { setZoom(img.src); return; }
    const b = e.target.closest?.('[data-wiki]');
    if (!b || e.detail > 1) return;
    const want = b.dataset.wiki;
    clearTimeout(jumpTimer.current);
    jumpTimer.current = setTimeout(() => {
      let n = findTarget(want);
      if (!n) {
        // 图谱里没有（记忆池只挂 12 条降级候选）：合成记忆伪节点惰性拉原文——
        // ZCode 记忆全库都在 mem-raw 索引里，取不到时 Reader 内显式报"读取失败"也不闪退
        n = {id: 'mem:' + want, kind: 'memory', title: want, short: want, memory: {id: want, md: want + '.md'}};
      }
      onJump(n);   // 直接传节点对象：伪节点不在 graph.index 里，按 id 查会丢
    }, 260);
  };
  const cancelJump = () => clearTimeout(jumpTimer.current);

  const title = node.short || node.title;
  // noCopy：正文原文复制用自带的 rd-copy，header 的通用"复制本卡"撤下（星图 10-20 用户令"清理一个"）
  return <Modal title={String(title).slice(0, 60)} en={KINDS[node.kind].en} onClose={onClose} wide noCopy
    actions={<>
      {canBack && <button className="icon-btn rd-back" onClick={onBack} aria-label="返回上一篇" title="返回上一篇"><Icon name="back" size={15}/></button>}
      <button className="icon-btn rd-copy" onClick={copyAll} aria-label="复制全文" title="复制全文（正文原文）"
        disabled={!String(fullText || '').trim()}>{copied ? <Icon name="check" size={15}/> : <Icon name="copy" size={15}/>}</button>
    </>}>
    <div className="reader" onClick={click} onDoubleClick={cancelJump}>
      {/* 元信息行：各类型自己的身份与状态 */}
      <p className="md-meta">
        {node.kind === 'memory' && <span className="quiet">memorycore · {node.memory?.id || ''}</span>}
        {node.kind === 'note' && <span className="quiet">{node.path}</span>}
        {isTask && <>
          <span className="quiet">{task.id}</span>
          <span className="chip static mini" style={{'--kc': 'var(--acc, #9fc37c)'}}>{STATUS_ZH[task.status] || task.status}</span>
          <span className="chip static mini">优先级 {PRIO_ZH[task.priority] || task.priority}</span>
          {task.due && <span className="chip static mini">截止 {task.due}</span>}
          <span className="chip static mini">{SRC_ZH[task.source] || task.source || '—'}</span>
        </>}
        {isDecision && <>
          <span className="quiet">{dec.id || node.decision?.id}</span>
          <span className="chip static mini">{dec.status || node.decision?.status || 'pending'}</span>
        </>}
        {isCommand && <>
          <span className="quiet">{cm.id}</span>
          <span className="chip static mini">{cm.status || '—'}</span>
          <span className="chip static mini">{SRC_ZH[cm.source] || cm.source || '—'}</span>
        </>}
        {(meta.updated || node.updated) && <span className="chip static mini">更新 {(meta.updated || node.updated)}</span>}
        {meta.created && <span className="chip static mini">建于 {meta.created}</span>}
        {body && <span className="chip static mini">{body.replace(/\s/g, '').length} 字</span>}
        {isTask && task.notes && <span className="chip static mini">{String(task.notes).replace(/\s/g, '').length} 字</span>}
        {rendered?.images > 0 && <span className="chip static mini">{rendered.images} 图</span>}
        {tags.map(t => <span key={t} className="chip static mini tag">#{t}</span>)}
      </p>
      {err && <p className="quiet">全文读取失败（本地文件或引擎宿主不可达）。</p>}
      {!data && !err && !isCommand && <p className="quiet">读取全文…</p>}

      {/* 笔记 / 记忆：markdown 全文 */}
      {rendered && <article className="reader-md" dangerouslySetInnerHTML={{__html: rendered.html}}/>}
      {/* 纯文本命中（.txt）：原样展示 */}
      {isTxt && data && <article className="reader-md"><pre className="rd-plain">{body}</pre></article>}

      {/* 拍板：方案/理由/影响全文（markdown 渲染，与笔记同观感） */}
      {isDecision && data && <article className="reader-md">
        {dec.title && <h2>{dec.title}</h2>}
        {dec.proposal && <><h3>方案 <em>Proposal</em></h3><div dangerouslySetInnerHTML={{__html: renderMarkdown(String(dec.proposal), '').html}}/></>}
        {dec.why && <><h3>拍板理由 <em>Why</em></h3><div dangerouslySetInnerHTML={{__html: renderMarkdown(String(dec.why), '').html}}/></>}
        {dec.impact && <><h3>影响与代价 <em>Impact</em></h3><div dangerouslySetInnerHTML={{__html: renderMarkdown(String(dec.impact), '').html}}/></>}
        {(dec.options?.length || node.decision?.options?.length) && <><h3>备选方案 <em>Options</em></h3>
          <ul>{(dec.options || node.decision.options).map((o, i) => <li key={i}><b>{o.key || String.fromCharCode(65 + i)}</b>　{o.text || o}</li>)}</ul></>}
        {(dec.status && dec.status !== 'pending') && <p className="quiet">已按「{dec.status}」收口{dec.choice ? ` · 方案 ${dec.choice}` : ''}{dec.decided_at ? ` · ${String(dec.decided_at).slice(0, 16)}` : ''}</p>}
      </article>}
      {isDecision && !data && !err && <p className="quiet">读取全文…</p>}

      {/* 指令：prompt/result 全文 */}
      {isCommand && <article className="reader-md">
        <h3>指令内容 <em>Prompt</em></h3><p>{cm.prompt || '（空指令）'}</p>
        {String(cm.result || '').trim() && <><h3>执行结果 <em>Result</em></h3><p>{cm.result}</p></>}
      </article>}

      {/* 任务：正文（内嵌图片解析）+ 就地编辑 + 执行现场（附件/时间线） */}
      {isTask && data && <>
        <article className="reader-md">
          <h3>任务内容 <em>Content</em></h3>
          <TaskContent tid={task.id} text={task.notes} onZoom={setZoom}/>
        </article>
        <section className="rd-edit">
          <h3>编辑 <em>Edit</em></h3>
          {editing?.note !== undefined ? <>
            <textarea rows={6} value={editing.note} onChange={e => setEditing({note: e.target.value})} onFocus={wvFocus} onBlur={wvBlur} placeholder="补充说明/处理结果写这里…" aria-label="编辑任务内容"/>
            <div className="confirm-actions">
              <button className="primary" onClick={() => {
                onTaskOp({type: 'taskOp', id: task.id, op: 'note', note: editing.note});
                setData(d => ({...d, task: {...(d?.task || {}), notes: editing.note}}));   // 乐观更新，30 秒轮询兜底
                setEditing(null);
              }}>保存内容 <em>Save</em></button>
              <button onClick={() => setEditing(null)}>取消 <em>Cancel</em></button>
            </div>
          </> : <button className="ghost te-btn" onClick={() => setEditing({note: task.notes || ''})}>✎ 编辑任务内容 <em>Edit</em></button>}
          {editing?.due !== undefined ? <>
            <DuePick date={editing.due} time={''} onDate={v => setEditing({due: v})}
              onTime={() => {}} bare/>
            <div className="confirm-actions">
              <button className="primary" onClick={() => {
                onTaskOp({type: 'taskOp', id: task.id, op: 'due', due: editing.due || ''});
                setData(d => ({...d, task: {...(d?.task || {}), due: editing.due || null}}));
                setEditing(null);
              }}>保存截止 <em>Save</em></button>
              <button onClick={() => setEditing(null)}>取消 <em>Cancel</em></button>
            </div>
          </> : <button className="ghost te-btn" onClick={() => setEditing({due: String(task.due || '').slice(0, 10)})}>◷ 调截止 <em>Due</em>{task.due ? ` · ${String(task.due).slice(0, 10)}` : ''}</button>}
        </section>
        <TaskExtra tid={task.id} detail={data} onZoom={setZoom}/>
      </>}
    </div>
    {zoom && <Lightbox src={zoom} onClose={() => setZoom(null)}/>}
  </Modal>;
}

// （DuePick/iso/shiftDay 已上移 Analysis.jsx 导出，右侧面板编辑区与本弹窗共用一份实现）

// ＋新建任务（10-16 批1 → 10-18 升级）：标题/优先级/截止（自绘日期+时间）/到期提醒/备注 + 截图粘贴——
// task_add 走引擎宿主 actions（hub.add_task 同写路径），附件逐张 /api/attach（图片触发后台视觉解析回填）；
// 填了日期+时间且提醒开着 → 同步建一条 once 闹钟（title="T-xxx 任务名"），到点电脑弹通知+推微信，
// 默认每 10 分钟重推、共 3 次（可调）——任务完成时引擎自动关掉这条闹钟。
function TaskModal({onClose, onDone}) {
  const [title, setTitle] = useState('');
  const [prio, setPrio] = useState('mid');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [remind, setRemind] = useState(true);
  const [rmin, setRmin] = useState(10);
  const [rn, setRn] = useState(3);
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const addFiles = list => {
    for (const f of Array.from(list || [])) {
      if (!/^(image|video)\//.test(f.type || '')) continue;
      if (f.size > 60 * 1024 * 1024) continue;
      const r = new FileReader();
      r.onload = () => setFiles(prev => [...prev, {name: f.name || `粘贴_${Date.now()}.png`, b64: String(r.result).split(',')[1] || ''}]);
      r.readAsDataURL(f);
    }
  };
  const dateOk = dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate);
  const timeOk = /^\d{2}:\d{2}$/.test(dueTime);
  const alarmOn = remind && dateOk && timeOk;
  const submit = async () => {
    if (!title.trim() || busy) return;
    if (dueDate && !dateOk) { setErr('日期格式应为 YYYY-MM-DD（或点快捷按钮）'); return; }
    if (remind && dateOk && !timeOk) { setErr('开了到期提醒需选时间（时:分），不提醒可把时间留"全天"'); return; }
    setBusy(true); setErr('');
    try {
      const r = await panelAction('task_add', {title: title.trim(), source: 'star-map', prio, due: dateOk ? dueDate : null, notes: notes.trim() || null});
      if (!r?.ok || !r.id) { setErr(r?.error || r?.msg || '建任务失败'); setBusy(false); return; }
      for (const f of files) await attachAction({id: r.id, name: f.name, data_b64: f.b64}).catch(() => {});
      let alarmMsg = '';
      if (alarmOn) {   // 到期提醒：闹钟与任务同号前缀（T-xxx 任务名），完成时引擎自动清
        const ar = await panelAction('alarm_add', {title: `${r.id} ${title.trim()}`, kind: 'once',
          at: `${dueDate} ${dueTime}`, repeat_min: rmin, repeat_n: rn}).catch(() => null);
        alarmMsg = ar?.ok ? `，到期提醒 ${dueDate} ${dueTime}（每 ${rmin} 分×${rn} 次）` : '（提醒创建失败，任务已建好）';
      }
      onDone(r.id, files.length, alarmMsg);
    } catch { setErr('写接口不可达（引擎宿主）'); setBusy(false); }
  };
  return <Modal title="新建任务" en="New task" onClose={onClose}>
    <div className="form-box" onPaste={e => { addFiles(e.clipboardData?.files); }}>
      <label>标题 <em>必填</em><input value={title} onChange={e => setTitle(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="一句话说清要做什么…" autoFocus/></label>
      <div className="form-row">
        <label>优先级
          {/* 星图 10-18 五轮：原生 select 的下拉/底色是 OS 画的（壁纸里白底看不清），全改自绘片格 */}
          <span className="opt-row">
            {[['high', '高'], ['mid', '中'], ['low', '低']].map(([v, zh]) =>
              <button type="button" key={v} className={'opt-chip' + (prio === v ? ' on pri-' + v : '')}
                onClick={() => setPrio(v)} aria-pressed={prio === v}>{zh}</button>)}
          </span>
        </label>
        <label>截止{!remind ? '（日期）' : '（日期＋提醒时间）'}<DuePick date={dueDate} time={dueTime} onDate={setDueDate} onTime={setDueTime}/></label>
      </div>
      <label className="alarm-row">
        <input type="checkbox" checked={remind} onChange={e => setRemind(e.target.checked)}/>
        <span className="ar-main"><Icon name="bell" size={14}/> 到期电脑弹通知＋推微信</span>
        {remind && <>
          <span className="ar-opt">每
            <span className="opt-row">
              {[5, 10, 15, 20, 30, 60].map(v =>
                <button type="button" key={v} className={'opt-chip sm' + (rmin === v ? ' on' : '')}
                  onClick={() => setRmin(v)} aria-pressed={rmin === v}>{v}</button>)}
            </span>分钟</span>
          <span className="ar-opt">共
            <span className="opt-row">
              {[1, 2, 3, 4, 5].map(v =>
                <button type="button" key={v} className={'opt-chip sm' + (rn === v ? ' on' : '')}
                  onClick={() => setRn(v)} aria-pressed={rn === v}>{v}</button>)}
            </span>次</span>
        </>}
        {remind && !alarmOn && <em className="ar-hint">选好日期＋时间后生效</em>}
      </label>
      <label>备注<textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="补充说明、把握、回滚点…"/></label>
      <label>截图/视频附件
        <div className="paste-zone">
          <input type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm" onChange={e => addFiles(e.target.files)} onFocus={wvFocus} onBlur={wvBlur}/>
          <p className="quiet">点选择文件，或在弹窗内直接 Ctrl+V 粘贴截图（图片上传后自动视觉解析回填任务内容）</p>
          {files.length > 0 && <div className="paste-files">{files.map((f, i) => <span key={i} className="chip static">{f.name}<button onClick={() => setFiles(files.filter((_, k) => k !== i))} aria-label="移除">×</button></span>)}</div>}
        </div>
      </label>
      {window.chrome?.webview && <button type="button" className="win-open" onClick={() => window.open(location.href, '_blank')}>壁纸模式打不了中文 · 在窗口中打开<Icon name="outlink" size={11}/></button>}
      {err && <p className="form-err">{err}</p>}
      <div className="confirm-actions">
        <button className="primary" disabled={!title.trim() || busy} onClick={submit}>{busy ? '提交中…' : '记入任务池'} <em>Add</em></button>
        <button onClick={onClose}>取消 <em>Cancel</em></button>
      </div>
    </div>
  </Modal>;
}

// ＋登记拍板（10-16 批1）：三门槛落账走 hub.decide add 同路径，落账即推微信（hub 内建）。
function DecisionModal({onClose, onDone}) {
  const [title, setTitle] = useState('');
  const [proposal, setProposal] = useState('');
  const [why, setWhy] = useState('');
  const [impact, setImpact] = useState('');
  const [opts, setOpts] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true); setErr('');
    const opt = opts.split(/\n+/).map(s => s.trim()).filter(Boolean);
    try {
      const r = await panelAction('decide_add', {title: title.trim(), proposal: proposal.trim(), why: why.trim(), impact: impact.trim(), opt: opt.length ? opt : null});
      if (!r?.ok) { setErr(r?.error || r?.msg || '落账失败'); setBusy(false); return; }
      onDone(r.msg || '已落账并推微信');
    } catch { setErr('写接口不可达（引擎宿主）'); setBusy(false); }
  };
  return <Modal title="登记拍板" en="New decision" onClose={onClose}>
    <div className="form-box">
      <p className="eco-intro">拍板=AI 干活拿不准、需要你拿主意的事：AI 收尾没有答案、不拍板就动不了、且有实际代价（三门槛）才落账到这里，成 D-xxx 编号并即时推微信；你批准后自动建任务派 AI 执行。日常一般不用手填——这条表单是补录入口。</p>
      <label>拍板事项 <em>必填</em><input value={title} onChange={e => setTitle(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="要拍什么板，一句话" autoFocus/></label>
      <label>方案<textarea rows={3} value={proposal} onChange={e => setProposal(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="推荐方案全文…"/></label>
      <div className="form-row">
        <label>拍板理由<textarea rows={2} value={why} onChange={e => setWhy(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="为什么是这个方案"/></label>
        <label>影响与代价<textarea rows={2} value={impact} onChange={e => setImpact(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="不做/做的代价"/></label>
      </div>
      <label>备选方案（每行一个，格式 A|描述）<textarea rows={2} value={opts} onChange={e => setOpts(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder={'A|描述一\nB|描述二'}/></label>
      {err && <p className="form-err">{err}</p>}
      <div className="confirm-actions">
        <button className="primary" disabled={!title.trim() || busy} onClick={submit}>{busy ? '提交中…' : '落账并推微信'} <em>Add</em></button>
        <button onClick={onClose}>取消 <em>Cancel</em></button>
      </div>
    </div>
  </Modal>;
}

// 生态体检 2.0（10-18）：结论先行 + 变化对比 + 只看我建的定时资产 + 当前在办结构化。
// 设计原则：体检不是资产清单——打开第一眼是"结论"，往下才是证据；
// 与上次体检对比出"变了什么"，才是它代替晨检/日报的价值。
function EcoCheckModal({onClose, eco}) {
  const [d, setD] = useState(null);
  const [prev, setPrev] = useState(null);
  const snapRef = useRef(null);   // 关闭时 POST 给 /api/eco-baseline 作下次对比基线
  useEffect(() => {
    let stop = false;
    Promise.all([
      fetch('/api/schedule').then(r => r.json()).catch(() => null),
      fetch('/api/now-md').then(r => r.json()).catch(() => null),
      fetch('/api/eco-baseline').then(r => r.json()).catch(() => null)
    ]).then(([sch, now, base]) => {
      if (stop) return;
      setD({sch, now}); setPrev(base?.prev || null);
      // 基线内容 = 定时任务名集合 + 在办条数 + 常驻工作者在线数（group=worker 投影口径，防对比口径漂移）
      const rsOk = (eco?.services || []).filter(s => s.group === 'worker' && s.state === 'ok').length;
      snapRef.current = {
        ts: Date.now(),
        tasks: (sch?.tasks || []).map(t => t.name),
        recurring: (sch?.recurring || []).filter(r => r.enabled).map(r => r.key),
        now_lines: now?.ok ? String(now.raw || '').split('\n').filter(l => /^\s*\d+[\.、]/.test(l)).length : -1,
        workers_ok: rsOk
      };
    });
    return () => {
      stop = true;
      // 关弹窗即记录基线（fire-and-forget）：下次打开就有"距上次体检"对比
      if (snapRef.current) fetch('/api/eco-baseline', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(snapRef.current)}).catch(() => {});
    };
  }, []);
  const v = eco?.vitals;
  const svcs = eco?.services || [];
  const links = [
    {name: '微信推送链路', key: 'wecompush', desc: 'done/拍板/告警即时推'},
    {name: '飞书指令桥', key: 'feishu', desc: 'feishu-bridge 常驻工作者'},
    {name: 'ZCode 派发执行', key: 'zrunner', desc: '领单执行 AI 定时'},
    {name: '微信哨兵', key: 'wxwatch', desc: '群消息三分拣'}
  ];
  for (const l of links) {
    const w = svcs.find(s => String(s.id || '').startsWith(l.key) || String(s.desc || '').includes(l.key));
    // 链路口径：down=真断（红）；noreport=没接心跳上报（灰，不算断——wecompush 等 lib 型查不到即 na）
    l.ok = w ? (w.state === 'ok' ? true : w.state === 'down' ? false : null) : null;
  }
  // 体检结论（红黄绿 + 一句话）：待拍板/链路断=黄，常驻工作者真超时过半=红，其余=绿。
  // 口径：services 投影里 group=worker 的即常驻工作者；noreport（没接心跳上报）≠掉线，不参与判红。
  const down = links.filter(l => l.ok === false).length;
  const residents = svcs.filter(s => s.group === 'worker');
  const resOk = residents.filter(s => s.state === 'ok').length;
  const resHard = residents.filter(s => s.state === 'down').length;
  const verdict = (residents.length >= 2 && resHard >= Math.ceil(residents.length / 2))
    ? {cls: 'red', text: `常驻工作者掉线过半（${resHard}/${residents.length}），先看服务舱`}
    : (v?.pending_decisions > 0 || down > 0)
      ? {cls: 'amber', text: [v?.pending_decisions > 0 ? `${v.pending_decisions} 件待拍板` : '', down > 0 ? `${down} 条链路断` : ''].filter(Boolean).join('，') + '——需要你出手'}
      : {cls: 'green', text: '生态健康：链路通、无积压，不用管'};
  // 变化对比：与上次体检的基线比
  const cur = snapRef.current;
  let delta = null;
  if (prev && cur) {
    const ago = Math.max(1, Math.round((Date.now() - (prev.ts || Date.now())) / 3600000));
    const pset = new Set(prev.tasks || []), cset = new Set(cur.tasks);
    const added = [...cset].filter(x => !pset.has(x)), removed = [...pset].filter(x => !cset.has(x));
    const parts = [];
    if (added.length) parts.push(`定时任务 +${added.length}${added.length <= 2 ? '（' + added.join('、') + '）' : ''}`);
    if (removed.length) parts.push(`定时任务 -${removed.length}`);
    if (cur.workers_ok >= 0 && prev.workers_ok >= 0 && cur.workers_ok !== prev.workers_ok) parts.push(`工作者在线 ${prev.workers_ok}→${cur.workers_ok}`);
    if (cur.now_lines >= 0 && prev.now_lines >= 0 && cur.now_lines !== prev.now_lines) parts.push(`在办 ${prev.now_lines}→${cur.now_lines} 条`);
    delta = {ago, parts, changed: parts.length > 0};
  }
  // 当前在办：NOW.md 编号行解析成条目（数据源：brain/NOW.md，三端 AI 共写的热状态正本）
  const nowLines = d?.now?.ok ? String(d.now.raw || '').split('\n')
    .map(l => l.trim()).filter(l => /^\d+[\.、]/.test(l)) : [];
  // 今日动态（10-19 用户令"体检没有新意"）：体检不只报资产存量，还要报今天生态干了什么——
  // dispatcher 今日实际动作数（events 里 dispatch 流水，滤"非排班/跳过"的空转记录）+ 最近业务事件
  // （滤掉 dispatch 的例行刷屏）。数据源：/api/platform/tasks 的 events 投影，与生态流水同一份。
  const today = new Date().toISOString().slice(0, 10);
  const dispEvts = (eco?.events || []).filter(e => e.kind === 'dispatch' && String(e.ts || '').slice(0, 10) === today);
  const sent = dispEvts.filter(e => /→/.test(String(e.detail || '')) && !/非排班|跳过|不排班/.test(String(e.detail || '')));
  const realEvts = (eco?.events || []).filter(e => e.kind !== 'dispatch').slice(0, 5);
  const EVT_ZH = {task: '任务', decision: '拍板', command: '指令', push: '推送', alarm: '闹钟',
    review: '验收', worker: '工作者', attach: '附件', memory: '记忆'};
  return <Modal title="生态体检" en="Ecosystem check" onClose={onClose} wide>
    <div className="ecocheck">
      <div className={`eco-verdict ${verdict.cls}`}><i/>{verdict.text}</div>
      {delta && <p className="eco-delta">{delta.changed
        ? `距上次体检（约 ${delta.ago} 小时前）：${delta.parts.join('；')}`
        : `距上次体检（约 ${delta.ago} 小时前）：无变化`}</p>}
      {!delta && <p className="eco-delta">本次为基线（首次打开或引擎刚重启），关闭时记录、下次打开可看变化</p>}
      <section><h3>今日动态 <em>Today</em></h3>
        {eco && <p className="eco-sub">调度器今日实跑 {sent.length} 次{sent.length ? ` · 最近一次 ${String(sent[sent.length - 1].ts || '').slice(11, 16)} ${String(sent[sent.length - 1].detail || '').slice(1, 40).split(']')[0]}` : ' · 最近 40 条事件内无实跑记录（更早的已滚出窗口）'}</p>}
        <ul className="eco-list compact">
          {realEvts.length ? realEvts.map(e => <li key={e.id}><i className="on"/><span className="ev-ts">{String(e.ts || '').slice(11, 16)}</span>{EVT_ZH[e.kind] || e.kind || '事件'} · {String(e.detail || e.action || '').slice(0, 64)}</li>)
            : <li><i className="na"/>最近事件全是调度器例行巡检——今天还没有任务/拍板/推送类动作</li>}
        </ul>
      </section>
      <section><h3>生命体征 <em>Vitals</em></h3>
        <div className="eco-kpis">
          <div><b>{v?.open_tasks ?? '—'}</b><span>未结任务</span></div>
          <div><b>{v?.pending_decisions ?? '—'}</b><span>待拍板</span></div>
          <div><b>{v?.review_tasks ?? 0}</b><span>待验收</span></div>
          <div><b>{resOk}/{residents.length}</b><span>常驻工作者在线</span></div>
        </div>
      </section>
      <section><h3>推送 / 派发链路 <em>Channels</em></h3>
        <ul className="eco-list">{links.map(l => <li key={l.name}><i className={l.ok ? 'on' : l.ok === false ? 'off' : 'na'}/>{l.name}<small>{l.desc}</small></li>)}</ul>
      </section>
      <section><h3>我的定时资产 <em>My schedule</em></h3>
        {!d && <p className="quiet">读取中（schtasks 枚举约 2~5 秒）…</p>}
        {d?.sch?.ok === false && <p className="quiet">计划任务枚举失败：{d.sch.err}</p>}
        {d?.sch?.recurring?.length > 0 && <p className="eco-sub">AI 定时（dispatcher · recurring.json · {d.sch.recurring.filter(r => r.enabled).length} 启用/{d.sch.recurring.length} 总）</p>}
        {d?.sch?.recurring?.map(r => <div key={r.key} className="eco-row"><i className={r.enabled ? 'on' : 'off'}/>{r.key}<small>{r.prompt}</small></div>)}
        {d?.sch?.tasks && <>
          <p className="eco-sub">Windows 计划任务 {d.sch.tasks.length} 个（我手动创建 · 未禁用）</p>
          <ul className="eco-list compact">{d.sch.tasks.map(t => <li key={t.name}><i className={t.state === 'Ready' ? 'on' : 'na'}/>{t.name}{t.next && t.next !== 'N/A' && <small>下次 {String(t.next).slice(0, 16)}</small>}</li>)}</ul>
          {(d.sch.system_count > 0 || d.sch.disabled_count > 0) && <p className="eco-sys">另有系统/软件自带 {d.sch.system_count} 个、我创建但已禁用 {d.sch.disabled_count} 个未列出（\Microsoft\ 与禁用任务均不计）</p>}
        </>}
      </section>
      <section><h3>当前在办 <em>NOW · hot state</em></h3>
        {d?.now?.ok
          ? <>
              <p className="eco-src">数据源：KnowledgeBase/brain/NOW.md（三端 AI 共写的热状态正本，一案一行）· 文件更新 {d.now.mtime || '未知'} · 共 {nowLines.length} 条</p>
              <ol className="eco-nowlist">{nowLines.slice(0, 12).map((l, i) => <li key={i}>{l.replace(/^\d+[\.、]\s*/, '').slice(0, 80)}</li>)}</ol>
            </>
          : <p className="quiet">{d ? 'NOW.md 不可达' : '读取中…'}</p>}
      </section>
    </div>
  </Modal>;
}

// 来源管理（星图 10-20 用户令「Excel 来源手动配置 + 统一标准」）：hub sources 表的可视化配置入口——
// 新增/改频率/改页签/启停/立即重扫/删除，走引擎 /api/source（proxy /api/platform/source-op → 8331）。
// 统一标准：任何 Excel 文件（任意页签/任意列位）登记为来源即自动入池，无需改代码；列位映射 cols
// 为 JSON（默认按页签套模板，见 ui/server.py _SRC_DEFAULT_COLS），高级区可手改。
// 来源管理内容体（星图 10-20 四轮拆出）：独立弹窗与「任务流档案页」共用同一块——
// 任务模块的来源文件在这里可增/改/删/重扫，任何 Excel 登记为来源即自动入池，无需改代码。
function SourcesManager() {
  const [data, setData] = useState(null);          // {sources, tfssync}
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [adv, setAdv] = useState(false);
  const [fm, setFm] = useState({name: '', path: '', sheet: '', owner: '', scan_min: '', cols: ''});
  const [freqs, setFreqs] = useState({});          // 行内改频率：{id: 输入值}
  // 绑定 Excel 效果展示（星图 10-20 七轮，用户令「只要一个绑定 excel 的效果展示」）：拉全表任务（只读），
  // 按 source_ref 前缀 src{id}: 匹配，每个来源下面直接显示"这个 Excel 导入了哪些任务（含已完成）"——
  // 添加 Excel 来源后不用到处找，就在这里一眼看到效果。
  const [tasks, setTasks] = useState(null);
  useEffect(() => {
    let on = true;
    fetch('/api/platform/tasks/full').then(r => r.json()).then(d => { if (window.__srcLog) window.__srcLog.push('full ok=' + d?.ok + ' n=' + (d?.data?.tasks || []).length + ' err=' + (d?.err || '')); if (on && d.ok) setTasks(d.data.tasks || []); }).catch(e => { if (window.__srcLog) window.__srcLog.push('full catch ' + String(e)); });
    return () => { on = false; };
  }, []);
  const load = () => fetch('/api/platform/sources').then(r => r.json()).then(d => { if (window.__srcLog) window.__srcLog.push('sources ok=' + d?.ok + ' n=' + (d?.data?.sources || []).length + ' err=' + (d?.err || '')); if (d.ok) setData(d); else setErr('来源实况读取失败'); }).catch(e => { if (window.__srcLog) window.__srcLog.push('sources catch ' + String(e)); setErr('来源实况读取失败'); });
  useEffect(() => { if (window.__srcLog) window.__srcLog.push('mounted ' + Date.now()); load(); }, []);
  const act = async body => {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/platform/source-op', {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}).then(x => x.json());
      if (!r?.ok) setErr(r?.msg || r?.error || '操作失败');
      else { await load(); setFreqs({}); }
      return r;
    } catch { setErr('引擎宿主不可达（写接口）'); return null; }
    finally { setBusy(false); }
  };
  const addSrc = async () => {
    if (!fm.name.trim() || !fm.path.trim()) { setErr('名称与文件绝对路径必填'); return; }
    const body = {op: 'add', name: fm.name.trim(), path: fm.path.trim()};
    if (fm.sheet.trim()) body.sheet = fm.sheet.trim();
    if (fm.owner.trim()) body.owner = fm.owner.trim();
    if (fm.scan_min.trim() !== '') body.scan_min = parseInt(fm.scan_min, 10) || 0;
    if (adv && fm.cols.trim()) { try { body.cols = JSON.parse(fm.cols.trim()); } catch { setErr('列位映射不是合法 JSON'); return; } }
    const r = await act(body);
    if (r?.ok) { setAdding(false); setAdv(false); setFm({name: '', path: '', sheet: '', owner: '', scan_min: '', cols: ''}); }
  };
  const srcs = data?.sources || [];
  const tf = data?.tfssync || null;
  const tfFiles = tf?.files ? Object.values(tf.files) : [];
  return <div className="src-manage">
      <p className="eco-intro">任何 Excel 文件（任意页签、任意列位）在这里登记为<em>来源</em>，引擎按扫描频率自动把未完成的行导入任务池（source=plan，全库去重）；TFS 工作区内的文件还由 TFS取新哨兵每 15 分钟保鲜。字段：<b>名称 / 文件绝对路径 / 页签 sheet / 负责人过滤 owner（空=全部）/ 扫描频率 scan_min（分钟，0=仅手动）</b>，列位映射 cols 高级区可改（不填自动按页签套模板）。</p>
      <div className="src-manage-actions">
        <button className="pill primary" onClick={() => { setAdding(!adding); setErr(''); }}>{adding ? '收起新增' : '＋ 新增来源'} <em>Add source</em></button>
        {srcs.length === 0 && <span className="quiet">暂无来源</span>}
      </div>
      {adding && <div className="form-box src-add-form">
        <div className="form-row">
          <label>名称 <em>必填</em><input value={fm.name} onChange={e => setFm({...fm, name: e.target.value})} onFocus={wvFocus} onBlur={wvBlur} placeholder="如：XX车间进度表"/></label>
          <label>文件绝对路径 <em>必填</em><input value={fm.path} onChange={e => setFm({...fm, path: e.target.value})} onFocus={wvFocus} onBlur={wvBlur} placeholder="D:\Project\…\xx.xlsx"/></label>
        </div>
        <div className="form-row">
          <label>页签 sheet<input value={fm.sheet} onChange={e => setFm({...fm, sheet: e.target.value})} onFocus={wvFocus} onBlur={wvBlur} placeholder="不填=文件第一个工作表"/></label>
          <label>负责人过滤 owner<input value={fm.owner} onChange={e => setFm({...fm, owner: e.target.value})} onFocus={wvFocus} onBlur={wvBlur} placeholder="空=不过滤（全部）"/></label>
          <label>扫描频率（分钟）<input value={fm.scan_min} onChange={e => setFm({...fm, scan_min: e.target.value})} onFocus={wvFocus} onBlur={wvBlur} placeholder="0=仅手动/变更触发" inputMode="numeric"/></label>
        </div>
        <button type="button" className="ghost te-btn" onClick={() => setAdv(!adv)}>{adv ? '收起' : '▾ 高级：列位映射 cols（默认按页签套模板）'}</button>
        {adv && <>
          <label>列位映射 JSON<textarea rows={4} value={fm.cols} onChange={e => setFm({...fm, cols: e.target.value})} onFocus={wvFocus} onBlur={wvBlur} placeholder={'{"start_row":5,"module":"B","item":"C","progress":"D","owner":"E","pct":"G","plan_s":"I","due":"J","status_col":"F","done_mode":"status"}'} className="mono"/></label>
          <p className="quiet">列用字母（A..Z）；start_row=数据起始行；status_col 空串=无状态列；done_mode=status（状态列滤 Close/Cancel）或 pct（完成度≥done_pct 跳过）。</p>
        </>}
        {err && <p className="form-err">{err}</p>}
        <div className="confirm-actions">
          <button className="primary" disabled={busy} onClick={addSrc}>{busy ? '提交中…' : '登记来源'} <em>Add</em></button>
          <button onClick={() => { setAdding(false); setErr(''); }}>取消 <em>Cancel</em></button>
        </div>
      </div>}
      <ul className="src-list">
        {srcs.map(s => <li key={s.id} className="src-static src-row-full">
          <span className="src-row-main">
            <b>{s.name} <em>sheet {s.sheet || '—'}</em></b>
            <span className="src-data">
              <i className={'dot ' + (s.enabled ? 'on' : 'off')}/>{s.enabled ? '启用' : '停用'} · 频率 {s.scan_min ? `${s.scan_min} 分钟` : '手动/变更'} · {s.exists ? '文件在' : '⚠ 文件缺失'} · 最后扫描 {s.last_scan_at || '—'} · 本轮 {s.last_count} 条
            </span>
            <span className="src-desc">{s.path}{s.owner ? ` · owner=${s.owner}` : ''}</span>
            {(() => {
              const mine = (tasks || []).filter(t => String(t.source_ref || '').startsWith(`src${s.id}:`));
              if (mine.length === 0) return <span className="src-tasks muted">绑定效果：这份 Excel 尚未导入任务（登记后按扫描频率自动入池）</span>;
              const openN = mine.filter(t => t.status !== 'done').length;
              const recent = mine.slice(0, 4).map(t => `${t.id} ${String(t.title).replace(/\s+/g, ' ').slice(0, 16)}〔${STATUS_ZH[t.status] || t.status}〕`).join('、');
              return <span className="src-tasks">← 这份 Excel 已导入 <b>{mine.length}</b> 条任务（{openN} 未结）{recent ? ` · 最近：${recent}` : ''}</span>;
            })()}
          </span>
          <span className="src-row-ops">
            <input className="freq-input" title="扫描频率（分钟，0=关）" placeholder="频率" inputMode="numeric" value={freqs[s.id] ?? ''}
              onChange={e => setFreqs({...freqs, [s.id]: e.target.value})} onFocus={wvFocus} onBlur={wvBlur}/>
            <button className="ghost sm" disabled={busy} title="应用频率" onClick={() => {
              const v = parseInt(freqs[s.id], 10);
              if (Number.isNaN(v)) { setErr('频率须为整数分钟'); return; }
              act({op: 'set', id: s.id, scan_min: v});
            }}>频率</button>
            <button className="ghost sm" disabled={busy} onClick={() => act({op: 'set', id: s.id, enabled: s.enabled ? 0 : 1})}>{s.enabled ? '停用' : '启用'}</button>
            <button className="ghost sm" disabled={busy} title="立即重扫" onClick={() => act({op: 'scan', id: s.id})}>重扫</button>
            <button className="ghost sm danger" disabled={busy} onClick={() => { if (!window.confirm(`删除来源「${s.name}」？已导入的任务保留。`)) return; act({op: 'del', id: s.id}); }}>删除</button>
          </span>
        </li>)}
        <li className="src-static"><span className="src-row-main">
          <b>TFS取新哨兵 <em>tfssync</em></b>
          <span className="src-data">{tf ? `最后取新 ${tf.last_success || '—'} · 最新变更集 ${(tfFiles[0] && tfFiles[0].cs) || '—'}（${(tfFiles[0] && tfFiles[0].user) || '—'} ${(tfFiles[0] && tfFiles[0].date) || '—'}）${(tf.pending_scan || []).length ? ' · 待补扫 ' + tf.pending_scan.join('/') : ''}` : '读取中…'}</span>
          <span className="src-desc">每 15 分钟 tf get 取 TFS 最新进度表，md5 变化自动重扫来源进任务池；TFS 需内网/aTrust，断网轮只留痕不告警。重扫端点=引擎 8331 /api/source。</span>
        </span></li>
      </ul>
    </div>;
}
// 独立来源管理弹窗（「关于」→ 管理来源走这里；任务流档案页直接内嵌 SourcesManager 本体）
function SourcesModal({onClose}) {
  return <Modal title="来源管理 · 统一标准" en="Sources · unified standard" onClose={onClose} wide>
    <SourcesManager/>
  </Modal>;
}

// 模块档案页（星图 10-20 用户令「点击各模块后新开一页，完整展示有哪些数据、哪些逻辑、对应哪些文件路径」）：
// 每模块一页 = 一句话大白话简介 + 数据实况 + 逻辑（谁在读/谁在写/怎么流转，通俗说明+代码位置）+ 文件路径（实物+代码）。
// 任务流特殊：来源文件在这里直接可增/改/删/重扫（内嵌 SourcesManager），二次添加来源不用改任何代码。
const MODULE_DOCS = {
  tasks: {zh: '任务流', en: 'Tasks', hasSrc: true,
    intro: '你所有「要干的事」都在这里排队。任务不只是星图里手建的——Excel 进度表、微信@我、接收区投递、调度器巡检，全都汇进同一个任务池（hub.db 的 tasks 表），星图只是把这个池子实时投影出来给你看、给你改。',
    data: [
      ['tasks 表', '任务本体：T-xxx 编号、标题、状态、优先级、截止日、来源、备注/内容'],
      ['commands 表', '指令台账：AI 定时/巡检跑过的一键重跑指令（M-xxx）'],
      ['events 表', '最近事件流水：派发/状态变更/拍板/推送，左下角滚动展示'],
      ['vitals', '顶栏计数：未结 / 待验收 / 今日完成 / 待拍板']
    ],
    logic: [
      ['读取（每 30 秒）', '星图轮询 vite 中间件 /api/platform/tasks（vite.config.js platformApiPlugin），node:sqlite 以只读模式直查 hub.db——星图从不写库。'],
      ['写入 · Excel 来源扫描', '引擎宿主按每个来源的扫描频率（scan_min 分钟）扫 Excel，把「还没完成的行」导入任务池，source=plan；任务卡/详情直接标注「哪个 Excel 哪个页签」（来源文件清单见下方「来源文件」区，可增改/重扫）。全库去重键=来源+模块段+事项名（source_ref），同一行绝不会重复导入。'],
      ['写入 · 微信@我', 'wxwatch 哨兵盯微信群，@你/点你名的消息自动落成任务（source=wechat），原文与群/发言人保留在详情里可查。'],
      ['写入 · 星图新建 / 接收区', '星图内点「＋ 新任务」（source=star-map）、接收区投递（source=inbox）都走引擎宿主同一套 actions（web/server.py）写进同一个任务池。'],
      ['写入 · 调度器巡检', '调度器（dispatcher）每 15 分钟自我巡检：派发 AI 定时任务（10-20 起已全部停用）＋自我体检（工作者离线/AI 出勤超期/TFS 取新失败/看门狗不一致等），发现问题自动建「[调度]」任务（source=cron）催你处理，处理完自动不再催。'],
      ['状态流转', '待办 pending → 进行 doing → 待验收 review → 完成 done；验收不达标可打回（必填原因）退回待办。'],
      ['完成判定', '来源表里状态列为 Close/Cancel、或完成度≥done_pct（如 100%）的行，扫描时自动跳过、不再导入。'],
      ['TFS 保鲜', 'tfssync 哨兵每 15 分钟 tf get 取 TFS 工作区最新进度表，md5 变了就自动重扫进池（workers/tfssync/tfssync.py）']
    ],
    srcmap: [
      {k: 'plan', zh: 'Excel 来源扫描', en: 'Excel source', desc: '引擎按登记频率（你配的是 20 分钟）扫 Excel，把「还没完成的行」自动导入任务池。任务详情直接显示哪个文件、哪个页签来的（如 EAP 进度表 · 页签「EAP管理进度表」）。'},
      {k: 'wechat', zh: '微信@我', en: 'WeChat', desc: 'wxwatch 哨兵盯着群消息，@你/点你名的消息自动落成任务，原文和群/发言人保留可查。'},
      {k: 'cron', zh: '调度器 · 巡检', en: 'Scheduler', desc: '调度器每 15 分钟自我巡检：①派发 AI 定时任务（10-20 起已全部停用）；②自我体检——工作者离线/AI 出勤超期/TFS 取新失败/看门狗不一致等，发现问题自动建「[调度]」任务催你处理。T-324「任务清单与看门狗不一致」就是出勤看门狗发现凭据没有产出方时自动催的，处理完自检恢复即不再催。'},
      {k: 'star-map', zh: '星图新建', en: 'Star map', desc: '你在星图里点「＋ 新任务」手建的。'},
      {k: 'inbox', zh: '接收区', en: 'Inbox', desc: '丢进接收区的文件/内容自动落成任务。'},
      {k: 'manual', zh: '手动 / 截图', en: 'Manual', desc: '手动录入或截图创建，日常顺手记的（数量最多）。'},
      {k: 'decision', zh: '拍板派工', en: 'Decisions', desc: '拍板批准后引擎自动派生的任务。'},
      {k: 'other', zh: '其他零散', en: 'Others', desc: 'AI 会话、网页、微信文件、测试等零散入口产生的任务。'}
    ],
    files: [
      ['hub.db（数据正本）', 'D:\\Portable\\Documents\\工作管理\\LoopDeck\\hub\\hub.db'],
      ['读取代码', 'D:\\Portable\\neural-creator-dashboard\\vite.config.js（platformApiPlugin）'],
      ['写入代码 · 引擎', 'D:\\Portable\\Documents\\工作管理\\LoopDeck\\web\\server.py（actions）'],
      ['写入代码 · 来源扫描', 'D:\\Portable\\Documents\\工作管理\\LoopDeck\\ui\\server.py（source_action / _source_scan）'],
      ['哨兵代码', 'D:\\Portable\\Documents\\工作管理\\LoopDeck\\workers\\tfssync\\tfssync.py + watch.json']
    ]},
  kb: {zh: '知识库', en: 'Knowledge', hasSrc: false,
    intro: '你的第二大脑（Obsidian 仓库）。星图每次打开都现场扫一遍 markdown 文件，把 [[双链]] 和共用话题标签变成连线；笔记按 分区 → 子目录 → 文件 逐层钻入，长清单用滚轮往下平移。',
    data: [
      ['notes', '全部 markdown 笔记：标题、分区、子目录、正文、tags、双链'],
      ['图谱结构', '连接 links（双链/话题）、未创建双链 ghosts（提到但还没建出来的链接）']
    ],
    logic: [
      ['读取（现场扫描）', '/api/kb-graph 每次请求现扫 KB 目录（vite.config.js kbGraphPlugin），正本零写入——往 KB 放一篇新笔记，30 秒内星图自动带出，无需任何手动刷新。'],
      ['全文/图片', '/api/note-raw 拉笔记全文（markdown 渲染）；/api/kb-asset 出图内图片（白名单扩展名 + 防目录穿越）。']
    ],
    files: [
      ['知识库本体（数据正本）', 'D:\\Portable\\KnowledgeBase（Obsidian 仓库；C:\\Users\\ocean.xu\\KnowledgeBase 为 junction）'],
      ['读取代码', 'D:\\Portable\\neural-creator-dashboard\\vite.config.js（kbGraphPlugin / detailPlugin）']
    ]},
  decisions: {zh: '拍板台', en: 'Decisions', hasSrc: false,
    intro: 'AI 干活拿不准、需要你拿主意的事。三门槛才落账：收尾没有答案 ＋ 不拍板就动不了 ＋ 有实际代价。落账即推微信，你批准后自动建任务派 AI 执行。',
    data: [
      ['decisions 表', '拍板事项 D-xxx：标题、方案/理由/影响、备选方案、状态（pending/approved/rejected/resolved）']
    ],
    logic: [
      ['写入', '引擎 decide（hub.decide add，三门槛落账），落账即推企业微信群；星图内可直接登记补录。'],
      ['读取/收口', '/api/platform/decisions 只读展示；就地批准/否决/销账走引擎 actions（web/server.py），批准自动建任务派工。']
    ],
    files: [
      ['数据正本', 'D:\\Portable\\Documents\\工作管理\\LoopDeck\\hub\\hub.db（decisions 表）'],
      ['写入代码', 'D:\\Portable\\Documents\\工作管理\\LoopDeck\\web\\server.py + hub.py（decide）']
    ]},
  memory: {zh: '记忆池', en: 'Memory', hasSrc: false,
    intro: 'AI 记住了什么的投影：ZCode 记忆真身 + memorycore 降级候选池，按条展示状态，点开可看整条记忆全文。',
    data: [
      ['memories', '记忆池条目（中文标题 + 状态）'],
      ['memState', '池状态 pool_n（条目数）']
    ],
    logic: [
      ['读取', 'memoryStatePlugin（vite.config.js /api/memory-state，memorycore MCP 零打扰）；全文走 /api/mem-raw。']
    ],
    files: [
      ['记忆真身', 'C:\\Users\\ocean.xu\\.zcode\\cli\\memories\\projects'],
      ['memorycore 状态', 'D:\\Portable\\KnowledgeBase\\brain\\memorycore\\state + memlazy pool.json']
    ]},
  services: {zh: '服务舱', en: 'Services', hasSrc: false,
    intro: '本机所有在跑的核心服务与常驻工作者，心跳三态实时监控：ok 在线 / late 迟报 / down 掉线，卡片右侧直接看状态，出问题一眼知道是谁。',
    data: [
      ['workers', '常驻工作者清单（registry.json 唯一注册表）：心跳状态、描述、入口链接'],
      ['核心服务', '执行引擎（8331）与检索服务（8342）的健康探测']
    ],
    logic: [
      ['读取', '/api/platform/services 只读；在线判定=心跳超时 2× 判 down + 独立 ping 探测（engine-ping / kb-health）。']
    ],
    files: [
      ['注册表（数据正本）', 'D:\\Portable\\Documents\\工作管理\\LoopDeck\\workers\\registry.json'],
      ['心跳数据', 'D:\\Portable\\Documents\\工作管理\\LoopDeck\\hub\\hub.db（heartbeats 表）']
    ]},
  stream: {zh: '生态流水', en: 'Stream', hasSrc: false,
    intro: '工作站最近发生的事（任务派发 / 状态变更 / 拍板 / 推送），左下角 30 秒轮询滚动，新到的金色高亮。',
    data: [
      ['events', '最近 40 条事件（派发/状态/拍板/推送/验收/闹钟…）']
    ],
    logic: [
      ['读取', 'vite 直读 /api/entities 同源投影（最近 40 条），与顶栏计数同一份数据。']
    ],
    files: [
      ['数据正本', 'D:\\Portable\\Documents\\工作管理\\LoopDeck\\hub\\hub.db（events 表）']
    ]}
};

// 任务从哪来（星图 10-21 用户令「来源要通俗易懂、一眼看全所有细节」）：
// 档案页「任务从哪来 · 大白话」卡片 + 实时条数（按 source 归组，数据=/api/platform/sources 的 taskCounts）
const SRC_MAP = [
  {k: 'plan', zh: 'Excel 来源扫描', en: 'Excel source', desc: '引擎按登记频率（你配的是 20 分钟）扫 Excel，把「还没完成的行」自动导入任务池。任务详情直接显示哪个文件、哪个页签来的（如 EAP 进度表 · 页签「EAP管理进度表」）。'},
  {k: 'wechat', zh: '微信@我', en: 'WeChat', desc: 'wxwatch 哨兵盯着群消息，@你/点你名的消息自动落成任务，原文和群/发言人保留可查。'},
  {k: 'cron', zh: '调度器 · 巡检', en: 'Scheduler', desc: '调度器每 15 分钟自我巡检：①派发 AI 定时任务（10-20 起已全部停用）；②自我体检——工作者离线/AI 出勤超期/TFS 取新失败/看门狗不一致等，发现问题自动建「[调度]」任务催你处理。T-324「任务清单与看门狗不一致」就是出勤看门狗发现凭据没有产出方时自动催的，处理完自检恢复即不再催。'},
  {k: 'star-map', zh: '星图新建', en: 'Star map', desc: '你在星图里点「＋ 新任务」手建的。'},
  {k: 'inbox', zh: '接收区', en: 'Inbox', desc: '丢进接收区的文件/内容自动落成任务。'},
  {k: 'manual', zh: '手动 / 截图', en: 'Manual', desc: '手动录入或截图创建，日常顺手记的（数量最多）。'},
  {k: 'decision', zh: '拍板派工', en: 'Decisions', desc: '拍板批准后引擎自动派生的任务。'},
  {k: 'other', zh: '其他零散', en: 'Others', desc: 'AI 会话、网页、微信文件、测试等零散入口产生的任务。'}
];
// 原始 source 值 → 显示组（微信文件并进微信@我，其余零散并进其他）
const SRC_GROUP = {plan: 'plan', wechat: 'wechat', wxfile: 'wechat', cron: 'cron', 'star-map': 'star-map', inbox: 'inbox', manual: 'manual', decision: 'decision', ai: 'other', web: 'other', hub: 'other', oa: 'other', zcode: 'other', 'zrunner-test': 'other', 'km2026会话': 'other', feishu: 'other'};
function SrcMap() {
  const [tc, setTc] = useState(null);   // /api/platform/sources → taskCounts：[{source, n, open}]
  useEffect(() => {
    let on = true;
    fetch('/api/platform/sources').then(r => r.json()).then(d => { if (on && d.ok) setTc(d.data?.taskCounts || []); }).catch(() => {});
    return () => { on = false; };
  }, []);
  const by = {};
  for (const c of SRC_MAP) by[c.k] = {n: 0, open: 0};
  for (const t of (tc || [])) { const g = SRC_GROUP[t.source] || 'other'; by[g].n += t.n || 0; by[g].open += t.open || 0; }
  return <div className="md-srcmap">
    {SRC_MAP.map(c => <div key={c.k} className="ms-card">
      <b>{c.zh} <em>{c.en}</em></b>
      <i className="ms-n">{tc ? `${by[c.k].n} 条${by[c.k].open ? `（${by[c.k].open} 未结）` : ''}` : '读取中…'}</i>
      <p>{c.desc}</p>
    </div>)}
  </div>;
}

function ModuleDocModal({id, graph, eco, s, onClose, onGo, onEnterView}) {
  const doc = MODULE_DOCS[id];
  if (!doc) return null;
  const today = new Date().toISOString().slice(0, 10);
  const n = k => graph.nodes.filter(x => x.kind === k);
  const T = n('task'), D = n('decision'), N = n('note'), S = n('service'), C = n('command');
  // 各模块一行实况（顶在档案页头上，跟"数据"章节互相印证）
  const live = id === 'tasks' ? `未结 ${T.filter(x => x.task?.status !== 'done').length} · 待验收 ${T.filter(x => x.task?.status === 'review').length} · 今日完成 ${T.filter(x => x.task?.status === 'done' && String(x.task?.done_at || '').slice(0, 10) === today).length} · 指令台账 ${C.length}`
    : id === 'kb' ? `笔记 ${N.length} 篇 · 连接 ${s.links} 条 · 未创建双链 ${s.ghosts}`
    : id === 'decisions' ? `待拍板 ${D.filter(x => x.decision?.status === 'pending').length} · 累计 ${D.length}`
    : id === 'memory' ? `条目 ${n('memory').length}`
    : id === 'services' ? `在线 ${S.filter(x => x.service?.ok).length}/${S.length}`
    : `最近事件 ${(eco?.events || []).length} 条`;
  return <Modal title={`${doc.zh} · 模块档案`} en={`${doc.en} · module dossier`} onClose={onClose} wide>
    <div className="moddoc">
      <p className="md-intro">{doc.intro}</p>
      <p className="md-live">当前实况 <em>Live</em>：<b>{live}</b></p>
      <section className="md-sec">
        <h3>有哪些数据 <em>Data</em></h3>
        <ul className="md-list">{doc.data.map(([k, v]) => <li key={k}><b>{k}</b><span>{v}</span></li>)}</ul>
      </section>
      <section className="md-sec">
        <h3>有哪些逻辑 <em>Logic · 白话版</em></h3>
        <ul className="md-list">{doc.logic.map(([k, v]) => <li key={k}><b>{k}</b><span>{v}</span></li>)}</ul>
      </section>
      {doc.srcmap && <section className="md-sec">
        <h3>任务从哪来 <em>Where tasks come from · 大白话</em>
          <span className="md-src-tip">所有任务都汇进同一个任务池（hub.db tasks 表），这张卡片告诉你每条通道从哪来、多少条；任务卡/详情上直接标来源。</span>
        </h3>
        <SrcMap/>
      </section>}
      <section className="md-sec">
        <h3>对应哪些文件路径 <em>Files</em></h3>
        <ul className="md-list">{doc.files.map(([k, v]) => <li key={k}><b>{k}</b><span className="path">{v}</span></li>)}</ul>
      </section>
      {doc.hasSrc && <section className="md-sec md-src">
        <h3>来源文件 <em>Source files · 可设定</em>
          <span className="md-src-tip">任务比较特殊：来源文件在这里登记/增改/重扫，二次添加新的 Excel 来源不用改任何代码。</span>
        </h3>
        <SourcesManager/>
      </section>}
      <div className="confirm-actions md-foot">
        <button className="primary" onClick={() => { onGo({mod: id === 'stream' ? null : id, zone: null, sel: null}); onEnterView && onEnterView(); }}>进入{id === 'stream' ? '星图主页' : doc.zh}视图 <em>Go</em></button>
        <button onClick={onClose}>返回 <em>Back</em></button>
      </div>
    </div>
  </Modal>;
}

// 关于弹窗（星图 10-20 用户令「数据来源指向实物」）：来源清单从静态说明升级为实况行。
// 10-20 四轮（用户令「实物来源并入各生态模块描述」）：不再单列「来源实物」区——每个模块行的描述
// 直接带它的实物来源（数据文件在哪、谁在读谁在写、源头实物是什么）；模块行可点击打开「模块档案」页
// （一页看全数据/逻辑/文件路径，任务模块的档案页里还能直接增改来源文件）。
function AboutModal({graph, eco, s, onClose, onOpenDoc, onOpenSources}) {
  const today = new Date().toISOString().slice(0, 10);
  const n = k => graph.nodes.filter(x => x.kind === k);
  const T = n('task'), D = n('decision'), N = n('note'), S = n('service'), C = n('command');
  const [srcs, setSrcs] = useState(null);
  useEffect(() => {
    let on = true;
    fetch('/api/platform/sources').then(r => r.json()).then(d => { if (on && d.ok) setSrcs(d.data); }).catch(() => {});
    return () => { on = false; };
  }, []);
  const tf = srcs?.tfssync || null;
  const tfFiles = tf?.files ? Object.values(tf.files) : [];
  const tfLine = tf
    ? `TFS取新哨兵：最后取新 ${tf.last_success || '—'} · 最新变更集 ${(tfFiles[0] && tfFiles[0].cs) || '—'}（${(tfFiles[0] && tfFiles[0].user) || '—'} ${(tfFiles[0] && tfFiles[0].date) || '—'}）${(tf.pending_scan || []).length ? ' · 待补扫 ' + tf.pending_scan.join('/') : ''}`
    : 'TFS取新哨兵状态读取中…';
  const rows = [
    {id: 'tasks', zh: '任务流', en: 'Tasks',
      data: `未结 ${T.filter(x => x.task?.status !== 'done').length} · 待验收 ${T.filter(x => x.task?.status === 'review').length} · 今日完成 ${T.filter(x => x.task?.status === 'done' && String(x.task?.done_at || '').slice(0, 10) === today).length} · 指令台账 ${C.length}`,
      desc: `任务从哪来（都是进同一个任务池 hub.db tasks 表的事）：①Excel 来源扫描——TFS 进度表（江西威尔高-EAP管理进度表.xlsx · 两个页签 EAP程序开发进度表 / EAP管理进度表），每 20 分钟把没完成的行自动导入，任务详情直接标哪个文件哪个页签；②微信@我——wxwatch 哨兵盯群，@你/点你名的消息自动成任务，原文可查；③接收区；④星图内「＋ 新任务」；⑤调度器巡检——每 15 分钟自检，发现问题自动建「[调度]」任务（如 T-324 看门狗不一致）；再加大头的手动/截图、拍板派工等零散入口。读取=vite 中间件 /api/platform/tasks（只读直查）。${tfLine}`},
    {id: 'kb', zh: '知识库', en: 'Knowledge',
      data: `笔记 ${N.length} 篇 · 连接 ${s.links} 条 · 未创建双链 ${s.ghosts}`,
      desc: '实物来源=D:\\Portable\\KnowledgeBase（Obsidian 仓库，C:\\Users\\ocean.xu\\KnowledgeBase 为 junction），markdown 现场扫描 · 读取=vite 中间件 kbGraphPlugin（/api/kb-graph，零写入正本）· 全文=/api/note-raw · 图内图片=/api/kb-asset。'},
    {id: 'decisions', zh: '拍板台', en: 'Decisions',
      data: `待拍板 ${D.filter(x => x.decision?.status === 'pending').length} · 累计 ${D.length}`,
      desc: '数据源=hub.db decisions 表（D:\\Portable\\Documents\\工作管理\\LoopDeck\\hub\\hub.db）· 读取=/api/platform/decisions · 写入=引擎 decide（三门槛落账，落账即推企业微信群）。'},
    {id: 'memory', zh: '记忆池', en: 'Memory',
      data: `条目 ${n('memory').length}`,
      desc: '实物来源=ZCode memory 真身（C:\\Users\\ocean.xu\\.zcode\\cli\\memories\\projects）＋ memorycore 状态（KnowledgeBase\\brain\\memorycore）· 读取=memoryStatePlugin（/api/memory-state，零打扰）· 全文=/api/mem-raw。'},
    {id: 'services', zh: '服务舱', en: 'Services',
      data: `在线 ${S.filter(x => x.service?.ok).length}/${S.length}`,
      desc: '数据源=workers\\registry.json（唯一注册表）＋ hub.db heartbeats（心跳）· 读取=/api/platform/services · 在线=心跳三态（ok/late/down）+ 独立 ping 探测。'},
    {id: null, zh: '生态流水', en: 'Stream',
      data: `最近事件 ${(eco?.events || []).length} 条`,
      desc: '数据源=hub.db events（最近 40 条，vite 直读 /api/entities 同源投影）· 左下角 30 秒轮询，新到的金色高亮。'}
  ];
  return <Modal title="关于这张生态星图" en="About the ecosystem" onClose={onClose} wide>
    <div className="about">
      <p>中心 <em>Core</em>：<strong>{CONFIG.workspace}</strong> · 数据每 30 秒从本机服务实时拉取。</p>
      <hr/>
      <h3>各模块的数据来源与逻辑 <em>Where the data lives</em>
        <span className="md-src-tip">点模块行打开「模块档案」：完整看数据 / 逻辑 / 文件路径；任务模块里可直接增改来源文件。</span>
      </h3>
      <ul className="src-list">
        {rows.map(r => {
          const main = <span className="src-row-main">
            <b>{r.zh} <em>{r.en}</em></b>
            <span className="src-data">{r.data}</span>
            <span className="src-desc">{r.desc}</span>
          </span>;
          return r.id
            ? <li key={r.zh}><button className="src-row" title={`打开${r.zh}模块档案`} onClick={() => onOpenDoc(r.id)}>{main}<Icon name="chevron" size={13}/></button></li>
            : <li key={r.zh} className="src-static">{main}</li>;
        })}
      </ul>
      {(() => {
        // 任务从哪来 · 实时（10-21）：/api/platform/sources 新增 taskCounts，一屏看清各通道条数与未结
        const tc = srcs?.taskCounts || [];
        const sum = (...ks) => tc.filter(t => ks.includes(t.source)).reduce((s, t) => s + (t.n || 0), 0);
        const opn = (...ks) => tc.filter(t => ks.includes(t.source)).reduce((s, t) => s + (t.open || 0), 0);
        if (!tc.length) return null;
        const groups = [
          ['Excel 来源', ['plan'], 1], ['微信', ['wechat', 'wxfile'], 1], ['调度器', ['cron'], 1],
          ['手动/截图', ['manual'], 1], ['星图/拍板/AI/其他', ['star-map', 'decision', 'ai', 'web', 'inbox', 'hub', 'oa', 'zcode', 'zrunner-test', 'km2026会话', 'feishu'], 0]
        ];
        return <p className="about-srcmap">任务从哪来 · 实时：{groups.map(([zh, ks]) => `${zh} ${sum(...ks)}${opn(...ks) ? `（${opn(...ks)} 未结）` : ''}`).join(' · ')}
          <button className="pill ghost about-src-btn" onClick={onOpenSources}>管理来源 <em>Manage</em></button>
        </p>;
      })()}
      <p>当前：{s.content} 条内容 · {s.links} 条连接 · {s.mutual} 组双向 · {s.ghosts} 个未创建双链。</p>
      <p className="quiet">数据全部本机，不外发；任务/拍板/验收/指令全部在星图内闭环（顶栏 🩺=生态体检）。<em>Local first, nothing is published.</em></p>
    </div>
  </Modal>;
}

// review 打回（10-16 批2）：hub.review reject 必填原因，弹窗输入而非原生 prompt。
function ReviewRejectModal({id, onClose, onDone}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title={`打回 ${id}`} en="Reject review" onClose={onClose}>
    <div className="confirm-box">
      <p className="confirm-line">打回后任务回到待办，原因会写进事件留痕（必填）。</p>
      <textarea className="reject-reason" rows={3} value={reason} onChange={e => setReason(e.target.value)} onFocus={wvFocus} onBlur={wvBlur} placeholder="哪里不达标、要改什么…"/>
      <div className="confirm-actions">
        <button className="primary danger" disabled={!reason.trim() || busy} onClick={async () => {
          setBusy(true);
          const r = await panelAction('review_reject', {id, reason: reason.trim()}).catch(() => null);
          onDone(r?.ok ? `${id} 已打回` : `失败：${r?.error || '写接口不可达'}`);
        }}>{busy ? '提交中…' : '确认打回'} <em>Reject</em></button>
        <button onClick={onClose}>取消 <em>Cancel</em></button>
      </div>
    </div>
  </Modal>;
}

// 页面级错误边界（10-14 审查短板②，10-16 壁纸黑屏案后补上）：任何组件崩溃只显示错误卡+重载按钮，
// 不再整树卸载把壁纸/页面变黑屏（ReferenceError: useRef 案=点附件图全屏黑，root 直接清空）。
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = {err: null}; }
  static getDerivedStateFromError(err) { return {err}; }
  componentDidCatch(err) { try { console.error('[ErrorBoundary]', err); } catch {} }
  render() {
    if (!this.state.err) return this.props.children;
    return <div className="eb-fallback" role="alert">
      <h2>页面出了个错 <em>Something broke</em></h2>
      <p>{String(this.state.err?.message || this.state.err)}</p>
      <button className="pill primary" onClick={() => location.reload()}>刷新页面 <em>Reload</em></button>
      <p className="quiet">错误已拦下没有黑屏；若反复出现请带着上面这行报错找 AI。</p>
    </div>;
  }
}

function focusFromLocation() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [mod, ...zone] = raw.split('/').filter(Boolean);
  if (PLATFORM_MODULES.some(m => m.id === mod)) return {mod, zone: zone.join('/'), sel: null};
  const q = new URLSearchParams(location.search);
  const legacyMod = q.get('mod'), legacyZone = q.get('zone');
  return legacyMod ? {mod: legacyMod, zone: legacyZone || '', sel: null} : {mod: null, zone: '', sel: null};
}

const routeForFocus = f => !f.mod ? '#/' : '#/' + f.mod + (f.zone ? '/' + encodeURIComponent(f.zone) : '');

function App() {
  // 哈希路由 #/模块/层级：可分享/可书签直达某层（也供无头截图验证壁纸端真实渲染）；
  // 旧 ?mod=&zone= 查询参数仍兼容（focusFromLocation 兜底）。
  const [focus, setFocus] = useState(focusFromLocation);
  const [modal, setModal] = useState(null);
  const [modalFrom, setModalFrom] = useState(null);   // 「返回」要回到的上一层弹窗（星图 10-21：关于 ↔ 模块档案/来源管理，不再一步回主页）
  const [docBack, setDocBack] = useState(null);       // 从档案页「进入视图」后，模块视图里按返回应回到数据来源层（档案页）而不是主页
  const [readNode, setReadNode] = useState(null);
  const [readStack, setReadStack] = useState([]);   // 阅读全文跳转链（星图 10-18）：双链直跳目标全文，栈存来路可一路返回
  const [toast, setToast] = useState('');
  const {eco, refresh} = usePlatform();
  const [deciding, setDeciding] = useState(null);   // 待确认的拍板动作（弹窗替代原生 confirm，内嵌浏览器里原生框不渲染）
  const [rejecting, setRejecting] = useState(null); // review 打回（必填原因）
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  // 阅读全文栈式打开：任何来源（按钮/双击/双链跳转）都经这里，跳转前把当前篇压栈；返回=弹栈
  const readRef = useRef(null);
  const openRead = useCallback(n => {
    if (!n) return;
    if (readRef.current) setReadStack(p => [...p, readRef.current]);
    readRef.current = n;
    setReadNode(n);
  }, []);
  const readBack = useCallback(() => {
    setReadStack(p => {
      const last = p[p.length - 1] || null;
      readRef.current = last;
      setReadNode(last);
      return p.slice(0, -1);
    });
  }, []);

  const pullRef = useRef(refresh);
  useEffect(() => { pullRef.current = refresh; }, [refresh]);

  useEffect(() => {
    const syncHash = () => {
      const next = focusFromLocation();
      setFocus(prev => (prev.mod === next.mod && prev.zone === next.zone) ? prev : next);
    };
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, []);

  useEffect(() => {
    const route = routeForFocus(focus);
    if (location.hash !== route) history.replaceState(null, '', route);
  }, [focus]);

  // 图谱导航（点水母/卡片/搜索跳转/hash 直达）时静默关闭阅读弹窗：用户已去别处，
  // 旧弹窗不该盖在新视图上（readClose 的 openInGraph 落点也会经过这里，幂等无副作用）
  useEffect(() => { readRef.current = null; setReadNode(null); setReadStack([]); }, [focus]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2800); return () => clearTimeout(t); }, [toast]);

  const close = useCallback(() => setModal(null), []);
  // 弹窗链（10-21 用户令「返回应回到上一层=数据来源层，而不是直接回主页」，所有来源模块通用）：
  // 关于 → 模块档案 / 来源管理：返回都回到「关于」（数据来源这层）；档案页「进入视图」→ 视图内返回 → 档案页
  const openDoc = useCallback(id => { setModal('doc:' + id); setModalFrom('about'); }, []);
  const backToAbout = useCallback(() => { setModal('about'); setModalFrom(null); setDocBack(null); }, []);
  const enterViewFromDoc = useCallback(id => { setModal(null); setModalFrom(null); setDocBack(id === 'stream' ? null : id); }, []);
  const graph = useMemo(() => buildGraph(eco || {}), [eco]);
  const layout = useMemo(() => forceLayout(graph), [graph]);
  const s = stats(graph);
  // 待拍板常驻条数据源（用户令「拍板固定在页面」）：有 pending 才现身，不随水母游走
  const pendingDecisions = useMemo(() => graph.nodes.filter(n => n.kind === 'decision' && n.decision?.status === 'pending'), [graph]);

  const openInGraph = useCallback(id => {
    const n = graph.index.get(id);
    const mod = {task: 'tasks', note: 'kb', decision: 'decisions', memory: 'memory', service: 'services', command: 'tasks'}[n?.kind];
    // 落到内容真实所在的目录层（笔记=分区+子路径；任务=所在清单层；服务=所在分类层），
    // 层级链完整展开：水母 → 分类 → 清单 → 选中项，不再只停在水母+第一层
    let z = null;
    if (mod === 'kb' && String(n.folder || '').startsWith('f:kb:'))
      z = [n.folder.slice(5), n.subzone].filter(Boolean).join('/') || null;
    else if (mod === 'tasks') {
      const today = new Date().toISOString().slice(0, 10);
      z = n.kind === 'command' ? '指令台账'
        : n.task?.status === 'review' ? '待验收'
        : n.task?.status !== 'done' ? '待办'
        : String(n.task?.done_at || '').slice(0, 10) === today ? '今日完成'
        : '累计完成/所有';
    }
    else if (mod === 'services')
      z = null;   // 服务舱已平铺（10-15），无分类层
    if (mod) setFocus({mod, zone: z, sel: id});
  }, [graph, setFocus]);
  // 关闭阅读全文：图谱落到最后看的那篇（双链跳了几篇，关掉正好停在那篇的分析面板）
  const readClose = useCallback(() => {
    if (readRef.current) openInGraph(readRef.current.id);
    readRef.current = null; setReadNode(null); setReadStack([]);
  }, [openInGraph]);
  const onAction = useCallback(a => {
    if (a.type === 'read') openRead(graph.index.get(a.id));
    if (a.type === 'readKb') {
      // 二进制原件（docx/pdf 等，kbserve 从里抽了文字但原件不是文本）：不进阅读弹窗报"读取失败"，
      // 复制完整路径让用户去资源管理器打开原件（壁纸 WebView2 里 window.open 本地文件也打不开）
      if (!/\.(md|txt)$/i.test(a.path || '')) {
        navigator.clipboard?.writeText(a.path).catch(() => {});
        setToast(`「${a.title || '该命中'}」是二进制原件（${String(a.path).split('.').pop()}），阅读全文只支持文本；完整路径已复制，去资源管理器粘贴打开`);
        return;
      }
      const vnode = {id: 'kb:' + a.path, kind: 'note', title: a.title || a.path, short: a.title || a.path, path: a.path};
      openRead(vnode);
    }
    if (a.type === 'taskOp') {
      setToast(`${a.id} 执行中…`);
      taskAction(a).then(r => {
        setToast(r?.ok ? (r.msg || '已执行') : `失败：${r?.msg || '未知错误'}`);
        if (r?.ok) pullRef.current?.();
      }).catch(() => setToast('写接口不可达（引擎宿主）'));
    }
    if (a.type === 'reviewOp') {
      if (a.op === 'accept') {
        setToast(`${a.id} 验收中…`);
        panelAction('review_accept', {id: a.id}).then(r => {
          setToast(r?.ok ? (r.msg || `${a.id} 已验收`) : `失败：${r?.error || r?.msg || '未知'}`);
          if (r?.ok) pullRef.current?.();
        }).catch(() => setToast('写接口不可达（引擎宿主）'));
      } else setRejecting(a.id);   // 打回必填原因 → 小弹窗
    }
    if (a.type === 'cmdOp' && a.op === 'rerun') {
      setToast(`${a.id} 重跑中…`);
      cmdAction({action: 'rerun', id: a.id}).then(r => {
        setToast(r?.ok ? (r.msg || '已重跑') : `失败：${r?.msg || '未知错误'}`);
        if (r?.ok) pullRef.current?.();
      }).catch(() => setToast('写接口不可达（引擎宿主）'));
    }
    if (a.type === 'addTask') setModal('task');
    if (a.type === 'addDecision') setModal('decision');
    if (a.type === 'ecoCheck') setModal('eco');
    if (a.type === 'decideOp') {
      setDeciding(a);
    }
  }, [graph, openRead]);

  const runDecide = useCallback(a => {
    setDeciding(null);
    setToast(`${a.id} 收口中…`);
    decideAction(a).then(r => {
      setToast(r?.ok ? (r.msg || '已收口') : `失败：${r?.msg || '未知错误'}`);
      if (r?.ok) pullRef.current?.();
    }).catch(() => setToast('写接口不可达（引擎宿主）'));
  }, []);

  return <div className="neural page-home">
    {/* 顶栏（星图 10-18 瘦身）：模块导航（"我的数字生态"等）与 任务/拍板/工者 徽标组按用户令撤下——
        模块入口本来就是水母本体（点击即进），顶部再挂一排按钮是重复；保留 品牌 + 🩺体检 + 头像 */}
    <header className="topbar slim">
      <a className="brand" href={asset('')} onClick={e => { e.preventDefault(); setFocus({mod: null, sel: null}); }}>
        <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 28" width="18" height="21"><path fill="#7d7f7c" d="m14 1 8 7-2 12-7 7-10-5L1 12 8 4Z"/><path fill="#d8d9d6" d="m14 1-3 10 2 16 7-7 2-12Z"/><path fill="#ecd9a6" d="m14 1-3 10 11-3Z"/><path fill="#a9aba7" d="m1 12 10-1 2 16-10-5Z"/></svg></span>
        <span className="brand-text">{CONFIG.brand.name} <b>/ {CONFIG.brand.sub}</b><small>{CONFIG.brand.tagline} · {CONFIG.brand.taglineEn}</small></span>
      </a>
      <div className="top-actions">
        <button className="avatar eco-avatar" onClick={() => setModal('eco')} aria-label="生态体检：定时任务/推送链路/AI 定时/当前在办，一屏看全健康面" title="生态体检：定时任务 / 推送链路 / AI 定时 / 当前在办，一屏看全健康面（代替晨检日报）">🩺</button>
        <button className="avatar" onClick={() => setModal('about')} aria-label="关于本图与数据来源"><img src={asset(CONFIG.avatar)} alt=""/></button>
      </div>
    </header>

    <main>
      <Home graph={graph} layout={layout} focus={focus} setFocus={setFocus} onAction={onAction} onAbout={() => setModal('about')} reduced={reduced} ecoEvents={eco?.events || []} docBack={docBack} onDocBack={() => openDoc(docBack)}/>
    </main>

    <footer className="site-foot">
      <button onClick={() => setModal('about')}><Icon name="info" size={13}/>数据来源：工作站实体投影 + 知识库现场扫描 · 任务·拍板就地收口 <em>Local &amp; live</em></button>
      <span>{CONFIG.footer.zh}<em>{CONFIG.footer.en}</em></span>
    </footer>

    {toast && <div className="toast glass" role="status"><Icon name="check" size={15}/>{toast}</div>}

    {/* 待拍板常驻条（10-18 用户令「拍板固定在页面」）：有 pending 才出现，固定右下不随水母游走；
        单案就地批准（共用拍板确认弹窗）、多案跳拍板台选方案；用途来历写在头上，不用进模块才知道这是干嘛的 */}
    {pendingDecisions.length > 0 && <aside className="pending-dock glass" aria-label="待拍板">
      <h3><Icon name="idea" size={14}/> 待拍板 <b>{pendingDecisions.length}</b> <em>Pending decisions</em></h3>
      <p className="pd-note">拍板=AI 干活拿不准、要你拿主意的事（D-xxx），三门槛才落账；落账即推微信，批准自动建任务派工。</p>
      {pendingDecisions.map(n => {
        const multi = (n.decision?.options?.length || 0) > 0;
        return <div key={n.id} className="pd-item">
          <button className="pd-title" title="进拍板台看详情" onClick={() => setFocus({mod: 'decisions', zone: null, sel: n.id})}>{n.short || n.title}</button>
          {multi
            ? <button className="pd-go" onClick={() => setFocus({mod: 'decisions', zone: null, sel: n.id})}>选方案 <em>Options</em></button>
            : <button className="pd-go" onClick={() => onAction({type: 'decideOp', id: n.decision?.id, to: 'approved'})}>批准 <em>Approve</em></button>}
        </div>;
      })}
    </aside>}

    {modal === 'about' && <AboutModal graph={graph} eco={eco} s={s} onClose={close} onOpenDoc={openDoc} onOpenSources={() => { setModal('sources'); setModalFrom('about'); }}/>}
    {modal === 'sources' && <SourcesModal onClose={backToAbout}/>}
    {modal?.startsWith('doc:') && <ModuleDocModal id={modal.slice(4)} graph={graph} eco={eco} s={s} onClose={backToAbout} onEnterView={() => enterViewFromDoc(modal.slice(4))} onGo={setFocus}/>}
    {deciding && <Modal title="拍板确认" en="Confirm decision" onClose={() => setDeciding(null)}>
      {(() => {
        const d = graph.nodes.find(n => n.decision?.id === deciding.id)?.decision || {};
        const TO_ZH = {approved: '批准', rejected: '否决', resolved: '销账（已处理）'};
        return <div className="confirm-box">
          <p className="confirm-line"><b>{deciding.id}</b>{d.title ? ` · ${d.title}` : ''}</p>
          <p className="confirm-line">动作：<b>{TO_ZH[deciding.to] || deciding.to}</b>{deciding.choice ? `（方案 ${deciding.choice}）` : ''}</p>
          {deciding.to === 'approved' && <p className="quiet">批准会走执行链：自动建关联任务并派 AI 执行会话。</p>}
          <div className="confirm-actions">
            <button className="primary" onClick={() => runDecide(deciding)}>确认执行 <em>Confirm</em></button>
            <button onClick={() => setDeciding(null)}>取消 <em>Cancel</em></button>
          </div>
        </div>;
      })()}
    </Modal>}
    {modal === 'task' && <TaskModal onClose={close} onDone={(tid, natt, alarmMsg = '') => {
      setModal(null);
      setToast(natt ? `${tid} 已入池（${natt} 附件解析中，约 20 秒回填）${alarmMsg}` : `${tid} 已入池${alarmMsg}`);
      pullRef.current?.();
    }}/>}
    {modal === 'decision' && <DecisionModal onClose={close} onDone={msg => {
      setModal(null);
      setToast(msg || '已落账并推微信');
      pullRef.current?.();
    }}/>}
    {modal === 'eco' && <EcoCheckModal onClose={close} eco={eco}/>}
    {rejecting && <ReviewRejectModal id={rejecting} onClose={() => setRejecting(null)} onDone={msg => {
      setRejecting(null);
      setToast(msg);
      pullRef.current?.();
    }}/>}
    {readNode && <Reader node={readNode} graph={graph}
      onJump={n => openRead(n)}   // 双链直跳：直接收节点对象（合成伪节点不在 graph.index，星图 10-18 三轮）
      onBack={readBack} canBack={readStack.length > 0}
      onTaskOp={onAction} onClose={readClose}/>}
  </div>;
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><App/></ErrorBoundary>);

// 壁纸模式标记（WebView2 宿主里才存在 chrome.webview）：底部元素避让任务栏区，
// 浏览器窗口模式无任务栏遮挡不受影响
if (window.chrome?.webview) document.body.classList.add('wallpaper-mode');

// FPS 诊断浮层（?fps=1 开启）：量化"卡不卡"——实时帧率/超 20ms 帧占比/最差帧耗时；
// 不带参数时零开销，平时不渲染
if (new URLSearchParams(location.search).get('fps')) {
  const el = document.createElement('div');
  el.className = 'fps-badge';
  document.body.appendChild(el);
  let n = 0, slow = 0, worst = 0, t0 = performance.now(), last = t0;
  const tick = now => {
    requestAnimationFrame(tick);
    const dt = now - last; last = now; n++;
    if (dt > 20) slow++;
    if (dt < 2000 && dt > worst) worst = dt;
    if (now - t0 >= 1000) {
      el.textContent = `${Math.round(n * 1000 / (now - t0))} fps · 超时帧 ${Math.round(slow / n * 100)}% · 最差 ${Math.round(worst)}ms`;
      n = 0; slow = 0; worst = 0; t0 = now;
    }
  };
  requestAnimationFrame(tick);
}
