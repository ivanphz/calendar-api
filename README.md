# calendar-api —— 提醒中枢框架

一个 Cloudflare Worker **框架**(曾用名 reminder-hub,v5 起名称统一为 calendar-api,与下游
alarm-api 对仗;Cloudflare Worker 部署名保持现役 ios-calendar-ics 不变,原地更新零迁移),内置两个域:💳 信用卡还款、⏰ 周期签到。
**日历是本体**(ICS 订阅),**闹钟是附加输出**(?format=json,喂手机闹钟网关)。

三层生态:**workdays-core(假期事实,npm 私有包)→ calendar-api(本项目,决策)→ alarm-api(手机执行)**。
本项目不持有任何假期数据(v5 起归上游),也不输出任何 iPhone 概念(归下游)。

## 文档地图

| 我想… | 读这个 |
|---|---|
| 看结构/契约/参数矩阵/口径 | **ARCHITECTURE.md** |
| 接入一个新提醒插件 | **docs/DEVGUIDE.md**(三步,自足) |
| 维护/看懂信用卡域 | **docs/PLUGIN-CARD.md**(模型/主键/email/iOS坑/排查) |
| 写会出闹钟的插件,想知道下游能干什么 | **docs/DOWNSTREAM.md** |
| 做 v4.5 → v5 升级(一次性) | **docs/UPGRADE-V5.md** |
| 查决策沿革 | **docs/DEVLOG.md** |

## 领地(先读这个)

```
config/   你的领地:账户、任务、默认值、标签。框架更新永不触碰。
src/      框架领地:更新时整目录替换,不含任何配置。
test/golden/  金标准测试基建:原项目终版冻结,永不改动(存档在已归档原仓库)。
```

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
```

诊断事件**默认开启**(一条全天事件写明生效默认值、上游数据源状态与 coverage 缺口告警),
`?debug=0` 隐藏。`?testDate=YYYY-MM-DD` 模拟基准日,ICS/JSON 通用。
⚠️ v5 词汇:口径只有 `bank|market|public`,`official` 已废除(旧 URL 不崩,按 bank 处理并在诊断告警)。

## 测试与部署

```bash
npm ci                    # 需 GitHub Packages 私有源(上游 @ivanphz/workdays-core)
node test/hub.test.mjs    # 83 项:金标准(与冻结原版逐行等价) + 领地/视图/闹钟策略 + 口径 + 响亮降级
```

部署走 GitHub Actions:push main → npm ci → **83 项测试(红灯不部署)** → wrangler deploy。
需要三个仓库 Secret:`CF_API_TOKEN` / `CF_ACCOUNT_ID` / `GH_PAT`(读私有包,与 alarm-api 共用)。
上游发版后 update-core.yml 自动升级依赖并触发部署,节假日数据更新全程无人值守。
启用 email 模型:按 `wrangler.toml` 里的 KV 注释三步走,收件地址存 `EXPECTED_RECIPIENT` Secret
(详见 docs/PLUGIN-CARD.md §email)。
