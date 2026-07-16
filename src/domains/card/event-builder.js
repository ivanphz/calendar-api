// ==========================================
// 📅 event-builder.js —— 信用卡事件组装 (标题分层 + 合并 + 审计正文)
// ==========================================
// 【v6 手术 A】原名 ics-builder.js。改名不是洁癖:本文件【不再产出任何 ICS 文本】——
//   转义/折行/DTSTART/VALARM/DTSTAMP/整册信封 全部归 src/renderer.js。
//   叫 ics-builder 会绊倒未来的读者,而且域目录里禁止出现 ICS 关键字(EVENT-MODEL §8 领地看守)。
//
// 【本文件的领地 —— 业务语义,一行未改】
//   · 同日合并分组(框架永远不做业务合并 —— 域先合并、再交一个事件对象)
//   · 标题分层(单笔/合并/银行聚合/国家降级)
//   · 审计正文
//   · 提醒【意图】(提前几分 / 第几天几点) —— 意图是业务,TRIGGER 语法是框架
//
// 【随手术消失的东西】
//   · beforeStartTrigger / signedDurationTrigger → 逐字移植进 renderer.js(全域共享)
//   · pushTiming / endDateStrOf / VCALENDAR 信封 → 渲染器职责
//   · buildTimingLines → 【死代码】,定义了从未被调用,顺手清除
//   · 手写 \\n 转义 → 改真实换行(EVENT-MODEL §2 铁律二)
//
// 【手术 B】账户身份改 crc32 短哈希(见下方冻结声明);needsFxPurchase/fxNote 正文行删除。
import { CURRENCY_SYMBOLS } from './config.js';
import { uidHash } from '../../governance.js';

const pad2 = (n) => ('0' + n).slice(-2);
const isoDateOf = (compact) => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;

// ============================================================================
// 🔒 账户身份 —— 哈希输入冻结声明(手术 B)
// ============================================================================
// 【冻结】哈希输入 = country - bankShortName - cardName - repayCurrency - (last4 || 'NA')
//        按此顺序、此分隔符,**永不改动**。以后要加字段?加在别处,不进哈希。
//        改一个字 = 全部 uid 变 = 网关全体重建(旧的自动关、新的自动建,一次刷新的眨眼,
//        不是灾难 —— 但没必要平白无故来这么一下)。
//
// 【为什么选哈希而不是手写短名】(判据见 governance.js 的 uidHash 头注)
//   本域身份是五段拼出来的:长(汇丰那条 44 字符 > 下游硬限 40)、含中文(PAB '一账通')。
//   属于"身份长/含中文/机器生成"那一类 → 哈希。
//   checkin 域的 'checkin-moeshare-202607' 则天生又短又 ASCII → 它不哈希。同判据,不同答案。
//
// 【哈希不可读怎么办】uid 的工作是【配对】不是【沟通】:
//   · 沟通归日历标题(SUMMARY)和闹钟 reason —— 那里全是人话;
//   · 手机标签 `Gate-ES-repay-<uid>-<HHMM>` 里的 `repay` 已答完"哪个项目";
//   · 治理诊断打 uid 时会带上 summary/reason(governance.js 的 who()) —— 排错不用查表。
//
// 【配对怎么用】闹钟 uid 是日历 uid 的【前缀】,肉眼即可对上:
//   日历: card-78d494f0-202607-20260720
//   闹钟: card-78d494f0-202607
// ============================================================================

// 冻结的哈希输入串(原 v5 主键;仍用于人读场景与哈希入参)。
// 特殊字符过滤保留 v5 原样 —— 它也是冻结契约的一部分。
export function makeAccountId(acct) {
  const raw = [acct.country, acct.bankShortName, acct.cardName, acct.repayCurrency, acct.last4 || 'NA']
    .join('-')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5\-]/g, '');
  return raw;
}

// 账户短身份:全库唯一入口。uid 与 KV 键都走它 —— 单点改动。
export function accountKey(acct) {
  return uidHash(makeAccountId(acct));
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
  return lines.join('\n');                     // v6:真实换行,转义归渲染器
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

// -------- 时间语义 + 提醒意图 (exact / allday) --------
// 【逐字继承 v5 pushTiming 的语义】,只是换成了事件对象的说法:
//   exact  → 定点事件:上海墙上时刻 + 时长(分钟)。tz 显式声明 —— 本域的 targetChinaHour/Minute
//            天生就是上海时间(参数名里就写着 China),隐式继承 HUB_CONFIG 会在改时区时静默错 8 小时。
//   allday → 全天事件:排他 DTEND 由渲染器算(v5 的 endDateStrOf 同语义)。
// 提醒【意图】归域,TRIGGER 【语法】归渲染器:
//   exact  → { minutesBefore }        缺省文案 '提前N分钟提醒！' / '事件开始时提醒！'(渲染器,与 v5 逐字同)
//   allday → { dayOffset, at:'HH:MM' } 缺省文案 '第X天 HH:MM 提醒！' / '当天 HH:MM 提醒！'(同上)
function timingOf(item, cfg, mode) {
  const date = isoDateOf(item.startDateStr);
  if (mode === 'exact') {
    return {
      allDay: false, date,
      time: `${pad2(cfg.targetChinaHour)}:${pad2(cfg.targetChinaMinute)}`,
      tz: 'Asia/Shanghai',
      durationMinutes: cfg.exactDurationMin,
      reminders: cfg.exactReminders.map(al => ({ minutesBefore: al.minutesBefore }))
    };
  }
  return {
    allDay: true, date,
    reminders: cfg.allDayReminders.map(al => ({ dayOffset: al.dayOffset, at: `${pad2(al.hour)}:${pad2(al.minute)}` }))
  };
}

// -------- 对外主函数：把推算结果列表组装成【事件对象】数组 --------
// 契约见 docs/EVENT-MODEL.md §1。返回的是语义,不是文本。
// uid 前缀 v6 起为 `card-`(=域 id,治理层跨域防撞的硬规则;v5 为 `repay-`,
// 订阅日历整册替换式刷新,改名对 iOS 无感)。@mycal.local 由渲染器统一追加,此处不带。
export function buildCardEvents(items, cfg, mode, mergeSameDay) {
  const events = [];

  // uid = card-<账户哈希>-<账单月>-<提醒日>。前两段与闹钟 uid 逐字相同 → 天然配对。
  // (v5 是 repay-<年>-<月0>-<长主键>-<提醒日>;身份语义不变,只是账户段换成了短哈希、
  //  月份段从 0 基改 1 基的 YYYYMM 与闹钟对齐。)
  const singleOf = (item) => ({
    uid: `card-${accountKey(item.account)}-${item.calcYear}${pad2(item.calcMonth0 + 1)}-${item.startDateStr}`,
    summary: buildSingleTitle(item, cfg.titlePrefix),
    description: buildDescription(item),
    tags: item.account.tags || [],
    ...timingOf(item, cfg, mode)
  });

  const mergedOf = (group) => ({
    uid: `card-merged-${group[0].startDateStr}`,
    summary: buildMergedTitle(group, cfg.titlePrefix, cfg),
    description: [`【合并提醒】当日共 ${group.length} 笔账单需处理`, ...group.map(buildDescription)]
      .join('\n\n────────\n\n'),                 // v6:真实换行
    tags: [...new Set(group.flatMap(it => it.account.tags || []))],
    ...timingOf(group[0], cfg, mode)
  });

  if (!mergeSameDay) {
    items.forEach(it => events.push(singleOf(it)));
  } else {
    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.startDateStr)) groups.set(it.startDateStr, []);
      groups.get(it.startDateStr).push(it);
    }
    for (const g of groups.values()) {
      events.push(g.length === 1 ? singleOf(g[0]) : mergedOf(g));
    }
  }

  return events;
}
