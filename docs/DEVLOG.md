# 开发日志 (DEVLOG)

> 记录每一版的关键决策与理由。新决策往下追加,别改历史。

---

## v6.1 · 2026-07-15 —— 手术 B:账户身份改短哈希 + 清除遗留字段(破坏性)

手术 A 只换交付形态、行为全等;B 是**有意改行为**,故金标准先退役再动刀。

### 账户身份:五段长主键 → crc32 短哈希

**病根不是"长",是"身份建在有损压缩上"。** v5 的闹钟 uid 走 `asciiId()`(把五段主键压成纯 ASCII):
- 汇丰那条 **44 字符 > 下游硬限 40** —— capture 时实测:`cardAlarm=each` 下 13 条闹钟会被网关
  **静默丢弃**,只在下游面板记一笔"无uid"。用户永远看不见。
- 中文被抹掉 → `CN-招行-经典白-CNY-NA` 与 `CN-中行-长城-CNY-NA` 压成同一个 id → **撞键**。
  而 config 注释同时允许"简称可中可英"+"合并账单 last4 留空" —— 两条规则一叠加就踩雷。

处置:`accountKey(acct) = uidHash(makeAccountId(acct))`,8 位十六进制。
- 汇丰 44 → **20 字符**,13 条闹钟复活;
- crc32 原生吃 Unicode,中文撞键 bug **根治**(无需人工起短名);
- **8 位不压到 4 位**:30 个身份的生日碰撞 4位=0.66% vs 8位=0.00001%,而 `card-<8位>-<YYYYMM>`
  才 20 字符、只用掉上限 40 的一半 —— **省的是不需要的东西,赌的是输不起的东西**(撞号=闹钟互相顶掉)。

### 三个决策记录(讨论中被推翻/收敛的)

1. **一度主张手写短名 `alias`**(可读、且显示名改了 uid 不抖)。用户反驳成立:
   **uid 的工作是配对,不是沟通** —— 沟通归日历标题与闹钟 reason,手机标签里的 `repay` 已答完
   "哪个项目"。我把可读性放错了层。且"改卡名会churn"实际后果只是旧关新建、一次刷新自愈,
   我当时说重了。**改判:哈希。** 代价是自觉买单的。
   补偿:治理告警打 uid 时**必带 summary/reason** —— uid 可以不可读,**诊断必须可读**。
   两件事本来不冲突,是"改 uid"这个手段把它们绑在了一起。
2. **一度考虑"框架在输出闹钟时按长度阈值自动转哈希 + URL 参数控制"**(用户提议)。否决,三条:
   ①**长度阈值 = 悬崖**:CMB 那条 38 字符,改卡名多 3 个字就越过 40 → uid 从明文悄悄翻成哈希 →
   全体重建。**身份不能取决于"这串字符碰巧多长"这种偶然属性**;
   ②**URL 参数控制身份 = 身份跟着链接走**:调试看的(明文)和生产跑的(哈希)不是一个东西。
   视图参数改的是"你看什么",身份参数改的是"东西是谁",两个物种不能共用一套参数系统;
   ③**框架不知道身份的结构** —— 只有域知道哪一段是账户、哪一段是月份,框架只能把整串搅进哈希。
   这与"框架不许合并事件"是同一条理。
   **结论:哈不哈、哈哪段 = 设计时决定一次并冻住,不是运行时算。**
3. **三层分工定案:框架发【约束】(≤40/字符集/前缀,已在 governance)+【工具】(`uidHash`,
   与 `checkAlarmUid` 一造一查、同一件事的正反面);【策略】归插件自己。**
   不存在"信用卡模式",只有一条判据:*身份天生短且 ASCII → 直接用;身份长/含中文/机器生成 → 哈希。*
   checkin 的 `checkin-moeshare-202607` 按此判据**不哈希**(强制全域哈希是纯亏)。同判据,不同答案。
   **选了哈希 = 欠一条冻结声明**(哈希输入是哪几段、什么顺序、承诺不改),已写进 event-builder 头部
   并由 K 组测试当执行器。

### 配对(白送的)

闹钟 uid 是日历 uid 的**前缀**,肉眼即可对上,不必往日历标题里塞机器编号:
```
日历: card-b7c92750-202607-20260722
闹钟: card-b7c92750-202607
```

### 清除的遗留

- `needsFxPurchase` / `fxNote` —— 预留接口,从未启用。**违反自己"explicit over speculative"的
  投机字段**;真遇到购汇卡,事件对象的 `ext` 自由袋随时能装。
- `DEFAULT_CONFIG.pastMonths/futureMonths` —— 窗口归中枢后已成死配置(缺省搬到 config/hub.js)。
- `?adAlarms=` / `?exAlarms=` v5.2 兼容别名 —— **删除,但响亮告警**(与 `?months=` 同套路)。
  不静默忽略的理由:旧链接会"看起来正常"却悄悄拿到默认提醒 —— 不报错、只是提醒时间悄悄变了,
  最坏的那种失败。
- `asciiId()` —— 随哈希消亡。

### KV 键

`stmt:<accountKey>` / `hist:<accountKey>:<ISO>` 一并换哈希。email 模型确认**未启用、KV 无真实数据**,
零成本改键的最后窗口,用掉了。(历史流水 `hist:` 一直在只追加地存 —— 数据在,只是没展示;
将来要在日历里回溯往期账单,读 `hist:` 即可,数据层口子早就留好了。)

### 验收

金标准退役前最后一次 diff:**属性级差异 0 条** —— 全部差异都是 uid 换编号,事件内容一字未动,
正是手术 B 的目的。测试 60(v5 基线)→ **92 绿**,零回归。

---

## v6.0 · 2026-07-15 —— Tier 2 重构:域交事件对象,框架独家渲染 ICS

用户诊断:"框架没有总控参数,子项各自为政"。分析后发现**缺的不是参数,是抓手** ——
v5 已有的总控只有闹钟侧两条(未来过滤+排序),因为 alarms 是结构化的;日历本体是
`eventLines: string[]` 黑箱,框架看不见 date/uid,想管也管不了。**总控能力 = 契约透明度的函数。**
更扎心:workdays-core 的铁律是"providers emit raw facts, conclusions computed by consumers",
但本库内部域却交**结论**(渲染死的 ICS 文本)给框架 —— 同一条原则,在自己家没执行。

用户选择直接上 Tier 2(不走"域仍渲染、只额外交锚点日期"的 Tier 1),理由成立:
即将上多个时区敏感插件,不想以后返工兼容。**契约要在生态长起来之前定死** —— 现在改契约动 2 个域,
第 5 个插件时动 5 个还得开一场辩论。

### 一句话总纲

> **框架吃语法,域吃语义。**

石蕊测试(裁决任何一行代码归谁):*"输出格式从 ICS 换成 Google Calendar API,这行要不要动?"*
要动=框架;不动=域。红线:**框架永远不做业务合并** —— 域先合并、再交一个事件对象。

### 做了什么

1. **`docs/EVENT-MODEL.md`(新,宪法)** —— 事件对象契约。先写文档、文档定稿才动工。
   两条铁律:①域绝不自己换算时区(只声明墙上时间+IANA 名,换算是消费方的事 —— 与闹钟通道
   "带 tz 交给网关"完全同构);②内容块只收原始文本(转义/折行归渲染器)。
2. **`src/renderer.js`(新)** —— ICS 语法唯一产地,**所有 iOS 血债的唯一收容所**:
   相对 TRIGGER(绝对 DATE-TIME 被苹果误当 UTC 偏 8 小时 → 接口上不提供绝对 TRIGGER,
   结构性杜绝再犯)、裸 TZID 依赖(明写的决策,非疏漏)、Event Alerts 总开关。
   新插件自动继承全部赔偿。两个 TRIGGER 函数从 card/ics-builder 逐字移植。
   顺带修真 bug:v5 **零转义零折行**,卡名带逗号即破行。
3. **`src/governance.js`(新)** —— 框架长牙:窗口换算与裁剪(±45 天结构性缓冲:裁"离谱越界"
   不裁"贴边溢出")、uid 双协议校验、超时预算、`uidHash`。原则:**响亮降级,绝不静默**。
4. **中枢窗口** —— `?past=/?future=` 从 card 私产升格为中枢参数,`?months=` 废除(响亮告警)。
   **窗口是【许可边界】不是【生产配额】**(用户逼出来的语义):签到域算法只向前推,past 自然空产出,
   框架不催产;信用卡回溯有真实价值(核对推算、暴露 bug),它用足许可。同一参数,两种合法用法。
   年份推导随之归中枢(v5 里两个域各写一套算法还不一致 —— "没有总控"的具象)。
5. **两域迁移** —— checkin(engine 推算数学一字未改)、card(手术 A)。
   card 的 `indexOf('BEGIN:VEVENT')` 切片 hack 消亡(自产完整 ICS 再把 VEVENT 抠出来 —— 病灶本身);
   `ics-builder.js` → `event-builder.js`(它不再产 ICS,旧名会绊倒读者,且域目录禁 ICS 关键字);
   清掉死代码 `buildTimingLines`(定义了从未被调用)。
6. **领地看守**(EVENT-MODEL §8) —— 测试断言:域目录禁 ICS 关键字;渲染器/治理禁 import 域。
   只查代码不查散文(剥注释后再查:域注释里**应该**出现这些词,那是文档不是违规)。
7. **迁移期双契约桥** —— 我先前明确反对兼容层,此处破例:因为它有**拆除条件写在三处代码里**,
   且 legacy 域每次请求都在诊断自曝"未受治理"。永久兼容层让人忘记欠债;这个桥让欠债持续刺眼。
   **手术 A 完成即拆,已拆干净**(worker-entry 的 isV6 分支、render.test 白名单同时归零)。
8. **金标准 harness(用完即焚)** —— v5.2 刚废除的东西请回来打一场仗:钉死 testDate,
   11 条代表性 URL 抓 v5 语义快照,**比语义不比字节**(折行/属性次序/转义形式/DTSTAMP/uid 前缀
   全部归一化抹平;JSON 侧引用 governance 同一个 checkAlarmUid 双侧剔除,单一真相源)。
   手术 A 验收:11/11 全等。**手术 B 前已按服役期约定退役删除**(B 是有意改行为,再比就是自缚)——
   退役理由同 v5.2:迁移正确性是一次性证据,不该变成枷锁。

### 契约收敛(v5 → v6)

`prepare(q, ctx) → {countries, state}`;`build(state, hub, ctx) → {events, alarms, debugLines}`

规则:**ctx = 请求级恒定的一切**(env/baseDate/window/filters/matchesTags);
**hub = 阶段二才诞生的资源**(要等 prepare 报完 countries),故走位置参数。
拆桥时发现 v6 契约漏掉了 v5 `prepare` 第4参的 env(KV 驱动的域要先读 KV 才知道自己要哪些国家,
且有测试盯着)—— 补进 ctx,顺手把 build 的 env 位置参也收进 ctx,全链只此一处。

### 闹钟通道

协议 v1 **一个字未改**。Tier 2 只是让日历通道追平闹钟通道的透明度。

---

## v5.2 · 2026-07-14 —— 移除金标准冻结 + 日历提醒字段更名(两项破坏性变更)

用户两点批评,均成立,一起处理:

1. **移除 golden 金标准冻结,信用卡逻辑成为可自由演进的框架一等公民**。
   反思:v3~v5 把原项目 src 逐字节冻结在 `test/golden/`,并用 B5 字节看守 + A 组逐行对比
   焊死"信用卡逻辑 = 原版"。这是**定位倒置** —— 迁移正确性是一次性证据,不该变成"用户不能
   再改自己信用卡逻辑"的枷锁。用户原话:"以后我要动信用卡逻辑还不能改了吗?不可能啊。"
   处置:删除整个 `test/golden/`;A 组从"与原版逐行等价"重写为**结构自洽断言**(该出的账户出、
   该合并的合并、DTSTART/VALARM 符合配置);B5 从"字节看守"降为**账户开关行为断言**(停卡真停);
   H 组去掉 "verbatim 引擎" 措辞。正确性自此由 A(结构)+ E~H(口径避让/端到端,真实归档钉死)+
   I(契约)守护,校验"逻辑对不对"而非"和原版一不一样"。改信用卡逻辑 = 直接改 src/domains/card/
   + 更新对应断言,无枷锁。金标准相关文档(ARCHITECTURE §7、PLUGIN-CARD §0/§10、README 领地段、
   UPGRADE 清单)全面重写为"演进指南"。

2. **日历提醒字段更名,彻底摆脱 "alarm" 误导**(破坏性,带兼容别名)。
   反思:`adAlarms`/`exAlarms` 明明是[日历事件的 VALARM 通知],却用了 "alarm" 一词,与底部
   [闹钟网关 CARD_ALARM]共享词根 —— 正是这个命名让 v5.1 我写错注释、用户误以为"日历提醒被换成
   闹钟"。字段命名本身就是 bug。处置:`adAlarms → allDayReminders`、`exAlarms → exactReminders`
   (刻意不含 alarm);同步改 config/card.js(字段+强化注释,明说"这不是闹钟")、
   src/domains/card/ics-builder.js(消费点+死函数内键名)、adapter.js(解析函数改语义名)。
   URL 参数新增 `?allDayReminders=`/`?exactReminders=`,**保留旧名 `?adAlarms=`/`?exAlarms=`
   作兼容别名**(现有订阅链接不断)。得益于第 1 项刚移除 verbatim 束缚,此次改名无需同步任何
   冻结副本 —— 两项变更天然互相成全:能改名,正因为逻辑已不再被焊死。

**测试**:81/81(移除 A 组 6 参数组金标准对比 + B5 字节看守共 ~9 条,新增 A 组结构断言 ~7 条)。
探针确认字段更名后 exact 默认 VALARM=`-PT0M`、allday 用带符号偏移、旧参数别名仍生效。

---


承接 v5.0,处理用户补充 checkin 原始文件后的四点澄清:

1. **口径 token 统一迁 `CHN:bank`(三位显式)**:签到 MoeShare 的 `holidayCalendars` 从
   "预留注释"升为真实字段 `['CHN:bank']`;信用卡 7 处活跃 + 3 处注释示例的 `['CN']`/
   `['CN','HK']` 全部迁 `['CHN:bank',…]`。理由:①功能上 `CN≡CN:bank≡CHN:bank`,但显式
   `:bank` 钉死不被全局 `?cnRule=market` 带偏(签到/还款要的就是"补班日照常");②三位码
   统一美学(用户选)。上游实测完整识别 `CHN:bank` 且无告警(coverage 归一到 CN 数据集)。
2. **信用卡默认纯日历、不进闹钟**:`CARD_ALARM.alarmMode` 由 `merged` 改 **`off`**;
   `exAlarms` 由 `[{minutesBefore:1}]` 改 `[{minutesBefore:0}]`(准点 09:30 不提前)。
   用户偏好:还款非高时效,日历提醒够用,要提前自定义。URL `?cardAlarm=merged` 随时临时开。
3. **修正 v5.0 的一处注释误导(我的错)**:card.js 顶部曾写"加卡/改还款日/**调闹钟**都在这",
   "调闹钟"一词让纯日历配置文件的 `adAlarms`/`exAlarms`(实为日历 VALARM)被误读为闹钟。
   **数组值与逻辑从未改动**(A 组金标准全程绿即证),纯属注释措辞制造错觉。已重写顶部门楣,
   把"日历提醒 VALARM"与"闹钟网关 CARD_ALARM"两套东西彻底划清,并补 `isActive` 停卡详解
   (停卡=改 false,不必删段/注释;卓越卡作活教材)。
4. **golden 第二处接缝(token 归一化)**:配置迁 `CHN:bank` 后,verbatim 冻结的 golden
   `holidays/index.js`(只认二位码)会把该 token 落进"只按周末"降级分支 → A 组假红。
   在 golden 的 `createHolidayHub` 入口 + `makeWorkdayChecker` 加纯词汇映射(去口径后缀 +
   三位转二位),**不碰任何还款推算逻辑**。这与 config 垫片同级,属"为当测试基建而生的最小
   接缝",不违反 golden 冻结铁律;登记于 golden/README。副产品:A 组逐行等价现在**反向
   证明**了上游 `CHN:bank ≡ 原版二位 CN` 的语义等价。

**测试**:84/84(B2 新增"默认 off 时 JSON 空"一条)。探针确认 exact 默认 VALARM=`-PT0M`
(准点)、默认 JSON 空、签到 CHN:bank 无未识别告警。

---


**背景**:① 假期数据/判定与 alarm-api 各自维护两套,workdays-core 已就位(alarm-api 已接);
② 上游 v2 起词汇"一词一义"(official 等别名移除),与本库 v4.1/v4.3 契约冲突,用户裁决:
**破坏性重构,词汇整体切到上游规范**;③ 例行体检发现两处实伤(见"决策 3");④ 名称混用
(仓库 calendar-api / 文档 reminder-hub / Worker ios-calendar-ics),用户裁决统一为 **calendar-api**。

**决策**

1. **假期整层外包上游**:删除 `src/holidays/` 全部五文件,中枢直接
   `import { createHolidayHub } from '@ivanphz/workdays-core'`(签名/行为逐语义等价,
   含 Date 入参、空列表默认 CN、多国叠加、未知地区周末兜底)。本库自此**零假期数据、
   零判定实现**;换数据源/修数据/加国家 = 上游发版,经 update-core.yml 自动升级部署。
   **上游可见性(用户点名要求)**:`hub.loadLogs` 逐行进诊断;`hub.coverage` 中 `ok=false`
   的地区×年份渲染为醒目告警行(⚠️ 无真实数据,按纯周末兜底)——上游出错/缺口/词汇写错,
   一律在日历诊断事件显形,绝不静默。
2. **词汇破坏性统一(用户裁决)**:`official` 废除 → 显式写法 `bank`;`?cnRule=bank|market`
   (缺省 bank,行为=原 official 分毫未动);HK 唯一口径 `public`,v4.3 立的
   `'HK:market'/'HK:official'` 等价别名**随之废除**(该决策就此作废;当年"防被误判未实现"
   的目的由本条日志接棒)。旧词不崩:上游对未知口径退默认+loadLogs 告警,中枢对
   `?cnRule=official` 额外产出诊断告警行"已按 bank 处理"。**响亮降级,静默零容忍。**
3. **金标准 v2(根治两处实伤)**:体检发现 v4 测试 ① 金标准 import 写死了上次沙箱的绝对
   路径(换环境必挂);② 74 项中 5 项假红 —— 原因是 repayment-cal 与本库的 config 各自
   演化(原版也改成了 exact+合并、注释了一个账户),A 组把"配置相等"错误地当成了前提。
   新设计三件套:**golden 内置**(repayment-cal 终版 src 逐字节冻结进 test/golden/,原仓库
   退役归档);**配置共享**(golden 的 config.js 换成指向 config/card.js 的垫片 —— 金标准
   自此只对比逻辑,用户改配置永不再打破 A 组);**事实共享**(测试用上游 listDays/exportIcs
   把同一份 CN/HK 数据喂给 golden 的 fetch;US 两边独立算 → A 组顺带交叉验证上游 US 算法
   ≡ 原版 us.js)。副产品:金标准从"两边断网退化对比"升级为"真实假期避让下的对比",
   覆盖强度提升。B5 从抽查升级为**五文件字节级看守**。
   **golden 的职责定位(用户追问后钉死)**:测试基建(oracle/字节看守/US 交叉验证),CI 每次
   执行;**历史存档职责归 GitHub 已归档的 repayment-cal 原仓库**。刻意不做"CI 从归档仓库
   克隆"——那会重新引入外部耦合(可改名/可删除/要联网要凭据),正是本条刚根治的脆弱性;
   测试必须密闭自足,60KB 换这个,值。
4. **测试进流水线(fail-closed)**:deploy.yml 改为 npm ci → 83 项测试 → deploy,红灯不部署。
   paths 补 `config/**`(旧文件漏了它:改配置竟不触发部署)与 `package.json` /
   `package-lock.json`(上游自动升级只动这两个文件,不加则升级永不部署 —— 上游手册点名的
   头号坑),外加 `test/**`。
5. **命名定死**:GitHub 仓库/项目名 = **calendar-api**(package.json / 文档 / PRODID /
   ICS 文件名统一,"reminder-hub" 自此只是曾用名);Cloudflare Worker 部署名**保持现役的
   `ios-calendar-ics` 不变,刻意不改**(ios-*-ics 命名模式与原信用卡项目的 `ios-repay-ics`
   同款,但不是同一个 Worker)—— 同名部署 = 原地更新,订阅 URL / KV / Secret /
   Email Routing 零迁移;改名收益为零、成本是全套迁移(备忘见 UPGRADE-V5 §4)。
   过程教训一条:部署名以 **wrangler.toml 为准质证**口头信息(本次口头两度与文件不符,
   最终回归文件原值;顺带纠正"沿用原项目同名"的口误 —— 原项目查证为 ios-repay-ics)——
   以后任何"线上叫什么"的结论,先看文件、再看 Cloudflare 后台,口头记忆排最后。
6. **文档补全(用户 8 条要求的 1/3/4)**:新增 PLUGIN-CARD.md(信用卡域自足手册,收编
   repayment-cal README 的设计取舍/演进指南/排查清单三节精华)、DOWNSTREAM.md(下游
   alarm-api 能力册,插件作者视角)、UPGRADE-V5.md(一次性迁移 runbook);DEVGUIDE 假期节
   改为"上游供给",README/ARCHITECTURE 全面改版。

**测试**:83/83(A 金标准 6 参数组 · B 五点 · C 杂项 · D 领地/视图 · E CN 双口径(真实归档)
· F US 双日历 · G HK+旧别名响亮降级 · H 三叠配方 · I 插件契约)。

---

## v4 · 2026-07-08 —— 领地分离 + 视图组合 + "日历本体"定调

**背景**:v3 把用户配置混在 `src/` 框架树里,框架更新会冲掉用户改动;信用卡默认值被上一版
错误全局化过;需要一条链接自由组合多规则输出。

**决策**
1. **领地分离**:顶层 `config/` = 用户领地(hub.js / checkin.js / card.js),框架交付永不包含;
   `src/` = 框架领地,禁止出现配置值。`src/domains/card/config.js` 降级为纯转发垫片,
   让五个原逻辑文件的 `import './config.js'` 一字不改。测试 D1 看守垫片纯净性。
2. **默认值归位(用户指示)**:`config/card.js` 里 `displayMode:'exact'`、`mergeSameDay:true`。
   相对原项目 config.js 的全部差异 = 这两行 + 尾部追加的 CARD_ALARM 段(diff 留档)。
3. **定调:日历是本体,闹钟是附加输出**。`?format` 缺省 ics;alarms 只读推算结果,禁止反向影响
   事件生成;文档、诊断、代码注释统一此表述。
4. **视图组合**:中枢新增 `?exclude=`(域排除)与 `?tags= / ?excludeTags=`(条目级标签,选择型/
   排除型语义分离);所有域条目预留 `tags` 字段。一条链接 = 一种组合;ICS 链接与 JSON 链接
   各自组合,天然解耦。
5. **单条豁免**:信用卡账户支持 `remind:false`(不进网关、日历照常),与签到任务同语义。
6. **文档三件套**:ARCHITECTURE.md(结构/契约/矩阵)、DEVGUIDE.md(接入手册)、本日志。

**信用卡逻辑完整性审计(v4 复核,37 项测试全绿)**

| 原项目能力 | 现位置 | 保真方式 |
|---|---|---|
| 账户字典(6 活跃 + 卓越停用 + 🇺🇸/📧示例注释) | config/card.js | 原文(仅 2 默认值改动,diff 留档) |
| legacy 模型 + 月末溢出(31 号→次月) | repay-engine.js | 逐字节 verbatim |
| cycle 模型(statementDay+graceDays) | repay-engine.js | 逐字节 verbatim |
| email 模型(KV 最近一期、不外推) | repay-engine/storage + adapter 编排 | 文件 verbatim;编排自原 worker-entry 逐行搬 |
| 多国假期叠加(CN/HK/US, 任一放假即避让) | src/holidays/* | 逐字节 verbatim,全域共享 |
| advanceDays 工作日倒推 + holidayExtraAdvance 补偿 | repay-engine.js | 逐字节 verbatim |
| exact/allday 双显示、adAlarms 带符号时长触发、exAlarms | ics-builder.js | 逐字节 verbatim |
| 同日合并 + 分层标题(showCount/银行数降级国家聚合) | ics-builder.js | 逐字节 verbatim |
| titlePrefix / DESCRIPTION 审计正文 / DURATION | ics-builder.js | 逐字节 verbatim |
| URL 参数 mode/merge/past/future/adAlarms/exAlarms/durationMin/mergeTitleShowCount/ch/cm | card/adapter.js | 原解析逐行搬;金标准成对比对(A组) |
| Debug 报告(账户/假期源/email状态/解析失败报警) | card/adapter.js debugLines | 正文逐行搬 + 生效参数标注 |
| email 三件套(MIME/多卡 last4/Ref 去重/分层 L1–L4/收件人 Secret) | email-*.js / storage.js | 逐字节 verbatim |
| `email()` Worker 入口 / KV 绑定注释 / Actions 部署 | worker-entry / wrangler / workflow | 原样 |
| **金标准**:五组参数下 VEVENT 与原项目逐行等价(DTSTAMP 归一) | test A 组 | 双向对齐(hub默认↔orig显式;orig默认↔hub显式) |

**签到逻辑完整性**:720h+双 delay 漂移、三规则碰撞检测(同月挤压→次月 1 号重置/正常继承/
跳月重置)、审计正文、actionUrl 注入、PT10M、workday/holidayAlarms 日历 VALARM、
`?tasks=ID|锚点` 覆盖语义、`?months=`、defaultAnchor 兜底 —— engine.js 逐行保留;
仅 UID 按协议 v1 改为 `checkin-<id>-<YYYYMM>`(v2 已与你共识)。

---

## v4.5 · 2026-07-08 —— 插件契约加固 + 手册自足化

**背景**:以"插件作者只读一份文档、零源码分析即可接入"为标准审计,发现 4 个契约缺口。

**决策(框架加固,全部加法式)**
1. `prepare` 一律 `await`(支持异步插件,如 KV 驱动的推算范围);第 4 参注入 `env`。
2. **故障隔离**:域 prepare/build 抛异常仅熔断该域;ICS 强制出哨兵全天事件
   `❌ 域 xxx 构建失败`(即使 ?debug=0),JSON 静默剔除该域 —— 单插件坏不再拖垮信用卡提醒,
   且坏了在日历上看得见。
3. **透传契约化**:alarm 条目字段不增不删不改(tz 等协议可选字段原样输出),写入文档与测试。
4. `docs/DEVGUIDE.md` 全量重写为自足手册:域对象/prepare/build 逐参数规范、eventLines 装配
   硬规则(CRLF/无裸换行/DESCRIPTION 字面量 \n/UID@mycal.local/DTSTART 两式)、uid bucket 表、
   口径 token 表与三叠配方、预留字段语义表、URL 派生与私参命名、id 约束、性能预算、
   完整可抄模板、自检清单。**接入新插件只发这一份文档即可。**
5. 测试 I 组 6 项:异步 prepare、env 注入、tz 透传、熔断哨兵(debug=0 下可见)、
   同请求 card 不受牵连、JSON 合法降级。合计 74/74。

---

## v4.4 · 2026-07-08 —— 三叠配方钉死(CN+US+US:market)

**背景**:美股"卖出→回款→跨境→还款"链条需同时满足 NYSE 开市、美银行清算、国内工作日。
用户确认采用三叠组合并要求防回归。

**决策**
1. 测试 H 组 8 项:叠加语义(Good Friday/Columbus/Veterans/CN法定假/CN补班六/普通日) +
   **verbatim 还款引擎**在三叠日历上跨 Columbus 倒推(名义10/13→提醒10/9;名义恰逢
   Columbus 触发节假日补偿→10/8)。改叠加/口径实现必须先过 H 组。
2. DEVGUIDE 新增"口径组合配方":advanceDays 建议 4~5;并钉入两条事实防想当然 ——
   美股 T+0 是交易口径,资金 T+1 结算(2024-05 起)提现在结算后;Columbus/Veterans 是
   "能卖不能动钱"的半残日且结算顺延,三叠自动判休。
3. 记录一个叠加的自然性质:CN 补班周六无需切 CN:market,US 双腿周末已兜住。

---

## v4.3 · 2026-07-08 —— HK 口径别名(语法拉齐)

**决策**:'HK:market'/'HK:official' 升格为 'HK' 的**受支持等价别名**(此前是"安全忽略")。
理由:港交所日历≈公众假期+周末,与银行口径无背离,两口径天然重合;拉齐三国 token 语法后,
配置书写无需记忆"哪国可带后缀"。契约由测试 G 组看守(逐日等价+叠加),头注明示,防止将来
被误判为"未实现"而改动。三国口径语义总结:**CN=同数据换规则,US=换日历,HK=同一份**。

---

## v4.2 · 2026-07-08 —— US:market(NYSE 交易日历)落地

**背景**:v4.1 的 token 语法对 US 只是"安全忽略"。与 CN 不同,US 的 market 不是换规则而是
**换日历**(NYSE 假日集 ≠ 联邦假日集,双向差异),需要独立数据。

**决策**
1. 新增 `src/holidays/us-market.js`:NYSE 全日休市纯算法生成(含复活节 Computus → Good Friday;
   NYSE 观察日规则:周日→周一、周六→周五,元旦例外不补休)。半日市视为开市。us.js 保持 verbatim。
2. `index.js` 接线:'US:market' 触发惰性创建 NYSE provider,判定分支独立;'US:official'≡'US'。
3. **刻意不提供 ?usRule 全局默认**:market 把银行休息日(Columbus/Veterans)判为工作日,
   全局切换会让还款踩空;仅允许条目级显式声明。CN 可全局切是因为其 market 口径只增不减休息日
   (对转账严格更保守),US 不满足该性质。
4. 测试 F 组 9 项:Good Friday/Columbus/Veterans 双向背离、7/4 周六平移、元旦周六例外
   (2027-12-31 银行休/NYSE开)、半日市开市、token 等价、CN 叠加。合计 57/57。

---

## v4.1 · 2026-07-08 —— CN 双口径(official / market)

**背景**:调休补班周末,银行网点上班但 A 股闭市、跨行清算按周末档;还款/转账场景把补班日
当工作日会误判。需求:新增"只认放假、补班亦休"的口径,默认仍走调休那套。

**决策**
1. 实现位置:`src/holidays/index.js`(判定层唯一改动点;cn.js 的三态 lookup 原样复用,零改动)。
   ⚠️ 自本版起 index.js 不再是原项目 verbatim(加法式扩展);default 路径行为逐字节等价,
   金标准 A 组全绿背书。cn/hk/us 三个 provider 仍 verbatim。
2. 语义:market 口径下 `lookup===false`(补班)不作数,落回周末规则 → 工作日 = 周一至五 且 非法定假。
3. 优先级:条目 token `'CN:market'/'CN:official'` > URL `?cnRule=` > 缺省 `official`。
   token 在 provider 创建时归一化('CN' 与 'CN:market' 共用同一份数据,不重复拉取)。
4. 诊断报告新增一行,始终标注当前 CN 口径。
5. 测试 E 组 11 项:两口径×(法定假/补班六/普通日)、全局默认、token 优先、多国叠加、管道与诊断标注。

**调研结论(用户提问:HK/US 是否存在同类问题)**
- 调休/补班为大陆特有制度;HK/US 从不把周末改为工作日 → 无需第二口径。
- HK:公众假期落周日则次日补假(政府 ICS 已含,hk.js 即用该源);HKEX=周末+公众假期闭市,
  另有农历除夕/平安夜/新年前夕半日市(上午有市,对还款无影响);2024-09 起台风天不停市。
  → 还款场景现有日历即正确。
- US:无补班;us.js 已实现观察日规则(周六→周五、周日→周一)。注意**银行日历≠股市日历**:
  NYSE 在 Good Friday 闭市(银行开)、在 Columbus/Veterans Day 开市(银行关)。us.js 注释明言
  取"银行/ACH 的 11 个联邦假日"口径 —— 对还款正确。若将来做美股交易日历,按 token 语法
  扩 `US:market` + NYSE provider 即可。

---

## v3 · 2026-07-08 —— verbatim + 薄适配层

- 收到最新版信用卡代码(新增 email 模型)。策略反转:不再把信用卡改写成中枢形状,
  改为**原文件逐字节保留 + adapter 适配**;建立金标准等价测试。
- 参数域内自治(v2 曾把信用卡参数误设为全局,纠正)。
- 信用卡闹钟三档(merged/each/off),默认同日合并一条;签到闹钟与日历 VALARM 脱钩,默认准点一条。
- 诊断事件默认开,写明生效默认值。

## v2 · 2026-07 —— 四层解耦初版(已被 v3/v4 取代)

- Occurrence 单一契约、rules/serialize 分层;确立 uid 协议实践:
  bucket 锚定账单月/落点月而非响铃日,修掉两个旧项目 uid 含时间导致的网关抖动。

## v1 · 2026-07 —— 方案确认

- 确认双输出(ICS 订阅 + 闹钟网关 JSON)、分册颜色靠分链接订阅、
  信用卡与签到共用一根脊柱。

---

## 待办 / 展望

- [ ] 香港卡按邮件实测数据逐步切 `model:'email'`(KV + Email Routing 就绪即换)
- [ ] email-parser L1(PDF 附件)/L2/L3 层实现(接口已留)
- [ ] 新域候选:充值提醒、会员到期(按 DEVGUIDE 三步接入)
- [ ] 若引入英国假期:holidays/gb.js + index 注册一行
