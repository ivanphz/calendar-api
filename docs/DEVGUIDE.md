# 插件接入手册 (DEVGUIDE)

> **这份文档是自足的**:接入一个新提醒插件(域),只需读完本文,无需阅读框架源码。
> 心法一句话:**你只负责算出"哪一刻",框架包办其余**(ICS/JSON 双输出、视图组合、
> 分册颜色、假期数据、testDate、故障隔离)。日历是本体,闹钟是附加输出。
>
> **v6 起你写作零 ICS 知识** —— 交【事件对象】,框架独家渲染。转义、折行、时区标注、
> VALARM 语法、以及一堆用真机踩出来的 iOS 坑,你全部自动继承,一个字都不用写。
>
> 契约的**唯一真相源**是 **docs/EVENT-MODEL.md**;本文与它冲突时以它为准。
> 闹钟最终要进手机?下游网关(alarm-api)能做什么、你能依赖什么,见 **docs/DOWNSTREAM.md**;
> 想看一个满配实战样本(三模型/邮件驱动/多国叠加),见 **docs/PLUGIN-CARD.md**。

---

## 0. 三步接入(概览)

1. **建配置** `config/<域id>.js`(用户领地,框架更新永不触碰)
2. **建域** `src/domains/<域id>/`:`engine.js`(纯算法) + `adapter.js`(实现契约)
3. **注册** `src/registry.js` 的 `DOMAINS` 加一行

完成后自动获得:`?cal=<域id>` 独立册、`?cal=all` 混册、`?exclude=`、`?tags=`、
`?format=json` 闹钟流、`?testDate=`、`?past=/?future=` 窗口、诊断报告一段、
`?color<域Id>=` 颜色覆盖、超时熔断与故障隔离。

**一句话记住领地**:

> **框架吃语法,域吃语义。**
>
> 石蕊测试:*"输出格式从 ICS 换成 Google Calendar API,这行要不要动?"* 要动=框架;不动=你。

---

## 1. 契约:域对象

```js
export const xxxDomain = {
  id: 'xxx',              // 见 §8 id 约束
  contract: 2,            // v6 契约标记(必填)
  calName: '🧪 某某提醒',  // 单独订阅(?cal=xxx)时的册名(X-WR-CALNAME)
  defaultColor: '#34C759',// 单独订阅时的整册色;?colorXxx= 可覆盖(派生规则见 §7)
  window: 'USE',          // 窗口治理姿态:USE | MAP | OWN(见 §2.1)
  prepare(q, ctx) { /* ... */ },              // 可为 async,见 §2
  async build(state, hub, ctx) { /* ... */ }  // 见 §3
};
```

**ctx 与位置参数的分工规则**(记住这条就不会问"XX 该放哪"):

> **ctx = 请求级【恒定】的一切**(从头到尾不变)。
> **hub = 【阶段二才诞生】的资源** —— 它要等 prepare 报完 countries 才能创建,
> 进不了 prepare 的 ctx,故走位置参数。

---

## 2. 契约:prepare(阶段一 —— 解析参数、报假期需求)

**可以是 async**(框架一律 `await`)。**抛异常或超时 = 本域熔断**,其它域不受影响(见 §8)。

入参 `q`(URLSearchParams,整条请求的 query。**只读你自己的参数**,命名规范见 §7)与 `ctx`:

| ctx 字段 | 类型 | 说明 |
|---|---|---|
| `env` | object | Cloudflare 绑定(KV/Secret…)。**账户列表存 KV 的域**得先读 KV 才知道自己要哪些国家 |
| `baseDate` | Date | 基准日("今天",已含 ?testDate 覆盖)。**用本地 getter 读**(`getFullYear/getMonth/getDate`),读出来就是北京墙上日期 |
| `todayStr` | string | `'YYYY-MM-DD'`,同上口径 |
| `window` | `{from, to}` | **中枢窗口**,绝对日期闭区间(`?past=/?future=` 换算而来)。见 §2.1 |
| `filters` | `{tags, excludeTags}` | 中枢级视图过滤(通常你用下面的 `matchesTags` 就够,不必自己读它) |
| `matchesTags(item)` | function | **框架助手** —— 对你的每个条目调它。v5 要求各域自抄一份实现,v6 收归中枢 |
| `nowBeijingStr` | string | 人类可读的北京时间串,只用于 debug 文案 |
| `hubTimezone` | string | `HUB_CONFIG.timezone`,你给事件缺省 tz 时的参照(通常不用管) |

返回:

```js
{
  countries: ['CN', 'US:market'],  // 本域所有条目需要的假期日历并集(口径 token 见 §5.5)
  state: { /* 你的私有状态,原样传给 build,形状随意 */ }
}
```

> ⚠️ **v6 起不要返回 `years`** —— 窗口归中枢后,年份是中枢从裁剪窗推导的事实,你别操心。
> (v5 里两个内置域各写了一套年份算法、还不一致 —— 那正是"没有总控"的具象。)

### 2.1 窗口:许可边界,不是生产配额

`ctx.window` 是**绝对日期区间**,不是月数。为什么框架不下发"月"?因为**月对不同域语义不同**:
对信用卡是账单月,对签到是 30 天节律 —— 月是个骗人的单位,绝对日期才无歧义。

**它是【许可】,不是【指标】**:`?past=3` 的意思是"允许你往前 3 个月",不是"必须填满"。

- 签到域算法从锚点单向前推,天生不产历史 → past 区间自然空产出,**框架不催产**。
- 信用卡域回溯有真实价值(核对推算、暴露 bug)→ 它用足这个许可。

同一个参数,两种用法都合法。

**你的姿态(adapter 静态属性 `window`)**:

| 姿态 | 语义 |
|---|---|
| `USE` | 直接吃框架窗口 |
| `MAP` | 映射成自己的语义(如 card:窗口两端 → 账单月循环边界;checkin:只吃 `window.to` → 推几期) |
| `OWN` | 完全自持。**必在诊断显形**(否则是暗箱);仍逃不掉出口硬治理 |

**框架会兜底硬裁**(按事件 `date`,裁剪窗 = 视图窗 ±45 天缓冲),越界必在诊断报数。
所以:你**用不用** `ctx.window` 都不会出错 —— 用了省算力,不用也有兜底。但**别越界**,越界会被
裁掉并点名。缓冲的存在意味着"贴边溢出"(宽限跨月/假期顺延/提前量)是安全的,那是业务不是越界。

**豁免边界(硬规矩)**:

> **只影响自己的 → 可豁免(窗口);影响别人的 → 不可豁免(uid 合法性、超时、体积)。**

---

## 3. 契约:build(阶段二 —— 产出三件套)

入参:

| 参数 | 说明 |
|---|---|
| `state` | prepare 返回的私有状态 |
| `hub` | 假期判断器工厂:`hub.makeWorkdayChecker(countries)` → `(dateObj) => boolean`。日期构造方式见 §6 |
| `ctx` | 同 §2(含 `env`) |

返回(三件都必填,允许空数组):

```js
{
  events:     [ /* 日历本体:【事件对象】,规则见 §4 —— 不是 ICS 文本! */ ],
  alarms:     [ /* 附加输出:闹钟条目,规则见 §5;空数组 = 本域不进网关 */ ],
  debugLines: [ /* 诊断段落:字符串数组,一行一元素 */ ]
}
```

**铁律:alarms 只能从推算结果衍生,不得为了闹钟改动事件生成**(日历是本体)。

---

## 4. events 硬规则(事件对象)

> 完整字段表见 **docs/EVENT-MODEL.md §1**。此处是速查 + 最易踩的三条。

```js
// 全天事件
{ uid: 'xxx-demo-20260801', allDay: true, date: '2026-08-01',
  summary: '🧪 某某到期', description: '第一行\n第二行',
  reminders: [{ dayOffset: -1, at: '20:00' }] }

// 定点事件
{ uid: 'xxx-demo-20260801', allDay: false, date: '2026-08-01', time: '09:30',
  tz: 'Asia/Shanghai', durationMinutes: 10,
  summary: '🧪 某某到期', url: 'https://…',
  reminders: [{ minutesBefore: 5, label: '可以领了！' }] }
```

**你不要输出**:任何 ICS 关键字(`BEGIN:VEVENT` / `DTSTART` / `TRIGGER:` / `X-WR-*`…)。
—— 这条有**测试看守**:域目录里出现 ICS 关键字 = 红灯(ARCHITECTURE §8)。

### 铁律一:绝不自己换算时区

只声明**当地几点**(墙上时间 `date`+`time` + IANA 名 `tz`),换算是框架的事。

与闹钟通道"异时区业务别自己换算,带 `tz` 字段交给网关"(DOWNSTREAM §2)**完全同构** ——
三层生态里,时区换算永远发生在消费侧,全链只此一个方向。

- `tz` 只收 **IANA 名**(`Asia/Tokyo`、`America/New_York`),**不收 `+09:00` 偏移量**:
  TZID 需要名字,且裸偏移无 DST 信息,是伪时区。
- 缺省 = `HUB_CONFIG.timezone`(东八)。做东八业务一个 tz 都不用写。
- 但**引擎天生产出别的时区就显式写**(如签到域的"虚拟 UTC"数学天生产上海墙上时间)——
  隐式继承会在哪天 hub 时区改了之后静默错 8 小时。**显式优于隐式。**

### 铁律二:内容只给原始文本

`summary` / `description` 里:真实换行就是 `\n`(JS 源码单反斜杠),逗号就是逗号。

**严禁**手写 ICS 转义序列(`\\n`、`\\,`)—— 渲染器有**探雷断言**,发现即诊断告警。
转义、UTF-8 安全折行(75 字节),全归框架。

> v5 的域是裸字符串拼接、**零转义**:卡名里写个逗号就破行。v6 这个 bug 结构性消失。

### 铁律三:reminders 是【意图】,不是语法

两种形态(见 EVENT-MODEL §3):

```js
{ minutesBefore: 5 }                    // 定点事件惯用;0 = 准点
{ dayOffset: -1, at: '20:00' }          // 全天事件惯用:事件日前一天 20:00
{ …, label: '自定义文案' }               // 可选;缺省文案框架给
```

框架**只产相对 TRIGGER**。你**没有办法**产出绝对 TRIGGER —— 这是故意的:
苹果日历把不带时区限定的绝对 `DATE-TIME` TRIGGER 当 UTC 读,偏整整 8 小时。
处置不是"注意别用",而是**接口上不提供**,让这个坑不可能被你踩到。

---

## 5. alarms 硬规则(闹钟网关,协议 v1)

每条 = 一个闹钟:

```js
{ uid: 'xxx-demo-202612', date: '2026-12-01', time: '09:00', reason: '🧪 某某到期' }
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `uid` | ✅ | 前缀=域id、纯 `[A-Za-z0-9_.-]`、**≤40 字符**、**不含时钟时间**,规范见 §5.1 |
| `date` | ✅ | `YYYY-MM-DD`,东八区墙上日期 |
| `time` | ✅ | `HH:MM` 24h,东八区墙上时刻 |
| `reason` | 建议 | 备注文案。**也是治理诊断里的人话** —— 见 §5.2 |
| 其它 | 可选 | **协议可选字段(如 `tz`)原样透传** —— 框架契约保证对条目字段不增不删不改 |

### 5.1 uid 双协议(日历 ≠ 闹钟,别混用)

| | 日历事件 uid | 闹钟 uid |
|---|---|---|
| 消费方 | iOS 日历(整册替换式刷新) | alarm-api 网关(增量对账) |
| 时钟时间 | **允许**(身份可以就是"这一天") | **严禁**(bucket 锚事件不锚响铃) |
| 字符集 | ASCII 可打印;建议 `[A-Za-z0-9_.-]` | **硬限** `[A-Za-z0-9_.-]` |
| 长度 | 建议 ≤60(只告警) | **硬限 ≤40**(网关拼手机标签) |
| 前缀 | **必须 = 域 id + `-`** | 同左 |
| `@mycal.local` | 框架统一追加,**你不要自带** | 无 |

`{域id}-{任务实例}-{周期桶}`。周期桶(bucket)粒度 = "同一时段最多响一次"的时段:

| 提醒模式 | bucket | 例 |
|---|---|---|
| 月度 | `YYYYMM` | `card-b7c92750-202607` |
| 每日一次 | `YYYYMMDD` | `dose-vitd-20260807` |
| 每日多次 | `YYYYMMDD-稳定序号` | `water-desk-20260807-am` |

bucket 锚定"**事件属于哪个周期**",不锚定"哪天响" —— 改提前量/假期漂移时 uid 不变、
只有 time 变,网关平滑改期不抖。同一次输出里同一 uid 绝不能出现两次(**框架会查,重了熔断**)。
多个提前量 → 物化成多条,uid 加稳定后缀(如 `-m5`/`-m0`);单提前量用裸 uid。

### 5.2 uid 太长/含中文怎么办 —— 判据在这

框架发**约束**和**工具**,**不发政策**。用不用哈希,你自己按判据定:

> **身份天生就短且是 ASCII → 直接用,别哈希。**
> **身份长 / 含中文 / 机器生成 → 哈希。**

- 签到域:`checkin-moeshare-202607` —— 一眼看懂,**不哈希**(强制哈希是纯亏:丢了可读性,
  一个问题没解决)。
- 信用卡域:身份是五段拼出来的,汇丰那条 **44 字符 > 40 硬限**,PAB 那条含中文 —— **哈希**。
  (v5 用有损 ASCII 压缩来救,结果两张中文简称的卡压成同一个 id → **撞键**;
   crc32 原生吃 Unicode,该 bug 根治。)

**同判据,不同答案。** 不存在"某个域的模式",只有这一条判据。

工具:`import { uidHash } from '../../governance.js'` → `uidHash(身份串)` → 8 位十六进制。
它和 `checkAlarmUid` 是**一造一查、同一件事的正反面**,所以住在框架里 —— 第二个要哈希的域
不必再抄一份实现。

**为什么 8 位不压 4 位**:30 个身份的生日碰撞,4 位=0.66%,8 位=0.00001%。而
`card-<8位>-<YYYYMM>` 才 **20 字符**,只用掉上限 40 的一半 —— **省的是你不需要的东西,
赌的是你输不起的东西**(撞号 = 两条闹钟互相顶掉)。

**⚠️ 这个判断发生在【设计时】,不是【运行时】。** 别写"超过 N 个字符就自动转哈希"的代码:
那让身份取决于"这串字符碰巧多长"这种偶然属性 —— 改个显示名多 3 个字就跨过阈值,uid 从明文
悄悄翻成哈希,全体闹钟重建,而没有任何东西告诉你为什么。**身份不能建在偶然属性上。**
同理,**别用 URL 参数控制哈不哈**:那让身份跟着链接走,你调试看的(明文)和生产跑的(哈希)
不是一个东西。视图参数改的是"你看什么",身份参数改的是"东西是谁",两个物种。

### 选了哈希 = 你欠一条【冻结声明】

白纸黑字写明:**哈希输入是哪几个字段、什么顺序,并承诺不改**。改一个字 = 全部 uid 变 =
网关全体重建。声明写进你的插件文档,并**用一条测试当执行器**(样板见 hub.test.mjs K 组
第一条:钉死 `makeAccountId` 的输出串)。**声明不靠自觉,靠测试。**

### 哈希不可读怎么办 —— 它不需要可读

**uid 的工作是【配对】,不是【沟通】**:

- 沟通归日历 `summary` 和闹钟 `reason` —— 那里全是人话;
- 手机标签 `Gate-ES-<code>-<uid>-<HHMM>` 里的 `code` 已答完"哪个项目";
- **治理诊断打 uid 时会带上 summary/reason** —— 排错不用查表。

**配对是白送的**:让日历 uid 和闹钟 uid 共用同一个哈希段,闹钟 uid 就是日历 uid 的**前缀**,
肉眼即可对上,不必往日历标题里塞机器编号:

```
日历: card-b7c92750-202607-20260722
闹钟: card-b7c92750-202607
```

### 5.3 框架代劳(你不用做)

治理校验(uid 双协议 + 全 feed 唯一性)、按日的未来过滤(丢弃 `date <` 基准日;当日保留)、
按 date+time 排序、包 `{ v:1, alarms }` 壳、剔除熔断域。
**你要做**:尊重条目 `remind:false`(不产 alarm)与 `alarmOffsets`(§6 语义表)。

### 5.5 假期口径 token(holidayCalendars 直接写;与上游 workdays-core 一词一义)

| token | 语义 |
|---|---|
| `'CN'` / `'CN:bank'` | 大陆·调休那套(法定假休,补班周末**上班**)。裸 `'CN'` 受全局 `?cnRule=` 影响;显式 `':bank'` 不受 |
| `'CN:market'` | 大陆·市场口径(补班周末**休**;股市/清算) |
| `'US'` / `'US:bank'` | 美国·银行/联邦(含观察日) —— **还款/转账用这个** |
| `'US:market'` | 美国·NYSE 交易日历(休 Good Friday;Columbus/Veterans 开市)。仅条目级,无全局开关 |
| `'HK'` / `'HK:public'` | 香港·公众假期(唯一口径) |

alpha-3 写法(`CHN`/`HKG`/`USA`/`GBR`/`SGP`)与二位码永久等价;上游另有 GB(england/
scotland/ni 三分域)与 SG 数据集,配置里直接写 token 即得,本库零改动。
**v5 破坏性变更**:`':official'` 及 HK 的 `':market'/':official'` 伪口径已废除 ——
写错/写废不会崩,但行为退该国默认口径,且**诊断事件里响亮告警**(绝不静默吞掉)。

叠加语义:数组里**任一日历休息即休息**。

**实战配方(美股全链条:卖出→回款→跨境→还款)**:
`holidayCalendars: ['CN','US','US:market']` + `advanceDays: 4`。
依据:美股 T+0 只是交易口径,资金 **T+1 结算**(2024-05 起)后才能提;"NYSE 开/银行关"日
(Columbus、Veterans)能卖不能动钱且结算顺延 —— 三叠自动判休;CN 补班周六被 US 周末腿天然
兜住。该配方被**测试 H 组钉死**,改叠加逻辑必须先过它。

---

## 6. 时间口径 · filters · 预留字段

**时间**:Cloudflare 运行时时区 = UTC。约定:
- 构造"某天"用正午模式:`new Date(y, m0, d, 12, 0, 0)` —— 免疫边界问题。
- `ctx.baseDate` 用本地 getter 读 = 北京墙上日期(框架已换算)。
- 引擎内部若用"虚拟 UTC"(`Date.UTC` 存、`getUTC*` 读,如签到域),输出前自己格式化成
  `date`/`time` 字段,并**显式写 `tz`**;两种风格别混用。
- 假期一律 `hub.makeWorkdayChecker(countries)`,**禁止自拉数据源**。假期事实全部来自
  上游 npm 包 **workdays-core**:本库零假期数据、零判定实现;要新地区/新口径 =
  上游加数据集发版(见上游 `docs/DATASET-GUIDE.md`),本库经 update-core 自动升级获得,
  代码零改动。上游数据缺口(某年无归档)会按纯周末兜底并在诊断事件**响亮告警**(coverage),
  插件不必也不应自行兜底。

**filters(义务)**:对你的每个条目调 `ctx.matchesTags(item)`。

> v5 要求各域自抄一份 `hitTags` 实现(结果两个域抄了两份逐字相同的代码)——
> **v6 收归中枢**,你直接用助手,单点改动。

**条目预留字段(全框架统一语义,你的引擎必须尊重,缺省即默认)**:

| 字段 | 缺省 | 语义 |
|---|---|---|
| `isActive` | true | false = 停用(日历+闹钟都不出) |
| `tags` | `[]` | 视图标签,配合 `?tags= / ?excludeTags=` |
| `remind` | true | false = 仅日历,不进闹钟网关 |
| `alarmOffsets` | `[0]` | 闹钟提前分钟;`[0]`=事件准点一条;与日历 `reminders` **无关** |
| `holidayCalendars` | `['CN']` | 叠加哪些假期日历(含口径 token) |
| `ext` | `{}` | 自由扩展对象,框架不读不校验。**新特性优先塞这里**,老代码零影响 |

> `ext` 不是摆设:v6 删掉了信用卡域两个"预留但从未启用"的字段(`needsFxPurchase`/`fxNote`)
> —— 那是违反"explicit over speculative"的投机字段。真遇到那种卡,`ext` 随时能装。
> **预留接口不如自由袋。**

---

## 7. URL 参数(自动派生 + 命名规范)

接入后自动生效:`?cal=<id>`(可逗号组合)、`?exclude=<id>`、`?tags=`、`?excludeTags=`、
`?past=` `?future=`、`?format=ics|json`、`?testDate=YYYY-MM-DD`、`?debug=0`、
`?color<Id>=`(派生规则:`color` + id 首字母大写;id=recharge → `?colorRecharge=`,# 编码 %23)。

**你的域私有参数**必须带域名前缀防冲突:`?rechargeMode=`……
在 prepare 里自己解析,config 默认值兜底。

> ⚠️ **别拿 `?past=/?future=` 当自己的参数** —— 它们是中枢参数,统管全域。
> 想要"本域独立跨度"?先想清楚为什么 —— 大概率你要的是 `window: 'MAP'`(把中枢窗口映射成
> 自己的语义),而不是再开一个参数让用户记两套。

---

## 8. id 约束 · 故障隔离 · 性能

- **id**:`[a-z][a-z0-9]*`(小写 ASCII);同时用于 `?cal=`、颜色参数派生、**uid 前缀**、注册键。
- **故障隔离**:prepare/build 抛异常**或超时** → 仅本域熔断:ICS 出现一条
  `❌ 域 xxx 构建失败` 哨兵全天事件(**即使 ?debug=0**),JSON 静默剔除本域,其它域照常。
  这是**安全网不是流程控制** —— 想跳过输出就返回空数组,别抛异常。
- **超时预算**:单域 3 秒(框架给)。
  ⚠️ 诚实边界:竞速救得了 **I/O 等待**(KV 慢、上游慢),救不了 **CPU 死循环**
  (JS 无法取消已起跑的 Promise;后者由 Workers 平台自己掐)。
- **性能**:闹钟网关拉取有 5 秒超时,整条链必须远快于此;假期数据框架已统一加载,别重复拉;
  避免在 prepare/build 里做无缓存的多次远程请求。**用 `ctx.window` 收敛你的循环范围**是
  最省事的优化。

---

## 9. 完整可抄模板

```js
// ── config/recharge.js ──【用户领地】
export const RECHARGE_ITEMS = [
  { id: 'broadband', name: '宽带充值', emoji: '🔋', everyDays: 90,
    anchor: '2026-07-01'
    // ,tags: ['life'], remind: false, alarmOffsets: [10, 0],
    // holidayCalendars: ['CN'], ext: {}
  }
];
export const RECHARGE_CONFIG = { calendarName: '🔋 充值提醒', color: '#34C759' };
```

```js
// ── src/domains/recharge/engine.js ──【纯算法:只算"哪一刻"】
export function runRecharge(item, horizonStr, isWorkDay, baseDateObj) {
  const out = [];
  const [y, m, d] = item.anchor.split('-').map(Number);
  const [hy, hm, hd] = horizonStr.split('-').map(Number);
  const horizon = new Date(hy, hm - 1, hd, 12, 0, 0);
  let cur = new Date(y, m - 1, d, 12, 0, 0);
  while (cur <= horizon) {
    cur = new Date(cur); cur.setDate(cur.getDate() + item.everyDays);
    const t = new Date(cur);
    while (!isWorkDay(t)) t.setDate(t.getDate() + 1);   // 示例策略:遇休顺延
    if (t <= horizon) out.push(t);
  }
  return out; // Date[](每期一刻)
}
```

```js
// ── src/domains/recharge/adapter.js ──【契约实现:零 ICS 知识】
import { RECHARGE_ITEMS, RECHARGE_CONFIG } from '../../../config/recharge.js';
import { runRecharge } from './engine.js';
const pad = n => ('0' + n).slice(-2);

export const rechargeDomain = {
  id: 'recharge',
  contract: 2,
  window: 'USE',                       // 直接吃中枢窗口:用 window.to 当推算地平线
  calName: RECHARGE_CONFIG.calendarName,
  defaultColor: RECHARGE_CONFIG.color,

  prepare(q, ctx) {
    const items = RECHARGE_ITEMS
      .filter(i => i.isActive !== false)
      .filter(i => ctx.matchesTags(i));            // ← 框架助手,不再自抄 hitTags
    const countries = [...new Set(items.flatMap(i => i.holidayCalendars || ['CN']))];
    return { countries, state: { items } };        // ← 不报 years,中枢自己推
  },

  async build(state, hub, ctx) {
    const events = [], alarms = [], log = [];
    for (const item of state.items) {
      const isWorkDay = hub.makeWorkdayChecker(item.holidayCalendars || ['CN']);
      for (const at of runRecharge(item, ctx.window.to, isWorkDay, ctx.baseDate)) {
        const dateStr = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
        const uid = `recharge-${item.id}-${dateStr.replace(/-/g, '')}`;   // 每期一天 → 日粒度 bucket
        events.push({
          uid, allDay: false, date: dateStr, time: '09:30', durationMinutes: 10,
          summary: `${item.emoji} ${item.name}`,
          description: `每 ${item.everyDays} 天一次\n上次锚点: ${item.anchor}`,  // 真换行,别写 \\n
          reminders: [{ minutesBefore: 0 }],
          tags: item.tags || []
        });
        if (item.remind !== false) {
          const offs = (item.alarmOffsets && item.alarmOffsets.length) ? item.alarmOffsets : [0];
          for (const min of offs) {
            const t = new Date(at); t.setHours(9, 30 - min, 0, 0);
            alarms.push({ uid: offs.length > 1 ? `${uid}-m${min}` : uid,
              date: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`,
              time: `${pad(t.getHours())}:${pad(t.getMinutes())}`, reason: `${item.emoji} ${item.name}` });
          }
        }
      }
      log.push(`- ${item.emoji}${item.name} 每${item.everyDays}天`);
    }
    return { events, alarms, debugLines: ['【🔋 充值域】', `条目 ${state.items.length} 个`, ...log] };
  }
};
```

```js
// ── src/registry.js ── 注册一行
import { rechargeDomain } from './domains/recharge/adapter.js';
export const DOMAINS = { checkin: /*…*/, card: /*…*/, recharge: rechargeDomain };
```

---

## 10. 提交前自检清单

- [ ] `npm test` 全绿(框架层 + 域层;并为新域补用例)
- [ ] **域目录里没有任何 ICS 关键字**(领地看守会红;注释里提到无妨,只查代码)
- [ ] `description`/`summary` 用**真换行**,没手写 `\\n`(渲染器探雷会在诊断告警)
- [ ] 事件 `date` 落在 `ctx.window` 内(越界会被裁并在诊断点名;贴边溢出安全,有 ±45 天缓冲)
- [ ] `?cal=<id>&format=json&testDate=<未来>`:闹钟 uid **前缀=域id、≤40、纯 ASCII、
      无时钟时间**、只含未来、同 uid 不重复
- [ ] 同参数拉两次 → uid 集合完全一致(稳定);改"时刻类"配置 → uid 不变仅 time 变(不抖)
- [ ] **选了哈希?** 冻结声明写了吗?测试当执行器了吗?(§5.2)
- [ ] 时区:只给墙上时间 + IANA 名,**没自己换算**;引擎天生非东八的话 `tz` 显式写了
- [ ] `?tags=` / `?excludeTags=` 对本域条目生效(用了 `ctx.matchesTags`)
- [ ] `remind:false / alarmOffsets / isActive / ext` 语义与 §6 表一致
- [ ] 域私有参数带 `<id>` 前缀;**没读 `?past=/?future=`**(那是中枢的);
      未读任何别域参数;`config/` 之外没有新增配置值
- [ ] prepare/build 抛异常时哨兵事件出现、其它域不受影响(顺手验一次,别依赖它)
