// ==========================================
// 🗄 storage.js —— KV 存储层 (键名约定 + 读写助手)
// ==========================================
// 所有 KV 键名规则集中在这里，其他模块不直接拼键名。
//
// 键名空间划分:
//   stmt:<accountId>              该账户"最近一期"实测记录(给日历生成用，只存最新，选Y方案:不外推)
//   hist:<accountId>:<ISO时间>    历史流水(自动记账副产品，给你以后做账单规律分析用，只追加不覆盖)
//   ref:<邮件Ref号>               已处理邮件去重标记(同一封邮件不会重复入库)，90天后自动过期
//   fail:<ISO时间>                解析失败记录(报警用，日历 Debug 事件会显示最近失败数)
//
// stmt 记录结构(JSON):
//   {
//     dueDateStr: 'YYYY-MM-DD',        推算/提取出的还款日
//     statementDateStr: 'YYYY-MM-DD',  推定账单日
//     layer: 4,                        数据来自解析器第几层(1附件/2正文还款日/3正文账单日/4收件日推算)
//     layerNote: '...',                该层的人类可读说明
//     sourceRef: 'X383...',            来源邮件 Ref 号
//     receivedAt: ISO,                 邮件收件时间(精确到秒，将来做规律分析的核心原始数据)
//     parsedAt: ISO                    入库时间
//   }

const REF_TTL_SECONDS = 90 * 24 * 3600; // 去重标记保留90天

export const kvKeys = {
  stmt: (accountId) => `stmt:${accountId}`,
  hist: (accountId, isoTime) => `hist:${accountId}:${isoTime}`,
  ref: (refId) => `ref:${refId}`,
  fail: (isoTime) => `fail:${isoTime}`
};

// 读取某账户最近一期记录；无 KV 绑定或无记录时返回 null(调用方需容错)
export async function getLatestStatement(env, accountId) {
  if (!env || !env.REPAY_KV) return null;
  const raw = await env.REPAY_KV.get(kvKeys.stmt(accountId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function putStatement(env, accountId, record) {
  await env.REPAY_KV.put(kvKeys.stmt(accountId), JSON.stringify(record));
}

export async function appendHistory(env, accountId, isoTime, record) {
  await env.REPAY_KV.put(kvKeys.hist(accountId, isoTime), JSON.stringify(record));
}

export async function isDuplicateRef(env, refId) {
  if (!refId) return false;
  return (await env.REPAY_KV.get(kvKeys.ref(refId))) !== null;
}

export async function markRefProcessed(env, refId) {
  if (!refId) return;
  await env.REPAY_KV.put(kvKeys.ref(refId), '1', { expirationTtl: REF_TTL_SECONDS });
}

export async function recordParseFailure(env, reason, detail) {
  if (!env || !env.REPAY_KV) return;
  const iso = new Date().toISOString();
  await env.REPAY_KV.put(kvKeys.fail(iso), JSON.stringify({ reason, detail, at: iso }));
}

// 列出最近的解析失败(供 Debug 事件报警)。KV list 按键名排序，fail: 前缀 + ISO 时间天然按时间排。
export async function listRecentFailures(env, limit = 5) {
  if (!env || !env.REPAY_KV || typeof env.REPAY_KV.list !== 'function') return [];
  try {
    const res = await env.REPAY_KV.list({ prefix: 'fail:', limit: 1000 });
    const keys = (res.keys || []).map(k => k.name).sort().slice(-limit);
    const out = [];
    for (const k of keys) {
      const v = await env.REPAY_KV.get(k);
      if (v) { try { out.push(JSON.parse(v)); } catch {} }
    }
    return out;
  } catch { return []; }
}
