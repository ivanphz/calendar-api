// ==========================================
// 🗓 假期总调度 (多国叠加判断器)
// ==========================================
// 职责：
//   1. 按需惰性创建各国 provider(用到哪国才建哪国)，并统一 load 指定年份的数据。
//   2. 对外暴露一个 makeWorkdayChecker(countries)，返回一个"这几个国家里任意一国放假就算休息"的判断函数。
//
// 叠加规则(来自需求)：跨境还款要两头都能清算，任一相关国家放假，这天就不可用。
//   - 中国大陆卡:      countries = ['CN']
//   - 香港卡:          countries = ['CN','HK']  (资金路径两头都要在线)
//   - 美国卡:          countries = ['CN','US']
//   具体每张卡挂哪几个国家，由 config.js 里该卡的 holidayCalendars 字段决定。
//
// ── 🆕 CN 双口径(v4.1) ─────────────────────────────────────────────────────
// 中国大陆独有"调休补班"(周末被官方标为上班)。但补班周末【股市不开、跨行清算走周末档】，
// 转账/市场类操作不应把补班日当工作日。因此 CN 提供两种口径：
//   'official' (默认)  调休那套：法定假=休，补班周末=上班。 —— 原行为，一字未变。
//   'market'           市场/清算口径：只认"放假"，补班标记不作数(周末照休)。
//                      即 工作日 = 周一至周五 且 非法定假(A股/银行清算口径)。
// 指定方式(优先级从高到低)：
//   1) 条目级 token：holidayCalendars 里写 'CN:market' 或 'CN:official'(单卡/单任务生效)
//   2) 全局默认：createHolidayHub 第三参 { cnDefaultRule } —— 由 URL ?cnRule=market|official 传入
//   3) 缺省 'official'
// HK/US 无调休概念，token 后缀对它们无意义(会被忽略)。
//
// 加新国家(如英国)只需:  1) 新增 holidays/gb.js  2) 在下面 PROVIDER_FACTORIES 里注册一行。其他文件不用动。

import { createCnHolidayProvider } from './cn.js';
import { createHkHolidayProvider } from './hk.js';
import { createUsHolidayProvider } from './us.js';
import { createUsMarketHolidayProvider } from './us-market.js';

const PROVIDER_FACTORIES = {
  CN: createCnHolidayProvider,
  HK: createHkHolidayProvider,
  US: createUsHolidayProvider
  // GB: createGbHolidayProvider,  // ← 以后加英国卡时，取消注释并新建 holidays/gb.js 即可
};

// 'CN:market' -> { code:'CN', rule:'market' }；'CN' -> { code:'CN', rule:null }
const parseToken = (token) => {
  const [code, rule] = String(token).split(':');
  return { code, rule: (rule === 'market' || rule === 'official') ? rule : null };
};

export async function createHolidayHub(neededCountries, years, opts = {}) {
  const cnDefaultRule = opts.cnDefaultRule === 'market' ? 'market' : 'official';
  const providers = {};
  const loadLogs = [];

  // 只为实际用到的国家创建 provider('CN' 与 'CN:market' 归一化为同一份 CN 数据)
  const uniqueCountries = [...new Set(neededCountries.map(t => parseToken(t).code))];
  // 'US:market' 额外需要 NYSE 日历(独立数据，与联邦 us.js 并存)
  const needUsMarket = neededCountries.some(t => { const p = parseToken(t); return p.code === 'US' && p.rule === 'market'; });
  if (needUsMarket) providers.US_MARKET = createUsMarketHolidayProvider();
  for (const c of uniqueCountries) {
    const factory = PROVIDER_FACTORIES[c];
    if (!factory) {
      loadLogs.push(`[WARN] 国家 ${c} 没有对应的假期 provider，将只按周末判断`);
      continue;
    }
    providers[c] = factory();
  }

  // 并行加载所有国家的数据
  await Promise.all(
    Object.values(providers).map(async (p) => {
      const result = await p.load(years);
      loadLogs.push(`[${p.country}] ${result.source}${result.ok ? '' : ' ⚠️'}`);
    })
  );

  // 判断单个国家的某一天是否为该国工作日。cnRule 仅对 CN 生效。
  const isWorkdayInCountry = (country, dateObj, rule) => {
    const pad = n => ('0' + n).slice(-2);
    const dateStr = `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
    // US 市场口径：查 NYSE 休市集合(独立于联邦 us.js)
    if (country === 'US' && rule === 'market' && providers.US_MARKET) {
      if (providers.US_MARKET.isOffDay(dateStr)) return false;
      const dow0 = dateObj.getDay();
      return dow0 !== 0 && dow0 !== 6;
    }

    const p = providers[country];

    // CN 特殊：有调休，lookup 可能返回 true(放假)/false(补班)/undefined(未知)
    if (p && typeof p.lookup === 'function') {
      const v = p.lookup(dateStr);
      if (v === true) return false;   // 明确放假(两种口径一致)
      if (v === false) {
        // 明确补班上班：
        //   official -> 采信补班，算工作日(原行为)
        //   market   -> 🆕 补班标记不作数，落到下面的周末默认判断
        //               (补班必落在周末，故市场口径下 = 休息)
        if (rule !== 'market') return true;
      }
      // undefined / market口径的补班 -> 落到周末默认判断
    } else if (p && typeof p.isOffDay === 'function') {
      if (p.isOffDay(dateStr)) return false; // HK/US: 命中假期即非工作日
    }

    // 默认：周末(周六/周日)为休息
    const dow = dateObj.getDay();
    return dow !== 0 && dow !== 6;
  };

  return {
    loadLogs,
    cnDefaultRule,
    // 返回一个判断器：这几个国家里"全部都是工作日"才算工作日；任一国休息即 false。
    // countries 支持口径 token('CN:market')；CN 未带 token 时用全局默认口径。
    makeWorkdayChecker(countries) {
      const list = ((countries && countries.length) ? countries : ['CN'])
        .map(parseToken)
        .map(({ code, rule }) => ({
          code,
          rule: code === 'CN' ? (rule || cnDefaultRule)
              : (code === 'US' && rule === 'market') ? 'market'
              : null   // HK: market/official 为等价别名(港交所≈公众假期+周末,无背离) -> 统一走默认口径
        }));
      return (dateObj) => list.every(({ code, rule }) => isWorkdayInCountry(code, dateObj, rule));
    }
  };
}
