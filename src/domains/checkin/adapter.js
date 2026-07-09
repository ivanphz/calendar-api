// ============================================================================
// 🔌 domains/checkin/adapter.js —— 签到域适配层(框架文件)
// ============================================================================
// 本域 URL 参数(域内自治，与其它域互不相干)：
//   ?tasks=MoeShare|2026-06-01T16:29,Other|...  选任务并覆盖锚点(原程序语义原样)
//   ?months=12                                  生成未来月数(原程序参数名原样)
// 中枢级视图过滤(?tags= ?excludeTags=)经 filters 传入，对任务的 tags 字段生效。
//
// 【日历是本体，闹钟是附加输出】
//   ICS 事件由 engine 原逻辑生成(含 workday/holidayAlarms 的日历 VALARM)。
//   闹钟网关条目只看"事件发生时刻"：默认每期【准点一条】(alarmOffsets 缺省 [0])；
//   显式配置 alarmOffsets 才提前；remind:false 的任务不进网关。日历不受任何影响。

import { TASK_DICT, CHECKIN_CONFIG } from '../../../config/checkin.js';
import { runCheckinTask } from './engine.js';

const pad = (n) => ('0' + n).slice(-2);
const hitTags = (item, filters) => {
  const t = item.tags || [];
  if (filters.tags.length && !filters.tags.some(x => t.includes(x))) return false;      // 选择型:必须命中
  if (filters.excludeTags.length && filters.excludeTags.some(x => t.includes(x))) return false; // 排除型
  return true;
};

export const checkinDomain = {
  id: 'checkin',
  calName: CHECKIN_CONFIG.calendarName,
  defaultColor: CHECKIN_CONFIG.color,

  // —— 阶段一：解析本域参数 + 应用视图过滤，报出假期需求 ——
  prepare(q, baseDateObj, filters) {
    const futureMonths = q.has('months') ? parseInt(q.get('months')) : CHECKIN_CONFIG.futureMonths;

    // ?tasks 解析(原程序语义：任务ID|上次签到时间，不传则跑字典全部)
    let taskParamsArray = q.has('tasks') ? q.get('tasks').split(',') : Object.keys(TASK_DICT);
    const runs = [];
    for (const taskStr of taskParamsArray) {
      const [taskId, urlAnchorStr] = taskStr.split('|');
      const config = TASK_DICT[taskId];
      if (!config) continue;
      if (!hitTags(config, filters)) continue;                       // 视图标签过滤
      const finalAnchorStr = urlAnchorStr || config.defaultAnchor;   // URL 优先，降级默认锚点(原样)
      if (!finalAnchorStr) continue;
      runs.push({ taskId, config, anchorStr: finalAnchorStr });
    }

    const countries = [...new Set(runs.flatMap(r => r.config.holidayCalendars || ['CN']))];
    const years = [];
    const currentYear = baseDateObj.getFullYear();
    const maxYear = currentYear + Math.ceil(futureMonths / 12);
    for (let y2 = currentYear; y2 <= maxYear; y2++) years.push(y2);

    return { countries, years, state: { futureMonths, runs } };
  },

  // —— 阶段二：跑引擎 → VEVENT(本体) + 闹钟(附加) + Debug 段 ——
  async build(state, env, hub, dtStamp) {
    const { futureMonths, runs } = state;
    const eventLines = [];
    const alarms = [];
    const taskLog = [];

    for (const { taskId, config, anchorStr } of runs) {
      const isWorkDay = hub.makeWorkdayChecker(config.holidayCalendars || ['CN']);
      const { eventLines: ev, occurrences } = runCheckinTask(taskId, config, anchorStr, futureMonths, isWorkDay, dtStamp);
      eventLines.push(...ev);   // ← 日历本体，先行且不依赖下方闹钟逻辑

      // —— 闹钟网关(附加输出；与日历 VALARM 无关) ——
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
      `生成跨度: 未来 ${futureMonths} 个月 (?months= 可覆盖)`,
      `闹钟策略: 默认事件准点一条，与日历提醒(workday/holidayAlarms)脱钩；任务配 alarmOffsets 才提前，remind:false 仅日历`,
      '',
      `【任务 ${runs.length} 个】`,
      ...taskLog
    ];

    return { eventLines, alarms, debugLines };
  }
};
