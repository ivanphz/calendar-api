# 架构书 —— calendar-api v6

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

## 0. v6 总纲(先读这一句)

> **框架吃语法,域吃语义。**

- **域**交出"发生了什么":哪一刻(墙上时间 + IANA 时区名)、什么标题、什么正文、想在什么时候
  被提醒 —— 全部是**原始语义值**(真实换行、真实逗号、分钟数)。
- **框架**负责"怎么写成 ICS":转义、折行、DTSTART/VALARM 语法、时区标注、VCALENDAR 信封。

**石蕊测试**(裁决任何一行代码归谁):
*"如果哪天输出格式从 ICS 换成 Google Calendar API,这行代码要不要动?"* 要动=框架;不动=域。

**红线**:框架**永远不做业务合并**。"同日 3 笔账单合成一件事"是域的业务决策 —— 域先合并、
再交一个事件对象;框架看到的永远是"最终要出现在日历上的事件清单",一对一渲染,不增不减不并。

**v5 → v6 的根本变化**:域不再产 ICS 文本。v5 的 `eventLines: string[]` 是个黑箱 ——
框架看不见 date/uid,想管也管不了(所以 v5 的"总控"只存在于结构化的闹钟侧)。
**总控能力 = 契约透明度的函数**。契约详见 **docs/EVENT-MODEL.md**(宪法,唯一真相源)。

## 1. 目录结构与领地

```
calendar-api/
├─ config/                        ★★ 用户领地:框架更新【永不触碰、永不重新下发】
│  ├─ hub.js                        混册名/色/时区 + 中枢窗口缺省(past/futureMonths)
│  ├─ checkin.js                    签到任务字典 + 签到域默认
│  └─ card.js                       信用卡账户 + DEFAULT_CONFIG + CARD_ALARM
│
├─ src/                           ★ 框架领地:整目录可被更新替换,不含任何用户数据
│  ├─ worker-entry.js               中枢路由:视图组合、窗口下发、双输出、诊断、email()转发
│  │                                【零 ICS 字符串】—— 渲染与治理全部委托下面两个文件
│  ├─ renderer.js                   ICS 语法【唯一产地】+ 所有 iOS 血债的唯一收容所(§7)
│  ├─ governance.js                 框架长牙处:窗口裁剪 / uid 双协议校验 / uidHash / 超时预算
│  ├─ registry.js                   域清单(加新域在此注册)+ 契约速查
│  └─ domains/
│     ├─ checkin/
│     │  ├─ adapter.js              解析 ?tasks;窗口 MAP;闹钟策略(准点/脱钩)
│     │  └─ engine.js               720h 漂移+碰撞检测(推算数学逐行原样)
│     └─ card/
│        ├─ adapter.js              URL 参数解析 + 编排 + 闹钟策略
│        ├─ config.js               ⚠️ 纯转发垫片 → ../../../config/card.js(不放任何值)
│        └─ repay-engine.js / event-builder.js / email-handler.js
│           / email-parser.js / storage.js        可自由演进的域逻辑(见 PLUGIN-CARD §0)
│
│  (v5 起【没有 src/holidays/】:假期事实全部来自上游 npm 包 @ivanphz/workdays-core,见 §6。
│   v6 起【域目录里没有任何 ICS 关键字】:领地看守测试盯着,见 §8。)
│
├─ test/
│  ├─ render.test.mjs             72 项 · 框架层:渲染器/治理/uidHash/领地看守。
│  │                                【零外部依赖】—— 不 import 上游、不起 worker,先跑、快速失败
│  └─ hub.test.mjs                113 项 · 域层:结构自洽 + 领地/视图/窗口总控 + 闹钟策略
│                                  + 口径避让 + 响亮降级 + 插件契约(需上游真实数据)
│
├─ docs/
│  ├─ EVENT-MODEL.md              ★ 事件模型契约(v6 宪法;域↔框架的唯一真相源)
│  ├─ DEVGUIDE.md                 新插件接入手册(自足,三步)
│  ├─ PLUGIN-CARD.md              信用卡域完整手册(模型/身份/email/iOS坑/排查/沿革)
│  ├─ DOWNSTREAM.md               下游 alarm-api 能力册(插件作者视角:能依赖什么)
│  ├─ UPGRADE-V5.md               v4.5 → v5 升级 runbook(一次性,已完成)
│  ├─ UPGRADE-V6.md               v5 → v6 升级 runbook(一次性;破坏性变更与链接盘点)
│  └─ DEVLOG.md                   开发日志(决策沿革)
│
├─ .github/workflows/
│  ├─ deploy.yml                  push → npm ci → npm test(185 项) → wrangler deploy
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
5. **v6 新增**:`src/domains/` 里不得出现 ICS 关键字,`renderer/governance` 不得 import 域文件
   —— 两条都由 render.test.mjs 的领地看守断言执行(§8)。

## 2. 数据流(一次请求)

```
URL ──► 中枢: 解析 cal/exclude → 选域;  tags/excludeTags → filters
        │     解析 past/future → 视图窗口(绝对日期) → 裁剪窗(±45天缓冲)
        │     组装 ctx = { env, baseDate, todayStr, window, filters, matchesTags, … }
        │
        ├─ 阶段一  每个域 adapter.prepare(q, ctx)            ← 有超时预算
        │            · 域内自治解析【自己的】URL 参数(默认值来自 config/<域>.js)
        │            · ctx.matchesTags 应用视图过滤(框架助手,不再各域自抄)
        │            · 报出需要的【地区】(年份归中枢:窗口归它,年份就是它推导的事实)
        │
        ├─ 中枢: 年份 = 裁剪窗跨越的全部年份
        │        createHolidayHub(地区并集, 年份并集)   ← 上游 workdays-core:
        │         打包内置数据、零联网、进程内现算;loadLogs + coverage 缺口进诊断
        │
        ├─ 阶段二  每个域 adapter.build(state, hub, ctx)      ← 有超时预算,超时=熔断该域
        │            ① events      日历本体【事件对象】(不是文本!契约见 EVENT-MODEL §1)
        │            ② alarms      附加输出(只读推算结果,绝不写回)
        │            ③ debugLines  诊断段(生效参数 + 域状态)
        │
        ├─ 中枢·治理  governance:  uid 校验(双协议) → 全 feed 唯一性 → 窗口硬裁
        │                          违规【响亮熔断 + 诊断报数】,绝不静默修复
        │
        └─ 中枢·渲染  renderer:    事件对象 → VEVENT(转义/折行/DTSTART/VALARM/时区)
                 format=ics  → VCALENDAR 信封(册名/颜色) + 诊断/哨兵事件 + 各域事件
                 format=json → 汇总 alarms → 只留未来 → 排序 → { v:1, alarms }
```

诊断事件与故障哨兵事件**也是普通事件对象**,走同一个渲染器 —— v6 起框架内不存在第二套
手拼 ICS 的路径。

## 3. 适配器契约(域必须实现)

> **权威在 docs/EVENT-MODEL.md**(§1 事件对象 / §5 适配器契约)。此处只是速查。

```js
export const xxxDomain = {
  id: 'xxx',
  contract: 2,             // v6 契约标记
  calName: '…',            // 单独订阅该域时的册名
  defaultColor: '#RRGGBB', // 单独订阅时整册色(?colorXxx= 可覆盖)
  window: 'USE',           // 窗口治理姿态:USE | MAP | OWN(§4.1)

  prepare(q, ctx) {                       // 可为 async,框架一律 await
    return { countries: ['CN'], state: {/* 域内私有 */} };
  },

  async build(state, hub, ctx) {
    return {
      events:     [/* 事件对象,见 EVENT-MODEL §1 —— 不是 ICS 文本 */],
      alarms:     [/* {uid,date:'YYYY-MM-DD',time:'HH:MM',reason} */],
      debugLines: [/* 诊断段落 */]
    };
  }
};
```

**ctx 与位置参数的分工规则**(记住这条就不会问"XX 该放哪"):

> **ctx = 请求级【恒定】的一切**:`env` / `baseDate` / `todayStr` / `window{from,to}` /
> `filters` / `matchesTags(item)` / `nowBeijingStr` / `hubTimezone`。
> **hub = 【阶段二才诞生】的资源** —— 它要等 prepare 报完 countries 才能创建,
> 进不了 prepare 的 ctx,故走位置参数。

约束:

- **uid 双协议**(EVENT-MODEL §4):日历 uid 与闹钟 uid 是**两套规矩**,别混用。
  闹钟侧全硬(前缀=域id / 字符集 `[A-Za-z0-9_.-]` / **长度 ≤40** / 不含时钟时间);
  日历侧前缀与唯一性硬,字符集与长度只告警。
  bucket 锚定"哪件事"(信用卡=账单月),不锚定"哪天响"→ 改提前量/假期漂移,uid 不变、
  只有 time 变,网关不抖。(下游依据见 docs/DOWNSTREAM.md。)
- **uid 长了怎么办**:框架发**工具**不发政策 —— `governance.js` 的 `uidHash()`(crc32,8 位)。
  用不用、哈希哪一段,是域按自己的身份结构在**设计时**决定一次并冻住的(判据见 DEVGUIDE §5.2)。
- alarms 允许为空数组(纯日历域);events 允许为空(纯闹钟域,理论上)。
- alarm 条目字段**原样透传**(uid/date/time/reason 之外的协议可选字段如 tz 一并输出);
  框架只做治理校验 + 按日未来过滤 + 排序 + 包 v:1。
- **故障隔离**:域 prepare/build 抛异常**或超时**仅熔断该域 —— ICS 出哨兵事件
  `❌ 域 xxx 构建失败`(不受 ?debug=0 影响),JSON 静默剔除,其它域照常。
  ⚠️ 诚实边界:超时竞速救得了 **I/O 等待**(KV 慢),救不了 **CPU 死循环**(JS 无法取消已起跑的
  Promise;后者由 Workers 平台自己掐)。价值在于:一个域的 I/O 卡死不再拖垮整册订阅 ——
  iOS 订阅刷新失败是**不报警**的,整册 5xx = 静默失联,可见性远差于单域熔断。
- 域之间互不 import;共享物只有 holidays hub 与中枢传入的 ctx。

## 4. 参数矩阵(三层,互不越界)

| 层 | 参数 | 说明 |
|---|---|---|
| 中枢·视图 | `?cal=` `?exclude=` `?tags=` `?excludeTags=` | 一条链接一种组合;tags 是选择型(严格命中),excludeTags 是排除型(不伤未打标签者) |
| 中枢·窗口 | `?past=` `?future=`(月) | **v6 升格为中枢参数**(v5 曾是 card 私产)。缺省住 `config/hub.js`。框架换算成绝对日期区间下发 + 兜底硬裁。⚠️ v6 废除 `?months=`(签到域旧参数):写了不崩,按 `?future=` 处理并在诊断响亮告警 |
| 中枢·输出 | `?format=ics\|json` `?testDate=` `?debug=0` `?colorCheckin= ?colorCard= ?color=` | 日历缺省;testDate 同时作用推算基准与 JSON 未来过滤 |
| 中枢·计算 | `?cnRule=bank\|market` | 裸 `'CN'` 的工作日口径全局默认。bank(缺省)=调休那套;market=补班周末视为休息(股市/清算)。条目级 token(`'CN:market'`/`'CN:bank'`)优先于此。⚠️ v5 废除 `official`:传旧值不崩,按 bank 处理并在诊断响亮告警 |
| 签到域 | `?tasks=ID\|锚点,…` | 原程序参数原语义 |
| 信用卡域 | `?mode= ?merge= ?durationMin= ?allDayReminders= ?exactReminders= ?mergeTitleShowCount= ?ch= ?cm=` + `?cardAlarm=merged\|each\|off` | cardAlarm 只影响 JSON。⚠️ v6 删除旧别名 `?adAlarms= / ?exAlarms=`:写了不崩,按默认提醒处理并在诊断响亮告警 |

### 4.1 窗口:许可边界,不是生产配额

`?past=3` 的意思是"**允许**你往前 3 个月",不是"**必须**填满 3 个月"。同一个参数,两种合法用法:

- **签到域(MAP,忽略 past)**:算法从锚点单向前推,天生不产历史 → past 区间自然空产出。
  框架不催产。
- **信用卡域(MAP → 账单月循环边界)**:回溯有真实价值(核对推算、暴露 bug)→ 它用足这个许可。

**两条腿,缺一不可**:
- **下发**(协商):窗口进 ctx,域自愿用来省算力(card 少循环、email 域少读 KV)。
- **兜底**(强制):build 之后框架按事件 `date` 硬裁,裁剪必上诊断。

只下发是君子协定,只兜底是白算一遍 —— 信任但验证。

**裁剪窗 = 视图窗 ±45 天结构性缓冲**:裁的是"离谱越界",不是"贴边溢出"。宽限跨月
(cycle 模型 statementDay 晚 + 21 天宽限)、假期顺延、提前量把提醒推出边界 —— 这些是**业务**
不是越界,归域的 MAP 语义,框架不掺和。年份推导同样基于裁剪窗,天然覆盖全部合法溢出。

**治理姿态**(adapter 静态属性,不进 URL —— URL 是"这次怎么看",adapter 是"这个域天生什么脾气"):
`USE` 直接吃 / `MAP` 映射成自己的语义 / `OWN` 完全自持(**必在诊断显形**,否则是暗箱)。

**豁免边界(硬规矩)**:

> **只影响自己的 → 可豁免(软治理);影响别人的 → 不可豁免(硬治理)。**

软:窗口、历史保留 → 可 OWN。硬:uid 合法性、超时、输出体积 → **OWN 也逃不掉**,fail-closed。

## 5. 日历↔闹钟解耦矩阵

| 开关 | 位置 | 影响日历? | 影响闹钟? |
|---|---|---|---|
| `isActive:false` | 账户/任务条目 | ✅ 移除 | ✅ 移除 |
| `tags` + URL 视图 | 条目 + 链接 | ✅ 按链接 | ✅ 按链接(JSON 链接自己选自己的视图) |
| `remind:false` | 账户/任务条目 | ❌ 照常出 | ✅ 该条不进网关 |
| `CARD_ALARM.alarmMode` / `?cardAlarm` | config/card.js | ❌ | ✅ merged/each/off |
| `alarmOffsets` | 签到任务 | ❌ | ✅ 缺省准点一条,配置才提前 |
| `workdayAlarms/holidayAlarms/allDayReminders/exactReminders` | 日历侧 | ✅ VALARM | ❌ 与闹钟无关 |

ICS 链接与 JSON 链接是两条独立 URL,各自组合视图 —— "链接"与"是否闹钟"天然解耦。

## 6. 假期事实与口径(上游 workdays-core)

**v5 起,假期这件事本库只剩两个动作:报需求(prepare 返回 countries)、拿判断器
(hub.makeWorkdayChecker)。** 数据、抓取、归档、observed 顺延、调休三态、NYSE 例外规则,
全部住在上游 `@ivanphz/workdays-core`(GitHub Packages 私有包;上游契约见其 docs/INTEGRATION.md)。

> **v6 变化**:域**不再自报 years** —— 窗口归中枢后,年份是中枢从裁剪窗推导的事实。
> (v5 里两个域各写了一套年份算法、还不一致 —— 那正是"没有总控"的具象。)

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
  deploy.yml 跑测试后部署。节假日公告更新全程无人值守直达线上。

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

## 7. 渲染器:iOS 血债的唯一收容所

v6 之前,这些知识散在各域的字符串拼接里,谁也说不清哪条长在哪行。渲染器建成后它们有唯一
居所,**新插件自动继承全部赔偿**(域侧写作零 ICS 知识)。

| 保证 | 细节 |
|---|---|
| TEXT 转义 | `\` `;` `,` 换行,RFC 5545;域给原文即可(v5 **零转义**,卡名带逗号即破行) |
| 折行 | 75 字节,UTF-8 安全(不劈多字节字符);v5 完全不折 |
| 定点时间 | `DTSTART;TZID=<IANA>:<墙上时间>` + `DURATION:PT…M`(逐字继承 v5 pushTiming 语义) |
| 全天时间 | `DTSTART;VALUE=DATE` + 排他 DTEND |
| VALARM | **只产相对 TRIGGER**;绝对 TRIGGER 在接口上**不存在** |
| DTSTAMP / `@mycal.local` | 统一生成 / 追加(域不要自带) |
| 信封 | VCALENDAR 头、册名/颜色、诊断事件、哨兵事件 |

**三条已收容的血债**:
1. **绝对 TRIGGER 8 小时坑** —— 苹果把不带时区限定的绝对 `DATE-TIME` TRIGGER 当 UTC 读。
   处置不是"注意别用",而是**接口上不提供绝对 TRIGGER**:结构性杜绝再犯。
2. **裸 TZID 依赖(决策记录,非疏漏)** —— `DTSTART;TZID=Asia/Shanghai` 不携带 VTIMEZONE 块。
   RFC 严格说要求,Apple 认裸 Olson 名。**维持现状**,依赖写进渲染器头注;哪天要喂非 Apple
   客户端,补 VTIMEZONE 只改渲染器一处 —— 这正是 Tier 2 买来的权利。
3. **订阅日历"Event Alerts"总开关盖过一切 VALARM** —— 提醒不响先查手机侧,不是代码 bug。

**探雷断言(长期保留)**:渲染器检测到原始文本含字面 `\n` 序列(反斜杠+n)即诊断告警 ——
v6 之后域没有任何正当理由手写转义序列,出现即迁移漏网或新插件误学旧写法。

## 8. 领地看守(测试即边界)

两条断言住在 `test/render.test.mjs`,是 §0 总纲和 §1 领地规则的**执行器**:

1. **域目录禁 ICS 关键字** —— grep `src/domains/**` 不得出现 `BEGIN:VEVENT` / `BEGIN:VALARM` /
   `TRIGGER:` / `DTSTART` / `X-WR-`。出现 = 域在私产 ICS。
   ⚠️ 只查代码不查散文(剥注释后再查):域注释里**应该**出现这些词 —— 那是在说明"此物归框架管",
   是文档不是违规。裸 `includes()` 分不清,会让插件作者写一句合理注释就吃红灯。
2. **反向** —— `renderer.js` / `governance.js` 不得 import 任何域文件(框架不掺和业务)。

同类既有手法:`src/domains/card/config.js` 垫片有测试看守(禁放任何值)。
**用测试看守领地边界**,不靠自觉。

## 9. 信用卡域的演进(为什么没有金标准冻结)

原信用卡项目 repayment-cal 已在 GitHub **归档(archived,只读)**,历史存档职责归那个仓库。
早期版本(v3~v5)曾在本库 `test/golden/` 冻结原版逐字节副本作金标准。**v5.2 起移除该机制**,
原因很直接:迁移正确性是**一次性**的证据,而信用卡逻辑是框架里**长期要演进**的一等公民 ——
把它焊死在"原版不可改"上,等于宣布用户不能再改自己的信用卡逻辑,荒谬。

> **v6 借尸打了一仗,又送走了。** v6 迁移期(域交事件对象、行为须全等)临时立了一套
> `test/golden.mjs` 夹具:钉死 testDate,对 11 条代表性 URL 抓 v5 语义快照,**比语义不比字节**
> (折行/属性次序/转义形式/DTSTAMP/uid 前缀全部归一化抹平)。手术 A 验收 11/11 全等后,
> 按服役期约定**已删除**(手术 B 是有意改行为,再比就是自缚)。退役理由同 v5.2。
> 详见 DEVLOG v6.0 / v6.1。

正确性由**行为/结构断言**守护,而非"与原版逐行相等":
- `render.test.mjs`(框架层,零依赖):渲染语义、治理规则、uidHash、领地看守。
- `hub.test.mjs`(域层):A 组(事件结构自洽)、B 组(领地/视图/窗口总控)、
  E~H 组(口径避让/双日历/三叠端到端,用真实归档日期钉死)、I 组(插件契约)、
  J 组(v6 契约:事件对象/出口治理/超时熔断)、K 组(哈希身份/旧别名/遗留字段)。

这些断言校验的是"逻辑对不对",不是"和原版一不一样",所以你改逻辑时更新对应断言即可。

破坏性变更记 DEVLOG。**是否给旧名留兼容别名,分情况**:

- **对外(你控制不了的东西)**:留(如上游包的 API)。
- **对内(框架内部契约,两边都是你自己的)**:**不留** —— 兼容层本身就是技术债,会得到一个
  "永远有两条路径"的框架,而第一条路径上的域永远不受治理,总控就成了摆设。
  (v6 迁移期确实立过一座"双契约桥",但它有**拆除条件写在三处代码里**,且 legacy 域每次请求
  都在诊断自曝"未受治理" —— 永久兼容层让人忘记欠债,那座桥让欠债持续刺眼。手术 A 完成即拆。)
- **URL 参数(存量链接有限且可盘点)**:**删除 + 响亮告警**。不静默忽略的理由:旧链接会
  "看起来正常"却悄悄跑偏(`?months=6` 的人悄悄拿到 12 个月;`?adAlarms=` 的人悄悄拿到默认提醒)
  —— 不报错、只是行为悄悄变了,最坏的那种失败。v6 的 `?months=` / `?adAlarms=` / `?exAlarms=`
  即照此处理,盘点清单见 docs/UPGRADE-V6.md。
