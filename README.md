# memory-system · 记忆系统

一个给 AI 陪伴角色用的分层记忆系统。零运行时依赖，纯 Node ESM。
**仓库里只有中性测试数据，不含任何真实人物的经历。**

设计见 [docs/设计-v2.md](docs/设计-v2.md)，一页纸介绍见 [docs/介绍.md](docs/介绍.md)，同类项目参考见 [docs/参考-同类项目.md](docs/参考-同类项目.md)。

## 这一版做了什么

| 模块 | 文件 | 状态 |
|---|---|---|
| 捕获层（每轮同步落盘 + fsync） | `src/core/turns.js` | ✅ |
| 事件模型 / 双时态 / 墓碑 | `src/core/events.js` | ✅ |
| 三轴打分 + 激活度 + 唯一性 | `src/core/score.js` | ✅ |
| 容量驱动分层 / 迟滞 / 冷却 / 配额 / 淘汰 | `src/core/tier.js` | ✅ |
| 事实表（不衰减、只推翻、immortal） | `src/core/facts.js` | ✅ |
| 线索 | `src/core/threads.js` | ✅ |
| 事件合并 / 向量去重 | `src/core/merge.js` | ✅ v0.4 |
| 混合检索（BM25 ⊕ 向量 ⊕ 实体，RRF） | `src/core/recall.js` | ✅ v0.2 |
| 向量化 + 缓存 | `src/core/embed.js`、`embeddings.js` | ✅ v0.2 |
| 启动上下文（预算硬约束） | `src/core/boot.js` | ✅ |
| 夜间巩固（幂等 / 水位 / 隔离） | `src/core/consolidate.js` | ✅ |
| 离线启发式抽取器 | `src/llm/stub.js` | ✅ v0.2 重写 |
| OpenAI 兼容抽取器 | `src/llm/openai.js` | ✅ |
| 记忆体检（dry / full / 基线） | `src/core/eval.js` | ✅ |
| 每晚自动巩固（补跑 / 退避 / 幂等） | `src/core/schedule.js` | ✅ v0.3 |
| 本地 GUI（会话 / 检查器 / 体检 dry+full） | `src/server/app.js`、`src/web/` | ✅ v0.3 |

测试 52 条。

## 快速开始

```bash
node bin/memctl.js init
node bin/memctl.js seed --from ./seed
node bin/memctl.js boot          # 看她每次醒来会看到什么
node bin/memctl.js eval --mode dry

node bin/serve.js --port 8787    # GUI，只开本机
# 手机也要用：node bin/serve.js --host 0.0.0.0   （没有鉴权，只在自家网络开）
# 打开 http://127.0.0.1:8787
```

接真实模型：复制 `config.example.json` 为 `config.json`，填 `llm.apiKey`
（或设环境变量 `DEEPSEEK_API_KEY`）。没有 key 时一切照跑，只是回答会降级成
"把想起来的念给你听"，不会假装能聊。

命令行：

```bash
node bin/memctl.js capture --role user --text "今天去学校办了注册"
node bin/memctl.js consolidate --local      # --local 强制离线抽取器
node bin/memctl.js recall "注册"
node bin/memctl.js stats
node bin/memctl.js inspect e_xxx
node bin/memctl.js embed                    # 换 embedding provider 后重建向量
node bin/memctl.js eval --mode full --set-baseline
```

## v0.4：事件合并与向量去重

`src/core/merge.js`。分两级，风险完全不同：

- **去重（dedupe）**：相似度 ≥ 0.9，确定性地并成一条，不改写摘要、不增加代数。
- **合并（merge）**：相似度 ≥ 0.45 只当候选门槛，真正"是不是同一件事"交给模型判断；
  合并后摘要代数 +1，到 3 就停（再往上就是摘要漂移）。

只碰 cache2 / l4，**core 不动**（那是每轮注入的东西，动它等于改人格的连续性）；
契约、里程碑、pin 过的、immortal 的永不合并；被并掉的事件标 `status='merged'` +
`mergedInto`，不删除，溯源可追。

**校准暴露的坑：字面相似度分不开"同一件事的碎片"和"很像的两件事"。**

| 对比 | 余弦 | 实体 | 文本 | 综合 |
|---|---|---|---|---|
| 完全相同 | 1.00 | 1.00 | 1.00 | **1.000** |
| 同片段（注册 / 排队） | 0.21 | 1.00 | 0.06 | **0.425** |
| 近似不同（注册 / 退学） | 0.79 | 1.00 | 0.60 | **0.822** |
| 无关 | 0.01 | 0 | 0 | **0.007** |

"退学"和"注册"比真正的同片段还像。所以任何单一阈值都不安全：调到 0.4 会把退学并进注册，
调到 0.75 就永远合并不了碎片。结论是**相似度只能筛候选，判断必须交给模型**；
离线模式因此只做"一句包含另一句"的保守合并，拿不准就不并。

## v0.3 的四处改动

**1. 存活晋升改成按自然日算。** 原来的 `minConsolidations: 3` 数的是"被巩固了几次"，
重跑同一批 turn 会让事件凭空变老。现在用 `minSurvivalDays: 2`：事件存在满两天才有资格
进 core，当天的新事件不会插队（`retain ≥ 0.85` 或你说了"记住"仍然直接绕过）。

**2. 每晚自动巩固。** `src/core/schedule.js`，跑在 GUI 服务里，默认 04:30。
判据是"今天还没跑过"而不是"现在正好 4:30"，所以半夜关机、早上开机也能补跑。
失败退避 5 分钟重试。状态存在 `data/schedule.json`，侧栏底部直接显示。

**3. 体检页接上了 full 模式。** dry 只判检索层；full 真生成回答再判分，逐条显示她答了什么。
没接模型时 full 会直接拒绝并说明原因，不会静默降级。

**4. 向量 provider 可以换，且换了不会静默失效。** `embeddings.meta.json` 记录
provider 与维度，不匹配时整批作废；`node bin/memctl.js embed` 重建。
之前这里有个坑：换 provider 后旧向量长度不等，`cosine` 返回 0，不报错，检索悄悄退回纯词法。

## 要不要配真 embedding provider

结论：**可以先不做，但要把开关留着**。理由和成本：

| 项 | 数字 |
|---|---|
| 本地向量开销 | 1000 条 8ms，单条约 1KB JSON；3650 条/年 ≈ 3.6MB |
| 远端向量（text-embedding-3-small） | 每天 10–20 条 × ~120 token ≈ 40k–70k token/月，约 $0.001/月 |
| 远端向量存储 | 1536 维 float32 ≈ 6KB/条，3650 条/年 ≈ 22MB |
| 巩固时开销 | 一次批量调用，200–800ms，不在对话路径上 |
| 召回时开销 | 每次提问一次 query embedding，100–300ms，**在对话路径上** |
| 换 provider 的工作量 | 代码已就绪，`memctl embed` 重建，约 10 分钟 |

真正的代价不是钱，是**多一个会在对话路径上失败的依赖**，以及**事件摘要会发给第三方**。
所以默认仍是本地向量；只有当 recall@5 的评测分数掉下来、且确认是"同义改写导致漏召回"时，
再去开远端。

另一个更便宜的补法：抽取时让 LLM 顺带输出实体的 `aliases`（同义词/别称），
索引时一起建 —— 不增加调用次数，只增加输出字段。这能解决专名类改写，解决不了长句改写。

## v0.2 的三处改动

**1. 离线抽取器不再是"一条消息一个事件"。**
现在做四件事：15 分钟内的连续发言按 session 合成一个 episode；用词表算三个轴
（情绪词分强/中两档、承诺词、时间与计划词），分布是散开的；把"记住…""我对…过敏"
"我讨厌…"抽成 facts；实体来自引号、英文与已知语料词表。它仍然不懂语义，但管道能跑、
测试能过、降级时不出丑。

**2. 检索改成词法 ⊕ 向量的混合。**
词法负责硬信息（专名、数字、"城东""11 月 8 号"），向量负责模糊相似（语序、近义字词），
RRF 融合排序。相关度用可解释的绝对量而不是榜内归一化：

```
nLex = 命中的查询词占比        （与语料大小无关）
nVec = 余弦相似度的线性映射
rel  = 1 - (1-nLex)(1-nVec) + 实体加成
```

榜内归一化会让"任何查询的第一名"都等于 1.0，等于没有闸门。

**3. GUI。**
每天一个新会话（`s_<dayKey>`，本地 04:00 切日）；侧栏最近 7 个会话只读浏览；
「记忆」页是检查器（每条事件的层、retain 四项分解、搬迁历史、有无向量）；
「体检」页跑 dry 评测并给出分类通过率与逐条结论。

## 三条铁律（代码里是硬约束）

1. **捕获不等于巩固。** 每轮同步 append + fsync；巩固异步、幂等、可重入，靠
   `state.watermarkTurn` 推进，失败不前进。
2. **容量是唯一控制量。** 每层只配 token 预算，切线 = 第一条挤不进来的分值。
   没有"权重低于 X 就怎样"。
3. **契约不进池。** `rules.md` 与 `immortal: true` 的事件/事实不参与打分、不参与淘汰、
   不会被自动推翻，`boot()` 不接受裁剪。

## 关键参数（`src/core/config.js`）

| 参数 | 值 |
|---|---|
| 预算 | core 2.4k / warm 2.6k / cache2 15k / l4 90k |
| 晋升 | core 1（突发 2）、warm 3（突发 7）；`retain ≥ 0.85` 或 immutable 绕过 |
| 存活 | `minSurvivalDays = 2`（按自然日，不按巩固次数） |
| 迟滞 / 冷却 | 晋升 > 1.15×门槛；冷却 14 天；每晚 ≤ 30 次搬迁 |
| 召回 | 阈值 0.40，或 rel ≥ 0.5；且必须有检索信号（rel ≥ 0.05）；最多 5 条 / 1000 token |
| 向量 | 默认本地 384 维；可切 `embedding.provider = "openai"` |
| 合并 | 去重 0.9 / 候选 0.45；每晚 ≤10 次合并、≤20 次模型询问；代数上限 3 |
| 巩固 | 每天 04:30，服务启动时补跑未跑过的当天 |

## 目录

```
docs/       设计文档
src/core/   引擎（无外部依赖，可单测）
src/llm/    抽取器（离线 / OpenAI 兼容）
src/server/ 本地 HTTP 服务
src/web/    单页 GUI（无构建步骤）
bin/        memctl（CLI）、serve（GUI）
probes/     记忆体检探针
seed/       人格/契约/核心事件（含私人信息，已 gitignore）
data/       运行时数据（已 gitignore）
```

## 已知短板

- **离线合并很保守。** 没有模型时只会合并"一句包含另一句"的情况；真正的碎片合并需要
  `llm.mergeEvents`（OpenAI 那一版已实现，用 `same:true/false` 判定）。
- **本地向量解决不了语义改写**，所以"注册 vs 退学"这种只能靠模型判，不能靠阈值。
- **full 评测串行跑**，探针多了会慢。
- **没有登录鉴权**，`--host 0.0.0.0` 只在自家网络里用。
