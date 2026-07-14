# 信用卡域完整手册 (PLUGIN-CARD)

> **这份文档给谁看**:要维护、排查、演进信用卡域的人或 AI。目标:**读完本文 + DEVGUIDE,
> 无需任何其它上下文即可安全接手**。原独立项目 repayment-cal 已退役,其终版逐字节冻结于
> `test/golden/`;那个仓库的全部经验(设计取舍、iOS 血泪坑、排查法)已收编进本文,
> **不必再去翻旧仓库**。
>
> 心智模型一句话:信用卡域 = 框架里最重的内置插件 —— 五个**逐字节 verbatim** 的原版逻辑
> 文件,外面包一层 adapter 把它翻译成框架契约。verbatim 是被测试字节级看守的铁律,见 §1。

---

## 0. 文件地图与职责

```
config/card.js                     ★ 用户领地:账户字典 + DEFAULT_CONFIG + CARD_ALARM
                                     (加卡/改还款日/调闹钟,唯一要动的文件)
src/domains/card/
├─ adapter.js                      框架适配层(v4 新写,非 verbatim):
│                                    · 解析本域 URL 参数(与原项目逐字同义)
│                                    · 编排 = 原 worker-entry 主流程逐行搬运
│                                    · 从原版 buildCalendar 输出中抽取 VEVENT 段
│                                    · 闹钟策略(merged/each/off)与 uid 生成
│                                    · debugLines(原诊断正文 + 生效参数标注)
├─ config.js                       ⚠️ 纯转发垫片 → config/card.js(禁放任何值,测试 D1 看守)
├─ repay-engine.js                 🧊 verbatim:三模型还款日推算 + 工作日倒推 + 假期补偿
├─ ics-builder.js                  🧊 verbatim:事件生成/合并分层标题/VALARM
├─ email-handler.js                🧊 verbatim:收信编排(校验/去重/匹配账户/写 KV)
├─ email-parser.js                 🧊 verbatim:MIME 解码 + 四层解析管线(现仅 L4)
└─ storage.js                      🧊 verbatim:KV 键名约定 + 读写封装
test/golden/src/                   🧊 原项目终版冻结(金标准 oracle;唯一改动=config 垫片)
```

### verbatim 铁律(动手前必读)

五个 🧊 文件与 `test/golden/src/` 同名文件**逐字节一致**,由测试 B5 强制看守。这保证一件事:
**中枢的信用卡 = 退役原版的信用卡**,金标准 A 组的逐行等价才有意义。

- 修显示、修参数、修闹钟 → 去 **adapter.js**(它不是 verbatim,可自由演进)。
- 修配置、加卡 → 去 **config/card.js**。
- **确要演进核心逻辑**(改 repay-engine 等)→ 这是"有意识地告别 verbatim",正确姿势:
  ① 同步修改 `src/domains/card/<文件>` 与 `test/golden/src/<文件>`(保持 B5 绿 —— golden
  自此代表"当前逻辑基线"而非"历史原版");② DEVLOG 记录"自本版起 <文件> 告别原版
  verbatim";③ A 组金标准继续有效(它对比的是 golden,同步改后仍逐行等价)。
  **禁止**只改一边把 B5 灭红了事,也禁止改 A 组来"适配差异"。

---

## 1. 核心概念:账单账户(account),不是"卡"

本系统追踪的单位是**一个独立账单**,不是一张物理卡:
- 招行 5 张卡合并成 1 个账单 → 1 个 account 条目(还 1 次款)。
- 汇丰 Pulse 一卡出港币+人民币两个账单 → 2 个 account 条目(各还一次)。
- 某银行几张卡分开出账单 → 每张卡一个条目。

**主键五段组合(自动生成,不用填)**:`country + bankShortName + cardName + repayCurrency + last4`。
为什么是五段(两种真实场景的依据,勿简化):
① 同卡同账单日出多币种账单(Pulse HKD/CNY)—— `repayCurrency` 保证两条不同主键、互不覆盖;
② 合并账单没有单一卡号 —— `last4` 留空时前四段依然唯一。

**字段显示位置对照**(加卡前先看,决定你怎么填):

| 字段 | 显示位置 | 说明 |
|---|---|---|
| bankShortName | 日历标题 | 银行简称,越短越好 |
| bankFullName | 事件正文 | 全称,点开才见 |
| cardName | 标题+正文 | 产品名;合并账单写清由哪几张卡合出 |
| last4 | 事件正文 | 后四位;合并账单留空 `''`;**email 模型必填**(邮件匹配键) |
| emoji / countryLabel | 标题 / 正文 | 国旗一眼识别 / 地区中文名 |
| repayCurrency | 标题旁+正文 | "要还进去哪种货币",不是这卡能刷什么币 |
| needsFxPurchase / fxNote | 不显示 | 购汇卡预留接口,暂无逻辑 |

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
| pastMonths / futureMonths | `?past= ?future=` | 生成窗口 |
| targetChinaHour/Minute | `?ch= ?cm=` | exact 模式的北京时刻 |
| exactDurationMin | `?durationMin=` | exact 事件时长 |
| adAlarms | `?adAlarms=-1:20:00,0:09:30` | **allday 模式**日历 VALARM:dayOffset:HH:MM 列表 |
| exAlarms | `?exAlarms=1,60` | **exact 模式**日历 VALARM:提前分钟列表 |
| titlePrefix | — | 标题统一前缀(💳Repay),通知被截断也认得出 |

这些 VALARM 是**日历侧**提醒,与闹钟网关无关(解耦矩阵见 ARCHITECTURE §5)。

---

## 5. 闹钟网关输出(CARD_ALARM,只影响 ?format=json)

三档 `alarmMode`(URL `?cardAlarm=merged|each|off` 临时覆盖):

| 档 | 语义 | uid 形状 |
|---|---|---|
| merged(默认) | 同一天所有还款 = 一条闹钟,绝不同时响多条 | `card-day-YYYYMMDD` |
| each | 每笔账单一条,可单独勾销 | `card-<五段主键>-<YYYYMM账单月>` |
| off | 信用卡完全不进网关(仅日历) | — |

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

**KV 键**:`stmt:<账户ID>` 最近一期实测(日历用,只存最新,不外推);`hist:<账户ID>:<时间>`
历史流水(含精确收件时刻,为将来分析账单日规律自动积累原始数据)。
**报警**:解析失败记入 KV 并在诊断事件报警(如银行改邮件模板致正则失效),绝不静默丢失。
**解析器四层**:L1 附件 PDF → L2 正文还款日 → L3 正文账单日 → L4 收件日推算;当前只实现
L4,上三层接口已留在 email-parser.js,实现后自动优先生效。

---

## 7. 设计取舍备忘(为什么这么做 —— 防"后来的自己"想当然翻案)

- **US 假期为何算法写死不抓 ics**:苹果官方 US_en.ics 混入情人节/万圣节等几十个民间节日
  (银行照常营业),直接用会大量误判。联邦假期是纯算法(固定日或"某月第N个星期几"+observed
  顺延),无农历,写死更可靠。已用官方数据核对全部 11 个假期含"7/4 周六→观察日 7/3"边界。
  (v5 起该算法住上游 workdays-core 的 USA 数据集;金标准 A 组持续交叉验证它 ≡ 原版 us.js。)
- **HK 为何用政府 1823 源不用苹果 HK_zh.ics**:苹果那份混入小寒/大寒等节气(非假期),
  且用 RRULE 重复规则解析复杂;政府源逐年展开、干净。(v5 起由上游归档供给,同源。)
- **2 月溢出**见 §2;**五段主键**见 §1;**email 只存最近一期**与 **offset 留口**见 §2。

---

## 8. iOS 血泪坑(排查前必读,都是实测)

1. **「事件提醒」总开关**:日历 App → 日历列表 → 该订阅日历右侧 ⓘ → 通知里的开关。
   它凌驾于 ics 内一切 VALARM 之上,**关了神仙都救不了**,且与代码/内容完全无关。
2. **订阅缓存**:iOS 订阅日历走 Apple 服务器代理转发,有自己的缓存节奏;改代码后建议
   **删除订阅重新添加**,别等自然刷新。
3. **UTC TRIGGER 8 小时坑**:allday 闹钟必须用相对偏移(adAlarms 机制),**不要改回**绝对
   `TRIGGER;VALUE=DATE-TIME` —— 实测苹果日历把不带时区标记的绝对时间当 UTC 解析,偏移
   整整一个时区差。

---

## 9. 排查清单

| 症状 | 查法 |
|---|---|
| 日历完全没事件 | 诊断事件看【假期数据源状态·上游 workdays-core】是否满屏 ⚠️;新账户 `isActive` 忘了置 true |
| 某年推算全踩周末 | 诊断里 `⚠️ [XX 202N] 无真实数据(fallback)` = 上游该年归档缺失(公告未发属正常;否则去上游仓库跑 Refresh) |
| 收不到 iOS 提醒 | §8 第 1、2 条 |
| allday 闹钟时间不对 | §8 第 3 条 |
| email 账户始终不出现 | 诊断"email 模型状态"应显示等待首封;核对 Routing 规则 / EXPECTED_RECIPIENT / last4 与邮件后四位逐字一致 |
| 解析失败报警频繁 | 多半银行改了邮件模板;去 email-parser.js 的 extractStatementInfo 对照最新邮件调正则(改前读 §0 verbatim 铁律) |
| 域整个熔断(❌ 哨兵事件) | 看哨兵 DESCRIPTION 的阶段与报错;其它域不受影响,修复后刷新即恢复 |

---

## 10. 沿革(一段速览)

独立项目 repayment-cal(legacy→cycle→email 三模型、多国叠加、合并标题、email 三件套)
→ v3 以 **verbatim+薄适配**方式并入本框架并建立金标准 → v4 配置迁至用户领地 config/card.js
(仅两处默认值按用户指示改动:exact+合并)→ v4.5 契约加固 → **v5 原仓库退役**:终版冻结
`test/golden/`,假期层移交上游,本文成为该域唯一权威手册。逐项能力→位置→保真方式的
审计表见 DEVLOG v4;金标准设计见 ARCHITECTURE §7。
