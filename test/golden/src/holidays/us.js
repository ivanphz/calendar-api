// ==========================================
// 🇺🇸 美国联邦假期 (纯算法生成，不联网)
// ==========================================
// 为什么写死而不抓 ics:
//   1. 美国联邦假期是纯规则 —— 要么固定日期(如7月4日)，要么"某月第N个星期几"(如感恩节=11月第4个周四)，
//      不含农历，完全可以用算法算出来，不需要任何外部数据源，也就不会因为源挂了而降级出错。
//   2. 银行/ACH 清算只认这 11 个联邦假期。网上很多 ics(包括苹果的 US_en.ics)混入了情人节、万圣节、
//      复活节等几十个"民间节日"，这些日子银行照常营业，若拿来判断工作日会把大量正常日误判为假期。
// 观察日规则(observed): 联邦假期若落在周六 -> 前移到周五; 落在周日 -> 后移到周一。银行按 observed 日休息。

// 计算某年某月的"第 n 个星期 weekday"的日期。weekday: 0=周日 ... 6=周六。n 从 1 开始。
function nthWeekdayOfMonth(year, month0, weekday, n) {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstDow = first.getUTCDay();
  let day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
  return new Date(Date.UTC(year, month0, day));
}

// 计算某年某月"最后一个星期 weekday"的日期。
function lastWeekdayOfMonth(year, month0, weekday) {
  const last = new Date(Date.UTC(year, month0 + 1, 0)); // 当月最后一天
  const lastDow = last.getUTCDay();
  const day = last.getUTCDate() - ((lastDow - weekday + 7) % 7);
  return new Date(Date.UTC(year, month0, day));
}

// 把固定日期的联邦假期，按观察日规则平移(周六->周五, 周日->周一)。
function applyObservedRule(dateUtc) {
  const dow = dateUtc.getUTCDay();
  const shifted = new Date(dateUtc.getTime());
  if (dow === 6) shifted.setUTCDate(shifted.getUTCDate() - 1);      // 周六 -> 周五
  else if (dow === 0) shifted.setUTCDate(shifted.getUTCDate() + 1); // 周日 -> 周一
  return shifted;
}

function toDateStr(dateUtc) {
  const pad = n => ('0' + n).slice(-2);
  return `${dateUtc.getUTCFullYear()}-${pad(dateUtc.getUTCMonth() + 1)}-${pad(dateUtc.getUTCDate())}`;
}

// 生成指定年份的全部美国联邦假期(含观察日)，返回 Set<'YYYY-MM-DD'>。
function generateUsFederalHolidays(year) {
  const set = new Set();
  const addFixed = (month0, day) => {
    // 固定日期类：真实日期 + 观察日都标为休息(银行按 observed 休，但真实日当天很多机构也关，两天都算安全)
    const real = new Date(Date.UTC(year, month0, day));
    set.add(toDateStr(real));
    set.add(toDateStr(applyObservedRule(real)));
  };
  const addFloating = (dateUtc) => set.add(toDateStr(dateUtc));

  addFixed(0, 1);                                    // New Year's Day (1/1)
  addFloating(nthWeekdayOfMonth(year, 0, 1, 3));     // MLK Day (1月第3个周一)
  addFloating(nthWeekdayOfMonth(year, 1, 1, 3));     // Presidents' Day (2月第3个周一)
  addFloating(lastWeekdayOfMonth(year, 4, 1));       // Memorial Day (5月最后一个周一)
  addFixed(5, 19);                                   // Juneteenth (6/19)
  addFixed(6, 4);                                    // Independence Day (7/4)
  addFloating(nthWeekdayOfMonth(year, 8, 1, 1));     // Labor Day (9月第1个周一)
  addFloating(nthWeekdayOfMonth(year, 9, 1, 2));     // Columbus Day (10月第2个周一)
  addFixed(10, 11);                                  // Veterans Day (11/11)
  addFloating(nthWeekdayOfMonth(year, 10, 4, 4));    // Thanksgiving (11月第4个周四)
  addFixed(11, 25);                                  // Christmas (12/25)

  return set;
}

// 对外接口：返回一个 { load(years), isOffDay(dateStr) } 形态的 provider，和 hk/cn 保持一致。
export function createUsHolidayProvider() {
  const holidaySet = new Set();
  return {
    country: 'US',
    async load(years) {
      for (const y of years) {
        for (const d of generateUsFederalHolidays(y)) holidaySet.add(d);
      }
      return { source: 'algorithm(US federal)', ok: true };
    },
    isOffDay(dateStr) {
      return holidaySet.has(dateStr);
    }
  };
}
