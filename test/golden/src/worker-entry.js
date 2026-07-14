// ==========================================
// 🚀 worker-entry.js —— Cloudflare Worker 入口
// ==========================================
// 职责：解析 URL 参数 -> 组装账户 -> 加载多国假期 -> 逐账户逐月推算 -> 生成 ics -> 返回。
// 具体业务逻辑都在各模块里，这里只做编排。
//
// URL 参数(可选，均可覆盖 config.js 默认)：
//   ?mode=allday|exact         显示模式
//   ?merge=1                   合并同日多笔账单
//   ?past=3 ?future=12         生成跨度(月)
//   ?adAlarms=-1:20:00,0:09:30 allday 闹钟
//   ?exAlarms=1,60             exact 闹钟(提前分钟数)
//   ?mergeTitleShowCount=2     合并标题展示段数
//   ?durationMin=360           exact 事件时长

import { ACCOUNTS, DEFAULT_CONFIG } from './config.js';
import { createHolidayHub } from './holidays/index.js';
import { computeReminder, computeReminderForDate } from './repay-engine.js';
import { buildCalendar, makeAccountId } from './ics-builder.js';
import { handleIncomingEmail } from './email-handler.js';
import { getLatestStatement, listRecentFailures } from './storage.js';

const pad2 = (n) => ('0' + n).slice(-2);

function parseAdAlarms(str, fallback) {
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
function parseExAlarms(str, fallback) {
  try {
    const e = str.split(',').map(s => {
      const n = parseInt(s.trim());
      if (Number.isNaN(n)) throw 0;
      return { minutesBefore: n };
    });
    return e.length ? e : fallback;
  } catch { return fallback; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const q = url.searchParams;

    // ---- 参数解析 ----
    const cfg = { ...DEFAULT_CONFIG };
    const pastMonths = q.has('past') ? parseInt(q.get('past')) : cfg.pastMonths;
    const futureMonths = q.has('future') ? parseInt(q.get('future')) : cfg.futureMonths;
    const mode = q.get('mode') || cfg.displayMode;
    const mergeSameDay = q.has('merge') ? ['1', 'true', 'yes'].includes(q.get('merge').toLowerCase()) : cfg.mergeSameDay;
    if (q.has('mergeTitleShowCount')) cfg.mergeTitleShowCount = parseInt(q.get('mergeTitleShowCount'));
    if (q.has('durationMin')) cfg.exactDurationMin = parseInt(q.get('durationMin'));
    if (q.has('ch')) cfg.targetChinaHour = parseInt(q.get('ch'));
    if (q.has('cm')) cfg.targetChinaMinute = parseInt(q.get('cm'));
    if (q.has('adAlarms')) cfg.adAlarms = parseAdAlarms(q.get('adAlarms'), cfg.adAlarms);
    if (q.has('exAlarms')) cfg.exAlarms = parseExAlarms(q.get('exAlarms'), cfg.exAlarms);

    // ---- 基准时间(北京时区，避开 UTC 跨日) ----
    const realNow = new Date();
    const beijingTimeStr = realNow.toLocaleString('zh-CN', { timeZone: cfg.baseTimezone, hour12: false });
    const beijingDateObj = new Date(realNow.toLocaleString('en-US', { timeZone: cfg.baseTimezone }));
    const startYear = beijingDateObj.getFullYear();
    const startMonth = beijingDateObj.getMonth() - pastMonths;

    // ---- 活跃账户 ----
    const accounts = ACCOUNTS.filter(a => a.isActive);

    // ---- 需要哪些国家的假期 + 覆盖哪些年份 ----
    const neededCountries = [...new Set(accounts.flatMap(a => a.holidayCalendars || ['CN']))];
    const yearsSet = new Set();
    for (let i = -1; i <= pastMonths + futureMonths + 1; i++) {
      const m = beijingDateObj.getMonth() - pastMonths + i;
      yearsSet.add(beijingDateObj.getFullYear() + Math.floor(m / 12));
    }
    const years = [...yearsSet];

    // ---- 加载假期，构建判断器 ----
    const hub = await createHolidayHub(neededCountries, years);

    // ---- 逐账户推算 ----
    // legacy/cycle: 按月循环推算(可预测的模型，能生成未来所有月份)。
    // email: 选Y方案 —— 只读 KV 里"最近一期实测记录"，生成这一期的精确提醒，不外推不猜未来。
    const items = [];
    const emailModelNotes = []; // email 账户的状态，进 Debug 报告

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

    // ---- Debug 诊断事件 ----
    const dtStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const debugStart = `${beijingDateObj.getFullYear()}${pad2(beijingDateObj.getMonth() + 1)}${pad2(beijingDateObj.getDate())}`;
    const debugEndObj = new Date(beijingDateObj); debugEndObj.setDate(debugEndObj.getDate() + 1);
    const debugEnd = `${debugEndObj.getFullYear()}${pad2(debugEndObj.getMonth() + 1)}${pad2(debugEndObj.getDate())}`;
    const acctLog = accounts.map(a =>
      `- ${a.emoji}${a.bankShortName}(${a.cardName}) ${a.repayCurrency} [${a.model}] 假期:${(a.holidayCalendars || ['CN']).join('+')}`
    ).join('\\n');
    const debugDesc = [
      '>>> 日历引擎诊断报告 <<<', '',
      `运行时间: ${beijingTimeStr} (北京时间)`,
      `显示模式: ${mode} | 合并: ${mergeSameDay ? '是' : '否'}`,
      `生成跨度: 过去 ${pastMonths} 月 -> 未来 ${futureMonths} 月`, '',
      `【活跃账户 ${accounts.length} 个】`, acctLog, '',
      ...(emailModelNotes.length ? ['【email 模型状态】', ...emailModelNotes, ''] : []),
      ...(failures.length ? [`【⚠️ 邮件解析报警: 最近 ${failures.length} 条失败】`, ...failures.map(f => `- ${f.at} ${f.reason}`), ''] : []),
      '【假期数据源状态】', ...hub.loadLogs.map(l => '  ' + l)
    ].join('\\n');
    const debugEventLines = [
      'BEGIN:VEVENT', `UID:debug-log-${dtStamp}@mycal.local`, `DTSTAMP:${dtStamp}`,
      'SUMMARY:⚙️ 日历引擎诊断报告 (Debug)', `DESCRIPTION:${debugDesc}`,
      `DTSTART;VALUE=DATE:${debugStart}`, `DTEND;VALUE=DATE:${debugEnd}`, 'END:VEVENT'
    ];

    // ---- 构建 ics ----
    const icsText = buildCalendar(items, cfg, mode, mergeSameDay, dtStamp, debugEventLines);

    return new Response(icsText, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="repayment_cal.ics"',
        'Access-Control-Allow-Origin': '*'
      }
    });
  },

  // Cloudflare Email Routing 入口: 在后台把收件地址路由到本 Worker 后，来信自动触发这里。
  // 收件地址本身是保密的(存在 EXPECTED_RECIPIENT Secret 里)，不出现在任何代码/仓库中。
  async email(message, env, ctx) {
    await handleIncomingEmail(message, env);
  }
};
