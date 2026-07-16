// ============================================================================
// 框架层测试:渲染器 + 治理(v6 新增,R 组 / G 组)
// ============================================================================
// 与 hub.test.mjs 分开的理由:本文件【零外部依赖】(不 import workdays-core、不起
// worker)—— 渲染与治理是纯框架资产,与任何域、任何数据源无关,必须能独立验证。
//
//   R 组:渲染器 —— 转义/探雷/折行(UTF-8 安全)/TRIGGER 字节级 v5 全等/事件渲染/信封
//   G 组:治理   —— uidHash 短哈希工具 / uid 双协议(日历软硬分层/闹钟全硬)/唯一性/
//                 窗口换算与缓冲裁剪/超时
//   B 组:领地看守 —— 域目录禁 ICS 关键字;渲染器/治理禁 import 域文件

import {
  escapeIcsText, containsHandWrittenEscape, foldIcsLine,
  beforeStartTrigger, signedDurationTrigger,
  renderEventObject, renderCalendarDocument, makeDtStamp
} from '../src/renderer.js';
import {
  computeViewWindow, computeClampWindow, CLAMP_BUFFER_DAYS,
  uidHash, checkCalendarUid, checkAlarmUid,
  governDomainEvents, governDomainAlarms,
  runWithTimeBudget
} from '../src/governance.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ❌ ' + m)); };
const enc = new TextEncoder();

// ============ R1. 转义:域给原文,框架唯一转义点 ============
console.log('R1. TEXT 转义');
{
  ok(escapeIcsText('a,b;c') === 'a\\,b\\;c', '逗号/分号转义');
  ok(escapeIcsText('第一行\n第二行') === '第一行\\n第二行', '真实换行 → \\n 序列');
  ok(escapeIcsText('C:\\notes') === 'C:\\\\notes', '反斜杠先转,不被二次转义');
  ok(escapeIcsText('Pulse, Red') === 'Pulse\\, Red', '含逗号卡名不再破行(v5 真 bug 的修复)');
  ok(escapeIcsText('a\r\nb\rc') === 'a\\nb\\nc', 'CRLF/CR 归一为 \\n');
}

// ============ R2. 探雷断言:手写转义序列显形 ============
console.log('R2. 手写转义探雷');
{
  ok(containsHandWrittenEscape('推算明细\\n\\n锚点') === true, '源码级 \\n 字面量被探出(迁移漏网形态)');
  ok(containsHandWrittenEscape('正常正文\n真换行') === false, '真实换行不误报');
  ok(containsHandWrittenEscape('金额 1,024 元') === false, '普通逗号不误报');
}

// ============ R3. 折行:75 字节,UTF-8 安全 ============
console.log('R3. 折行');
{
  const short = 'SUMMARY:短行';
  ok(foldIcsLine(short).length === 1 && foldIcsLine(short)[0] === short, '短行原样');

  const long = 'DESCRIPTION:' + '中文内容混emoji💳与English '.repeat(12);
  const folded = foldIcsLine(long);
  ok(folded.length > 1, '长行确实折了');
  ok(folded.every(l => enc.encode(l).length <= 75), '每行 ≤75 字节');
  ok(folded.slice(1).every(l => l.startsWith(' ')), '续行以空格开头');
  const unfolded = folded[0] + folded.slice(1).map(l => l.slice(1)).join('');
  ok(unfolded === long, 'unfold 还原 = 原文(无字符丢失)');
  // UTF-8 安全:逐行 encode→decode 往返无损 = 没有任何多字节字符被劈开
  const dec = new TextDecoder('utf-8', { fatal: true });
  ok(folded.every(l => { try { dec.decode(enc.encode(l)); return true; } catch { return false; } }), '折点不劈多字节字符');
}

// ============ R4. TRIGGER:与 v5 字节级全等(金标准命门) ============
console.log('R4. TRIGGER v5 全等');
{
  ok(beforeStartTrigger(0) === '-PT0M', 'exact 准点 → -PT0M');
  ok(beforeStartTrigger(5) === '-PT5M', 'exact 提前5分');
  ok(beforeStartTrigger(60) === '-PT1H', 'exact 整小时无 M 段');
  ok(beforeStartTrigger(90) === '-PT1H30M', 'exact 时+分');
  // allday 三元组换算:dayOffset*1440 + h*60 + m
  ok(signedDurationTrigger(-1 * 1440 + 20 * 60) === '-PT4H', '前一天20:00 → -PT4H(v5 原语义:相对午夜)');
  ok(signedDurationTrigger(0 * 1440 + 9 * 60 + 30) === '+PT9H30M', '当天09:30 → +PT9H30M');
  ok(signedDurationTrigger(-1440) === '-P1D', '整日无 T 段');
  ok(signedDurationTrigger(0) === '+PT0M', '零偏移显式正号(无 -0)');
}

// ============ R5. 事件渲染:两种形态 + 提醒两形态 + 缺省文案 v5 全等 ============
console.log('R5. 事件对象渲染');
const dtStamp = '20260715T000000Z';
{
  // 定点事件(card exact 形态)
  const timed = renderEventObject({
    uid: 'card-day-20260720', allDay: false, date: '2026-07-20', time: '09:30',
    durationMinutes: 360, summary: '💳Repay · 2笔',
    description: '【合并提醒】当日共 2 笔账单需处理\n\n────────\n\n明细',
    reminders: [{ minutesBefore: 60 }, { minutesBefore: 0 }]
  }, { dtStamp, defaultTimezone: 'Asia/Shanghai' });
  ok(timed.lines[0] === 'BEGIN:VEVENT' && timed.lines.at(-1) === 'END:VEVENT', 'VEVENT 完整包裹');
  ok(timed.lines.includes('UID:card-day-20260720@mycal.local'), '@域名后缀由渲染器统一追加');
  ok(timed.lines.includes('DTSTART;TZID=Asia/Shanghai:20260720T093000'), '定点 DTSTART 语法 = v5 pushTiming 原样(缺省时区回填)');
  ok(timed.lines.includes('DURATION:PT360M'), 'DURATION 语法');
  ok(timed.lines.includes('TRIGGER:-PT1H') && timed.lines.includes('TRIGGER:-PT0M'), '两条 VALARM 相对 TRIGGER');
  ok(timed.lines.includes('DESCRIPTION:提前60分钟提醒！') && timed.lines.includes('DESCRIPTION:事件开始时提醒！'), '缺省文案 = v5 原文');
  ok(timed.lines.some(l => l.startsWith('DESCRIPTION:【合并提醒】') && l.includes('\\n')), '正文真换行被转义为 \\n');
  ok(timed.warnings.length === 0, '干净输入零告警');

  // 全天事件(card allday 形态) + 三元组提醒 + endDate 缺省次日
  const allday = renderEventObject({
    uid: 'card-day-20260721', allDay: true, date: '2026-07-21',
    summary: '💳Repay', reminders: [{ dayOffset: -1, at: '20:00' }, { dayOffset: 0, at: '09:30' }]
  }, { dtStamp, defaultTimezone: 'Asia/Shanghai' });
  ok(allday.lines.includes('DTSTART;VALUE=DATE:20260721') && allday.lines.includes('DTEND;VALUE=DATE:20260722'), '全天 DTSTART/排他 DTEND(缺省次日,含月末进位由 UTC 日期算术保证)');
  ok(allday.lines.includes('TRIGGER:-PT4H') && allday.lines.includes('TRIGGER:+PT9H30M'), '三元组 → 相对 TRIGGER(v5 signedDuration 语义)');
  ok(allday.lines.includes('DESCRIPTION:第-1天 20:00 提醒！') && allday.lines.includes('DESCRIPTION:当天 09:30 提醒！'), 'allday 缺省文案 = v5 原文');

  // 自定义 label(checkin 场景) + 显式 tz + URL
  const custom = renderEventObject({
    uid: 'checkin-moeshare-202607', allDay: false, date: '2026-07-01', time: '16:29',
    tz: 'Asia/Tokyo', durationMinutes: 10, summary: '💰 MoeShare 签到提醒',
    url: 'https://moeshare.cc/jobcenter.php?action=list',
    reminders: [{ minutesBefore: 5, label: 'MoeShare本月打卡补贴 可签到！' }]
  }, { dtStamp, defaultTimezone: 'Asia/Shanghai' });
  ok(custom.lines.includes('DTSTART;TZID=Asia/Tokyo:20260701T162900'), '显式 tz 直落 TZID(域给墙上时间,零换算)');
  ok(custom.lines.includes('DESCRIPTION:MoeShare本月打卡补贴 可签到！'), '自定义 label 覆盖缺省文案');
  ok(custom.lines.includes('URL:https://moeshare.cc/jobcenter.php?action=list'), 'URL 属性(URI 型不转义)');

  // 探雷:手写 \\n 的迁移漏网被告警(不熔断)
  const mined = renderEventObject({
    uid: 'card-x-202607', allDay: true, date: '2026-07-21', summary: 'x',
    description: '旧写法\\n漏网'
  }, { dtStamp, defaultTimezone: 'Asia/Shanghai' });
  ok(mined.warnings.length === 1 && mined.warnings[0].includes('手写转义'), '探雷告警触发');
  ok(mined.lines.some(l => l.startsWith('DESCRIPTION:')), '告警但照常渲染(响亮不拦截)');

  // 提醒形态不合法 → 跳过 + 告警
  const badReminder = renderEventObject({
    uid: 'card-y-202607', allDay: true, date: '2026-07-21', summary: 'y', reminders: [{ foo: 1 }]
  }, { dtStamp, defaultTimezone: 'Asia/Shanghai' });
  ok(!badReminder.lines.includes('BEGIN:VALARM') && badReminder.warnings.some(w => w.includes('形态不合法')), '非法提醒意图:跳过并告警');
}

// ============ R6. 整册信封 ============
console.log('R6. 信封');
{
  const ev = renderEventObject({ uid: 'card-z-202607', allDay: true, date: '2026-07-21', summary: 'z' },
    { dtStamp, defaultTimezone: 'Asia/Shanghai' });
  const doc = renderCalendarDocument({ calendarName: '📌 提醒合集', timezone: 'Asia/Shanghai', color: '#FF9500' }, [ev.lines]);
  ok(doc.startsWith('BEGIN:VCALENDAR') && doc.endsWith('END:VCALENDAR'), 'VCALENDAR 包裹');
  ok(doc.includes('X-WR-CALNAME:📌 提醒合集') && doc.includes('X-APPLE-CALENDAR-COLOR:#FF9500'), '册名/颜色');
  ok(doc.includes('\r\n') && !/[^\r]\n/.test(doc), 'CRLF 统一,无裸 LF');
  ok(/^\d{8}T\d{6}Z$/.test(makeDtStamp()), 'makeDtStamp 形状');
}

// ============ G1. 窗口:换算与缓冲 ============
console.log('G1. 窗口换算');
{
  const base = new Date(2026, 6, 15, 12, 0, 0);   // 2026-07-15
  const view = computeViewWindow(base, 3, 12);
  ok(view.from === '2026-04-01' && view.to === '2027-07-31', '视图窗:月对齐(过3未12)');
  const clamp = computeClampWindow(view);
  ok(clamp.from === '2026-02-15' && clamp.to === '2027-09-14', `裁剪窗 = 视图窗 ±${CLAMP_BUFFER_DAYS} 天`);
  const view0 = computeViewWindow(new Date(2026, 0, 10), 3, 1);
  ok(view0.from === '2025-10-01' && view0.to === '2026-02-28', '跨年边界正确');
}

// ============ G2. uid 短哈希工具(框架发工具,不发政策) ============
console.log('G2. uidHash');
{
  ok(/^[0-9a-f]{8}$/.test(uidHash('anything')), '8 位十六进制(32bit)');
  ok(uidHash('CN-CMB-X-CNY-NA') === uidHash('CN-CMB-X-CNY-NA'), '确定性:同输入同输出(uid 稳定=网关不抖的前提)');
  ok(uidHash('CN-招行-经典白-CNY-NA') !== uidHash('CN-中行-长城-CNY-NA'),
     '原生吃 Unicode:中文身份不撞(无需有损 ASCII 压缩 —— v5 那个 bug 的根治)');
  ok(uidHash('a') !== uidHash('b') && uidHash('CN-X-1') !== uidHash('CN-X-2'), '相邻输入充分散开');
  ok(uidHash('') === uidHash(''), '空串不炸');
  // 长度预算:'card-' + 8 + '-' + 'YYYYMM' = 20,只用掉下游硬限 40 的一半 —— 没有压到 4 位的理由
  ok(('card-' + uidHash('CN-HSBC-CN-MasterUnionPay-CNY-NA') + '-202607').length === 20,
     '典型 uid = 20 字符(上限 40,余量一半;压 4 位省 4 字符换 0.66% 撞号,不划算)');
  // 与校验器成对:造出来的东西必须过得了自己的查
  ok(checkAlarmUid('card-' + uidHash('CN-HSBC-CN-MasterUnionPay-CNY-NA') + '-202607', 'card').ok === true,
     '构造器产出必然通过校验器(一造一查,同一件事的正反面)');
}

// ============ G3. uid 双协议:日历软硬分层 / 闹钟全硬 ============
console.log('G3. uid 双协议');
{
  ok(checkCalendarUid('card-day-20260715', 'card').ok === true, '日历合规 uid 放行');
  ok(checkCalendarUid('repay-2026-6-x', 'card').ok === false, '前缀非域 id → 硬熔断(跨域防撞)');
  const cn = checkCalendarUid('card-2026-6-CN-PAB-一账通-CNY-NA-20260715', 'card');
  ok(cn.ok === true && cn.warning && cn.warning.includes('字符集'), '含中文 uid(v5 现网 PAB 实况):告警不熔断,等手术 B 消音');
  ok(checkAlarmUid('card-day-20260715', 'card').ok === true, '闹钟合规 uid 放行');
  ok(checkAlarmUid('card-CN-HSBC-CN-MasterUnionPay-CNY-NA-202607', 'card').ok === false, '闹钟 uid 44 字符 > 40 → 硬熔断(v5 现网汇丰实况,不再静默流向下游)');
  ok(checkAlarmUid('card-一账通-202607', 'card').ok === false, '闹钟 uid 含中文 → 硬熔断');
  ok(checkAlarmUid('checkin-moeshare-202607', 'card').ok === false, '闹钟前缀跨域 → 硬熔断');
}

// ============ G4. 逐域出口审计 ============
console.log('G4. 出口审计');
{
  const clampWindow = { from: '2026-02-15', to: '2027-09-14' };
  const seenUids = new Set();
  const r1 = governDomainEvents({
    domainId: 'card', clampWindow, seenUids,
    events: [
      { uid: 'card-a-202607', date: '2026-07-20' },
      { uid: 'card-a-202607', date: '2026-07-21' },      // 重复 uid
      { uid: 'card-b-202607', date: '2030-01-01' },      // 离谱越界
      { uid: 'repay-old-1',   date: '2026-07-20' },      // 旧前缀
      { uid: 'card-c-202607' }                            // 缺 date
    ]
  });
  ok(r1.accepted.length === 1 && r1.accepted[0].uid === 'card-a-202607', '5 进 1 出:重复/越界/前缀/缺date 各熔断或裁剪');
  ok(r1.notes.some(n => n.includes('越界输出 1 条')), '裁剪响亮报数');
  ok(r1.notes.filter(n => n.startsWith('❌')).length === 3, '三条硬熔断逐条显形');

  // 跨域共享 seenUids:第二个域撞第一个域的 uid 也被抓
  const r2 = governDomainEvents({
    domainId: 'checkin', clampWindow, seenUids,
    events: [{ uid: 'checkin-m-202607', date: '2026-07-20' }]
  });
  ok(r2.accepted.length === 1 && seenUids.size === 2, '跨域唯一性登记');

  const seenAlarmUids = new Set();
  const a1 = governDomainAlarms({
    domainId: 'card', seenAlarmUids,
    alarms: [
      { uid: 'card-day-20260720', date: '2026-07-20', time: '09:30', reason: 'r' },
      { uid: 'card-CN-HSBC-CN-MasterUnionPay-CNY-NA-202607', date: '2026-07-21', time: '09:30', reason: 'r' }
    ]
  });
  ok(a1.accepted.length === 1 && a1.notes.length === 1 && a1.notes[0].includes('超下游硬限'), '闹钟通道:超长 uid 在【本框架】诊断显形,不再要跑下游面板才看见');
  ok(a1.accepted[0].reason === 'r' && a1.accepted[0].time === '09:30', '合规条目字段原样透传(治理不改内容)');
}

// ============ G5. 时间预算 ============
console.log('G5. 时间预算');
{
  const fast = await runWithTimeBudget(Promise.resolve(42), 200, '域 x');
  ok(fast.ok === true && fast.value === 42, '快任务原值返回');
  const slow = await runWithTimeBudget(new Promise(r => setTimeout(() => r(1), 300)), 50, '域 y');
  ok(slow.ok === false && slow.timedOut === true && slow.error.includes('超时'), '慢任务熔断并报预算');
  const thrown = await runWithTimeBudget(Promise.reject(new Error('boom')), 200, '域 z');
  ok(thrown.ok === false && thrown.timedOut === false && thrown.error === 'boom', '抛错与超时可区分');
}

// ============ B. 领地看守:域禁 ICS 关键字 / 框架禁 import 域 ============
console.log('B. 领地看守');
{
  // v6 铁律(EVENT-MODEL §8):域目录不得出现 ICS 语法关键字 —— 出现 = 域在私产 ICS。
  // ✅ 白名单已清空 —— checkin/card 手术均完成,铁律【全域生效】。
  //    与之同生共死的 worker-entry.js 双契约桥也已拆除(两处互为进度条,一起归零)。
  //    留着这个空集合是给未来的:万一哪天又要分批迁移,填回来即可,规矩现成。
  const MIGRATION_WHITELIST = new Set([]);
  const ICS_KEYWORDS = ['BEGIN:VEVENT', 'BEGIN:VALARM', 'TRIGGER:', 'DTSTART', 'X-WR-'];
  // 【只查代码,不查散文】域文件的注释里【应该】出现这些词 —— 那是在说明"此物归框架管",
  // 是文档不是违规。裸 includes() 分不清,会让插件作者写一句合理注释就吃红灯。
  // 启发式(非 JS 解析器,够用即可):剥掉 /* */ 块 与 整行 // 注释。
  // 已知局限:代码行尾的行内注释(`foo(); // DTSTART`)仍会误报 —— 罕见,遇到改写措辞即可。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(line => !/^\s*(\/\/|\*)/.test(line)).join('\n');
  const domainsDir = new URL('../src/domains/', import.meta.url).pathname;
  let violations = [];
  for (const domain of readdirSync(domainsDir)) {
    if (MIGRATION_WHITELIST.has(domain)) continue;
    const dir = join(domainsDir, domain);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      const code = stripComments(readFileSync(join(dir, f), 'utf8'));
      for (const kw of ICS_KEYWORDS) if (code.includes(kw)) violations.push(`${domain}/${f}: ${kw}`);
    }
  }
  ok(violations.length === 0, `域目录禁 ICS 关键字(违规: ${violations.join('; ') || '无'})`);

  // 反向:渲染器/治理层不得 import 任何域文件(框架不掺和业务)
  for (const frameworkFile of ['renderer.js', 'governance.js']) {
    const src = readFileSync(new URL('../src/' + frameworkFile, import.meta.url), 'utf8');
    ok(!/from\s+['"].*domains\//.test(src), `${frameworkFile} 零域依赖`);
  }
}

console.log(`\n框架层测试: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
