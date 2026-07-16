// ============================================================================
// calendar-api 测试套件 (v6 · 域层)
// ============================================================================
// 分工:框架层(渲染器/治理/领地看守)在 test/render.test.mjs —— 零依赖、先跑、快速失败。
//      本文件测【域 + 中枢集成】,需要上游 workdays-core 真实数据。
//      跑全套: npm test
// 验证:
//   (a) 信用卡事件生成的结构自洽(账户/合并/VALARM/口径避让)
//   (b) 框架契约:领地/视图组合/闹钟策略/故障隔离/字段透传
//   (c) 假期口径(v5 词汇: bank|market|public;official 已废除)与三叠配方
//   (d) 上游 workdays-core 的响亮降级在本库可见(告警不静默)
//
// ── 为什么没有"与原版逐行相等"的金标准 ──────────────────────────────────────
// 信用卡逻辑自并入框架起已是【一等公民,可破坏性演进】(v5.2 移除 golden 冻结,理由见
// DEVLOG v5.2;v6 迁移期曾临时借回一套 harness 打完一仗即焚,见 DEVLOG v6.0/v6.1)。
// 正确性改由【行为/结构断言】守护 —— 校验"逻辑对不对",不是"和原版一不一样":
//   · A 组 事件结构自洽(该出的出、该合并的合并、提醒符合配置)
//   · B 组 领地/视图/【窗口总控】/诊断
//   · E~H 组 口径/避让/三叠端到端(真实归档日期钉死)
//   · I 组 插件契约   · J 组 v6 契约(事件对象/出口治理/超时熔断)
//   · K 组 账户哈希身份 / 旧别名删除 / 遗留字段清除
// 要改信用卡逻辑,直接改 src/domains/card/ 并更新相应断言即可。
process.env.TZ = 'UTC'; // Cloudflare Workers 运行时为 UTC,本地对齐

import { createHolidayHub } from '@ivanphz/workdays-core';
import hubWorker from '../src/worker-entry.js';

// ---- 喂数 stub:上游打包内置数据,零联网;测试直接调 core,无需拦截 fetch ----
// (fetch stub 仅为防止意外真实联网而保留最小兜底。)
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };
const env = {}; // 无 KV → email 相关自然为空(与原项目行为一致)
const call = (w, qs) => w.fetch(new Request('https://x/' + qs), env, {});
const D = (str) => { const [a, b, c] = str.split('-').map(Number); return new Date(a, b - 1, c, 12, 0, 0); };
// DTSTAMP 随生成时刻变化,行集合对比时归一化
const norm = (lines) => lines.map(l => l.startsWith('DTSTAMP:') ? 'DTSTAMP:X' : l);
// v6 起渲染器按 RFC 5545 折行(75 字节;v5 完全不折 —— 这是 v6 的正确性升级,不是回归)。
// 长正文(诊断报告、审计明细)会被 CRLF+空格 断开,故用 includes() 断言长文本前必须先 unfold。
// 短行(SUMMARY/DTSTART/X-WR-*)不会折,可直接断言。
const U = (s) => s.replace(/\r\n[ \t]/g, '');

// ============ A. 信用卡事件生成:结构与关键字段自洽 ============
// (v5.2 起不再与原项目冻结版逐行对比 —— 信用卡逻辑已是框架可演进的一等公民。
//  这里改为对【当前逻辑】的结构性断言:该出的账户出、该合并的合并、VALARM 符合配置。)
console.log('A. 信用卡事件生成:结构自洽(账户/合并/VALARM)');
{
  const extractEventBlocks = (text) => {
    const L = text.split('\r\n'); const blocks = []; let buf = null;
    for (const l of L) {
      if (l === 'BEGIN:VEVENT') buf = [l];
      else if (l === 'END:VEVENT') { buf.push(l); if (!buf.some(x => x.startsWith('UID:debug-log-'))) blocks.push(buf); buf = null; }
      else if (buf) buf.push(l);
    }
    return blocks;
  };
  // ⚠️ 提醒相关断言【一律从配置推导,绝不硬编码】——
  //    config/ 是【用户领地】,exactReminders/allDayReminders 用户想改就改(改成几条、提前几分钟
  //    都是他的自由),框架测试无权钉死它的值。钉了就会像 v5 那样悄悄烂掉:
  //    配置从 [{0}] 改成 [{1}],测试还断言 '-PT0M' → CI 红,而代码一点错没有。
  //    这里验的是【机制】(配置 → 提醒生效),不是【值】。
  //    值的数学由 render.test.mjs R4 组用字面量钉死(beforeStartTrigger(0)==='-PT0M')——
  //    两层不重叠:R4 管"算得对不对",这里管"接得通不通"。
  const { DEFAULT_CONFIG } = await import('../config/card.js');
  const { beforeStartTrigger, signedDurationTrigger } = await import('../src/renderer.js');

  // exact 默认:每个非诊断事件都应有 DTSTART 带时刻 + 与配置条数一致的日历提醒
  let t = await (await call(hubWorker, '?cal=card&debug=0&testDate=2026-07-01')).text();
  let blocks = extractEventBlocks(t);
  ok(blocks.length > 0, 'exact 默认: 有信用卡事件产出');
  ok(blocks.every(b => b.some(l => /^DTSTART;TZID=Asia\/Shanghai:\d{8}T\d{6}$/.test(l))), 'exact: 每事件 DTSTART 带北京时刻');
  const exactCount = DEFAULT_CONFIG.exactReminders.length;
  const expectExact = DEFAULT_CONFIG.exactReminders.map(r => `TRIGGER:${beforeStartTrigger(r.minutesBefore)}`);
  ok(blocks.every(b => b.filter(l => l === 'BEGIN:VALARM').length === exactCount),
     `exact: 每事件恰 ${exactCount} 条日历提醒(= config 的 exactReminders 条数;配 [] 则应为 0 条)`);
  ok(expectExact.every(tr => t.includes(tr)),
     `exact: 提醒 TRIGGER 与配置一致(期望 ${expectExact.join(' + ') || '(无)'})`);
  // allday 模式:DTSTART 为 VALUE=DATE,提醒用带符号偏移(同样从配置推导)
  t = await (await call(hubWorker, '?cal=card&debug=0&mode=allday&testDate=2026-07-01')).text();
  blocks = extractEventBlocks(t);
  const adCount = DEFAULT_CONFIG.allDayReminders.length;
  const expectAllDay = DEFAULT_CONFIG.allDayReminders
    .map(r => `TRIGGER:${signedDurationTrigger(r.dayOffset * 1440 + r.hour * 60 + r.minute)}`);
  ok(blocks.every(b => b.some(l => /^DTSTART;VALUE=DATE:\d{8}$/.test(l))), 'allday: DTSTART 为全天');
  ok(blocks.every(b => b.filter(l => l === 'BEGIN:VALARM').length === adCount),
     `allday: 每事件恰 ${adCount} 条日历提醒(= config 的 allDayReminders 条数)`);
  ok(expectAllDay.every(tr => t.includes(tr)),
     `allday: 提醒 TRIGGER 与配置一致(期望 ${expectAllDay.join(' + ') || '(无)'})`);
  // merge 语义:同日多账户默认合一
  t = await (await call(hubWorker, '?cal=card&debug=0&merge=1&testDate=2026-07-01')).text();
  const merged = extractEventBlocks(t).length;
  t = await (await call(hubWorker, '?cal=card&debug=0&merge=0&testDate=2026-07-01')).text();
  const unmerged = extractEventBlocks(t).length;
  ok(merged <= unmerged, `合并事件数(${merged}) ≤ 不合并(${unmerged})`);
}

// ============ B. 五点要求逐条 ============
console.log('B1. 参数独立:【域私产】参数互不泄漏 / 【中枢】参数统管全域');
// ⚠️ v6 变更:past/future 已从 card 私产【升格为中枢参数】,?months= 已废除 ——
//    故本组不能再拿它俩验"隔离"(那是统一,不是泄漏)。改用真正的域私产参数:
//      card 私产 = mode / merge / ch / cm / cardAlarm      checkin 私产 = tasks
let t = await (await call(hubWorker, '?cal=checkin&debug=0&mode=allday&merge=0&ch=8&cm=0&cardAlarm=each')).text();
let base = await (await call(hubWorker, '?cal=checkin&debug=0')).text();
ok(norm(t.split('\r\n')).join('\n') === norm(base.split('\r\n')).join('\n'), '信用卡私产参数泄漏进了签到域');
t = await (await call(hubWorker, '?cal=card&debug=0&tasks=MoeShare|2020-01-01T00:00')).text();
base = await (await call(hubWorker, '?cal=card&debug=0')).text();
ok(norm(t.split('\r\n')).join('\n') === norm(base.split('\r\n')).join('\n'), '签到私产参数泄漏进了信用卡域');

console.log('B1b. 中枢窗口:一个参数统管全域(v6 总控)');
// 窗口是【许可边界】:收窄 ?future= 两域都应跟着收 —— 这正是 v5 做不到的"总控"。
const evCount = (txt) => (txt.match(/BEGIN:VEVENT/g) || []).length;
const wide = evCount(await (await call(hubWorker, '?cal=checkin&debug=0&future=12&testDate=2026-07-15')).text());
const narrow = evCount(await (await call(hubWorker, '?cal=checkin&debug=0&future=2&testDate=2026-07-15')).text());
ok(wide === 12 && narrow === 2, `签到域(MAP 姿态)跟随中枢窗口: future=12→12期(实得${wide}) future=2→2期(实得${narrow})`);
const cardWide = evCount(await (await call(hubWorker, '?cal=card&debug=0&future=12&testDate=2026-07-15')).text());
const cardNarrow = evCount(await (await call(hubWorker, '?cal=card&debug=0&future=1&testDate=2026-07-15')).text());
ok(cardNarrow < cardWide, `信用卡域跟随中枢窗口: future=1(${cardNarrow}) < future=12(${cardWide})`);
// 【许可边界 ≠ 生产配额】签到域 MAP 忽略 past —— 给它历史许可,它也不产历史事件
const noPast = await (await call(hubWorker, '?cal=checkin&debug=0&past=0&future=12&testDate=2026-07-15')).text();
const bigPast = await (await call(hubWorker, '?cal=checkin&debug=0&past=9&future=12&testDate=2026-07-15')).text();
ok(norm(noPast.split('\r\n')).join('\n') === norm(bigPast.split('\r\n')).join('\n'),
   '签到域 MAP 姿态:past 许可放宽不产历史(算法只向前推;窗口是许可边界不是生产配额)');

console.log('B2. 信用卡闹钟:默认 off(纯日历);merged/each/off 可切');
// 你的默认 CARD_ALARM.alarmMode='off' —— 信用卡默认不进闹钟网关(只出日历)
let jDefault = JSON.parse(await (await call(hubWorker, '?cal=card&format=json&testDate=2026-07-08')).text());
ok(jDefault.v === 1 && jDefault.alarms.length === 0, `默认 off: 信用卡不进闹钟(实得 ${jDefault.alarms.length} 条)`);
// 显式 ?cardAlarm=merged 测合并行为(不依赖默认值)
let j = JSON.parse(await (await call(hubWorker, '?cal=card&format=json&cardAlarm=merged&testDate=2026-07-08')).text());
ok(j.v === 1 && j.alarms.length > 0, 'merged: json 基本结构');
const byDT = new Map();
for (const a of j.alarms) { const k = a.date + 'T' + a.time; byDT.set(k, (byDT.get(k) || 0) + 1); }
ok([...byDT.values()].every(n => n === 1), `默认 merged: 同一时刻只 1 条(实测有重复时刻)`);
ok(j.alarms.every(a => /^card-day-\d{8}$/.test(a.uid)), 'merged uid = card-day-YYYYMMDD');
const multi = j.alarms.find(a => a.reason.includes('笔还款'));
ok(!!multi, `同日多笔时 reason 汇总(样例: ${multi ? multi.reason : '无'})`);
let jEach = JSON.parse(await (await call(hubWorker, '?cal=card&format=json&cardAlarm=each&testDate=2026-07-08')).text());
ok(jEach.alarms.length > j.alarms.length, 'each 模式条数更多(每笔一条)');
ok(jEach.alarms.every(a => /^card-[A-Za-z0-9-]+-\d{6}$/.test(a.uid)), 'each uid = card-<账户>-<账单月> 纯ASCII无时钟');
let jOff = JSON.parse(await (await call(hubWorker, '?cal=card&format=json&cardAlarm=off&testDate=2026-07-08')).text());
ok(jOff.alarms.length === 0, 'off 模式 0 条');
// uid 稳定性:each 模式下改 ch/cm(响铃时刻)不改 uid
let jEach2 = JSON.parse(await (await call(hubWorker, '?cal=card&format=json&cardAlarm=each&ch=8&cm=0&testDate=2026-07-08')).text());
ok(JSON.stringify(jEach.alarms.map(a => a.uid)) === JSON.stringify(jEach2.alarms.map(a => a.uid)) &&
   jEach2.alarms[0].time === '08:00', '改响铃时刻: uid 不变,仅 time 变(平滑不抖)');

console.log('B3. 诊断事件默认开 + 写清默认逻辑');
t = U(await (await call(hubWorker, '?cal=all')).text());   // ← 诊断正文很长,v6 会折行,先 unfold
ok(t.includes('⚙️ 提醒中枢诊断报告'), '默认含诊断事件');
ok(t.includes('【💳 信用卡域】') && t.includes('【活跃账户'), '含信用卡域原版报告(账户清单)');
ok(t.includes('显示模式: exact') && t.includes('同日合并: 是'), '写明你的默认(exact/合并)');
ok(t.includes('【⏰ 签到域】') && t.includes('闹钟策略'), '含签到域报告与闹钟策略说明');
ok(t.includes('【假期数据源状态 · 上游 workdays-core】'), '含上游数据源状态段');
// v6 新增:中枢窗口与出口治理必须在诊断里可见(总控看不见 = 总控不存在)
ok(t.includes('【出口治理 · 框架】'), '含出口治理段');
ok(/窗口: 过去 3 月 \/ 未来 12 月 →/.test(t), '写明中枢窗口(缺省 past3/future12)与换算出的绝对区间');
ok(t.includes('裁剪兜底:'), '写明裁剪兜底窗(许可边界≠生产配额)');
// 手术 A 后:全域一律受治理,再无 legacy 黑箱旁路
ok(!t.includes('仍为 v5 契约'), '双契约桥已拆:诊断里不再有"未受治理"的域');
ok(t.includes('✅ 无越界/无 uid 违规'), '治理段全清(默认视图下无违规)');
// 废除参数响亮告警:旧链接不静默跑偏
const tMonths = U(await (await call(hubWorker, '?cal=checkin&months=6')).text());
ok(tMonths.includes('?months=6 已废除'), '?months= 已废除 → 诊断响亮告警,不静默按新缺省跑');

console.log('B4. 签到闹钟:默认准点一条,与日历 VALARM 脱钩');
j = JSON.parse(await (await call(hubWorker, '?cal=checkin&format=json&testDate=2026-07-08')).text());
ok(j.alarms.length === 11, `12期中7月那期已成过去被正确过滤 → 11条(实得 ${j.alarms.length})`);
ok(j.alarms.every(a => /^checkin-moeshare-\d{6}$/.test(a.uid)), '裸 uid 无后缀(单偏移)');
// 日历侧 VALARM 仍是 5/0 与 1/0(原样)
t = await (await call(hubWorker, '?cal=checkin&debug=0')).text();
ok(t.includes('TRIGGER:-PT5M') || t.includes('TRIGGER:-PT1M'), '日历 VALARM 保留 workday/holidayAlarms 原样');
// 闹钟 time 应等于【对应事件】的时刻(准点):按日期配对比对
const dts = t.split('\r\n').filter(l => l.startsWith('DTSTART;TZID=Asia/Shanghai:')).map(l => l.split(':').pop());
const a0 = j.alarms[0];
const wantYmd = a0.date.replace(/-/g, '');
const evLine = dts.find(v => v.startsWith(wantYmd));
ok(!!evLine && evLine.slice(9, 13) === a0.time.replace(':', ''), `闹钟=对应事件准点(事件${evLine} vs 闹钟${a0.date} ${a0.time})`);

console.log('B5. 账户开关:isActive 停卡真的停(含注释卡/停用卡)');
// 运行级断言:启用/停用账户状态与 config 一致
t = await (await call(hubWorker, '?cal=card&debug=0&mode=exact&merge=0')).text();
ok(t.includes('Pulse') && t.includes('Red'), '启用账户(Pulse×2/Red)在事件中');
ok(!t.includes('卓越'), '卓越 isActive:false → 正确地不出现在事件中');

console.log('C. 其它:混册/颜色/testDate');
t = await (await call(hubWorker, '?cal=all&debug=0')).text();
ok(t.includes('X-WR-CALNAME:📌 提醒合集') && t.includes('💳Repay') && t.includes('MoeShare'), '混册两域共存');
t = await (await call(hubWorker, '?cal=card&debug=0')).text();
ok(t.includes('X-APPLE-CALENDAR-COLOR:#FF3B30') && t.includes('X-WR-CALNAME:💳 信用卡还款提醒'), 'card 分册红+原册名');
t = await (await call(hubWorker, '?cal=checkin&debug=0')).text();
ok(t.includes('X-APPLE-CALENDAR-COLOR:#FF9500'), 'checkin 分册橙');
t = await (await call(hubWorker, '?cal=card&debug=0&colorCard=%2300AA00')).text();
ok(t.includes('X-APPLE-CALENDAR-COLOR:#00AA00'), 'colorCard 覆盖');
j = JSON.parse(await (await call(hubWorker, '?cal=all&format=json&testDate=2027-01-01')).text());
ok(j.alarms.every(a => a.date >= '2027-01-01'), 'testDate 未来过滤生效');

console.log('D. 领地/排除/标签/单卡豁免');
// D1 领地:src/domains/card/config.js 必须是纯垫片(不含任何配置值)
const shim = (await import('fs')).readFileSync(new URL('../src/domains/card/config.js', import.meta.url), 'utf-8');
ok(shim.includes("export * from '../../../config/card.js'") && !shim.includes('ACCOUNTS ='), '垫片只转发,配置全在用户领地 config/');
// D2 exclude 组合
let tD = await (await call(hubWorker, '?cal=all&exclude=card&debug=0')).text();
ok(tD.includes('MoeShare') && !tD.includes('💳Repay'), '?cal=all&exclude=card = 除信用卡外一切');
// D3 tags:给 MoeShare 无标签时 ?tags=A 应为空签到册
tD = await (await call(hubWorker, '?cal=checkin&tags=A&debug=0')).text();
ok(!tD.includes('MoeShare'), '?tags=A 严格选择:未打标签的任务不出现');
tD = await (await call(hubWorker, '?cal=checkin&excludeTags=A&debug=0')).text();
ok(tD.includes('MoeShare'), '?excludeTags 不影响未打标签的任务');
// D4 信用卡单卡豁免 remind:false —— 运行时给 CMB 打豁免(动态改内存配置验证路径)
const cardCfg = await import('../config/card.js');
const cmb = cardCfg.ACCOUNTS.find(a => a.bankShortName === 'CMB');
cmb.remind = false;
let jD = JSON.parse(await (await call(hubWorker, '?cal=card&format=json&cardAlarm=each&testDate=2026-07-08')).text());
ok(!jD.alarms.some(a => a.uid.includes('CMB')), 'remind:false 账户不进闹钟(each)');
let tD2 = await (await call(hubWorker, '?cal=card&debug=0&mode=exact&merge=0')).text();
ok(tD2.includes('CMB'), 'remind:false 不影响日历(CMB 事件仍在)');
delete cmb.remind;

console.log('E. CN 双口径(bank / market) —— v5 词汇,真实归档数据');
{
  // 2026-10-01 = 国庆法定假(真实公告);2026-10-10 = 调休补班周六(真实公告);2026-10-13 = 普通周二
  let hb = await createHolidayHub(['CN'], [2026]);
  let w = hb.makeWorkdayChecker(['CN']);
  ok(w(D('2026-10-10')) === true,  'bank(默认): 补班周六 = 上班(原 official 行为分毫未动)');
  ok(w(D('2026-10-01')) === false, 'bank: 法定假 = 休息');
  ok(w(D('2026-10-13')) === true,  'bank: 普通周二 = 上班');

  w = hb.makeWorkdayChecker(['CN:market']);
  ok(w(D('2026-10-10')) === false, 'market: 补班周六 = 休息(股市/清算口径)');
  ok(w(D('2026-10-01')) === false, 'market: 法定假 = 休息');
  ok(w(D('2026-10-13')) === true,  'market: 普通周二 = 上班');

  hb = await createHolidayHub(['CN'], [2026], { cnDefaultRule: 'market' });
  ok(hb.makeWorkdayChecker(['CN'])(D('2026-10-10')) === false, '全局默认 market(?cnRule=)生效');
  ok(hb.makeWorkdayChecker(['CN:bank'])(D('2026-10-10')) === true, "条目 token('CN:bank')优先于全局默认");

  hb = await createHolidayHub(['CN:market', 'CN', 'US'], [2026]);
  ok(hb.makeWorkdayChecker(['CN:market', 'US'])(D('2026-10-11')) === false, '周日+多国叠加 = 休息;token 归一化不重复建数据集');

  // 管道 + 诊断标注 + 响亮降级
  const tE = await (await call(hubWorker, '?cal=card&cnRule=market')).text();
  ok(tE.includes('CN工作日口径: market'), '诊断报告标注市场口径');
  const tE2 = await (await call(hubWorker, '?cal=card')).text();
  ok(tE2.includes('CN工作日口径: bank'), '诊断报告标注默认口径(bank)');
  const tE3 = U(await (await call(hubWorker, '?cal=card&cnRule=official')).text());   // 诊断正文,v6 折行 → 先 unfold
  ok(tE3.includes('已按 bank 处理') && tE3.includes('official 已废除'), "?cnRule=official(v5 已废) → 诊断响亮告警,不静默");
}

console.log('F. US 双日历(银行/federal vs 市场/NYSE)');
{
  const hb = await createHolidayHub(['US', 'US:market'], [2026, 2027, 2028]);
  const bank = hb.makeWorkdayChecker(['US']);
  const mkt = hb.makeWorkdayChecker(['US:market']);

  ok(bank(D('2026-04-03')) === true  && mkt(D('2026-04-03')) === false, 'Good Friday(2026-04-03): 银行开 / NYSE 休');
  ok(bank(D('2026-10-12')) === false && mkt(D('2026-10-12')) === true,  'Columbus Day: 银行休 / NYSE 开');
  ok(bank(D('2026-11-11')) === false && mkt(D('2026-11-11')) === true,  'Veterans Day: 银行休 / NYSE 开');
  ok(bank(D('2026-07-03')) === false && mkt(D('2026-07-03')) === false, '7/4落周六 -> 周五两边都休');
  ok(bank(D('2027-12-31')) === false && mkt(D('2027-12-31')) === true,  '元旦落周六: 银行observed休 / NYSE开(唯一例外规则)');
  ok(mkt(D('2026-11-26')) === false && mkt(D('2026-11-27')) === true,   '感恩节休; 次日半日市=开市');
  ok(mkt(D('2026-01-19')) === false && bank(D('2026-01-19')) === false, 'MLK 两边同休(交集节日)');
  ok(hb.makeWorkdayChecker(['US:bank'])(D('2026-10-12')) === false, "'US:bank' ≡ 'US'(显式写法等价)");
  ok(hb.makeWorkdayChecker(['CN', 'US:market'])(D('2026-04-03')) === false, '与 CN 叠加: 任一休即休');
}

console.log('G. HK 口径(v5: public 是唯一合法 kind;旧别名响亮降级)');
{
  const hb = await createHolidayHub(['HK', 'HK:public', 'HKG'], [2026]);
  const wHK = hb.makeWorkdayChecker(['HK']);
  const wP  = hb.makeWorkdayChecker(['HK:public']);
  const w3  = hb.makeWorkdayChecker(['HKG']);
  // 连续两周逐日等价(含周末),三种规范写法输出必须完全一致
  let allEq = true;
  for (let i = 0; i < 14; i++) {
    const d = D('2026-07-06'); d.setDate(d.getDate() + i);
    if (wHK(d) !== wP(d) || wHK(d) !== w3(d)) { allEq = false; break; }
  }
  ok(allEq, "'HK' / 'HK:public' / 'HKG'(alpha-3) 逐日等价");
  ok(wHK(D('2026-07-12')) === false && wHK(D('2026-07-13')) === true, '周日休/周一班,行为正常');
  ok(hb.makeWorkdayChecker(['CN', 'HK'])(D('2026-07-12')) === false, '可与他国叠加');
  // v4.3 的 'HK:market'/'HK:official' 别名已随 v5 废除:行为退默认口径(仍正确)但必须告警可见
  const hb2 = await createHolidayHub(['HK:market'], [2026]);
  ok(hb2.makeWorkdayChecker(['HK:market'])(D('2026-07-13')) === true, '旧别名不致崩:退 HK 默认口径');
  ok(hb2.loadLogs.some(l => /market/.test(l) && /WARN|⚠|告警|未识别|unknown/i.test(l)), '旧别名在 loadLogs 响亮告警(不静默)');
}

console.log('H. 三叠口径配方(CN+US+US:market) —— 钉死场景');
{
  const { computeReminder } = await import('../src/domains/card/repay-engine.js');
  const hb = await createHolidayHub(['CN', 'US', 'US:market'], [2026]);
  const w = hb.makeWorkdayChecker(['CN', 'US', 'US:market']);

  ok(w(D('2026-04-03')) === false, 'Good Friday: NYSE 腿休 → 全链休');
  ok(w(D('2026-10-12')) === false, 'Columbus: 银行腿休(NYSE 开也没用) → 全链休');
  ok(w(D('2026-11-11')) === false, 'Veterans: 银行腿休 → 全链休');
  ok(w(D('2026-10-01')) === false, 'CN 法定假 → 全链休');
  ok(w(D('2026-10-10')) === false, 'CN 补班周六: bank 说上班,但 US 双腿周末 → 全链休(叠加天然兜住)');
  ok(w(D('2026-10-13')) === true,  '三腿皆开的普通周二 → 工作日');

  // 还款引擎在三叠日历上倒推(端到端)
  const acct = { bankShortName: 'BOA', cardName: 'X', last4: '', emoji: '🇺🇸', country: 'US',
    countryLabel: '美国', repayCurrency: 'USD', holidayCalendars: ['CN', 'US', 'US:market'],
    model: 'legacy', repayDay: 13, advanceDays: 1 };
  let item = computeReminder(acct, 2026, 9, w, 1);
  ok(item.startDateStr === '20261009', `名义10/13(周二)提前1工作日: 跨过Columbus+周末+补班六 → 10/9 (实得 ${item.startDateStr})`);
  item = computeReminder({ ...acct, repayDay: 12 }, 2026, 9, w, 1);
  ok(item.startDateStr === '20261008', `名义恰逢Columbus: 节假日补偿+1 → 10/8 (实得 ${item.startDateStr})`);
}

console.log('I. 插件契约(异步 prepare / 故障隔离 / 字段透传)');
{
  const { DOMAINS } = await import('../src/registry.js');
  // 模拟插件 zz:异步 prepare + 闹钟带协议可选字段 tz
  // v6:交事件对象,零 ICS 知识;env 从 ctx 取(KV 驱动的域要先读 KV 才知道自己要哪些国家)
  DOMAINS.zz = {
    id: 'zz', contract: 2, calName: 'Z测试', defaultColor: '#000000',
    async prepare(q, ctx) {
      await new Promise(r => setTimeout(r, 5));           // 真·异步
      return { countries: [], state: { gotEnv: ctx.env !== undefined } };
    },
    async build(state, hub, ctx) {
      return {
        events: [{ uid: 'zz-demo-20260801', allDay: true, date: '2026-08-01', summary: '🧪 zz插件事件' }],
        alarms: [{ uid: 'zz-demo-202608', date: '2026-08-01', time: '09:00', reason: '🧪', tz: 'Asia/Tokyo' }],
        debugLines: ['【🧪 zz域】', `env注入:${state.gotEnv ? '✓' : '✗'}`, `hub位置参:${hub ? '✓' : '✗'}`]
      };
    }
  };
  // 模拟插件 bad:build 必炸 → 只熔断自己
  DOMAINS.bad = {
    id: 'bad', contract: 2, calName: 'B测试', defaultColor: '#000000',
    prepare() { return { countries: [], state: {} }; },
    build() { throw new Error('boom'); }
  };

  let tI = await (await call(hubWorker, '?cal=zz&debug=0&testDate=2026-07-08')).text();
  ok(tI.includes('🧪 zz插件事件'), '异步 prepare 的插件正常出事件');
  let jI = JSON.parse(await (await call(hubWorker, '?cal=zz&format=json&testDate=2026-07-08')).text());
  ok(jI.alarms.length === 1 && jI.alarms[0].tz === 'Asia/Tokyo', '协议可选字段(tz)原样透传');
  const tEnv = U(await (await call(hubWorker, '?cal=zz&debug=1&testDate=2026-07-08')).text());
  ok(tEnv.includes('env注入:✓'), 'prepare 从 ctx.env 拿到 env(v5 的第4参能力保留)');
  ok(tEnv.includes('hub位置参:✓'), 'build 位置参拿到 hub(它阶段二才诞生,进不了 prepare 的 ctx)');

  tI = await (await call(hubWorker, '?cal=card,bad&debug=0&testDate=2026-07-08')).text();
  ok(tI.includes('❌ 域 bad 构建失败'), '熔断哨兵事件出现(且不受 debug=0 影响)');
  ok(tI.includes('💳Repay'), '同请求中 card 域不受牵连');
  jI = JSON.parse(await (await call(hubWorker, '?cal=card,bad&format=json&cardAlarm=merged&testDate=2026-07-08')).text());
  ok(jI.v === 1 && jI.alarms.length > 0, '故障域被 JSON 静默剔除,协议输出仍合法');

  delete DOMAINS.zz; delete DOMAINS.bad;
}

console.log('K. 手术 B(账户哈希身份 / 旧别名删除 / 遗留字段清除)');
{
  const { uidHash } = await import('../src/governance.js');
  const { accountKey, makeAccountId } = await import('../src/domains/card/event-builder.js');

  // 冻结的哈希输入:改一个字 = 全部 uid 变。此断言就是冻结声明的执行器。
  ok(makeAccountId({ country: 'CN', bankShortName: 'HSBC-CN', cardName: 'Master/UnionPay', repayCurrency: 'CNY', last4: '' })
     === 'CN-HSBC-CN-MasterUnionPay-CNY-NA', '哈希输入冻结:五段、此顺序、特殊字符过滤(见 event-builder 冻结声明)');
  ok(uidHash('CN-招行-经典白-CNY-NA') !== uidHash('CN-中行-长城-CNY-NA'),
     '哈希原生吃 Unicode:两张中文简称卡不再撞键(v5 的 asciiId 有损压缩会把它们压成同一个 id)');
  ok(/^[0-9a-f]{8}$/.test(accountKey({ country: 'CN', bankShortName: 'X', cardName: 'Y', repayCurrency: 'CNY', last4: '1' })),
     'accountKey = 8 位十六进制(32bit;压到 4 位则 30 个身份 0.66% 撞号,不给压)');

  // 汇丰实况:v5 的 44 字符 uid 会被网关静默丢弃,现在 20 字符全数存活
  const jK = JSON.parse(await (await call(hubWorker, '?cal=card&format=json&cardAlarm=each&testDate=2026-07-15')).text());
  const hsbc = jK.alarms.filter(a => a.reason.includes('HSBC-CN'));
  ok(hsbc.length > 0 && hsbc.every(a => a.uid.length <= 40),
     `汇丰 each 闹钟全数存活且合规(${hsbc.length} 条, uid ${hsbc[0] ? hsbc[0].uid.length : '-'} 字符;v5 时是 44 > 40 被下游静默丢弃)`);

  // 日历↔闹钟配对:闹钟 uid 是日历 uid 的前缀(肉眼可对)
  const tK = await (await call(hubWorker, '?cal=card&merge=0&debug=0&testDate=2026-07-15')).text();
  const calUids = tK.split('\r\n').filter(l => l.startsWith('UID:card-')).map(l => l.slice(4).replace('@mycal.local', ''));
  ok(hsbc.every(a => calUids.some(u => u.startsWith(a.uid + '-'))),
     '闹钟 uid 是日历 uid 的前缀 → 日历↔闹钟肉眼配对(不必往标题里塞机器编号)');

  // 旧别名已删:响亮告警,不静默按默认跑
  const tAlias = U(await (await call(hubWorker, '?cal=card&adAlarms=-1:20:00&testDate=2026-07-15')).text());
  ok(tAlias.includes('?adAlarms= 已删除'), '?adAlarms= 已删除 → 诊断响亮告警(旧链接不会静默拿到默认提醒)');
  const tAlias2 = U(await (await call(hubWorker, '?cal=card&exAlarms=60&testDate=2026-07-15')).text());
  ok(tAlias2.includes('?exAlarms= 已删除'), '?exAlarms= 同理');

  // 遗留字段清除:购汇提示不再出现在任何正文
  const tFx = await (await call(hubWorker, '?cal=card&merge=0&debug=0&testDate=2026-07-15')).text();
  ok(!tFx.includes('购汇提示'), 'needsFxPurchase/fxNote 预留接口已删(从未启用的投机字段)');
}

console.log('J. v6 契约(contract:2 事件对象 / 出口治理 / 超时熔断)');
{
  const { DOMAINS } = await import('../src/registry.js');
  // v6 插件 vv:交【事件对象】,零 ICS 知识 —— 转义/折行/TRIGGER 全由框架代劳
  DOMAINS.vv = {
    id: 'vv', contract: 2, window: 'USE', calName: 'V测试', defaultColor: '#000000',
    async prepare(q, ctx) {
      await new Promise(r => setTimeout(r, 5));                    // 真·异步
      return { countries: [], state: { gotWindow: !!(ctx.window && ctx.window.from && ctx.window.to) } };
    },
    async build(state, hub, ctx) {
      return {
        events: [
          // 域交原始文本(真逗号/真换行),框架负责转义 —— v5 里这两个字符会破行
          { uid: 'vv-ok-20260801', allDay: true, date: '2026-08-01',
            summary: '🧪 vv插件, 含逗号', description: '第一行\n第二行; 含分号',
            reminders: [{ dayOffset: -1, at: '20:00' }] },
          { uid: 'vv-far-20301231', allDay: true, date: '2030-12-31', summary: '🧪 越界事件' },   // 应被裁
          { uid: 'zz-badprefix-20260801', allDay: true, date: '2026-08-01', summary: '🧪 前缀违规' }, // 应熔断
          { uid: 'vv-ok-20260801', allDay: true, date: '2026-08-02', summary: '🧪 uid 重复' }        // 应熔断
        ],
        alarms: [{ uid: 'vv-a-202608', date: '2026-08-01', time: '09:00', reason: '🧪', tz: 'Asia/Tokyo' }],
        debugLines: ['【🧪 vv域】', `窗口下发:${state.gotWindow ? '✓' : '✗'}`]
      };
    }
  };
  // v6 插件 slow:build 卡住 → 超时熔断(I/O 等待型;JS 无法取消 CPU 死循环,见 governance 头注)
  DOMAINS.slow = {
    id: 'slow', contract: 2, calName: 'S测试', defaultColor: '#000000',
    prepare() { return { countries: [], state: {} }; },
    build() { return new Promise(r => setTimeout(() => r({ events: [], alarms: [], debugLines: [] }), 9999)); }
  };

  let tJ = U(await (await call(hubWorker, '?cal=vv&testDate=2026-07-15')).text());
  // ⚠️ 熔断的负向断言必须在 debug=0 的净场里验:治理告警会把 summary 打进诊断
  //    (故意的 —— uid 可以不可读,诊断必须可读),整份 ICS 搜标题会搜到诊断里的那份。
  const tJClean = U(await (await call(hubWorker, '?cal=vv&debug=0&testDate=2026-07-15')).text());
  ok(tJ.includes('窗口下发:✓'), 'v6 契约:prepare 第2参拿到中枢窗口(ctx.window)');
  ok(tJ.includes('SUMMARY:🧪 vv插件\\, 含逗号'), '框架代劳 TEXT 转义(域给真逗号 → 输出 \\,;v5 此处会破行)');
  ok(tJ.includes('DESCRIPTION:第一行\\n第二行\\; 含分号'), '换行/分号转义同理');
  ok(tJ.includes('TRIGGER:-PT4H'), '提醒意图 {dayOffset:-1, at:20:00} → 相对 TRIGGER(结构性杜绝绝对 TRIGGER)');
  ok(!tJClean.includes('🧪 越界事件'), '出口治理:越界事件被裁剪');
  ok(tJ.includes('越界输出 1 条事件已裁剪'), '裁剪响亮报数(不静默)');
  ok(!tJClean.includes('🧪 前缀违规'), '出口治理:uid 前缀≠域id 被熔断(跨域防撞)');
  ok(tJ.includes('前缀须为 vv-'), '前缀违规响亮显形');
  ok(!tJClean.includes('🧪 uid 重复'), '出口治理:重复 uid 被熔断');
  ok((tJClean.match(/BEGIN:VEVENT/g) || []).length === 1, '4 进 1 出(debug=0 净场,不含诊断事件)');
  // 【诊断必须可读】uid 可以是不可读的哈希,但打 uid 时必须带上人话 —— 否则排错要查表
  ok(tJ.includes('(🧪 前缀违规)') && tJ.includes('(🧪 uid 重复)'), '治理告警打 uid 时带 summary(哈希化 uid 的可读性保障)');

  const jJ = JSON.parse(await (await call(hubWorker, '?cal=vv&format=json&testDate=2026-07-15')).text());
  ok(jJ.alarms.length === 1 && jJ.alarms[0].tz === 'Asia/Tokyo', 'v6 契约下闹钟通道协议 v1 原样(tz 透传)');

  const tSlow = await (await call(hubWorker, '?cal=vv,slow&debug=0&testDate=2026-07-15')).text();
  ok(tSlow.includes('❌ 域 slow 构建失败') && tSlow.includes('超时'), '超时熔断:慢域出哨兵事件(与抛错同一出口)');
  ok(tSlow.includes('🧪 vv插件'), '超时域不牵连同请求的其它域(故障隔离)');

  delete DOMAINS.vv; delete DOMAINS.slow;
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
