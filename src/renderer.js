// ============================================================================
// 🖨️ renderer.js —— ICS 渲染器(框架文件;v6 起 ICS 语法的【唯一产地】)
// ============================================================================
// 契约见 docs/EVENT-MODEL.md(唯一真相源)。本文件职责:把【事件对象】翻译成 ICS 文本。
// 域侧写作零 ICS 知识 —— 转义/折行/CRLF/DTSTART/VALARM/信封,全在这里,只在这里。
//
// 【本文件收容的 iOS 血债(历史真机实测,勿动)】
//   1. VALARM 只产【相对 TRIGGER】(带符号 duration)。绝对浮动 DATE-TIME 会被 Apple
//      误当 UTC 读、偏移 8 小时 —— 接口上不提供绝对 TRIGGER,结构性杜绝再犯。
//   2. 定点事件 DTSTART;TZID=<IANA名> 裸引用、【不携带 VTIMEZONE 块】。RFC 严格说要求
//      VTIMEZONE,但 Apple 认裸 Olson 名 —— 这是明写的依赖(决策记录见 EVENT-MODEL §7)。
//      哪天要喂非 Apple 客户端,补 VTIMEZONE 只改本文件。
//   3. 订阅日历整册 "Event Alerts" 开关盖过一切 VALARM —— 提醒不响先查手机侧,非本层 bug。
//
// 【与 v5 的字节级血缘】beforeStartTrigger / signedDurationTrigger 从原
//   src/domains/card/ics-builder.js 逐字移植(金标准全等的命门,勿"顺手优化")。

const pad2 = (n) => ('0' + n).slice(-2);
const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// 一、文本层:转义 / 探雷 / 折行
// ---------------------------------------------------------------------------

// RFC 5545 TEXT 转义。域给【原始文本】(真换行/真逗号),本函数是唯一转义点。
// 顺序敏感:反斜杠必须最先转,否则会二次转义。
export function escapeIcsText(rawText) {
  return String(rawText)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// 【探雷断言】(EVENT-MODEL §2 铁律二):v6 起域没有任何正当理由手写 ICS 转义序列。
// 原始文本里出现字面 反斜杠+n/,/; = 迁移漏网或新插件误学旧写法 → 响亮告警(不拦截)。
// (极小概率误报:正文里真有 "C:\notes" 这类路径 —— 告警而非熔断,正是为此。)
export function containsHandWrittenEscape(rawText) {
  return /\\[nN,;]/.test(String(rawText));
}

// RFC 5545 折行:每行 ≤75 字节(不含 CRLF),续行以单个空格开头(空格计入 75 预算)。
// UTF-8 安全:按码点推进,绝不劈开多字节字符(中文 3 字节 / emoji 4 字节)。
// (v5 完全不折行、Apple 也容忍 —— 折行是 v6 的正确性升级;金标准 diff 前需先 unfold 归一。)
export function foldIcsLine(line) {
  if (textEncoder.encode(line).length <= 75) return [line];
  const outputLines = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) {                       // for..of 按码点迭代,emoji 不会被劈
    const chBytes = textEncoder.encode(ch).length;
    if (currentBytes + chBytes > 75) {
      outputLines.push(current);
      current = ' ' + ch;                        // 续行前导空格,计入下一行预算
      currentBytes = 1 + chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current) outputLines.push(current);
  return outputLines;
}

// ---------------------------------------------------------------------------
// 二、TRIGGER 生成(v5 逐字移植 —— 字节级金标准命门)
// ---------------------------------------------------------------------------

// exact 形态:事件开始前 N 分钟。恒定显式负号,避免 -0 符号丢失。(原 ics-builder 原文)
export function beforeStartTrigger(minutesBefore) {
  const abs = Math.max(0, Math.round(minutesBefore));
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  let dur = 'PT';
  if (hours > 0) dur += `${hours}H`;
  if (mins > 0 || hours === 0) dur += `${mins}M`;
  return `-${dur}`;
}

// allday 形态:相对事件日午夜的时长偏移,符号恒定显式(+/-)。实测跟随设备时区,
// 出境自动对齐当地时钟。(曾试过绝对浮动 DATE-TIME,苹果误当 UTC 偏 8 小时,故用此方案。)
// (原 ics-builder 原文)
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

// ---------------------------------------------------------------------------
// 三、提醒意图 → VALARM(两种形态,见 EVENT-MODEL §3)
// ---------------------------------------------------------------------------

// 形态 1: { minutesBefore }          → 相对提前(定点事件惯用)
// 形态 2: { dayOffset, at:'HH:MM' }  → 锚定日的绝对钟点(全天事件惯用;渲染时换算成相对量)
// 两种均可带 label 覆盖缺省文案。缺省文案 = v5 原文(金标准全等,EVENT-MODEL §9 已裁决)。
function reminderToValarmLines(reminder) {
  let trigger, defaultLabel;
  if (reminder.minutesBefore != null) {
    trigger = beforeStartTrigger(reminder.minutesBefore);
    defaultLabel = reminder.minutesBefore === 0 ? '事件开始时提醒！' : `提前${reminder.minutesBefore}分钟提醒！`;
  } else if (reminder.dayOffset != null && reminder.at) {
    const [hour, minute] = reminder.at.split(':').map(Number);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    trigger = signedDurationTrigger(reminder.dayOffset * 1440 + hour * 60 + minute);
    defaultLabel = `${reminder.dayOffset === 0 ? '当天' : `第${reminder.dayOffset}天`} ${pad2(hour)}:${pad2(minute)} 提醒！`;
  } else {
    return null;                                  // 形态不合法 → 交给调用方计告警
  }
  return [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText(reminder.label != null ? reminder.label : defaultLabel)}`,
    `TRIGGER:${trigger}`,
    'END:VALARM'
  ];
}

// ---------------------------------------------------------------------------
// 四、事件对象 → VEVENT 行
// ---------------------------------------------------------------------------

const compactDate = (isoDate) => isoDate.replace(/-/g, '');   // 'YYYY-MM-DD' → 'YYYYMMDD'

function nextDayOf(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

// 属性次序(v6 规范序):UID → DTSTAMP → SUMMARY → URL? → DESCRIPTION? → 时间轴 → VALARM*。
// (v5 两域次序本就不一致;iOS 不在乎次序 —— 金标准 diff 按"属性集合"归一后比对。)
// 返回 { lines, warnings }:warnings 是给诊断事件的原始文本告警(探雷/形态不合法),不熔断。
export function renderEventObject(event, { dtStamp, defaultTimezone }) {
  const warnings = [];
  const lines = ['BEGIN:VEVENT', `UID:${event.uid}@mycal.local`, `DTSTAMP:${dtStamp}`];

  for (const [fieldName, raw] of [['summary', event.summary], ['description', event.description]]) {
    if (raw != null && containsHandWrittenEscape(raw)) {
      warnings.push(`⚠️ 事件 ${event.uid} 的 ${fieldName} 含手写转义序列(\\n 等)—— v6 起域应交真实换行,疑似迁移漏网`);
    }
  }

  lines.push(`SUMMARY:${escapeIcsText(event.summary != null ? event.summary : '')}`);
  if (event.url) lines.push(`URL:${event.url}`);                 // URI 值类型,不做 TEXT 转义
  if (event.description != null) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);

  if (event.allDay) {
    lines.push(
      `DTSTART;VALUE=DATE:${compactDate(event.date)}`,
      `DTEND;VALUE=DATE:${compactDate(event.endDate || nextDayOf(event.date))}`   // endDate 排他
    );
  } else {
    const tz = event.tz || defaultTimezone;                      // 铁律一:换算/标注归框架,域给墙上时间
    lines.push(
      `DTSTART;TZID=${tz}:${compactDate(event.date)}T${event.time.replace(':', '')}00`,
      `DURATION:PT${event.durationMinutes}M`
    );
  }

  for (const reminder of (event.reminders || [])) {
    const valarm = reminderToValarmLines(reminder);
    if (valarm) lines.push(...valarm);
    else warnings.push(`⚠️ 事件 ${event.uid} 的一条提醒意图形态不合法(既非 minutesBefore 也非 dayOffset+at),已跳过`);
  }

  lines.push('END:VEVENT');
  return { lines, warnings };
}

// ---------------------------------------------------------------------------
// 五、整册信封(VCALENDAR 包装 + 统一折行 + CRLF 落盘)
// ---------------------------------------------------------------------------

export function makeDtStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// eventLineChunks: 若干组 VEVENT 行(含诊断/哨兵事件 —— 它们也是普通事件对象渲染而来,
// 不再有第二套手拼路径)。折行在此统一施加,是全文档唯一折行点。
export function renderCalendarDocument({ calendarName, timezone, color }, eventLineChunks) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//calendar-api//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${calendarName}`, `X-WR-TIMEZONE:${timezone}`, `X-APPLE-CALENDAR-COLOR:${color}`
  ];
  for (const chunk of eventLineChunks) lines.push(...chunk);
  lines.push('END:VCALENDAR');
  return lines.flatMap(foldIcsLine).join('\r\n');
}
