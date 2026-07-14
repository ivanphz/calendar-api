# 🧊 test/golden —— 金标准测试基建(不是存档)

这里是独立项目 **repayment-cal 的终版 `src/`**(2026-07)逐字节冻结副本。
**唯一改动**:`src/config.js` 换成了指向 `../../../config/card.js` 的转发垫片
(设计见 docs/DEVLOG.md v5.0"金标准 v2"、ARCHITECTURE §7)。

**职责边界先说清**:历史存档职责属于 GitHub 上**已归档(archived)的 repayment-cal 原仓库**,
不在这里。本目录是**测试基建**,每次 CI 都要执行它:

1. **金标准 oracle** —— 测试 A 组把中枢 `?cal=card` 输出与它逐行对比(共享配置+共享事实,
   纯逻辑等价);顺带每次运行都交叉验证上游 workdays-core 的 US 算法 ≡ 原版 us.js。
2. **字节看守基准** —— 测试 B5 断言 `src/domains/card/` 五个逻辑文件与此处逐字节一致,
   防"顺手改 verbatim 文件"。

为什么不改成"CI 从归档仓库克隆"从而省掉本目录:那会重新引入外部耦合 —— 归档仓库可被
改名/删除、克隆要走网络和凭据,正是 v5 刚根治过的脆弱性(v4 曾因外部路径失效全套测试
跑不起来)。测试必须**密闭自足**。60KB 的代价,买的是这个。

**铁律:本目录永不改动。** 若未来有意演进信用卡核心逻辑(告别 verbatim),
正确流程见 docs/PLUGIN-CARD.md §0"verbatim 铁律"。
