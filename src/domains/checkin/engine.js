// ============================================================================
// 🔁 domains/checkin/engine.js —— 720 小时严格月度推算引擎(原程序核心循环原样)
// ============================================================================
// 逻辑与原单文件版逐行对应：硬推 intervalHours + 动作漂移 -> 三规则碰撞检测 -> 动态提醒策略。
// 仅两处按既定共识调整(其余一字不改)：
//   1) UID 改为协议规范 checkin-<id小写>-<落点月YYYYMM>(无时钟时间，月内漂移不换身份)；
//   2) isWorkDay 改为注入(来自共享假期 hub，数据源与判定语义同原版：NateScarlet + 调休)。

const HOUR_MS = 3600000;
const MINUTE_MS = 60000;
const pad = (n) => ('0' + n).slice(-2);
// 虚拟 UTC 格式化(直接将 UTC 数值输出为上海时间字符串，规避时区偏移错误)
const formatICSDate = (vDate) => `${vDate.getUTCFullYear()}${pad(vDate.getUTCMonth() + 1)}${pad(vDate.getUTCDate())}T${pad(vDate.getUTCHours())}${pad(vDate.getUTCMinutes())}00`;

// 返回 { eventLines: string[], occurrences: [{uid, bucket, dateStr, timeStr, title}] }
export function runCheckinTask(taskId, config, anchorStr, futureMonths, isWorkDay, dtStamp) {
  const eventLines = [];
  const occurrences = [];

  // 防御性容错，防止 URL 参数格式错误导致 Worker 崩溃(原样)
  const [datePart, timePart = '00:00'] = anchorStr.replace(' ', 'T').split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, min] = timePart.split(':').map(Number);

  let virtualDate = new Date(Date.UTC(y, m - 1, d, h || 0, min || 0, 0));

  for (let i = 0; i < futureMonths; i++) {
    let prevMonth = virtualDate.getUTCMonth();
    let prevYear = virtualDate.getUTCFullYear();
    let currentIsWorkDay = isWorkDay(virtualDate);
    let delayMinutes = currentIsWorkDay ? config.workdayDelay : config.holidayDelay;

    // 核心数学：硬性推进 720 小时 + 漂移延迟(原样)
    let nextVirtualDate = new Date(virtualDate.getTime() + (config.intervalHours * HOUR_MS) + (delayMinutes * MINUTE_MS));

    let targetMonth = nextVirtualDate.getUTCMonth();
    let targetYear = nextVirtualDate.getUTCFullYear();
    let monthDiff = (targetYear * 12 + targetMonth) - (prevYear * 12 + prevMonth);

    let logicAudit = `🕒 基础推算: +${config.intervalHours}小时\\n⏱ 动作漂移: +${delayMinutes}分钟 (因上次操作为${currentIsWorkDay ? '工作日' : '非工作日'})`;

    if (monthDiff === 0) {
      // 规则 A：同月挤压。强制推迟到下个月 1 号，并恢复健康时间
      // 必须先将日期设为 1 号，再加月份，防止 31 号溢出到次月导致吞月 Bug(原样)
      nextVirtualDate.setUTCDate(1);
      nextVirtualDate.setUTCMonth(nextVirtualDate.getUTCMonth() + 1);
      nextVirtualDate.setUTCHours(config.defaultHour, config.defaultMinute, 0, 0);
      logicAudit += `\\n⚠️ 碰撞检测: 触发同月防挤压策略，强制顺延至下月 1 号并重置时间。`;
    } else if (monthDiff > 1) {
      // 规则 C：跳月宽裕。恢复健康时间(原样)
      nextVirtualDate.setUTCHours(config.defaultHour, config.defaultMinute, 0, 0);
      logicAudit += `\\n✨ 碰撞检测: 触发跳月宽裕期 (大跨度跳跃)，已恢复至默认健康时间。`;
    } else {
      // 规则 B：正常跨越次月。直接继承漂移时间(原样)
      logicAudit += `\\n✅ 碰撞检测: 正常跨月轮换，持续自适应修正中。`;
    }

    const startDateStr = formatICSDate(nextVirtualDate);
    const bucket = `${nextVirtualDate.getUTCFullYear()}${pad(nextVirtualDate.getUTCMonth() + 1)}`;
    const uid = `checkin-${taskId.toLowerCase().replace(/[^a-z0-9]/g, '')}-${bucket}`;

    // 动态获取当天的提醒策略(原样，作用于日历 VALARM)
    let isTargetDateWorkDay = isWorkDay(nextVirtualDate);
    let alarms = isTargetDateWorkDay ? config.workdayAlarms : config.holidayAlarms;

    // 构建日历正文属性(原样)
    let eventDescription = `【推算审计明细】\\n\\n${logicAudit}\\n\\n上次操作锚点: ${virtualDate.getUTCFullYear()}-${pad(virtualDate.getUTCMonth() + 1)}-${pad(virtualDate.getUTCDate())} ${pad(virtualDate.getUTCHours())}:${pad(virtualDate.getUTCMinutes())}`;
    eventDescription += `\\n🔔 提醒策略: 提前 ${alarms.join('分钟 和 ')}分钟 (${isTargetDateWorkDay ? '工作日' : '非工作日'})`;

    let ev = [
      'BEGIN:VEVENT',
      `UID:${uid}@mycal.local`,
      `DTSTAMP:${dtStamp}`,
      `SUMMARY:${config.emoji} ${config.name} 签到提醒`
    ];

    // 若配置了直达链接，注入 URL 属性并在正文附带(原样)
    if (config.actionUrl) {
      ev.push(`URL:${config.actionUrl}`);
      eventDescription += `\\n\\n直达链接: ${config.actionUrl}`;
    }

    ev.push(
      `DESCRIPTION:${eventDescription}`,
      `DTSTART;TZID=Asia/Shanghai:${startDateStr}`,
      `DURATION:PT10M` // 默认占用 10 分钟日历块(原样)
    );

    // 🌟 动态循环挂载多个日历闹钟提醒(原样)
    for (let advanceMin of alarms) {
      ev.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${config.name} 可签到！`,
        `TRIGGER:-PT${advanceMin}M`,
        'END:VALARM'
      );
    }

    ev.push('END:VEVENT');
    eventLines.push(...ev);

    occurrences.push({
      uid, bucket,
      at: new Date(nextVirtualDate.getTime()),
      dateStr: `${nextVirtualDate.getUTCFullYear()}-${pad(nextVirtualDate.getUTCMonth() + 1)}-${pad(nextVirtualDate.getUTCDate())}`,
      title: `${config.emoji} ${config.name} 签到提醒`
    });

    // 步进迭代，下一次计算的基准点变为刚刚推算出的正确时间(原样)
    virtualDate = nextVirtualDate;
  }

  return { eventLines, occurrences };
}
