// ============================================================================
// 🛡️ governance.js —— 框架治理层(框架文件;v6 起框架"长牙"的地方)
// ============================================================================
// 契约见 docs/EVENT-MODEL.md §4(uid 双协议)/ §6(窗口治理)。原则只有一条:
//   【响亮降级,绝不静默】—— 与 coverage 告警、cnRule 告警同一哲学。
//   熔断/裁剪/告警一律产出诊断行(notes),由中枢汇入诊断事件;绝不静默修复
//   (静默修复会让同一 uid 在两次请求间被"修"得不一样,反而制造漂移)。
//
// 硬/软分界(EVENT-MODEL §6 豁免边界:影响别人的不可豁免):
//   闹钟 uid   —— 全硬(字符集/长度≤40/前缀):下游网关拼标签的物理现实,违规=熔断该条。
//   日历 uid   —— 前缀/唯一性硬;字符集/长度【响亮告警不熔断】:iOS 实测容忍 Unicode
//                 (v5 现网 PAB '一账通' 的 uid 即含中文),硬杀会误伤存量;告警持续
//                 挂诊断催清理(card 换短哈希后已自然消音)。
//   窗口裁剪   —— 硬,但带【±45 天结构性缓冲】:裁的是"离谱越界",不是"贴边溢出"。
//                 贴边语义(宽限跨月/假期顺延/提前量)归域,是业务不是越界。

const pad2 = (n) => ('0' + n).slice(-2);

// ---------------------------------------------------------------------------
// 一、窗口(中枢统一 ?past= ?future= 的换算与裁剪)
// ---------------------------------------------------------------------------

// 视图窗口(下发给域的"意图"):月对齐 —— from = (基准月 - past) 的 1 号,
// to = (基准月 + future) 的月末。绝对日期无歧义,域按需 MAP 成自己的语义(如账单月)。
export function computeViewWindow(baseDateObj, pastMonths, futureMonths) {
  const y = baseDateObj.getFullYear(), m = baseDateObj.getMonth();
  const fromObj = new Date(y, m - pastMonths, 1);
  const toObj = new Date(y, m + futureMonths + 1, 0);           // 下月 0 号 = 本月末
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return { from: fmt(fromObj), to: fmt(toObj) };
}

// 裁剪窗口(治理"兜底"用) = 视图窗口 ± 缓冲。缓冲是常量而非配置:它不是业务参数,
// 是"贴边溢出与离谱越界"的分界线,45 天覆盖最长宽限(cycle 模型 statementDay 晚 + 21 天
// 宽限跨月)与假期顺延的一切合法溢出。要改它 = 先改本注释里的论证。
export const CLAMP_BUFFER_DAYS = 45;

export function computeClampWindow(viewWindow) {
  const shift = (isoDate, days) => {
    const [y, m, d] = isoDate.split('-').map(Number);
    const nd = new Date(Date.UTC(y, m - 1, d + days));
    return `${nd.getUTCFullYear()}-${pad2(nd.getUTCMonth() + 1)}-${pad2(nd.getUTCDate())}`;
  };
  return { from: shift(viewWindow.from, -CLAMP_BUFFER_DAYS), to: shift(viewWindow.to, CLAMP_BUFFER_DAYS) };
}

// ---------------------------------------------------------------------------
// 二、uid 工具:短哈希(构造器 —— 与下面的校验器是同一件事的正反面)
// ---------------------------------------------------------------------------

// 为什么住在框架里:①它和 checkAlarmUid 是一对(一个造、一个查),放一起才不会飘;
// ②第二个需要哈希的域(如吃外部订阅、uid 来自别人机器生成)不必再抄一份实现。
//
// 【框架发工具,不发政策】用不用哈希、哈希哪一段,是【域】按自己的身份结构决定的。
//   判据(写进 DEVGUIDE,新插件照此自选):
//     · 身份天生就短且是 ASCII → 直接用,别哈希(checkin: 'checkin-moeshare-202607' 一眼看懂)
//     · 身份长 / 含中文 / 机器生成 → 哈希(card: 五段拼出来的,已达 44 字符且中文有损压缩会撞键)
//   并且这个判断发生在【设计时】(人看一眼自己的 uid,定一次,冻住),
//   绝不在【运行时】(按长度动态决定哈不哈 = 身份取决于"这串字符碰巧多长",
//   改个显示名就跨过阈值、明文悄悄翻成哈希 —— 身份不能建在偶然属性上)。
//
// 【选了哈希 = 你欠一条冻结声明】白纸黑字写明哈希输入是哪几个字段、什么顺序,并承诺不改。
//   改一个字 = 全部 uid 变 = 网关全体重建。card 的声明见 docs/PLUGIN-CARD.md。
//
// CRC32(IEEE 多项式)。严格说它是校验码不是密码学哈希 —— 故意造碰撞很容易,
// 但本系统输入全在自己手里、无对手,无所谓。8 位十六进制 = 32 bit:
//   30 个身份的生日碰撞概率 ≈ 0.00001%;压到 4 位(16 bit)则是 0.66% —— 不给压。
//   长度也没有压的理由:'card-' + 8 + '-' + 'YYYYMM' = 20 字符,才用掉上限 40 的一半。
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function uidHash(identityString) {
  const bytes = new TextEncoder().encode(String(identityString));   // 原生吃 Unicode:
  let c = 0xFFFFFFFF;                                               // '招行' 与 '中行' 哈希不同,
  for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); // 无需有损 ASCII 压缩
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// 三、uid 校验(双协议,EVENT-MODEL §4)
// ---------------------------------------------------------------------------

const RECOMMENDED_UID_CHARSET = /^[A-Za-z0-9_.\-]+$/;
export const ALARM_UID_MAX_LENGTH = 40;         // 下游硬限(DOWNSTREAM §2),不是本框架的发明
export const CALENDAR_UID_ADVISED_MAX_LENGTH = 60;

// 日历侧:返回 { ok, hardError?, warning? } —— hardError 熔断,warning 只上诊断。
export function checkCalendarUid(uid, domainId) {
  if (!uid) return { ok: false, hardError: '缺 uid' };
  if (!uid.startsWith(domainId + '-')) return { ok: false, hardError: `前缀须为 ${domainId}-(跨域防撞)` };
  let warning = null;
  if (!RECOMMENDED_UID_CHARSET.test(uid)) warning = `字符集超出建议范围 [A-Za-z0-9_.-](含中文等;换短哈希后自然消音)`;
  else if (uid.length > CALENDAR_UID_ADVISED_MAX_LENGTH) warning = `长度 ${uid.length} 超建议值 ${CALENDAR_UID_ADVISED_MAX_LENGTH}`;
  return { ok: true, warning };
}

// 闹钟侧:全硬。违规条目绝不能流向网关(会被下游静默计入"无uid",排错要跑到下游面板)。
export function checkAlarmUid(uid, domainId) {
  if (!uid) return { ok: false, hardError: '缺 uid' };
  if (!RECOMMENDED_UID_CHARSET.test(uid)) return { ok: false, hardError: '字符集违规(硬限 [A-Za-z0-9_.-])' };
  if (uid.length > ALARM_UID_MAX_LENGTH) return { ok: false, hardError: `长度 ${uid.length} 超下游硬限 ${ALARM_UID_MAX_LENGTH}` };
  if (!uid.startsWith(domainId + '-')) return { ok: false, hardError: `前缀须为 ${domainId}-(跨域防撞)` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 四、逐域出口审计(事件通道 / 闹钟通道)
// ---------------------------------------------------------------------------

// 事件通道:uid 校验 + 全 feed 唯一性 + 窗口裁剪。seenUids 由中枢跨域共享同一个 Set。
// 返回 { accepted, notes }:notes 是可直接汇入诊断事件的中文行。
export function governDomainEvents({ domainId, events, clampWindow, seenUids }) {
  const accepted = [];
  const notes = [];
  const hardDrops = [];
  const warnings = [];
  let clampedCount = 0;

  for (const ev of (events || [])) {
    // 打 uid 必带 summary:uid 可以不可读(它的工作是配对,不是沟通),
    // 但【诊断必须可读】—— 否则哈希化的 uid 会逼你去查表才知道是哪张卡。
    // 身份保持稳定 + 你保持看得懂,这两件事本来就不冲突。
    const who = (e) => `${e.uid || '(空)'}${e.summary ? ` (${e.summary})` : ''}`;
    const uidCheck = checkCalendarUid(ev.uid, domainId);
    if (!uidCheck.ok) { hardDrops.push(`${who(ev)} — ${uidCheck.hardError}`); continue; }
    if (uidCheck.warning) warnings.push(`${who(ev)} — ${uidCheck.warning}`);
    if (seenUids.has(ev.uid)) { hardDrops.push(`${who(ev)} — 与已输出事件 uid 重复(iOS 去重行为不可预期)`); continue; }
    if (!ev.date) { hardDrops.push(`${who(ev)} — 缺 date(窗口治理与排序的抓手)`); continue; }
    if (ev.date < clampWindow.from || ev.date > clampWindow.to) { clampedCount++; continue; }
    seenUids.add(ev.uid);
    accepted.push(ev);
  }

  if (clampedCount) notes.push(`⚠️ 域 ${domainId} 越界输出 ${clampedCount} 条事件已裁剪(裁剪窗 ${clampWindow.from} .. ${clampWindow.to},含 ±${CLAMP_BUFFER_DAYS} 天缓冲)`);
  for (const line of hardDrops) notes.push(`❌ 域 ${domainId} 事件熔断: ${line}`);
  for (const line of warnings) notes.push(`⚠️ 域 ${domainId} 事件 uid 告警: ${line}`);
  return { accepted, notes };
}

// 闹钟通道:uid 全硬校验 + 跨域唯一性。未来过滤/排序仍由中枢做(现状不变,不在此重复)。
export function governDomainAlarms({ domainId, alarms, seenAlarmUids }) {
  const accepted = [];
  const notes = [];
  const who = (a) => `${a.uid || '(空)'}${a.reason ? ` (${a.reason})` : ''}`;   // reason 是闹钟的人话
  for (const alarm of (alarms || [])) {
    const uidCheck = checkAlarmUid(alarm.uid, domainId);
    if (!uidCheck.ok) { notes.push(`❌ 域 ${domainId} 闹钟熔断: ${who(alarm)} — ${uidCheck.hardError}`); continue; }
    if (seenAlarmUids.has(alarm.uid)) { notes.push(`❌ 域 ${domainId} 闹钟熔断: ${who(alarm)} — uid 跨域重复(网关会视为同一闹钟互相顶掉)`); continue; }
    seenAlarmUids.add(alarm.uid);
    accepted.push(alarm);
  }
  return { accepted, notes };
}

// ---------------------------------------------------------------------------
// 五、时间预算(per-domain 超时熔断)
// ---------------------------------------------------------------------------

// 诚实说明局限(EVENT-MODEL 风险登记簿 #5):JS 无法取消已起跑的 Promise。
// 竞速救得了【I/O 等待】(KV 慢、上游慢),救不了【CPU 死循环】—— 后者由 Workers 平台
// 自己掐(整个请求 5xx)。本预算的价值:一个域的 I/O 卡死不再拖垮整册订阅
// (iOS 订阅刷新失败是不报警的,整册 5xx = 静默失联,比单域熔断可见性差得多)。
export const DOMAIN_TIME_BUDGET_MS = 3000;   // 单域预算;全链须远快于下游 5s 拉取超时(DOWNSTREAM §2)

export async function runWithTimeBudget(promise, budgetMs, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
  });
  try {
    const raced = await Promise.race([
      promise.then((value) => ({ timedOut: false, value })),
      timeout
    ]);
    if (raced.timedOut) return { ok: false, timedOut: true, error: `${label} 超时(预算 ${budgetMs}ms)` };
    return { ok: true, value: raced.value };
  } catch (e) {
    return { ok: false, timedOut: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}
