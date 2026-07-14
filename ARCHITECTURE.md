# 架构书 —— calendar-api v5

> 定位:这是一个**框架**(项目名 calendar-api,曾用名 reminder-hub),后面挂了两个内置域
> (信用卡提醒、签到提醒)。第一原则:**日历是本体,闹钟是附加输出**。JSON 只从同一批
> 推算结果衍生,绝不反向影响 ICS。
>
> 在三层生态中的位置(各层只做自己的事,靠契约通信,互不越界):
>
> ```
> workdays-core (事实层: 多国假期/工作日事实, npm 私有包)
>       ↓ import(进程内现算, 零联网)
> calendar-api  (决策层: 本项目 —— 把"事实"算成"哪一刻该提醒", 出 ICS 日历 + JSON 闹钟)
>       ↓ HTTP GET(?format=json, 闹钟接入协议 v1)
> alarm-api     (执行层: 手机网关 —— 把闹钟点落地成 iPhone 闹钟/设备状态)
> ```
>
> 铁律:本项目**不持有任何假期数据**(事实归上游),也**不输出任何 iPhone 概念**(执行归下游)。

## 1. 目录结构与领地

```
calendar-api/
├─ config/                        ★★ 用户领地:框架更新【永不触碰、永不重新下发】
│  ├─ hub.js                        混册名/色/时区
│  ├─ checkin.js                    签到任务字典 + 签到域默认
│  └─ card.js                       信用卡账户 + DEFAULT_CONFIG + CARD_ALARM
│
├─ src/                           ★ 框架领地:整目录可被更新替换,不含任何用户数据
│  ├─ worker-entry.js               中枢路由:视图组合(cal/exclude/tags)、双输出、诊断、email()转发
│  ├─ registry.js                   域清单(加新域在此注册)
│  └─ domains/
│     ├─ checkin/
│     │  ├─ adapter.js              解析 ?tasks ?months;闹钟策略(准点/脱钩)
│     │  └─ engine.js               720h 漂移+碰撞检测(原逻辑逐行)
│     └─ card/
│        ├─ adapter.js              URL 参数解析 + 编排 + VEVENT 抽取 + 闹钟策略
│        ├─ config.js               ⚠️ 纯转发垫片 → ../../../config/card.js(不放任何值)
│        └─ repay-engine.js / ics-builder.js / email-handler.js
│           / email-parser.js / storage.js        可自由演进的域逻辑(见 PLUGIN-CARD §0)
│
│  (v5 起【没有 src/holidays/】:假期事实全部来自上游 npm 包 @ivanphz/workdays-core,
│   见 §6。要新地区 = 上游加数据集,本库零改动。)
│
├─ test/
│  └─ hub.test.mjs                81 项:信用卡结构自洽 + 领地/视图/闹钟策略 + 口径避让 + 响亮降级
│
├─ docs/
│  ├─ DEVGUIDE.md                 新插件接入手册(自足,三步)
│  ├─ PLUGIN-CARD.md              信用卡域完整手册(模型/主键/email/iOS坑/排查/沿革)
│  ├─ DOWNSTREAM.md               下游 alarm-api 能力册(插件作者视角:能依赖什么)
│  ├─ UPGRADE-V5.md               v4.5 → v5 升级/迁移 runbook(一次性)
│  └─ DEVLOG.md                   开发日志(决策沿革)
│
├─ .github/workflows/
│  ├─ deploy.yml                  push → npm ci → 83 项测试 → wrangler deploy(测试红=不部署)
│  └─ update-core.yml             上游发版 → 自动 bump 依赖并提交 → 触发 deploy
└─ wrangler.toml / package.json
```

**领地规则(铁律)**
1. `config/` 只属于你。加卡、加签到站点、改默认值、打标签,全在这里;框架交付永不包含此目录。
2. `src/` 只属于框架。里面**不允许出现任何配置值**(card/config.js 垫片有测试看守)。
3. 两地之间只有一条通道:`src/domains/card/config.js` 垫片 `export * from '../../../config/card.js'`,
   使原逻辑文件里的 `import './config.js'` 一字不改地继续工作。
4. 信用卡域逻辑(`src/domains/card/`)是**可自由演进的框架代码**,没有"原版冻结"约束
   (v5.2 起移除);改动方式与测试更新见 PLUGIN-CARD §0。

## 2. 数据流(一次请求)

```
URL ──► 中枢: 解析 cal/exclude → 选域;  tags/excludeTags → filters
        │
        ├─ 阶段一  每个域 adapter.prepare(q, 基准日, filters, env)
        │            · 域内自治解析【自己的】URL 参数(默认值来自 config/<域>.js)
        │            · 应用 tags 过滤到自己的条目
        │            · 报出需要的 地区×年份
        │
        ├─ 中枢: createHolidayHub(地区并集, 年份并集)   ← 来自上游 workdays-core:
        │         打包内置数据、零联网、进程内现算;loadLogs + coverage 缺口进诊断
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
  (这条规范的下游依据 —— 网关拼名机制 —— 见 docs/DOWNSTREAM.md。)
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
| 中枢·计算 | `?cnRule=bank\|market` | 裸 `'CN'` 的工作日口径全局默认。bank(缺省)=调休那套;market=补班周末视为休息(股市/清算)。条目级 token(`'CN:market'`/`'CN:bank'`)优先于此。⚠️ v5 废除 `official`:传旧值不崩,按 bank 处理并在诊断响亮告警 |
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

## 6. 假期事实与口径(上游 workdays-core)

**v5 起,假期这件事本库只剩两个动作:报需求(prepare 返回 countries/years)、拿判断器
(hub.makeWorkdayChecker)。** 数据、抓取、归档、observed 顺延、调休三态、NYSE 例外规则,
全部住在上游 `@ivanphz/workdays-core`(GitHub Packages 私有包;上游契约见其 docs/INTEGRATION.md)。

**消费面速查(受上游 semver 保护,patch/minor 永不破坏)**:
- `createHolidayHub(tokens, years, { cnDefaultRule })` → `{ makeWorkdayChecker, loadLogs, coverage, … }`
- `makeWorkdayChecker(tokens)` → `(Date|'YYYY-MM-DD') => boolean`,多地区叠加:**任一地区休息即休息**;
  空列表默认 `['CN']`。
- 词汇一词一义(完整表见 DEVGUIDE §5.5):`CN|CN:bank|CN:market`、`US|US:bank|US:market`、
  `HK|HK:public`;alpha-3 等价;上游另有 GB/SG。**未知地区/未知口径不崩:按默认口径或纯周末
  兜底,且必在诊断告警**(响亮降级,配置错误绝不静默)。
- **coverage 上屏**:某地区×年份无真实数据(公告未发/归档缺失)时上游按纯周末兜底,本库把
  `coverage.ok=false` 逐条渲染成诊断告警行 `⚠️ [CN 2027] 无真实数据(fallback)…` —— 上游出错、
  上游有缺口、词汇写错,一律在日历诊断事件里看得见。
- 升级链路:上游发版 → repository_dispatch → 本库 update-core.yml 自动 bump 并提交 →
  deploy.yml 跑 83 项测试后部署。节假日公告更新全程无人值守直达线上。

### 6.1 CN 双口径(bank / market)

大陆独有"调休补班":周末被官方标为上班,但**A 股不开市、跨行清算按周末档**。三级优先:
**条目 token(`'CN:market'`/`'CN:bank'`) > `?cnRule=` > 缺省 bank**。

| 口径 | 法定假 | 补班周末 | 普通周末 | 适用 |
|---|---|---|---|---|
| bank(默认) | 休 | **上班** | 休 | 网点办事、上班族日程(即原 official 行为,分毫未动) |
| market | 休 | **休** | 休 | 转账清算、股市、还款(工作日=周一至五且非法定假) |

### 6.2 US 双日历(`'US:market'`)

美国"银行日历 ≠ 股市日历",且**双向不同**:

| | Good Friday | Columbus / Veterans Day | 元旦落周六 |
|---|---|---|---|
| `US`(银行/联邦,默认) | **开** | **休** | 前一周五 observed **休** |
| `US:market`(NYSE) | **休** | **开** | 前一周五(12/31) **开**(NYSE 例外规则) |

正因为双向不同,US **刻意不提供全局默认切换**(无 `?usRule`):market 会把银行休息日判为
工作日,全局切换会让还款提醒踩空。`'US:market'` 只允许**条目级显式声明**,用于交易类场景;
还款/转账一律用 `'US'`。半日市(感恩节次日等)视为开市。
交易+还款全链场景用三叠 `['CN','US','US:market']`(任一腿休即休),配方与依据见
DEVGUIDE"口径组合配方",测试 H 组钉死。

### 6.3 HK(单口径)

港交所日历 ≈ 公众假期 + 周末,与银行无背离(半日市视为开市),故只有一种口径:
`'HK'` / `'HK:public'`。v4.3 曾把 `'HK:market'/'HK:official'` 立为等价别名,**v5 已随上游
词汇统一而废除**(写了不崩,退默认口径 + 响亮告警);决策沿革见 DEVLOG v5.0。

## 7. 信用卡域的演进(为什么没有金标准冻结)

原信用卡项目 repayment-cal 已在 GitHub **归档(archived,只读)**,历史存档职责归那个仓库。
早期版本(v3~v5)曾在本库 `test/golden/` 冻结原版逐字节副本作金标准,以证明"从独立项目搬进
框架时逻辑没搬歪"。**v5.2 起移除该机制**,原因很直接:迁移正确性是**一次性**的证据,而信用卡
逻辑是框架里**长期要演进**的一等公民 —— 把它焊死在"原版不可改"上,等于宣布用户不能再改自己
的信用卡逻辑,荒谬。移除后:

- 信用卡逻辑(`src/domains/card/`)与任何插件一样可自由改。改动方式见 PLUGIN-CARD §0。
- 正确性改由**行为/结构断言**守护,而非"与原版逐行相等":
  A 组(事件结构自洽:该出的账户出、该合并的合并、VALARM 符合配置)、
  E~H 组(口径避让/双日历/三叠端到端,用真实归档日期钉死)、I 组(插件契约)。
  这些断言校验的是"逻辑对不对",不是"和原版一不一样",所以你改逻辑时更新对应断言即可,
  不会有"改了就假红"的枷锁。
- 破坏性变更(改字段名/URL/输出结构)记 DEVLOG,并尽量给旧名留兼容别名
  (如 v5.2 把 `adAlarms/exAlarms` 更名 `allDayReminders/exactReminders`,旧 URL 参数仍兼容)。
