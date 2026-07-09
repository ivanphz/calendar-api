// ============================================================================
// 🚀 worker-entry.js —— 提醒中枢入口(框架文件；薄路由，零业务计算)
// ============================================================================
// 【日历是本体，闹钟是附加输出】?format 缺省即 ics；json 只是从同一批推算结果衍生。
//
// ── 中枢级参数(各域的参数由各域 adapter 自己解析，见各 adapter 头注) ──
//   [视图组合 —— 一条链接一种组合，互相独立]
//   ?cal=all|checkin|card|checkin,card   选域(默认 all)
//   ?exclude=card                        从选中的域里剔除(排除法：?cal=all&exclude=card)
//   ?tags=A,B                            只出带这些标签的条目(账户/任务上的 tags 字段)
//   ?excludeTags=X                       剔除带这些标签的条目(未打标签的不受影响)
//   [输出与调试]
//   ?format=ics|json                     默认 ics(日历)
//   ?testDate=YYYY-MM-DD                 覆盖"今天"(基准日；影响推算窗口与 JSON 未来过滤)
//   ?colorCheckin= ?colorCard= ?color=   分册/混册颜色(带 # 编码为 %23)
//   ?debug=0                             隐藏诊断事件(默认【开】)
//
// 组合示例：
//   ?cal=card                       只要信用卡(红册，重要单独订)
//   ?cal=all&exclude=card           除信用卡外的一切
//   ?cal=checkin&tags=A             日历A(签到域里打了 A 标签的任务)
//   ?tags=life&format=json          全域 life 标签条目的闹钟流
// 日历链接与闹钟互相解耦：ICS 链接组合什么，与网关拉哪条 JSON、谁进闹钟(remind/alarmMode)互不牵连。

import { DOMAINS } from './registry.js';
import { createHolidayHub } from './holidays/index.js';
import { handleIncomingEmail } from './domains/card/email-handler.js';
import { HUB_CONFIG } from '../config/hub.js';

const pad2 = (n) => ('0' + n).slice(-2);
const splitList = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const q = url.searchParams;

    const format = (q.get('format') || 'ics').toLowerCase();
    const debugOn = format === 'ics' && q.get('debug') !== '0';   // 诊断默认开

    // ---- 基准时间(北京时区，避开 UTC 跨日；原信用卡项目写法原样) + testDate 覆盖 ----
    const realNow = new Date();
    const beijingTimeStr = realNow.toLocaleString('zh-CN', { timeZone: HUB_CONFIG.timezone, hour12: false });
    let baseDateObj = new Date(realNow.toLocaleString('en-US', { timeZone: HUB_CONFIG.timezone }));
    if (q.has('testDate') && /^\d{4}-\d{2}-\d{2}$/.test(q.get('testDate'))) {
      const [y, m, d] = q.get('testDate').split('-').map(Number);
      baseDateObj = new Date(y, m - 1, d, 12, 0, 0);
    }
    const todayStr = `${baseDateObj.getFullYear()}-${pad2(baseDateObj.getMonth() + 1)}-${pad2(baseDateObj.getDate())}`;

    // ---- 视图组合：cal 圈定 → exclude 剔除 → tags/excludeTags 传给域内条目过滤 ----
    const calParam = (q.get('cal') || 'all').toLowerCase();
    let selectedIds = calParam === 'all'
      ? Object.keys(DOMAINS)
      : calParam.split(',').map(s => s.trim()).filter(id => DOMAINS[id]);
    const excluded = new Set(splitList(q.get('exclude')).map(s => s.toLowerCase()));
    selectedIds = selectedIds.filter(id => !excluded.has(id));
    if (!selectedIds.length) return new Response('empty selection (cal/exclude)', { status: 400 });

    const filters = { tags: splitList(q.get('tags')), excludeTags: splitList(q.get('excludeTags')) };

    // ---- 阶段一：各域自行解析参数并报出假期需求 ----
    // 契约:prepare 可为 async(一律 await);第 4 参传 env(KV/Secret 驱动的域会用到)。
    // 故障隔离:单个域抛异常只熔断该域,其它域照常;失败以"哨兵事件"在日历显形(见下)。
    const prepared = {};
    const failed = {};   // id -> 错误信息
    const countries = new Set(), years = new Set();
    for (const id of selectedIds) {
      try {
        prepared[id] = await DOMAINS[id].prepare(q, baseDateObj, filters, env);
        prepared[id].countries.forEach(c => countries.add(c));
        prepared[id].years.forEach(y => years.add(y));
      } catch (e) {
        failed[id] = `prepare 阶段: ${String((e && e.message) || e)}`;
      }
    }

    // ---- 假期一次性加载(共享 hub) ----
    // 🆕 ?cnRule=market|official —— CN 工作日口径全局默认(official=调休那套;market=补班周末视为休息)
    //     条目级 'CN:market' token 优先于此(见 holidays/index.js 头注)。
    const cnRule = q.get('cnRule') === 'market' ? 'market' : 'official';
    const hub = await createHolidayHub([...countries], [...years], { cnDefaultRule: cnRule });

    // ---- 阶段二：各域构建(日历本体 + 附加闹钟 + Debug 段) ----
    const dtStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const results = {};
    for (const id of selectedIds) {
      if (failed[id]) continue;
      try {
        results[id] = await DOMAINS[id].build(prepared[id].state, env, hub, dtStamp, beijingTimeStr);
      } catch (e) {
        failed[id] = `build 阶段: ${String((e && e.message) || e)}`;
      }
    }
    const okIds = selectedIds.filter(id => !failed[id]);

    // ================= 附加输出：闹钟接入协议 v1 =================
    if (format === 'json') {
      // 契约:框架对每条 alarm 只做【按日的未来过滤 + 排序】,字段原样透传
      // (uid/date/time/reason 之外的协议可选字段如 tz,一并原样输出)。
      let alarms = okIds.flatMap(id => results[id].alarms || []);
      alarms = alarms.filter(a => a.date >= todayStr);                       // 只吐未来(过去网关也会丢)
      alarms.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
      return new Response(JSON.stringify({ v: 1, alarms }, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // ================= 日历本体：ICS 分册/混册包装 =================
    let calName, color;
    if (selectedIds.length === 1) {
      const d = DOMAINS[selectedIds[0]];
      const colorParam = `color${d.id.charAt(0).toUpperCase()}${d.id.slice(1)}`;   // colorCheckin / colorCard
      calName = d.calName;
      color = q.get(colorParam) || d.defaultColor;
    } else {
      calName = HUB_CONFIG.mixedCalName;
      color = q.get('color') || HUB_CONFIG.mixedColor;
    }

    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Reminder Hub//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${calName}`, `X-WR-TIMEZONE:${HUB_CONFIG.timezone}`, `X-APPLE-CALENDAR-COLOR:${color}`
    ];

    const endObj = new Date(baseDateObj); endObj.setDate(endObj.getDate() + 1);
    const dStart = `${baseDateObj.getFullYear()}${pad2(baseDateObj.getMonth() + 1)}${pad2(baseDateObj.getDate())}`;
    const dEnd = `${endObj.getFullYear()}${pad2(endObj.getMonth() + 1)}${pad2(endObj.getDate())}`;

    // ---- 故障哨兵事件：域熔断必须在日历上看得见(即使 ?debug=0) ----
    for (const [fid, msg] of Object.entries(failed)) {
      ics.push(
        'BEGIN:VEVENT', `UID:error-${fid}-${dtStamp}@mycal.local`, `DTSTAMP:${dtStamp}`,
        `SUMMARY:❌ 域 ${fid} 构建失败`,
        `DESCRIPTION:${msg}\\n\\n该域本次未输出任何事件/闹钟;其它域不受影响。修复后刷新订阅即恢复。`,
        `DTSTART;VALUE=DATE:${dStart}`, `DTEND;VALUE=DATE:${dEnd}`, 'END:VEVENT'
      );
    }

    // ---- 诊断事件(默认开)：中枢视图组合 + 各域自己的报告段 ----
    if (debugOn) {
      const viewDesc = [
        `启用域: ${selectedIds.join(' + ')}`,
        excluded.size ? `排除域: ${[...excluded].join(',')}` : null,
        filters.tags.length ? `选择标签: ${filters.tags.join(',')}` : null,
        filters.excludeTags.length ? `排除标签: ${filters.excludeTags.join(',')}` : null
      ].filter(Boolean).join(' | ');
      const desc = [
        '>>> 提醒中枢诊断报告 <<<', '',
        `视图: ${viewDesc} | 输出: ICS(日历本体)`,
        q.has('testDate') ? `⚠️ testDate 模拟基准日: ${todayStr}` : `基准日: ${todayStr}`,
        `CN工作日口径: ${cnRule}${cnRule === 'market' ? ' (补班周末视为休息 — 股市/清算口径)' : ' (调休那套,默认;?cnRule=market 或条目 CN:market 可切市场口径)'}`,
        '',
        ...Object.entries(failed).map(([fid, msg]) => `❌ 域 ${fid} 熔断: ${msg}`),
        ...okIds.flatMap(id => [...results[id].debugLines, '']),
        '【假期数据源状态】', ...hub.loadLogs.map(l => '  ' + l)
      ].join('\\n');
      ics.push(
        'BEGIN:VEVENT', `UID:debug-log-${dtStamp}@mycal.local`, `DTSTAMP:${dtStamp}`,
        'SUMMARY:⚙️ 提醒中枢诊断报告 (Debug)', `DESCRIPTION:${desc}`,
        `DTSTART;VALUE=DATE:${dStart}`, `DTEND;VALUE=DATE:${dEnd}`, 'END:VEVENT'
      );
    }

    for (const id of okIds) ics.push(...results[id].eventLines);
    ics.push('END:VCALENDAR');

    return new Response(ics.join('\r\n'), {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="reminder_hub_${selectedIds.join('_')}.ics"`,
        'Access-Control-Allow-Origin': '*'
      }
    });
  },

  // Cloudflare Email Routing 入口：来信原样转发给信用卡域(email 模型)。
  // 收件地址保密(EXPECTED_RECIPIENT Secret)，不出现在任何代码/仓库中。(原样)
  async email(message, env, ctx) {
    await handleIncomingEmail(message, env);
  }
};
