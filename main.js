/**
 * 会议记录员 —— Forsion 桌面插件(裸 setup(ctx) 体,宿主 new Function('ctx', code) 装载)。
 *
 * Granola 式:会中只采麦克风录音 + 随手记要点,MediaRecorder 分段轮转(不能用 timeslice——
 * 后续 chunk 无容器头,不能独立转写),每段经 Forsion 自己的语音链路(window.tangu.transcribeAudio,
 * 设置 → 语音)转写,时间戳加段偏移并入总转写;每段转写完成即落盘,崩溃最多丢当前段;音频转写后即弃。
 * 会后 Tangu(随包「会议书记官」Agent,未播种或产出不合约自动回退默认助手)融合「你的要点 × 完整转写」,
 * 产出 ```minutes 代码块,插件解析后**外科式**回写:纪要节整节替换;行动项节做合并——
 * 同文案旧行的勾选状态原样带过、模型没给的旧行动项行(手写/上一轮)原字节保留,重新生成只加不毁。
 * 行动项跨会议聚合:按截止日排序、过期红标,勾选回写原文件该行。
 *
 * 录音状态全在模块级(bluebird 队列同款「不绑视图闭包」手法):关视图不断录,状态栏见「● 录音中」。
 * 安全:一切模型/用户/ASR 产出的文本只走 createElement+textContent(自建 renderMarkdown),
 * innerHTML 仅用于编译期静态模板字面量。主题吃宿主 token,浮层挂自己的 .mt-layer。
 */
const PLUGIN_ID = 'meeting-recorder'
// slug 带插件前缀 = agents/ 子目录名。绝不能叫 meeting-scribe:20260717 内容包有同名异契约老 agent
// (读模板出「# 会议纪要 + 表格行动项」,不吐 ```minutes 围栏),播种「已存在则保留」,撞车即永久劫持。
const AGENT_SLUG = 'meeting-recorder-scribe'
const APP_ID = 'tangu'
const DEFAULT_FOLDER = '会议记录员'
const SECTION_NAMES = ['要点速记', '转写', '纪要', '行动项']

ctx.registerSetting({ key: 'segmentMinutes', label: '转写分段时长(分钟)', type: 'number', default: 5, min: 2, max: 15, description: '录音每 N 分钟切一段送转写(2-15 夹取)。段越短实时转写越跟手;段越长转写调用越少。' })

// ── 纯函数(经文末 __MEETING_TEST__ 暴露给 check.mjs) ────────────────────────

const getSetting = (k, d) => { try { const v = localStorage.getItem(`plugin.${PLUGIN_ID}.${k}`); return v == null || v === '' ? d : v } catch { return d } }
const uuid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)
const pad2 = (n) => String(n).padStart(2, '0')

/** 秒 → 转写行时间戳 [HH:MM:SS](数据契约钉死,恒两位补零)。 */
function fmtTs(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  return `[${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}]`
}
/** 秒 → 要点/计时器的相对时间戳(MM:SS,过 1 小时带 H:)。603 → "10:03"。 */
function fmtBullet(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`
}
function localDate(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
const todayStr = () => localDate(Date.now())
function fmtDate(iso) {
  const t = Date.parse(String(iso || ''))
  if (Number.isNaN(t)) return String(iso || '')
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
function slugify(title) {
  const s = String(title || '').replace(/[\\/:*?"<>|#^[\]{}]/g, '').trim().replace(/\s+/g, '-').slice(0, 40)
  return s || '会议'
}
function clampSeg(v) { const n = parseInt(v, 10); return Number.isNaN(n) ? 5 : Math.min(15, Math.max(2, n)) }
const segMinutes = () => clampSeg(getSetting('segmentMinutes', '5'))
function safeHref(u) {
  const s = String(u || '').trim()
  return /^(https?:\/\/|#|mailto:)/i.test(s) ? s : ''
}

// ── 行动项行(格式钉死 `- [ ] 内容 @负责人 📅YYYY-MM-DD`,负责人/日期可缺省) ──

function parseActionLine(line) {
  const m = /^\s*- \[( |x|X)\]\s+(.*)$/.exec(String(line == null ? '' : line))
  if (!m || !m[2].trim()) return null
  let rest = m[2].trim(), due = '', owner = ''
  const dm = /\s*📅\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(rest)
  if (dm) { due = dm[1]; rest = rest.slice(0, dm.index).trim() }
  const om = /(?:^|\s)@([^\s@]+)$/.exec(rest)
  if (om) { owner = om[1]; rest = rest.slice(0, om.index).trim() }
  return { done: m[1] !== ' ', text: rest, owner, due }
}
function serializeAction(a) {
  return `- [${a.done ? 'x' : ' '}] ${a.text}${a.owner ? ` @${a.owner}` : ''}${a.due ? ` 📅${a.due}` : ''}`
}

// ── 会议文件(数据契约钉死:frontmatter mt_* + 四节) ─────────────────────────

function parseTranscriptLine(line) {
  const l = String(line == null ? '' : line)
  const m = /^\[(\d{2,}):(\d{2}):(\d{2})\]\s?(.*)$/.exec(l)
  if (m) return { t: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), text: m[4] }
  return l.trim() ? { t: -1, text: l } : null
}

/** 读端解析:容忍用户在笔记里加的私货(未知 frontmatter 键与未知节原样忽略,不进写路径)。 */
function parseMeeting(md) {
  const out = { title: '', dateIso: '', status: '', attendees: '', fmExtra: [], bullets: [], transcript: [], minutes: '', actions: [] }
  const text = String(md == null ? '' : md).replace(/\r\n/g, '\n')
  let body = text
  let fmLines = 0 // frontmatter 占掉的行数(行动项行号 = LF 规范化全文的 0 基行号,勾选回写按行定位用)
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (fm) {
    body = text.slice(fm[0].length)
    fmLines = fm[0].split('\n').length - 1
    for (const line of fm[1].split('\n')) {
      const kv = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line)
      if (!kv) { if (line.trim()) out.fmExtra.push(line); continue }
      if (kv[1] === 'mt_title') out.title = kv[2]
      else if (kv[1] === 'mt_date') out.dateIso = kv[2]
      else if (kv[1] === 'mt_status') out.status = kv[2]
      else if (kv[1] === 'mt_attendees') out.attendees = kv[2]
      else out.fmExtra.push(line)
    }
  }
  const secs = {}
  const actNos = [] // 与 secs['行动项'] 一一对应的全文行号
  let cur = null
  const bodyLines = body.split('\n')
  for (let bi = 0; bi < bodyLines.length; bi++) {
    const line = bodyLines[bi]
    const h = /^## (.+?)\s*$/.exec(line)
    if (h) { cur = SECTION_NAMES.includes(h[1]) ? h[1] : null; if (cur) secs[cur] = []; continue }
    if (cur) {
      secs[cur].push(line)
      if (cur === '行动项') actNos.push(fmLines + bi)
    }
  }
  out.bullets = (secs['要点速记'] || []).map((l) => l.replace(/^- /, '')).filter((l) => l.trim())
  out.transcript = (secs['转写'] || []).map(parseTranscriptLine).filter(Boolean)
  out.minutes = (secs['纪要'] || []).join('\n').trim()
  const actLines = secs['行动项'] || []
  for (let k = 0; k < actLines.length; k++) {
    const a = parseActionLine(actLines[k])
    if (a) { a.raw = actLines[k]; a.line = actNos[k]; out.actions.push(a) }
  }
  return out
}

/** 写端序列化:仅用于「插件独占文件」的阶段(创建 + 录音中草稿)。会后一律外科式改文本。 */
function serializeMeeting(m) {
  const fmx = (m.fmExtra || []).filter((l) => l && l.trim())
  const head = ['---', `mt_title: ${m.title || ''}`, `mt_date: ${m.dateIso || ''}`, `mt_status: ${m.status || 'done'}`, `mt_attendees: ${m.attendees || ''}`].concat(fmx, ['---'])
  const tr = (m.transcript || []).map((s) => (s.t >= 0 ? `${fmtTs(s.t)} ${s.text}` : s.text))
  const parts = head.concat(
    ['', '## 要点速记'], (m.bullets || []).map((b) => `- ${b}`),
    ['', '## 转写'], tr,
    ['', '## 纪要'], m.minutes ? m.minutes.split('\n') : [],
    ['', '## 行动项'], (m.actions || []).map(serializeAction),
    [''],
  )
  return parts.join('\n')
}

// ── 外科式文本操作(会后写路径:只动目标行/节,用户手写内容全保留) ──────────────

function setFmValue(md, key, value) {
  // 外科式操作反正整文件重写:先统一 CRLF→LF,外部编辑器留下的 \r 不再让行匹配失灵
  const text = String(md == null ? '' : md).replace(/\r\n/g, '\n')
  const fm = /^---\n[\s\S]*?\n---/.exec(text)
  if (!fm) return text
  const head = fm[0]
  const re = new RegExp(`^${key}:.*$`, 'm')
  const next = re.test(head) ? head.replace(re, `${key}: ${value}`) : head.replace(/\n---$/, `\n${key}: ${value}\n---`)
  return next + text.slice(head.length)
}
/** 替换 `## name` 节的正文(到下一个 `## ` 或文件尾);节不存在则追加到文件尾。幂等。CRLF 统一为 LF。 */
function replaceSection(md, name, body) {
  const text = String(md == null ? '' : md).replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const bodyLines = body ? String(body).replace(/\s+$/, '').split('\n') : []
  const start = lines.findIndex((l) => l.trim() === `## ${name}`)
  if (start < 0) {
    const base = text.replace(/\s+$/, '')
    return `${base}\n\n## ${name}\n${bodyLines.join('\n')}${bodyLines.length ? '\n' : ''}`
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) { if (/^## /.test(lines[i])) { end = i; break } }
  const rep = [`## ${name}`].concat(bodyLines, [''])
  return lines.slice(0, start).concat(rep, lines.slice(end)).join('\n')
}
/** 勾选回写:只翻转命中行的复选框字符,该行其余字节原样保留。CRLF 统一为 LF。
 *  身份 = 行号(parseMeeting 记录的 a.line)+ 行内容双校验:同文案行动项出现多次时,indexOf 永远翻第一条、
 *  用户点的那条纹丝不动——行号对得上才翻;行号失配(文件被编辑)退回全文唯一匹配,多于一条命中返回 null
 *  让上层提示刷新,绝不瞎翻。 */
function toggleActionInText(md, rawLine, done, lineNo) {
  const lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n')
  let i = -1
  if (Number.isInteger(lineNo) && lineNo >= 0 && lineNo < lines.length && lines[lineNo] === rawLine) i = lineNo
  else {
    const first = lines.indexOf(rawLine)
    if (first >= 0 && lines.indexOf(rawLine, first + 1) >= 0) return null // 同文多行且行号对不上:拒绝瞎翻
    i = first
  }
  if (i < 0 || !parseActionLine(lines[i])) return null
  lines[i] = lines[i].replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]')
  return lines.join('\n')
}

// ── ```minutes 块(Agent 产出契约) ──────────────────────────────────────────

function parseMinutesBlock(text) {
  const m = /```minutes[^\n]*\n([\s\S]*?)```/i.exec(String(text == null ? '' : text))
  if (!m) return null
  const body = m[1]
  const idx = body.indexOf('## 行动项')
  const head = idx >= 0 ? body.slice(0, idx) : body
  const minutes = head.replace(/^\s*## 纪要[^\n]*\n?/, '').trim()
  const actions = []
  if (idx >= 0) {
    for (const line of body.slice(idx).split('\n')) {
      const a = parseActionLine(line)
      if (a) actions.push(a)
    }
  }
  return { minutes, actions }
}
/** 取 `## name` 节的正文行(到下一个 `## ` 或文件尾);节不存在返回 []。 */
function sectionLines(md, name) {
  const lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${name}`)
  if (start < 0) return []
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) { if (/^## /.test(lines[i])) { end = i; break } }
  return lines.slice(start + 1, end)
}
/** 重新生成时合并行动项:同文案的旧行勾选状态原样带过(勾了的绝不弹回 [ ]);
 *  模型这轮没给的旧行动项行(手写补的 / 上一轮产出)原字节保留、缀在后面 —— 重新生成只加不毁。幂等。 */
function mergeActionLines(oldLines, newActions) {
  const olds = []
  for (const l of oldLines || []) {
    const a = parseActionLine(l)
    if (a) { a.raw = l; olds.push(a) }
  }
  const used = new Set()
  const out = (newActions || []).map((na) => {
    const i = olds.findIndex((oa, k) => !used.has(k) && oa.text === na.text)
    if (i < 0) return serializeAction(na)
    used.add(i)
    return serializeAction({ done: olds[i].done || na.done, text: na.text, owner: na.owner, due: na.due })
  })
  for (let k = 0; k < olds.length; k++) { if (!used.has(k)) out.push(olds[k].raw) }
  return out.join('\n')
}
/** 把纪要产出落进「最新盘上文本」:改状态 + 替换纪要节 + 合并行动项节。防 TOCTOU 的关键。 */
function applyMinutesToText(md, parsed) {
  let out = setFmValue(md, 'mt_status', 'done')
  out = replaceSection(out, '纪要', parsed.minutes)
  out = replaceSection(out, '行动项', mergeActionLines(sectionLines(md, '行动项'), parsed.actions))
  return out
}

// ── 段偏移合并:一段 ASR 结果 → 加该段起点偏移的转写行 ────────────────────────

function mergeSegments(res, offsetSec) {
  const off = Math.max(0, Math.round(Number(offsetSec) || 0))
  if (res && Array.isArray(res.segments) && res.segments.length) {
    return res.segments
      .filter((s) => s && String(s.text == null ? '' : s.text).trim())
      .map((s) => ({ t: off + Math.max(0, Math.round(Number(s.start) || 0)), text: String(s.text).trim() }))
  }
  const text = res == null ? '' : typeof res === 'string' ? res : String(res.text == null ? '' : res.text)
  return text.trim() ? [{ t: off, text: text.trim() }] : []
}

// ── 行内 / 块 Markdown → 安全 DOM(只 createElement+textContent,照抄 bluebird) ──

function inline(text) {
  const frag = document.createDocumentFragment()
  let rest = String(text == null ? '' : text)
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\n]+)\*|_([^_\n]+)_/
  let m
  while ((m = re.exec(rest))) {
    if (m.index > 0) frag.appendChild(document.createTextNode(rest.slice(0, m.index)))
    if (m[1] != null) { const b = document.createElement('strong'); b.textContent = m[1]; frag.appendChild(b) }
    else if (m[2] != null) { const c = document.createElement('code'); c.textContent = m[2]; frag.appendChild(c) }
    else if (m[3] != null) {
      const a = document.createElement('a'); a.textContent = m[3]
      const href = safeHref(m[4])
      if (href) { a.setAttribute('href', href); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer') }
      frag.appendChild(a)
    } else if (m[5] != null) { const e = document.createElement('em'); e.textContent = m[5]; frag.appendChild(e) }
    else if (m[6] != null) { const e = document.createElement('em'); e.textContent = m[6]; frag.appendChild(e) }
    rest = rest.slice(m.index + m[0].length)
  }
  if (rest) frag.appendChild(document.createTextNode(rest))
  return frag
}
function renderMarkdown(container, md) {
  container.textContent = ''
  const lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n')
  let i = 0, para = [], list = null, listTag = null
  const flushPara = () => { if (para.length) { const p = document.createElement('p'); p.appendChild(inline(para.join(' '))); container.appendChild(p); para = [] } }
  const flushList = () => { if (list) { container.appendChild(list); list = null; listTag = null } }
  while (i < lines.length) {
    const t = lines[i].replace(/\s+$/, '').trim()
    if (/^```/.test(t)) {
      flushPara(); flushList()
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++ }
      i++
      const pre = document.createElement('pre'); const code = document.createElement('code')
      code.textContent = buf.join('\n'); pre.appendChild(code); container.appendChild(pre)
      continue
    }
    if (t === '') { flushPara(); flushList(); i++; continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) { flushPara(); flushList(); const el2 = document.createElement('h' + Math.min(4, h[1].length)); el2.appendChild(inline(h[2])); container.appendChild(el2); i++; continue }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); flushList(); container.appendChild(document.createElement('hr')); i++; continue }
    if (/^>\s?/.test(t)) { flushPara(); flushList(); const bq = document.createElement('blockquote'); bq.appendChild(inline(t.replace(/^>\s?/, ''))); container.appendChild(bq); i++; continue }
    const ul = /^[-*]\s+(.*)$/.exec(t), ol = /^\d+\.\s+(.*)$/.exec(t)
    if (ul || ol) {
      flushPara()
      const want = ul ? 'ul' : 'ol'
      if (list && listTag !== want) flushList()
      if (!list) { list = document.createElement(want); listTag = want }
      const li = document.createElement('li'); li.appendChild(inline(ul ? ul[1] : ol[1])); list.appendChild(li)
      i++
      continue
    }
    flushList(); para.push(t); i++
  }
  flushPara(); flushList()
}
/** 转写行 → 安全 DOM(时间戳徽标 + 正文 textContent;ASR 结果按不可信处理)。 */
function renderTranscript(container, lines) {
  container.textContent = ''
  for (const s of lines || []) {
    const row = document.createElement('div'); row.className = 'mt-seg'
    if (s.t >= 0) { const ts = document.createElement('span'); ts.className = 'mt-ts'; ts.textContent = fmtTs(s.t); row.appendChild(ts) }
    const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = s.text
    row.appendChild(tx)
    container.appendChild(row)
  }
}

// ── 引擎配置 + 纯文本 run(照 bluebird 的 SSE 配方,无 execMode——纪要不需要工具) ──

async function getCfg() {
  try {
    const c = await (globalThis.window && window.tangu && window.tangu.getConfig ? window.tangu.getConfig() : null)
    if (c && c.backendUrl) return { backendUrl: c.backendUrl, token: c.token || '', modelId: c.modelId || '' }
  } catch { /* web 回退 */ }
  try { return { backendUrl: location.origin + '/api', token: localStorage.getItem('forsion_token') || '', modelId: '' } } catch { /* ignore */ }
  return { backendUrl: '', token: '', modelId: '' }
}
async function runAgent(cfg, sessionId, message, agentSlug, onTick, signal, onStage) {
  const stage = (s) => { if (onStage) onStage(s) }
  stage('提交任务')
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` }
  const reqBody = { session_id: sessionId, model_id: cfg.modelId || undefined, app_id: APP_ID, message, attachments: [] }
  if (agentSlug) reqBody.agent_config = { agentSlug }
  const start = await fetch(`${cfg.backendUrl}/agent/runs`, { method: 'POST', headers: h, signal, body: JSON.stringify(reqBody) })
  if (!start.ok) throw new Error((await start.text().catch(() => '')) || `起 run 失败 HTTP ${start.status}`)
  const { runId } = await start.json()
  if (!runId) throw new Error('引擎未返回 runId')
  const res = await fetch(`${cfg.backendUrl}/agent/runs/${encodeURIComponent(runId)}/events?fromSeq=0`, { headers: h, signal })
  if (!res.ok || !res.body) throw new Error(`订阅事件失败 HTTP ${res.status}`)
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = '', lastSeq = 0, content = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() || ''
    for (const line of parts) {
      const s = line.trim()
      if (!s || s.startsWith(':') || !s.startsWith('data:')) continue
      const data = s.slice(5).replace(/^ /, '')
      if (!data) continue
      let ev
      try { ev = JSON.parse(data) } catch { continue }
      if (typeof ev.seq === 'number') { if (ev.seq <= lastSeq) continue; lastSeq = ev.seq }
      if (ev.type === 'status') { stage(ev.payload && ev.payload.state === 'queued' ? '排队中' : '准备中'); continue }
      if (ev.type === 'token') {
        const d = ev.payload && ev.payload.delta
        if (d) { content += d; stage('生成纪要中'); if (onTick) onTick(content) }
        continue
      }
      if (ev.type === 'done') { stage('完成'); return (ev.payload && ev.payload.content) || content }
      if (ev.type === 'error') throw new Error((ev.payload && ev.payload.error) || '生成失败')
    }
  }
  throw new Error('与引擎的连接中断,未收到完成事件(可重试)')
}
/** 注入模型的指令一律英文(语言纪律);格式字面量(## 纪要 等)是钉死的数据契约,原样给出。 */
function buildMinutesPrompt(m) {
  const bullets = m.bullets.length ? m.bullets.map((b) => `- ${b}`).join('\n') : '(none)'
  const transcript = m.transcript.length ? m.transcript.map((s) => (s.t >= 0 ? `${fmtTs(s.t)} ${s.text}` : s.text)).join('\n') : '(empty)'
  return `You are a faithful meeting scribe. Merge the user's live bullet notes (authoritative for intent and emphasis) with the full ASR transcript (authoritative for coverage; may contain recognition errors) into structured meeting minutes.

Hard rules:
- Every statement must come from the bullets or the transcript. Never invent decisions, numbers, dates, or facts.
- Assign an action-item owner only when that exact name appears in the bullets, transcript, or attendee list; when unsure, omit the owner.
- Include a due date only when one is explicitly mentioned; resolve relative dates against the meeting date below.
- Write the minutes in the same language as the transcript/bullets (Chinese content means Chinese minutes).
- Leading timestamps (MM:SS in bullets, [HH:MM:SS] in the transcript) are elapsed time from meeting start.

Output EXACTLY ONE fenced code block tagged "minutes" and nothing else. Do NOT put any nested code fences inside it. Format:

\`\`\`minutes
## 纪要
### <topic>
- <discussion point / decision, grouped by topic>

## 行动项
- [ ] <task> @<owner> 📅<YYYY-MM-DD>
\`\`\`

Keep the two section headers exactly "## 纪要" and "## 行动项". In action lines, "@owner" and "📅date" are both optional; omit what is unknown, never guess. If there are no action items, leave that section empty.

Meeting title: ${m.title}
Meeting date (ISO): ${m.dateIso}
Attendees: ${m.attendees || '(not provided)'}

## Live bullet notes
${bullets}

## Full transcript
${transcript}`
}

// ── 录音 Blob → 16kHz 单声道 WAV base64(照抄宿主 useVoiceInput;check 里 stub) ──

function wavBase64(pcm, sampleRate) {
  const n = pcm.length
  const buf = new ArrayBuffer(44 + n * 2)
  const dv = new DataView(buf)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE')
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  w(36, 'data'); dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  return btoa(bin)
}
/** 可替换钩子:check 环境给不起 AudioContext,wav 一步经此间接层 stub(真机验收项)。 */
const hooks = {
  wav: async function blobToWav16kBase64(blob) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext
    if (!AC || !globalThis.OfflineAudioContext) throw new Error('当前环境没有音频解码能力(AudioContext 缺失)')
    const arrayBuf = await blob.arrayBuffer()
    const ac = new AC()
    let decoded
    try { decoded = await ac.decodeAudioData(arrayBuf) } finally { try { const p = ac.close(); if (p && p.catch) p.catch(() => {}) } catch { /* ignore */ } }
    const frames = Math.max(1, Math.round(decoded.duration * 16000))
    const off = new OfflineAudioContext(1, frames, 16000)
    const src = off.createBufferSource()
    src.buffer = decoded
    src.connect(off.destination)
    src.start()
    const rendered = await off.startRendering()
    const pcm = rendered.getChannelData(0)
    let peak = 0
    for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a }
    // 连续会议录音里整段安静(静音键/冷场)是常态不是故障:返回 null 让调用方落「未识别到语音」
    // 良性占位,跳过转写、不计失败(push-to-talk 那套「静音=报错」不适用于这里)
    if (peak < 0.005) return null
    return wavBase64(pcm, 16000)
  },
}

// ── 持久化:工作文件夹 + 索引(打开自愈,孤儿剔除) ────────────────────────────

const root = () => (ctx.app.workFolder ? ctx.app.workFolder() : DEFAULT_FOLDER)
const indexPath = () => `${root()}/.meeting-index.json`
/** 索引写串行闸:ensureWorkFolder / upsertIndex / healIndex 都是「读 → 改 → 写」跨 IPC 往返,
 *  并发交错会用旧快照覆盖别人刚写的条目(首装时 mount 的 ensureWorkFolder × 立即开录的 upsertIndex
 *  能把第一条会议从索引里永久抹掉——没有目录重扫,抹了找不回)。同一时刻只放一条索引写链。 */
let idxChain = Promise.resolve()
function withIndexLock(fn) {
  const run = idxChain.then(fn)
  idxChain = run.then(() => undefined, () => undefined)
  return run
}
async function readIndexFile() {
  try {
    const t = ctx.app.readFile ? await ctx.app.readFile(indexPath()) : null
    const j = t ? JSON.parse(t) : null
    return j && Array.isArray(j.meetings) ? { meetings: j.meetings } : { meetings: [] }
  } catch { return { meetings: [] } }
}
const writeIndexFile = (idx) => ctx.app.writeFile(indexPath(), JSON.stringify(idx, null, 2))
async function upsertIndex(path, meeting) {
  return withIndexLock(async () => {
    const idx = await readIndexFile()
    const entry = { path, title: meeting.title || '', date: meeting.dateIso || '', status: meeting.status || 'done', openActions: (meeting.actions || []).filter((a) => !a.done).length }
    idx.meetings = [entry].concat(idx.meetings.filter((x) => x && x.path !== path))
    await writeIndexFile(idx)
  })
}
/** 打开时自愈:孤儿剔除、字段按文件实况重算;崩溃残留的 recording(当前并没有在录)降为 transcribed。 */
async function healIndex() {
  return withIndexLock(async () => {
    const idx = await readIndexFile()
    const meetings = []
    let changed = false
    for (const m of idx.meetings || []) {
      if (!m || !m.path) { changed = true; continue }
      // 只有「读到 null」(宿主契约 = 文件不存在)才算孤儿;readFile 抛错是瞬时故障(云库抖动/IPC 失败),
      // 剔了就永远找不回来(没有目录重扫路径)——这一轮原样保留该条目
      let text = null, readFailed = false
      try { text = ctx.app.readFile ? await ctx.app.readFile(m.path) : null } catch { readFailed = true }
      if (readFailed) { meetings.push(m); continue }
      if (text == null) { changed = true; continue }
      const p = parseMeeting(text)
      if (p.status === 'recording' && !((recState.active || recState.stopping) && recState.path === m.path)) {
        try { await ctx.app.writeFile(m.path, setFmValue(text, 'mt_status', 'transcribed')); p.status = 'transcribed' } catch { /* ignore */ }
      }
      const entry = { path: m.path, title: p.title || m.title || '', date: p.dateIso || m.date || '', status: p.status || m.status || 'done', openActions: p.actions.filter((a) => !a.done).length }
      if (JSON.stringify(entry) !== JSON.stringify(m)) changed = true
      meetings.push(entry)
    }
    const healed = { meetings }
    if (changed) { try { await writeIndexFile(healed) } catch { /* ignore */ } }
    return healed
  })
}
/** 眼见为实:打开插件就把工作文件夹落进库(写空索引),不必等第一场会才出现在文件树。
 *  在索引锁里跑:mount 时不 await 它,若与「立即开始录音」的 upsertIndex 交错,读到 null 旧快照的
 *  空索引写会把首条会议覆盖掉——串行闸保证它写完 upsertIndex 才读。 */
async function ensureWorkFolder() {
  if (!ctx.app.readFile || !ctx.app.writeFile) return
  return withIndexLock(async () => {
    try {
      const t = await ctx.app.readFile(indexPath())
      if (t == null) await writeIndexFile({ meetings: [] })
    } catch { /* ignore */ }
  })
}
async function uniqueMeetingPath(title, nowMs) {
  const base = `${root()}/${localDate(nowMs)}-${slugify(title)}`
  let p = `${base}.md`
  for (let n = 2; n < 100; n++) {
    let hit = null
    try { hit = ctx.app.readFile ? await ctx.app.readFile(p) : null } catch { hit = null }
    if (hit == null) return p
    p = `${base}-${n}.md`
  }
  return `${base}-${Date.now() % 100000}.md`
}

// ── 跨视图小总线 ─────────────────────────────────────────────────────────────

const bus = (() => { const subs = new Set(); return { on: (f) => (subs.add(f), () => subs.delete(f)), emit: (e) => subs.forEach((f) => { try { f(e) } catch { /* ignore */ } }) } })()
const say = (m, o) => (ctx.notify ? ctx.notify(m, o) : ctx.app.notify(m))

// ── 录音引擎(全模块级:关视图不断录;dispose 才收) ──────────────────────────

const recState = {
  active: false, stopping: false, finalized: false,
  path: '', meeting: null, startedAt: 0, segStartAt: 0,
  segIndex: 0, doneSegs: 0, failedSegs: 0, pending: 0,
  stream: null, recorder: null, audioCtx: null, analyser: null,
  rotateTimer: null, tickTimer: null, error: '',
}
function resetRecState() {
  clearTimeout(recState.rotateTimer)
  clearTimeout(recState.tickTimer)
  Object.assign(recState, {
    active: false, stopping: false, finalized: false,
    path: '', meeting: null, startedAt: 0, segStartAt: 0,
    segIndex: 0, doneSegs: 0, failedSegs: 0, pending: 0,
    stream: null, recorder: null, audioCtx: null, analyser: null,
    rotateTimer: null, tickTimer: null, error: '',
  })
}
function capability() {
  const hasMic = !!(globalThis.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  const hasRec = typeof globalThis.MediaRecorder !== 'undefined'
  const hasAsr = !!(globalThis.window && window.tangu && window.tangu.transcribeAudio)
  if (hasMic && hasRec && hasAsr) return { ok: true, reason: '' }
  const miss = []
  if (!hasMic) miss.push('麦克风采集(navigator.mediaDevices)')
  if (!hasRec) miss.push('录音器(MediaRecorder)')
  if (!hasAsr) miss.push('语音识别桥(window.tangu.transcribeAudio;需 Forsion 桌面端,并在 设置 → 语音 配好识别模型)')
  return { ok: false, reason: `当前环境缺少:${miss.join('、')}。录音功能不可用;已有会议的浏览与纪要生成不受影响。` }
}
async function writeRecDraft() {
  // finalized 后禁写:收尾终稿(mt_status: transcribed)落盘之后,迟到的草稿写会把状态倒回 recording
  if (!recState.path || !recState.meeting || recState.finalized) return
  try { await ctx.app.writeFile(recState.path, serializeMeeting(recState.meeting)) }
  catch (e) { recState.error = '落盘失败:' + ((e && e.message) || e) }
}
/** 开录进行中闸(权限弹窗可开着好几秒):入口即置位,双路并发第二路直接拒,绝不等 await 之后才裁决。 */
let recStarting = false
/** 插件已停用标记:等权限/等路径期间被 dispose,继续开录就是收不掉的孤儿热麦克风,必须半路刹车。 */
let pluginDisposed = false
const stopTracks = (s) => { if (s && s.getTracks) { try { s.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ } } }
async function startRecording(title, attendees) {
  if (recStarting || recState.active || recState.stopping || pluginDisposed) { say('已有一场录音在进行中', { level: 'warning' }); return { ok: false, error: 'busy' } }
  const cap = capability()
  if (!cap.ok) { say(cap.reason, { level: 'error' }); return { ok: false, error: cap.reason } }
  recStarting = true
  try {
    let stream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch (e) {
      const name = e && e.name
      const msg = name === 'NotAllowedError' ? '麦克风权限被拒绝(打开 系统设置 › 隐私与安全 › 麦克风,允许本 App)'
        : name === 'NotFoundError' ? '没检测到麦克风设备'
          : `麦克风打不开:${name || (e && e.message) || e}`
      say(msg, { level: 'error' })
      return { ok: false, error: msg }
    }
    // 权限弹窗期间插件被停用 / 状态被占(recStarting 已挡并发,这里是防未来改动的双保险):停掉刚拿到的流再退
    if (pluginDisposed || recState.active || recState.stopping) { stopTracks(stream); return { ok: false, error: 'busy' } }
    resetRecState()
    const now = Date.now()
    const meeting = {
      title: String(title || '').trim() || '即时会议', dateIso: new Date(now).toISOString(), status: 'recording',
      attendees: String(attendees || '').trim(), fmExtra: [], bullets: [], transcript: [], minutes: '', actions: [],
    }
    let path
    try { path = await uniqueMeetingPath(meeting.title, now) } catch { path = `${root()}/${localDate(now)}-${slugify(meeting.title)}.md` }
    // 查重名是慢路径(云库逐个 readFile):这段 await 期间同样可能被 dispose,提交前最后一查
    if (pluginDisposed) { stopTracks(stream); return { ok: false, error: 'busy' } }
    Object.assign(recState, { active: true, path, meeting, startedAt: now, stream })
    // 实时波形:AnalyserNode 挂在流上(不连 destination = 不外放);失败不影响录音本身
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext
      if (AC) {
        const ac = new AC()
        const node = ac.createAnalyser()
        node.fftSize = 128
        node.smoothingTimeConstant = 0.7
        ac.createMediaStreamSource(stream).connect(node)
        recState.audioCtx = ac
        recState.analyser = node
      }
    } catch { /* 可视化非关键 */ }
    await writeRecDraft()
    try { await upsertIndex(path, meeting) } catch { /* 打开时自愈 */ }
    if (!startSegment()) {
      // MediaRecorder 构造失败:绝不报 ok:true 留一个空转会话 + 冻死的「● 录音中 00:00」状态栏。
      // 已落盘的空草稿降级 transcribed(与崩溃自愈同款结局),状态栏复位,报真实错误。
      const err = recState.error || '录音器启动失败'
      releaseMedia()
      const failedMeeting = recState.meeting, failedPath = recState.path
      if (failedMeeting) {
        failedMeeting.status = 'transcribed'
        try { await ctx.app.writeFile(failedPath, serializeMeeting(failedMeeting)) } catch { /* 打开时自愈 */ }
        try { await upsertIndex(failedPath, failedMeeting) } catch { /* 打开时自愈 */ }
      }
      resetRecState()
      if (sb && sb.update) sb.update({ text: '🎙 会议', title: '会议记录员' })
      say(err, { level: 'error' })
      return { ok: false, error: err }
    }
    tickLoop()
    if (sb && sb.update) sb.update({ text: '● 录音中 00:00', title: '会议记录员:录音中,点击查看' })
    bus.emit({ type: 'rec-start' }) // 一次性「开录了」事件:视图切进录音页只认它;周期性 'rec' 只刷数据
    return { ok: true, path }
  } finally { recStarting = false }
}
/** 分段轮转:到点 stop → onstop 里对同一条流 new MediaRecorder 续录(timeslice 的后续 chunk 无容器头,不能用)。
 *  构造失败返回 false 上报调用方:开录首段由 startRecording 收拾并报 ok:false;轮转续段由 onstop 收尾这场录音。 */
function startSegment() {
  const MR = globalThis.MediaRecorder
  let r
  try { r = new MR(recState.stream) } catch (e) {
    recState.error = '录音器启动失败:' + ((e && e.message) || e)
    return false
  }
  recState.recorder = r
  recState.segIndex++
  recState.segStartAt = Date.now()
  const segNo = recState.segIndex
  const offset = Math.max(0, Math.round((recState.segStartAt - recState.startedAt) / 1000))
  const chunks = []
  r.ondataavailable = (e) => { if (e && e.data && e.data.size) chunks.push(e.data) }
  r.onstop = () => {
    r.__mtStopPending = false
    const blob = !chunks.length ? null
      : chunks.length === 1 ? chunks[0]
        : typeof Blob === 'undefined' ? chunks[0] : new Blob(chunks, { type: r.mimeType || 'audio/webm' })
    if (blob) transcribeSegment(segNo, offset, blob) // 异步转写,不阻塞续录;同步段先 pending++,定稿闸拦得住
    if (recState.active && !recState.stopping) { if (!startSegment()) finishRecording() }
    else { releaseMedia(); maybeFinalize() }
  }
  try { r.start() } catch { /* ignore */ }
  scheduleRotate()
  return true
}
function scheduleRotate() {
  clearTimeout(recState.rotateTimer)
  recState.rotateTimer = setTimeout(() => {
    if (!recState.active || recState.stopping) return
    const r = recState.recorder
    // stop() 调用成功即置 __mtStopPending:真 MediaRecorder 的 onstop 是异步派发的,
    // 这段 flush 窗口里用户点「结束录音」不能提前定稿(见 finishRecording)
    if (r) { try { r.stop(); r.__mtStopPending = true } catch { /* ignore */ } }
  }, segMinutes() * 60000)
}
async function transcribeSegment(segNo, offsetSec, blob) {
  recState.pending++
  bus.emit({ type: 'rec' })
  const meeting = recState.meeting
  try {
    const b64 = await hooks.wav(blob)
    if (b64 == null) {
      // 静音段(hooks.wav 电平检测):良性占位,不送转写、不计失败
      if (meeting) insertTranscript(meeting, [{ t: offsetSec, text: `(第 ${segNo} 段未识别到语音)` }])
      recState.doneSegs++
    } else {
      const t = globalThis.window && window.tangu && window.tangu.transcribeAudio
      if (!t) throw new Error('语音识别桥不可用')
      const res = await t({ audioBase64: b64, mime: 'audio/wav', timestamps: true })
      const lines = mergeSegments(res, offsetSec)
      if (meeting) {
        if (lines.length) insertTranscript(meeting, lines)
        else insertTranscript(meeting, [{ t: offsetSec, text: `(第 ${segNo} 段未识别到语音)` }])
      }
      recState.doneSegs++
    }
  } catch (e) {
    recState.failedSegs++
    if (meeting) insertTranscript(meeting, [{ t: offsetSec, text: `(第 ${segNo} 段转写失败:${(e && e.message) || e})` }])
  }
  recState.pending--
  await writeRecDraft() // 每段转写完成即落盘:崩溃最多丢当前段
  bus.emit({ type: 'rec' })
  maybeFinalize()
}
function insertTranscript(meeting, lines) {
  for (const l of lines) meeting.transcript.push(l)
  meeting.transcript.sort((a, b) => (a.t < 0 ? 1 : b.t < 0 ? -1 : a.t - b.t))
}
async function finishRecording() {
  if (!recState.active && !recState.stopping) return
  if (recState.stopping) return
  recState.stopping = true
  recState.active = false
  clearTimeout(recState.rotateTimer)
  const r = recState.recorder
  recState.recorder = null
  bus.emit({ type: 'rec' })
  if (r) {
    // 轮转的 stop 已发出、onstop 还没回(编码 flush 窗口,数毫秒~数十毫秒):此刻绝不能立刻定稿——
    // 末段 blob 还没交付,提前 maybeFinalize 会把终稿写盘,迟到的末段转写被 finalized 闸挡在门外
    // (最后一段会议内容无声消失)。收尾交给即将到来的 onstop:它的 else 分支会 releaseMedia+maybeFinalize,
    // 且 transcribeSegment 同步段先 pending++,定稿必然等到末段转写落地。
    if (r.__mtStopPending) return
    try { r.stop(); r.__mtStopPending = true; return } catch { /* fallthrough:录音器从未 start 成功,onstop 不会来 */ }
  }
  releaseMedia()
  maybeFinalize()
}
function releaseMedia() {
  const s = recState.stream
  recState.stream = null
  if (s && s.getTracks) { try { s.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ } }
  const ac = recState.audioCtx
  recState.audioCtx = null
  recState.analyser = null
  if (ac && ac.close) { try { const p = ac.close(); if (p && p.catch) p.catch(() => {}) } catch { /* ignore */ } }
}
async function maybeFinalize() {
  if (!recState.stopping || recState.finalized || recState.pending > 0) return
  recState.finalized = true
  clearTimeout(recState.tickTimer)
  const meeting = recState.meeting, path = recState.path
  if (meeting) {
    meeting.status = 'transcribed'
    try {
      await ctx.app.writeFile(path, serializeMeeting(meeting))
      await upsertIndex(path, meeting)
    } catch { /* 打开时自愈 */ }
  }
  recState.stopping = false
  if (sb && sb.update) sb.update({ text: '🎙 会议', title: '会议记录员' })
  say(recState.failedSegs ? `录音结束,转写完成(${recState.failedSegs} 段失败,已在转写里标注占位)` : '录音结束,转写完成', { level: recState.failedSegs ? 'warning' : 'success' })
  if (ctx.activity && ctx.activity.log) ctx.activity.log('meeting_recorded', { title: meeting ? meeting.title : '' })
  bus.emit({ type: 'rec-done', path })
}
/** 要点速记:Enter 落一条,自动带相对时间戳(MM:SS,自会议开始)。
 *  收尾窗口(stopping:剩余分段还在转写,可能长达数秒)照收——meeting 还活着,终稿会带上它。 */
function addBullet(text) {
  const s = String(text || '').trim()
  if (!s || !(recState.active || recState.stopping) || recState.finalized || !recState.meeting) return Promise.resolve(false)
  const sec = Math.max(0, Math.round((Date.now() - recState.startedAt) / 1000))
  recState.meeting.bullets.push(`${fmtBullet(sec)} ${s}`)
  bus.emit({ type: 'rec' })
  return writeRecDraft().then(() => true)
}
/** 秒表:setTimeout 自排程(轮询纪律);只在录音期活动,收尾即停。 */
function tickLoop() {
  clearTimeout(recState.tickTimer)
  const step = () => {
    if (!recState.active && !recState.stopping) {
      // 退出前把状态栏复位一次:任何路径漏掉复位也不许把「● 录音中」冻死在状态栏
      if (sb && sb.update) sb.update({ text: '🎙 会议', title: '会议记录员' })
      return
    }
    if (sb && sb.update) {
      const sec = recState.startedAt ? Math.max(0, Math.round((Date.now() - recState.startedAt) / 1000)) : 0
      sb.update({ text: recState.active ? `● 录音中 ${fmtBullet(sec)}` : '● 完成转写中…', title: '会议记录员:点击查看' })
    }
    bus.emit({ type: 'tick' })
    recState.tickTimer = setTimeout(step, 1000)
  }
  recState.tickTimer = setTimeout(step, 1000)
}

// ── 纪要生成引擎(模块级:关视图不中断;每会议至多一个在跑) ────────────────────

const gen = new Map() // path → { status:'running'|'error', label, text, error, controller }
async function generateMinutes(path) {
  const running = gen.get(path)
  if (running && running.status === 'running') { say('这场会议的纪要正在生成中', { level: 'info' }); return }
  let md = null
  try { md = ctx.app.readFile ? await ctx.app.readFile(path) : null } catch { md = null }
  if (md == null) { say('读不到会议文件(可能已被移动或删除)', { level: 'error' }); return }
  const meeting = parseMeeting(md)
  if (!meeting.bullets.length && !meeting.transcript.length) { say('这场会议既没有要点也没有转写内容,没法生成纪要', { level: 'warning' }); return }
  const cfg = await getCfg()
  if (!cfg.backendUrl || !cfg.token) {
    const msg = cfg.backendUrl ? '请先登录 Forsion' : '未连接到 Tangu 引擎(需 Forsion 桌面端)'
    gen.set(path, { status: 'error', label: '', text: '', error: msg, controller: null })
    bus.emit({ type: 'gen', path })
    say(msg, { level: 'error' })
    return
  }
  const g = { status: 'running', label: '提交任务', text: '', error: '', controller: new AbortController() }
  gen.set(path, g)
  bus.emit({ type: 'gen', path })
  const message = buildMinutesPrompt(meeting)
  const onTick = (full) => { g.text = full; bus.emit({ type: 'gen', path }) }
  const onStage = (label) => { g.label = label; bus.emit({ type: 'gen', path }) }
  try {
    let usedFallback = false
    let out
    try {
      out = await runAgent(cfg, uuid(), message, AGENT_SLUG, onTick, g.controller.signal, onStage)
    } catch (e) {
      // 随包 agent 未播种(旧宿主/装后未重启引擎)会在产出任何 token 前失败 → 回退不带 agentSlug。
      // 指令全在 message 里,行为一致;已开始产出/主动取消则不重试(避免白烧一轮)。
      if (g.controller.signal.aborted || g.text) throw e
      onStage('回退默认助手重试')
      usedFallback = true
      out = await runAgent(cfg, uuid(), message, null, onTick, g.controller.signal, onStage)
    }
    let parsed = parseMinutesBlock(out)
    const unusable = (p) => !p || (!p.minutes && !p.actions.length)
    if (unusable(parsed) && !usedFallback && !g.controller.signal.aborted) {
      // 首轮带 slug 正常产出了 token 却解析不出 ```minutes:十有八九是引擎里蹲着同 slug 异契约的
      // 旧 agent(播种「已存在则保留」,老实体永远不被覆盖,产出别的格式)——再回退一轮默认助手,
      // 而不是直接报死错让用户每次白烧一轮 token 且永无自愈。
      onStage('产出不合约,回退默认助手重试')
      g.text = ''
      usedFallback = true
      out = await runAgent(cfg, uuid(), message, null, onTick, g.controller.signal, onStage)
      parsed = parseMinutesBlock(out)
    }
    if (unusable(parsed)) throw new Error('模型没有按约定返回 ```minutes 代码块,请重试一次')
    // 防 TOCTOU:生成期间用户可能在笔记里改过这份文件 —— 重新读盘,外科式只替换 纪要/行动项/状态
    let fresh = null
    try { fresh = await ctx.app.readFile(path) } catch { fresh = null }
    if (fresh == null) throw new Error('会议文件在生成期间被移动或删除,纪要未写入')
    const nextText = applyMinutesToText(fresh, parsed)
    await ctx.app.writeFile(path, nextText)
    try { await upsertIndex(path, parseMeeting(nextText)) } catch { /* 打开时自愈 */ }
    if (ctx.activity && ctx.activity.log) ctx.activity.log('meeting_done', { title: meeting.title })
    say('纪要已生成', { level: 'success' })
    gen.delete(path)
    bus.emit({ type: 'gen', path })
    bus.emit({ type: 'minutes-done', path })
  } catch (e) {
    const aborted = g.controller && g.controller.signal.aborted
    if (aborted) gen.delete(path)
    else {
      const msg = (e && e.message) || String(e)
      gen.set(path, { status: 'error', label: '', text: '', error: msg, controller: null })
      say('纪要生成失败:' + msg, { level: 'error' })
    }
    bus.emit({ type: 'gen', path })
  }
}

// ── 行动项聚合(跨会议再浮现) ────────────────────────────────────────────────

async function collectActions() {
  const idx = await healIndex()
  const out = []
  const today = todayStr()
  for (const m of idx.meetings) {
    let text = null
    try { text = ctx.app.readFile ? await ctx.app.readFile(m.path) : null } catch { text = null }
    if (text == null) continue
    const parsed = parseMeeting(text)
    for (const a of parsed.actions) {
      if (a.done) continue
      out.push({ path: m.path, meetingTitle: parsed.title || m.title || '', raw: a.raw, line: a.line, text: a.text, owner: a.owner, due: a.due, done: false, overdue: !!a.due && a.due < today })
    }
  }
  out.sort((a, b) => {
    const x = a.due || '9999-99-99', y = b.due || '9999-99-99'
    return x < y ? -1 : x > y ? 1 : 0
  })
  return out
}
async function toggleAction(path, rawLine, done, lineNo) {
  let md = null
  try { md = ctx.app.readFile ? await ctx.app.readFile(path) : null } catch { md = null }
  if (md == null) { say('读不到会议文件', { level: 'error' }); return false }
  const next = toggleActionInText(md, rawLine, done, lineNo)
  if (next == null) { say('没找到这一行行动项(文件可能已被编辑),已刷新列表', { level: 'warning' }); bus.emit({ type: 'actions' }); return false }
  try { await ctx.app.writeFile(path, next) }
  catch (e) { say('勾选没写回(保存失败):' + ((e && e.message) || e), { level: 'error' }); return false }
  try { await upsertIndex(path, parseMeeting(next)) } catch { /* 打开时自愈 */ }
  bus.emit({ type: 'actions' })
  return true
}

// ── 浮层容器 + 主题(照 bluebird:吃宿主 token,缺哪个才派生;强调色上的字禁写死白) ──

let _layer = null
function layer() {
  if (!globalThis.document || !document.body) return null
  if (_layer && _layer.isConnected) return _layer
  _layer = document.createElement('div')
  _layer.className = 'mt-layer'
  document.body.appendChild(_layer)
  return _layer
}
let _probe = null
function parseColor(css) {
  const s = (css || '').trim()
  if (!s) return null
  if (!_probe) { const c = document.createElement('canvas'); c.width = c.height = 1; _probe = c.getContext('2d', { willReadFrequently: true }) }
  if (!_probe) return null
  _probe.fillStyle = '#000000'; _probe.fillStyle = s
  const a = _probe.fillStyle
  _probe.fillStyle = '#ffffff'; _probe.fillStyle = s
  if (a === '#000000' && _probe.fillStyle === '#ffffff') return null
  _probe.clearRect(0, 0, 1, 1); _probe.fillRect(0, 0, 1, 1)
  const d = _probe.getImageData(0, 0, 1, 1).data
  return [d[0], d[1], d[2], d[3] / 255]
}
function opaqueBgOf(start) {
  for (let n = start; n; n = n.parentElement) {
    const c = parseColor(getComputedStyle(n).backgroundColor)
    if (c && c[3] > 0.95) return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`
  }
  return null
}
const relL = (c) => { const g = (v) => { const x = v / 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4) }; return .2126 * g(c[0]) + .7152 * g(c[1]) + .0722 * g(c[2]) }
const contrast = (a, b) => { const x = relL(a), y = relL(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
/** 强调色上的字色:白 / 近黑取对比度高的一方(宿主没给 --on-accent 时的兜底)。 */
const onColorOf = (accent) => (contrast(accent, [255, 255, 255]) >= contrast(accent, [22, 22, 26]) ? '#ffffff' : '#16161a')
/** 强调色当前景用时,与底色对比不足就朝文字色掺,掺到 3:1 为止。 */
function readableOn(fg, bg, text, min = 3) {
  let c = [fg[0], fg[1], fg[2]]
  for (let i = 0; i < 12 && contrast(c, bg) < min; i++) c = c.map((v, k) => v + (text[k] - v) * .18)
  return `rgb(${c.map((v) => Math.round(v)).join(',')})`
}
function syncTheme(rootEl) {
  const cs = getComputedStyle(rootEl)
  const tok = (n) => (cs.getPropertyValue(n) || '').trim()
  const rgb = parseColor(tok('--text')) || parseColor(cs.color) || [40, 40, 40, 1]
  const dark = relL(rgb) > .5 // 前景偏亮 = 暗色主题
  const bgc = parseColor(tok('--bg')) || parseColor(opaqueBgOf(rootEl.parentElement) || '') || (dark ? [23, 24, 28] : [255, 255, 255])
  const rd = Math.round
  const f = (a) => `rgba(${rd(rgb[0])},${rd(rgb[1])},${rd(rgb[2])},${a})`
  const accent = tok('--accent') || tok('--am-accent') || (dark ? '#cfc9ff' : '#4C2585')
  const arc = parseColor(accent) || [76, 37, 133, 1]
  const af = (a) => `rgba(${rd(arc[0])},${rd(arc[1])},${rd(arc[2])},${a})`
  const danger = tok('--danger') || (dark ? '#e08a7d' : '#b03a2e')
  const drc = parseColor(danger) || [176, 58, 46, 1]
  const targets = [rootEl, layer()].filter(Boolean)
  const set = (k, v) => targets.forEach((t) => t.style.setProperty(`--mt-${k}`, v))
  targets.forEach((t) => { t.style.colorScheme = dark ? 'dark' : 'light' })
  set('text', tok('--text') || `rgb(${rd(rgb[0])},${rd(rgb[1])},${rd(rgb[2])})`)
  set('text-sec', tok('--text-light') || f(.72)); set('text-muted', tok('--text-muted') || f(.5)); set('text-subtle', tok('--text-faint') || f(.32))
  set('bg', tok('--bg') || `rgb(${rd(bgc[0])},${rd(bgc[1])},${rd(bgc[2])})`)
  set('elev', tok('--bg-card') || tok('--bg') || `rgb(${rd(bgc[0])},${rd(bgc[1])},${rd(bgc[2])})`) // 浮层必须不透明
  set('surf', tok('--bg-card') || f(.045)); set('surf-sub', tok('--overlay-subtle') || f(.025))
  set('header', tok('--overlay-subtle') || f(.02)); set('input', tok('--overlay-light') || f(.05))
  set('hover', tok('--overlay-medium') || f(.08)); set('border', tok('--border') || f(.16)); set('border-sub', tok('--overlay-medium') || f(.09))
  set('fill', accent); set('on-fill', tok('--on-accent') || onColorOf(arc))
  set('primary', readableOn(arc, bgc, rgb)); set('glow', af(.22)); set('tint', tok('--accent-light') || af(.13))
  set('danger', danger); set('danger-tint', `rgba(${rd(drc[0])},${rd(drc[1])},${rd(drc[2])},.12)`)
  set('shadow', tok('--card-shadow') || (dark ? '0 4px 20px rgba(0,0,0,.4)' : '0 2px 12px rgba(0,0,0,.08)'))
}
function themeObserver(rootEl) {
  syncTheme(rootEl)
  const ob = new MutationObserver(() => syncTheme(rootEl))
  for (let n = rootEl.parentElement; n; n = n.parentElement) ob.observe(n, { attributes: true, attributeFilter: ['class', 'data-mode', 'data-theme', 'style'] })
  const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)')
  const onMq = () => syncTheme(rootEl)
  if (mq && mq.addEventListener) mq.addEventListener('change', onMq)
  return () => { ob.disconnect(); if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq) }
}

const STYLE = `
.mt-root{height:100%;min-height:0;display:flex;flex-direction:column;color:inherit;background:var(--mt-bg);font-size:13px;line-height:1.5}
.mt-root *{box-sizing:border-box}
.mt-root ::-webkit-scrollbar{width:6px;height:6px}.mt-root ::-webkit-scrollbar-thumb{background:var(--mt-border);border-radius:3px}
.mt-app{display:flex;flex-direction:column;height:100%;min-height:0}
.mt-hdr{flex:0 0 auto;display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--mt-border-sub);background:var(--mt-header)}
.mt-hdr .hd-main{flex:1;min-width:0}
.mt-hdr .hd-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.mt-hdr .hd-sub{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-body{flex:1;min-height:0;overflow:auto;padding:14px}
.mt-hero{max-width:640px;margin:0 auto}
.mt-hero h1{font-size:24px;font-weight:700;margin:10px 0 6px;color:var(--mt-primary);text-align:center}
.mt-hero p{color:var(--mt-text-muted);margin:0 0 14px;text-align:center}
.mt-panel{border-radius:14px;background:var(--mt-surf);border:1px solid var(--mt-border);box-shadow:var(--mt-shadow)}
.mt-form{padding:14px}
.mt-banner{border:1px solid var(--mt-danger);color:var(--mt-danger);background:var(--mt-danger-tint);border-radius:12px;padding:10px 12px;margin-bottom:10px;font-size:12px;text-align:left}
.mt-input{width:100%;padding:9px 12px;font:inherit;color:var(--mt-text);background:var(--mt-input);border:1.5px solid var(--mt-border);border-radius:12px;outline:none;transition:border-color .2s,box-shadow .2s}
.mt-input::placeholder{color:var(--mt-text-subtle)}
.mt-input:focus{border-color:var(--mt-primary);box-shadow:0 0 0 3px var(--mt-glow)}
.mt-btn{padding:7px 12px;font:inherit;color:var(--mt-text-sec);border:1px solid var(--mt-border);border-radius:12px;background:var(--mt-surf);cursor:pointer;transition:background .2s,border-color .2s,color .2s;white-space:nowrap}
.mt-btn:hover:not(:disabled){background:var(--mt-tint);border-color:var(--mt-primary);color:var(--mt-primary)}
.mt-btn:active:not(:disabled){transform:scale(.98)}
.mt-btn:disabled{opacity:.5;cursor:default}
.mt-btn.primary{color:var(--mt-on-fill);background:var(--mt-fill);border-color:transparent;font-weight:500}
.mt-btn.primary:hover:not(:disabled){color:var(--mt-on-fill);border-color:transparent;background:var(--mt-fill);filter:brightness(1.06)}
.mt-btn.ghost{background:transparent;color:var(--mt-text-sec);border-color:transparent}
.mt-btn.ghost:hover:not(:disabled){background:var(--mt-hover);color:var(--mt-text);border-color:transparent}
.mt-btn.sm{padding:5px 10px;font-size:12px;border-radius:9px}
.mt-btn.stop{color:var(--mt-danger);border-color:var(--mt-danger);background:transparent;font-weight:500}
.mt-btn.stop:hover:not(:disabled){background:var(--mt-danger-tint);color:var(--mt-danger);border-color:var(--mt-danger)}
.mt-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mt-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mt-text-muted)}
.mt-muted{color:var(--mt-text-muted)}
.mt-err{color:var(--mt-danger)}
.mt-empty{padding:22px 10px;text-align:center;color:var(--mt-text-subtle);font-size:12px}
.mt-tabs{display:flex;gap:4px;padding:4px;border-radius:12px;background:var(--mt-surf-sub);margin:14px 0 10px}
.mt-tab{flex:1;padding:7px;text-align:center;border-radius:9px;cursor:pointer;font-size:12.5px;color:var(--mt-text-sec)}
.mt-tab.on{background:var(--mt-tint);color:var(--mt-primary);font-weight:500}
.mt-list-wrap{max-width:640px;margin:4px auto 0}
.mt-card{border-radius:14px;background:var(--mt-surf);border:1px solid var(--mt-border-sub);cursor:pointer;padding:10px 12px;margin-top:8px;transition:border-color .2s,background .2s}
.mt-card:hover{border-color:var(--mt-primary);background:var(--mt-tint)}
.mt-card .ttl{flex:1;min-width:0;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-card .sub{font-size:11px;color:var(--mt-text-subtle);margin-top:3px}
.mt-badge{display:inline-block;font-size:10px;font-weight:600;padding:1px 8px;border-radius:9999px;white-space:nowrap;flex:0 0 auto}
.mt-badge.rec{color:var(--mt-danger);border:1px solid var(--mt-danger)}
.mt-badge.todo{background:var(--mt-tint);color:var(--mt-primary)}
.mt-badge.ok{background:var(--mt-hover);color:var(--mt-text-muted)}
.mt-badge.open{background:var(--mt-tint);color:var(--mt-primary)}
.mt-dot{width:10px;height:10px;border-radius:50%;background:var(--mt-danger);display:inline-block;flex:0 0 auto;animation:mtpulse 1.6s ease-in-out infinite}
@keyframes mtpulse{0%,100%{opacity:1}50%{opacity:.35}}
.mt-recwrap{display:flex;flex-direction:column;gap:12px}
.mt-rec-top{display:flex;flex-direction:column;align-items:center;gap:8px}
.mt-timerbox{display:flex;align-items:center;gap:10px}
.mt-timer{font-size:40px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--mt-text)}
.mt-wave{max-width:100%;height:56px;color:var(--mt-primary)}
.mt-cols{display:flex;gap:12px;flex:1;min-height:0;align-items:stretch}
.mt-col{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;min-height:0}
@media(max-width:760px){.mt-cols{flex-direction:column}}
.mt-livebox{flex:1;min-height:180px;max-height:46vh;overflow:auto;padding:10px 12px}
.mt-seg{display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--mt-border-sub);align-items:flex-start}
.mt-seg:last-child{border-bottom:none}
.mt-seg .tx{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.mt-ts{flex:0 0 auto;padding:0 5px;border-radius:6px;background:var(--mt-tint);color:var(--mt-primary);font-size:.85em;font-variant-numeric:tabular-nums}
.mt-bulletbox{flex:1;min-height:180px;max-height:46vh;display:flex;flex-direction:column;padding:10px 12px;gap:8px}
.mt-bullets{flex:1;overflow:auto;display:flex;flex-direction:column;gap:4px;min-height:60px}
.mt-bullet{padding:5px 8px;border-radius:8px;background:var(--mt-surf-sub);font-size:12.5px;white-space:pre-wrap;word-break:break-word}
.mt-bullet-in{resize:none}
.mt-live-card{padding:14px;display:flex;align-items:center;gap:10px}
.mt-live-card .ttl{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}
.mt-pane{padding:14px;min-height:200px}
.mt-out{line-height:1.65}
.mt-out h1,.mt-out h2,.mt-out h3,.mt-out h4{margin:.9em 0 .4em;line-height:1.3}
.mt-out h1{font-size:1.4em}.mt-out h2{font-size:1.2em}.mt-out h3{font-size:1.05em}
.mt-out pre{background:var(--mt-surf-sub);padding:10px 12px;border-radius:10px;overflow:auto}
.mt-out code{background:var(--mt-surf-sub);padding:1px 5px;border-radius:5px;font-family:ui-monospace,Menlo,monospace}
.mt-out pre code{background:transparent;padding:0}
.mt-out blockquote{margin:.6em 0;padding:2px 12px;border-left:3px solid var(--mt-primary);color:var(--mt-text-sec)}
.mt-out a{color:var(--mt-primary)}
.mt-act{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:10px;border:1px solid var(--mt-border-sub);margin-top:6px;background:var(--mt-surf)}
.mt-act .mid{flex:1;min-width:0}
.mt-act .tx{font-size:12.5px;white-space:pre-wrap;word-break:break-word}
.mt-act.done .tx{text-decoration:line-through;color:var(--mt-text-muted)}
.mt-act .meta{display:flex;gap:6px;margin-top:4px;flex-wrap:wrap}
.mt-check{width:15px;height:15px;margin-top:2px;accent-color:var(--mt-fill);cursor:pointer;flex:0 0 auto}
.mt-chip{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--mt-hover);color:var(--mt-text-sec)}
.mt-chip.overdue{background:var(--mt-danger-tint);color:var(--mt-danger);font-weight:600}
.mt-chip.src{cursor:pointer;background:var(--mt-tint);color:var(--mt-primary)}
.mt-prog{font-size:11.5px;color:var(--mt-text-muted);padding:8px 10px;border-radius:10px;background:var(--mt-surf-sub);margin-bottom:10px}
.mt-prog.err{color:var(--mt-danger);background:var(--mt-danger-tint)}
.mt-layer{position:fixed;inset:0;z-index:9999;pointer-events:none;color:var(--mt-text);font-size:13px;line-height:1.5}
.mt-modal{position:absolute;inset:0;pointer-events:auto;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}
.mt-menu{pointer-events:auto;min-width:300px;max-width:380px;padding:16px;border-radius:14px;background:var(--mt-elev);border:1px solid var(--mt-border);box-shadow:var(--mt-shadow)}
.mt-confirm .ttl{font-weight:600;margin-bottom:6px}
.mt-confirm .desc{font-size:12px;color:var(--mt-text-sec)}
`

/** 极简确认框(Electron 无 window.confirm 可依赖性;浮层挂 .mt-layer 拿主题变量)。 */
function confirmBox(title, desc, okLabel) {
  return new Promise((resolve) => {
    const host = layer()
    if (!host) { resolve(true); return }
    const ov = document.createElement('div'); ov.className = 'mt-modal'
    const box = document.createElement('div'); box.className = 'mt-menu mt-confirm'
    const h = document.createElement('div'); h.className = 'ttl'; h.textContent = title
    const p = document.createElement('div'); p.className = 'desc'; p.textContent = desc || ''
    const row = document.createElement('div'); row.className = 'mt-row'; row.style.justifyContent = 'flex-end'; row.style.marginTop = '12px'
    const no = document.createElement('button'); no.className = 'mt-btn ghost sm'; no.textContent = '取消'
    const ok = document.createElement('button'); ok.className = 'mt-btn primary sm'; ok.textContent = okLabel || '确定'
    const done = (v) => { ov.remove(); resolve(v) }
    no.addEventListener('click', () => done(false))
    ok.addEventListener('click', () => done(true))
    ov.addEventListener('click', (e) => { if (e.target === ov) done(false) })
    row.appendChild(no); row.appendChild(ok)
    box.appendChild(h); box.appendChild(p); box.appendChild(row)
    ov.appendChild(box)
    host.appendChild(ov)
  })
}
/** 实时波形:AnalyserNode 频谱 → 居中条形;颜色吃 canvas 的 CSS color(随主题)。 */
function drawWave(canvas, analyser) {
  if (!canvas || !canvas.getContext || !globalThis.requestAnimationFrame) return () => {}
  const g = canvas.getContext('2d')
  if (!g) return () => {}
  const buf = new Uint8Array(analyser.frequencyBinCount)
  let raf = 0, dead = false
  const loop = () => {
    if (dead) return
    let color = 'rgb(128,128,160)'
    try { color = getComputedStyle(canvas).color || color } catch { /* ignore */ }
    try { analyser.getByteFrequencyData(buf) } catch { /* ignore */ }
    const W = canvas.width, H = canvas.height
    g.clearRect(0, 0, W, H)
    g.fillStyle = color
    const n = buf.length, bw = Math.max(2, Math.floor(W / n) - 2)
    for (let i = 0; i < n; i++) {
      const v = buf[i] / 255
      const bh = Math.max(2, v * (H - 4))
      g.fillRect(i * (bw + 2), (H - bh) / 2, bw, bh)
    }
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
  return () => { dead = true; if (globalThis.cancelAnimationFrame) cancelAnimationFrame(raf) }
}
function downloadText(name, text) {
  try {
    const b = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(b)
    a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 20000)
  } catch (e) { say('导出失败:' + ((e && e.message) || e), { level: 'error' }) }
}

// ══ 单视图状态机:idle(表单+列表+行动项总览)/ rec(录音中)/ done(纪要三 tab) ══

function mountRecorder(el) {
  el.innerHTML = ''
  const style = document.createElement('style'); style.textContent = STYLE; el.appendChild(style)
  const rootEl = document.createElement('div'); rootEl.className = 'mt-root'; el.appendChild(rootEl)
  const offTheme = themeObserver(rootEl)
  const $ = (s) => rootEl.querySelector(s)
  let mode = 'idle'          // idle | rec | done
  let idleTab = 'meetings'   // meetings | actions
  let donePath = '', doneTab = 'minutes', doneMeeting = null, doneText = ''
  let waveStop = null
  ensureWorkFolder()

  // ── idle:新会议表单 + 历史列表 / 行动项总览 ──
  function renderIdle() {
    mode = 'idle'
    if (waveStop) { waveStop(); waveStop = null }
    rootEl.innerHTML = `
<div class="mt-app">
  <div class="mt-body">
    <div class="mt-hero">
      <h1>会议记录员</h1>
      <p>会中录音 + 随手记要点,分段实时转写;会后 AI 融合出结构化纪要与行动项。</p>
      <div class="mt-banner" data-banner style="display:none"></div>
      <div class="mt-panel mt-form" data-form>
        <input class="mt-input" data-title placeholder="会议标题(留空 = 即时会议)" />
        <input class="mt-input" data-attendees style="margin-top:8px" placeholder="与会人,逗号分隔(可选,如:张三, 李四)" />
        <div class="mt-row" style="justify-content:space-between;margin-top:10px">
          <span class="mt-muted" style="font-size:11px" data-seghint></span>
          <button class="mt-btn primary" data-start>开始录音</button>
        </div>
        <div class="mt-muted" style="font-size:11px;margin-top:8px">只采集麦克风;音频分段转写后即弃、不保存原始录音;关闭应用会直接结束录音。</div>
      </div>
      <div class="mt-panel mt-live-card" data-livecard style="display:none">
        <span class="mt-dot"></span>
        <span class="ttl" data-lc-title></span>
        <span class="mt-muted" data-lc-timer style="font-variant-numeric:tabular-nums"></span>
        <button class="mt-btn primary sm" data-lc-open>回到录音</button>
      </div>
    </div>
    <div class="mt-list-wrap">
      <div class="mt-tabs">
        <div class="mt-tab" data-tab="meetings">会议列表</div>
        <div class="mt-tab" data-tab="actions">行动项总览</div>
      </div>
      <div data-list></div>
    </div>
  </div>
</div>`
    $('[data-seghint]').textContent = `每 ${segMinutes()} 分钟一段送转写(插件设置可调)`
    const cap = capability()
    if (!cap.ok) {
      const banner = $('[data-banner]')
      banner.style.display = ''
      banner.textContent = cap.reason
      $('[data-start]').disabled = true
    }
    if (recState.active || recState.stopping) {
      $('[data-form]').style.display = 'none'
      const card = $('[data-livecard]')
      card.style.display = ''
      $('[data-lc-title]').textContent = recState.meeting ? recState.meeting.title : ''
      $('[data-lc-open]').addEventListener('click', renderRec)
      updateIdleClock()
    }
    $('[data-start]').addEventListener('click', async () => {
      const btn = $('[data-start]')
      if (!btn || btn.disabled) return
      btn.disabled = true
      btn.textContent = '正在打开麦克风…'
      const r = await startRecording($('[data-title]') ? $('[data-title]').value : '', $('[data-attendees]') ? $('[data-attendees]').value : '')
      if (r.ok) { if (mode === 'idle') renderRec(); return }
      if (mode !== 'idle') return
      const b2 = $('[data-start]')
      if (b2) { b2.disabled = !capability().ok; b2.textContent = '开始录音' }
    })
    rootEl.querySelectorAll('.mt-tab').forEach((t) => t.addEventListener('click', () => { idleTab = t.getAttribute('data-tab'); renderIdleList() }))
    renderIdleList()
  }
  function updateIdleClock() {
    const t = $('[data-lc-timer]')
    if (!t || !recState.startedAt) return
    t.textContent = recState.active ? `● 录音中 ${fmtBullet(Math.round((Date.now() - recState.startedAt) / 1000))}` : '完成转写中…'
  }
  async function renderIdleList() {
    rootEl.querySelectorAll('.mt-tab').forEach((t) => t.classList.toggle('on', t.getAttribute('data-tab') === idleTab))
    const box = $('[data-list]')
    if (!box) return
    box.textContent = ''
    const loading = document.createElement('div'); loading.className = 'mt-empty'; loading.textContent = '加载中…'
    box.appendChild(loading)
    if (idleTab === 'meetings') {
      const idx = await healIndex()
      if (mode !== 'idle' || idleTab !== 'meetings' || !box.isConnected) return
      box.textContent = ''
      if (!idx.meetings.length) {
        const d = document.createElement('div'); d.className = 'mt-empty'
        d.textContent = '还没有会议记录。填好标题点「开始录音」,要点、完整转写与 AI 纪要都会存进你的笔记库。'
        box.appendChild(d)
        return
      }
      for (const m of idx.meetings) box.appendChild(meetingRow(m))
    } else {
      const acts = await collectActions()
      if (mode !== 'idle' || idleTab !== 'actions' || !box.isConnected) return
      box.textContent = ''
      if (!acts.length) {
        const d = document.createElement('div'); d.className = 'mt-empty'
        d.textContent = '没有未完成的行动项。生成纪要后,各场会议的 - [ ] 待办会聚合到这里,按截止日排序、过期红标。'
        box.appendChild(d)
        return
      }
      for (const a of acts) box.appendChild(actionRow(a, true))
    }
  }
  function meetingRow(m) {
    const card = document.createElement('div'); card.className = 'mt-card'
    const top = document.createElement('div'); top.className = 'mt-row'; top.style.flexWrap = 'nowrap'
    const ttl = document.createElement('div'); ttl.className = 'ttl'; ttl.textContent = m.title || '(未命名会议)'
    const badge = document.createElement('span')
    badge.className = 'mt-badge ' + (m.status === 'recording' ? 'rec' : m.status === 'transcribed' ? 'todo' : 'ok')
    badge.textContent = m.status === 'recording' ? '● 录音中' : m.status === 'transcribed' ? '待纪要' : '已完成'
    top.appendChild(ttl); top.appendChild(badge)
    if (m.openActions > 0) { const b = document.createElement('span'); b.className = 'mt-badge open'; b.textContent = `${m.openActions} 项待办`; top.appendChild(b) }
    const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = fmtDate(m.date)
    card.appendChild(top); card.appendChild(sub)
    card.addEventListener('click', () => {
      if (m.status === 'recording' && (recState.active || recState.stopping) && recState.path === m.path) { renderRec(); return }
      renderDone(m.path)
    })
    return card
  }
  function actionRow(a, showSource) {
    const row = document.createElement('div'); row.className = 'mt-act' + (a.done ? ' done' : '')
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'mt-check'; cb.checked = !!a.done
    cb.addEventListener('change', async () => {
      cb.disabled = true
      let ok = false
      try { ok = await toggleAction(a.path, a.raw, cb.checked, a.line) }
      catch (e) { say('勾选失败:' + ((e && e.message) || e), { level: 'error' }) }
      if (!ok) { cb.checked = !cb.checked; cb.disabled = false } // 失败:弹回原状态可重试(成功路径由总线重绘)
    })
    const mid = document.createElement('div'); mid.className = 'mid'
    const tx = document.createElement('div'); tx.className = 'tx'; tx.textContent = a.text
    mid.appendChild(tx)
    const meta = document.createElement('div'); meta.className = 'meta'
    if (a.owner) { const o = document.createElement('span'); o.className = 'mt-chip'; o.textContent = '@' + a.owner; meta.appendChild(o) }
    if (a.due) { const d = document.createElement('span'); d.className = 'mt-chip' + (a.overdue ? ' overdue' : ''); d.textContent = '📅 ' + a.due + (a.overdue ? ' 已过期' : ''); meta.appendChild(d) }
    if (showSource && a.meetingTitle) {
      const s = document.createElement('span'); s.className = 'mt-chip src'; s.textContent = a.meetingTitle; s.title = '打开这场会议'
      s.addEventListener('click', () => renderDone(a.path))
      meta.appendChild(s)
    }
    if (meta.children.length) mid.appendChild(meta)
    row.appendChild(cb); row.appendChild(mid)
    return row
  }

  // ── rec:大计时器 + 波形 + 分段进度 + 实时转写 + 要点速记 ──
  function renderRec() {
    mode = 'rec'
    if (waveStop) { waveStop(); waveStop = null }
    rootEl.innerHTML = `
<div class="mt-app">
  <div class="mt-hdr">
    <button class="mt-btn ghost sm" data-back>← 返回</button>
    <div class="hd-title" style="flex:1" data-rtitle></div>
    <button class="mt-btn stop" data-stop>结束录音</button>
  </div>
  <div class="mt-body mt-recwrap">
    <div class="mt-rec-top">
      <div class="mt-timerbox"><span class="mt-dot"></span><span class="mt-timer" data-timer>00:00</span></div>
      <canvas class="mt-wave" data-wave width="560" height="56"></canvas>
      <div class="mt-muted" data-segs style="font-variant-numeric:tabular-nums"></div>
      <div class="mt-err" data-recerr style="display:none;font-size:11px"></div>
    </div>
    <div class="mt-cols">
      <div class="mt-col">
        <div class="mt-label">实时转写</div>
        <div class="mt-panel mt-livebox" data-live><div class="mt-empty" data-liveempty></div></div>
      </div>
      <div class="mt-col">
        <div class="mt-label">要点速记</div>
        <div class="mt-panel mt-bulletbox">
          <div class="mt-bullets" data-bullets></div>
          <textarea class="mt-input mt-bullet-in" data-bin rows="2" placeholder="记要点,Enter 落一条(自动带相对时间戳)…"></textarea>
        </div>
      </div>
    </div>
    <div class="mt-muted" style="font-size:11px;text-align:center">关掉这个视图录音也不断(状态栏可见);关闭应用 = 结束录音。</div>
  </div>
</div>`
    $('[data-rtitle]').textContent = recState.meeting ? recState.meeting.title : ''
    $('[data-liveempty]').textContent = `第一段转写完成后出现在这里(每 ${segMinutes()} 分钟一段)…`
    $('[data-back]').addEventListener('click', renderIdle)
    $('[data-stop]').addEventListener('click', async () => {
      const ok = await confirmBox('结束录音?', '结束后会完成剩余分段的转写,然后可一键生成纪要。', '结束录音')
      if (!ok) return
      const b = $('[data-stop]')
      if (b) b.disabled = true
      finishRecording()
    })
    const bin = $('[data-bin]')
    bin.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return
      e.preventDefault()
      const v = bin.value
      bin.value = ''
      // 没记上(录音刚好收尾完)绝不静默吞:文字放回输入框并提示
      addBullet(v).then((ok) => { if (!ok && String(v).trim()) { bin.value = v; say('这条要点没记上:录音已结束(可复制到笔记里)', { level: 'warning' }) } })
    })
    const cv = $('[data-wave]')
    if (recState.analyser) waveStop = drawWave(cv, recState.analyser)
    else cv.style.display = 'none'
    updateRecClock()
    updateRecLive()
  }
  function recSegLabel() {
    const parts = [`第 ${recState.segIndex} 段`, `已转写 ${recState.doneSegs} 段`]
    if (recState.pending) parts.push(`${recState.pending} 段转写中`)
    if (recState.failedSegs) parts.push(`${recState.failedSegs} 段失败`)
    if (recState.stopping) parts.push('正在收尾…')
    return parts.join(' · ')
  }
  function updateRecClock() {
    const t = $('[data-timer]')
    if (!t) return
    const sec = recState.startedAt ? Math.max(0, Math.round((Date.now() - recState.startedAt) / 1000)) : 0
    t.textContent = fmtBullet(sec)
    const segs = $('[data-segs]')
    if (segs) segs.textContent = recSegLabel()
  }
  function updateRecLive() {
    updateRecClock()
    const live = $('[data-live]')
    if (live && recState.meeting && recState.meeting.transcript.length) {
      const nearBottom = live.scrollHeight - live.scrollTop - live.clientHeight < 60
      renderTranscript(live, recState.meeting.transcript)
      if (nearBottom) live.scrollTop = live.scrollHeight
    }
    const bl = $('[data-bullets]')
    if (bl && recState.meeting) {
      bl.textContent = ''
      for (const b of recState.meeting.bullets) { const d = document.createElement('div'); d.className = 'mt-bullet'; d.textContent = b; bl.appendChild(d) }
      bl.scrollTop = bl.scrollHeight
    }
    if (recState.stopping) { const s = $('[data-stop]'); if (s) s.disabled = true }
    const er = $('[data-recerr]')
    if (er && recState.error) { er.style.display = ''; er.textContent = recState.error }
  }

  // ── done:纪要 / 转写 / 行动项 三 tab ──
  async function renderDone(path) {
    mode = 'done'
    donePath = path
    if (waveStop) { waveStop(); waveStop = null }
    let text = null
    try { text = ctx.app.readFile ? await ctx.app.readFile(path) : null } catch { text = null }
    if (mode !== 'done' || donePath !== path) return
    if (text == null) { say('读不到会议文件(可能已被移动或删除)', { level: 'error' }); renderIdle(); return }
    doneText = text
    const m = parseMeeting(text)
    doneMeeting = m
    rootEl.innerHTML = `
<div class="mt-app">
  <div class="mt-hdr">
    <button class="mt-btn ghost sm" data-back>← 返回</button>
    <div class="hd-main">
      <div class="hd-title" data-dtitle></div>
      <div class="mt-muted hd-sub" data-dsub></div>
    </div>
    <button class="mt-btn ghost sm" data-copy>复制</button>
    <button class="mt-btn ghost sm" data-export>导出 MD</button>
    <button class="mt-btn sm" data-opennote>在笔记中打开</button>
  </div>
  <div class="mt-body">
    <div class="mt-tabs" style="margin-top:0">
      <div class="mt-tab" data-dtab="minutes">纪要</div>
      <div class="mt-tab" data-dtab="transcript">转写</div>
      <div class="mt-tab" data-dtab="actions">行动项</div>
    </div>
    <div class="mt-panel mt-pane">
      <div data-pane-minutes>
        <div class="mt-row" style="justify-content:space-between;margin-bottom:10px">
          <span class="mt-label">会议纪要</span>
          <button data-gen>生成纪要</button>
        </div>
        <div class="mt-prog" data-genprog style="display:none"></div>
        <div class="mt-out" data-minutes></div>
        <div data-prebullets></div>
      </div>
      <div data-pane-transcript style="display:none"></div>
      <div data-pane-actions style="display:none"></div>
    </div>
  </div>
</div>`
    $('[data-dtitle]').textContent = m.title || '(未命名会议)'
    const statusLabel = m.status === 'recording' ? '录音未正常收尾' : m.status === 'transcribed' ? '待纪要' : '已完成'
    $('[data-dsub]').textContent = [fmtDate(m.dateIso), m.attendees, statusLabel].filter(Boolean).join(' · ')
    $('[data-back]').addEventListener('click', renderIdle)
    $('[data-copy]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(doneText); say('已复制整篇会议 Markdown', { level: 'success' }) }
      catch { say('复制失败', { level: 'error' }) }
    })
    $('[data-export]').addEventListener('click', () => downloadText(path.split('/').pop() || '会议.md', doneText))
    $('[data-opennote]').addEventListener('click', () => {
      if (ctx.app.openFile) ctx.app.openFile(path)
      else say('当前宿主不支持直接打开笔记', { level: 'warning' })
    })
    // 生成按钮:未生成 = 高亮 primary;已生成 = 普通「重新生成」
    const genBtn = $('[data-gen]')
    genBtn.className = m.minutes ? 'mt-btn sm' : 'mt-btn primary sm'
    genBtn.textContent = m.minutes ? '重新生成' : '生成纪要'
    genBtn.addEventListener('click', () => generateMinutes(donePath))
    // 纪要 pane
    const outEl = $('[data-minutes]')
    if (m.minutes) renderMarkdown(outEl, m.minutes)
    else {
      const d = document.createElement('div'); d.className = 'mt-empty'
      d.textContent = m.transcript.length || m.bullets.length
        ? '转写已就绪。点「生成纪要」,AI 会把你的要点与完整转写融合成结构化纪要 + 行动项(只取会上说过的,不发明决议)。'
        : '这场会议没有要点与转写内容。'
      outEl.appendChild(d)
      if (m.bullets.length) {
        const pb = $('[data-prebullets]')
        const lab = document.createElement('div'); lab.className = 'mt-label'; lab.textContent = '要点速记'; lab.style.margin = '10px 0 4px'
        pb.appendChild(lab)
        for (const b of m.bullets) { const bd = document.createElement('div'); bd.className = 'mt-bullet'; bd.style.marginTop = '4px'; bd.textContent = b; pb.appendChild(bd) }
      }
    }
    // 转写 pane
    const trEl = $('[data-pane-transcript]')
    if (m.transcript.length) renderTranscript(trEl, m.transcript)
    else { const d = document.createElement('div'); d.className = 'mt-empty'; d.textContent = '没有转写内容。'; trEl.appendChild(d) }
    // 行动项 pane
    const acEl = $('[data-pane-actions]')
    if (m.actions.length) {
      const today = todayStr()
      for (const a of m.actions) acEl.appendChild(actionRow({ path, meetingTitle: '', raw: a.raw, line: a.line, text: a.text, owner: a.owner, due: a.due, done: a.done, overdue: !a.done && !!a.due && a.due < today }, false))
    } else { const d = document.createElement('div'); d.className = 'mt-empty'; d.textContent = '还没有行动项。生成纪要时会按「- [ ] 内容 @负责人 📅日期」自动提取。'; acEl.appendChild(d) }
    // tab 切换
    const setTab = (name) => {
      doneTab = name
      rootEl.querySelectorAll('[data-dtab]').forEach((t) => t.classList.toggle('on', t.getAttribute('data-dtab') === name))
      $('[data-pane-minutes]').style.display = name === 'minutes' ? '' : 'none'
      $('[data-pane-transcript]').style.display = name === 'transcript' ? '' : 'none'
      $('[data-pane-actions]').style.display = name === 'actions' ? '' : 'none'
    }
    rootEl.querySelectorAll('[data-dtab]').forEach((t) => t.addEventListener('click', () => setTab(t.getAttribute('data-dtab'))))
    setTab(doneTab === 'transcript' || doneTab === 'actions' ? doneTab : 'minutes')
    updateGenUI()
  }
  function updateGenUI() {
    const g = gen.get(donePath)
    const prog = $('[data-genprog]'), btn = $('[data-gen]'), out = $('[data-minutes]')
    if (!btn) return
    if (g && g.status === 'running') {
      btn.disabled = true
      btn.textContent = '生成中…'
      if (prog) { prog.style.display = ''; prog.classList.remove('err'); prog.textContent = (g.label || '生成中') + (g.text ? ` · 已产出 ${g.text.length} 字` : '') }
      if (out && g.text) {
        const parsed = parseMinutesBlock(g.text)
        out.textContent = parsed && parsed.minutes ? parsed.minutes : g.text.slice(-800) // 直播原文;完成后整页重绘走 renderMarkdown
      }
    } else if (g && g.status === 'error') {
      btn.disabled = false
      btn.textContent = doneMeeting && doneMeeting.minutes ? '重新生成' : '生成纪要'
      if (prog) { prog.style.display = ''; prog.classList.add('err'); prog.textContent = '生成失败:' + g.error }
    } else if (prog) prog.style.display = 'none'
  }

  // ── 总线消费 ──
  const offBus = bus.on((e) => {
    if (e.type === 'tick') {
      if (mode === 'rec') updateRecClock()
      else if (mode === 'idle') updateIdleClock()
      return
    }
    if (e.type === 'rec-start') {
      // 一次性「开录了」:只有它才把非录音页切进录音页(用户按了开录/命令)。
      if (mode !== 'rec') renderRec()
      return
    }
    if (e.type === 'rec') {
      // 周期性数据事件(每段送转写/转写回来/记要点都发):只刷数据,绝不把 idle 拽回录音页——
      // 否则整场录音期间历史列表/行动项总览/live card 全不可用(每 5 分钟被强制传送两次)。
      if (mode === 'rec') updateRecLive()
      else if (mode === 'idle') updateIdleClock()
      return
    }
    if (e.type === 'rec-done') {
      if (mode === 'rec') renderDone(e.path)
      else if (mode === 'idle') renderIdle()
      return
    }
    if (e.type === 'gen') { if (mode === 'done' && e.path === donePath) updateGenUI(); return }
    if (e.type === 'minutes-done') {
      if (mode === 'done' && e.path === donePath) renderDone(donePath)
      else if (mode === 'idle') renderIdleList()
      return
    }
    if (e.type === 'actions') {
      if (mode === 'idle') renderIdleList()
      else if (mode === 'done') renderDone(donePath)
    }
  })

  if (recState.active || recState.stopping) renderRec()
  else renderIdle()

  return () => { offTheme(); offBus(); if (waveStop) waveStop() } // 录音/生成在模块级:关视图不断
}

// ── 注册(07-18 后的 ctx 面一律判存在:旧宿主缺席时优雅降级,setup 不抛) ──────────

if (ctx.registerView) ctx.registerView({ id: 'recorder', title: '会议记录员', mount: mountRecorder, singleton: true })
ctx.registerCommand({
  id: 'meeting-open', title: '会议记录员:打开', keywords: 'meeting 会议 纪要 录音 转写 行动项 minutes recorder',
  run: () => { if (ctx.openView) ctx.openView('recorder'); else say('当前宿主版本过旧,不支持工作台视图', { level: 'warning' }) },
})
ctx.registerCommand({
  id: 'meeting-start', title: '会议记录员:立即开始录音', keywords: 'meeting 会议 录音 record start 开始',
  run: async () => {
    if (ctx.openView) ctx.openView('recorder')
    if (recState.active || recState.stopping) { say('已经在录音中', { level: 'info' }); return }
    await startRecording('', '')
  },
})
const sb = ctx.registerStatusItem ? ctx.registerStatusItem({ id: 'status', side: 'right', text: '🎙 会议', title: '会议记录员', onClick: () => { if (ctx.openView) ctx.openView('recorder') } }) : null

if (globalThis.__MEETING_TEST__) {
  Object.assign(globalThis.__MEETING_TEST__, {
    pad2, fmtTs, fmtBullet, localDate, todayStr, fmtDate, slugify, clampSeg, safeHref,
    parseActionLine, serializeAction, parseTranscriptLine, parseMeeting, serializeMeeting,
    setFmValue, replaceSection, toggleActionInText, parseMinutesBlock, applyMinutesToText, sectionLines, mergeActionLines,
    mergeSegments, insertTranscript, buildMinutesPrompt, inline, renderMarkdown, renderTranscript,
    onColorOf, readableOn, contrast, wavBase64,
    capability, hooks, recState, startRecording, finishRecording, addBullet, bus,
    gen, generateMinutes, toggleAction, collectActions,
    readIndexFile, healIndex, upsertIndex, ensureWorkFolder, uniqueMeetingPath, getCfg,
  })
}

return () => {
  // 插件停用:状态栏、定时器、媒体资源、生成任务、浮层全收干净(没人代管)
  pluginDisposed = true // 半路的 startRecording(权限弹窗/查重名 await 中)看到即刹车并停掉新流
  if (sb && sb.dispose) sb.dispose()
  clearTimeout(recState.rotateTimer)
  clearTimeout(recState.tickTimer)
  if (recState.active || recState.stopping) {
    recState.active = false
    recState.stopping = true
    const r = recState.recorder
    recState.recorder = null
    if (r) { try { r.stop() } catch { /* ignore */ } } // onstop 里会转写最后一段并落盘收尾
    releaseMedia()
  }
  gen.forEach((g) => { if (g.controller) { try { g.controller.abort() } catch { /* ignore */ } } })
  if (_layer) { try { _layer.remove() } catch { /* ignore */ } }
  _layer = null
}
