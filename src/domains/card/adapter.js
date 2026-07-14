// ============================================================================
// 🔌 domains/card/adapter.js —— 信用卡域适配层(框架文件，业务逻辑零改动)
// ============================================================================
// 职责边界(严格)：
//   · 参数解析 + 逐账户推算编排：从原 worker-entry.js 【逐行搬运】。
//   · ICS 事件(本体)：直接调用原版 ics-builder.buildCalendar，抽取 VEVENT 段。
//     标题分层/同日合并/allday闹钟/审计正文…全出自原文件，本层不碰。
//   · 闹钟网关(附加输出)：按 config/card.js 里 CARD_ALARM.alarmMode 产出；绝不反向影响日历。
//   · Debug 报告：原版正文原样 + 生效参数说明。
//
// 信用卡 URL 参数【全部本域解析】(与原项目一致)：
//   ?mode=exact|allday  ?merge=1|0  ?past=3  ?future=12  ?durationMin=360
//   ?allDayReminders=-1:20:00,0:09:30   ?exactReminders=1,60   ?mergeTitleShowCount=2
//   (?adAlarms= / ?exAlarms= 为 v5.2 前旧名,仍兼容)
//   ?ch=9 ?cm=30 (响铃时刻)      ?cardAlarm=merged|each|off (仅影响 JSON)
// 中枢级视图过滤(?tags= ?excludeTags=)经 filters 传入，对账户的 tags 字段生效。

import { ACCOUNTS, DEFAULT_CONFIG, CURRENCY_SYMBOLS, CARD_ALARM } from './config.js';
import { computeReminder, computeReminderForDate } from './repay-engine.js';
import { buildCalendar, makeAccountId } from './ics-builder.js';
import { getLatestStatement, listRecentFailures } from './storage.js';

const pad2 = (n) => ('0' + n).slice(-2);

// ---- 参数解析辅助 ----
function parseAllDayReminders(str, fallback) {
  try {
    const e = str.split(',').map(seg => {
      const [d, hh, mm] = seg.split(':');
      const o = { dayOffset: parseInt(d), hour: parseInt(hh), minute: parseInt(mm) };
      if ([o.dayOffset, o.hour, o.minute].some(Number.isNaN)) throw 0;
      return o;
    });
    return e.length ? e : fallback;
  } catch { return fallback; }
}
function parseExactReminders(str, fallback) {
  try {
    const e = str.split(',').map(s => {
      const n = parseInt(s.trim());
      if (Number.isNaN(n)) throw 0;
      return { minutesBefore: n };
    });
    return e.length ? e : fallback;
  } catch { return fallback; }
}

// 网关 uid 用：主键压成纯 ASCII(去中文等)，连字符保留、去重
const asciiId = (acct) => makeAccountId(acct).replace(/[^\x20-\x7E]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

const hitTags = (item, filters) => {
  const t = item.tags || [];
  if (filters.tags.length && !filters.tags.some(x => t.includes(x))) return false;
  if (filters.excludeTags.length && filters.excludeTags.some(x => t.includes(x))) return false;
  return true;
};

export const cardDomain = {
  id: 'card',
  calName: DEFAULT_CONFIG.calendarName,   // '💳 信用卡还款提醒'
  defaultColor: '#FF3B30',                // 原 ics-builder 整册色

  // —— 阶段一：解析本域参数 + 视图过滤，报出假期需求 ——
  prepare(q, baseDateObj, filters) {
    // ---- 参数解析(原 worker-entry 原样；默认值来自 config/card.js) ----
    const cfg = { ...DEFAULT_CONFIG };
    const pastMonths = q.has('past') ? parseInt(q.get('past')) : cfg.pastMonths;
    const futureMonths = q.has('future') ? parseInt(q.get('future')) : cfg.futureMonths;
    const mode = q.get('mode') || cfg.displayMode;
    const mergeSameDay = q.has('merge') ? ['1', 'true', 'yes'].includes(q.get('merge').toLowerCase()) : cfg.mergeSameDay;
    if (q.has('mergeTitleShowCount')) cfg.mergeTitleShowCount = parseInt(q.get('mergeTitleShowCount'));
    if (q.has('durationMin')) cfg.exactDurationMin = parseInt(q.get('durationMin'));
    // 日历提醒(VALARM):新参数名 ?allDayReminders= / ?exactReminders=;
    // 兼容旧名 ?adAlarms= / ?exAlarms=(v5.2 前的名字,保留别名防止旧链接失效)。
    const adReminderRaw = q.get('allDayReminders') ?? q.get('adAlarms');
    if (adReminderRaw != null) cfg.allDayReminders = parseAllDayReminders(adReminderRaw, cfg.allDayReminders);
    const exReminderRaw = q.get('exactReminders') ?? q.get('exAlarms');
    if (exReminderRaw != null) cfg.exactReminders = parseExactReminders(exReminderRaw, cfg.exactReminders);
    if (q.has('ch')) cfg.targetChinaHour = parseInt(q.get('ch'));
    if (q.has('cm')) cfg.targetChinaMinute = parseInt(q.get('cm'));

    // 闹钟模式(仅 JSON；默认来自 config/card.js 的 CARD_ALARM)
    const alarmMode = (q.get('cardAlarm') || CARD_ALARM.alarmMode || 'merged').toLowerCase();

    // ---- 活跃账户(原样) + 视图标签过滤 ----
    const accounts = ACCOUNTS.filter(a => a.isActive).filter(a => hitTags(a, filters));

    // ---- 需要哪些国家 + 覆盖哪些年份(原样，基于北京基准日) ----
    const neededCountries = [...new Set(accounts.flatMap(a => a.holidayCalendars || ['CN']))];
    const yearsSet = new Set();
    for (let i = -1; i <= pastMonths + futureMonths + 1; i++) {
      const m = baseDateObj.getMonth() - pastMonths + i;
      yearsSet.add(baseDateObj.getFullYear() + Math.floor(m / 12));
    }

    return {
      countries: neededCountries,
      years: [...yearsSet],
      state: { cfg, pastMonths, futureMonths, mode, mergeSameDay, alarmMode, accounts, baseDateObj }
    };
  },

  // —— 阶段二：原版编排 → VEVENT(本体) + 闹钟(附加) + Debug 段 ——
  async build(state, env, hub, dtStamp, beijingTimeStr) {
    const { cfg, pastMonths, futureMonths, mode, mergeSameDay, alarmMode, accounts, baseDateObj } = state;
    const startYear = baseDateObj.getFullYear();
    const startMonth = baseDateObj.getMonth() - pastMonths;

    // ---- 逐账户推算(原 worker-entry 原样) ----
    // legacy/cycle: 按月循环推算。email: 只读 KV 里"最近一期实测记录"，不外推不猜未来。
    const items = [];
    const emailModelNotes = [];
    const monthlyAccounts = accounts.filter(a => a.model !== 'email');
    const emailAccounts = accounts.filter(a => a.model === 'email');

    for (let i = 0; i <= pastMonths + futureMonths; i++) {
      let cm = startMonth + i, cy = startYear;
      while (cm > 11) { cm -= 12; cy++; }
      while (cm < 0) { cm += 12; cy--; }
      for (const acct of monthlyAccounts) {
        const isWorkday = hub.makeWorkdayChecker(acct.holidayCalendars);
        items.push(computeReminder(acct, cy, cm, isWorkday, cfg.holidayExtraAdvance));
      }
    }

    for (const acct of emailAccounts) {
      const accountId = makeAccountId(acct);
      const rec = await getLatestStatement(env, accountId);
      if (!rec || !rec.dueDateStr) {
        emailModelNotes.push(`- ${acct.emoji}${acct.bankShortName}(${acct.cardName}) ${acct.repayCurrency}: 等待首封账单邮件，暂无事件`);
        continue;
      }
      const [y, m, d] = rec.dueDateStr.split('-').map(Number);
      const dueDate = new Date(y, m - 1, d, 12, 0, 0);
      const isWorkday = hub.makeWorkdayChecker(acct.holidayCalendars);
      const modelNote = `邮件实测(L${rec.layer}): ${rec.layerNote || ''}${rec.sourceRef ? ' [Ref ' + rec.sourceRef + ']' : ''}`;
      items.push(computeReminderForDate(acct, dueDate, isWorkday, cfg.holidayExtraAdvance, modelNote));
      emailModelNotes.push(`- ${acct.emoji}${acct.bankShortName}(${acct.cardName}) ${acct.repayCurrency}: 本期还款日 ${rec.dueDateStr} (L${rec.layer})`);
    }

    // 解析失败报警(email 功能未启用/KV 未绑定时自然为空)
    const failures = await listRecentFailures(env, 3);

    // ---- ①日历本体：调用原版 buildCalendar，抽取 VEVENT 段(事件内容零改动) ----
    const fullIcs = buildCalendar(items, cfg, mode, mergeSameDay, dtStamp, null);
    const lines = fullIcs.split('\r\n');
    const first = lines.indexOf('BEGIN:VEVENT');
    const last = lines.lastIndexOf('END:VEVENT');
    const eventLines = first === -1 ? [] : lines.slice(first, last + 1);

    // ---- ②附加输出：闹钟网关条目(读 items，绝不写回；对日历零影响) ----
    const alarms = buildGatewayAlarms(items, cfg, alarmMode);

    // ---- ③Debug 报告段(原版正文原样 + 生效参数说明) ----
    const acctLog = accounts.map(a =>
      `- ${a.emoji}${a.bankShortName}(${a.cardName}) ${a.repayCurrency} [${a.model}]${a.tags ? ' tags:' + a.tags.join('/') : ''}${a.remind === false ? ' 闹钟:关' : ''} 假期:${(a.holidayCalendars || ['CN']).join('+')}`
    ).join('\\n');
    const debugLines = [
      `【💳 信用卡域】`,
      `运行时间: ${beijingTimeStr} (北京时间)`,
      `显示模式: ${mode} | 同日合并: ${mergeSameDay ? '是' : '否'} (默认值在 config/card.js，URL 可临时覆盖)`,
      `生成跨度: 过去 ${pastMonths} 月 -> 未来 ${futureMonths} 月`,
      `闹钟网关: ${alarmMode === 'off' ? '关闭(仅日历)' : alarmMode === 'each' ? '每笔一条' : '同日合并为一条'} @ ${pad2(cfg.targetChinaHour)}:${pad2(cfg.targetChinaMinute)} (默认在 config/card.js 的 CARD_ALARM，?cardAlarm= 可覆盖)`,
      '',
      `【活跃账户 ${accounts.length} 个】`, acctLog,
      ...(emailModelNotes.length ? ['', '【email 模型状态】', ...emailModelNotes] : []),
      ...(failures.length ? ['', `【⚠️ 邮件解析报警: 最近 ${failures.length} 条失败】`, ...failures.map(f => `- ${f.at} ${f.reason}`)] : [])
    ];

    return { eventLines, alarms, debugLines };
  }
};

// ============================================================================
// 闹钟网关构建(附加输出层)。uid 遵守协议 v1：无时钟时间。
//   each   → card-<账户ASCII主键>-<账单月YYYYMM>  (账单月锚定：改 advanceDays/假期漂移都不抖)
//   merged → card-day-<响铃日YYYYMMDD>           (身份=“这一天的还款集合”，日粒度 bucket 合规)
// 账户级豁免：remind:false 的账户在两种模式下都不产生闹钟(日历不受影响)。
// ============================================================================
function buildGatewayAlarms(items, cfg, alarmMode) {
  if (alarmMode === 'off') return [];
  const eligible = items.filter(it => it.account.remind !== false);
  const time = `${pad2(cfg.targetChinaHour)}:${pad2(cfg.targetChinaMinute)}`;
  const dateOf = (it) => `${it.startDateStr.slice(0, 4)}-${it.startDateStr.slice(4, 6)}-${it.startDateStr.slice(6, 8)}`;
  const brief = (a) => `${a.emoji}${a.bankShortName}(${a.cardName}) ${CURRENCY_SYMBOLS[a.repayCurrency] || a.repayCurrency}`;

  if (alarmMode === 'each') {
    return eligible.map((it) => ({
      uid: `card-${asciiId(it.account)}-${it.calcYear}${pad2(it.calcMonth0 + 1)}`,
      date: dateOf(it), time,
      reason: `💳 ${brief(it.account)} 还款`
    }));
  }

  // merged(默认)：按响铃日聚合，一天一条
  const groups = new Map();
  for (const it of eligible) {
    if (!groups.has(it.startDateStr)) groups.set(it.startDateStr, []);
    groups.get(it.startDateStr).push(it);
  }
  const out = [];
  for (const [dayStr, group] of groups) {
    const reason = group.length === 1
      ? `💳 ${brief(group[0].account)} 还款`
      : `💳 ${group.length}笔还款: ${group.map((it) => brief(it.account)).join(' + ')}`;
    out.push({ uid: `card-day-${dayStr}`, date: dateOf(group[0]), time, reason });
  }
  return out;
}
