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
// 加新国家(如英国)只需:  1) 新增 holidays/gb.js  2) 在下面 PROVIDER_FACTORIES 里注册一行。其他文件不用动。

import { createCnHolidayProvider } from './cn.js';
import { createHkHolidayProvider } from './hk.js';
import { createUsHolidayProvider } from './us.js';

const PROVIDER_FACTORIES = {
  CN: createCnHolidayProvider,
  HK: createHkHolidayProvider,
  US: createUsHolidayProvider
  // GB: createGbHolidayProvider,  // ← 以后加英国卡时，取消注释并新建 holidays/gb.js 即可
};

export async function createHolidayHub(neededCountries, years) {
  const providers = {};
  const loadLogs = [];

  // 只为实际用到的国家创建 provider
  const uniqueCountries = [...new Set(neededCountries)];
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

  // 判断单个国家的某一天是否为该国工作日
  const isWorkdayInCountry = (country, dateObj) => {
    const pad = n => ('0' + n).slice(-2);
    const dateStr = `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
    const p = providers[country];

    // CN 特殊：有调休，lookup 可能返回 true(放假)/false(补班)/undefined(未知)
    if (p && typeof p.lookup === 'function') {
      const v = p.lookup(dateStr);
      if (v === true) return false;   // 明确放假
      if (v === false) return true;   // 明确补班上班
      // undefined -> 落到下面的周末默认判断
    } else if (p && typeof p.isOffDay === 'function') {
      if (p.isOffDay(dateStr)) return false; // HK/US: 命中假期即非工作日
    }

    // 默认：周末(周六/周日)为休息
    const dow = dateObj.getDay();
    return dow !== 0 && dow !== 6;
  };

  return {
    loadLogs,
    // 返回一个判断器：这几个国家里"全部都是工作日"才算工作日；任一国休息即 false。
    makeWorkdayChecker(countries) {
      const list = (countries && countries.length) ? countries : ['CN'];
      return (dateObj) => list.every(c => isWorkdayInCountry(c, dateObj));
    }
  };
}
