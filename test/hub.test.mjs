// ============================================================================
// calendar-api 测试套件 (v5.2)
// ============================================================================
// 验证:
//   (a) 信用卡事件生成的结构自洽(账户/合并/VALARM/口径避让)
//   (b) 框架契约:领地/视图组合/闹钟策略/故障隔离/字段透传
//   (c) 假期口径(v5 词汇: bank|market|public;official 已废除)与三叠配方
//   (d) 上游 workdays-core 的响亮降级在本库可见(告警不静默)
//
// ── v5.2 变更:移除 golden 金标准 ─────────────────────────────────────────────
// 信用卡逻辑自并入框架起已是【一等公民,可破坏性演进】,不再与"原项目冻结版"逐行绑定
// (原 golden/A组/B5字节看守随本版删除,理由见 DEVLOG v5.2)。信用卡正确性改由:
//   · A 组结构断言(该出的出、该合并的合并、VALARM 符合配置)
//   · E~H 组口径/避让/三叠端到端(真实归档日期钉死)
//   · I 组插件契约
// 三者共同守护;要改信用卡逻辑,直接改 src/domains/card/ 并更新相应断言即可。
process.env.TZ = 'UTC'; // Cloudflare Workers 运行时为 UTC,本地对齐

import { createHolidayHub } from '@ivanphz/workdays-core';
import hubWorker from '../src/worker-entry.js';

// ---- 喂数 stub:上游打包内置数据,零联网;测试直接调 core,无需拦截 fetch ----
// (v5.2 起信用卡逻辑已是框架一等公民,不再与"原项目冻结版"逐行对比 —— 见 DEVLOG v5.2;
//  故这里不再需要为 golden 的 fetch 供数,fetch stub 仅为防止意外真实联网而保留最小兜底。)
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };
const env = {}; // 无 KV → email 相关自然为空(与原项目行为一致)
const call = (w, qs) => w.fetch(new Request('https://x/' + qs), env, {});
const D = (str) => { const [a, b, c] = str.split('-').map(Number); return new Date(a, b - 1, c, 12, 0, 0); };
// DTSTAMP 随生成时刻变化,行集合对比时归一化
const norm = (lines) => lines.map(l => l.startsWith('DTSTAMP:') ? 'DTSTAMP:X' : l);

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
  // exact 默认:每个非诊断事件都应有 DTSTART 带时刻 + 至少一条 VALARM
  let t = await (await call(hubWorker, '?cal=card&debug=0&testDate=2026-07-01')).text();
  let blocks = extractEventBlocks(t);
  ok(blocks.length > 0, 'exact 默认: 有信用卡事件产出');
  ok(blocks.every(b => b.some(l => /^DTSTART;TZID=Asia\/Shanghai:\d{8}T\d{6}$/.test(l))), 'exact: 每事件 DTSTART 带北京时刻');
  ok(blocks.every(b => b.some(l => l === 'BEGIN:VALARM')), 'exact: 每事件含日历 VALARM(exactReminders 生效)');
  ok(blocks.every(b => b.filter(l => l === 'BEGIN:VALARM').length === 1), '默认 exactReminders=[0]: 每事件恰 1 条 VALARM');
  ok(t.includes('TRIGGER:-PT0M'), '默认准点: VALARM = -PT0M(不提前)');
  // allday 模式:DTSTART 为 VALUE=DATE,VALARM 用带符号偏移
  t = await (await call(hubWorker, '?cal=card&debug=0&mode=allday&testDate=2026-07-01')).text();
  blocks = extractEventBlocks(t);
  ok(blocks.every(b => b.some(l => /^DTSTART;VALUE=DATE:\d{8}$/.test(l))), 'allday: DTSTART 为全天');
  ok(blocks.some(b => b.some(l => /^TRIGGER:-?P/.test(l))), 'allday: VALARM 用 allDayReminders 的带符号偏移');
  // merge 语义:同日多账户默认合一
  t = await (await call(hubWorker, '?cal=card&debug=0&merge=1&testDate=2026-07-01')).text();
  const merged = extractEventBlocks(t).length;
  t = await (await call(hubWorker, '?cal=card&debug=0&merge=0&testDate=2026-07-01')).text();
  const unmerged = extractEventBlocks(t).length;
  ok(merged <= unmerged, `合并事件数(${merged}) ≤ 不合并(${unmerged})`);
}

// ============ B. 五点要求逐条 ============
console.log('B1. 参数独立:信用卡参数不影响签到;签到 ?months 不影响信用卡');
let t = await (await call(hubWorker, '?cal=checkin&debug=0&mode=exact&merge=1&past=9')).text();
let base = await (await call(hubWorker, '?cal=checkin&debug=0')).text();
ok(norm(t.split('\r\n')).join('\n') === norm(base.split('\r\n')).join('\n'), '信用卡参数泄漏进了签到域');
t = await (await call(hubWorker, '?cal=card&debug=0&months=1')).text();
base = await (await call(hubWorker, '?cal=card&debug=0')).text();
ok(norm(t.split('\r\n')).join('\n') === norm(base.split('\r\n')).join('\n'), '签到参数泄漏进了信用卡域');

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
t = await (await call(hubWorker, '?cal=all')).text();
ok(t.includes('⚙️ 提醒中枢诊断报告'), '默认含诊断事件');
ok(t.includes('【💳 信用卡域】') && t.includes('【活跃账户'), '含信用卡域原版报告(账户清单)');
ok(t.includes('显示模式: exact') && t.includes('同日合并: 是'), '写明你的默认(exact/合并)');
ok(t.includes('【⏰ 签到域】') && t.includes('闹钟策略'), '含签到域报告与闹钟策略说明');
ok(t.includes('【假期数据源状态 · 上游 workdays-core】'), '含上游数据源状态段');

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
  const tE3 = await (await call(hubWorker, '?cal=card&cnRule=official')).text();
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
  DOMAINS.zz = {
    id: 'zz', calName: 'Z测试', defaultColor: '#000000',
    async prepare(q, base, filters, env) {
      await new Promise(r => setTimeout(r, 5));           // 真·异步
      return { countries: [], years: [], state: { gotEnv: env !== undefined } };
    },
    async build(state) {
      return {
        eventLines: ['BEGIN:VEVENT', 'UID:zz-demo-20260801@mycal.local', 'DTSTAMP:20260701T000000Z',
          'SUMMARY:🧪 zz插件事件', 'DTSTART;VALUE=DATE:20260801', 'DTEND;VALUE=DATE:20260802', 'END:VEVENT'],
        alarms: [{ uid: 'zz-demo-202608', date: '2026-08-01', time: '09:00', reason: '🧪', tz: 'Asia/Tokyo' }],
        debugLines: ['【🧪 zz域】', `env注入:${state.gotEnv ? '✓' : '✗'}`]
      };
    }
  };
  // 模拟插件 bad:build 必炸 → 只熔断自己
  DOMAINS.bad = {
    id: 'bad', calName: 'B测试', defaultColor: '#000000',
    prepare() { return { countries: [], years: [], state: {} }; },
    build() { throw new Error('boom'); }
  };

  let tI = await (await call(hubWorker, '?cal=zz&debug=0&testDate=2026-07-08')).text();
  ok(tI.includes('🧪 zz插件事件'), '异步 prepare 的插件正常出事件');
  let jI = JSON.parse(await (await call(hubWorker, '?cal=zz&format=json&testDate=2026-07-08')).text());
  ok(jI.alarms.length === 1 && jI.alarms[0].tz === 'Asia/Tokyo', '协议可选字段(tz)原样透传');
  ok((await (await call(hubWorker, '?cal=zz&debug=1&testDate=2026-07-08')).text()).includes('env注入:✓'), 'prepare 第4参拿到 env');

  tI = await (await call(hubWorker, '?cal=card,bad&debug=0&testDate=2026-07-08')).text();
  ok(tI.includes('❌ 域 bad 构建失败'), '熔断哨兵事件出现(且不受 debug=0 影响)');
  ok(tI.includes('💳Repay'), '同请求中 card 域不受牵连');
  jI = JSON.parse(await (await call(hubWorker, '?cal=card,bad&format=json&cardAlarm=merged&testDate=2026-07-08')).text());
  ok(jI.v === 1 && jI.alarms.length > 0, '故障域被 JSON 静默剔除,协议输出仍合法');

  delete DOMAINS.zz; delete DOMAINS.bad;
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
