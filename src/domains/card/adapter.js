// ============================================================================
// 🔌 domains/card/adapter.js —— 信用卡域适配层(框架文件，业务逻辑零改动)
// ============================================================================
// 职责边界(严格)：
//   · 参数解析 + 逐账户推算编排：从原 worker-entry.js 【逐行搬运】。
//   · 日历本体：调用 event-builder.buildCardEvents 产【事件对象】。
//     标题分层/同日合并/审计正文…全出自原文件，本层不碰。
//   · 闹钟网关(附加输出)：按 config/card.js 里 CARD_ALARM.alarmMode 产出；绝不反向影响日历。
//   · Debug 报告：原版正文原样 + 生效参数说明。
//
// 【v6 手术 A 变更】
//   · contract: 2 —— 交事件对象,不再交 ICS 文本。env 改从 ctx.env 取(见 registry 契约)。原来那段
//     `fullIcs.split('\r\n')` + `indexOf('BEGIN:VEVENT')` 切片 hack 就此消亡
//     (自己产完整 ICS 再把 VEVENT 抠出来 —— 那是契约错位的病灶)。
//   · ?past= / ?future= 【不再本域解析】:已升格为中枢参数(config/hub.js 持缺省),
//     本域按 window 姿态 MAP 成账单月循环边界。
//   · years 不再自报:窗口归中枢后由中枢从裁剪窗推导。
//   · hitTags 本地实现删除,改用中枢 ctx.matchesTags(v5 里两个域各抄了一份逐字相同的)。
//
// 信用卡 URL 参数【全部本域解析】(与原项目一致)：
//   ?mode=exact|allday  ?merge=1|0  ?durationMin=360
//   ?allDayReminders=-1:20:00,0:09:30   ?exactReminders=1,60   ?mergeTitleShowCount=2
//   (?adAlarms= / ?exAlarms= 旧名【已删除】,写了会在诊断响亮告警 —— 见下)
//   ?ch=9 ?cm=30 (响铃时刻)      ?cardAlarm=merged|each|off (仅影响 JSON)
// 中枢级参数(?past= ?future= ?tags= ?excludeTags=)经 ctx 传入。

import { ACCOUNTS, DEFAULT_CONFIG, CURRENCY_SYMBOLS, CARD_ALARM } from './config.js';
import { computeReminder, computeReminderForDate } from './repay-engine.js';
import { buildCardEvents, accountKey } from './event-builder.js';
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

// 中枢绝对日期窗 → 本域语义(账单月循环边界)。MAP 的全部内容就是这一个函数。
// 本域按【账单月】推算,故窗口两端各取其所在月:from 的月 → to 的月,逐月循环。
// (v5 是 baseDate.getMonth() - pastMonths 起、循环 past+future+1 次;窗口月对齐后完全等价。)
function mapWindowToMonths(window) {
  const [fy, fm] = window.from.split('-').map(Number);
  const [ty, tm] = window.to.split('-').map(Number);
  return {
    startYear: fy, startMonth0: fm - 1,
    monthCount: (ty * 12 + (tm - 1)) - (fy * 12 + (fm - 1)) + 1
  };
}

export const cardDomain = {
  id: 'card',
  contract: 2,             // v6 契约:prepare(q,ctx)→{countries,state};build→{events,alarms,debugLines}
  window: 'MAP',           // 治理姿态:把中枢绝对日期窗映射成账单月循环边界(见 mapWindowToMonths)
  calName: DEFAULT_CONFIG.calendarName,   // '💳 信用卡还款提醒'
  defaultColor: '#FF3B30',                // 原整册色

  // —— 阶段一：解析本域参数 + 视图过滤，报出假期需求 ——
  prepare(q, ctx) {
    // ---- 参数解析(原 worker-entry 原样；默认值来自 config/card.js) ----
    const cfg = { ...DEFAULT_CONFIG };
    const mode = q.get('mode') || cfg.displayMode;
    const mergeSameDay = q.has('merge') ? ['1', 'true', 'yes'].includes(q.get('merge').toLowerCase()) : cfg.mergeSameDay;
    if (q.has('mergeTitleShowCount')) cfg.mergeTitleShowCount = parseInt(q.get('mergeTitleShowCount'));
    if (q.has('durationMin')) cfg.exactDurationMin = parseInt(q.get('durationMin'));
    // 日历提醒(VALARM):?allDayReminders= / ?exactReminders=
    // 【手术 B】v5.2 前的旧名 ?adAlarms= / ?exAlarms= 【已删除】。
    //   为什么不静默忽略:旧链接会"看起来正常"却悄悄拿到默认提醒(你设的 -1:20:00 没了,
    //   而日历照常显示 —— 最坏的那种失败:不报错、只是提醒时间悄悄变了)。
    //   故:检出即在诊断响亮告警(与中枢 ?months= 同一套路),你看得见才改得掉。
    const legacyReminderParams = ['adAlarms', 'exAlarms'].filter(k => q.has(k));
    if (q.has('allDayReminders')) cfg.allDayReminders = parseAllDayReminders(q.get('allDayReminders'), cfg.allDayReminders);
    if (q.has('exactReminders')) cfg.exactReminders = parseExactReminders(q.get('exactReminders'), cfg.exactReminders);
    if (q.has('ch')) cfg.targetChinaHour = parseInt(q.get('ch'));
    if (q.has('cm')) cfg.targetChinaMinute = parseInt(q.get('cm'));

    // 闹钟模式(仅 JSON；默认来自 config/card.js 的 CARD_ALARM)
    const alarmMode = (q.get('cardAlarm') || CARD_ALARM.alarmMode || 'merged').toLowerCase();

    // ---- 活跃账户(原样) + 视图标签过滤(中枢助手) ----
    const accounts = ACCOUNTS.filter(a => a.isActive).filter(a => ctx.matchesTags(a));

    // ---- 需要哪些国家(年份归中枢:窗口归它,年份就是它从裁剪窗推导的事实) ----
    const neededCountries = [...new Set(accounts.flatMap(a => a.holidayCalendars || ['CN']))];

    return {
      countries: neededCountries,
      state: { cfg, span: mapWindowToMonths(ctx.window), window: ctx.window, mode, mergeSameDay, alarmMode, accounts, legacyReminderParams }
    };
  },

  // —— 阶段二：原版编排 → 事件对象(本体) + 闹钟(附加) + Debug 段 ——
  async build(state, hub, ctx) {
    const { cfg, span, window, mode, mergeSameDay, alarmMode, accounts, legacyReminderParams } = state;

    // ---- 逐账户推算(原 worker-entry 原样) ----
    // legacy/cycle: 按月循环推算。email: 只读 KV 里"最近一期实测记录"，不外推不猜未来。
    const items = [];
    const emailModelNotes = [];
    const monthlyAccounts = accounts.filter(a => a.model !== 'email');
    const emailAccounts = accounts.filter(a => a.model === 'email');

    for (let i = 0; i < span.monthCount; i++) {
      let cm = span.startMonth0 + i, cy = span.startYear;
      while (cm > 11) { cm -= 12; cy++; }
      while (cm < 0) { cm += 12; cy--; }
      for (const acct of monthlyAccounts) {
        const isWorkday = hub.makeWorkdayChecker(acct.holidayCalendars);
        items.push(computeReminder(acct, cy, cm, isWorkday, cfg.holidayExtraAdvance));
      }
    }

    for (const acct of emailAccounts) {
      const accountId = accountKey(acct);
      const rec = await getLatestStatement(ctx.env, accountId);
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
    const failures = await listRecentFailures(ctx.env, 3);

    // ---- ①日历本体：事件对象(内容零改动;ICS 语法归框架渲染器) ----
    const events = buildCardEvents(items, cfg, mode, mergeSameDay);

    // ---- ②附加输出：闹钟网关条目(读 items，绝不写回；对日历零影响) ----
    const alarms = buildGatewayAlarms(items, cfg, alarmMode);

    // ---- ③Debug 报告段(原版正文原样 + 生效参数说明) ----
    const acctLog = accounts.map(a =>
      `- ${a.emoji}${a.bankShortName}(${a.cardName}) ${a.repayCurrency} [${a.model}]${a.tags ? ' tags:' + a.tags.join('/') : ''}${a.remind === false ? ' 闹钟:关' : ''} 假期:${(a.holidayCalendars || ['CN']).join('+')}`
    ).join('\n');                                  // v6:真实换行,转义归渲染器
    const debugLines = [
      `【💳 信用卡域】`,
      ...(legacyReminderParams.length ? [legacyReminderParams.map(k =>
        `⚠️ ?${k}= 已删除(v6 手术 B;v5.2 起的正名是 ?${k === 'adAlarms' ? 'allDayReminders' : 'exactReminders'}=)`
        + ` —— 本次按默认提醒处理,请更新此链接`).join('\n')] : []),
      `运行时间: ${ctx.nowBeijingStr} (北京时间)`,
      `显示模式: ${mode} | 同日合并: ${mergeSameDay ? '是' : '否'} (默认值在 config/card.js，URL 可临时覆盖)`,
      `生成跨度: ${span.monthCount} 个账单月 ${window.from} .. ${window.to} ← 中枢窗口 ?past=/?future= 映射(姿态 MAP)`,
      `闹钟网关: ${alarmMode === 'off' ? '关闭(仅日历)' : alarmMode === 'each' ? '每笔一条' : '同日合并为一条'} @ ${pad2(cfg.targetChinaHour)}:${pad2(cfg.targetChinaMinute)} (默认在 config/card.js 的 CARD_ALARM，?cardAlarm= 可覆盖)`,
      '',
      `【活跃账户 ${accounts.length} 个】`, acctLog,
      ...(emailModelNotes.length ? ['', '【email 模型状态】', ...emailModelNotes] : []),
      ...(failures.length ? ['', `【⚠️ 邮件解析报警: 最近 ${failures.length} 条失败】`, ...failures.map(f => `- ${f.at} ${f.reason}`)] : [])
    ];

    return { events, alarms, debugLines };
  }
};

// ============================================================================
// 闹钟网关构建(附加输出层)。uid 遵守协议 v1：无时钟时间。
//   each   → card-<账户哈希>-<账单月YYYYMM>  (账单月锚定：改 advanceDays/假期漂移都不抖)
//            与日历 uid 的前两段【逐字相同】→ 肉眼配对;20 字符,远在下游硬限 40 之内。
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
      uid: `card-${accountKey(it.account)}-${it.calcYear}${pad2(it.calcMonth0 + 1)}`,
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
