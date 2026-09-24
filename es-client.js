import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config
function loadConfig() {
  const configPath = join(__dirname, '..', 'es-config.json');
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

const config = loadConfig();

/**
 * Build Elasticsearch index name(s) from service name and optional date.
 * @param {string} [service] - Service name, e.g. "personnel"
 * @param {string} [date] - Date in YYYY.MM.dd format
 * @returns {string} Index pattern, e.g. "springcloud-personnel-logs-2026.05.15" or "springcloud-*-logs-2026.05.15"
 */
/**
 * 默认只返回的字段列表，减少网络传输。
 */
export const DEFAULT_SOURCE_FIELDS = [
  '_id',
  '@timestamp',
  'level',
  'application',
  'message',
  'msg',
  'traceId',
  'logger_name',
  'logger',
  'stack_trace',
];

export function buildIndex(service, date) {
  const prefix = config.indexPrefix;
  const servicePart = service ? service : '*';
  const datePart = date ? `-${date}` : '-*';
  return `${prefix}-${servicePart}-logs${datePart}`;
}

const TIME_RANGE_LABELS = {
  '5m': '5 分钟',
  '15m': '15 分钟',
  '30m': '30 分钟',
  '1h': '1 小时',
  '3h': '3 小时',
  '6h': '6 小时',
  '12h': '12 小时',
  '1d': '1 天',
};

/**
 * Parse time range params and build ES query filter + index + description.
 * Rules:
 *   - timeRange and startDate/endDate are mutually exclusive.
 *   - If neither is provided, defaults to timeRange='30m'.
 */
export function buildTimeQuery({ timeRange, startDate, endDate, service }) {
  const hasTimeRange = !!timeRange;
  const hasDateRange = !!startDate || !!endDate;

  if (hasTimeRange && hasDateRange) {
    throw new Error('timeRange 与 startDate/endDate 互斥，不能同时指定');
  }

  let effectiveTimeRange = timeRange;
  if (!hasTimeRange && !hasDateRange) {
    effectiveTimeRange = '30m';
  }

  let timeFilter;
  let timeDesc;

  if (effectiveTimeRange) {
    timeFilter = {
      range: {
        '@timestamp': {
          gte: `now-${effectiveTimeRange}`,
          lte: 'now',
        },
      },
    };
    timeDesc = `最近 ${TIME_RANGE_LABELS[effectiveTimeRange] || effectiveTimeRange}`;
  } else {
    // 用户输入的 startDate/endDate 是北京时间（UTC+8），需转为 UTC 后再查 ES
    const toUtcIso = (dateStr, isEnd) => {
      const localIso = `${dateStr.replace(/\./g, '-')}${isEnd ? 'T23:59:59.999' : 'T00:00:00.000'}+08:00`;
      return new Date(localIso).toISOString();
    };

    const range = {};
    const start = startDate ? toUtcIso(startDate, false) : undefined;
    const end = endDate ? toUtcIso(endDate, true) : undefined;
    if (start) range.gte = start;
    if (end) range.lte = end;
    timeFilter = { range: { '@timestamp': range } };

    if (startDate && endDate) {
      timeDesc = startDate === endDate ? startDate : `${startDate} ~ ${endDate}`;
    } else if (startDate) {
      timeDesc = `${startDate} 及之后`;
    } else {
      timeDesc = `${endDate} 及之前`;
    }
  }

  // Use wildcard index for any date range. ELK rolls indices by UTC date,
  // so a single local date may map to two UTC days; wildcard avoids missing data.
  const index = buildIndex(service, undefined);

  return { timeFilter, timeDesc: `查询时间段: ${timeDesc}`, index };
}

/**
 * Build Authorization header.
 * Priority: API Key > Basic Auth
 */
function buildAuth() {
  if (config.apiKey) {
    return `ApiKey ${config.apiKey}`;
  }
  if (config.username && config.password) {
    return 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
  }
  return undefined;
}

const REQUEST_TIMEOUT_MS = 30000;

/**
 * Perform a GET request to ES.
 */
export async function esGet(path) {
  const url = `${config.esHost}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(buildAuth() ? { Authorization: buildAuth() } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ES GET ${path} failed: ${res.status} ${res.statusText}\n${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Perform a POST request to ES.
 */
export async function esPost(path, body) {
  const url = `${config.esHost}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(buildAuth() ? { Authorization: buildAuth() } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ES POST ${path} failed: ${res.status} ${res.statusText}\n${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convert an ISO 8601 UTC timestamp to Beijing time (UTC+8).
 * Returns the original string if parsing fails.
 */
function toBeijingTime(isoString) {
  if (!isoString || isoString === 'N/A') return 'N/A';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

/**
 * Format a single ES hit into a concise log record.
 */
export function formatHit(hit) {
  const s = hit._source;
  const ts = toBeijingTime(s['@timestamp']) || 'N/A';
  const level = s.level || 'UNKNOWN';
  const app = s.application || hit._index || 'unknown';
  const msg = s.message || s.msg || JSON.stringify(s);
  const traceId = s.traceId || '';
  const logger = s.logger_name || s.logger || '';
  const stackTrace = compressStackTrace(s.stack_trace || '');
  let message = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const MAX_MSG_LEN = 1000;
  if (message.length > MAX_MSG_LEN) {
    message = message.slice(0, MAX_MSG_LEN) + ` ...(截断, 共 ${message.length} 字符)`;
  }
  return {
    id: hit._id,
    timestamp: ts,
    level,
    application: app,
    message,
    traceId,
    logger,
    stackTrace,
    index: hit._index,
  };
}

/**
 * Format ES search response into a readable result string.
 */
export function formatSearchResponse(data, limit = 50) {
  if (!data.hits || !data.hits.hits) {
    return JSON.stringify(data, null, 2);
  }
  const total = typeof data.hits.total === 'number' ? data.hits.total : data.hits.total?.value || 0;
  const hits = data.hits.hits.map(formatHit);
  const lines = [
    `共找到 ${total} 条记录（展示前 ${Math.min(hits.length, limit)} 条）`,
    '---',
    ...hits.slice(0, limit).map((h) => {
      const traceInfo = h.traceId ? ` [traceId: ${h.traceId}]` : '';
      const stackInfo = h.stackTrace ? `\n${h.stackTrace}` : '';
      return `[${h.id}] [${h.timestamp}] [${h.level}] [${h.application}]${traceInfo}\n${h.message}${stackInfo}\n`;
    }),
  ];
  if (data.aggregations) {
    lines.push('---');
    lines.push('聚合结果:');
    lines.push(JSON.stringify(data.aggregations, null, 2));
  }
  return lines.join('\n');
}

// ─── Stack trace compression ───

const FRAMEWORK_PATTERNS = [
  // Java / Jakarta EE
  /^at org\.apache\.(catalina|coyote|tomcat)/,
  /^at org\.springframework\./,
  /^at org\.jboss\./,
  /^at io\.undertow\./,
  /^at reactor\./,
  /^at io\.projectreactor\./,
  /^at io\.netty\./,
  /^at com\.fasterxml\./,
  /^at org\.hibernate\./,
  /^at org\.mybatis\./,
  /^at com\.alibaba\.(druid|fastjson|nacos)/,
  /^at org\.(gradle|junit|testng|eclipse|intellij)/,
  /^at (java|javax|jdk|sun|com\.sun)\./,
  /^at sun\./,
  // Node.js
  /^at \(internal\//,
  /^at \(node:/,
  /^at Module\./,
  /^at Object\.Module\./,
  /^at Function\.Module\./,
];

const isFrameworkFrame = (line) => {
  const trimmed = line.trim();
  return trimmed.startsWith('at ') && FRAMEWORK_PATTERNS.some((p) => p.test(trimmed));
};

/**
 * Compress a stack trace by omitting framework-internal frames.
 * Keeps "Caused by", business code frames, and summarises omitted runs.
 */
function compressStackTrace(stackTrace) {
  if (!stackTrace) return '';
  const lines = stackTrace.split('\n');
  const result = [];
  let omittedCount = 0;

  for (const line of lines) {
    if (isFrameworkFrame(line)) {
      omittedCount++;
      continue;
    }
    if (omittedCount > 0) {
      result.push(`\t... ${omittedCount} common frames omitted`);
      omittedCount = 0;
    }
    result.push(line);
  }

  if (omittedCount > 0) {
    result.push(`\t... ${omittedCount} common frames omitted`);
  }

  return result.join('\n');
}

/**
 * Format ES aggregation response into a concise summary string.
 */
export function formatSummaryResponse(data) {
  if (!data.hits) {
    return JSON.stringify(data, null, 2);
  }

  const total = typeof data.hits.total === 'number' ? data.hits.total : data.hits.total?.value || 0;
  const aggs = data.aggregations || {};

  const lines = [];
  lines.push(`日志摘要（共 ${total} 条）`);
  lines.push('---');

  // 时间范围
  const minTime = toBeijingTime(aggs.min_time?.value_as_string);
  const maxTime = toBeijingTime(aggs.max_time?.value_as_string);
  if (minTime && maxTime) {
    lines.push(`时间范围: ${minTime} ~ ${maxTime}`);
    lines.push('');
  }

  // Level 分布
  const levelBuckets = aggs.by_level?.buckets || [];
  if (levelBuckets.length > 0) {
    lines.push('日志级别分布:');
    for (const b of levelBuckets) {
      const pct = total > 0 ? ((b.doc_count / total) * 100).toFixed(1) : '0.0';
      lines.push(`  - ${b.key}: ${b.doc_count} 条 (${pct}%)`);
    }
    lines.push('');
  }

  // Service 分布
  const serviceBuckets = aggs.by_service?.buckets || [];
  if (serviceBuckets.length > 0) {
    lines.push('服务分布:');
    for (const b of serviceBuckets) {
      const pct = total > 0 ? ((b.doc_count / total) * 100).toFixed(1) : '0.0';
      lines.push(`  - ${b.key}: ${b.doc_count} 条 (${pct}%)`);
    }
    lines.push('');
  }

  // Logger 分布
  const loggerBuckets = aggs.by_logger?.buckets || [];
  if (loggerBuckets.length > 0) {
    lines.push('高频 Logger（前 10）:');
    for (const b of loggerBuckets.slice(0, 10)) {
      lines.push(`  - ${b.key}: ${b.doc_count} 次`);
    }
    lines.push('');
  }

  // ERROR 样本去重
  const errorHits = aggs.error_samples?.recent?.hits?.hits || [];
  if (errorHits.length > 0) {
    const errorMap = new Map();
    for (const hit of errorHits) {
      const src = hit._source;
      const rawMsg = src.message || src.msg || 'N/A';
      const msg = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
      const key = msg.slice(0, 80);
      if (!errorMap.has(key)) {
        errorMap.set(key, {
          message: msg,
          count: 0,
          app: src.application || 'unknown',
          ts: src['@timestamp'] || '',
        });
      }
      const entry = errorMap.get(key);
      entry.count++;
      if (src['@timestamp'] && src['@timestamp'] > entry.ts) {
        entry.ts = src['@timestamp'];
        entry.app = src.application || entry.app;
      }
    }

    const errorCount = aggs.error_samples?.doc_count || errorHits.length;
    lines.push(`ERROR 日志样本（共 ${errorCount} 条，展示 ${errorMap.size} 种不同错误）:`);
    let idx = 1;
    for (const [key, entry] of errorMap) {
      const ts = entry.ts ? `[${toBeijingTime(entry.ts)}] ` : '';
      const truncatedMsg = entry.message.length > 200
        ? entry.message.slice(0, 200) + '...'
        : entry.message;
      lines.push(`  ${idx}. ${ts}[${entry.app}]`);
      lines.push(`     ${truncatedMsg}`);
      if (entry.count > 1) {
        lines.push(`     ↳ 相似错误出现 ${entry.count} 次`);
      }
      idx++;
    }
  }

  return lines.join('\n');
}

export { config };
