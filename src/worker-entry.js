// ============================================================================
// 🚀 worker-entry.js —— 提醒中枢入口(框架文件；薄路由，零业务计算)
// ============================================================================
// 【日历是本体，闹钟是附加输出】?format 缺省即 ics；json 只是从同一批推算结果衍生。
// 【v6】ICS 语法全部委托 src/renderer.js;窗口/uid/超时治理全部委托 src/governance.js。
//       本文件只做:路由 → 组装上下文 → 调域 → 过治理 → 交渲染器。零 ICS 字符串。
//
// ── 中枢级参数(各域自己的参数由各域 adapter 解析，见各 adapter 头注) ──
//   [视图组合 —— 一条链接一种组合，互相独立]
//   ?cal=all|checkin|card|checkin,card   选域(默认 all)
//   ?exclude=card                        从选中的域里剔除(排除法：?cal=all&exclude=card)
//   ?tags=A,B                            只出带这些标签的条目(账户/任务上的 tags 字段)
//   ?excludeTags=X                       剔除带这些标签的条目(未打标签的不受影响)
//   [窗口 —— v6 新增,中枢统一;旧的 ?months= 已废除]
//   ?past=3 ?future=12                   跨度(月)。缺省住 config/hub.js。
//                                        窗口是【许可边界】不是【生产配额】:域可以少产,不可以越界。
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
// 假期事实一律来自上游 npm 包 workdays-core(GitHub Packages 私有源):
// 本库自 v5 起【不再持有任何假期数据与判定实现】,换数据源/修数据 = 上游发版,本库零改动。
// 上游 API 契约与升级链路见 workdays-core 的 docs/INTEGRATION.md;本库消费面速查见 ARCHITECTURE §6。
import { createHolidayHub } from '@ivanphz/workdays-core';
import { handleIncomingEmail } from './domains/card/email-handler.js';
import { HUB_CONFIG } from '../config/hub.js';
import { renderEventObject, renderCalendarDocument, makeDtStamp } from './renderer.js';
import {
  computeViewWindow, computeClampWindow,
  governDomainEvents, governDomainAlarms,
  runWithTimeBudget, DOMAIN_TIME_BUDGET_MS
} from './governance.js';

const pad2 = (n) => ('0' + n).slice(-2);
const splitList = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const intOr = (raw, fallback) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export default {
  async fetch(request, env, _execCtx) {
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
    // 标签命中助手:v5 里两个 adapter 各抄了一份逐字相同的实现 —— v6 收归中枢,单点改动。
    const matchesTags = (item) => {
      const t = item.tags || [];
      if (filters.tags.length && !filters.tags.some(x => t.includes(x))) return false;              // 选择型:必须命中
      if (filters.excludeTags.length && filters.excludeTags.some(x => t.includes(x))) return false; // 排除型
      return true;
    };

    // ---- 中枢窗口(v6)：月参数 → 绝对日期区间 → 下发 + 兜底 ----
    const pastMonths = intOr(q.get('past'), HUB_CONFIG.pastMonths);
    const futureMonths = intOr(q.get('future'), HUB_CONFIG.futureMonths);
    const viewWindow = computeViewWindow(baseDateObj, pastMonths, futureMonths);
    const clampWindow = computeClampWindow(viewWindow);
    // 废除参数响亮告警:?months= 是 v5 签到域参数,v6 起由 ?future= 统管。
    // 不静默吞掉 —— 否则旧链接会"看起来正常"却按新缺省跑(?months=6 的人会悄悄拿到 12 个月)。
    const monthsWarn = q.has('months')
      ? `⚠️ ?months=${q.get('months')} 已废除(v6:签到域跨度并入中枢窗口),本次按 ?future=${futureMonths} 处理 —— 请更新此链接`
      : null;

    // 域上下文:装【请求级恒定】的一切(从头到尾不变)。
    // 为什么 hub 不在里头? 它要等 prepare 报完 countries 才诞生 —— 它是【阶段二才存在】的资源,
    // 故走位置参数 build(state, hub, ctx)。这条界线就是 ctx 与位置参数的分工规则。
    const domainCtx = {
      env,                                  // KV/Secret。prepare 也拿得到 —— 账户列表存 KV 的域,
                                            // 得先读 KV 才知道自己要哪些国家(v5 的 prepare 第4参,能力保留)
      baseDate: baseDateObj, todayStr,
      window: viewWindow, filters, matchesTags,
      nowBeijingStr: beijingTimeStr, hubTimezone: HUB_CONFIG.timezone
    };

    // ---- 阶段一：各域自行解析参数并报出假期需求 ----
    // 故障隔离:单个域抛异常/超时只熔断该域,其它域照常;失败以"哨兵事件"在日历显形(见下)。
    const prepared = {};
    const failed = {};   // id -> 错误信息
    const countries = new Set(), years = new Set();
    for (const id of selectedIds) {
      const r = await runWithTimeBudget(
        Promise.resolve().then(() => DOMAINS[id].prepare(q, domainCtx)),
        DOMAIN_TIME_BUDGET_MS, `域 ${id} prepare`
      );
      if (!r.ok) { failed[id] = `prepare 阶段: ${r.error}`; continue; }
      prepared[id] = r.value;
      prepared[id].countries.forEach(c => countries.add(c));
    }
    // 年份【全部由中枢推导】:覆盖裁剪窗(含 ±缓冲)跨越的全部年份 —— 多加载一年只是多读数据,
    // 绝不给错答案。v5 里两个域各写了一套年份算法、还不一致 —— 那正是"没有总控"的具象。
    for (let y = Number(clampWindow.from.slice(0, 4)); y <= Number(clampWindow.to.slice(0, 4)); y++) years.add(y);

    // ---- 假期一次性加载(共享 hub,数据与判定全在上游 workdays-core 内) ----
    // ?cnRule=bank|market —— 裸 'CN' 的工作日口径全局默认(bank=调休那套;market=补班周末视为休息)。
    // 条目级 token('CN:market'/'CN:bank')优先于此。词汇与上游一词一义拉齐:
    // v5 破坏性变更 —— 'official' 已废除;写错/写旧不会静默吞掉,下面会在诊断里响亮告警。
    const cnRuleRaw = q.get('cnRule');
    const cnRule = cnRuleRaw === 'market' ? 'market' : 'bank';
    const cnRuleWarn = (cnRuleRaw && cnRuleRaw !== 'market' && cnRuleRaw !== 'bank')
      ? `⚠️ ?cnRule=${cnRuleRaw} 不是合法口径(v5 起只有 bank|market;official 已废除),已按 bank 处理`
      : null;
    const hub = await createHolidayHub([...countries], [...years], { cnDefaultRule: cnRule });
    // 上游覆盖度自检:某地区×年份没有真数据时(公告未发/归档缺失/未知口径),上游按纯周末兜底
    // 且 coverage 里 ok=false —— 必须在诊断里显形,绝不让"在瞎猜"静默混过。
    const coverageWarns = (hub.coverage || [])
      .filter(c => !c.ok)
      .map(c => `⚠️ [${c.region}${c.kind && c.kind !== '*' ? ':' + c.kind : ''} ${c.year}] 无真实数据(${c.mode || 'fallback'}),该年按纯周末兜底,结果不可全信`);

    // ---- 阶段二：各域构建(日历本体 + 附加闹钟 + Debug 段) ----
    const dtStamp = makeDtStamp();
    const results = {};
    for (const id of selectedIds) {
      if (failed[id]) continue;
      const r = await runWithTimeBudget(
        Promise.resolve().then(() => DOMAINS[id].build(prepared[id].state, hub, domainCtx)),
        DOMAIN_TIME_BUDGET_MS, `域 ${id} build`
      );
      if (!r.ok) { failed[id] = `build 阶段: ${r.error}`; continue; }
      results[id] = r.value;
    }
    const okIds = selectedIds.filter(id => !failed[id]);

    // ---- 出口治理:闹钟通道(两种 format 都跑 —— ICS 模式下熔断也要在诊断里看得见) ----
    // 理由:Ivan 日常看的是日历诊断,不是 JSON。汇丰 44 字符 uid 这类问题若只在 JSON 模式显形,
    // 就等于永远看不见(那条链接是网关在拉,不是人在看)。
    const seenAlarmUids = new Set();
    const governNotes = [];
    const governedAlarms = {};
    for (const id of okIds) {
      const g = governDomainAlarms({ domainId: id, alarms: results[id].alarms, seenAlarmUids });
      governedAlarms[id] = g.accepted;
      governNotes.push(...g.notes);
    }

    // ================= 附加输出：闹钟接入协议 v1 =================
    if (format === 'json') {
      // 契约:框架对每条 alarm 只做【治理校验 + 按日的未来过滤 + 排序】,字段原样透传
      // (uid/date/time/reason 之外的协议可选字段如 tz,一并原样输出)。
      let alarms = okIds.flatMap(id => governedAlarms[id]);
      alarms = alarms.filter(a => a.date >= todayStr);                       // 只吐未来(过去网关也会丢)
      alarms.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
      // JSON 通道没有诊断事件承载告警 —— 至少让 `wrangler tail` 看得见,不至于全无痕迹。
      for (const note of governNotes) console.log('[governance]', note);
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

    // ---- 出口治理:事件通道(uid/唯一性/窗口裁剪) ----
    const seenUids = new Set();
    const domainChunks = [];
    const renderWarns = [];
    // 全域一律过治理再渲染 —— 没有旁路,没有豁免。v5 那条"eventLines 黑箱"路径已随手术 A 拆除。
    for (const id of okIds) {
      const g = governDomainEvents({ domainId: id, events: results[id].events, clampWindow, seenUids });
      governNotes.push(...g.notes);
      for (const ev of g.accepted) {
        const rendered = renderEventObject(ev, { dtStamp, defaultTimezone: HUB_CONFIG.timezone });
        renderWarns.push(...rendered.warnings);
        domainChunks.push(rendered.lines);
      }
    }

    const dStart = todayStr;                       // 诊断/哨兵事件锚在基准日当天(全天)
    const eventChunks = [];

    // ---- 故障哨兵事件：域熔断必须在日历上看得见(即使 ?debug=0) ----
    for (const [fid, msg] of Object.entries(failed)) {
      const r = renderEventObject({
        uid: `error-${fid}-${dtStamp}`, allDay: true, date: dStart,
        summary: `❌ 域 ${fid} 构建失败`,
        description: `${msg}\n\n该域本次未输出任何事件/闹钟;其它域不受影响。修复后刷新订阅即恢复。`
      }, { dtStamp, defaultTimezone: HUB_CONFIG.timezone });
      eventChunks.push(r.lines);
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
        `窗口: 过去 ${pastMonths} 月 / 未来 ${futureMonths} 月 → ${viewWindow.from} .. ${viewWindow.to}`,
        `  (裁剪兜底: ${clampWindow.from} .. ${clampWindow.to};窗口是许可边界不是生产配额 — 域可少产不可越界)`,
        ...(monthsWarn ? [monthsWarn] : []),
        `CN工作日口径: ${cnRule}${cnRule === 'market' ? ' (补班周末视为休息 — 股市/清算口径)' : ' (调休那套,默认;?cnRule=market 或条目 CN:market 可切市场口径)'}`,
        ...(cnRuleWarn ? [cnRuleWarn] : []),
        '',
        ...Object.entries(failed).map(([fid, msg]) => `❌ 域 ${fid} 熔断: ${msg}`),
        ...okIds.flatMap(id => [...results[id].debugLines, '']),
        '【出口治理 · 框架】',
        ...(governNotes.length ? governNotes.map(l => '  ' + l) : ['  ✅ 无越界/无 uid 违规']),
        ...(renderWarns.length ? renderWarns.map(l => '  ' + l) : []),
        '',
        '【假期数据源状态 · 上游 workdays-core】',
        ...coverageWarns.map(l => '  ' + l),
        ...hub.loadLogs.map(l => '  ' + l)
      ].join('\n');
      const r = renderEventObject({
        uid: `debug-log-${dtStamp}`, allDay: true, date: dStart,
        summary: '⚙️ 提醒中枢诊断报告 (Debug)', description: desc
      }, { dtStamp, defaultTimezone: HUB_CONFIG.timezone });
      eventChunks.push(r.lines);
    }

    eventChunks.push(...domainChunks);
    const ics = renderCalendarDocument({ calendarName: calName, timezone: HUB_CONFIG.timezone, color }, eventChunks);

    return new Response(ics, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="calendar_api_${selectedIds.join('_')}.ics"`,
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
