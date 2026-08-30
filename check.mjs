/**
 * 会议记录员插件自检:宿主同款 new Function('ctx', src) 求值 main.js + DOM 垫片 + 冻钟 + 假定时器 +
 * 内存 vault + MediaRecorder/getUserMedia 假实现(onstop 同步触发喂假 blob)。
 * 覆盖(SPEC「check.mjs 额外必测」逐条):段偏移合并 / 行动项解析与勾选回写(@与📅缺省)/
 * 状态机 recording→transcribed→done / 录音不绑视图闭包(全程零视图挂载,模块级状态断言)/
 * ```minutes 块解析 / 索引自愈(孤儿剔除 + 崩溃残留降级 + 瞬时读错不剔)/ XSS(转写与 Markdown 渲染)/
 * 旧宿主(07-18 后 API 全删)setup 不抛 + 无 transcribeAudio 降级不抛 / 数据契约往返不丢字段。
 * 修复轮加钉:开录竞态(权限弹窗窗口期拒第二路)/ 重新生成行动项合并(勾选带过+手写行保留)/
 * 静音段良性占位不计失败 / 收尾窗口期要点不丢 / CRLF 文件外科操作命中 / 勾选写回失败返回 false 不上抛。
 * 第二修复轮加钉:随包 agent slug 不撞 20260717 老 agent + 首轮产出不合约自动回退默认助手(假 fetch 断言
 * 第 2 次 POST 不带 agent_config)/ 视图层挂载('rec' 数据事件不把 idle 拽回录音页;开录切页只认 'rec-start';
 * 录音结束 idle 不被传送进 done 页)/ 轮转 stop 与手动结束撞车不丢末段(FakeMediaRecorder onstop 异步派发 +
 * inactive 再 stop 抛错,同真机契约)/ 同文重复行动项行按行号定位 / MediaRecorder 构造失败报 ok:false 且状态栏
 * 不冻死 / 首装 ensureWorkFolder × upsertIndex 竞态不抹首条会议(索引写串行闸)。
 * 双语轮加钉:MSG 两侧键集合相等(+ 占位符同名同数、英文侧零残留中文)/ mock ctx 的 getLocale 返回 'en'
 * 且宿主广播语言变化时,**同一个已挂载视图不重挂**也必须重渲成英文,disposer 退订 subscribeLocale。
 * 第三修复轮加钉:重渲是整树 innerHTML 重建 —— 未提交的输入(idle 标题/与会人、rec 要点草稿)与滚动位
 * 必须快照回填,且回填的同时 placeholder 已换语言(否则「干脆不重渲」也能骗过前一条)/ 录音页与纪要页的
 * 英文(纪要页喂一份内容全英文的会议:节名被 parseMeeting 剥掉,页面再出现中文即判 render 硬编码)/
 * fmtDate 跟 zh-CN·en-US 走 / 列表分隔符按语言取,英文侧禁中文标点与 (s) 括号复数。
 * blobToWav16kBase64 在此 stub(node 给不起 AudioContext)——真实音频管线为真机验收项。
 * 跑法:node check.mjs
 */
process.env.TZ = 'Asia/Shanghai'
import { readFileSync, readdirSync } from 'node:fs'
import { strict as A } from 'node:assert'

const src = readFileSync(new URL('./main.js', import.meta.url), 'utf8')

// ── 源码纪律 lint ──
A.ok(!/setInterval/.test(src), '禁 setInterval(轮询一律 setTimeout 自排程)')
A.ok(!/new Date\(\)/.test(src), '禁裸 new Date()(「现在」一律 Date.now(),冻钟才冻得住)')
A.ok(!/color:\s*#fff/i.test(src), 'CSS 禁写死白字(强调色上的字一律 var(--mt-on-fill))')
for (const m of src.matchAll(/\.innerHTML\s*=\s*`([\s\S]*?)`/g)) {
  A.ok(!m[1].includes('${'), 'innerHTML 模板必须是纯静态字面量(动态文本一律 textContent)')
}
A.ok(!/\.innerHTML\s*\+=/.test(src), '禁 innerHTML +=')
// ASI 陷阱:无分号风格下,以 ( 或 [ 开头的行会粘到上一句尾部当调用/下标
const srcLines = src.split('\n')
const asi = [...srcLines.keys()].filter((i) => {
  if (!/^\s*[([]/.test(srcLines[i])) return false
  let p = i - 1
  while (p >= 0 && !srcLines[p].trim()) p--
  return p >= 0 && /[)\]'"`\w]\s*$/.test(srcLines[p])
}).map((i) => i + 1)
A.equal(asi.length, 0, `以 ( [ 开头的行会被 ASI 粘到上一句:第 ${asi.join(',')} 行`)
// P1 钉①:随包 agent slug 不许与 20260717 内容包的同名异契约老 agent(meeting-scribe)撞车。
// 引擎播种「文件夹名 = slug,已存在则保留」:撞上老实体,本插件的 ```minutes 契约永远拿不到。
const slugM = /const AGENT_SLUG = '([^']+)'/.exec(src)
A.ok(slugM, 'main.js 应声明 AGENT_SLUG')
const AGENT_SLUG = slugM[1]
A.notEqual(AGENT_SLUG, 'meeting-scribe', 'slug 不许叫 meeting-scribe(与 20260717 老 agent 撞车)')
const agentDirs = readdirSync(new URL('./agents/', import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
A.deepEqual(agentDirs, [AGENT_SLUG], 'agents/ 下唯一子目录名必须 = AGENT_SLUG(文件夹名即 slug)')

// ── DOM 垫片(照 bluebird check;本轮升级到「能挂载真实视图」:innerHTML 迷你解析器 + 选择器 + 事件派发,
//    钉视图层缺陷需要——check 只喂静态受控模板,解析器只支持双引号属性/void input) ──
function mkText(t) {
  const n = { tag: '#text', children: [], attrs: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, remove() {} }
  let v = String(t)
  Object.defineProperty(n, 'textContent', { get: () => v, set: (x) => { v = String(x) } })
  return n
}
const selMatch = (n, sel) => {
  if (!n || !n.tag || n.tag[0] === '#') return false
  if (sel[0] === '.') return String(n.className || '').split(/\s+/).includes(sel.slice(1))
  const am = /^\[([\w-]+)\]$/.exec(sel)
  if (am) return !!n.attrs && am[1] in n.attrs
  return n.tag === sel
}
function findFirstSel(rootN, sel) {
  let hit = null
  const walk = (x) => { for (const c of x.children || []) { if (hit) return; if (selMatch(c, sel)) { hit = c; return } walk(c) } }
  walk(rootN)
  return hit
}
function findAllSel(rootN, sel) {
  const out = []
  const walk = (x) => { for (const c of x.children || []) { if (selMatch(c, sel)) out.push(c); walk(c) } }
  walk(rootN)
  return out
}
const VOID_TAGS = new Set(['input', 'br', 'hr', 'img'])
function parseHTMLInto(parent, html) {
  const stack = [parent]
  const re = /<\/?[a-zA-Z][^>]*>|[^<]+/g
  let m
  while ((m = re.exec(html))) {
    const tok = m[0]
    if (tok[0] !== '<') { if (tok.trim()) stack[stack.length - 1].appendChild(mkText(tok)); continue }
    if (tok[1] === '/') { if (stack.length > 1) stack.pop(); continue }
    const selfClose = /\/>$/.test(tok)
    const tagM = /^<([a-zA-Z][\w-]*)/.exec(tok)
    const el = mkEl(tagM[1].toLowerCase())
    const attrStr = tok.slice(tagM[0].length, tok.length - (selfClose ? 2 : 1))
    const attrRe = /([\w-]+)(?:="([^"]*)")?/g
    let am
    while ((am = attrRe.exec(attrStr))) {
      const k = am[1], v = am[2] == null ? '' : am[2]
      if (k === 'class') el.className = v
      if (k === 'style') { for (const part of v.split(';')) { const ci = part.indexOf(':'); if (ci > 0) el.style[part.slice(0, ci).trim()] = part.slice(ci + 1).trim() } }
      el.attrs[k] = v
    }
    stack[stack.length - 1].appendChild(el)
    if (!selfClose && !VOID_TAGS.has(el.tag)) stack.push(el)
  }
}
function mkEl(tag) {
  const n = { tag, children: [], attrs: {}, className: '', isConnected: true, remove() {}, getContext: () => null }
  n.style = { setProperty() {} }
  n._ls = {}
  let own = ''
  n.appendChild = (c) => { if (c && c.tag === '#frag') { for (const k of c.children) n.children.push(k) } else n.children.push(c); return c }
  n.setAttribute = (k, val) => { n.attrs[k] = val }
  n.getAttribute = (k) => (k in n.attrs ? n.attrs[k] : null)
  n.addEventListener = (t, fn) => { (n._ls[t] = n._ls[t] || []).push(fn) }
  n.querySelector = (sel) => findFirstSel(n, sel)
  n.querySelectorAll = (sel) => findAllSel(n, sel)
  n.classList = {
    _set: () => new Set(String(n.className || '').split(/\s+/).filter(Boolean)),
    add: (c) => { const s = n.classList._set(); s.add(c); n.className = [...s].join(' ') },
    remove: (c) => { const s = n.classList._set(); s.delete(c); n.className = [...s].join(' ') },
    contains: (c) => n.classList._set().has(c),
    toggle: (c, on) => { const s = n.classList._set(); const want = on === undefined ? !s.has(c) : !!on; if (want) s.add(c); else s.delete(c); n.className = [...s].join(' ') },
  }
  Object.defineProperty(n, 'textContent', { get: () => own + n.children.map((c) => c.textContent || '').join(''), set: (x) => { n.children.length = 0; own = String(x) } })
  Object.defineProperty(n, 'innerHTML', { get: () => '', set: (html) => { n.children.length = 0; own = ''; parseHTMLInto(n, String(html)) } })
  return n
}
globalThis.document = { createElement: mkEl, createTextNode: mkText, createDocumentFragment: () => mkEl('#frag'), addEventListener() {} } // 故意不给 document.body:layer() 返回 null,confirmBox 自动放行
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', color: '', backgroundColor: '' })
const fire = (n, type, ev) => { for (const f of (n && n._ls && n._ls[type]) || []) f(ev || { target: n }) }
const findAll = (node, tag) => { const out = []; const walk = (n) => { for (const c of n.children || []) { if (c.tag === tag) out.push(c); walk(c) } }; walk(node); return out }
const anyAttr = (node, key) => { let hit = false; const walk = (n) => { if (n.attrs && key in n.attrs) hit = true; for (const c of n.children || []) walk(c) }; walk(node); return hit }

// ── 冻钟 + 假定时器(按 ms 甄别:轮转 300000 / 秒表 1000 互不串) ──
const T0 = Date.parse('2026-08-06T10:00:00+08:00')
let NOW = T0
Date.now = () => NOW
const timers = []
let timerSeq = 1
globalThis.setTimeout = (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms: ms || 0 }); return id }
globalThis.clearTimeout = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) }
const fireTimer = (pred) => { const i = timers.findIndex(pred); A.ok(i >= 0, '找不到匹配的定时器'); const t = timers.splice(i, 1)[0]; t.fn() }
const settle = (n = 8) => new Promise((resolve) => { let k = 0; const step = () => (++k > n ? resolve() : setImmediate(step)); setImmediate(step) })

// ── localStorage / 媒体 / 语音桥 假实现 ──
const _ls = new Map()
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) }
class FakeTrack { constructor() { this.stopped = false } stop() { this.stopped = true } }
const tracks = []
// node 22 的 navigator 是只有 getter 的全局:必须 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => { const t = new FakeTrack(); tracks.push(t); return { getTracks: () => [t] } } } }, configurable: true })
class FakeMediaRecorder {
  constructor(stream) { this.stream = stream; this.mimeType = 'audio/webm'; this.state = 'inactive'; FakeMediaRecorder.instances.push(this) }
  start() { this.state = 'recording' }
  stop() {
    // 照真机契约:inactive 上再 stop 抛 InvalidStateError;ondataavailable/onstop 异步派发(编码 flush 期)。
    // 同步派发会把「轮转 stop 与手动结束撞车丢末段」这类竞态整个遮住。
    if (this.state === 'inactive') throw new Error('InvalidStateError: The MediaRecorder is inactive')
    this.state = 'inactive'
    setImmediate(() => { if (this.ondataavailable) this.ondataavailable({ data: { size: 4, fake: true } }); if (this.onstop) this.onstop() })
  }
}
FakeMediaRecorder.instances = []
globalThis.MediaRecorder = FakeMediaRecorder
const asrQueue = [] // 每次 transcribeAudio 消费一项;{reject:'…'} = 让该段失败
globalThis.window = {
  tangu: {
    transcribeAudio: async (req) => {
      A.equal(req.mime, 'audio/wav', '转写请求应是 wav')
      A.equal(req.timestamps, true, '转写请求应要时间戳')
      const r = asrQueue.shift()
      if (!r) throw new Error('mock ASR 队列为空')
      if (r.reject) throw new Error(r.reject)
      return r
    },
  },
}

// ── 求值 main.js(宿主同款) ──
globalThis.__MEETING_TEST__ = {}
const reg = { views: [], commands: [], settings: [], status: [], listSources: [] }
const V = new Map()
const writes = []
const notes = []
const navOpened = []; const navLoaded = [] // ctx.app.openFile / loadPage 的调用账本
const sbUpdates = [] // 状态栏 update 轨迹(钉「构造失败不许冻死 ● 录音中」)
const ctx = {
  registerView: (v) => reg.views.push(v),
  registerCommand: (c) => reg.commands.push(c),
  registerSetting: (s) => reg.settings.push(s),
  registerStatusItem: (s) => { reg.status.push(s); return { update: (u) => sbUpdates.push(u), dispose() {} } },
  registerListSource: (x) => reg.listSources.push(x), // 统一左栏数据源(宿主 2026-08-25+)
  notify: (m, o) => notes.push({ m, o }),
  activity: { log() {} },
  openView() {},
  app: {
    notify: (m) => notes.push({ m }),
    readFile: async (p) => (V.has(p) ? V.get(p) : null),
    writeFile: async (p, t) => { V.set(p, t); writes.push(p) },
    openFile: (p) => navOpened.push(p),
    loadPage: (p) => navLoaded.push(p), // 裸 .md 的正确开法(readflow 1.1.2 的生态级 P0-A)
    workFolder: () => '会议记录员',
  },
}
const dispose = new Function('ctx', src)(ctx)
const T = globalThis.__MEETING_TEST__

// ── ① 贡献点契约 ──
A.equal(typeof dispose, 'function', 'setup 应返回 disposer')
A.ok(reg.views.find((v) => v.id === 'recorder' && typeof v.mount === 'function'), '应注册 recorder 视图')
A.ok(reg.commands.find((c) => c.id === 'meeting-open'), '应注册 meeting-open 命令')
A.ok(reg.commands.find((c) => c.id === 'meeting-start'), '应注册 meeting-start 命令')
A.deepEqual(reg.settings.map((s) => s.key), ['segmentMinutes'], '应声明 segmentMinutes 设置')
A.equal(reg.settings[0].default, 5)
A.ok(reg.status.find((s) => s.id === 'status'), '应注册状态栏项')

// ── ② 纯函数已知向量 ──
A.equal(T.fmtTs(12), '[00:00:12]')
A.equal(T.fmtTs(303), '[00:05:03]')
A.equal(T.fmtTs(3723), '[01:02:03]')
A.equal(T.fmtBullet(603), '10:03', '要点相对时间戳:603s → 10:03')
A.equal(T.fmtBullet(5), '00:05')
A.equal(T.fmtBullet(3723), '1:02:03')
A.equal(T.clampSeg('5'), 5)
A.equal(T.clampSeg('1'), 2, '分段时长下夹 2')
A.equal(T.clampSeg('99'), 15, '分段时长上夹 15')
A.equal(T.clampSeg('abc'), 5, '非法值回默认 5')
A.equal(T.slugify('周会/临时: 讨论'), '周会临时-讨论')
A.equal(T.slugify(''), '会议')
A.equal(T.safeHref('javascript:alert(1)'), '', 'javascript: 应被拒')
A.equal(T.safeHref('https://x.com'), 'https://x.com')
// wavBase64:RIFF 头 + 16k 单声道
const wavHead = Buffer.from(T.wavBase64(new Float32Array([0, 0.5, -0.5]), 16000), 'base64')
A.equal(wavHead.subarray(0, 4).toString('ascii'), 'RIFF')
A.equal(wavHead.readUInt32LE(24), 16000, 'WAV 采样率 16k')

// 行动项行解析/序列化(@ 与 📅 都可缺省)
const a1 = T.parseActionLine('- [ ] 跟进供应商报价 @张三 📅2026-08-10')
A.deepEqual(a1, { done: false, text: '跟进供应商报价', owner: '张三', due: '2026-08-10' })
A.deepEqual(T.parseActionLine('- [x] 发会议纪要'), { done: true, text: '发会议纪要', owner: '', due: '' })
A.deepEqual(T.parseActionLine('- [ ] 只有负责人 @李四'), { done: false, text: '只有负责人', owner: '李四', due: '' })
A.deepEqual(T.parseActionLine('- [ ] 只有日期 📅2026-09-01'), { done: false, text: '只有日期', owner: '', due: '2026-09-01' })
A.equal(T.parseActionLine('- 普通列表行'), null)
A.equal(T.parseActionLine('随便一行'), null)
A.equal(T.serializeAction(a1), '- [ ] 跟进供应商报价 @张三 📅2026-08-10', '解析↔序列化往返')
A.equal(T.serializeAction({ done: true, text: '无主任务', owner: '', due: '' }), '- [x] 无主任务')

// 段偏移合并:第 2 段 segments 时间戳 +300s(5 分钟)
A.deepEqual(T.mergeSegments({ text: 'x', segments: [{ start: 3.4, end: 6, text: ' 第二段开头 ' }] }, 300), [{ t: 303, text: '第二段开头' }])
A.deepEqual(T.mergeSegments({ text: ' 无分段整段文本 ' }, 300), [{ t: 300, text: '无分段整段文本' }], '无 segments 整段落在段起点')
A.deepEqual(T.mergeSegments('纯字符串结果', 60), [{ t: 60, text: '纯字符串结果' }])
A.deepEqual(T.mergeSegments({ text: '', segments: [] }, 0), [], '空结果 → 空数组(调用方落占位行)')

// ```minutes 块解析
const agentOut = '好的,给你纪要。\n```minutes\n## 纪要\n### 预算\n- 预算砍 20%,Q3 生效\n\n## 行动项\n- [ ] 跟进供应商报价 @张三 📅2026-08-10\n- [ ] 更新预算表\n```\n以上。'
const pm = T.parseMinutesBlock(agentOut)
A.ok(pm, '应解析出 minutes 块')
A.ok(pm.minutes.includes('预算砍 20%') && pm.minutes.includes('### 预算'), '纪要正文保留')
A.ok(!pm.minutes.includes('## 行动项'), '行动项不混进纪要正文')
A.equal(pm.actions.length, 2)
A.equal(pm.actions[0].owner, '张三')
A.equal(pm.actions[1].owner, '')
A.equal(T.parseMinutesBlock('没有代码块'), null)

// buildMinutesPrompt:英文指令 + 双源注入
const prompt = T.buildMinutesPrompt({ title: '周会', dateIso: '2026-08-06T02:00:00.000Z', attendees: '张三', bullets: ['10:03 预算砍 20%'], transcript: [{ t: 12, text: '大家好' }] })
A.ok(prompt.includes('Never invent'), '模型指令应为英文且含防编造硬规则')
A.ok(prompt.includes('```minutes'), '应点名 minutes 代码块')
A.ok(prompt.includes('- 10:03 预算砍 20%') && prompt.includes('[00:00:12] 大家好'), '要点与转写都应注入')

// ── ④ XSS:恶意字符串走渲染器后不产生元素/属性注入 ──
const box = mkEl('div')
T.renderMarkdown(box, '**hi** <img src=x onerror=alert(1)> `code`')
A.ok(box.textContent.includes('hi') && box.textContent.includes('<img') && box.textContent.includes('onerror'), '<img onerror> 应作为字面文字保留')
A.equal(findAll(box, 'img').length, 0, '绝不能创建 img 元素')
A.equal(anyAttr(box, 'onerror'), false, '绝不能设 onerror 属性')
const box2 = mkEl('div')
T.renderMarkdown(box2, '# H\n\n- a\n- b\n\n[good](https://x.com) [bad](javascript:evil)')
A.equal(findAll(box2, 'h1').length, 1)
A.equal(findAll(findAll(box2, 'ul')[0], 'li').length, 2)
const as = findAll(box2, 'a')
A.equal(as[0].attrs.href, 'https://x.com', '安全链接设 href')
A.equal(as[1].attrs.href, undefined, '危险协议不设 href')
const box3 = mkEl('div')
T.renderTranscript(box3, [{ t: 12, text: '<script>alert(1)</script><img src=x onerror=pwn()>' }])
A.equal(findAll(box3, 'script').length, 0, '转写渲染绝不能创建 script')
A.equal(findAll(box3, 'img').length, 0, '转写渲染绝不能创建 img')
A.ok(box3.textContent.includes('<script>') && box3.textContent.includes('[00:00:12]'), '恶意转写文本按字面显示且带时间戳')

// 深浅色可读性兜底(真 LCL 配色:强调色 × 兜底字色对比度必须够读)
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
for (const [name, acc] of [['cream-dark', '#f8f7f6'], ['cream-light', '#1c1c1c'], ['lovable-dark', '#ece7dd'], ['echo-dark', '#ff9a7d'], ['qbird-dark', '#5fa3b2'], ['zhi', '#1e96eb']]) {
  const on = T.onColorOf(hex(acc))
  A.ok(T.contrast(hex(acc), hex(on)) >= 4.5, `${name} 强调色上的兜底字色对比度不足(${on})`)
}
A.equal(T.onColorOf(hex('#f8f7f6')), '#16161a', '纸白强调色上必须给深字')
const rgbOf = (s) => s.match(/\d+/g).map(Number)
const blended = rgbOf(T.readableOn(hex('#2a292b'), hex('#2a292b'), hex('#f2efe8')))
A.ok(T.contrast(blended, hex('#2a292b')) >= 3, '与底色同色的强调色应被掺开到 3:1')

// ── ⑤ 数据契约往返(写→读→再写,不丢字段;含未知 frontmatter 键) ──
const m0 = {
  title: '周会', dateIso: '2026-08-06T02:00:00.000Z', status: 'transcribed', attendees: '张三, 李四',
  fmExtra: ['mt_custom: keepme'], bullets: ['10:03 预算砍 20%'],
  transcript: [{ t: 12, text: '大家好,今天……' }, { t: 303, text: '(第 2 段)……' }],
  minutes: '', actions: [{ done: false, text: '跟进供应商报价', owner: '张三', due: '2026-08-10' }],
}
const md1 = T.serializeMeeting(m0)
A.ok(md1.startsWith('---\nmt_title: 周会\nmt_date: 2026-08-06T02:00:00.000Z\nmt_status: transcribed\nmt_attendees: 张三, 李四\nmt_custom: keepme\n---'), 'frontmatter 契约形状')
A.ok(md1.includes('\n## 要点速记\n- 10:03 预算砍 20%'), '要点节契约')
A.ok(md1.includes('\n## 转写\n[00:00:12] 大家好,今天……\n[00:05:03] (第 2 段)……'), '转写节契约')
A.ok(md1.includes('\n## 行动项\n- [ ] 跟进供应商报价 @张三 📅2026-08-10'), '行动项节契约')
const p1 = T.parseMeeting(md1)
A.equal(p1.title, '周会'); A.equal(p1.dateIso, '2026-08-06T02:00:00.000Z'); A.equal(p1.status, 'transcribed'); A.equal(p1.attendees, '张三, 李四')
A.deepEqual(p1.fmExtra, ['mt_custom: keepme'], '未知 frontmatter 键不丢')
A.deepEqual(p1.bullets, ['10:03 预算砍 20%'])
A.deepEqual(p1.transcript, [{ t: 12, text: '大家好,今天……' }, { t: 303, text: '(第 2 段)……' }])
A.equal(p1.actions.length, 1); A.equal(p1.actions[0].due, '2026-08-10')
A.equal(T.serializeMeeting(p1), md1, '序列化↔解析↔再序列化字节稳定')

// ── 首开即建工作文件夹(幂等) ──
await T.ensureWorkFolder()
A.ok(V.has('会议记录员/.meeting-index.json'), '应写空索引落夹')
const w0 = writes.length
await T.ensureWorkFolder()
A.equal(writes.length, w0, '已有索引不重复写(幂等)')

// ── 录音引擎 e2e(全程零视图挂载 = 「录音中视图 unmount」的极端形:状态全在模块级) ──
T.hooks.wav = async () => 'RkFLRQ==' // blobToWav16kBase64 stub:AudioContext 垫不起,真机验收项
let mountCalls = 0
const realMount = reg.views[0].mount
reg.views[0].mount = (el2) => { mountCalls++; return realMount(el2) }
asrQueue.push({ text: '大家好,今天……', segments: [{ start: 12, end: 15, text: '大家好,今天……' }] })
asrQueue.push({ text: '第二段开头', segments: [{ start: 3, end: 6, text: '第二段开头' }] })
const r1 = await T.startRecording(' 周会 ', '张三, 李四')
A.ok(r1.ok, '开录应成功')
const path1 = r1.path
A.equal(path1, '会议记录员/2026-08-06-周会.md', '文件路径契约 <workFolder>/<YYYY-MM-DD>-<slug>.md')
A.equal(T.recState.active, true)
A.equal(T.recState.segIndex, 1)
A.ok(V.get(path1).includes('mt_status: recording'), '开录即写草稿:recording 态')
A.ok(V.get(path1).includes('mt_attendees: 张三, 李四'))
A.ok(V.get('会议记录员/.meeting-index.json').includes('2026-08-06-周会.md'), '开录即入索引')
A.equal(mountCalls, 0, '录音不依赖任何视图实例(模块级状态)')
// 5 分钟到点轮转(按 ms 甄别轮转定时器,不碰 1s 秒表)
NOW = T0 + 300000
fireTimer((t) => t.ms === 300000)
await settle()
A.equal(T.recState.segIndex, 2, '轮转后续录第 2 段')
A.equal(T.recState.doneSegs, 1, '第 1 段转写完成')
A.ok(V.get(path1).includes('[00:00:12] 大家好,今天……'), '第 1 段转写落盘(段内时间戳原样)')
// 要点速记:10:03 相对时间戳
NOW = T0 + 603000
await T.addBullet('预算砍 20%')
A.ok(V.get(path1).includes('- 10:03 预算砍 20%'), '要点带相对时间戳落盘')
// 结束:最后一段转写(偏移 +300s)→ transcribed
await T.finishRecording()
await settle()
A.equal(T.recState.active, false)
A.equal(T.recState.stopping, false)
A.equal(T.recState.finalized, true)
A.equal(T.recState.doneSegs, 2)
A.equal(T.recState.pending, 0)
A.ok(tracks.every((t) => t.stopped), '结束后麦克风轨全部 stop')
const fin1 = V.get(path1)
A.ok(fin1.includes('[00:05:03] 第二段开头'), '第 2 段时间戳 = 段偏移 300s + 段内 3s')
A.ok(fin1.indexOf('[00:00:12]') < fin1.indexOf('[00:05:03]'), '转写按时间序')
A.ok(fin1.includes('mt_status: transcribed'), '状态机 recording→transcribed')
A.ok(JSON.parse(V.get('会议记录员/.meeting-index.json')).meetings.find((x) => x.path === path1).status === 'transcribed', '索引同步 transcribed')
A.ok(notes.some((n) => String(n.m).includes('转写完成')), '完成通知')

// ── 第二场(recState 重置回归)+ 段转写失败占位 ──
asrQueue.push({ reject: 'ASR 挂了' })
NOW = T0 + 3600000
const r2 = await T.startRecording('周会', '')
A.ok(r2.ok, '第二场应能开(recState 全量重置)')
A.equal(r2.path, '会议记录员/2026-08-06-周会-2.md', '同日同名标题自动加序号')
A.equal(T.recState.doneSegs, 0, '计数器不残留上一场')
await T.finishRecording()
await settle()
A.equal(T.recState.failedSegs, 1)
A.ok(V.get(r2.path).includes('转写失败'), '失败段留占位行,不吞录音')
A.ok(V.get(r2.path).includes('ASR 挂了'), '占位行带真实原因')
A.ok(V.get(r2.path).includes('mt_status: transcribed'), '有失败段照样收尾 transcribed')
A.ok(notes.some((n) => String(n.m).includes('1 段失败')), '收尾通知提示失败段数')

// ── 纪要落盘:外科式替换,防 TOCTOU(生成期间用户补写的内容不许被抹) ──
const fresh = V.get(path1) + '\n## 我的补充\n- 手写的一行\n'
const applied = T.applyMinutesToText(fresh, pm)
A.ok(applied.includes('mt_status: done'), '状态机 transcribed→done')
A.ok(applied.includes('## 纪要\n### 预算\n- 预算砍 20%,Q3 生效'), '纪要节写入')
A.ok(applied.includes('- [ ] 跟进供应商报价 @张三 📅2026-08-10'), '行动项节写入(契约行格式)')
A.ok(applied.includes('- [ ] 更新预算表'), '无主行动项照写')
A.ok(applied.includes('## 我的补充') && applied.includes('- 手写的一行'), '用户手写节原样保留')
A.ok(applied.includes('- 10:03 预算砍 20%') && applied.includes('[00:00:12]'), '要点/转写原样保留')
A.equal(T.applyMinutesToText(applied, pm), applied, '外科替换幂等')
V.set(path1, applied)
A.equal(T.parseMeeting(applied).status, 'done')

// ── 重新生成:行动项节做合并不做覆盖(勾选状态带过 + 手写行保留 = README「手写内容安全」承诺) ──
const regenOld = ['---', 'mt_title: 复盘会', 'mt_date: 2026-08-06T05:00:00.000Z', 'mt_status: done', 'mt_attendees: ', '---', '',
  '## 纪要', '- 旧纪要一行', '', '## 行动项', '- [x] 跟进供应商报价 @张三 📅2026-08-10', '- [ ] 手写的待办 @自己 📅2026-08-20', ''].join('\n')
const regen1 = T.applyMinutesToText(regenOld, pm)
A.ok(regen1.includes('- [x] 跟进供应商报价 @张三 📅2026-08-10'), '重新生成:已勾选状态不弹回 [ ]')
A.ok(regen1.includes('- [ ] 手写的待办 @自己 📅2026-08-20'), '重新生成:模型没给的手写行动项行原字节保留')
A.ok(regen1.includes('- [ ] 更新预算表'), '重新生成:模型新行动项照写')
A.ok(!regen1.includes('旧纪要一行'), '纪要节整节替换为新产出')
A.equal(T.applyMinutesToText(regen1, pm), regen1, '重新生成合并幂等(不重复缀行)')
A.equal(T.mergeActionLines([], pm.actions), '- [ ] 跟进供应商报价 @张三 📅2026-08-10\n- [ ] 更新预算表', '空旧节 = 纯新产出')

// generateMinutes 边界:无引擎 → error 态;空会 → 拒绝并提示
await T.generateMinutes(path1)
const g1 = T.gen.get(path1)
A.ok(g1 && g1.status === 'error' && g1.error.includes('引擎'), 'node 无引擎应落 error 而非抛')
T.gen.delete(path1)
const emptyPath = '会议记录员/2026-08-06-空会.md'
V.set(emptyPath, T.serializeMeeting({ title: '空会', dateIso: '2026-08-06T03:00:00.000Z', status: 'transcribed', attendees: '', fmExtra: [], bullets: [], transcript: [], minutes: '', actions: [] }))
notes.length = 0
await T.generateMinutes(emptyPath)
A.ok(notes.some((n) => String(n.m).includes('没法生成纪要')), '空会应拒绝生成并提示')
A.ok(!T.gen.get(emptyPath), '空会不进 gen 队列')

// ── 勾选回写:只翻该行复选框,其余字节不动;索引 openActions 同步 ──
const raw1 = '- [ ] 跟进供应商报价 @张三 📅2026-08-10'
A.equal(T.toggleActionInText('- [ ] a\n' + raw1, raw1, true), '- [ ] a\n- [x] 跟进供应商报价 @张三 📅2026-08-10')
A.equal(T.toggleActionInText('无此行', raw1, true), null, '找不到该行返回 null(文件被编辑过)')
const ok1 = await T.toggleAction(path1, raw1, true)
A.ok(ok1)
A.ok(V.get(path1).includes('- [x] 跟进供应商报价 @张三 📅2026-08-10'), '勾选回写原文件该行')
A.equal(JSON.parse(V.get('会议记录员/.meeting-index.json')).meetings.find((x) => x.path === path1).openActions, 1, '索引未完数刷新 2→1')

// ── CRLF 文件(外部编辑器改过行尾)下,外科文本操作照常命中 ──
const crlfDoc = ('---\nmt_title: c\nmt_date: d\nmt_status: done\nmt_attendees: \n---\n\n## 行动项\n' + raw1 + '\n').replace(/\n/g, '\r\n')
const crlfToggled = T.toggleActionInText(crlfDoc, raw1, true)
A.ok(crlfToggled && crlfToggled.includes('- [x] 跟进供应商报价 @张三 📅2026-08-10'), 'CRLF 文件勾选回写命中(不再「没找到这一行」)')
A.ok(!crlfToggled.includes('\r'), '外科重写后行尾统一 LF,不产出混合行尾')
A.ok(T.replaceSection(crlfDoc, '纪要', '新纪要').includes('## 纪要\n新纪要'), 'CRLF 文件替换节命中且输出 LF')
A.ok(T.setFmValue(crlfDoc, 'mt_status', 'recording').includes('mt_status: recording'), 'CRLF 文件 frontmatter 改写命中')

// ── 勾选写回失败:返回 false + 提示,而非未处理拒绝(视图据此弹回复选框) ──
const wfSaved = ctx.app.writeFile
ctx.app.writeFile = async () => { throw new Error('磁盘写入失败') }
notes.length = 0
const tf = await T.toggleAction(path1, '- [x] 跟进供应商报价 @张三 📅2026-08-10', false)
A.equal(tf, false, '写回抛错时 toggleAction 返回 false 不上抛')
A.ok(notes.some((n) => String(n.m).includes('保存失败')), '写回失败要提示用户')
ctx.app.writeFile = wfSaved
A.ok(V.get(path1).includes('- [x] 跟进供应商报价'), '写失败文件保持原状')

// ── 行动项总览聚合:按截止日排序、过期红标、缺省字段 ──
V.set(r2.path, T.replaceSection(V.get(r2.path), '行动项', '- [ ] 补交周报 @李四 📅2026-08-01\n- [ ] 无主任务'))
const acts = await T.collectActions()
A.equal(acts.length, 3, '聚合全部未完成项(已勾掉的不再浮现)')
A.equal(acts[0].text, '补交周报', '有截止日的排最前(最早优先)')
A.equal(acts[0].overdue, true, '08-01 早于今天(08-06)→ 过期')
A.equal(acts[0].owner, '李四')
const namesOpen = acts.map((x) => x.text)
A.ok(namesOpen.includes('更新预算表') && namesOpen.includes('无主任务'), '无截止日的排后但都在')
A.ok(acts.every((x) => x.text !== '跟进供应商报价'), '已完成项不进总览')
A.ok(acts.find((x) => x.text === '更新预算表').overdue === false)

// ── ⑥ 索引自愈:孤儿剔除 + 崩溃残留 recording 降级 ──
const idxRaw = JSON.parse(V.get('会议记录员/.meeting-index.json'))
idxRaw.meetings.push({ path: '会议记录员/2026-01-01-不存在.md', title: '孤儿', date: '', status: 'done', openActions: 0 })
const crashPath = '会议记录员/2026-08-05-断电会.md'
V.set(crashPath, T.serializeMeeting({ title: '断电会', dateIso: '2026-08-05T02:00:00.000Z', status: 'recording', attendees: '', fmExtra: [], bullets: [], transcript: [{ t: 0, text: '仅有一段' }], minutes: '', actions: [] }))
idxRaw.meetings.push({ path: crashPath, title: '断电会', date: '', status: 'recording', openActions: 0 })
V.set('会议记录员/.meeting-index.json', JSON.stringify(idxRaw))
const healed = await T.healIndex()
A.ok(!healed.meetings.find((x) => x.path.includes('不存在')), '孤儿条目剔除')
A.ok(!V.get('会议记录员/.meeting-index.json').includes('不存在'), '自愈写回盘')
A.equal(healed.meetings.find((x) => x.path === crashPath).status, 'transcribed', '崩溃残留 recording(当前无活录音)降级 transcribed')
A.ok(V.get(crashPath).includes('mt_status: transcribed'), '降级写回文件本体')

// ── 开录竞态:权限弹窗窗口期(getUserMedia 挂起数秒)第二路开录必须立即被拒,绝不抹掉第一路会话 ──
const gumSaved = globalThis.navigator.mediaDevices.getUserMedia
const gumResolvers = []
globalThis.navigator.mediaDevices.getUserMedia = () => new Promise((res) => { gumResolvers.push(res) })
NOW = T0 + 7200000
const tracksBefore = tracks.length
const startP = T.startRecording('竞态会', '')          // 第一路:卡在权限弹窗
const secondP = T.startRecording('插队会', '')          // 弹窗还开着,命令面板再触发一次
A.equal(gumResolvers.length, 1, '第二路在弹窗窗口期不该去开第二个 getUserMedia')
while (gumResolvers.length) { const res = gumResolvers.shift(); const t2 = new FakeTrack(); tracks.push(t2); res({ getTracks: () => [t2] }) }
const second = await secondP
const r3 = await startP
A.equal(second.ok, false, '弹窗窗口期第二次开录被拒')
A.equal(second.error, 'busy', '拒因 busy')
A.ok(r3.ok, '第一路照常开录')
A.equal(T.recState.path, r3.path, '会话归第一路所有,没被第二路 resetRecState 抹掉')
A.equal(T.recState.active, true)
A.equal(tracks.length, tracksBefore + 1, '整个窗口期只开了一路麦克风,无孤儿热流')
globalThis.navigator.mediaDevices.getUserMedia = gumSaved

// ── 静音段 = 良性占位不计失败;收尾窗口期(剩余段还在转写)补记的要点不许静默吞 ──
const wavSaved2 = T.hooks.wav
let wavRelease
T.hooks.wav = () => new Promise((res) => { wavRelease = res })
notes.length = 0
await T.finishRecording()
await settle() // onstop 异步派发:等末段进转写(pending 闸)
A.equal(T.recState.stopping, true, '收尾中(最后一段转写在飞)')
A.equal(T.recState.pending, 1)
const lateOk = await T.addBullet('收尾窗口补一条')
A.equal(lateOk, true, '收尾窗口期要点照收(不静默丢)')
wavRelease(null) // 整段静音:hooks.wav 电平检测返回 null(不再抛错)
await settle()
A.equal(T.recState.finalized, true, '静音段不卡收尾')
A.equal(T.recState.failedSegs, 0, '静音段不计失败')
A.equal(T.recState.doneSegs, 1, '静音段计入已处理')
const f3 = V.get(r3.path)
A.ok(f3.includes('未识别到语音'), '静音段落良性占位行')
A.ok(!f3.includes('转写失败'), '静音段绝不落「转写失败」占位')
A.ok(f3.includes('收尾窗口补一条'), '收尾期要点进了终稿')
A.ok(f3.includes('mt_status: transcribed'), '正常收尾')
A.ok(notes.some((n) => String(n.m).includes('转写完成') && n.o && n.o.level === 'success'), '收尾通知是 success 而非「N 段失败」warning')
T.hooks.wav = wavSaved2

// ── 索引自愈:readFile 抛错(云库抖动/IPC 瞬时故障)≠ 文件不存在,条目必须保留(没有目录重扫,剔了永远找不回) ──
const rfSaved = ctx.app.readFile
ctx.app.readFile = async (p) => { if (p === r3.path) throw new Error('EIO 瞬时读错'); return V.has(p) ? V.get(p) : null }
const healed2 = await T.healIndex()
A.ok(healed2.meetings.some((x) => x.path === r3.path), '瞬时读错的会议条目不被剔除')
ctx.app.readFile = rfSaved
const healed3 = await T.healIndex()
A.ok(healed3.meetings.some((x) => x.path === r3.path), '故障恢复后条目还在,照常刷新')

// ── 视图层(真实挂载):'rec' 数据事件绝不把 idle 拽回录音页——否则整场录音期间历史列表/
//    行动项总览/live card 全不可用(每 5 分钟被强制传送两次);开录切页只认一次性 'rec-start';
//    录音结束时 idle 用户不被传送进 done 页 ──
const viewEl = mkEl('host')
const unmountView = reg.views[0].mount(viewEl)
A.equal(typeof unmountView, 'function', '视图 mount 返回卸载函数')
A.ok(viewEl.querySelector('[data-start]'), '初始 idle:有「开始录音」表单')
asrQueue.push({ text: '视图会片段', segments: [] })
NOW = T0 + 10800000
const rv = await T.startRecording('视图会', '')
A.ok(rv.ok)
A.ok(viewEl.querySelector('[data-stop]'), "开录的一次性 'rec-start' 把视图切进录音页")
fire(viewEl.querySelector('[data-back]'), 'click') // 用户主动「← 返回」idle 看列表/行动项总览
A.ok(!viewEl.querySelector('[data-stop]'), '返回后已离开录音页')
A.ok(viewEl.querySelector('[data-livecard]'), 'idle 顶部有「回到录音」live card')
T.bus.emit({ type: 'rec' }); T.bus.emit({ type: 'rec' }); T.bus.emit({ type: 'rec' })
A.ok(!viewEl.querySelector('[data-stop]'), "P1 钉:idle 态连发 'rec' 数据事件不许被拽回录音页")
A.ok(viewEl.querySelector('[data-lc-timer]').textContent.includes('录音中'), 'live card 计时文案在刷')
const fpv = T.finishRecording()
await settle(); await fpv; await settle()
A.equal(T.recState.finalized, true)
A.ok(!viewEl.querySelector('[data-dtab]'), 'P1 钉:录音结束时 idle 用户不被传送进 done 页')
A.ok(viewEl.querySelector('[data-start]'), '收尾后回到 idle 表单')
A.ok(V.get(rv.path).includes('视图会片段'), '视图测试场次的转写照常落盘')
unmountView()

// ── 轮转 stop(onstop 还在异步派发中)与手动「结束录音」撞车:末段转写不许静默丢、不许提前定稿 ──
asrQueue.push({ text: '', segments: [{ start: 2, end: 4, text: '撞车末段句子' }] })
NOW = T0 + 14400000
const rc = await T.startRecording('撞车会', '')
A.ok(rc.ok)
NOW += 300000
fireTimer((t) => t.ms === 300000) // 轮转:r.stop() 已发出,onstop 还没回(编码 flush 窗口)
const fpr = T.finishRecording()   // 用户恰在此刻点「结束录音」
await settle(); await fpr; await settle()
A.equal(T.recState.finalized, true, '撞车后照常收尾')
A.ok(V.get(rc.path).includes('撞车末段句子'), 'P2 钉:flush 窗口撞车,末段转写必须落进终稿(不许提前定稿把它挡在门外)')
A.ok(V.get(rc.path).includes('mt_status: transcribed'))
A.equal(T.recState.doneSegs, 1)

// ── MediaRecorder 构造失败:开录必须报 ok:false,状态栏不许冻死「● 录音中 00:00」 ──
const MRSaved = globalThis.MediaRecorder
globalThis.MediaRecorder = class { constructor() { throw new Error('no suitable codec') } }
notes.length = 0
sbUpdates.length = 0
NOW = T0 + 18000000
const rfail = await T.startRecording('坏录音器会', '')
A.equal(rfail.ok, false, 'P2 钉:构造失败必须报 ok:false(不许留空转会话)')
A.ok(String(rfail.error).includes('录音器启动失败'), '错误信息指向录音器')
A.equal(T.recState.active, false)
A.equal(T.recState.stopping, false)
A.ok(sbUpdates.length > 0 && !String(sbUpdates[sbUpdates.length - 1].text).includes('录音中'), 'P2 钉:状态栏复位,不留冻死的「● 录音中」')
A.ok(notes.some((n) => String(n.m).includes('录音器启动失败')), '用户收到真实失败提示')
A.ok(!notes.some((n) => String(n.m).includes('录音结束')), '不许弹自相矛盾的「录音结束,转写完成」')
A.ok(V.get('会议记录员/2026-08-06-坏录音器会.md').includes('mt_status: transcribed'), '空草稿降级收掉,不留「录音中」残骸')
globalThis.MediaRecorder = MRSaved

// ── 同文重复行动项行:身份 = 行号 + 内容双校验,勾第二条绝不翻第一条 ──
const dupDoc = ['---', 'mt_title: dup', 'mt_date: d', 'mt_status: done', 'mt_attendees: ', '---', '', '## 行动项', '- [ ] 更新预算表', '- [ ] 别的事 @李四', '- [ ] 更新预算表', ''].join('\n')
A.deepEqual(T.parseMeeting(dupDoc).actions.map((a) => a.line), [8, 9, 10], 'parseMeeting 给行动项记全文行号')
const dupToggled = T.toggleActionInText(dupDoc, '- [ ] 更新预算表', true, 10)
A.ok(dupToggled, '行号 + 内容都对得上 → 命中')
const dl = dupToggled.split('\n')
A.equal(dl[8], '- [ ] 更新预算表', 'P2 钉:第一条(同文案)纹丝不动')
A.equal(dl[10], '- [x] 更新预算表', 'P2 钉:翻的是用户点的那条(行号定位)')
A.equal(T.toggleActionInText(dupDoc, '- [ ] 更新预算表', true, 9), null, '行号失配且同文多行 → null(上层提示文件已被编辑并刷新)')
A.ok(T.toggleActionInText(dupDoc, '- [ ] 别的事 @李四', true, 3), '行号失配但全文唯一 → 退回唯一匹配照常翻')
A.equal(T.toggleActionInText(dupDoc, '- [ ] 更新预算表', true), null, '不带行号且同文多行 → 拒绝瞎翻第一条')
V.set('会议记录员/dup.md', dupDoc)
A.equal(await T.toggleAction('会议记录员/dup.md', '- [ ] 更新预算表', true, 10), true, 'toggleAction 带行号写回')
A.equal(V.get('会议记录员/dup.md').split('\n')[10], '- [x] 更新预算表')
A.equal(V.get('会议记录员/dup.md').split('\n')[8], '- [ ] 更新预算表')

// ── P1 钉②:带 slug 首轮有 token 但无 ```minutes 围栏(同 slug 异契约老 agent 在位)→
//    必须自动回退第 2 次不带 agent_config 的 run,而不是报死错让用户每次白烧一轮 token 且永无自愈 ──
const tanguSavedFb = globalThis.window.tangu
globalThis.window.tangu = { transcribeAudio: tanguSavedFb.transcribeAudio, getConfig: async () => ({ backendUrl: 'http://fake-engine', token: 'tk', modelId: '' }) }
const realFetch = globalThis.fetch
const postBodies = []
const sseBody = (lines) => ({ getReader: () => { let i = 0; return { read: async () => (i < lines.length ? { done: false, value: new TextEncoder().encode(lines[i++]) } : { done: true, value: undefined }) } } })
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  if (u.endsWith('/agent/runs')) {
    postBodies.push(JSON.parse(opts.body))
    return { ok: true, status: 200, json: async () => ({ runId: 'run-' + postBodies.length }), text: async () => '' }
  }
  const legit = postBodies.length >= 2 // 首轮 = 老 agent 的产出形态;回退轮 = 合约产出
  const content = legit
    ? '```minutes\n## 纪要\n### 回退\n- 回退产出的纪要\n\n## 行动项\n- [ ] 回退行动项 @张三\n```'
    : '# 会议纪要:老 agent 的模板格式\n| 事项 | 负责人 |\n(有完整 token,但绝不吐 minutes 围栏)'
  const lines = ['data: {"type":"token","payload":{"delta":"x"}}\n', `data: {"type":"done","payload":{"content":${JSON.stringify(content)}}}\n`]
  return { ok: true, status: 200, body: sseBody(lines) }
}
const fbPath = '会议记录员/2026-08-06-回退会.md'
V.set(fbPath, T.serializeMeeting({ title: '回退会', dateIso: '2026-08-06T06:00:00.000Z', status: 'transcribed', attendees: '张三', fmExtra: [], bullets: ['00:10 要点一条'], transcript: [{ t: 1, text: '张三说了一句话' }], minutes: '', actions: [] }))
notes.length = 0
await T.generateMinutes(fbPath)
A.equal(postBodies.length, 2, 'P1 钉:首轮产出不合约必须发第 2 次 POST 回退,不许一轮报死')
A.ok(postBodies[0].agent_config && postBodies[0].agent_config.agentSlug === AGENT_SLUG, '首轮带随包 agentSlug(与 agents/ 目录名一致)')
A.equal(postBodies[1].agent_config, undefined, '回退轮不带 agent_config(默认助手,指令全在 message)')
A.ok(!T.gen.get(fbPath), '成功后清 gen 态(不落 error)')
const fbOut = V.get(fbPath)
A.ok(fbOut.includes('- 回退产出的纪要'), '回退轮产出落盘')
A.ok(fbOut.includes('- [ ] 回退行动项 @张三'), '回退轮行动项落盘')
A.ok(fbOut.includes('mt_status: done'), '状态机走到 done')
A.ok(notes.some((n) => String(n.m).includes('纪要已生成')), '成功提示')
globalThis.fetch = realFetch
globalThis.window.tangu = tanguSavedFb

// ── 首装竞态:mount 的 ensureWorkFolder(读到 null 旧快照)不许把并发 upsertIndex 刚写的首条会议抹掉 ──
const idxKey = '会议记录员/.meeting-index.json'
const idxSaved = V.get(idxKey)
V.delete(idxKey)
const rfReal2 = ctx.app.readFile
let hangResolve = null, hung = false
ctx.app.readFile = (p) => {
  if (p === idxKey && !hung) { hung = true; return new Promise((res) => { hangResolve = res }) }
  return rfReal2(p)
}
const pEnsure = T.ensureWorkFolder()
const pUp = T.upsertIndex('会议记录员/first.md', { title: '首会', dateIso: '2026-08-06T09:00:00.000Z', status: 'recording', actions: [] })
await settle()
hangResolve(null) // ensureWorkFolder 的索引 read 此刻才回来,读到的是「不存在」旧快照
await pEnsure
await pUp
await settle()
A.ok(String(V.get(idxKey)).includes('first.md'), 'P2 钉:首条会议不被 ensureWorkFolder 的空索引覆盖(索引写串行闸)')
ctx.app.readFile = rfReal2
V.set(idxKey, idxSaved)

// ── ⑦ 双语词表:zh/en 两侧键集合必须完全相等(漏翻一条就红),英文侧不许有残留中文 ──
const zhKeys = Object.keys(T.MSG.zh).sort()
const enKeys = Object.keys(T.MSG.en).sort()
A.deepEqual(enKeys, zhKeys, '双语词表 MSG.zh / MSG.en 键集合必须完全相等')
A.ok(zhKeys.length >= 60, `词表条目太少(${zhKeys.length}),UI 文案八成还有硬编码没进词表`)
const CJK_RE = /[一-鿿]/
for (const k of zhKeys) {
  A.ok(String(T.MSG.zh[k]).trim(), `MSG.zh.${k} 不能是空串`)
  A.ok(String(T.MSG.en[k]).trim(), `MSG.en.${k} 不能是空串`)
  A.ok(!CJK_RE.test(String(T.MSG.en[k])), `MSG.en.${k} 里有残留中文:${T.MSG.en[k]}`)
  // 占位符两侧必须同名同数(英文语序不同,只能靠 {name} 而不是拼接)
  const vz = (String(T.MSG.zh[k]).match(/\{\w+\}/g) || []).sort().join(',')
  const ve = (String(T.MSG.en[k]).match(/\{\w+\}/g) || []).sort().join(',')
  A.equal(ve, vz, `MSG.${k} 两侧占位符不一致(zh=${vz} en=${ve})`)
}
A.equal(T.tl('en', 'segHint', { n: 5 }), 'Transcribed every 5 min (adjustable in plugin settings)', '占位符替换按 {name} 走')
A.equal(T.tl('en', '__nope__'), '__nope__', '未知 key 回吐 key 本身,不抛')

// ── ⑧ mock ctx 的 getLocale 返回 'en':视图**不重挂**也必须变英文(subscribeLocale 原地重渲) ──
globalThis.__MEETING_TEST__ = {}
let mockLocale = 'zh'
const localeSubs = new Set()
const reg3 = { views: [] }
const V3 = new Map()
const enCtx = {
  registerView: (v) => reg3.views.push(v),
  registerCommand: () => {},
  registerSetting: () => {},
  registerStatusItem: () => ({ update() {}, dispose() {} }),
  notify: () => {},
  activity: { log() {} },
  openView() {},
  getLocale: () => mockLocale,
  subscribeLocale: (cb) => { localeSubs.add(cb); return () => localeSubs.delete(cb) },
  app: {
    notify: () => {},
    readFile: async (p) => (V3.has(p) ? V3.get(p) : null),
    writeFile: async (p, txt) => { V3.set(p, txt) },
    openFile() {},
    workFolder: () => '会议记录员',
  },
}
const enDispose = new Function('ctx', src)(enCtx)
const T3 = globalThis.__MEETING_TEST__
A.equal(T3.L(), 'zh', 'getLocale 返回 zh 时词表走中文')
let mount3Calls = 0
const el3 = mkEl('host')
const un3 = ((v) => { mount3Calls++; return v.mount(el3) })(reg3.views[0])
await settle()
const zhView = el3.textContent
A.ok(zhView.includes('开始录音') && zhView.includes('行动项总览'), '中文态视图是中文文案')
mockLocale = 'en'
A.equal(T3.L(), 'en', "getLocale 返回 'en' 时词表切英文")
A.ok(localeSubs.size >= 1, '插件必须订阅 ctx.subscribeLocale(否则切语言不跟)')
for (const cb of localeSubs) cb('en')  // 宿主广播语言变化(**不重挂视图**)
await settle()
const enView = el3.textContent
A.equal(mount3Calls, 1, '语言切换靠原地重渲,不许重挂视图(会打断录音/已开视图)')
A.notEqual(enView, zhView, '切英文后界面文案必须真的变了')
A.ok(enView.includes('Start recording'), `英文态应出现英文串,实得:${enView.replace(/\s+/g, ' ').slice(0, 120)}`)
A.ok(enView.includes('All action items') && enView.includes('Meeting Recorder'), '英文态标题/标签页都翻了')
A.ok(!enView.includes('开始录音') && !enView.includes('行动项总览'), '英文态不许残留中文按钮/标签')
const cjkLeft = (enView.match(/[一-鿿]/g) || []).length
A.ok(cjkLeft / Math.max(1, enView.length) < 0.05, `英文界面残留中文过多:${cjkLeft}/${enView.length}`)
A.equal(T3.tl('en', 'sbIdle'), '🎙 Meeting', '状态栏英文文案')

// ── ⑨ 重渲是整树 innerHTML 重建:未提交的 DOM 输入 / 滚动位必须自己快照回填 ──
//    (录音、转写、生成在模块级本来就不受影响;被吞的是**没进模块级的**那半句草稿。
//     README/CHANGELOG 写了「重渲不打断」,下面 idle / rec 两组断言就是那句话的证据。)
mockLocale = 'zh'
for (const cb of localeSubs) cb('zh')
await settle()
const in1 = findFirstSel(el3, '[data-title]')
const in2 = findFirstSel(el3, '[data-attendees]')
A.ok(in1 && in2, 'idle 页应有标题/与会人输入框')
in1.value = '季度复盘会'
in2.value = '张三, 李四'
mockLocale = 'en'
for (const cb of localeSubs) cb('en')
await settle()
const in1b = findFirstSel(el3, '[data-title]')
A.notEqual(in1b, in1, '重渲确实重建了 DOM(否则下面两条断言什么也没测)')
A.equal(in1b.value, '季度复盘会', '切语言不许吞掉 idle 表单里未提交的标题')
A.equal(findFirstSel(el3, '[data-attendees]').value, '张三, 李四', '切语言不许吞掉未提交的与会人')
A.equal(in1b.getAttribute('placeholder'), T3.tl('en', 'phTitle'), '值保住的同时 placeholder 必须已切英文(不是靠「干脆不重渲」蒙混)')

// rec 页是最疼的一条:会中正打了一半的要点草稿 + 翻上去在读的转写滚动位
T3.bus.emit({ type: 'rec-start' })
await settle()
const bin1 = findFirstSel(el3, '[data-bin]')
const live1 = findFirstSel(el3, '[data-live]')
A.ok(bin1 && live1, "'rec-start' 后应在录音页(要点输入框 + 实时转写栏都在)")
// 录音页的英文:⑧ 只验到 idle,rec 页以前完全靠 MSG parity 兜底(D1 那条草稿丢失正是因此没被门禁抓到)
const recEn = el3.textContent
A.ok(recEn.includes('Stop recording') && recEn.includes('Live notes'), `录音页英文态应是英文,实得:${recEn.replace(/\s+/g, ' ').slice(0, 120)}`)
A.ok(!recEn.includes('结束录音') && !recEn.includes('要点速记'), '录音页英文态不许残留中文按钮/标签')
A.equal(bin1.getAttribute('placeholder'), T3.tl('en', 'phBullet'), '录音页 placeholder 也跟着切英文')
bin1.value = '预算这块还没记完'
live1.scrollTop = 137
mockLocale = 'zh'
for (const cb of localeSubs) cb('zh')
await settle()
const bin2 = findFirstSel(el3, '[data-bin]')
A.notEqual(bin2, bin1, 'rec 页重渲确实重建了 DOM')
A.equal(bin2.value, '预算这块还没记完', '会中切语言不许吞掉正在打的要点草稿(它不在模块级,rerender 必须自己接住)')
A.equal(findFirstSel(el3, '[data-live]').scrollTop, 137, '切语言不许把实时转写的滚动位拽走')
A.equal(bin2.getAttribute('placeholder'), T3.tl('zh', 'phBullet'), 'rec 页 placeholder 已切回中文')
A.equal(mount3Calls, 1, '连切三次后视图仍只挂载过一次')

// ── ⑩ 纪要页(done)的英文:门禁以前停在 idle(done 页要先有会议文件才进得去)。
//    这里喂一份**内容全英文**的会议 —— 四个节名是数据契约(恒中文),但 parseMeeting 会把它们剥掉,
//    渲染的只是节内容。所以页面上再冒出中文,就只可能是 renderDone 自己硬编码没进词表。
mockLocale = 'en'
for (const cb of localeSubs) cb('en')
await settle()
const donePath3 = '会议记录员/2026-08-14-quarterly-review.md' // 工作文件夹/文件名是数据契约,不随语言变
V3.set(donePath3, [
  '---', 'mt_title: Quarterly review', 'mt_date: 2026-08-14T07:30:00.000Z', 'mt_status: transcribed', 'mt_attendees: Alice, Bob', '---',
  '', '## 要点速记', '- 10:03 budget cut by 20%',
  '', '## 转写', '[00:10:03] We need to cut the budget by twenty percent.',
  '', '## 纪要', '', '## 行动项', '',
].join('\n'))
T3.bus.emit({ type: 'rec-done', path: donePath3 })
await settle()
const doneEn = el3.textContent
A.ok(doneEn.includes('Quarterly review'), `'rec-done' 应把录音页送进纪要页,实得:${doneEn.replace(/\s+/g, ' ').slice(0, 120)}`)
// 'Minutes' 大写只可能来自 tab(labMinutes 是 'Meeting minutes',小写 m),所以三个 tab 各自都钉到了
A.ok(doneEn.includes('Generate minutes') && doneEn.includes('Minutes') && doneEn.includes('Transcript') && doneEn.includes('Action items'), '纪要页英文态:生成按钮与三个 tab 都翻了')
A.ok(doneEn.includes('Needs minutes'), '纪要页的状态标签跟语言走')
const doneCjk = (doneEn.match(/[一-鿿]/g) || []).length
A.equal(doneCjk, 0, `会议内容全英文时纪要页不该有任何中文(有即 renderDone 硬编码漏进词表):${(doneEn.match(/.{0,14}[一-鿿]+.{0,14}/) || [''])[0]}`)
// 切回中文:同一页原地重渲(数据不跟着翻)
mockLocale = 'zh'
for (const cb of localeSubs) cb('zh')
await settle()
const doneZh = el3.textContent
A.ok(doneZh.includes('生成纪要') && doneZh.includes('待纪要'), '纪要页切回中文')
A.ok(doneZh.includes('Quarterly review') && doneZh.includes('Alice, Bob'), '数据(标题/与会人)是数据,不跟着界面语言翻')
A.equal(mount3Calls, 1, '纪要页切语言同样是原地重渲,不重挂')

// fmtDate 跟语言走(zh-CN / en-US),不是恒定 ISO;时分两侧一致(排序/过期判定另走 ISO,不受影响)
const isoD = '2026-08-14T15:30:00+08:00'
const dObj = new Date(Date.parse(isoD))
const hmD = `${String(dObj.getHours()).padStart(2, '0')}:${String(dObj.getMinutes()).padStart(2, '0')}`
mockLocale = 'zh'
const dZh = T3.fmtDate(isoD)
mockLocale = 'en'
const dEn = T3.fmtDate(isoD)
A.notEqual(dEn, dZh, 'fmtDate 必须跟界面语言变')
A.ok(/[A-Za-z]{3}/.test(dEn), `英文日期应含月份名,实得 ${dEn}`)
A.ok(dZh.includes('月'), `中文日期应是 zh-CN 写法,实得 ${dZh}`)
A.ok(dZh.endsWith(hmD) && dEn.endsWith(hmD), `两侧都以 HH:MM 收尾(zh=${dZh} en=${dEn})`)
A.equal(T3.fmtDate('不是日期'), '不是日期', '非法日期原样回吐,不炸')

// 分隔符按语言取:中文「、」/ 英文 ", "(⑦ 的中文残留正则是 [一-鿿],U+3001 不在区间内,只能单独钉)
A.equal(T3.tl('zh', 'capJoin'), '、', '中文侧列表分隔符是「、」')
A.equal(T3.tl('en', 'capJoin'), ', ', '英文侧列表分隔符是 ", ",不许硬拼中文顿号')
for (const k of zhKeys) A.ok(!/[、。；「」]/.test(String(T.MSG.en[k])), `MSG.en.${k} 里有中文标点:${T.MSG.en[k]}`)
// 英文侧不许出现「数字紧跟可数名词」的伪复数写法(1 segments / segment(s) 那种)
for (const k of zhKeys) A.ok(!/\(s\)/.test(String(T.MSG.en[k])), `MSG.en.${k} 用了 (s) 括号复数,换成不需要单复数一致的写法:${T.MSG.en[k]}`)

un3()
A.equal(T3.mountedViews.size, 0, '视图卸载后从重渲名册里摘掉')
A.doesNotThrow(() => enDispose(), '双语实例 disposer 不抛')
A.equal(localeSubs.size, 0, 'disposer 必须退订 subscribeLocale')

// ── 旧宿主(07-18 后 API 全删,**且没有 getLocale/subscribeLocale**)setup 不抛 + 缺 transcribeAudio 横幅降级 ──
globalThis.__MEETING_TEST__ = {}
const oldCtx = { registerCommand: () => {}, registerSetting: () => {}, app: { notify() {} } }
let oldDispose
A.doesNotThrow(() => { oldDispose = new Function('ctx', src)(oldCtx) }, '旧宿主 ctx 下 setup 不许抛')
A.equal(typeof oldDispose, 'function')
const T2 = globalThis.__MEETING_TEST__
const savedTangu = globalThis.window.tangu
globalThis.window.tangu = undefined
A.equal(T2.capability().ok, false, '无 transcribeAudio → 能力检查亮红(视图顶部横幅文案)')
A.ok(T2.capability().reason.includes('语音识别'), '横幅说明缺什么')
A.ok(T2.capability().reason.includes('设置'), '横幅说明怎么开')
const rr = await T2.startRecording('x', '')
A.equal(rr.ok, false, '缺能力时开录被拒绝而不是抛')
globalThis.window.tangu = savedTangu
A.doesNotThrow(() => oldDispose(), '旧宿主 disposer 不抛')
globalThis.__MEETING_TEST__ = T

// ── 收尾:disposer 执行不抛 ──
A.doesNotThrow(() => dispose(), 'disposer 执行不抛')

// ── 统一左栏列表源(1.2.0):注册 + 订阅即重读 + 状态分组 + open 交给 recorder + 笔记走 loadPage ──
// ⚠️「订阅即重读」是这条接缝的头号坑:插件在宿主**启动期**装载,那时活动库还没恢复,
//    ctx.app.readFile 静默给 null → 列表定格为空且此后无人再喊它(青鸟 2026-08-28 实报)。
{
  const LS = reg.listSources.find((x) => x.id === 'meeting-list')
  A.ok(LS, '应注册 meeting-list 列表源')
  A.equal(reg.views.find((v) => v.id === 'recorder').workspaceSource, 'meeting-list', 'recorder 视图应声明 workspaceSource(裸源 id)')
  const idxKey = '会议记录员/.meeting-index.json'
  const before = V.get(idxKey)
  V.set(idxKey, JSON.stringify({ meetings: [
    { path: '会议记录员/2026-08-28 周会.md', title: '订阅后才读得到', date: '2026-08-28T01:00:00.000Z', status: 'done', openActions: 3 },
    { path: '会议记录员/2026-08-27 评审.md', title: '还没出纪要', date: '2026-08-27T01:00:00.000Z', status: 'transcribed', openActions: 0 },
  ] }))
  A.ok(!LS.items({}).some((r) => r.key === '会议记录员/2026-08-28 周会.md'), '前提:此刻列表源还没读过这份新索引')
  const off = LS.subscribe(() => {})
  await new Promise((r) => setImmediate(r)) // ⚠️本文件把 setTimeout 换成了假时钟,只能用 setImmediate 让微任务跑完
  const rows = LS.items({})
  A.ok(rows.some((r) => r.key === '会议记录员/2026-08-28 周会.md'), 'subscribe() 必须触发一次重读,否则启动期读空的列表永远回不来')
  A.equal(rows.length, 2, '重读后就是索引里那两行')
  A.equal(rows[0].hint, '3', '右侧数字 = 未完成行动项数')
  A.equal(rows[1].hint, '', '零未完成不画 0')
  A.deepEqual(LS.items({ group: 'transcribed' }).map((r) => r.key), ['会议记录员/2026-08-27 评审.md'], '分组过滤按 status')
  A.deepEqual(LS.items({ query: '还没' }).map((r) => r.key), ['会议记录员/2026-08-27 评审.md'], '搜索匹配标题')
  A.deepEqual(LS.groups().map((g) => [g.key, g.count]), [['transcribed', 1], ['done', 1]], '分组=非空状态档,按 recording→transcribed→done 排')
  A.equal(LS.groups()[1].title, '已完成', '分组标签走词表(与列表页徽章同一批键)')
  // 右键「在笔记中打开」必须走 loadPage —— 裸 .md 给 openFile 会被系统默认程序抢走
  navLoaded.length = 0; navOpened.length = 0
  LS.itemMenu({ key: '会议记录员/2026-08-28 周会.md' })[0].run()
  A.deepEqual(navLoaded, ['会议记录员/2026-08-28 周会.md'], '打开笔记必须走 loadPage')
  A.equal(navOpened.length, 0, '一次都没调 openFile(裸 .md 会掉进系统默认程序)')
  const opened = []
  const realOpenView = ctx.openView
  ctx.openView = (v) => opened.push(v)
  LS.open({ key: '会议记录员/2026-08-28 周会.md' })
  ctx.openView = realOpenView
  A.deepEqual(opened, ['recorder'], 'open() 应把这场会议交给 recorder 视图')
  A.equal(typeof off, 'function', 'subscribe() 须返回退订函数')
  off()
  if (before === undefined) V.delete(idxKey); else V.set(idxKey, before)
}

console.log(`check ok — ${reg.views.length} view / ${reg.commands.length} cmds / ${reg.settings.length} setting / ${reg.status.length} statusItem`)
console.log('覆盖:段偏移合并(+300s)/ 行动项解析与勾选回写(@·📅缺省)/ 状态机 recording→transcribed→done / 模块级录音(零视图挂载)/ 双场连录重置 / 失败段占位 / ```minutes 解析与外科落盘(TOCTOU)/ 重新生成合并(勾选带过+手写行保留)/ 开录竞态(弹窗窗口期拒第二路)/ 静音段良性占位 / 收尾窗口期要点不丢 / CRLF 外科操作 / 勾选写回失败不上抛 / 行动项聚合排序·过期 / 索引自愈(孤儿+崩溃降级+瞬时读错不剔)/ XSS(Markdown+转写)/ 旧宿主降级 / 数据契约字节级往返')
console.log("第二修复轮加钉:agent slug 不撞 20260717 老实体(目录名=slug 实读)+ 首轮产出不合约自动回退默认助手(假 fetch 断言第 2 次 POST 无 agent_config)/ 视图真实挂载('rec' 不拽回录音页·'rec-start' 才切页·收尾不传送 done)/ 轮转×手动结束撞车不丢末段(onstop 异步派发+inactive stop 抛错)/ 同文重复行动项按行号定位 / MediaRecorder 构造失败 ok:false 且状态栏不冻死 / 首装索引写竞态(串行闸)")
console.log('双语轮加钉:MSG 两侧键集合相等(占位符同名同数 + 英文侧零残留中文/中文标点/(s) 括号复数)/ getLocale 返回 en 且宿主广播时同一视图不重挂即变英文 / disposer 退订 subscribeLocale')
console.log('第三修复轮加钉:切语言不吞未提交输入(idle 标题·与会人 + rec 要点草稿)与滚动位、且 placeholder 同时已换语言 / 录音页与纪要页的英文(纪要页喂全英文会议,页面出现任何中文即判硬编码)/ fmtDate 跟语言走而排序仍用 ISO / 列表分隔符按语言取')
console.log('真机验收项:blobToWav16kBase64 真实音频管线(此处 stub)、波形绘制、真 agent SSE 生成、麦克风权限弹窗;界面双语另跑 desktop 的 scripts/plugin-view.e2e.cjs(11 项含中英切换)。')
