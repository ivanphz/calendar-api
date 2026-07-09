// ==========================================
// 🇺🇸📈 us-market.js —— 美国 NYSE/Nasdaq 交易日历 (纯算法生成，不联网)
// ==========================================
// 供 'US:market' 口径使用。与 us.js(银行/联邦口径)是两份不同的日历，双向都有差异：
//   · NYSE 多休: Good Friday(耶稣受难日 = 复活节前的周五) —— 非联邦假日，银行照常营业
//   · NYSE 少休: Columbus Day、Veterans Day 正常开市 —— 联邦假日，银行休
// 观察日规则(NYSE 与联邦不同)：
//   · 假日落周日 -> 次周一休市
//   · 假日落周六 -> 前一个周五休市；【唯一例外】该周五若是当月最后一个交易日则不休 ——
//     实务上只会命中"元旦落周六"(前一日是 12/31)：此时 12/31 周五照常开市。
// 半日市(感恩节次日、平安夜等提前收盘日)仍是开市日，本日历不标记 —— 判定为工作日。
// 数据零依赖：全部规则离线推算(复活节用 Anonymous Gregorian/Computus 算法)，与 us.js 同哲学。
//
// ⚠️ 用途边界：本日历回答"NYSE 这天开不开市"。【还款/转账请继续用 'US'(银行口径)】——
//    market 口径会把银行休息的 Columbus/Veterans Day 判为工作日，用于还款会踩空。

// 计算某年某月的"第 n 个星期 weekday"。weekday: 0=周日 ... 6=周六。n 从 1 开始。
function nthWeekdayOfMonth(year, month0, weekday, n) {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstDow = first.getUTCDay();
  const day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
  return new Date(Date.UTC(year, month0, day));
}

// 计算某年某月"最后一个星期 weekday"。
function lastWeekdayOfMonth(year, month0, weekday) {
  const last = new Date(Date.UTC(year, month0 + 1, 0));
  const lastDow = last.getUTCDay();
  const day = last.getUTCDate() - ((lastDow - weekday + 7) % 7);
  return new Date(Date.UTC(year, month0, day));
}

// 复活节(格里历，Anonymous/Computus 算法)。返回当年复活节周日的 UTC 日期。
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month0 = Math.floor((h + l - 7 * m + 114) / 31) - 1;   // 2=三月, 3=四月
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month0, day));
}

function toDateStr(dateUtc) {
  const pad = n => ('0' + n).slice(-2);
  return `${dateUtc.getUTCFullYear()}-${pad(dateUtc.getUTCMonth() + 1)}-${pad(dateUtc.getUTCDate())}`;
}

// 生成指定年份的 NYSE 全日休市集合，返回 Set<'YYYY-MM-DD'>。
function generateNyseHolidays(year) {
  const set = new Set();

  // 固定日期类：按 NYSE 观察日规则平移。isNewYear 标记元旦例外。
  const addFixedNyse = (month0, day, isNewYear = false) => {
    const real = new Date(Date.UTC(year, month0, day));
    set.add(toDateStr(real));                       // 真实日(若在周末，本就非交易日，无害)
    const dow = real.getUTCDay();
    if (dow === 0) {                                // 周日 -> 周一补休
      const mon = new Date(real.getTime()); mon.setUTCDate(mon.getUTCDate() + 1);
      set.add(toDateStr(mon));
    } else if (dow === 6 && !isNewYear) {           // 周六 -> 周五补休；元旦例外(12/31 照常开市)
      const fri = new Date(real.getTime()); fri.setUTCDate(fri.getUTCDate() - 1);
      set.add(toDateStr(fri));
    }
  };
  const addFloating = (dateUtc) => set.add(toDateStr(dateUtc));

  addFixedNyse(0, 1, /* isNewYear */ true);            // New Year's Day
  addFloating(nthWeekdayOfMonth(year, 0, 1, 3));       // MLK Day (1月第3个周一)
  addFloating(nthWeekdayOfMonth(year, 1, 1, 3));       // Washington's Birthday (2月第3个周一)
  const easter = easterSunday(year);                   // Good Friday = 复活节 - 2 天
  const goodFriday = new Date(easter.getTime()); goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  addFloating(goodFriday);
  addFloating(lastWeekdayOfMonth(year, 4, 1));         // Memorial Day (5月最后一个周一)
  addFixedNyse(5, 19);                                 // Juneteenth (6/19)
  addFixedNyse(6, 4);                                  // Independence Day (7/4)
  addFloating(nthWeekdayOfMonth(year, 8, 1, 1));       // Labor Day (9月第1个周一)
  addFloating(nthWeekdayOfMonth(year, 10, 4, 4));      // Thanksgiving (11月第4个周四)
  addFixedNyse(11, 25);                                // Christmas (12/25)
  // 注意：不含 Columbus Day / Veterans Day —— NYSE 这两天开市(银行休)。

  return set;
}

// 对外接口：与 us/hk 同形 { country, load(years), isOffDay(dateStr) }。
export function createUsMarketHolidayProvider() {
  const holidaySet = new Set();
  return {
    country: 'US-NYSE',
    async load(years) {
      // 多算前后一年，覆盖跨年平移(如次年元旦落周日 -> 观察日在…始终在次年内；
      // 反向:元旦落周六不产生上年 12/31，休市；但为窗口边界稳妥仍冗余一年，成本为零)
      const expand = new Set(years.flatMap(y => [y - 1, y, y + 1]));
      for (const y of expand) for (const d of generateNyseHolidays(y)) holidaySet.add(d);
      return { source: 'algorithm(NYSE market)', ok: true };
    },
    isOffDay(dateStr) {
      return holidaySet.has(dateStr);
    }
  };
}
