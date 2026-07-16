// ============================================================================
// 🔌 domains/checkin/adapter.js —— 签到域适配层(框架文件;v6 契约 contract:2)
// ============================================================================
// 本域 URL 参数(域内自治，与其它域互不相干)：
//   ?tasks=MoeShare|2026-06-01T16:29,Other|...  选任务并覆盖锚点(原程序语义原样)
// 【v6 破坏性变更】?months= 已废除 —— 跨度并入中枢窗口 ?future=(见 EVENT-MODEL §6)。
//   旧链接不会静默跑偏:中枢检测到 ?months= 会在诊断里响亮告警。
// 中枢级视图过滤(?tags= ?excludeTags=)经 ctx.matchesTags 提供,不再各域自抄一份。
//
// 【窗口治理姿态:MAP】(EVENT-MODEL §6)
//   本域只吃 window.to(映射成"推几期"),【忽略 window.from】—— 理由是算法层面的:
//   引擎从锚点单向前推,天生不产历史,past 区间对它没有意义。
//   窗口是许可边界不是生产配额,不产就是不产,框架不催产。
//   (哪天想让签到也回溯,姿态改 USE 即可 —— 一字之改。)
//
// 【日历是本体，闹钟是附加输出】
//   ICS 事件由 engine 原逻辑生成(含 workday/holidayAlarms 的日历提醒意图)。
//   闹钟网关条目只看"事件发生时刻"：默认每期【准点一条】(alarmOffsets 缺省 [0])；
//   显式配置 alarmOffsets 才提前；remind:false 的任务不进网关。日历不受任何影响。

import { TASK_DICT, CHECKIN_CONFIG } from '../../../config/checkin.js';
import { runCheckinTask } from './engine.js';

const pad = (n) => ('0' + n).slice(-2);

// 中枢绝对日期窗 → 本域语义(推几期)。MAP 的全部内容就是这一个函数。
// 引擎每期硬推 720h(≈1 月),故"期数" = 基准月到窗口末月的月差。
// 至少 1 期:窗口再窄也总得有个下一期,否则 ?future=0 会得到空册 —— 那不是许可边界的本意。
function mapWindowToPeriods(baseDate, windowTo) {
  const [toY, toM] = windowTo.split('-').map(Number);
  const diff = (toY * 12 + (toM - 1)) - (baseDate.getFullYear() * 12 + baseDate.getMonth());
  return Math.max(1, diff);
}

export const checkinDomain = {
  id: 'checkin',
  contract: 2,             // v6 契约:prepare(q,ctx)→{countries,state};build→{events,alarms,debugLines}
  window: 'MAP',           // 治理姿态(见头注):只吃 window.to,忽略 window.from
  calName: CHECKIN_CONFIG.calendarName,
  defaultColor: CHECKIN_CONFIG.color,

  // —— 阶段一：解析本域参数 + 应用视图过滤，报出假期需求 ——
  // v6:不再自报 years —— 窗口归中枢后,年份是中枢从裁剪窗推导的事实(v5 里两域各算一套还不一致)。
  prepare(q, ctx) {
    const periods = mapWindowToPeriods(ctx.baseDate, ctx.window.to);

    // ?tasks 解析(原程序语义：任务ID|上次签到时间，不传则跑字典全部)
    let taskParamsArray = q.has('tasks') ? q.get('tasks').split(',') : Object.keys(TASK_DICT);
    const runs = [];
    for (const taskStr of taskParamsArray) {
      const [taskId, urlAnchorStr] = taskStr.split('|');
      const config = TASK_DICT[taskId];
      if (!config) continue;
      if (!ctx.matchesTags(config)) continue;                        // 视图标签过滤(中枢助手)
      const finalAnchorStr = urlAnchorStr || config.defaultAnchor;   // URL 优先，降级默认锚点(原样)
      if (!finalAnchorStr) continue;
      runs.push({ taskId, config, anchorStr: finalAnchorStr });
    }

    const countries = [...new Set(runs.flatMap(r => r.config.holidayCalendars || ['CN']))];
    return { countries, state: { periods, runs } };
  },

  // —— 阶段二：跑引擎 → 事件对象(本体) + 闹钟(附加) + Debug 段 ——
  async build(state, hub, ctx) {
    const { periods, runs } = state;
    const events = [];
    const alarms = [];
    const taskLog = [];

    for (const { taskId, config, anchorStr } of runs) {
      const isWorkDay = hub.makeWorkdayChecker(config.holidayCalendars || ['CN']);
      const { events: ev, occurrences } = runCheckinTask(taskId, config, anchorStr, periods, isWorkDay);
      events.push(...ev);   // ← 日历本体，先行且不依赖下方闹钟逻辑

      // —— 闹钟网关(附加输出；与日历提醒意图无关) ——
      if (config.remind !== false) {
        const offsets = (config.alarmOffsets && config.alarmOffsets.length) ? config.alarmOffsets : [0]; // 默认准点一条
        const multi = offsets.length > 1;
        for (const occ of occurrences) {
          for (const min of offsets) {
            const at = new Date(occ.at.getTime() - min * 60000);
            alarms.push({
              uid: multi ? `${occ.uid}-m${min}` : occ.uid,   // 多偏移才加稳定后缀；单偏移用裸 uid
              date: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`,
              time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`,
              reason: occ.title
            });
          }
        }
        taskLog.push(`- ${config.emoji}${config.name} [${taskId}]${config.tags ? ' tags:' + config.tags.join('/') : ''} 闹钟:${offsets.map(o => o === 0 ? '准点' : `提前${o}分`).join('+')}`);
      } else {
        taskLog.push(`- ${config.emoji}${config.name} [${taskId}]${config.tags ? ' tags:' + config.tags.join('/') : ''} 闹钟:关闭(仅日历)`);
      }
    }

    const debugLines = [
      `【⏰ 签到域】`,
      `生成跨度: ${periods} 期 ← 中枢窗口 ?future= 映射(姿态 MAP:只吃 window.to,忽略 past —— 引擎从锚点单向前推,不产历史)`,
      `闹钟策略: 默认事件准点一条，与日历提醒(workday/holidayAlarms)脱钩；任务配 alarmOffsets 才提前，remind:false 仅日历`,
      '',
      `【任务 ${runs.length} 个】`,
      ...taskLog
    ];

    return { events, alarms, debugLines };
  }
};
