// ==========================================
// 📧 email-parser.js —— 邮件解析器 (MIME 解码 + 多卡提取 + 分层解析)
// ==========================================
// 设计要点:
//   1. 零依赖的最小 MIME 解码器(base64 / quoted-printable / RFC2047 主题)，够用且可在本地完整测试。
//   2. 一封邮件可能包含多张卡(实测汇丰会把名下多个户口合并成一封通知)，提取所有后四位，逐个匹配。
//   3. 分层解析管线: 高精度层优先，逐层降级。当前只有第4层有实现，上面三层留接口:
//        L1 附件解析(PDF账单，含账单日+还款日) —— TODO 未实现
//        L2 正文明确"付款到期日"字段          —— TODO 未实现
//        L3 正文明确"结单日/账单日"字段        —— TODO 未实现
//        L4 收件时间 - 偏移 → 推定账单日 + 宽限期 → 还款日 —— 当前唯一实现
//   4. inferStatementDate 是可插拔口子: 现在是"固定减 N 天"，将来你积累了精确收件时间数据后，
//      可以在这里写"收件时刻落在某区间→偏移-2，另一区间→偏移-1，遇节假日再修正"之类的规则，
//      不需要动任何其他文件。

const pad2 = (n) => ('0' + n).slice(-2);
const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// ---------- 最小 MIME 解码 ----------

function unfoldHeaders(block) {
  return block.replace(/\r?\n[ \t]+/g, ' ');
}

function parseHeaders(block) {
  const headers = {};
  for (const line of unfoldHeaders(block).split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function bytesToUtf8(bytes) {
  try { return new TextDecoder('utf-8').decode(bytes); }
  catch { return String.fromCharCode(...bytes); }
}

function decodeBase64ToText(b64) {
  try {
    const bin = atob(b64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytesToUtf8(bytes);
  } catch { return ''; }
}

function decodeQuotedPrintable(text) {
  const noSoftBreaks = text.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < noSoftBreaks.length; i++) {
    if (noSoftBreaks[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(noSoftBreaks.slice(i + 1, i + 3))) {
      bytes.push(parseInt(noSoftBreaks.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(noSoftBreaks.charCodeAt(i) & 0xff);
    }
  }
  return bytesToUtf8(new Uint8Array(bytes));
}

function decodeBody(body, encoding) {
  const enc = (encoding || '').toLowerCase();
  if (enc.includes('base64')) return decodeBase64ToText(body);
  if (enc.includes('quoted-printable')) return decodeQuotedPrintable(body);
  return body;
}

// RFC2047 主题解码: =?utf-8?B?...?= 或 =?utf-8?Q?...?=
export function decodeSubject(subject) {
  return subject.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, type, data) => {
    if (type.toUpperCase() === 'B') return decodeBase64ToText(data);
    return decodeQuotedPrintable(data.replace(/_/g, ' '));
  });
}

// 解析原始邮件全文 -> { date, text }
// text 是所有可解码部分拼接后的可搜索文本(HTML 标签不剥离也不影响后四位/Ref 提取)
export function parseRawEmail(rawText) {
  const sepIdx = rawText.search(/\r?\n\r?\n/);
  const headerBlock = sepIdx >= 0 ? rawText.slice(0, sepIdx) : rawText;
  const bodyBlock = sepIdx >= 0 ? rawText.slice(sepIdx).replace(/^\r?\n\r?\n/, '') : '';
  const headers = parseHeaders(headerBlock);

  const date = headers['date'] ? new Date(headers['date']) : null;

  const texts = [];
  const boundaryMatch = (headers['content-type'] || '').match(/boundary="?([^";\r\n]+)"?/i);
  if (boundaryMatch) {
    for (const part of bodyBlock.split('--' + boundaryMatch[1])) {
      const pIdx = part.search(/\r?\n\r?\n/);
      if (pIdx < 0) continue;
      const pHeaders = parseHeaders(part.slice(0, pIdx));
      const pBody = part.slice(pIdx).replace(/^\r?\n\r?\n/, '');
      texts.push(decodeBody(pBody, pHeaders['content-transfer-encoding']));
    }
  } else {
    texts.push(decodeBody(bodyBlock, headers['content-transfer-encoding']));
  }

  return { date: (date && !isNaN(date)) ? date : null, text: texts.join('\n'), headers };
}

// ---------- 信息提取 ----------

// 提取所有卡号后四位(XXXX-XXXX-XXXX-1234 及少量变体)和邮件 Ref 号。
// 一封邮件可能列多张卡 —— 返回去重后的后四位数组。
export function extractStatementInfo(searchableText) {
  const last4s = [...searchableText.matchAll(/X{4}[-\s]*X{4}[-\s]*X{4}[-\s]*(\d{4})/gi)].map(m => m[1]);
  const refMatch = searchableText.match(/Ref:\s*\[?([A-Z0-9]{6,})\]?/i);
  return {
    last4s: [...new Set(last4s)],
    ref: refMatch ? refMatch[1] : null
  };
}

// ---------- 可插拔推断口子 ----------

// 【口子】收件时间 -> 推定账单日。
// 当前实现: 固定减 account.emailDateOffsetDays (缺省 2) 天。
// ⚠️ 时区修正: Worker 运行在 UTC，凌晨收到的邮件(如北京时间 0:32)在 UTC 里还是前一天，
//    直接取日历日会整体错一天。因此先把收件时刻转成北京时区的"墙上日期"再做偏移。
// 将来你积累了"结单日 vs 收件精确时刻"的数据后，在这里写更聪明的规则，例如:
//   - 收件时刻在凌晨 0-6 点 → 大概率是账单日+1 的凌晨批量发送 → 偏移 -1
//   - 收件时刻在白天       → 偏移 -2
//   - 推定出的账单日若落在周末/假期 → 回退到最近工作日(银行不在休息日出账)
// 只改这个函数，其他文件不用动。
export function inferStatementDate(receivedAt, account) {
  const offsetDays = (account.emailDateOffsetDays !== undefined) ? account.emailDateOffsetDays : 2;
  // 转成北京时区的墙上日期(收件的"当地日历日")，再做天数偏移
  const beijingWallClock = new Date(receivedAt.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const d = new Date(beijingWallClock.getFullYear(), beijingWallClock.getMonth(), beijingWallClock.getDate(), 12, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d;
}

// ---------- 分层解析管线 ----------

// 输入: 解析后的邮件 + 匹配到的某个账户；输出: 一条可入库的 stmt 记录(见 storage.js 注释)。
// 按 L1 -> L4 逐层尝试，哪层成功用哪层，layer 字段记录来源精度。
export function layeredParse(parsedEmail, account, receivedAt, sourceRef) {
  // ---- L1: 附件解析(PDF 账单) ----
  // TODO 未实现。思路: 邮件带 PDF 附件时，提取附件二进制，解析出精确的"结单日"和"付款到期日"。
  // 实现后 return { layer: 1, ... }

  // ---- L2: 正文明确"付款到期日" ----
  // TODO 未实现。思路: 正文若出现 /付款到期日[:：]\s*(\d{4}[年-]\d{1,2}[月-]\d{1,2})/ 之类，
  // 直接提取还款日，跳过一切推算。实现后 return { layer: 2, ... }

  // ---- L3: 正文明确"结单日/账单日" ----
  // TODO 未实现。思路: 正文若出现结单日期字样，提取后 + emailGraceDays 算还款日。
  // 实现后 return { layer: 3, ... }

  // ---- L4: 收件时间推算(当前唯一实现) ----
  const stmtDate = inferStatementDate(receivedAt, account);
  const graceDays = (account.emailGraceDays !== undefined) ? account.emailGraceDays : 21;
  const dueDate = new Date(stmtDate.getTime());
  dueDate.setDate(dueDate.getDate() + graceDays);

  return {
    layer: 4,
    layerNote: `收件日 ${fmtDate(receivedAt)} 减 ${(account.emailDateOffsetDays !== undefined) ? account.emailDateOffsetDays : 2} 天推定账单日，再加 ${graceDays} 天宽限`,
    statementDateStr: fmtDate(stmtDate),
    dueDateStr: fmtDate(dueDate),
    sourceRef: sourceRef || null,
    receivedAt: receivedAt.toISOString(),
    parsedAt: new Date().toISOString()
  };
}
