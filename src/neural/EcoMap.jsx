import React, {useEffect, useState} from 'react';

// 生态全景图（星图 10-23 · 用户令「完整看到我个人生态的全流程和所有细节，精准且精致美观」）。
// 内容体组件——由 main.jsx 套 <Modal wide> 渲染（复用统一的弹窗骨架/复制/关闭）。
// 数据口径：静态结构=生态运行手册+代码实证（路径/端口/频率全部核实过）；动态状态=/api/eco-live
// （端口探测/剧本实况/代谢节律）+/api/platform/services（registry 工作者在役清单）。全只读。

// ── 五层静态架构（精准锚点：路径与频率来自 brain/build_memory.py、dispatcher.py PLAYBOOKS、
//    生态运行手册、vite.config.js 中间件清单，2026-10-23 核对） ──────────────────────
const LAYERS = [
  {
    id: 'l1', tag: '层1', name: '常驻卡层', en: 'Identity', color: '#9ff2cc',
    desc: '我给三端 AI 的身份与纪律怎么生成——正本唯一，产物禁手改',
    nodes: [
      {t: 'CORE.md 正本', s: 'D:/Portable/KnowledgeBase/brain/CORE.md · ≤30 行守卫'},
      {t: '端特有段', s: 'brain/ends/zcode.md · codex.md · claude.md'},
      {t: 'build_memory.py', s: '拼装正本+端段 → 三端产物'},
      {t: '三端 AGENTS.md', s: '~/.zcode/AGENTS.md · ~/.codex/AGENTS.md · ~/.claude/CLAUDE.md'}
    ],
    foot: '改常驻卡=只改 CORE.md 正本再跑构建；产物手改会被下次构建覆盖'
  },
  {
    id: 'l2', tag: '层2', name: '检索层', en: 'Retrieval', color: '#8fb8d8',
    desc: 'AI 和星图怎么找到知识——一个检索服务喂所有端',
    nodes: [
      {t: 'kbserve :8342', s: '语义+关键词混合检索 · 0.6B 余弦粗捞 + ONNX int8 精排(热驻留<5s)'},
      {t: '查询入口 ×3', s: '星图搜索框(kb-ask 整合回答) · 三端 AI 会话(HTTP) · 本地 grep(HOWTO-SEARCH)'},
      {t: '索引源', s: 'KnowledgeBase 全库 markdown 现场索引'}
    ],
    foot: '冷启动 10~30s 属常态；KB 笔记改动即被下一轮检索命中'
  },
  {
    id: 'l3', tag: '层3', name: '任务层', en: 'Tasks', color: '#e6cf98',
    desc: '一条任务的一生：五通道进池 → 状态机 → 归档',
    nodes: [
      {t: '入口五通道', s: '微信哨兵 wxwatch(@我三分拣) · Excel 来源扫描(列位映射) · 手动录入+截图 · 拍板批准自动派活 · AI 会话产出'},
      {t: 'hub.db 任务池', s: 'D:/…/LoopDeck/hub/hub.db · pending → doing → review → done（+waiting_confirm/dispatched）'},
      {t: '引擎宿主 :8331', s: '写操作唯一入口(/api/platform/actions/*) · dispatcher 15分钟一轮 routine 剧本'},
      {t: '星图 :5173', s: '只读投影面 · vite 7 中间件(node:sqlite mode=ro) · 任务卡/详情/阅读全文/就地编辑'},
      {t: '归档', s: 'done 留池可查 · 任务库归档(每周一 06:35 schtask) · 事件流 events_archive 剧本'}
    ],
    foot: '铁律：hub.db 永远只读；一切写操作只走 8331——星图和 AI 都不碰直写'
  },
  {
    id: 'l4', tag: '层4', name: '增长层', en: 'Growth', color: '#c9a6e0',
    desc: '记忆怎么运作、知识库怎么长知识——三进水管，收口都要人工确认',
    nodes: [
      {t: '会话收尾沉淀', s: '事件单条 → ~/.zcode/experience/ · 纠错教训 → KB 30-AI/AI纠错记录.md（单点制）'},
      {t: '记忆蒸馏', s: '每晚 21~23 点窗 · memorycore_distill 剧本 → KB 00-收件箱 → 人工确认入库'},
      {t: '人工笔记', s: 'KnowledgeBase .md · [[双链]]+tags · 星图 kb-graph 现场扫描成知识网络'},
      {t: '周同步', s: '每周六 memorycore_weeklysync · 池状态对账 · 记忆晋升走人工确认'}
    ],
    foot: 'ZCode 原生记忆已关(2026-10-22)：落点=experience 单条+KB 单点，不再双写'
  },
  {
    id: 'l5', tag: '层5', name: '备份层', en: 'Backup', color: '#9fc37c',
    desc: '怎么不丢——双地快照 + 私有云，全部剧本化无人守',
    nodes: [
      {t: 'kbbak 每日快照', s: '凌晨 · D盘 workers/kbbak/latest + OneDrive 离机副本（双份互备）'},
      {t: 'KB 云端推送', s: 'kb_git_push 15分钟 · GitHub 私有库(PromiseYa/KnowledgeBase) · 有新提交才推 · socks5 127.0.0.1:1082'},
      {t: '中枢快照', s: 'hub_snapshot 剧本 · hub.db 定期快照 · 坏库自愈 hub_health'},
      {t: '记忆体系备份', s: 'zcode_mem_backup · memories/experience/AGENTS.md 增量'}
    ],
    foot: '备份新鲜度有看门狗：kb_backup_check 剧本轮询，超期自动建告警任务'
  }
];

// ── 运行节律（dispatcher PLAYBOOKS + schtasks 实况，2026-10-23 对齐） ──
// 组件内函数：剧本数为 live 解析 dispatcher.py 的实数，不用写死副本防漂移
const rhythm = live => [
  ['每 2 分钟', 'StarMap-keep 看护', 'vite 星图进程 + Lively 壁纸链路，挂了自动拉起'],
  ['每 15 分钟', 'dispatcher 例行扫描', `${(live?.playbooks || []).filter(p => p.routine).length || 21} 个 routine 剧本全跑（健康探测/磁盘/归档/看门狗…）`],
  ['每 15 分钟', 'TFS取新 + KB云端推送', '任务来源 Excel 保鲜 · GitHub 私有库同步'],
  ['12 / 20 点', '体检门控 syscheck_gate', '快检全绿免 AI，异常才建任务'],
  ['每晚 21~23', '记忆蒸馏窗', '会话记忆 → KB 00-收件箱（人工确认后入正库）'],
  ['每周六', '记忆周同步', '池状态对账'],
  ['每周日', '中枢冒烟 smoke_test', '临时库隔离跑 hub.py 全流程'],
  ['每日', 'kbbak 快照 + 事件归档', '双地备份落地 · events 滚动归档'],
  ['每周一 06:35', '任务库归档 + ZCode库清理', 'schtask 直跑脚本，产出凭据供出勤看门狗核对']
];

export default function EcoMapBody() {
  const [live, setLive] = useState(null);
  const [svcs, setSvcs] = useState(null);
  useEffect(() => {
    let stop = false;
    fetch('/api/eco-live').then(r => r.json()).then(d => { if (!stop) setLive(d); }).catch(() => {});
    fetch('/api/platform/services').then(r => r.json()).then(d => { if (!stop && d?.ok) setSvcs(d.data || d); }).catch(() => {});
    return () => { stop = true; };
  }, []);
  const ports = live?.ports || [];
  const workers = (svcs?.workers || []).filter(w => !w.retired);
  const retired = (svcs?.workers || []).filter(w => w.retired);
  return <div className="emap">
    <p className="em-intro">五层结构 · 纯本地代谢（零 AI 定时、零推送，2026-10-20 脱钩 · 10-23 恢复本地剧本）。
      节点全为实物：路径/端口/频率逐一核对自 brain/build_memory.py、dispatcher 剧本注册表与计划任务实况；
      带呼吸灯的是当下在线状态。</p>

    {/* 在线服务全景（live TCP 探测） */}
    <section className="em-ports">
      <h3>在线服务全景 <em>Live services</em></h3>
      <div className="em-port-row">
        {ports.map(p => <div key={p.name} className={`em-port${p.self || p.ok ? ' on' : ' off'}`}>
          <i/>{p.name}<small>:{p.port}{p.self ? ' · 本面板' : p.ok === false ? ' · 不通' : ' · 在线'}</small>
        </div>)}
        {!live && <span className="quiet">端口探测中…</span>}
      </div>
    </section>

    {/* 五层流程：每层一条泳道，节点从左到右为流转方向 */}
    {LAYERS.map(L => <section key={L.id} className="em-lane" style={{'--lc': L.color}}>
      <div className="em-lane-head">
        <span className="em-lane-tag">{L.tag}</span>
        <div><b>{L.name} <em>{L.en}</em></b><p>{L.desc}</p></div>
      </div>
      <div className="em-flow">
        {L.nodes.map((n, i) => <div key={n.t} className="em-node-wrap">
          {i > 0 && <span className="em-arrow" aria-hidden="true">→</span>}
          <div className="em-node"><b>{n.t}</b><small>{n.s}</small></div>
        </div>)}
      </div>
      <p className="em-foot">{L.foot}</p>
    </section>)}

    {/* 层间总流向提示 */}
    <p className="em-chain">常驻卡约束三端 AI → AI 用检索层找知识 → 产出进任务层流转 → 增长层沉淀回知识库与记忆 → 备份层兜底不丢</p>

    {/* 运行节律 */}
    <section className="em-grid">
      <div className="em-col">
        <h3>运行节律 <em>Rhythm</em></h3>
        <ul className="em-rhythm">
          {rhythm(live).map(([when, what, note]) => <li key={what}><b>{when}</b><span>{what}<small>{note}</small></span></li>)}
        </ul>
      </div>
      <div className="em-col">
        <h3>结构零件 <em>Workers · registry</em></h3>
        <p className="em-sub">在役 {workers.length} · 退役留档 {retired.length}（workers/registry.json 唯一注册表）</p>
        <ul className="em-workers">
          {workers.slice(0, 14).map(w => <li key={w.id}><i className={w.hb_state === 'ok' ? 'on' : w.hb_state === 'down' ? 'off' : 'na'}/>{w.emoji ? w.emoji + ' ' : ''}{w.name || w.id}<small>{w.desc || w.type || ''}</small></li>)}
          {workers.length > 14 && <li className="em-more">…其余 {workers.length - 14} 个看服务舱</li>}
        </ul>
      </div>
    </section>
    <p className="em-src">数据源：/api/eco-live（端口 TCP 实测 · dispatcher.py 剧本注册表 live 解析 · hub.db events 代谢实况）+ /api/platform/services（registry.json + heartbeats）· 全部只读</p>
  </div>;
}
