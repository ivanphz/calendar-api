# v4.5 → v5 升级 runbook (UPGRADE-V5)

> **一次性文档**:全程 GitHub 网页 + Cloudflare 后台操作,无本地环境。做完可归档。
> v5 三件大事:① 假期层外包上游 workdays-core;② 破坏性词汇统一(official 废除);
> ③ 命名定死 —— GitHub 仓库/项目名 **calendar-api**,Cloudflare Worker 部署名保持现役
> **ios-calendar-ics** 不变(同名部署 = **原地更新,零迁移**;刻意不改名,见 §4)。
> 决策依据见 DEVLOG v5.0。

---

## 1. 前置(一次)

- Secret `GH_PAT`:**与 alarm-api 共用同一个 PAT**(scopes: `repo` + `read:packages`,
  当初按上游 INTEGRATION §2 创建的那个)。本仓库 Settings → Secrets and variables →
  Actions → New repository secret,名字 `GH_PAT`,值 = 同一个 token。
- `CF_API_TOKEN` / `CF_ACCOUNT_ID` 原有,不动。

## 2. 升级顺序(严格按序 = 零红灯;做乱了也有自愈,见 §6)

1. **上传 `.github/workflows/update-core.yml`**(单文件提交)。
   不会触发部署(旧 deploy 的 paths 不含 workflows)。
2. **Actions → Update workdays-core → Run workflow**(留空=latest)。
   成功后它提交:旧 package.json 里多出 dependencies + 新生成 package-lock.json。
   同样不触发部署(旧 paths 不含 package 两文件)。
3. **github.dev 单提交换血**(仓库页按 `.` 键进编辑器,一次提交完成全部,清单见 §3):
   删 `src/holidays/` 五文件 + 覆盖 9 个文件 + 新增 15 个文件。
   push 后**新 deploy.yml 自动触发**:npm ci(锁文件已在,交付版 package.json 的 `"*"`
   依赖范围与之兼容,已实测)→ **81 项测试** → **原地更新**线上 Worker `ios-calendar-ics`
   (同名部署,订阅 URL / KV / Secret / Email Routing 全部不动)。
4. **再跑一次 Update workdays-core**(收口,可选但建议):把 `"*"` 钉成精确版本号、
   锁文件根信息同步,再触发一次绿部署。此后一切交给自动升级链。
5. **验证**:
   - Actions 两次运行全绿(测试步骤显示 `结果: 83 通过 / 0 失败`);
   - 打开你现有的订阅 URL(`https://ios-calendar-ics.<你的子域>.workers.dev/?cal=card`),
     诊断事件里有 `【假期数据源状态 · 上游 workdays-core】` 且 CN/HK/US 各行正常;
   - `?cal=card&cnRule=official` 的诊断出现"⚠️ …official 已废除…已按 bank 处理"(响亮降级在岗);
   - `?format=json&testDate=<未来某天>` 结构与升级前一致(下游 alarm-api 无感)。

## 3. 文件清单

**config/ 一个字不用动**(你的领地;现有 'CN'/'HK'/'US' token 在 v5 全部合法)。

| 动作 | 文件 |
|---|---|
| 删除(5) | `src/holidays/index.js` `cn.js` `hk.js` `us.js` `us-market.js` |
| 覆盖(9) | `README.md` · `ARCHITECTURE.md` · `docs/DEVGUIDE.md` · `docs/DEVLOG.md` · `src/worker-entry.js` · `test/hub.test.mjs` · `wrangler.toml` · `package.json` · `.github/workflows/deploy.yml` |
| 新增(4) | `.github/workflows/update-core.yml`(§2 第 1 步已传) · `docs/PLUGIN-CARD.md` · `docs/DOWNSTREAM.md` · `docs/UPGRADE-V5.md` |

其余(`config/` 三件、`src/domains/` 全部、`src/registry.js`、`.gitignore`)不动。

## 4. Worker 命名:为什么刻意不改(备忘)

wrangler `name` 保持 **ios-calendar-ics** —— 与线上现役 Worker 同名,每次 deploy 都是
**原地更新**,本次升级**无任何 Cloudflare 侧操作**(订阅 URL、KV、Secret、Email Routing
一概不动)。

仓库/文档统一叫 calendar-api,部署名沿用旧名,两者并存是刻意取舍:wrangler 改 `name`
等于新建一个 Worker,订阅、Email Routing 规则、`EXPECTED_RECIPIENT` Secret、alarm-api
侧的源 URL 都得逐项迁到新 Worker 再删旧 —— **收益为零,成本是全套迁移**。将来若真要
统一部署名,迁移清单按上面这句括号里的四项逐一处理,全部切换验证后再删旧 Worker。

## 5. 破坏性变更(订阅链接自查)

- `?cnRule=official` 不再合法:不崩,按 bank 处理 + 诊断响亮告警。**检查你收藏/订阅里的
  链接**,带这个参数的直接删掉参数(bank 就是缺省)。
- 条目 token `':official'`、HK 的 `':market'/':official'` 废除:同样不崩、退默认口径 +
  告警。你现有 config 全用裸 'CN'/'HK'/'US',**无需任何修改**。
- ICS 下载文件名由 `reminder_hub_*.ics` 变为 `calendar_api_*.ics`;PRODID 同步变更
  (对订阅行为无影响)。

## 6. 红灯自愈表

| 症状 | 原因 | 解法 |
|---|---|---|
| npm ci 红:`ENOLOCK`/缺 lockfile | §2 第 2 步没跑就推了第 3 步 | Actions → Update workdays-core → Run,自动补齐并触发绿部署 |
| npm ci 红:lock 与 package.json 不同步 | 手工改过依赖段 | 同上,重跑 update-core 即自愈 |
| npm 404 `@ivanphz/workdays-core` | GH_PAT 缺/无 `read:packages`/scope 大小写 | 对照 §1 与上游 INTEGRATION §8 |
| 测试红 | 真问题,别硬部署(fail-closed 就是为此) | 看失败行,断言消息会指出哪条不符 |
| 上游发版后毫无反应 | 本仓库缺 GH_PAT / 上游 CONSUMER_REPOS 没加本仓库 | 上游 Release 日志看 dispatch 返回码;上游 INTEGRATION §7"新增消费者" |

## 7. 回滚

第 3 步是单提交 —— GitHub 网页 Revert 该提交即回 v4.5(旧代码不依赖 npm 包,旧 deploy 流程
照常;同名部署,回滚也是原地覆盖,线上零中断)。update-core 提交同样可单独 Revert。
