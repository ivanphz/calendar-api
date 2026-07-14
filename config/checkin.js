// ============================================================================
// 📁 config/checkin.js —— 签到配置【用户领地：框架更新永不触碰此文件】
// ============================================================================
// 加一个签到站点 = TASK_DICT 加一条。字典结构沿用原程序。
//
// ── 每条任务的字段 ─────────────────────────────────────────────────────────
// 【核心(原程序原样)】
//   name / intervalHours / defaultHour / defaultMinute
//   workdayDelay / holidayDelay        本次落在工作日/节假日时，下次顺延分钟
//   workdayAlarms / holidayAlarms      [日历] VALARM 提前分钟(只管日历通知)
//   emoji / defaultAnchor / actionUrl
//
// 【预留字段(都可省略；为未来组合留好口子)】
//   tags: ['A','life']    视图标签。URL ?tags=A 只出带 A 的；?excludeTags=A 排除带 A 的。
//                         一个链接一种组合，随意搭配出"日历A/B/C"。
//   remind: false         不进闹钟网关(日历照常出)。日历与闹钟解耦的任务级开关。
//   alarmOffsets: [5, 0]  [闹钟] 提前分钟。缺省 = [0] 事件准点一条。
//                         ⚠️ 与日历的 workdayAlarms/holidayAlarms 完全无关。
//   holidayCalendars: ['CHN:bank']  该任务叠加哪些地区假期(缺省 = ['CN'] = 大陆银行口径)。
//                         口径 token 与上游 workdays-core 一词一义:CN≡CN:bank≡CHN:bank(等价),
//                         补班周六算上班日。显式写 :bank 可钉死不被全局 ?cnRule=market 带偏。
//                         多地区叠加(如 ['CHN:bank','HK'])任一地区休息即视为休息日。
//   ext: { ... }          自由扩展对象，框架不读不校验；以后新特性优先往这里放，
//                         老代码零影响(前向兼容约定)。

export const TASK_DICT = {
  "MoeShare": {
    name: "MoeShare本月打卡补贴",
    intervalHours: 720,         // 严格间隔小时数
    defaultHour: 9,             // 跨月或挤压时恢复的默认小时 (0-23)
    defaultMinute: 30,          // 跨月或挤压时恢复的默认分钟 (0-59)
    workdayDelay: 5,            // 当前打卡为工作日时，下次顺延分钟数
    holidayDelay: 10,           // 当前打卡为节假日时，下次顺延分钟数
    emoji: "💰",
    defaultAnchor: "2026-06-01T16:29", // 缺省兜底起始锚点
    actionUrl: "https://moeshare.cc/jobcenter.php?action=list", // 签到直达链接(可选)
    workdayAlarms: [5, 0],      // [日历]工作日：提前5分钟、准点
    holidayAlarms: [1, 0],      // [日历]非工作日：提前1分钟、准点
    holidayCalendars: ['CHN:bank']  // 假期口径:大陆·银行口径(补班周六算上班日)。
                                    // 显式写 :bank 钉死 —— 即使整个链接加了 ?cnRule=market
                                    // 也不会把签到带偏(签到要的就是"补班日照常打卡")。
    // tags: ['A'],
    // remind: false,
    // alarmOffsets: [5, 0],
    // ext: {}
  }
};

// ── 签到域默认参数(?months= 可覆盖跨度；?colorCheckin= 可覆盖颜色) ──
export const CHECKIN_CONFIG = {
  calendarName: '⏰ 周期签到调度',
  color: '#FF9500',
  futureMonths: 12
};
