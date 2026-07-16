# calendar-api —— 提醒中枢框架

一个 Cloudflare Worker **框架**(曾用名 reminder-hub,v5 起名称统一为 calendar-api,与下游
alarm-api 对仗;Cloudflare Worker 部署名保持现役 ios-calendar-ics 不变,原地更新零迁移),内置两个域:💳 信用卡还款、⏰ 周期签到。
**日历是本体**(ICS 订阅),**闹钟是附加输出**(?format=json,喂手机闹钟网关)。

三层生态:**workdays-core(假期事实,npm 私有包)→ calendar-api(本项目,决策)→ alarm-api(手机执行)**。
本项目不持有任何假期数据(v5 起归上游),也不输出任何 iPhone 概念(归下游)。

> **v6 一句话**:**框架吃语法,域吃语义。** 插件交【事件对象】(哪一刻、什么标题、想在什么
> 时候被提醒),框架独家渲染 ICS(转义/折行/时区/VALARM)并统一治理(窗口/uid/超时)。
> 插件作者写作**零 ICS 知识**,自动继承一堆用真机踩出来的 iOS 坑的赔偿。

## 文档地图

| 我想… | 读这个 |
|---|---|
| 看结构/契约/参数矩阵/口径 | **ARCHITECTURE.md** |
| **写插件时查字段怎么填** | **docs/EVENT-MODEL.md** ★ 事件模型契约(v6 宪法,唯一真相源) |
| 接入一个新提醒插件 | **docs/DEVGUIDE.md**(三步,自足) |
| 维护/看懂信用卡域 | **docs/PLUGIN-CARD.md**(模型/身份/email/iOS坑/排查) |
| 写会出闹钟的插件,想知道下游能干什么 | **docs/DOWNSTREAM.md** |
| 做 v5 → v6 升级(一次性;含链接盘点) | **docs/UPGRADE-V6.md** |
| 做 v4.5 → v5 升级(一次性,已完成) | **docs/UPGRADE-V5.md** |
| 查决策沿革 | **docs/DEVLOG.md** |

## 领地(先读这个)

```
config/   你的领地:账户、任务、默认值、标签。框架更新永不触碰。
src/      框架领地:更新时整目录替换,不含任何配置。
          └ renderer.js / governance.js  ← v6:ICS 语法与总控只此一处
```

> 信用卡逻辑虽源自独立项目 repayment-cal(已归档),但自并入起就是**可自由演进的框架
> 一等公民** —— 想改直接改 `src/domains/card/`,详见 docs/PLUGIN-CARD.md §0(v5.2 起已
> 移除"原版冻结"约束)。

日常维护 = 只改 `config/`:
加信用卡 → `config/card.js` 的 ACCOUNTS;加签到 → `config/checkin.js` 的 TASK_DICT。

## 订阅配方

```
…/?cal=card                        💳 红册(你的默认: exact + 同日合并)
…/?cal=checkin                     ⏰ 橙册
…/?cal=all&exclude=card            除信用卡外的一切(以后新增的域自动包含在内)
…/?cal=checkin&tags=A              自定义"日历A"(打了 A 标签的任务)
…/?format=json                     闹钟网关拉这条(默认全域;可同样用 cal/tags 组合)
…/?format=json&cardAlarm=off       网关流里临时关掉信用卡
…/?cnRule=market                   裸 'CN' 条目全局切市场口径(补班周末视为休息)
…/?past=0&future=6                 中枢窗口:不要历史、只看未来半年(v6 起统管全域)
```

诊断事件**默认开启**(一条全天事件写明生效默认值、中枢窗口、出口治理、上游数据源状态与
coverage 缺口告警),`?debug=0` 隐藏。`?testDate=YYYY-MM-DD` 模拟基准日,ICS/JSON 通用。

**窗口是【许可边界】不是【生产配额】**:`?past=3` 意思是"允许往前 3 个月",不是"必须填满"。
签到域算法只向前推 → past 区间自然空产出;信用卡域回溯能核对推算 → 它用足许可。同参数,两种用法。

⚠️ **废除的参数一律"不崩 + 响亮告警"**(旧链接不会静默跑偏,诊断里看得见):
- `?months=`(v6,签到域跨度)→ 并入 `?future=`
- `?adAlarms=` / `?exAlarms=`(v6,信用卡日历提醒)→ 正名 `?allDayReminders=` / `?exactReminders=`
- `?cnRule=official`(v5)→ 口径只有 `bank|market|public`,按 bank 处理

盘点存量链接见 **docs/UPGRADE-V6.md**。

## 测试与部署

```bash
npm ci                     # 需 GitHub Packages 私有源(上游 @ivanphz/workdays-core)
npm test                   # 全套 185 项
npm run test:framework     # 只跑框架层 72 项(零依赖:不装上游也能跑,秒回)
```

- `test/render.test.mjs` **72 项 · 框架层**:渲染器(转义/折行/时区/TRIGGER)、治理
  (窗口裁剪/uid 双协议/uidHash/超时)、**领地看守**。零外部依赖,先跑、快速失败。
- `test/hub.test.mjs` **113 项 · 域层**:结构自洽 + 领地/视图/**窗口总控** + 闹钟策略 +
  口径避让(真实归档日期钉死)+ 响亮降级 + 插件契约。需上游真实数据。

部署走 GitHub Actions:push main → npm ci → **npm test(红灯不部署)** → wrangler deploy。
需要三个仓库 Secret:`CF_API_TOKEN` / `CF_ACCOUNT_ID` / `GH_PAT`(读私有包,与 alarm-api 共用)。
上游发版后 update-core.yml 自动升级依赖并触发部署,节假日数据更新全程无人值守。
启用 email 模型:按 `wrangler.toml` 里的 KV 注释三步走,收件地址存 `EXPECTED_RECIPIENT` Secret
(详见 docs/PLUGIN-CARD.md §email)。
