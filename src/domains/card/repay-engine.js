// ==========================================
// 🧮 repay-engine.js —— 还款日推算引擎 (新旧两种模型)
// ==========================================
// 输入：一个 account + 某个年月 + 一个 workday 判断器(来自 holidays/index.js)
// 输出：这个账单在该月的完整推算结果(名义还款日、最终提醒日、审计信息)
//
// 两种模型：
//   legacy: 用固定 repayDay。月末边界用"溢出到下月"规则(29号在2月 -> 3月1日)，不压缩。
//   cycle : 用 statementDay + graceDays。名义还款日 = 账单日 + graceDays(天)，天然跨月、无2月问题。

const pad2 = (n) => ('0' + n).slice(-2);

// 由"年、月、想要的日号"构造一个真实日期，若日号超过当月天数则溢出到下月。
// 例：year=2026, month0=1(2月), wantDay=29 -> 2026-03-01 (2月只有28天，溢出1天)。
function dateWithOverflow(year, month0, wantDay) {
  const lastDay = new Date(year, month0 + 1, 0).getDate();
  if (wantDay <= lastDay) {
    return { date: new Date(year, month0, wantDay, 12, 0, 0), overflowed: false, lastDay };
  }
  const overflowAmount = wantDay - lastDay; // 溢出的天数
  const d = new Date(year, month0 + 1, overflowAmount, 12, 0, 0); // 下月第 overflowAmount 天
  return { date: d, overflowed: true, lastDay };
}

// 计算某账单在指定年月的"名义还款日"(未经工作日避让的原始应还日)。
function computeNominalRepayDate(account, calcYear, calcMonth0) {
  if (account.model === 'cycle') {
    // 新模型：账单日(可能也溢出) + graceDays 天
    const stmt = dateWithOverflow(calcYear, calcMonth0, account.statementDay);
    const due = new Date(stmt.date.getTime());
    due.setDate(due.getDate() + (account.graceDays || 0));
    return {
      nominal: due,
      note: `账单日 ${calcYear}-${pad2(calcMonth0 + 1)}-${pad2(account.statementDay)}${stmt.overflowed ? '(溢出)' : ''} + ${account.graceDays} 天期限`,
      overflowed: stmt.overflowed
    };
  }
  // 旧模型：固定 repayDay，月末溢出
  const r = dateWithOverflow(calcYear, calcMonth0, account.repayDay);
  return {
    nominal: r.date,
    note: r.overflowed
      ? `固定还款日 ${account.repayDay} 号在本月(${r.lastDay}天)不存在，溢出到下月 ${r.date.getMonth() + 1}/${r.date.getDate()}`
      : `固定还款日 ${account.repayDay} 号`,
    overflowed: r.overflowed
  };
}

// 从名义还款日往前倒推 advanceDays 个工作日(遇休息日跳过)，得到最终提醒日。
// isWorkday 来自 holiday hub，已经把该账单 holidayCalendars 涉及的多国假期叠加进去了。
export function computeReminder(account, calcYear, calcMonth0, isWorkday, holidayExtraAdvance) {
  const { nominal, note, overflowed } = computeNominalRepayDate(account, calcYear, calcMonth0);
  return backtrackToReminder(account, nominal, isWorkday, holidayExtraAdvance, note, overflowed, calcYear, calcMonth0);
}

// email 模型入口: 还款日不是按月推算的，而是外部(KV里的实测记录)直接给定。
// 共用同一套工作日倒推逻辑，保证 email 模型和 legacy/cycle 的避让行为完全一致。
export function computeReminderForDate(account, dueDate, isWorkday, holidayExtraAdvance, modelNote) {
  return backtrackToReminder(
    account, dueDate, isWorkday, holidayExtraAdvance,
    modelNote || '还款日来自邮件实测记录',
    false, dueDate.getFullYear(), dueDate.getMonth()
  );
}

// 共享核心: 名义还款日 -> (假期补偿 + 提前N工作日倒推) -> 最终提醒日 + 审计信息
function backtrackToReminder(account, nominal, isWorkday, holidayExtraAdvance, note, overflowed, calcYear, calcMonth0) {

  // 名义还款日当天若为休息日，额外多提前 holidayExtraAdvance 个工作日
  const nominalIsOff = !isWorkday(nominal);
  const totalAdvanceTarget = (account.advanceDays || 0) + (nominalIsOff ? holidayExtraAdvance : 0);

  let reminder = new Date(nominal.getTime());
  let advanced = 0;
  let scanned = 0;
  let skippedOffDays = 0;
  while (advanced < totalAdvanceTarget && scanned < 100) {
    reminder.setDate(reminder.getDate() - 1);
    if (isWorkday(reminder)) advanced++;
    else skippedOffDays++;
    scanned++;
  }

  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} (周${weekDays[d.getDay()]})`;

  return {
    account,
    calcYear,
    calcMonth0,
    nominalDate: nominal,
    reminderDate: reminder,
    startDateStr: `${reminder.getFullYear()}${pad2(reminder.getMonth() + 1)}${pad2(reminder.getDate())}`,
    audit: {
      modelNote: note,
      overflowed,
      nominalStr: fmt(nominal),
      nominalIsOff,
      baseAdvanceDays: account.advanceDays || 0,
      holidayCompensation: nominalIsOff ? holidayExtraAdvance : 0,
      scannedNaturalDays: scanned,
      skippedOffDays,
      finalStr: fmt(reminder)
    }
  };
}
