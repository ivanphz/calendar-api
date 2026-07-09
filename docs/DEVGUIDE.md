# 插件接入手册 (DEVGUIDE)

> **这份文档是自足的**:接入一个新提醒插件(域),只需读完本文,无需阅读框架源码。
> 心法一句话:**你只负责算出"哪一刻",框架包办其余**(ICS/JSON 双输出、视图组合、
> 分册颜色、假期数据、testDate、故障隔离)。日历是本体,闹钟是附加输出。

---

## 0. 三步接入(概览)

1. **建配置** `config/<域id>.js`(用户领地,框架更新永不触碰)
2. **建域** `src/domains/<域id>/`:`engine.js`(纯算法) + `adapter.js`(实现契约)
3. **注册** `src/registry.js` 的 `DOMAINS` 加一行

完成后自动获得:`?cal=<域id>` 独立册、`?cal=all` 混册、`?exclude=`、`?tags=`、
`?format=json` 闹钟流、`?testDate=`、诊断报告一段、`?color<域Id>=` 颜色覆盖。

---

## 1. 契约:域对象

```js
export const xxxDomain = {
  id: 'xxx',              // 见 §8 id 约束
  calName: '🧪 某某提醒',  // 单独订阅(?cal=xxx)时的册名(X-WR-CALNAME)
  defaultColor: '#34C759',// 单独订阅时的整册色;?colorXxx= 可覆盖(派生规则见 §7)
  prepare(q, baseDateObj, filters, env) { /* ... */ },        // 可为 async,见 §2
  async build(state, env, hub, dtStamp, beijingTimeStr) { /* ... */ }  // 见 §3
};
```

---

## 2. 契约:prepare(阶段一 —— 解析参数、报假期需求)

**可以是 async**(框架一律 `await`)。**抛异常 = 本域熔断**,其它域不受影响(见 §8)。

入参:

| 参数 | 类型 | 说明 |
|---|---|---|
| `q` | URLSearchParams | 整条请求的 query。**只读你自己的参数**(命名规范见 §7),不许读别的域的 |
| `baseDateObj` | Date | 基准日("今天",已含 ?testDate 覆盖)。**用本地 getter 读**(`getFullYear/getMonth/getDate`),读出来就是北京墙上日期 |
| `filters` | `{ tags: string[], excludeTags: string[] }` | 中枢级视图过滤。**你有义务**对自己的条目应用它(标准片段见 §6) |
| `env` | object | Cloudflare 绑定(KV/Secret…)。异步数据驱动的域在这一阶段就可能用到 |

返回:

```js
{
  countries: ['CN', 'US:market'],  // 本域所有条目需要的假期日历并集(口径 token 见 §5.5)
  years: [2026, 2027],             // 需要预加载的年份(按你的生成跨度算;宁多勿少)
  state: { /* 你的私有状态,原样传给 build,形状随意 */ }
}
```

---

## 3. 契约:build(阶段二 —— 产出三件套)

入参:

| 参数 | 说明 |
|---|---|
| `state` | prepare 返回的私有状态 |
| `env` | Cloudflare 绑定 |
| `hub` | 假期判断器工厂:`hub.makeWorkdayChecker(countries)` → `(dateObj) => boolean`。日期构造方式见 §6 |
| `dtStamp` | 现成的 ICS 时间戳字符串,直接放进 `DTSTAMP:` 行 |
| `beijingTimeStr` | 人类可读的北京时间串,只用于 debug 文案 |

返回(三件都必填,允许空数组):

```js
{
  eventLines: [ /* 日历本体:完整 VEVENT 行,规则见 §4 */ ],
  alarms:     [ /* 附加输出:闹钟条目,规则见 §5;空数组 = 本域不进网关 */ ],
  debugLines: [ /* 诊断段落:字符串数组,一行一元素,不许含裸换行 */ ]
}
```

**铁律:alarms 只能从推算结果衍生,不得为了闹钟改动事件生成**(日历是本体)。

---

## 4. eventLines 硬规则(ICS 装配)

框架把所有域的 eventLines 用 `\r\n` 连接后塞进统一的 VCALENDAR 壳(册名/颜色/时区由框架管,
**你不要输出** BEGIN:VCALENDAR / X-WR-* 等壳行)。因此:

1. **一行一个数组元素**,任何元素内不许出现裸换行符。
2. 每个事件必须是配对完整的 `'BEGIN:VEVENT'` … `'END:VEVENT'`。
3. `UID` 行格式:`` UID:${uid}@mycal.local ``,其中 `uid` 遵守 §5 的 uid 规范
   (日历 UID 稳定 → 订阅刷新不重建事件)。
4. `DESCRIPTION` 里的换行写成**字面量 `\n`**(反斜杠+n 两个字符),不是真换行。
5. `DTSTART` 两种合法写法:
   - 带时刻:`DTSTART;TZID=Asia/Shanghai:20261201T090000`(配 `DURATION:PT10M` 等)
   - 全天:`DTSTART;VALUE=DATE:20261201` + `DTEND;VALUE=DATE:20261202`(次日)
6. 日历侧提醒(VALARM)随你挂,与闹钟网关无关:
   `'BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:文案','TRIGGER:-PT5M','END:VALARM'`
7. 事件顺序不重要;框架按域注册顺序拼接,日历应用按时间渲染。

---

## 5. alarms 硬规则(闹钟网关,协议 v1)

每条 = 一个闹钟:

```js
{ uid: 'xxx-demo-202612', date: '2026-12-01', time: '09:00', reason: '🧪 某某到期' }
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `uid` | ✅ | 纯 ASCII(建议只用字母数字连字符),**不含时钟时间**,规范见 §5.1 |
| `date` | ✅ | `YYYY-MM-DD`,东八区墙上日期 |
| `time` | ✅ | `HH:MM` 24h,东八区墙上时刻 |
| `reason` | 建议 | 备注文案 |
| 其它 | 可选 | **协议可选字段(如 `tz`)原样透传** —— 框架契约保证对条目字段不增不删不改 |

### 5.1 uid 规范

`{域id}-{任务实例}-{周期桶}`。周期桶(bucket)粒度 = "同一时段最多响一次"的时段:

| 提醒模式 | bucket | 例 |
|---|---|---|
| 月度 | `YYYYMM` | `card-CN-CMB-...-202607` |
| 每日一次 | `YYYYMMDD` | `dose-vitd-20260807` |
| 每日多次 | `YYYYMMDD-稳定序号` | `water-desk-20260807-am` |

bucket 锚定"**事件属于哪个周期**",不锚定"哪天响" —— 改提前量/假期漂移时 uid 不变、
只有 time 变,网关平滑改期不抖。同一次输出里同一 uid 绝不能出现两次。
多个提前量 → 物化成多条,uid 加稳定后缀(如 `-m5`/`-m0`);单提前量用裸 uid。

### 5.2 框架代劳(你不用做)

按日的未来过滤(丢弃 `date <` 基准日;当日保留)、按 date+time 排序、包 `{ v:1, alarms }` 壳、
剔除熔断域。**你要做**:尊重条目 `remind:false`(不产 alarm)与 `alarmOffsets`(§6 语义表)。

### 5.5 假期口径 token(holidayCalendars 直接写)

| token | 语义 |
|---|---|
| `'CN'` | 大陆·调休那套(法定假休,补班周末**上班**);受全局 `?cnRule=` 影响 |
| `'CN:market'` | 大陆·市场口径(补班周末**休**;股市/清算) |
| `'US'` | 美国·银行/联邦(含观察日) —— **还款/转账用这个** |
| `'US:market'` | 美国·NYSE 交易日历(休 Good Friday;Columbus/Veterans 开市)。仅条目级,无全局开关 |
| `'HK'` ≡ `'HK:market'` | 香港·公众假期(两写法等价别名) |

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
- `baseDateObj` 用本地 getter 读 = 北京墙上日期(框架已换算)。
- 引擎内部若用"虚拟 UTC"(`Date.UTC` 存、`getUTC*` 读,如签到域),输出前自己格式化;两种风格别混用。
- 假期一律 `hub.makeWorkdayChecker(countries)`,**禁止自拉数据源**;
  加新国家 = `src/holidays/xx.js` 写 provider + `holidays/index.js` 注册一行。

**filters(义务)**:对你的每个条目应用标准片段:

```js
const hitTags = (item, f) => {
  const t = item.tags || [];
  if (f.tags.length && !f.tags.some(x => t.includes(x))) return false;      // 选择型:必须命中
  if (f.excludeTags.length && f.excludeTags.some(x => t.includes(x))) return false; // 排除型
  return true;
};
```

**条目预留字段(全框架统一语义,你的引擎必须尊重,缺省即默认)**:

| 字段 | 缺省 | 语义 |
|---|---|---|
| `isActive` | true | false = 停用(日历+闹钟都不出) |
| `tags` | `[]` | 视图标签,配合 `?tags= / ?excludeTags=` |
| `remind` | true | false = 仅日历,不进闹钟网关 |
| `alarmOffsets` | `[0]` | 闹钟提前分钟;`[0]`=事件准点一条;与日历 VALARM **无关** |
| `holidayCalendars` | `['CN']` | 叠加哪些假期日历(含口径 token) |
| `ext` | `{}` | 自由扩展对象,框架不读不校验。**新特性优先塞这里**,老代码零影响 |

---

## 7. URL 参数(自动派生 + 命名规范)

接入后自动生效:`?cal=<id>`(可逗号组合)、`?exclude=<id>`、`?tags=`、`?excludeTags=`、
`?format=ics|json`、`?testDate=YYYY-MM-DD`、`?debug=0`、
`?color<Id>=`(派生规则:`color` + id 首字母大写;id=recharge → `?colorRecharge=`,# 编码 %23)。

**你的域私有参数**必须带域名前缀防冲突:`?rechargeMonths=`、`?rechargeMode=`……
在 prepare 里自己解析,config 默认值兜底。

---

## 8. id 约束 · 故障隔离 · 性能

- **id**:`[a-z][a-z0-9]*`(小写 ASCII);同时用于 `?cal=`、颜色参数派生、uid 前缀、注册键。
- **故障隔离**:prepare/build 抛异常 → 仅本域熔断:ICS 出现一条
  `❌ 域 xxx 构建失败` 哨兵全天事件(**即使 ?debug=0**),JSON 静默剔除本域,其它域照常。
  这是**安全网不是流程控制** —— 想跳过输出就返回空数组,别抛异常。
- **性能**:闹钟网关拉取有 5 秒超时,整条链必须远快于此;假期数据框架已统一加载,别重复拉;
  避免在 prepare/build 里做无缓存的多次远程请求。

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
export const RECHARGE_CONFIG = { calendarName: '🔋 充值提醒', color: '#34C759', futureMonths: 12 };
```

```js
// ── src/domains/recharge/engine.js ──【纯算法:只算"哪一刻"】
export function runRecharge(item, futureMonths, isWorkDay, baseDateObj) {
  const out = [];
  const [y, m, d] = item.anchor.split('-').map(Number);
  let cur = new Date(y, m - 1, d, 12, 0, 0);
  const horizon = new Date(baseDateObj); horizon.setMonth(horizon.getMonth() + futureMonths);
  while (cur <= horizon) {
    cur = new Date(cur); cur.setDate(cur.getDate() + item.everyDays);
    const t = new Date(cur);
    while (!isWorkDay(t)) t.setDate(t.getDate() + 1);   // 示例策略:遇休顺延
    out.push(t);
  }
  return out; // Date[](每期一刻)
}
```

```js
// ── src/domains/recharge/adapter.js ──【契约实现】
import { RECHARGE_ITEMS, RECHARGE_CONFIG } from '../../../config/recharge.js';
import { runRecharge } from './engine.js';
const pad = n => ('0' + n).slice(-2);
const hitTags = (item, f) => { const t = item.tags || [];
  if (f.tags.length && !f.tags.some(x => t.includes(x))) return false;
  if (f.excludeTags.length && f.excludeTags.some(x => t.includes(x))) return false; return true; };

export const rechargeDomain = {
  id: 'recharge',
  calName: RECHARGE_CONFIG.calendarName,
  defaultColor: RECHARGE_CONFIG.color,

  prepare(q, baseDateObj, filters, env) {
    const futureMonths = q.has('rechargeMonths') ? parseInt(q.get('rechargeMonths')) : RECHARGE_CONFIG.futureMonths;
    const items = RECHARGE_ITEMS.filter(i => i.isActive !== false).filter(i => hitTags(i, filters));
    const countries = [...new Set(items.flatMap(i => i.holidayCalendars || ['CN']))];
    const y0 = baseDateObj.getFullYear();
    return { countries, years: [y0, y0 + Math.ceil(futureMonths / 12)], state: { futureMonths, items, baseDateObj } };
  },

  async build(state, env, hub, dtStamp) {
    const eventLines = [], alarms = [], log = [];
    for (const item of state.items) {
      const isWorkDay = hub.makeWorkdayChecker(item.holidayCalendars || ['CN']);
      for (const at of runRecharge(item, state.futureMonths, isWorkDay, state.baseDateObj)) {
        const bucket = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`; // 每期一天 → 日粒度
        const uid = `recharge-${item.id}-${bucket}`;
        eventLines.push('BEGIN:VEVENT', `UID:${uid}@mycal.local`, `DTSTAMP:${dtStamp}`,
          `SUMMARY:${item.emoji} ${item.name}`,
          `DTSTART;TZID=Asia/Shanghai:${bucket}T093000`, 'DURATION:PT10M', 'END:VEVENT');
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
    return { eventLines, alarms, debugLines: ['【🔋 充值域】', `条目 ${state.items.length} 个`, ...log] };
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

- [ ] `node test/hub.test.mjs` 全绿(并为新域补用例)
- [ ] `?cal=<id>&debug=0`:合法 ICS(VEVENT 配对、无裸换行、DESCRIPTION 用字面量 `\n`)
- [ ] `?cal=<id>&format=json&testDate=<未来>`:uid 纯 ASCII 无时钟时间、只含未来、同 uid 不重复
- [ ] 同参数拉两次 → uid 集合完全一致(稳定);改"时刻类"配置 → uid 不变仅 time 变(不抖)
- [ ] `?tags=` / `?excludeTags=` 对本域条目生效(filters 义务)
- [ ] `remind:false / alarmOffsets / isActive / ext` 语义与 §6 表一致
- [ ] 域私有参数带 `<id>` 前缀;未读任何别域参数;`config/` 之外没有新增配置值
- [ ] prepare/build 抛异常时哨兵事件出现、其它域不受影响(顺手验一次,别依赖它)
