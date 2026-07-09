# 架构书 —— reminder-hub v4

> 定位:这是一个**框架**,后面挂了两个内置域(信用卡提醒、签到提醒)。
> 第一原则:**日历是本体,闹钟是附加输出**。JSON 只从同一批推算结果衍生,绝不反向影响 ICS。

## 1. 目录结构与领地

```
reminder-hub/
├─ config/                        ★★ 用户领地:框架更新【永不触碰、永不重新下发】
│  ├─ hub.js                        混册名/色/时区
│  ├─ checkin.js                    签到任务字典 + 签到域默认
│  └─ card.js                       信用卡账户 + DEFAULT_CONFIG + CARD_ALARM
│                                   (= 你原项目 config.js 原文 + 尾部追加闹钟段;
│                                      默认值按你指示: exact + 合并)
│
├─ src/                           ★ 框架领地:整目录可被更新替换,不含任何用户数据
│  ├─ worker-entry.js               中枢路由:视图组合(cal/exclude/tags)、双输出、诊断、email()转发
│  ├─ registry.js                   域清单(加新域在此注册)
│  ├─ holidays/                     假期数据源(index/cn/hk/us,原文件 verbatim,全域共享)
│  └─ domains/
│     ├─ checkin/
│     │  ├─ adapter.js              解析 ?tasks ?months;闹钟策略(准点/脱钩)
│     │  └─ engine.js               720h 漂移+碰撞检测(原逻辑逐行)
│     └─ card/
│        ├─ adapter.js              原 worker-entry 编排逐行搬 + VEVENT 抽取 + 闹钟策略
│        ├─ config.js               ⚠️ 纯转发垫片 → ../../../config/card.js(不放任何值)
│        └─ repay-engine.js / ics-builder.js / email-handler.js
│           / email-parser.js / storage.js        ★ 原项目文件,逐字节 verbatim
│
├─ docs/DEVLOG.md                 开发日志(决策沿革)
├─ docs/DEVGUIDE.md               新子项目接入手册(三步)
├─ test/hub.test.mjs              37 项:金标准等价 + 领地 + 视图组合 + 闹钟策略
└─ wrangler.toml / package.json / .github/workflows/deploy.yml
```

**领地规则(铁律)**
1. `config/` 只属于你。加卡、加签到站点、改默认值、打标签,全在这里;框架交付永不包含此目录。
2. `src/` 只属于框架。里面**不允许出现任何配置值**(card/config.js 垫片有测试看守)。
3. 两地之间只有一条通道:`src/domains/card/config.js` 垫片 `export * from '../../../config/card.js'`,
   使原逻辑文件里的 `import './config.js'` 一字不改地继续工作。

## 2. 数据流(一次请求)

```
URL ──► 中枢: 解析 cal/exclude → 选域;  tags/excludeTags → filters
        │
        ├─ 阶段一  每个域 adapter.prepare(q, 基准日, filters)
        │            · 域内自治解析【自己的】URL 参数(默认值来自 config/<域>.js)
        │            · 应用 tags 过滤到自己的条目
        │            · 报出需要的 国家×年份
        │
        ├─ 中枢: createHolidayHub(国家并集, 年份并集)   ← 假期只加载一次,全域共享
        │
        ├─ 阶段二  每个域 adapter.build(state, env, hub, dtStamp, 北京时间)
        │            ① eventLines  日历本体(域自己生成;信用卡=原版 buildCalendar 输出抽取)
        │            ② alarms      附加输出(只读推算结果 items/occurrences,绝不写回)
        │            ③ debugLines  诊断段(生效参数 + 域状态)
        │
        └─ 中枢: format=ics → VCALENDAR 包装(册名/颜色) + 诊断事件 + 拼接各域 events
                 format=json → 汇总 alarms → 只留未来 → 排序 → { v:1, alarms }
```

## 3. 适配器契约(域必须实现)

```js
export const xxxDomain = {
  id: 'xxx',
  calName: '…',            // 单独订阅该域时的册名
  defaultColor: '#RRGGBB', // 单独订阅时整册色(?colorXxx= 可覆盖)

  prepare(q, baseDateObj, filters, env) {          // 可为 async,框架一律 await
    // filters = { tags: string[], excludeTags: string[] };env = CF 绑定(KV/Secret)
    return { countries: ['CN'], years: [2026], state: {/* 域内私有 */} };
  },

  async build(state, env, hub, dtStamp, beijingTimeStr) {
    return {
      eventLines: [/* 完整 BEGIN:VEVENT..END:VEVENT 行 */],
      alarms:     [/* {uid,date:'YYYY-MM-DD',time:'HH:MM',reason} */],
      debugLines: [/* 诊断段落 */]
    };
  }
};
```

约束:
- **uid 协议 v1**:`{域}-{实例}-{周期桶}`,纯 ASCII,**不含时钟时间**;bucket 锚定"哪件事"
  (信用卡=账单月),不锚定"哪天响"→ 改提前量/假期漂移,uid 不变、只有 time 变,网关不抖。
- alarms 允许为空数组(纯日历域);eventLines 允许为空(纯闹钟域,理论上)。
- alarm 条目字段**原样透传**(uid/date/time/reason 之外的协议可选字段如 tz 一并输出);
  框架只做按日未来过滤 + 排序 + 包 v:1。
- **故障隔离**:域 prepare/build 抛异常仅熔断该域 —— ICS 出哨兵事件
  `❌ 域 xxx 构建失败`(不受 ?debug=0 影响),JSON 静默剔除,其它域照常。
- 域之间互不 import;共享物只有 holidays hub 与中枢传入的上下文。

## 4. 参数矩阵(三层,互不越界)

| 层 | 参数 | 说明 |
|---|---|---|
| 中枢·视图 | `?cal=` `?exclude=` `?tags=` `?excludeTags=` | 一条链接一种组合;tags 是选择型(严格命中),excludeTags 是排除型(不伤未打标签者) |
| 中枢·输出 | `?format=ics\|json` `?testDate=` `?debug=0` `?colorCheckin= ?colorCard= ?color=` | 日历缺省;testDate 同时作用推算基准与 JSON 未来过滤 |
| 中枢·计算 | `?cnRule=official\|market` | CN 工作日口径全局默认。official(缺省)=调休那套;market=补班周末视为休息(股市/清算)。条目级 `holidayCalendars:['CN:market']` 优先于此 |
| 签到域 | `?tasks=ID\|锚点,…` `?months=` | 原程序参数原语义 |
| 信用卡域 | `?mode= ?merge= ?past= ?future= ?adAlarms= ?exAlarms= ?durationMin= ?mergeTitleShowCount= ?ch= ?cm=` + `?cardAlarm=merged\|each\|off` | 前十个与原项目逐字一致;cardAlarm 只影响 JSON |

## 5. 日历↔闹钟解耦矩阵

| 开关 | 位置 | 影响日历? | 影响闹钟? |
|---|---|---|---|
| `isActive:false` | 账户/任务条目 | ✅ 移除 | ✅ 移除 |
| `tags` + URL 视图 | 条目 + 链接 | ✅ 按链接 | ✅ 按链接(JSON 链接自己选自己的视图) |
| `remind:false` | 账户/任务条目 | ❌ 照常出 | ✅ 该条不进网关 |
| `CARD_ALARM.alarmMode` / `?cardAlarm` | config/card.js | ❌ | ✅ merged/each/off |
| `alarmOffsets` | 签到任务 | ❌ | ✅ 缺省准点一条,配置才提前 |
| `workdayAlarms/holidayAlarms/adAlarms/exAlarms` | 日历侧 | ✅ VALARM | ❌ 与闹钟无关 |

ICS 链接与 JSON 链接是两条独立 URL,各自组合视图 —— "链接"与"是否闹钟"天然解耦。

## 6. CN 双口径(调休 vs 市场)

大陆独有"调休补班":周末被官方标为上班,但**A 股不开市、跨行清算按周末档**。因此 CN 工作日
判定提供两种口径,三级优先:**条目 token(`'CN:market'`/`'CN:official'`) > `?cnRule=` > 缺省 official**。

| 口径 | 法定假 | 补班周末 | 普通周末 | 适用 |
|---|---|---|---|---|
| official(默认) | 休 | **上班** | 休 | 网点办事、上班族日程(原行为) |
| market | 休 | **休** | 休 | 转账清算、股市、还款(工作日=周一至五且非法定假) |

**HK 口径别名**:`'HK:market'` / `'HK:official'` ≡ `'HK'`(受支持的等价别名,有测试看守)。
港交所日历 ≈ 公众假期 + 周末,与银行无背离(半日市视为开市),故两口径天然重合;
三国 token 语法就此拉齐:CN 换规则、US 换日历、HK 同一份。

**US 双日历(`'US:market'` 已实现)**:美国"银行日历 ≠ 股市日历",且**双向不同**:

| | Good Friday | Columbus / Veterans Day | 元旦落周六 |
|---|---|---|---|
| `US`(银行/联邦,默认) | **开** | **休** | 前一周五 observed **休** |
| `US:market`(NYSE) | **休** | **开** | 前一周五(12/31) **开**(NYSE 例外规则) |

正因为双向不同,US **刻意不提供全局默认切换**(无 `?usRule`):market 会把银行休息日判为
工作日,全局切换会让还款提醒踩空。`'US:market'` 只允许**条目级显式声明**,用于交易类场景;
还款/转账一律用 `'US'`。半日市(感恩节次日等)视为开市。数据零依赖(含复活节 Computus 算法),
实现在 `src/holidays/us-market.js`,与 us.js 并存互不影响。
交易+还款全链场景用三叠 `['CN','US','US:market']`(任一腿休即休),配方与依据见
DEVGUIDE"口径组合配方",测试 H 组钉死。
