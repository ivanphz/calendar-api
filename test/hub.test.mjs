// 测试:重点验证 (a) 信用卡 VEVENT 与原项目输出逐行等价 (b) 用户五点要求
process.env.TZ = 'UTC'; // Cloudflare Workers 运行时为 UTC,本地对齐

// 断网 stub:假期源全部失败 → weekend-only 降级(两边一致,可公平对比)
globalThis.__cnDays = null; // 置为数组时,CN 源返回构造数据(用于双口径测试);其余源始终失败
globalThis.fetch = async (url) => {
  if (globalThis.__cnDays && String(url).includes('holiday-cn'))
    return { ok: true, status: 200, json: async () => ({ days: globalThis.__cnDays }), text: async () => '' };
  return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
};

import hubWorker from '../src/worker-entry.js';
// 原项目(最新版)直接引入,作为"金标准"
import originalWorker from '/home/claude/cc-new/repayment-cal-main/src/worker-entry.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };
const env = {}; // 无 KV → email 相关自然为空(与原项目行为一致)
const call = (w, qs) => w.fetch(new Request('https://x/' + qs), env, {});

// ============ A. 金标准对比:信用卡 VEVENT 逐行等价 ============
console.log('A. 信用卡输出 vs 原项目(逐行对比 VEVENT 段)');
const extractEvents = (text) => {
  const L = text.split('\r\n');
  const i = L.indexOf('BEGIN:VEVENT'), j = L.lastIndexOf('END:VEVENT');
  return i === -1 ? [] : L.slice(i, j + 1);
};
// 原项目含 debug 事件(在头部),先取其全部 VEVENT,再剔除 debug 事件做对比
const stripDebug = (lines) => {
  const out = []; let buf = [], inEv = false;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { inEv = true; buf = [l]; continue; }
    if (inEv) { buf.push(l); if (l === 'END:VEVENT') { inEv = false; if (!buf.some(x => x.startsWith('UID:debug-log-'))) out.push(...buf); } continue; }
  }
  return out;
};
// DTSTAMP 随生成时刻变化,归一化后对比
const norm = (lines) => lines.map(l => l.startsWith('DTSTAMP:') ? 'DTSTAMP:X' : l);

// [原项目参数, 中枢参数] 成对:两边显式对齐同一组生效值
const pairs = [
  ['?mode=exact&merge=1', ''],                              // 中枢新默认(exact+合并) vs 原项目显式同参
  ['', '?mode=allday&merge=0'],                             // 原项目默认(allday+不合并) vs 中枢显式同参
  ['?mode=exact&merge=1&past=1&future=4', '?past=1&future=4'],
  ['?mode=exact&merge=1&exAlarms=5,0', '?exAlarms=5,0'],
  ['?mode=exact&merge=1&ch=8&cm=15', '?ch=8&cm=15']
];
for (const [origQs, hubQs] of pairs) {
  const qs = `orig[${origQs||'默认'}] hub[${hubQs||'默认'}]`;
  const orig = await (await call(originalWorker, origQs)).text();
  const mine = await (await call(hubWorker, (hubQs ? hubQs + '&' : '?') + 'cal=card&debug=0')).text();
  const a = norm(stripDebug(extractEvents(orig)));
  const b = norm(extractEvents(mine));
  const same = a.length === b.length && a.every((l, i) => l === b[i]);
  ok(same, `参数[${qs || '默认'}] VEVENT 不等价: 原${a.length}行 vs 中枢${b.length}行`);
  if (!same) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { console.log('    首个差异@' + i, '\n    原:', a[i], '\n    枢:', b[i]); break; }
  }
}

// ============ B. 五点要求逐条 ============
console.log('B1. 参数独立:信用卡参数不影响签到;签到 ?months 不影响信用卡');
let t = await (await call(hubWorker, '?cal=checkin&debug=0&mode=exact&merge=1&past=9')).text();
let base = await (await call(hubWorker, '?cal=checkin&debug=0')).text();
ok(norm(t.split('\r\n')).join('\n') === norm(base.split('\r\n')).join('\n'), '信用卡参数泄漏进了签到域');
t = await (await call(hubWorker, '?cal=card&debug=0&months=1')).text();
base = await (await call(hubWorker, '?cal=card&debug=0')).text();
ok(norm(t.split('\r\n')).join('\n') === norm(base.split('\r\n')).join('\n'), '签到参数泄漏进了信用卡域');

console.log('B2. 信用卡闹钟:默认同日合并一条;each/off 可切');
let j = JSON.parse(await (await call(hubWorker, '?cal=card&format=json&testDate=2026-07-08')).text());
ok(j.v === 1 && j.alarms.length > 0, 'json 基本结构');
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
ok(t.includes('【假期数据源状态】'), '含假期源状态');

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

console.log('B5. 原项目文件逐字节保留(含注释卡/停用卡)');
// (文件级 cmp 已在搬运时验证 ✓)运行级再抽查:卓越5136已启用应出现在事件中
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

console.log('D. v4:领地/排除/标签/单卡豁免');
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

console.log('E. CN 双口径(official / market)');
{
  const { createHolidayHub } = await import('../src/holidays/index.js');
  // 构造:2026-10-01(周四)法定放假;2026-10-10(周六)调休补班
  globalThis.__cnDays = [
    { date: '2026-10-01', isOffDay: true },
    { date: '2026-10-10', isOffDay: false }
  ];
  const D = (str) => { const [a, b, c] = str.split('-').map(Number); return new Date(a, b - 1, c, 12, 0, 0); };

  let hb = await createHolidayHub(['CN'], [2026]);
  let w = hb.makeWorkdayChecker(['CN']);
  ok(w(D('2026-10-10')) === true,  'official: 补班周六 = 上班(原行为分毫未动)');
  ok(w(D('2026-10-01')) === false, 'official: 法定假 = 休息');
  ok(w(D('2026-10-13')) === true,  'official: 普通周二 = 上班');

  w = hb.makeWorkdayChecker(['CN:market']);
  ok(w(D('2026-10-10')) === false, 'market: 补班周六 = 休息(股市/清算口径)');
  ok(w(D('2026-10-01')) === false, 'market: 法定假 = 休息');
  ok(w(D('2026-10-13')) === true,  'market: 普通周二 = 上班');

  hb = await createHolidayHub(['CN'], [2026], { cnDefaultRule: 'market' });
  ok(hb.makeWorkdayChecker(['CN'])(D('2026-10-10')) === false, '全局默认 market(?cnRule=)生效');
  ok(hb.makeWorkdayChecker(['CN:official'])(D('2026-10-10')) === true, '条目 token 优先于全局默认');

  hb = await createHolidayHub(['CN:market', 'CN', 'US'], [2026]);
  ok(hb.makeWorkdayChecker(['CN:market', 'US'])(D('2026-10-11')) === false, '周日+多国叠加 = 休息;token 归一化不重复建 provider');
  globalThis.__cnDays = null;

  // 管道 + 诊断标注
  const tE = await (await call(hubWorker, '?cal=card&cnRule=market')).text();
  ok(tE.includes('CN工作日口径: market'), '诊断报告标注市场口径');
  const tE2 = await (await call(hubWorker, '?cal=card')).text();
  ok(tE2.includes('CN工作日口径: official'), '诊断报告标注默认口径');
}

console.log('F. US 双日历(银行/federal vs 市场/NYSE)');
{
  const { createHolidayHub } = await import('../src/holidays/index.js');
  const D = (str) => { const [a, b, c] = str.split('-').map(Number); return new Date(a, b - 1, c, 12, 0, 0); };
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
  ok(hb.makeWorkdayChecker(['US:official'])(D('2026-10-12')) === false, "'US:official' ≡ 'US'(银行口径)");
  ok(hb.makeWorkdayChecker(['CN', 'US:market'])(D('2026-04-03')) === false, '与 CN 叠加: 任一休即休');
}

console.log('G. HK 口径别名(HK:market ≡ HK)');
{
  const { createHolidayHub } = await import('../src/holidays/index.js');
  const D = (str) => { const [a, b, c] = str.split('-').map(Number); return new Date(a, b - 1, c, 12, 0, 0); };
  const hb = await createHolidayHub(['HK', 'HK:market', 'HK:official'], [2026]);
  const wHK = hb.makeWorkdayChecker(['HK']);
  const wM  = hb.makeWorkdayChecker(['HK:market']);
  const wO  = hb.makeWorkdayChecker(['HK:official']);
  // 连续两周逐日等价(含周末),三种写法输出必须完全一致
  let allEq = true;
  for (let i = 0; i < 14; i++) {
    const d = D('2026-07-06'); d.setDate(d.getDate() + i);
    if (wHK(d) !== wM(d) || wHK(d) !== wO(d)) { allEq = false; break; }
  }
  ok(allEq, "'HK:market'/'HK:official' 与 'HK' 逐日等价(别名契约)");
  ok(wM(D('2026-07-12')) === false && wM(D('2026-07-13')) === true, '别名下周日休/周一班,行为正常');
  ok(hb.makeWorkdayChecker(['CN', 'HK:market'])(D('2026-07-12')) === false, '别名可与他国叠加');
}

console.log('H. 三叠口径配方(CN+US+US:market) —— 钉死场景');
{
  const { createHolidayHub } = await import('../src/holidays/index.js');
  const { computeReminder } = await import('../src/domains/card/repay-engine.js');
  const D = (str) => { const [a, b, c] = str.split('-').map(Number); return new Date(a, b - 1, c, 12, 0, 0); };
  globalThis.__cnDays = [
    { date: '2026-10-01', isOffDay: true },    // CN 法定假(周四)
    { date: '2026-10-10', isOffDay: false }    // CN 调休补班(周六)
  ];
  const hb = await createHolidayHub(['CN', 'US', 'US:market'], [2026]);
  const w = hb.makeWorkdayChecker(['CN', 'US', 'US:market']);

  ok(w(D('2026-04-03')) === false, 'Good Friday: NYSE 腿休 → 全链休');
  ok(w(D('2026-10-12')) === false, 'Columbus: 银行腿休(NYSE 开也没用) → 全链休');
  ok(w(D('2026-11-11')) === false, 'Veterans: 银行腿休 → 全链休');
  ok(w(D('2026-10-01')) === false, 'CN 法定假 → 全链休');
  ok(w(D('2026-10-10')) === false, 'CN 补班周六: official 说上班,但 US 双腿周末 → 全链休(叠加天然兜住)');
  ok(w(D('2026-10-13')) === true,  '三腿皆开的普通周二 → 工作日');

  // verbatim 还款引擎在三叠日历上倒推(端到端)
  const acct = { bankShortName: 'BOA', cardName: 'X', last4: '', emoji: '🇺🇸', country: 'US',
    countryLabel: '美国', repayCurrency: 'USD', holidayCalendars: ['CN', 'US', 'US:market'],
    model: 'legacy', repayDay: 13, advanceDays: 1 };
  let item = computeReminder(acct, 2026, 9, w, 1);
  ok(item.startDateStr === '20261009', `名义10/13(周二)提前1工作日: 跨过Columbus+周末+补班六 → 10/9 (实得 ${item.startDateStr})`);
  item = computeReminder({ ...acct, repayDay: 12 }, 2026, 9, w, 1);
  ok(item.startDateStr === '20261008', `名义恰逢Columbus: 节假日补偿+1 → 10/8 (实得 ${item.startDateStr})`);
  globalThis.__cnDays = null;
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
        eventLines: ['BEGIN:VEVENT', 'UID:zz-demo-202612@mycal.local', 'DTSTAMP:X',
          'SUMMARY:🧪 zz插件事件', 'DTSTART;TZID=Asia/Shanghai:20261201T090000',
          'DURATION:PT10M', 'END:VEVENT'],
        alarms: [{ uid: 'zz-demo-202612', date: '2026-12-01', time: '09:00', reason: 'zz', tz: 'Asia/Tokyo' }],
        debugLines: [`【zz】env注入:${state.gotEnv ? '✓' : '✗'}`]
      };
    }
  };
  // 模拟插件 bad:build 抛异常
  DOMAINS.bad = {
    id: 'bad', calName: 'B', defaultColor: '#111111',
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
  jI = JSON.parse(await (await call(hubWorker, '?cal=card,bad&format=json&testDate=2026-07-08')).text());
  ok(jI.v === 1 && jI.alarms.length > 0, '故障域被 JSON 静默剔除,协议输出仍合法');

  delete DOMAINS.zz; delete DOMAINS.bad;
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
