// ============================================================================
// 📁 config.js —— 日常维护唯一需要修改的文件 (加卡 / 改还款日 / 调闹钟 都在这)
// ============================================================================
//
// 【核心概念：账单账户 account，不是"卡"】
//   本系统追踪的单位是"一个独立账单"，不是一张物理卡。
//   - 招行 5 张卡合并成 1 个账单 -> 只需 1 个 account 条目(还 1 次款)。
//   - 汇丰 Pulse 一卡出港币+人民币两个账单 -> 需 2 个 account 条目(还 2 次款)，
//     两条除 repayCurrency 外几乎相同，靠币种自动区分主键，不会冲突。
//   - 若某银行几张卡分开出账单 -> 每张卡一个 account 条目。
//
// 【accountId 自动生成，你不用填】
//   系统用 country + bankShortName + cardName + repayCurrency + last4 组合自动生成唯一主键，
//   即使 last4 留空(合并账单没有单一卡号)，靠前几段也能保证唯一。你只管填基础数据即可。
//
// 【每个字段会出现在哪里 —— 加卡/改卡前先看这里】
//   ┌ 字段              显示位置
//   │ bankShortName     [日历标题]    银行简称/缩写，标题里就显示这个，越短越好(你自己定中英文)
//   │ bankFullName      [事件正文]    银行全称，只在点开事件后的详情里出现
//   │ cardName          [标题+正文]   产品/账户名，标题里在银行简称后括号显示，正文也显示
//   │ last4             [事件正文]    卡号后四位或账户标识；合并账单可留空("")，不影响主键唯一性
//   │ emoji             [日历标题]    国旗，标题里显示，一眼看出国家
//   │ countryLabel      [事件正文]    地区中文名，正文显示
//   │ repayCurrency     [标题旁+正文] 本账单要还进去的货币(见下)，提醒你"还什么币种"
//   │ 其它(model/日期)  不显示        纯计算用
//   └
//
// 【货币 repayCurrency】
//   表示"这个账单你要还进去哪种货币"，不是这张卡能刷几种币。
//   - 单币账单: repayCurrency: 'CNY'  (还人民币)
//   - Pulse 港币账单: 'HKD'; Pulse 人民币账单: 'CNY' (拆成两个 account)
//   currencySymbol 会根据代码自动映射(见文件底部 CURRENCY_SYMBOLS)，标题旁显示符号更直观。
//
// 【购汇卡接口(暂未启用)】
//   若将来有"需要先购汇、还入外币、币种不定"的卡，用 needsFxPurchase / fxNote 两个字段。
//   目前不写任何逻辑，只是把接口预留好，遇到时再启用。
//
// 【账单日模型 model: 'legacy' / 'cycle' / 'email'】
//   'legacy' (旧模型，简单)：repayDay = 每月固定还款日(数字)。适合中国大陆固定还款日的卡。
//            月末边界规则：若该日在当月不存在(如2月没有29号)，顺延到下月对应溢出日(29号->3月1日)，
//            不再像老版本那样压缩到月末，避免"提前还款"和"和28号卡撞车"。
//   'cycle'  (新模型，精确)：statementDay = 账单日 + graceDays = 还款期限天数。
//            最终还款日 = 账单日 + graceDays。适合"账单日 + N天期限"的卡，天然规避2月天数问题。
//   'email'  (实测模型，最精确)：还款日来自邮件实测记录(Cloudflare Email Routing 收信 -> 解析 -> KV)。
//            不猜测、不外推——只提醒"最近一封账单邮件"对应的这一期，下期等下封邮件到达后自动出现。
//            需要额外字段: emailDateOffsetDays(收件日减几天推定账单日，默认2)、
//                          emailGraceDays(账单日加几天为还款日，默认21)。
//            需要部署侧配置: KV 绑定 + Email Routing 转发规则 + EXPECTED_RECIPIENT Secret，见 README。
//
// 【假期叠加 holidayCalendars】
//   数组，列出这张卡还款需要"同时在线"的国家。任一国放假，还款日就往前避让。
//   CN 卡: ['CN']   HK 卡: ['CN','HK']   US 卡: ['CN','US']
//
// 【advanceDays】提前几个工作日提醒还款(在 holidayCalendars 定义的合并工作日历上倒推)。
// ============================================================================

export const ACCOUNTS = [
  // ---------- 🇨🇳 中国大陆账户 (旧模型过渡中) ----------
  {
    isActive: true,
    bankShortName: 'CMB',            // [标题]
    bankFullName: '招商银行',         // [正文]
    cardName: 'Young/VISA/JCB',      // [标题+正文] 合并账单：这里写清是哪几张卡合出的账单
    last4: '',                       // [正文] 合并账单无单一卡号，留空即可
    emoji: '🇨🇳',
    country: 'CN',
    countryLabel: '中国大陆',
    repayCurrency: 'CNY',            // [标题旁+正文]
    holidayCalendars: ['CN'],
    model: 'legacy',
    repayDay: 28,
    advanceDays: 2,
    needsFxPurchase: false,          // 预留接口，暂不启用
    fxNote: ''
  },
  {
    isActive: true,
    bankShortName: 'HSBC-CN',
    bankFullName: '汇丰中国',
    cardName: 'Master/UnionPay',
    last4: '',
    emoji: '🇨🇳',
    country: 'CN',
    countryLabel: '中国大陆',
    repayCurrency: 'CNY',
    holidayCalendars: ['CN'],
    model: 'legacy',
    repayDay: 25,
    advanceDays: 2,
    needsFxPurchase: false,
    fxNote: ''
  },
  {
    isActive: true,
    bankShortName: 'PAB',
    bankFullName: '平安银行',
    cardName: '一账通',
    last4: '',
    emoji: '🇨🇳',
    country: 'CN',
    countryLabel: '中国大陆',
    repayCurrency: 'CNY',
    holidayCalendars: ['CN'],
    model: 'legacy',
    repayDay: 28,
    advanceDays: 2,
    needsFxPurchase: false,
    fxNote: ''
  },

  // ---------- 🇭🇰 香港账户 (旧模型过渡；规律清楚后可逐条切到 model:'cycle') ----------
  // Pulse 是"一卡两账单"：港币账单 + 人民币账单，账单日相同，需各还一次。拆成两条，靠 repayCurrency
  // 自动区分主键，不会覆盖。以后想精确，把 model 改 'cycle' 并填 statementDay/graceDays 即可。
  {
    isActive: true,
    bankShortName: 'HSBC-HK',
    bankFullName: '汇丰香港',
    cardName: 'Pulse',
    last4: '8532',
    emoji: '🇭🇰',
    country: 'HK',
    countryLabel: '中国香港',
    repayCurrency: 'HKD',            // 港币账单
    holidayCalendars: ['CN', 'HK'],
    model: 'legacy',
    repayDay: 29,
    advanceDays: 3,
    needsFxPurchase: false,
    fxNote: ''
  },
  {
    isActive: true,
    bankShortName: 'HSBC-HK',
    bankFullName: '汇丰香港',
    cardName: 'Pulse',
    last4: '8532',
    emoji: '🇭🇰',
    country: 'HK',
    countryLabel: '中国香港',
    repayCurrency: 'CNY',            // 人民币账单(同卡的第二个账单)
    holidayCalendars: ['CN', 'HK'],
    model: 'legacy',
    repayDay: 29,
    advanceDays: 3,
    needsFxPurchase: false,
    fxNote: ''
  },
  {
    isActive: true,
    bankShortName: 'HSBC-HK',
    bankFullName: '汇丰香港',
    cardName: 'Red',
    last4: '9758',
    emoji: '🇭🇰',
    country: 'HK',
    countryLabel: '中国香港',
    repayCurrency: 'HKD',
    holidayCalendars: ['CN', 'HK'],
    model: 'legacy',
    repayDay: 29,
    advanceDays: 3,
    needsFxPurchase: false,
    fxNote: ''
  },
  {
    isActive: false,
    bankShortName: 'HSBC-HK',
    bankFullName: '汇丰香港',
    cardName: '卓越',
    last4: '5136',
    emoji: '🇭🇰',
    country: 'HK',
    countryLabel: '中国香港',
    repayCurrency: 'HKD',
    holidayCalendars: ['CN', 'HK'],
    model: 'legacy',
    repayDay: 29,
    advanceDays: 3,
    needsFxPurchase: false,
    fxNote: ''
  }

  // ---------- 🇺🇸 美国账户示例 (以后办卡后取消注释并填真实数据) ----------
  // 美国卡建议直接用新模型 'cycle'(账单日 + 还款期限)，规避 2 月天数问题。
  // ,{
  //   isActive: true,
  //   bankShortName: 'BofA',
  //   bankFullName: 'Bank of America',
  //   cardName: 'Travel Rewards',
  //   last4: '1234',
  //   emoji: '🇺🇸',
  //   country: 'US',
  //   countryLabel: '美国',
  //   repayCurrency: 'USD',
  //   holidayCalendars: ['CN', 'US'],
  //   model: 'cycle',
  //   statementDay: 5,      // 账单日
  //   graceDays: 21,        // 还款期限天数 -> 最终还款日 = 账单日 + 21 天
  //   advanceDays: 3,
  //   needsFxPurchase: true,  // 需购汇还入外币
  //   fxNote: '需提前购汇 USD 还入'
  // }

  // ---------- 📧 email 模型示例 (香港卡以后切换用；把某张卡的 model 改成 'email' 即可) ----------
  // 前提: 已按 README 配好 KV 绑定 + Email Routing + EXPECTED_RECIPIENT Secret。
  // 切换后该卡不再按月生成事件，而是每收到一封账单邮件、生成一期精确提醒。
  // 匹配逻辑靠 last4: 邮件正文里的 XXXX-XXXX-XXXX-8532 会命中 last4:'8532' 的账户(可多张同时命中)。
  // ,{
  //   isActive: true,
  //   bankShortName: 'HSBC-HK',
  //   bankFullName: '汇丰香港',
  //   cardName: 'Pulse',
  //   last4: '8532',            // ⚠️ email 模型必填，这是邮件->账户的匹配键
  //   emoji: '🇭🇰',
  //   country: 'HK',
  //   countryLabel: '中国香港',
  //   repayCurrency: 'HKD',
  //   holidayCalendars: ['CN', 'HK'],
  //   model: 'email',
  //   emailDateOffsetDays: 2,   // 收件日减2天推定账单日(以后积累数据可调，见 email-parser.js 的口子)
  //   emailGraceDays: 21,       // 账单日+21天为还款日(以后按实测调，Pulse实测约24、Red约26)
  //   advanceDays: 3,
  //   needsFxPurchase: false,
  //   fxNote: ''
  // }
];

// ============================================================================
// ⚙️ 全局默认参数 (改这里影响所有账户；单条 URL 参数可临时覆盖)
// ============================================================================
export const DEFAULT_CONFIG = {
  calendarName: '💳 信用卡还款提醒',
  titlePrefix: '💳Repay',   // 所有事件标题统一前缀，通知栏一眼识别(即使标题被截断)
  displayMode: 'exact',     // 'exact'(带时刻) 或 'allday'(全天，闹钟跟随设备时区) —— 你的默认: exact
  mergeSameDay: true,       // 是否合并同一天的多个账单为一个事件 —— 你的默认: 合并
  mergeTitleShowCount: 2,   // 合并标题最多展示几个"银行分段"，超出折叠成"等N笔"
  maxDistinctBanksInTitle: 2, // 合并标题里不同银行数超过此值 -> 降级为纯国家聚合(🇨🇳×2 🇭🇰×3)
  pastMonths: 3,
  futureMonths: 12,

  // exact 模式参数
  targetChinaHour: 9,
  targetChinaMinute: 30,
  exactDurationMin: 360,

  // 闹钟(两个数组都支持任意数量)
  adAlarms: [               // allday 模式：相对提醒日午夜的偏移
    { dayOffset: -1, hour: 20, minute: 0 },
    { dayOffset: 0, hour: 9, minute: 30 }
  ],
  exAlarms: [               // exact 模式：提前分钟数
    { minutesBefore: 1 }
  ],

  holidayExtraAdvance: 1,   // 名义还款日恰逢休息日时，额外多提前几个工作日。范围 0 或 1
  baseTimezone: 'Asia/Shanghai'
};

// 货币代码 -> 符号，标题旁/正文展示用。缺失的代码回退显示代码本身。
export const CURRENCY_SYMBOLS = {
  CNY: '¥',
  HKD: 'HK$',
  USD: 'US$',
  GBP: '£',
  EUR: '€',
  JPY: '¥'
};

// ============================================================================
// 🔔 闹钟网关接入配置 (只影响 ?format=json 输出；ICS 日历【完全】不受影响)
// ============================================================================
// 日历是本体，闹钟是附加输出 —— 本段与上面的日历配置互不干涉。
//
// alarmMode 三档 (URL ?cardAlarm=merged|each|off 可临时覆盖)：
//   'merged' (默认) 同一天所有还款 = 一条闹钟。不管日历合不合并，同一时刻绝不响多条。
//   'each'          每笔账单一条闹钟(可单独勾销)。
//   'off'           信用卡完全不进闹钟网关(仅日历)。
// 响铃时刻 = 上面的 targetChinaHour/Minute (?ch= ?cm= 照常可调)。
// 单卡豁免：想让某张卡不进闹钟，在它的账户条目里加 remind: false 即可(日历照常出)。
export const CARD_ALARM = {
  alarmMode: 'merged'
};
