// ==========================================
// 🇭🇰 香港公众假期 (抓取香港政府 1823 官方 ics 并解析)
// ==========================================
// 为什么用政府源而不用苹果的 HK_zh.ics:
//   香港假期含农历(春节/清明/端午/中秋/重阳)，无法用纯算法生成，必须靠数据源。
//   - 政府 1823 源(1823.gov.hk): 每条都是真正的法定公众假期，逐年展开、无 RRULE 重复规则，干净可靠。
//   - 苹果 HK_zh.ics: 混入了"小寒/大寒"等节气(银行照常上班)，且用 RRULE 重复规则，解析复杂且会误判。
// 因此这里锁定政府源。政府源是标准 ics(VALUE=DATE 的全天 VEVENT)，我们只需扫 DTSTART 即可。

// 政府源官方地址(en 英文版即可，我们只取日期不取名称)。用多个入口做高可用:
// 直连官方 + 两个通用 CORS/镜像代理兜底(若某入口被墙或超时，自动尝试下一个)。
const HK_HOLIDAY_URLS = [
  'https://www.1823.gov.hk/common/ical/en.ics',
  'https://r.jina.ai/https://www.1823.gov.hk/common/ical/en.ics' // 只读代理兜底
];

// 从 ics 文本里抽取所有 DTSTART;VALUE=DATE:YYYYMMDD 的日期，转成 'YYYY-MM-DD'。
function parseIcsDates(icsText) {
  const dates = new Set();
  // 匹配 DTSTART;VALUE=DATE:20250101 或 DTSTART:20250101 两种写法
  const re = /DTSTART[^:\r\n]*:(\d{8})/g;
  let m;
  while ((m = re.exec(icsText)) !== null) {
    const raw = m[1];
    dates.add(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
  }
  return dates;
}

export function createHkHolidayProvider() {
  const holidaySet = new Set();
  return {
    country: 'HK',
    async load(years) {
      // 政府 ics 一份就包含多年数据，只需拉一次，不必按年循环。years 参数保留以对齐接口。
      for (const url of HK_HOLIDAY_URLS) {
        try {
          const resp = await fetch(url);
          if (resp.ok) {
            const text = await resp.text();
            const parsed = parseIcsDates(text);
            if (parsed.size > 0) {
              for (const d of parsed) holidaySet.add(d);
              return { source: `1823.gov.hk via ${new URL(url).host}`, ok: true, count: parsed.size };
            }
          }
        } catch (e) { /* 尝试下一个入口 */ }
      }
      // 全部失败：降级为"仅周末"，不抛错，避免整个日历生成崩溃
      return { source: 'HK holiday fetch FAILED -> weekend-only fallback', ok: false };
    },
    isOffDay(dateStr) {
      return holidaySet.has(dateStr);
    }
  };
}
