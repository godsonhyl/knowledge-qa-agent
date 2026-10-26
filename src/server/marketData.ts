/* ============================================================
   server/marketData.ts —— 行情数据直查通道
   复用"事实直查"模式（directAnswer → 前端 direct 标记跳过 LLM）。
   检索前优先判定是否行情类问题，命中则直连东方财富 push2 接口，
   返回格式化文本（带日期+来源），失败则回退知识库检索。

   东财 push2 字段（×100，需 /100）：
   f43=最新价/收盘  f44=最高  f45=最低  f46=今开  f60=昨收  f170=涨跌幅
   ============================================================ */
import { ENV } from './env.js';

/** 指数代码 → 东财 secid（1.上交所 0.深交所） */
const INDEX_MAP: Record<string, { secid: string; name: string }> = {
  '000001': { secid: '1.000001', name: '上证指数' },
  '399001': { secid: '0.399001', name: '深证成指' },
  '399006': { secid: '0.399006', name: '创业板指' },
  '000300': { secid: '1.000300', name: '沪深300' },
  '000852': { secid: '1.000852', name: '中证1000' },
  '000016': { secid: '1.000016', name: '上证50' },
  '000905': { secid: '1.000905', name: '中证500' },
};

/** 股指期货 secid 映射（中金所市场=8）。
 *  IF(沪深300)=040xxx  IH(上证50)=070xxx  IC(中证500)=060xxx  IM(中证1000)=150xxx
 *  后缀：120=当月连续 121=下月连续 122=下季连续 123=隔季连续 130=主力合约 131=次主力 */
const FUTURES_MAP: Record<string, { spot: string; name: string; contracts: Record<string, string> }> = {
  '000300': { spot: '000300', name: '沪深300', contracts: { '当月': '8.040120', '下月': '8.040121', '下季': '8.040122', '隔季': '8.040123' } },
  '000016': { spot: '000016', name: '上证50', contracts: { '当月': '8.070120', '下月': '8.070121', '下季': '8.070122', '隔季': '8.070123' } },
  '000905': { spot: '000905', name: '中证500', contracts: { '当月': '8.060120', '下月': '8.060121', '下季': '8.060122', '隔季': '8.060123' } },
  '000852': { spot: '000852', name: '中证1000', contracts: { '当月': '8.150120', '下月': '8.150121', '下季': '8.150122', '隔季': '8.150123' } },
};

/** 期货/基差类关键词——这类问题走基差直查通道（现货+期货同时取，算基差/基差率/年化） */
const FUTURES_BASIS_KEYWORDS = [
  '基差', '期现', '现货与期货', '现货和期货', '期货与现货', '期货和现货',
  '升水', '贴水', '年化基差', '基差率',
  '股指期货', '主力合约', '当月连续', '次月', '当季', '次季',
  'IM现货', 'IC现货', 'IF现货', 'IH现货',
  'IM基差', 'IC基差', 'IF基差', 'IH基差',
];

/** 行情类问题关键词——命中任一则尝试行情直查 */
const MARKET_KEYWORDS = [
  '上证指数', '上证综指', '大盘', 'A股大盘', '沪市',
  '深证成指', '深成指', '深市',
  '创业板指', '创业板',
  '沪深300', '沪深300指数',
  '中证1000', '中证500', '中证800',
  '上证50',
  '收盘价', '收盘行情', '收盘', '收盘点位',
  '开盘价', '开盘', '最新价', '实时行情', '行情',
  '涨跌幅', '涨跌', '指数点位',
];

/** 含期货/基差/期现的问题——走基差直查通道（现货+期货同时取，算基差） */
const FUTURES_KEYWORDS = FUTURES_BASIS_KEYWORDS;

/** 直连超时：宿主机无外网出口时快速失败让路给 Firecrawl */
const DIRECT_TIMEOUT_MS = 2500;
/** Firecrawl 备路超时：rawHtml 抓取实测 3-8s */
const RELAY_TIMEOUT_MS = 9000;

/** 判定是否是行情类问题（现货直查） */
export function isMarketQuery(question: string): boolean {
  const q = question.toLowerCase();
  // 排除明显在问"是什么/怎么算/原理"的定义类问题——这些走知识库
  if (/是什么|什么叫|什么意思|定义|原理|公式|怎么算|如何计算|区别|含义|什么是|是指什么/.test(q)) return false;
  // 期货/基差问题走基差直查（isFuturesBasisQuery），不走现货直查
  if (isFuturesBasisQuery(question)) return false;
  // 必须命中至少一个行情关键词
  return MARKET_KEYWORDS.some((kw) => q.includes(kw.toLowerCase()));
}

/** 判定是否是期货/基差类问题——走基差直查通道 */
export function isFuturesBasisQuery(question: string): boolean {
  const q = question.toLowerCase();
  // 排除定义类
  if (/是什么|什么叫|什么意思|定义|原理|公式|怎么算|如何计算|区别|含义|什么是|是指什么/.test(q)) return false;
  return FUTURES_BASIS_KEYWORDS.some((kw) => q.includes(kw.toLowerCase()));
}

/** 从问题中提取指数代码（显式 6 位代码 或 名称匹配） */
function extractIndexCode(question: string): string | null {
  // 显式代码：000001 / 399001 等
  const m = question.match(/\b(000001|399001|399006|000300|000852|000016|000905)\b/);
  if (m && INDEX_MAP[m[1]!]) return m[1]!;
  // 名称匹配（按长度降序，避免"中证1000"被"中证500"截胡）
  const names = Object.entries(INDEX_MAP).sort((a, b) => b[1].name.length - a[1].name.length);
  for (const [code, { name }] of names) {
    if (question.includes(name)) return code;
    // 简称
    const short = name.replace('指数', '');
    if (short.length >= 3 && question.includes(short)) return code;
  }
  // "大盘"/"A股" 默认指上证指数
  if (/大盘|A股/.test(question)) return '000001';
  return null;
}

export interface MarketQuote {
  name: string;
  code: string;
  /** 收盘/最新价 */
  price: number;
  /** 涨跌幅（%，正涨负跌） */
  changePct: number;
  /** 今开 */
  open: number;
  /** 最高 */
  high: number;
  /** 最低 */
  low: number;
  /** 昨收 */
  prevClose: number;
  /** 数据时间戳 */
  timestamp: string;
}

/** 调东财 push2 接口取指数快照；失败返回 null。
 *  直连 push2 失败时（如容器无外网出口），经 FIRECRAWL_URL 用 rawHtml 抓 JSON 原文。 */
async function fetchIndexQuote(code: string): Promise<MarketQuote | null> {
  const entry = INDEX_MAP[code];
  if (!entry) return null;
  const fields = 'f43,f44,f45,f46,f60,f170';
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${entry.secid}&fields=${fields}&fltt=2`;
  // 优先直连（快，~1s）
  const direct = await fetchDirect(url).catch(() => null);
  if (direct) return direct;
  // 退路：经 Firecrawl rawHtml（容器无外网出口时仍可经出口代理拿到）
  if (ENV.FIRECRAWL_URL) {
    const viaFc = await fetchViaFirecrawl(url).catch(() => null);
    if (viaFc) return viaFc;
  }
  return null;
}

/** 直连 push2（宿主机有出口时 ~1s） */
async function fetchDirect(url: string): Promise<MarketQuote | null> {
  const entry = parseSecidFromUrl(url);
  if (!entry) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DIRECT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const d: any = await res.json().catch(() => null);
    return parseQuote(d, entry);
  } catch { return null; } finally { clearTimeout(timer); }
}

/** 经 Firecrawl rawHtml 抓取 JSON（容器无外网出口时走出口代理） */
async function fetchViaFirecrawl(url: string): Promise<MarketQuote | null> {
  const entry = parseSecidFromUrl(url);
  if (!entry) return null;
  const fcBase = ENV.FIRECRAWL_URL.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
  try {
    const res = await fetch(`${fcBase}/v2/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['rawHtml'] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const d: any = await res.json().catch(() => null);
    if (!d?.success) return null;
    const raw = d?.data?.rawHtml || d?.rawHtml || '';
    if (!raw) return null;
    const parsed: any = JSON.parse(raw);
    return parseQuote(parsed, entry);
  } catch { return null; } finally { clearTimeout(timer); }
}

/** 从 push2 URL 解析出对应的 INDEX_MAP 条目 */
function parseSecidFromUrl(url: string): { name: string; code: string } | null {
  const m = url.match(/secid=([01])\.(\d{6})/);
  if (!m) return null;
  const secid = `${m[1]}.${m[2]}`;
  for (const [code, entry] of Object.entries(INDEX_MAP)) {
    if (entry.secid === secid) return { name: entry.name, code };
  }
  return null;
}

/** 解析东财 push2 响应为 MarketQuote */
function parseQuote(d: any, entry: { name: string; code: string }): MarketQuote | null {
  const data = d?.data;
  if (!data || data.f43 === undefined || data.f43 === null) return null;
  // fltt=2 时字段已是浮点（未乘 100），如 {"f43":3673.56,"f170":-0.46}
  const val = (k: string) => Number(data[k] ?? 0);
  return {
    name: entry.name,
    code: entry.code,
    price: val('f43'),
    changePct: val('f170'),
    open: val('f46'),
    high: val('f44'),
    low: val('f45'),
    prevClose: val('f60'),
    timestamp: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  };
}

/** 行情直查入口：判定 + 取数 + 格式化。返回 null 表示不是行情问题或取数失败。 */
export async function tryMarketDirect(question: string): Promise<{ name: string; text: string } | null> {
  const code = extractIndexCode(question);
  if (!code) return null;
  const q = await fetchIndexQuote(code);
  if (!q) return null;
  return { name: q.name, text: formatQuote(q, question) };
}

/** 期货/基差直查入口：取现货 + 各期限期货合约 → 算基差/基差率/年化基差率 → 表格输出。
 *  返回 null 表示不是基差类问题、无法提取指数代码、或取数失败。 */
export async function tryFuturesBasisDirect(question: string): Promise<{ name: string; text: string } | null> {
  const code = extractFuturesIndexCode(question);
  if (!code) return null;
  const entry = FUTURES_MAP[code];
  if (!entry) return null;
  // 并发取现货 + 4 种期货合约
  const [spot, c1, c2, c3, c4] = await Promise.all([
    fetchIndexQuote(code),
    fetchFuturesQuote(entry.contracts['当月']!, '当月'),
    fetchFuturesQuote(entry.contracts['下月']!, '下月'),
    fetchFuturesQuote(entry.contracts['下季']!, '下季'),
    fetchFuturesQuote(entry.contracts['隔季']!, '隔季'),
  ]);
  if (!spot || !c1) return null; // 至少现货+当月有数据
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  // 基差 = 期货 − 现货（负=贴水，正=升水）；年化基差率 = 基差率 × 365 / 距到期自然日
  const lines: string[] = [
    `${entry.name}（${code}）期现基差 · 数据时间：${ts}（来源：东方财富 push2 接口）`,
    `现货：${spot.price.toFixed(2)} 点  ${spot.changePct >= 0 ? '+' : ''}${spot.changePct.toFixed(2)}%`,
    '',
    '| 合约 | 期货收盘 | 基差（点） | 基差率 | 含义 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [c, q] of [['当月', c1], ['下月', c2], ['下季', c3], ['隔季', c4]] as const) {
    if (!q) { lines.push(`| ${c} | - | - | - | - |`); continue; }
    const basis = q.price - spot.price;
    const basisRate = (basis / spot.price) * 100;
    const meaning = basis < 0 ? '贴水' : basis > 0 ? '升水' : '平价';
    lines.push(`| ${c} | ${q.price.toFixed(2)} | ${basis >= 0 ? '+' : ''}${basis.toFixed(2)} | ${basisRate >= 0 ? '+' : ''}${basisRate.toFixed(2)}% | ${meaning} |`);
  }
  lines.push('');
  lines.push('口径：基差 = 期货 − 现货（负=贴水，正=升水）。push2 返回最新快照；收盘后为收盘价，盘中为实时值。');
  lines.push('注：年化基差率需知道各合约到期日才能精确计算；上表为静态基差率，如需年化请指出具体到期月份。');
  return { name: `${entry.name} 基差`, text: lines.join('\n') };
}

/** 从问题中提取股指期货对应的现货指数代码（IF→沪深300, IH→上证50, IC→中证500, IM→中证1000） */
function extractFuturesIndexCode(question: string): string | null {
  const q = question.toUpperCase();
  // 期货品种代码 → 现货指数代码
  if (/\bIM\b/.test(q) || question.includes('中证1000')) return '000852';
  if (/\bIC\b/.test(q) || question.includes('中证500')) return '000905';
  if (/\bIF\b/.test(q) || question.includes('沪深300')) return '000300';
  if (/\bIH\b/.test(q) || question.includes('上证50')) return '000016';
  return null;
}

/** 取期货合约快照（通用 secid 格式 8.NNNNNN） */
async function fetchFuturesQuote(secid: string, label: string): Promise<{ price: number; label: string } | null> {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f58&fltt=2`;
  // 直连
  const direct = await fetchFuturesRaw(url, secid);
  if (direct !== null) return { price: direct, label };
  // Firecrawl 备路
  if (ENV.FIRECRAWL_URL) {
    const relay = await fetchFuturesViaFirecrawl(url, secid);
    if (relay !== null) return { price: relay, label };
  }
  return null;
}

async function fetchFuturesRaw(url: string, _secid: string): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DIRECT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const d: any = await res.json().catch(() => null);
    const data = d?.data;
    if (!data || data.f43 === undefined || data.f43 === null) return null;
    return Number(data.f43);
  } catch { return null; } finally { clearTimeout(timer); }
}

async function fetchFuturesViaFirecrawl(url: string, _secid: string): Promise<number | null> {
  const fcBase = ENV.FIRECRAWL_URL.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
  try {
    const res = await fetch(`${fcBase}/v2/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['rawHtml'] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const d: any = await res.json().catch(() => null);
    if (!d?.success) return null;
    const raw = d?.data?.rawHtml || d?.rawHtml || '';
    if (!raw) return null;
    const parsed: any = JSON.parse(raw);
    const data = parsed?.data;
    if (!data || data.f43 === undefined || data.f43 === null) return null;
    return Number(data.f43);
  } catch { return null; } finally { clearTimeout(timer); }
}

/** 格式化行情快照为带日期+来源的文本（前端直查分支直接展示） */
function formatQuote(q: MarketQuote, question: string): string {
  const direction = q.changePct >= 0 ? '涨' : '跌';
  const abs = Math.abs(q.changePct).toFixed(2);
  const change = (q.price - q.prevClose).toFixed(2);
  const sign = q.changePct >= 0 ? '+' : '';
  return [
    `${q.name}（${q.code}）· 数据时间：${q.timestamp}（来源：东方财富 push2 接口）`,
    `最新/收盘：${q.price.toFixed(2)} 点  ${sign}${change}（${sign}${abs}% ${direction}）`,
    `今开：${q.open.toFixed(2)}  最高：${q.high.toFixed(2)}  最低：${q.low.toFixed(2)}  昨收：${q.prevClose.toFixed(2)}`,
    `注：push2 返回的是最新快照（含当日收盘字段）；若交易日已收盘则为收盘价，盘中则为实时值。`,
  ].join('\n');
}
