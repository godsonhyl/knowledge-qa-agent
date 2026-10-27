# Vibe Coding · 可观测性与回溯指南

> 适用项目：kqa-ts（企业知识问答 Agent，Hono + React + Qdrant + LLM 网关）
> 本文档回答两个问题：**"系统正在发生什么"（可观测性）** 与 **"那次为什么错"（回溯）**。
> 与 CONTRACTS.md 的关系：CONTRACTS 定义"什么不能改"，本文档定义"改坏了怎么发现、怎么定位、怎么归因"。

---

## 零、核心理念：Vibe Coding 的观测三件套

LLM 应用与传统 CRUD 系统有本质不同：**同样的代码,同样的输入,可能因为模型状态、检索边界、prompt 语义漂移而产生不同的输出**。可观测性建设的原则：

| 原则 | 落地 |
|---|---|
| **不可解释的输出不可信任** | 每个回答必须能回溯到"检索到了什么 / 证据门怎么判的 / LLM 拿到了什么 / 为什么引用 [n]" |
| **三层观测缺一不可** | 请求级（单问诊断）+ 聚合级（趋势/健康）+ 契约级（回归底线） |
| **用户反馈是最大的数据资产** | 👎 负样本是检索调优的唯一地面真相；必须有闭环把负样本转成可执行的修复 |
| **回答错了 ≠ 代码 bug** | 可能是：改写偏差 / 召回漏 / 证据门过松或过紧 / rerank 排错 / LLM 幻觉——四层各自观测，不可混为一谈 |
| **观测自身不可成为故障源** | 所有观测层（trace / metrics / audit）都异步或旁路，挂掉不影响主链路 |

---

## 一、请求级回溯：一次回答错误的五步定位法

这是本项目最重要的运维 SOP（Standard Operating Procedure）。当用户反馈"答错了"时，按顺序排查，**每一步都有对应的观测面板或数据源**。

### 1.1 五步定位流程

```
问题来了："这个回答不对"
   ↓
Step 1 打开 🔧 追踪面板（bubble-head，检索返回即可点）
   看什么：gate（词法/向量哪路过门）、lexHitCount/vecHitCount、rerankedCount、
           variants（改写质量）、耗时分解
   判断：
   - 两路都 ✗ 且 hasEvidence=false → 进入 Step 2（拒答误判排查）
   - 命中数够但排序不像话 → 进入 Step 3（排序问题）
   - 命中与排序都对但回答错 → 进入 Step 4（LLM 层）
   ↓
Step 2 拒答误判：看 variants + reason
   - variants 不包含正确的同义词 → queryRewrite / synonyms.ts 问题
   - variants 对但 lexHitCount 小 → BM25 召回问题（tokenize / 停用词 / 文档切块太大）
   - vecHitCount=0 → 嵌入网关挂了 / 向量门关闭（查 /api/health 的 embed 探针）
   - reason='below-threshold' → 考虑用户 sensitivity 设置（设置弹窗），而非改阈值！
   ↓
Step 3 排序问题：展开"命中 chunk 明细"
   - fused/rel/lex.matchedTerms/sim 逐块看，top1 是否真的应该排第一
   - rerankedCount < 预期 → rerank 网关超时（trace 里 rerankMs）→ 用了 RRF 兜底
   - 核心片段没进 topK 但在 allScored → 提高 topK 或检查 rerank 模型
   ↓
Step 4 LLM 层：
   - 用到的证据对吗？点击每个 [n] 角标，核对原文（ViewerModal 高亮定位）
   - 有没有幻觉数字 → 前端"事实核对警告"列出 unsupported 值
   - 整段没标 [n] → "引用覆盖提示"（citationGap）
   - 引用了不相关片段 → prompt 上下文过长导致注意力稀释？截短 topK
   ↓
Step 5 归档到反馈：
   - 点 👍/👎 进 kqa_feedback
   - 去 FeedbackModal 的"诊断聚合"tab 看该问题聚集了几次（聚集=优先修）
   - "重跑"按钮验证修复后是否改善
```

### 1.2 实测 trace 样例（现网数据）

```json
{
 "hasEvidence": true, "reason": "matched", "hits": 3,
 "trace": {
  "variants": [
    "自成交检查怎么做",
    "自成交检查怎么做 自成交",
    "自成交检查的方法与操作流程",
    "自成交（wash trade）识别、监控规则与防范措施"
  ],
  "lexHitCount": 3, "vecHitCount": 16, "rerankedCount": 3,
  "gate": {"lex": true, "vec": true},
  "channel": "kb",
  "searchMs": 4787, "rewriteMs": 268, "classifyMs": 671, "rerankMs": 91
 }
}
```

**怎么解读**：
- `searchMs 4787` 但 `rewriteMs 268 + classifyMs 671 + rerankMs 91 ≈ 1s` —— 大头在 BM25/向量索引扫描与嵌入调用，这是合理的（每次查询要嵌入原问题 1 次）
- `vecHitCount 16` 远大于 `lexHitCount 3`：向量通道召回了大量弱相关候选，但 rerank 精排后只保留 `topK=3`，属于正常
- gate 双 ✗ 才拒答（OR 关系）：单 ✗ 说明另一路失守，一般是嵌入网关半故障，去 `/api/health` 确认

### 1.3 追踪面板的关键 Toggle

- **🔧 按钮**：位于回答气泡头部（`bubble-head`），**检索返回即可点，不需要等 LLM 流完**——回答错了通常不必等 LLM 跑完才能定位
- **命中 chunk 明细**：每块显示 `fused`（RRF 融合分）/ `rel`（rerank 归一化相关度）/ `lex: score,matched` / `sim`——rerank 排错和 BM25 排错在这里一眼分辨

---

## 二、聚合级观测：趋势 / P95 / 覆盖率

### 2.1 `GET /api/metrics`（进程内存级，重启归零）

```json
{
 "http": {
   "totalRequests": 1,
   "searchMsAvg": 4787, "searchMsP95": 4787, "searchCount": 1,
   "refusalRate": 0,
   "reasonCounts": {"matched": 1},
   "channelCounts": {"kb": 1},
   "slowQueries": [{"ms":4787,"question":"自成交检查怎么做","reason":"matched",...}],
   "chunkCoverage": {"distinctHitChunks": 3, "zeroHitChunks": 2395, "topHitChunks": [...]}
 }
}
```

**三张趋势表的读法**：

| 指标 | 健康形态 | 异常形态 → 行动 |
|---|---|---|
| `reasonCounts` | matched 占多数 | `below-threshold` 聚集 → 检查知识库是否新导入了措辞偏离的文档（不要动阈值）|
| `refusalRate` | 一条基线（用户实际问题难度决定） | 突然飙升 → 先查嵌入网关健康（`vecHitCount` 同步下降=向量门失守）|
| `slowQueries` | 空 | 有聚集 → 看 `searchMs` 分解是 rewrite/classify/rerank 哪个环节慢；连续 >5s 建议查 LLM 网关负载 |
| `chunkCoverage.zeroHitChunks` | 大（新导入文档正常现象） | 老文档长期 0 命中 → 可能几块质量差/内容过时,评估重新蒸馏或删除 |
| `chunkCoverage.topHitChunks` | 分散 | 过度集中 → 可能知识库内容重复导入过（`⧉ 重复`徽章也会标出来） |

### 2.2 `GET /api/health`（公开免鉴权，给外部监控/uptime bot 直接打）

```json
{
 "ok": true,  ← 整体健康 = Qdrant 可达（主链路依赖）
 "deps": {
   "qdrant":   {"ok": true, "ms": 3},
   "llm":      {"ok": true, "ms": 18},   ← 2xx/3xx/4xx 都算可达
   "embed":    {"ok": true, "ms": 9},
   "searxng":  {"ok": true, "ms": 9},
   "firecrawl":{"ok": true, "ms": 8}
 }
}
```

**排障决策树**：
- 整体 `ok=false`（即 Qdrant 挂）→ 主链路瘫痪，需要立即处理
- 单依赖挂 → 主链路自动降级（embed 挂 → BM25-only；searxng 挂 → 拒答页无"联网搜索"按钮），应用层不告急但用户可感知
- 配了 `ALERT_WEBHOOK_URL` 时,整体不健康会 POST 一条告警（含哪个 dep 挂了）,按 `ALERT_DEBOUNCE_SEC` 指纹防抖避免刷屏

**为什么按依赖分层而不是只看整体**：用户反馈"回答变慢了"，如果只有一个聚合 ready 标志，得靠猜；分层探针直接告诉你是嵌入网关因此每次查询都重试了两轮（embedBatch 有 2 次重试）。

---

## 三、契约级观测：测试即回归底线

### 3.1 为什么需要第三层

请求级和聚合级能发现"这次错了""最近变慢了"，但**不能发现"行为已经是错的但因为没人问对问题所以从没人反馈"**。比如把证据门调宽 20%，大部分老问题依然命中（回归看起来没问题），但会出现一类新的"不该答也答了"的软幻觉——用户不会主动抱怨"你答得太多了"。

`tests/evidence.test.ts` 的两组回归就是为这种情况设计的：

| 回归 | 内容 | 保护的契约 |
|---|---|---|
| **§4 应命中 8 条** | 术语命中/短语命中/高分命中 | 证据门不会太严 → 把应该命中的拒答掉（"漏答"） |
| **§5 应拒答 7 条** | 无关主题/零星字词 | 证据门不会太松 → 出现"编造式回答"（"多答"） |

**流程红线**：任何检索层改动（包括想当然的"顺手优化"）都必须先跑 `npm test`；§4/§5 是**字面不变**的——不能为了过测试而改测试。

### 3.2 契约测试的覆盖矩阵

| 测试文件 | 保护的不可见契约 |
|---|---|
| `chunker.test.ts` §7 | 行号 + 字符偏移精度（引用定位,**改了 chunker 用户所有历史引用定位都会错位**,必须回归） |
| `factCheck.test.ts` | 抽验豁免规则的边界（版本号主段 / 小数字归纳），防止"为了减少误报"把抽验调到形同虚设 |
| `oidc.test.ts` | state 一次性消费 / RS256 篡改 / scrypt 往返 — 安全契约,肉眼无法验证 |
| `rerankCache.test.ts` | 缓存 key 含 topK 维度，防止意料外的"不同 topK 复用同 key"错误 |
| `embedCache.test.ts` | 缓存 key 含 model 派生 — 防止换嵌入模型后混用旧向量 |

---

## 四、回溯：从负样本到修复的闭环

观测的最终目的是**让"错一次"产生"修一次"的输入**。本项目有一个设计好的闭环流程：

```
用户点 👎
  ↓
kqa_feedback 落库（question + answerExcerpt + hitDocs + mode + ts）
  ↓
FeedbackModal 诊断聚合 tab
  · 按 mode 分组：normal（排序差）/ fallback（兜底失败）/ web（联网补救）
  · top 高频问题：聚集出现 = 优先修复，零星出现可能只是用户表达问题
  ↓
按 mode 分类行动：
  · fallback 组聚集   → 知识库缺内容,补文档/重导,而不是改检索
  · normal 组聚集    → 用"重跑"按钮验证,若稳定在 top-K 边缘,
                        考虑加同义词词典条目(扩召回,不改阈值)
  · web 组聚集       → 知识库该主题内容陈旧,触发 sync-confluence 更新
  ↓
修复后:
  · "重跑"该问题,对照新 trace 确认命中改善
  · 下轮同类问题点赞率上升 → chunkCoverage 中对应 chunk 进入 topHitChunks
```

**为什么这一层重要**：没有闭环的观测只是"仪表盘好看"；有了闭环,👎 从"用户发泄渠道"变成"优先级排序的修复队列"。

---

## 五、用户端透明性：把观测暴露给最终用户

与大部分系统不同，本项目的前置设计判断是：**知识问答的用户也应该能看到系统的"内心状态"**——因为答案错了的时候，用户是第一受害者,也是第一观察者。

| UI 元素 | 传递的信息 | 构成回溯的什么环节 |
|---|---|---|
| `检索知识库…` 占位气泡 | 系统正在检索阶段（不是卡住了）| 让用户知道在等哪一层,避免误判为网络问题 |
| `[n]` 角标可点击 | 每条结论的原文出处 | 用户自己就能核对"答案是从这来的吗" |
| 证据卡 + 原文行高亮 | 定位到具体行级偏移 | 不依赖开发者也能完成"最后一公里验证" |
| `未检索到依据` 拒答页 | 带拒答原因 + 检索词展示 | 让用户也知道自己问了什么词,系统提取了什么词 |
| `已回答` vs `模型兜底` vs `联网搜索兜底` 彩色标签 | 当前答案走的是哪条链路 | 避免把兜底误当成知识库内容（不伪装有据） |
| `高/中/低可信` Tag | rerank 置信度 | 低可信时用户自然会更仔细核对角标 |
| `引用覆盖提示` / `事实核对警告` | 引用密度 / 幻觉数字 | 用户本身就是抽验的最后一层防线 |
| 🔧 面板 | 完整 trace | 高级用户可自助定位是提问方式问题还是系统问题 |

**设计原则**：**不伪装有据,也不隐藏缺陷**。拒答就说拒答（带原因）,兜底就标兜底（无引用）,低置信就提示核对——这些"看起来像暴露弱点"的设计,实际是这套系统的产品灵魂：**可信度 > 流畅度**。

---

## 六、审计与不可见动作的留痕

多人治理场景中的"回溯"还有另一半: **"谁在什么时候做了什么"**。`AUDIT_LOG_ENABLED=1` 时,以下动作全部写入 Qdrant `kqa_audit`:

| 动作 | detail 内容 |
|---|---|
| 提问 / 联网搜索 | question / q 原文（截 500 字） |
| 文档导入 / 上传 | name + chunkCount |
| 文档删除 | docId |
| 知识库清空 | 备份文件名（可回溯到恢复点） |
| 登录 / 注册 | 用户身份（不含密码） |
| sync-confluence | checked/updated/stale/failed 计数 |
| 文档更新 | docId + size |

**配合"备份 + 恢复"就形成了完整的灾难回溯能力**：审计知道谁动了什么 → 备份知道动之前长什么样 → 恢复一条命令。

**运维场景例子**：某天一位用户反馈"上周还能查到的一篇文档没了"：
1. 查 `kqa_audit` 当天的 `doc_delete` 记录
2. 找到操作者 username + docId
3. 查备份目录（自动保留最近 10 份）
4. 从备份里抽出该 doc 恢复,或联系重新导入

---

## 七、踩坑沉淀：观测相关的实战教训

这一节记录的是**真实发生过的、观测系统帮我们抓到（或没抓到）的事**。

### 教训 1：silent failure 是观测的天敌

**事件**：queryRewrite 的 max_tokens 一开始是 120。接入 deepseek reasoning 模型后,reasoning 消耗掉全部 tokens,content 返回空——**queryRewrite 静默失败了几周**,检索退步成"只用原问题+同义词词典"扩召回。没有任何报错,因为代码里的 catch 会静默降级（这是对的）,**但完全没人知道这个安全网被触发了**。

**修复**：
- max_tokens 提到 2000（reasoning 兼容）
- **通用教训**：所有"静默降级"路径都应该出现在 trace 里（比如 `variants.length===1` 意味着改写失败,看 trace 能发现）,纯静默降级对可观测性是反模式

### 教训 2：观测数据本身的内存膨胀

**事件**：早期 `recordSearch` 只记 `searchMs`。后来要加 slowQueries 诊断,直接把 `question` 完整字符串存进去,内存累积。

**修复**：latencySamples 上限 200 条（超出 shift 最旧的）, question 截 100 字。

**通用教训**：观测层是"进程内累积型"的数据结构（Map/Set/Array）,**必须带容量上限**，否则观测本身会吃掉稳定性。

### 教训 3：指标要能区分"故障"和"配置"

**事件**：`chunkCoverage.zeroHitChunks=2395` 一开始看着像大问题——97% 的 chunk 长期零命中。

**实际情况**：知识库目标是几千 chunk,用户问题只覆盖其中很小子集——低命中率才是常态。

**通用教训**：聚合度量除非有历史基线（前一章提到"重启归零"限制了这个能力,重启后重新积累）,否则绝对值意义有限。看**趋势变化**而不是绝对值,这也是 alert webhook 用指纹防抖而不是阈值触发的原因之一。

### 教训 4：用户反馈是唯一地面真相

**事件**：全链路的指标看起来都正常——检索命中正常、门正常、rerank 正常、引用正常——但用户反馈"答非所问"。

**根因**：一行指标都没法告诉你"这个问题的 intent 用户是什么"。"中证1000 现货与期货的实时基差"的检索结果看,命中现货数据完全合理——但用户 intent 是"基差"（现货+期货组合）,系统只答了现货。

**修复**：这类 intent 级别的偏差**没有任何自动化指标可以捕捉**——必须依赖反馈收集,再由"重跑 + 人工对照 trace"定位。

**通用教训**：LLM 应用最难的部分,恰恰是**无法被系统内观测到的误差**。FeedbackModal 的"诊断聚合 + 重跑"组合就是为此设计的轻量武器,否则只能靠开发者自己使用产品时撞上。

### 教训 5：观测层暴露的密钥风险

**事件回顾**：`/api/config` 一开始把它能返回的尽量都返回（model、baseUrlHost）,直到讨论"什么应该暴露给浏览器"时才明确——**所有 key 绝不能下发**,哪怕看似"只给前端的展示用"。

**原则**：所有 Observability 端点写代码前先做"密钥扫描"检查,`/api/health` 返回的 `config` 块只含 boolean 开关,不含 URL/key 内容。

---

## 八、排障 SOP 速查（打印这张）

```bash
# 1. 系统活着吗？哪个依赖挂了？
curl -s http://localhost:3002/api/health | jq '.ok, .deps'

# 2. 最近检索趋势 + 慢查询 + 拒答原因
curl -s http://localhost:3002/api/metrics | jq '.http'

# 3. 用一个问题手动验证检索（带 trace）
curl -s -X POST http://localhost:3002/api/kb/search \
  -H 'Content-Type: application/json' \
  -d '{"question":"<用户反馈的问题>","topK":5}' | jq '.trace, .hasEvidence, (.hits[] | .docName)'

# 4. 反馈负样本聚集
curl -s http://localhost:3002/api/feedback/analysis | jq '.byMode, .topQuestions'

# 5. 容器日志（启动配置 + 降级 warn）
docker logs kqa-ts-app --tail 50

# 6. distill 任务状态
curl -s http://localhost:3002/api/kb/distill-status
```

**定位错了回答的五步**（§1.1 流程图的浓缩）：
1. **拒答了？** → 看 trace: variants 对不对 / lexHitCount+vecHitCount 是否全零 / embed 探针是否挂
2. **答了但引用混？** → 看命中 chunk 明细: top1 的 rel 是否真高 / rerankedCount 是否缩水（rerank 挂了）
3. **引用正确但表述错？** → 看 [n] 定位原文,对比答案逐句,确认是否 prompt/模型幻觉 → 强化 SYSTEM_PROMPT 措辞或截短上下文
4. **速度慢？** → metrics 里 searchMsP95 分解 rewrite/classify/rerank 哪段长
5. **修完没把握？** → 留着负样本,用"重跑"按钮做回归；跨批次改动 → `npm test`

---

## 九、观测能力的已知局限与取舍

诚实列出当前观测体系的短板,与其说是自我批评,不如说是给下一轮迭代的优先级参考：

| 局限 | 影响 | 为什么当时接受了 |
|---|---|---|
| metrics/latencySamples 进程内存级,重启归零 | 无长期趋势,基线难建立 | 单实例部署够用;持久化需要定时落 Qdrant/落盘,当时觉得"重启本身少"不是值得花预算的痛点 |
| LLM tokens 无计量 | 无成本归因( 按 user/问题维度) | 需要改 SSE 透传解析 final chunk 的 usage,当时判断改透传风险大于记账价值 |
| trace 不持久化 | 历史回答的完整诊断信息只在当时可见,重启后旧对话的 profiling 数据没了 | trace 随 SearchResult 回到前端,展示完毕留存对话的 hits 引用即可,重复存 trace 觉得冗余 |
| rerank 缓存无法区分"缓存命中"和"重跑" | 看不出命中缓存的比例 | 低优先级——缓存 5min TTL,收益预期固定,不需要精细衡量 |
| audit 日志依赖 Qdrant | Qdrant 挂了 audit 也挂（雪上加霜） | 短期把 audit 落地也挂同一存储是合理的方便;如果未来审计变成强合规要求,再考虑独立存储 |

这些局限什么时候值得修：当 P95/成本/trace 历史查询在实际运维中**第二次**成为瓶颈时——第一次是信号,第二次是需求（head first 原则）。项目大部分"明确不做"的判断都基于这个标准。
