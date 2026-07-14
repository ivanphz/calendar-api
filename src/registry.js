// ============================================================================
// 🧩 registry.js —— 域清单(框架文件)
// ============================================================================
// 一个"域" = 一个子项目。彼此完全独立：参数独立(各自 adapter 解析)、
// 配置独立(各自在顶层 config/ 用户领地)、逻辑独立(域内怎么算中枢不掺和)。
//
// 适配器接口(两阶段)：
//   prepare(q, baseDateObj, filters) => { countries, years, state }
//     filters = { tags: string[], excludeTags: string[] }  中枢级视图过滤，域内对自己的条目应用
//   build(state, env, hub, dtStamp, beijingTimeStr)
//     => { eventLines: string[], alarms: [{uid,date,time,reason}], debugLines: string[] }
//   原则：eventLines 是【日历本体】；alarms 是【附加输出】，只读推算结果、绝不反向影响日历。
//
// 加新子项目：见 docs/DEVGUIDE.md(三步接入手册)。

import { checkinDomain } from './domains/checkin/adapter.js';
import { cardDomain } from './domains/card/adapter.js';

export const DOMAINS = {
  checkin: checkinDomain,
  card: cardDomain
};
