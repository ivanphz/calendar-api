// ============================================================================
// 🧩 registry.js —— 域清单(框架文件)
// ============================================================================
// 一个"域" = 一个子项目。彼此完全独立：参数独立(各自 adapter 解析)、
// 配置独立(各自在顶层 config/ 用户领地)、逻辑独立(域内怎么算中枢不掺和)。
//
// ── 契约(v6,唯一)—— 权威见 docs/EVENT-MODEL.md §5 ──
//
//   prepare(q, ctx) => { countries, state }
//   build(state, hub, ctx) => { events, alarms, debugLines }
//
//   静态声明: id / calName / defaultColor / contract: 2
//             window: 'USE' | 'MAP' | 'OWN'   窗口治理姿态(EVENT-MODEL §6)。OWN 必在诊断显形。
//
//   【ctx 与位置参数的分工规则】
//     ctx  = 请求级【恒定】的一切,从头到尾不变:
//            env(KV/Secret)、baseDate、todayStr、window{from,to}、filters、
//            matchesTags(item)、nowBeijingStr、hubTimezone
//     hub  = 【阶段二才诞生】的资源 —— 它要等 prepare 报完 countries 才能创建,
//            故走位置参数,进不了 prepare 的 ctx。
//
//   【不再有的东西】(v5 → v6)
//     · years  —— 域不再自报。窗口归中枢后,年份是中枢从裁剪窗推导的事实
//                 (v5 里两个域各写了一套算法还不一致 —— "没有总控"的具象)。
//     · dtStamp / beijingTimeStr 位置参数 —— DTSTAMP 是 ICS 语法归渲染器;
//       运行时间进了 ctx.nowBeijingStr。
//     · eventLines —— 域【不再产 ICS 文本】。交事件对象,渲染归 src/renderer.js。
//       域侧写作零 ICS 知识,自动继承渲染器里全部 iOS 血债的赔偿。
//
//   原则:events 是【日历本体】;alarms 是【附加输出】(协议 v1,DOWNSTREAM.md)。两者互不牵连。
//
// ── 迁移完成(v6)──
//   ✅ checkin   ✅ card
//   双契约桥已拆除(worker-entry 的 isV6 分支、render.test 的 MIGRATION_WHITELIST 一并清空)。
//   全域一律过治理再渲染:没有旁路,没有豁免。
//
// 加新子项目：见 docs/DEVGUIDE.md(三步接入手册)。

import { checkinDomain } from './domains/checkin/adapter.js';
import { cardDomain } from './domains/card/adapter.js';

export const DOMAINS = {
  checkin: checkinDomain,
  card: cardDomain
};
