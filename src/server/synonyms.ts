/* ============================================================
   server/synonyms.ts —— 领域同义词词典（缩写 ↔ 全称）
   在检索阶段扩展 query：用户说"交易主干"也能召回写着"TL"的文档。
   只扩检索召回，不改索引内容、不改阈值——BM25 打分仍按原 token，
   变体经 queryRewrite 多路融合进结果池。

   词典维护：直接编辑下方 SYNONYMS 表。key 为规范化（小写）形式。
   每个条目：alias（别名数组）→ canonical（主术语）。
   检索时 query 命中 alias 或 canonical，把整组词都视为相关，
   交给 queryRewrite 生成变体（"TL 交易系统"等价于"TradeLight"）。
   ============================================================ */

export interface SynonymEntry {
  /** 主术语（文档中最常出现的写法） */
  canonical: string;
  /** 别名/缩写/口语（用户可能这样问） */
  aliases: string[];
}

/** 领域词典——按现网知识库的实际术语维护 */
const SYNONYMS: SynonymEntry[] = [
  // ---- 交易系统 ----
  { canonical: 'TL', aliases: ['TradeLight', 'Trade Light', 'trad light', '交易主干', '衍生品交易系统'] },
  { canonical: 'TLShell', aliases: ['tlshell', 'TL Shell'] },
  { canonical: 'TLStruct', aliases: ['tlstruct'] },
  { canonical: 'TLBroker', aliases: ['tlbroker'] },
  { canonical: 'RTS', aliases: ['rts'] },
  { canonical: 'JDAPI', aliases: ['jdapi', 'jd api'] },
  { canonical: 'BrokerService', aliases: ['brokerservice', 'broker service', '经纪服务'] },
  { canonical: 'FixGateway', aliases: ['fixgateway', 'fix gateway', 'fix网关'] },
  { canonical: 'HKTrader', aliases: ['hktrader', 'hk trader', '海外扫库'] },

  // ---- 基础设施 ——
  { canonical: 'GDS', aliases: ['gds机房', '金锝机房'] },
  { canonical: 'K8S', aliases: ['k8s', 'Kubernetes', 'kubernetes'] },
  { canonical: 'gitlab-runner', aliases: ['gitlab runner', 'gitlabrunner', 'runner'] },
  { canonical: 'ELK', aliases: ['elk日志', '日志数据库', 'elastic'] },
  { canonical: 'OpsAgent', aliases: ['opsagent', 'ops agent', '运维agent'] },
  { canonical: 'MCP', aliases: ['Model Context Protocol', '模型上下文协议'] },

  // ---- 业务术语 ----
  { canonical: '自成交', aliases: ['self trade', 'selftrade', '自成交检查'] },
  { canonical: '回测', aliases: ['backtest', '历史行情验证'] },
  { canonical: '撮合', aliases: ['matching', '撮合引擎', 'order matching'] },
  { canonical: '风控', aliases: ['风险管理', 'risk control', '风控模块'] },
  { canonical: '扫单', aliases: ['sweep order', 'sweeping'] },
  { canonical: '报单', aliases: ['下单', 'entrust', '委托'] },

  // ---- 券商/柜台 ----
  { canonical: 'XTP', aliases: ['中泰xtp', '中泰xtp'] },
  { canonical: 'HTS', aliases: ['顶点hts', '顶点'] },
  { canonical: 'UST', aliases: ['恒生ust', '恒生'] },
  { canonical: 'CATS', aliases: ['中信cats', '中信'] },
  { canonical: 'AGW', aliases: ['国君agw', '国君'] },
];

/** 查某个词的同组扩展词（含自身）。找不到返回空数组。 */
export function expandSynonyms(word: string): string[] {
  const w = word.toLowerCase().trim();
  if (!w) return [];
  for (const e of SYNONYMS) {
    const all = [e.canonical, ...e.aliases].map((x) => x.toLowerCase());
    if (all.includes(w)) return all;
  }
  return [];
}

/** 对整句 query 做同义词组扩展：返回扩展后的 query 字符串列表。
 *  例如 "交易主干的主备怎么处理" 检测到"交易主干" → 追加变体 "TL 交易主干的主备怎么处理"。
 *  保守策略：只把 canonical 词注入 query 末尾，不替换原词——原词匹配仍生效。 */
export function expandQueryWithSynonyms(query: string): string[] {
  const out: string[] = [];
  const qLower = query.toLowerCase();
  for (const e of SYNONYMS) {
    // query 命中了组内任一词 → 把 canonical 补进一个变体
    const hits = [e.canonical, ...e.aliases].filter((a) => qLower.includes(a.toLowerCase()));
    if (hits.length) {
      const variant = `${query} ${e.canonical}`;
      if (!out.includes(variant)) out.push(variant);
    }
    // 最多扩 2 组（避免 query 被稀释）
    if (out.length >= 2) break;
  }
  return out;
}
