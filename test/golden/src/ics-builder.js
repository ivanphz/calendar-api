// ==========================================
// 📅 ics-builder.js —— iCalendar 生成 (标题分层 + 合并 + 闹钟)
// ==========================================
import { CURRENCY_SYMBOLS } from './config.js';

const pad2 = (n) => ('0' + n).slice(-2);

// -------- 闹钟 TRIGGER 生成 (沿用重构前已在真机验证过的写法) --------

// exact 模式：事件开始前 N 分钟。恒定显式负号，避免 -0 符号丢失。
export function beforeStartTrigger(minutesBefore) {
  const abs = Math.max(0, Math.round(minutesBefore));
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  let dur = 'PT';
  if (hours > 0) dur += `${hours}H`;
  if (mins > 0 || hours === 0) dur += `${mins}M`;
  return `-${dur}`;
}

// allday 模式：相对提醒日午夜的时长偏移，符号恒定显式(+/-)。实测跟随设备时区，出境自动对齐当地时钟。
// (曾试过绝对浮动 DATE-TIME，苹果会误当 UTC 导致偏移8小时，故用此方案。)
export function signedDurationTrigger(totalMinutes) {
  const isNegative = totalMinutes < 0;
  const abs = Math.round(Math.abs(totalMinutes));
  const days = Math.floor(abs / 1440);
  const remain = abs - days * 1440;
  const hours = Math.floor(remain / 60);
  const mins = remain % 60;
  let dur = 'P';
  if (days > 0) dur += `${days}D`;
  if (hours > 0 || mins > 0 || days === 0) {
    dur += 'T';
    if (hours > 0) dur += `${hours}H`;
    if (mins > 0 || hours === 0) dur += `${mins}M`;
  }
  return (isNegative ? '-' : '+') + dur;
}

// -------- 主键 accountId 自动生成 --------
// 组合 country + bankShortName + cardName + repayCurrency + last4，过滤特殊字符。
// last4 留空(合并账单)时靠前几段仍唯一；Pulse 双账单靠 repayCurrency 区分。
export function makeAccountId(acct) {
  const raw = [acct.country, acct.bankShortName, acct.cardName, acct.repayCurrency, acct.last4 || 'NA']
    .join('-')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5\-]/g, '');
  return raw;
}

function currencyLabel(code) {
  const sym = CURRENCY_SYMBOLS[code] || code;
  return `${sym}${code}`;
}

// -------- 单账单事件正文(审计明细) --------
function buildDescription(item) {
  const a = item.account;
  const au = item.audit;
  const lines = [
    '【系统推算审计明细】',
    `🏦 ${a.bankFullName}${a.cardName ? ' · ' + a.cardName : ''}`,
    `🌍 所属地区: ${a.countryLabel}`,
    `💰 还款币种: ${currencyLabel(a.repayCurrency)}`
  ];
  if (a.last4) lines.push(`💳 卡号/账户末四位: ${a.last4}`);
  if (a.needsFxPurchase) lines.push(`💱 购汇提示: ${a.fxNote || '需先购汇再还入'}`);
  lines.push(`📅 假期日历: ${(a.holidayCalendars || ['CN']).join(' + ')}`);
  lines.push(`📌 名义还款日: ${au.nominalStr}`);
  lines.push(`🧾 推算依据: ${au.modelNote}`);
  lines.push(`🛠 基础提前量: ${au.baseAdvanceDays} 个工作日`);
  if (au.holidayCompensation > 0) {
    lines.push(`⚠️ 节假日补偿: +${au.holidayCompensation} 个工作日 (名义日恰逢休息)`);
  }
  lines.push(`⏳ 实际倒推: 向前跨越 ${au.scannedNaturalDays} 个自然日`);
  if (au.skippedOffDays > 0) lines.push(`🛑 期间跳过休息日: ${au.skippedOffDays} 天`);
  lines.push(`🎯 最终提醒日: ${au.finalStr}`);
  return lines.join('\\n');
}

// -------- 标题分层 --------
// 单账单标题：前缀 · 🇭🇰HSBC-HK(Pulse) HKD 还款
function buildSingleTitle(item, prefix) {
  const a = item.account;
  const cur = CURRENCY_SYMBOLS[a.repayCurrency] || a.repayCurrency;
  return `${prefix} · ${a.emoji}${a.bankShortName}(${a.cardName}) ${cur} 还款`;
}

// 合并标题：按规则分层
//   - 2 笔同国同行同产品无法区分时用币种；产品不同用 (A+B)
//   - 不同银行数 <= maxDistinctBanksInTitle: 展示 银行(产品聚合)，用 + 连接
//   - 不同银行数 > maxDistinctBanksInTitle: 降级为纯国家聚合 🇨🇳×2 🇭🇰×3
function buildMergedTitle(items, prefix, cfg) {
  const count = items.length;

  // 统计不同银行(按 emoji+bankShortName 区分同国同行)
  const bankKey = (a) => `${a.emoji}${a.bankShortName}`;
  const distinctBanks = [...new Set(items.map(it => bankKey(it.account)))];

  let body;
  if (distinctBanks.length > (cfg.maxDistinctBanksInTitle || 2)) {
    // 降级：纯国家聚合，例 🇨🇳×2 🇭🇰×3
    const countryCount = {};
    items.forEach(it => {
      const k = `${it.account.emoji}`;
      countryCount[k] = (countryCount[k] || 0) + 1;
    });
    body = Object.entries(countryCount).map(([emoji, n]) => `${emoji}×${n}`).join(' ');
  } else {
    // 按银行分段，每段把该行的产品名用 + 聚合，例 🇭🇰HSBC-HK(Pulse+Red)
    const segments = distinctBanks.map(bk => {
      const group = items.filter(it => bankKey(it.account) === bk);
      const a0 = group[0].account;
      const products = [...new Set(group.map(it => it.account.cardName))];
      // 若同产品多笔(如 Pulse 港币+人民币)，用币种区分而非产品名
      let inner;
      if (products.length === 1 && group.length > 1) {
        inner = group.map(it => CURRENCY_SYMBOLS[it.account.repayCurrency] || it.account.repayCurrency).join('+');
      } else {
        inner = products.join('+');
      }
      return `${a0.emoji}${a0.bankShortName}(${inner})`;
    });
    const shown = segments.slice(0, cfg.mergeTitleShowCount || 2).join(' ');
    const suffix = segments.length > (cfg.mergeTitleShowCount || 2) ? ` 等${segments.length}笔` : '';
    body = shown + suffix;
  }
  return `${prefix} · ${count}笔 · ${body}`;
}

// -------- 时间轴 + 闹钟行 (exact / allday) --------
function buildTimingLines(cfg, mode) {
  const lines = [];
  if (mode === 'exact') {
    const timeStr = `${pad2(cfg.targetChinaHour)}${pad2(cfg.targetChinaMinute)}00`;
    lines.push(`DURATION:PT${cfg.exactDurationMin}M`);
    return { prefixLines: [`DTSTART;TZID=Asia/Shanghai:{START}T${timeStr}`], durationLines: lines, alarms: cfg.exAlarms, kind: 'exact' };
  }
  return { prefixLines: [`DTSTART;VALUE=DATE:{START}`, `DTEND;VALUE=DATE:{END}`], durationLines: [], alarms: cfg.adAlarms, kind: 'allday' };
}

function pushTiming(ics, startStr, endStr, cfg, mode) {
  if (mode === 'exact') {
    const timeStr = `${pad2(cfg.targetChinaHour)}${pad2(cfg.targetChinaMinute)}00`;
    ics.push(`DTSTART;TZID=Asia/Shanghai:${startStr}T${timeStr}`, `DURATION:PT${cfg.exactDurationMin}M`);
    for (const al of cfg.exAlarms) {
      const trig = beforeStartTrigger(al.minutesBefore);
      const label = al.minutesBefore === 0 ? '事件开始时提醒！' : `提前${al.minutesBefore}分钟提醒！`;
      ics.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${label}`, `TRIGGER:${trig}`, 'END:VALARM');
    }
  } else {
    ics.push(`DTSTART;VALUE=DATE:${startStr}`, `DTEND;VALUE=DATE:${endStr}`);
    for (const al of cfg.adAlarms) {
      const total = al.dayOffset * 1440 + al.hour * 60 + al.minute;
      const trig = signedDurationTrigger(total);
      const label = `${al.dayOffset === 0 ? '当天' : `第${al.dayOffset}天`} ${pad2(al.hour)}:${pad2(al.minute)} 提醒！`;
      ics.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${label}`, `TRIGGER:${trig}`, 'END:VALARM');
    }
  }
}

function endDateStrOf(startStr) {
  const y = +startStr.slice(0, 4), m = +startStr.slice(4, 6), d = +startStr.slice(6, 8);
  const nd = new Date(y, m - 1, d);
  nd.setDate(nd.getDate() + 1);
  return `${nd.getFullYear()}${pad2(nd.getMonth() + 1)}${pad2(nd.getDate())}`;
}

// -------- 对外主函数：把推算结果列表构建成完整 ics 字符串 --------
export function buildCalendar(items, cfg, mode, mergeSameDay, dtStamp, debugEventLines) {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//My Repayment Cal//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${cfg.calendarName}`, 'X-WR-TIMEZONE:Asia/Shanghai', 'X-APPLE-CALENDAR-COLOR:#FF3B30'
  ];
  if (debugEventLines) ics.push(...debugEventLines);

  const pushSingle = (item) => {
    const a = item.account;
    const uid = `repay-${item.calcYear}-${item.calcMonth0}-${makeAccountId(a)}-${item.startDateStr}@mycal.local`;
    ics.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtStamp}`,
      `SUMMARY:${buildSingleTitle(item, cfg.titlePrefix)}`, `DESCRIPTION:${buildDescription(item)}`);
    pushTiming(ics, item.startDateStr, endDateStrOf(item.startDateStr), cfg, mode);
    ics.push('END:VEVENT');
  };

  const pushMerged = (group) => {
    const startStr = group[0].startDateStr;
    const uid = `repay-merged-${startStr}@mycal.local`;
    const blocks = group.map(it => buildDescription(it));
    const description = [`【合并提醒】当日共 ${group.length} 笔账单需处理`, ...blocks].join('\\n\\n────────\\n\\n');
    ics.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtStamp}`,
      `SUMMARY:${buildMergedTitle(group, cfg.titlePrefix, cfg)}`, `DESCRIPTION:${description}`);
    pushTiming(ics, startStr, endDateStrOf(startStr), cfg, mode);
    ics.push('END:VEVENT');
  };

  if (!mergeSameDay) {
    items.forEach(pushSingle);
  } else {
    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.startDateStr)) groups.set(it.startDateStr, []);
      groups.get(it.startDateStr).push(it);
    }
    for (const g of groups.values()) {
      if (g.length === 1) pushSingle(g[0]);
      else pushMerged(g);
    }
  }

  ics.push('END:VCALENDAR');
  return ics.join('\r\n');
}
