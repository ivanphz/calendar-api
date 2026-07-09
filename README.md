# reminder-hub —— 提醒中枢框架

一个 Cloudflare Worker **框架**,内置两个域:💳 信用卡还款、⏰ 周期签到。
**日历是本体**(ICS 订阅),**闹钟是附加输出**(?format=json,喂手机闹钟网关)。

- 结构/契约/参数矩阵 → **ARCHITECTURE.md**
- 新提醒怎么接入 → **docs/DEVGUIDE.md**(三步)
- 决策沿革 + 信用卡逻辑审计表 → **docs/DEVLOG.md**

## 领地(先读这个)

```
config/   你的领地:账户、任务、默认值、标签。框架更新永不触碰。
src/      框架领地:更新时整目录替换,不含任何配置。
```

日常维护 = 只改 `config/`:
加信用卡 → `config/card.js` 的 ACCOUNTS;加签到 → `config/checkin.js` 的 TASK_DICT。

## 订阅配方

```
…/?cal=card                        💳 红册(你的默认: exact + 同日合并)
…/?cal=checkin                     ⏰ 橙册
…/?cal=all&exclude=card            除信用卡外的一切
…/?cal=checkin&tags=A              自定义"日历A"(打了 A 标签的任务)
…/?format=json                     闹钟网关拉这条(默认全域;可同样用 cal/tags 组合)
…/?format=json&cardAlarm=off       网关流里临时关掉信用卡
```

诊断事件**默认开启**(一条全天事件写明所有生效默认值与数据源状态),`?debug=0` 隐藏。
`?testDate=YYYY-MM-DD` 模拟基准日,ICS/JSON 通用。

## 测试与部署

```bash
node test/hub.test.mjs    # 37 项:与原信用卡项目逐行等价(金标准) + 领地/视图/闹钟策略
```

部署沿用 GitHub Actions(推 main 自动 `wrangler deploy`)。
启用 email 模型:按 `wrangler.toml` 里的 KV 注释三步走,收件地址存 `EXPECTED_RECIPIENT` Secret。
