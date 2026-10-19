# scripts/ 工具说明

> 这里放的是**开发与排查工具**，不属于应用运行时。
> 除 `ensure-db.js`（建库）外均**只读**——不写业务表；`ab-prompt-compare.mjs` 会调用 LLM（产生 token 费用）。

## 运行前提

- 在**项目根目录**运行：脚本按相对路径读根目录的 `.env`
- Node.js 20+（用到内置 `fetch`、ESM；`diagnose`/`ab` 直接 `import` 了项目里的 `.ts`，靠 Node 的类型剥离）
- `.env` 至少要有 `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASSWORD`（`PG_DB` 默认 `fund_monitor`，`AI_FUND_DB` 默认 `ai_fund`）
- 涉及 AI 的脚本还需要 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`）

---

## diagnose-prompt-data.mjs —— AI 预测数据体检

AI 建议的质量完全取决于喂给它的数据。这个脚本把"数据够不够、AI 到底看到什么"固化成一条命令，用于**改动前后对比**与**定期体检**。

```bash
node scripts/diagnose-prompt-data.mjs                    # 全量体检：新闻健康度 + 命中率 + prompt 快照
node scripts/diagnose-prompt-data.mjs --news             # 只看 ai_fund.raw_news 的数据健康度
node scripts/diagnose-prompt-data.mjs --hits             # 只看各基金的新闻命中率
node scripts/diagnose-prompt-data.mjs --prompt 161725    # 渲染指定基金的真实 prompt 快照
node scripts/diagnose-prompt-data.mjs --prompt 161725 001594
```

**看什么**：

| 输出块 | 关注点 |
|---|---|
| 近 7 天字段覆盖率 | `summary`/`sentiment`/`llm_tags` 覆盖率。实测上游标注覆盖不足时（历史上低至 6.5%），AI 的新闻块基本是空壳，只能靠标题关键词兜底 |
| 各基金命中率 | "近 7 天命中 = 0"的基金，说明它拿不到任何行业新闻，prompt 里只会出现大盘兜底新闻 |
| prompt 快照 | 逐块打印 AI 实际收到的内容（时点/指标/估值分位/资金与仓位/净值/重仓股/新闻），可核对每块是否按预期进入 |

它也**可被 import 复用**：已导出取数函数（`loadFund` / `loadCapital` / `loadPositions` / `loadBenchmark` / `formatMetricsBlock` / `formatValuationBlock` / `formatCapitalBlock` 等），且只有被直接运行时才执行 CLI。`ab-prompt-compare.mjs` 就是这么复用的——改这些函数时要意识到有下游依赖。

---

## ab-prompt-compare.mjs —— 同日 A/B 对比

用来回答"改 prompt 到底有没有用"：同一批基金、**同一天**的数据，用**改动前**与**改动后**两版 prompt 各问一次 AI，对比建议。

```bash
node scripts/ab-prompt-compare.mjs                                    # 默认 8 只代表性基金，各版跑 1 次
node scripts/ab-prompt-compare.mjs --repeat 3                         # 每版重复 3 次（★ 强烈建议）
node scripts/ab-prompt-compare.mjs --repeat 3 --temp 0                # 温度=0 的确定性对照
node scripts/ab-prompt-compare.mjs --codes 161725,001594              # 指定基金
node scripts/ab-prompt-compare.mjs --base <git-ref>                   # 换基线提交
node scripts/ab-prompt-compare.mjs --dump                             # 额外落盘两版完整 prompt
```

| 参数 | 说明 |
|---|---|
| `--codes a,b` | 参与对比的基金代码，默认 8 只（覆盖有估值分位匹配的不同板块） |
| `--repeat N` | 每个版本重复调用 N 次，**默认 1 但建议 ≥3** |
| `--temp T` | 采样温度，默认 `0`（与线上一致）；`--temp 0.3` 可对照改前的随机摆动 |
| `--base <ref>` | 基线提交，默认 `621c6f6`。**它换的是"旧版代码"，而对比变量是固定的那三块**（估值分位 / 资金与仓位 / 新闻时效选材），所以应指向"这三块改动之前的提交"；随便换别的 ref，差异里会混入无关变量 |
| `--dump` | 把两版完整 prompt 写到 `.tmp-ab/prompt-<code>-{old,new}.txt` |

### 两个关键设计（踩过的坑）

**1. 基线取自 git 里的真实旧代码，不是手工复刻。**
脚本用 `git archive <ref> src/main | tar x` 导出旧版源码树，再用 esbuild 打包其 `analyze.ts`（electron 用 stub alias），所以"旧版"就是当时真正跑的代码，不存在"复刻走样"。要做到这点，旧版源码树必须自洽（它的相对 import 解析到导出目录内）。

**2. 必须 `--repeat`，否则结论不可信。**
LLM 有采样随机性：实测同一份数据、同一个 prompt 跑 3 次，出现过 `hold / add / hold` 三种结果混合。**单次 A/B 得到的"方向变化"大部分是噪声**——本项目第一次单次实验得出"3/8 基金方向变化"，重复 3 次后发现那 3 只全部属于"版本内不稳定"，可信差异实际是 0。脚本只在"两版**各自**稳定、且方向不同"时才判定为真实差异。

### 输出

控制台：每只基金两版的建议序列 → 汇总表（含"判定 / 新提估值 / 新提资金 / prompt 长度 / 新闻条数"）→ token 用量。
落盘：`.tmp-ab/ab-result.json`，含**两版完整 prompt 与原始响应**、每只基金每次运行的 action/confidence/suggestedPct/reason，可事后复查（目录已在 `.gitignore`）。

### 成本与限流

- 每次调用约 2400 prompt token + ~150 completion token；`8 只 × 2 版 × 3 次 = 48 次` ≈ 11.6 万 token（约 1.5～2 分钟，含节流）
- **DeepSeek 中转站限流 30 次/分钟**（HTTP 429 `RATE_LIMITED`）：实测无节流时 48 次调用有 **17 次被拒**。脚本已内置 2.1s 最小间隔 + 按 `retryAfterSeconds` 退避重试（最多 3 次），大规模跑批必须保留

---

## verify-prompt-blocks.mjs —— prompt 组装断言

用 esbuild 打包**真实** `src/main/analyzer/analyze.ts`，执行与 `tests/prompt.test.ts` 同一套断言，输出逐条 PASS/FAIL 与一段真实渲染样例。

```bash
node scripts/verify-prompt-blocks.mjs     # 退出码 0 = 全部通过
```

用途：在**跑不了 vitest 的环境**（例如受限沙箱里 `vitest`/`esbuild` 无法 spawn 原生子进程，报 `spawn EPERM`）下仍能验证 prompt 组装。常规单测仍以 `npm test` 为准，本脚本是补充手段。

---

## ensure-db.js —— 创建数据库

```bash
node scripts/ensure-db.js
```

读取根目录 `.env` 的 `PG_*`，连到已有库后检查并创建 `fund_monitor` 数据库。**仅创建缺失的库**，绝不删除或修改已有对象。首次部署时若还没有 `fund_monitor` 库，先跑它，再跑 `npm run check`（自动建表）。

---

## vision/ —— 独立识图脚本

`vision/vision.js` 调用千问 VL 模型识图（按量付费），支持图片路径 / URL / 剪贴板三种输入：

```bash
node scripts/vision/vision.js <图片路径> [问题]
node scripts/vision/vision.js --url <图片链接> [问题]
node scripts/vision/vision.js --clipboard [问题]
```

需要 `DASHSCOPE_API_KEY`（可用同目录 `.env`）。`clipboard.ps1` / `clipboard.swift` 是取剪贴板图片的平台辅助脚本。
