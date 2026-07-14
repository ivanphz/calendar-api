// ==========================================
// 📨 email-handler.js —— 收信编排 (Cloudflare Email Routing 触发)
// ==========================================
// 流程: 收到邮件 -> 校验收件地址(保密的 Secret) -> 解码 MIME -> 提取 Ref/后四位
//       -> Ref 去重 -> 匹配 config 里的活跃账户(可能多张) -> 分层解析 -> 写 KV(stmt + hist)
// 任何一步失败都会写入 fail: 记录，日历 Debug 事件会显示报警 —— 绝不静默失败。

import { ACCOUNTS } from './config.js';
import { makeAccountId } from './ics-builder.js';
import { parseRawEmail, decodeSubject, extractStatementInfo, layeredParse } from './email-parser.js';
import { putStatement, appendHistory, isDuplicateRef, markRefProcessed, recordParseFailure } from './storage.js';

export async function handleIncomingEmail(message, env) {
  if (!env || !env.REPAY_KV) {
    // 没绑定 KV 就没法入库。这种配置错误连 fail 都写不了，只能抛给 Cloudflare 日志。
    console.error('[email] REPAY_KV 未绑定，无法处理来信');
    return;
  }

  try {
    // ---- 1. 收件地址校验(EXPECTED_RECIPIENT 是 Cloudflare Secret，不进代码库) ----
    // 未设置该 Secret 时跳过校验(宽松模式)；设置了则收件人不匹配的邮件直接记录并忽略，
    // 防止有人猜到 Email Routing 入口乱塞邮件污染数据。
    const expected = (env.EXPECTED_RECIPIENT || '').toLowerCase().trim();
    const actualTo = (message.to || '').toLowerCase().trim();
    if (expected && actualTo && !actualTo.includes(expected)) {
      await recordParseFailure(env, 'recipient_mismatch', { to: actualTo });
      return;
    }

    // ---- 2. 读取原始邮件并解码 ----
    const raw = await new Response(message.raw).text();
    const parsed = parseRawEmail(raw);
    const subject = decodeSubject(
      (message.headers && typeof message.headers.get === 'function' ? message.headers.get('subject') : '') ||
      parsed.headers['subject'] || ''
    );
    const searchable = subject + '\n' + parsed.text;

    // ---- 3. 提取 Ref + 全部后四位 ----
    const { last4s, ref } = extractStatementInfo(searchable);

    // ---- 4. Ref 去重(同一封邮件因转发/重试到达多次时只入库一次) ----
    if (ref && await isDuplicateRef(env, ref)) return;

    // ---- 5. 匹配账户(一封邮件可能命中多张卡；同封邮件共享同一个收件时间) ----
    const receivedAt = parsed.date || new Date();
    const matched = ACCOUNTS.filter(a => a.isActive && a.last4 && last4s.includes(a.last4));

    if (matched.length === 0) {
      await recordParseFailure(env, 'no_account_matched', { subject, last4sFound: last4s, ref });
      return;
    }

    // ---- 6. 逐账户分层解析并入库 ----
    for (const acct of matched) {
      const accountId = makeAccountId(acct);
      const record = layeredParse(parsed, acct, receivedAt, ref);
      await putStatement(env, accountId, record);
      // 历史流水: 自动记账副产品，含精确收件时间，供你以后分析账单规律
      await appendHistory(env, accountId, receivedAt.toISOString(), {
        receivedAt: receivedAt.toISOString(),
        sourceRef: ref,
        layer: record.layer,
        statementDateStr: record.statementDateStr,
        dueDateStr: record.dueDateStr,
        subject
      });
    }

    if (ref) await markRefProcessed(env, ref);
  } catch (e) {
    await recordParseFailure(env, 'exception', { message: String(e && e.message || e) });
  }
}
