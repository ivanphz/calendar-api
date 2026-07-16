# 信用卡域完整手册 (PLUGIN-CARD)

> **这份文档给谁看**:要维护、排查、演进信用卡域的人或 AI。目标:**读完本文 + DEVGUIDE,
> 无需任何其它上下文即可安全接手**。信用卡逻辑源自独立项目 repayment-cal(已归档),但自
> 并入框架起就是**框架里一个可自由演进的一等公民** —— 想改逻辑、改字段、改结构,直接改
> `src/domains/card/` 下的文件即可,和改任何其它插件没区别(v5.2 起已移除"原版冻结不可改"
> 的约束,理由见 DEVLOG v5.2)。
>
> 心智模型一句话:信用卡域 = 框架里最重的内置插件 —— 一层 adapter 把域逻辑翻译成框架契约,
> 下面几个文件承载三模型还款推算 / ICS 生成 / email 管线。它们是**活代码**,不是标本。

---

## 0. 文件地图与职责

```
config/card.js                     ★ 用户领地:账户字典 + DEFAULT_CONFIG + CARD_ALARM
                                     (加卡/改还款日/改日历提醒,唯一日常要动的文件)
src/domains/card/
├─ adapter.js                      框架适配层:解析本域 URL 参数、编排、窗口 MAP、
│                                    闹钟策略(merged/each/off)与 uid、debugLines
├─ config.js                       ⚠️ 纯转发垫片 → config/card.js(禁放任何值,测试 D1 看守)
├─ repay-engine.js                 三模型还款日推算 + 工作日倒推 + 假期补偿
├─ event-builder.js                事件【对象】组装 / 合并分层标题 / 审计正文 / 提醒意图
│                                    + 🔒 账户身份哈希输入的【冻结声明】(见 §1)
│                                    (v6 前叫 ics-builder.js —— 它不再产任何 ICS 文本了)
├─ email-handler.js                收信编排(校验/去重/匹配账户/写 KV)
├─ email-parser.js                 MIME 解码 + 四层解析管线(现仅 L4)
└─ storage.js                      KV 键名约定 + 读写封装
```

### 改动指南(动手前必读)

信用卡逻辑是**框架的一等公民,可自由演进**,没有"不可改的原版"约束。按改什么去对应文件:

- 改显示/参数/闹钟策略 → **adapter.js**。
- 改配置/加卡/改提醒时间 → **config/card.js**(你的领地)。
- 改还款推算/事件结构/email 管线 → 直接改 **repay-engine.js / event-builder.js / email-*.js**,
  和改任何插件一样。改完:① 更新 test/hub.test.mjs 里相应的结构/口径断言(A、E~H 组);
  ② 若是破坏性变更(改了字段名/URL 参数/输出结构),在 DEVLOG 记一笔;旧 URL 参数的处置
  规矩见 ARCHITECTURE §9 结尾(**删除 + 响亮告警**,不留静默兼容);③ 跑 `npm test` 确认绿。
- ⚠️ **本域不许出现任何 ICS 关键字**(BEGIN:VEVENT / DTSTART / TRIGGER: …)—— 渲染归框架
  `src/renderer.js`,有领地看守测试盯着(ARCHITECTURE §8)。你只交【事件对象】。
- 加全新能力(新还款模型、新输出格式)→ 若与信用卡强相关放本域,否则考虑开新域(见 DEVGUIDE)。

---

## 1. 核心概念:账单账户(account),不是"卡"

本系统追踪的单位是**一个独立账单**,不是一张物理卡:
- 招行 5 张卡合并成 1 个账单 → 1 个 account 条目(还 1 次款)。
- 汇丰 Pulse 一卡出港币+人民币两个账单 → 2 个 account 条目(各还一次)。
- 某银行几张卡分开出账单 → 每张卡一个条目。

**身份五段组合(自动生成,不用填)**:`country + bankShortName + cardName + repayCurrency + last4`。
为什么是五段(两种真实场景的依据,勿简化):
① 同卡同账单日出多币种账单(Pulse HKD/CNY)—— `repayCurrency` 保证两条不同身份、互不覆盖;
② 合并账单没有单一卡号 —— `last4` 留空时前四段依然唯一。

### 🔒 哈希输入冻结声明(v6)

> **哈希输入 = `country - bankShortName - cardName - repayCurrency - (last4 || 'NA')`,
> 按此顺序、此分隔符,特殊字符过滤规则同 `makeAccountId()`,永不改动。**
> 以后要加字段?**加在别处,不进哈希。**

改一个字 = 全部 uid 变 = 网关全体重建(旧的自动关、新的自动建,一次刷新自愈,不是灾难 ——
但没必要平白无故来这么一下)。此声明由 **hub.test.mjs K 组第一条断言当执行器** ——
声明不靠自觉,靠测试。

**为什么本域选哈希**(判据见 DEVGUIDE §5.2:*身份天生短且 ASCII → 直接用;
身份长/含中文/机器生成 → 哈希*):

- 汇丰那条五段串出来 **44 字符 > 下游硬限 40** —— v5 时 `cardAlarm=each` 下**13 条闹钟会被
  网关静默丢弃**,只在下游面板记一笔"无uid",你永远看不见;
- PAB 那条含中文('一账通')。v5 用有损 ASCII 压缩来救,结果两张中文简称的 CNY 无尾号卡会被
  压成**同一个 id → 撞键**(而 config 注释同时允许"简称可中可英"+"合并账单 last4 留空",
  两条规则一叠加就踩雷)。crc32 原生吃 Unicode,该 bug **根治**。

对比:签到域的 `checkin-moeshare-202607` 天生又短又 ASCII → **它不哈希**。同判据,不同答案。

**身份怎么用**(全库唯一入口 `accountKey(acct)` = `uidHash(makeAccountId(acct))`,8 位十六进制):

| 用途 | 形状 |
|---|---|
| 日历 uid | `card-<哈希>-<账单月YYYYMM>-<提醒日YYYYMMDD>` |
| 闹钟 uid(each) | `card-<哈希>-<账单月YYYYMM>` ← 是日历 uid 的**前缀**,肉眼配对 |
| KV 键 | `stmt:<哈希>` / `hist:<哈希>:<ISO时间>` |

**哈希不可读怎么办 —— 它不需要可读**:uid 的工作是【配对】不是【沟通】。沟通归日历标题与
闹钟 `reason`(全是人话);手机标签 `Gate-ES-repay-<uid>-<HHMM>` 里的 `repay` 已答完"哪个项目";
**治理诊断打 uid 时必带 summary/reason**,排错不用查表。

**字段显示位置对照**(加卡前先看,决定你怎么填):

| 字段 | 显示位置 | 说明 |
|---|---|---|
| bankShortName | 日历标题 | 银行简称,越短越好 |
| bankFullName | 事件正文 | 全称,点开才见 |
| cardName | 标题+正文 | 产品名;合并账单写清由哪几张卡合出 |
| last4 | 事件正文 | 后四位;合并账单留空 `''`;**email 模型必填**(邮件匹配键) |
| emoji / countryLabel | 标题 / 正文 | 国旗一眼识别 / 地区中文名 |
| repayCurrency | 标题旁+正文 | "要还进去哪种货币",不是这卡能刷什么币 |

---

## 2. 三种还款日模型(model 字段,可混用,每账户自选)

| 模型 | 字段 | 语义 | 适用 |
|---|---|---|---|
| `legacy` | `repayDay` | 每月固定还款日 | 大陆固定还款日的卡 |
| `cycle` | `statementDay + graceDays` | 还款日 = 账单日 + 期限天数 | "账单日+N天"的卡,天然规避二月天数问题 |
| `email` | `emailDateOffsetDays / emailGraceDays` | 还款日来自**账单邮件实测**(KV) | 规律摸不清、要绝对精确的卡 |

**legacy 的月末溢出规则(取舍依据,勿"修复")**:该日在当月不存在时(如 2 月无 29 号),
**溢出到下月对应日**(29号→3月1日),而不是压到 2 月 28。旧写法 `Math.min(repayDay,当月天数)`
会导致"提前还款",还会和真正 28 号还款的账户撞同一天 —— 宁可计算基准晚一天,不要早算。

**email 模型的哲学(为什么只存最近一期、不外推未来)**:账单邮件是事件流,只能证明"已发生
的这一期";外推未来 = 猜周期规律,而这恰是 email 模型要替代的东西(知道规律直接用 cycle)。
全部价值 = 用实测替代猜测,牺牲"看得到未来"换"这一期绝对精确"。下期等下封邮件到达自动出现。

**emailDateOffsetDays 为什么是固定减 N 天**:数据点还少,看不出规律。该字段与
`inferStatementDate()` 就是留的口子 —— 积累"收件精确时刻 vs 真实账单日"对照(KV 的 hist:
流水自动攒)后,在那个函数里换成按时段/工作日细分的规则,其余代码不动。

---

## 3. 假期避让与提前量

- `holidayCalendars`:数组,这张卡还款需要"同时在线"的地区,**任一地区休息即避让**
  (口径 token 全表与三叠配方见 DEVGUIDE §5.5;美股全链条 = `['CN','US','US:market']`)。
  典型:CN 卡 `['CN']`;HK 卡 `['CN','HK']`;US 卡 `['CN','US']`。
- `advanceDays`:提前几个**工作日**提醒(在上述合并工作日历上倒推)。
- `holidayExtraAdvance`(全局,0 或 1):名义还款日恰逢休息日时,额外再多提前几个工作日的补偿。
- 假期事实来自上游 workdays-core(v5 起),本域只拿判断器;数据缺口会在诊断事件告警。

---

## 4. 日历显示(DEFAULT_CONFIG,URL 可临时覆盖)

| 参数 | URL | 说明 |
|---|---|---|
| displayMode | `?mode=exact\|allday` | exact=固定北京时刻事件;allday=全天事件(闹钟随设备时区)。你的默认:**exact** |
| mergeSameDay | `?merge=1\|0` | 同日多账单合并为一个事件。你的默认:**合并** |
| mergeTitleShowCount | `?mergeTitleShowCount=` | 合并标题最多展示几个银行分段,超出折叠"等N笔" |
| maxDistinctBanksInTitle | — | 标题里不同银行数超过它 → 降级纯国家聚合(🇨🇳×2 🇭🇰×3) |
| targetChinaHour/Minute | `?ch= ?cm=` | exact 模式的北京时刻 |
| exactDurationMin | `?durationMin=` | exact 事件时长 |
| allDayReminders | `?allDayReminders=-1:20:00,0:09:30` | **allday 模式**日历提醒意图:dayOffset:HH:MM 列表 |
| exactReminders | `?exactReminders=1,60` | **exact 模式**日历提醒意图:提前分钟列表。**你的默认 `[0]` = 事件准点(09:30)提醒不提前**;要提前改 config/card.js 的 exactReminders 或用此参数 |
| titlePrefix | — | 标题统一前缀(💳Repay),通知被截断也认得出 |

这些是**日历侧**提醒,与闹钟网关无关(解耦矩阵见 ARCHITECTURE §5)。

> ⚠️ **v6 破坏性变更**
> - **生成窗口 `pastMonths/futureMonths` 已从本域移除** —— `?past=/?future=` 升格为**中枢参数**
>   (缺省搬到 `config/hub.js`),一条参数统管全域。本域姿态 `window: 'MAP'`:把中枢的绝对
>   日期窗映射成账单月循环边界。窗口是**许可边界不是生产配额**,本域回溯有真实价值
>   (核对推算、暴露 bug),所以它用足这个许可。
> - **旧别名 `?adAlarms=` / `?exAlarms=` 已删除**(v5.2 起的正名是 `?allDayReminders=` /
>   `?exactReminders=`)。写了不崩,但会**按默认提醒处理并在诊断响亮告警**。
>   不静默忽略的理由:旧链接会"看起来正常"却悄悄拿到默认提醒 —— 不报错、只是提醒时间悄悄
>   变了,最坏的那种失败。
> - 你**交事件对象,不交 VALARM 文本** —— `reminders: [{minutesBefore}]` /
>   `[{dayOffset, at}]` 是**意图**,TRIGGER 语法归框架渲染器。

---

## 5. 闹钟网关输出(CARD_ALARM,只影响 ?format=json)

三档 `alarmMode`(URL `?cardAlarm=merged|each|off` 临时覆盖):

| 档 | 语义 | uid 形状 |
|---|---|---|
| **off(当前默认)** | **信用卡完全不进闹钟网关,只出日历** —— 当前偏好:日历提醒已够用,还款非高时效 | — |
| merged | 同一天所有还款 = 一条闹钟,绝不同时响多条 | `card-day-YYYYMMDD` |
| each | 每笔账单一条,可单独勾销 | `card-<账户哈希>-<YYYYMM账单月>`(20 字符;v5 是五段长主键,汇丰那条 44 > 40 会被网关静默丢弃) |

- 响铃时刻 = targetChinaHour/Minute(`?ch= ?cm=` 照常可调);**改时刻 uid 不变仅 time 变**
  (bucket 锚定账单月/响铃日,不含时钟时间 —— 网关平滑改期不抖,依据见 DOWNSTREAM §2)。
- 单卡豁免:账户条目加 `remind:false` → 不进网关,日历照常。
- 铁律:闹钟只从推算结果衍生,**绝不为闹钟改动事件生成**(日历是本体)。

---

## 6. email 模型启用(一次性三步,可选;不启用完全不影响 legacy/cycle)

原理:银行 e-statement 邮件 → Cloudflare Email Routing → 本 Worker `email()` 入口 →
解析 → 存 KV → 日历生成时读取。

1. **KV**:Cloudflare 后台建 namespace(名字随意)→ 复制 ID → `wrangler.toml` 取消 KV 三行
   注释填入 → push 部署。
2. **Email Routing**:域名 → Email → 启用 → Create address(建议"银行名+随机串"防垃圾)→
   Action 选 **Send to a Worker** → 选 `ios-calendar-ics`(本项目 Worker 部署名)。网银里把 e-statement 通知邮箱改到该地址。
3. **Secret**:Worker → Settings → Variables and Secrets → 加 Secret `EXPECTED_RECIPIENT` =
   第 2 步的完整地址。作用:只处理发到该地址的邮件,其余拒收并记录。**地址只存在于 Secret,
   不出现在任何代码/仓库 —— 这是仓库可公开的前提之一。**

账户切换:`model:'email'` + `emailDateOffsetDays`(收件日减 N 推定账单日,默认 2)+
`emailGraceDays`(账单日加 N 为还款日,默认 21);`last4` **必填**(邮件卡号→账户匹配键;
一封邮件列多卡会同时更新所有匹配账户,含同卡双币两条)。

**KV 键**:`stmt:<accountKey>` 最近一期实测(日历用,只存最新,不外推);`hist:<accountKey>:<时间>`
历史流水(含精确收件时刻,为将来分析账单日规律自动积累原始数据)。
`accountKey` = 五段身份的 crc32 短哈希,与日历/闹钟 uid **同源**(§1 冻结声明)。
> 💡 **历史数据一直在存,只是没展示。** `hist:` 是只追加的流水 —— 将来想让"以往解析过的账单"
> 也出现在日历里(窗口 `from` 之内),读 `hist:` 即可,数据层的口子早就留好了。
> 展示与否是本域的一个纯业务决定,框架层零障碍。
**报警**:解析失败记入 KV 并在诊断事件报警(如银行改邮件模板致正则失效),绝不静默丢失。
**解析器四层**:L1 附件 PDF → L2 正文还款日 → L3 正文账单日 → L4 收件日推算;当前只实现
L4,上三层接口已留在 email-parser.js,实现后自动优先生效。

---

## 7. 设计取舍备忘(为什么这么做 —— 防"后来的自己"想当然翻案)

- **US 假期为何算法写死不抓 ics**:苹果官方 US_en.ics 混入情人节/万圣节等几十个民间节日
  (银行照常营业),直接用会大量误判。联邦假期是纯算法(固定日或"某月第N个星期几"+observed
  顺延),无农历,写死更可靠。已用官方数据核对全部 11 个假期含"7/4 周六→观察日 7/3"边界。
  (v5 起该算法住上游 workdays-core 的 USA 数据集,已用官方数据核对全部 11 个假期。)
- **HK 为何用政府 1823 源不用苹果 HK_zh.ics**:苹果那份混入小寒/大寒等节气(非假期),
  且用 RRULE 重复规则解析复杂;政府源逐年展开、干净。(v5 起由上游归档供给,同源。)
- **2 月溢出**见 §2;**五段身份 + 哈希冻结**见 §1;**email 只存最近一期**与 **offset 留口**见 §2。
- **为何不给每张卡手写短名(alias)而用哈希**:一度主张过 alias(可读、且改显示名 uid 不抖)。
  被推翻,理由成立:**uid 的工作是配对不是沟通** —— 沟通归日历标题与闹钟 reason,手机标签里的
  `repay` 已答完"哪个项目"。可读性被放错了层。且"改卡名会churn"的实际后果只是旧关新建、
  一次刷新自愈。哈希换来零配置 + Unicode 原生 + 不会手滑写重。代价(改显示名会churn)是
  自觉买单的。补偿:治理诊断打 uid 必带 summary/reason。详见 DEVLOG v6.1。
- **为何不让框架"按长度自动转哈希 + URL 参数控制"**:①**长度阈值 = 悬崖** —— CMB 那条 38 字符,
  改卡名多 3 个字就越过 40,uid 从明文悄悄翻成哈希 → 全体重建。**身份不能建在"这串字符碰巧
  多长"这种偶然属性上**;②**URL 参数控制身份 = 身份跟着链接走** —— 调试看的(明文)和生产跑的
  (哈希)不是一个东西;③**框架不知道身份的结构** —— 只有本域知道哪段是账户、哪段是月份。
  结论:**哈不哈、哈哪段 = 设计时决定一次并冻住,不是运行时算。**

---

## 8. iOS 血泪坑(排查前必读,都是实测)

1. **「事件提醒」总开关**:日历 App → 日历列表 → 该订阅日历右侧 ⓘ → 通知里的开关。
   它凌驾于 ics 内一切 VALARM 之上,**关了神仙都救不了**,且与代码/内容完全无关。
2. **订阅缓存**:iOS 订阅日历走 Apple 服务器代理转发,有自己的缓存节奏;改代码后建议
   **删除订阅重新添加**,别等自然刷新。
3. **UTC TRIGGER 8 小时坑**:实测苹果日历把不带时区标记的绝对 `TRIGGER;VALUE=DATE-TIME`
   当 UTC 解析,偏移整整一个时区差。
   **v6 起本坑结构性消失** —— 渲染器**只产相对 TRIGGER**,接口上根本不提供绝对 TRIGGER,
   你想踩都踩不到。该血债连同另外两条(裸 TZID 依赖、Event Alerts 总开关)已收容进
   `src/renderer.js` 头注,新插件自动继承赔偿(ARCHITECTURE §7)。

---

## 9. 排查清单

| 症状 | 查法 |
|---|---|
| 日历完全没事件 | 诊断事件看【假期数据源状态·上游 workdays-core】是否满屏 ⚠️;新账户 `isActive` 忘了置 true |
| 某年推算全踩周末 | 诊断里 `⚠️ [XX 202N] 无真实数据(fallback)` = 上游该年归档缺失(公告未发属正常;否则去上游仓库跑 Refresh) |
| 收不到 iOS 提醒 | §8 第 1、2 条 |
| allday 闹钟时间不对 | §8 第 3 条 |
| email 账户始终不出现 | 诊断"email 模型状态"应显示等待首封;核对 Routing 规则 / EXPECTED_RECIPIENT / last4 与邮件后四位逐字一致 |
| 解析失败报警频繁 | 多半银行改了邮件模板;去 email-parser.js 的 extractStatementInfo 对照最新邮件调正则(改动指南见 §0) |
| 域整个熔断(❌ 哨兵事件) | 看哨兵 DESCRIPTION 的阶段与报错;其它域不受影响,修复后刷新即恢复 |

---

## 10. 沿革(一段速览)

独立项目 repayment-cal(legacy→cycle→email 三模型、多国叠加、合并标题、email 三件套)
→ v3 并入本框架、建立金标准回归 → v4 配置迁至用户领地 config/card.js(默认改为 exact+合并)
→ v4.5 契约加固 → **v5 原仓库归档**、假期层移交上游 → **v5.2 移除金标准冻结、信用卡逻辑
成为可自由演进的框架一等公民**,同批把 `adAlarms/exAlarms` 更名为 `allDayReminders/
exactReminders`(彻底摆脱 "alarm" 对日历提醒的误导,旧 URL 参数名留兼容别名)。
→ **v6 Tier 2 重构**:本域不再产 ICS 文本,改交**事件对象**,渲染归框架独家
(`ics-builder.js` → `event-builder.js`;adapter 里那段"自产完整 ICS 再用 indexOf 把 VEVENT
抠出来"的切片 hack 随之消亡 —— 那是契约错位的病灶本身);`?past=/?future=` 升格中枢参数;
→ **v6.1 手术 B**:账户身份改 crc32 短哈希(汇丰 44→20 字符,13 条闹钟复活;中文撞键根治)、
删 `needsFxPurchase/fxNote` 投机字段、删 `?adAlarms/?exAlarms` 旧别名、KV 键换哈希。
本文成为该域唯一权威手册;演进方式见 §0"改动指南",决策沿革见 DEVLOG。
