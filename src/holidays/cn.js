// ==========================================
// 🇨🇳 中国大陆法定节假日 (抓取 NateScarlet/holiday-cn 数据)
// ==========================================
// 沿用重构前已验证可靠的数据源。这份数据含调休逻辑(isOffDay 会把"周末补班日"标为工作日、
// 把"调休放假日"标为休息)，比单纯判断周末更准确。多 CDN 入口做高可用。

const CN_HOLIDAY_URLS = [
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json'
];

export function createCnHolidayProvider() {
  // 这里用 Map 存储：dateStr -> isOffDay(true=放假, false=补班上班)
  // 注意语义和 hk/us 略有不同：cn 源同时告诉你"哪些周末要补班"，所以存布尔而非只存假期集合。
  const dayMap = new Map();
  const logs = [];

  const fetchYear = async (year) => {
    for (const tpl of CN_HOLIDAY_URLS) {
      try {
        const resp = await fetch(tpl.replace('{year}', year));
        if (resp.ok) {
          const data = await resp.json();
          data.days.forEach(d => dayMap.set(d.date, d.isOffDay));
          logs.push(`[CN ${year}] via ${new URL(tpl.replace('{year}', year)).host}`);
          return true;
        }
      } catch (e) { /* try next */ }
    }
    logs.push(`[CN ${year}] fetch FAILED -> weekend-only fallback`);
    return false;
  };

  return {
    country: 'CN',
    async load(years) {
      await Promise.all(years.map(fetchYear));
      return { source: logs.join('; '), ok: true };
    },
    // 返回 true/false/undefined:
    //   true  = 这天是法定假期(放假)
    //   false = 这天是调休补班(虽是周末但要上班)
    //   undefined = 数据里没有，交给调用方按默认周末规则判断
    lookup(dateStr) {
      return dayMap.get(dateStr);
    },
    // 为对齐统一接口也提供 isOffDay：仅返回"是否明确为假期"
    isOffDay(dateStr) {
      return dayMap.get(dateStr) === true;
    }
  };
}
