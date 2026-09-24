#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  config,
  buildIndex,
  buildTimeQuery,
  esGet,
  esPost,
  formatHit,
  formatSearchResponse,
  formatSummaryResponse,
  DEFAULT_SOURCE_FIELDS,
} from './es-client.js';

const server = new McpServer({
  name: 'log-mcp',
  version: '1.0.0',
});

// ─── Tool 1: list_services ───
server.tool(
  'list_services',
  '列出部门内部所有已接入日志收集的微服务名称',
  {},
  async () => {
    const services = config.services || [];
    const text = services.map((s) => `- ${s}`).join('\n');
    return {
      content: [{ type: 'text', text: `已接入日志的微服务（共 ${services.length} 个）:\n${text}` }],
    };
  }
);

// ─── Tool 2: list_indices ───
server.tool(
  'list_indices',
  '查看某一天所有可用的日志索引',
  {
    date: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .describe('日期，北京时间，格式 YYYY.MM.dd，如 2026.05.15'),
  },
  async ({ date }) => {
    const pattern = buildIndex(undefined, date);
    const data = await esGet(`/_cat/indices/${pattern}?v&s=index&format=json`);
    if (!Array.isArray(data) || data.length === 0) {
      return {
        content: [{ type: 'text', text: `未找到 ${date} 的日志索引` }],
      };
    }
    const lines = data.map(
      (idx) =>
        `- ${idx.index} (docs: ${idx['docs.count']}, size: ${idx['store.size']}, health: ${idx.health})`
    );
    return {
      content: [
        {
          type: 'text',
          text: `${date} 共有 ${data.length} 个索引:\n${lines.join('\n')}`,
        },
      ],
    };
  }
);

// ─── Tool 3: query_log_summary ───
server.tool(
  'query_log_summary',
  '【推荐优先使用】查询日志统计摘要：返回时间范围、级别分布、服务分布、高频 logger 及 ERROR 样本，不返回全量日志。用于先快速判断是否有值得细查的内容，再决定是否全量查询',
  {
    service: z
      .string()
      .optional()
      .describe('微服务名称，如 personnel、admin、auth 等，不传则查询所有服务'),
    startDate: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('开始日期，北京时间，格式 YYYY.MM.dd，与 endDate 一起构成日期范围'),
    endDate: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('结束日期，北京时间，格式 YYYY.MM.dd，与 startDate 一起构成日期范围'),
    level: z
      .enum(['INFO', 'ERROR', 'WARN', 'DEBUG'])
      .optional()
      .describe('日志级别过滤'),
    keyword: z
      .string()
      .optional()
      .describe('日志内容关键字（全文搜索）'),
    traceId: z
      .string()
      .optional()
      .describe('分布式链路追踪 ID，精确匹配'),
    logger: z
      .string()
      .optional()
      .describe('Java logger 类名，精确匹配'),
    timeRange: z
      .enum(['5m', '15m', '30m', '1h', '3h', '6h', '12h', '1d'])
      .optional()
      .describe('最近 N 分钟/小时的时间范围，与 startDate/endDate 互斥'),
  },
  async ({ service, startDate, endDate, level, keyword, traceId, logger, timeRange }) => {
    const { timeFilter, timeDesc, index } = buildTimeQuery({ timeRange, startDate, endDate, service });
    const must = [timeFilter];

    if (level) {
      must.push({ term: { level } });
    }
    if (keyword) {
      must.push({ match_phrase: { message: keyword } });
    }
    if (traceId) {
      must.push({ term: { traceId } });
    }
    if (logger) {
      must.push({ term: { logger_name: logger } });
    }

    const query = { bool: { must } };
    const body = {
      size: 0,
      query,
      aggs: {
        min_time: { min: { field: '@timestamp' } },
        max_time: { max: { field: '@timestamp' } },
        by_level: { terms: { field: 'level', size: 10 } },
        by_service: { terms: { field: 'application', size: 20 } },
        by_logger: { terms: { field: 'logger_name.keyword', size: 15 } },
        error_samples: {
          filter: { term: { level: 'ERROR' } },
          aggs: {
            recent: {
              top_hits: {
                size: 15,
                sort: [{ '@timestamp': 'desc' }],
                _source: ['message', 'msg', '@timestamp', 'application', 'logger_name'],
              },
            },
          },
        },
      },
    };

    const data = await esPost(`/${index}/_search?pretty`, body);
    return {
      content: [{ type: 'text', text: `${timeDesc}\n---\n${formatSummaryResponse(data)}` }],
    };
  }
);

// ─── Tool 4: query_logs ───
server.tool(
  'query_logs',
  '通用日志查询：返回全量日志列表。建议在使用 query_log_summary 发现异常后，再用此工具查看详情',
  {
    service: z
      .string()
      .optional()
      .describe('微服务名称，如 personnel、admin、auth 等，不传则查询所有服务'),
    startDate: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('开始日期，北京时间，格式 YYYY.MM.dd，与 endDate 一起构成日期范围'),
    endDate: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('结束日期，北京时间，格式 YYYY.MM.dd，与 startDate 一起构成日期范围'),
    level: z
      .enum(['INFO', 'ERROR', 'WARN', 'DEBUG'])
      .optional()
      .describe('日志级别过滤'),
    keyword: z
      .string()
      .optional()
      .describe('日志内容关键字（全文搜索）'),
    traceId: z
      .string()
      .optional()
      .describe('分布式链路追踪 ID，精确匹配'),
    logger: z
      .string()
      .optional()
      .describe('Java logger 类名，精确匹配'),
    timeRange: z
      .enum(['5m', '15m', '30m', '1h', '3h', '6h', '12h', '1d'])
      .optional()
      .describe('最近 N 分钟/小时的时间范围，与 startDate/endDate 互斥'),
    size: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe('返回条数，默认 10，最大 100'),
  },
  async ({ service, startDate, endDate, level, keyword, traceId, logger, timeRange, size }) => {
    const { timeFilter, timeDesc, index } = buildTimeQuery({ timeRange, startDate, endDate, service });
    const must = [timeFilter];

    if (level) {
      must.push({ term: { level } });
    }
    if (keyword) {
      must.push({ match_phrase: { message: keyword } });
    }
    if (traceId) {
      must.push({ term: { traceId } });
    }
    if (logger) {
      must.push({ term: { logger_name: logger } });
    }

    const query = { bool: { must } };
    const body = {
      size,
      sort: [{ '@timestamp': 'desc' }],
      query,
      _source: DEFAULT_SOURCE_FIELDS,
    };

    const data = await esPost(`/${index}/_search?pretty`, body);
    return {
      content: [{ type: 'text', text: `${timeDesc}\n---\n${formatSearchResponse(data, size)}` }],
    };
  }
);

// ─── Tool 5: query_log_by_id ───
server.tool(
  'query_log_by_id',
  '根据日志 ID 精确查询完整无裁剪的日志详情，支持单个或多个逗号分隔的 ID',
  {
    id: z.string().min(1).describe('日志 ID（Elasticsearch _id），多个用逗号分隔'),
    service: z.string().optional().describe('微服务名称，如知道可加速查询'),
    date: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('日期，北京时间 YYYY.MM.dd，如知道可加速查询'),
  },
  async ({ id, service, date }) => {
    const index = buildIndex(service, date);
    const idList = id.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const body = {
        size: idList.length,
        query: { ids: { values: idList } },
        _source: DEFAULT_SOURCE_FIELDS,
      };
      const data = await esPost(`/${index}/_search?pretty`, body);
      const hits = data.hits?.hits || [];
      if (hits.length === 0) {
        return {
          content: [{ type: 'text', text: `未找到 ID 为 ${id} 的日志` }],
        };
      }

      const foundIds = new Set(hits.map((h) => h._id));
      const missingIds = idList.filter((i) => !foundIds.has(i));

      const lines = hits.map((hit, idx) => {
        const formatted = formatHit(hit);
        const traceInfo = formatted.traceId ? ` [traceId: ${formatted.traceId}]` : '';
        const stackInfo = formatted.stackTrace ? `\n${formatted.stackTrace}` : '';
        return [
          `[${idx + 1}/${hits.length}]`,
          `Index: ${formatted.index}`,
          `Logger: ${formatted.logger}`,
          `[${formatted.id}] [${formatted.timestamp}] [${formatted.level}] [${formatted.application}]${traceInfo}`,
          `${formatted.message}${stackInfo}`,
        ].join('\n');
      });

      if (missingIds.length > 0) {
        lines.push(`\n以下 ID 未找到: ${missingIds.join(', ')}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n\n') }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `查询失败: ${err.message}` }],
      };
    }
  }
);

// ─── Tool 6: trace_by_traceId ───
server.tool(
  'trace_by_traceId',
  '按 traceId 追踪完整的分布式请求链路（跨所有服务）',
  {
    traceId: z.string().min(1).describe('分布式链路追踪 ID'),
    startDate: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('开始日期，北京时间，格式 YYYY.MM.dd，与 endDate 一起构成日期范围'),
    endDate: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('结束日期，北京时间，格式 YYYY.MM.dd，与 startDate 一起构成日期范围'),
    timeRange: z
      .enum(['5m', '15m', '30m', '1h', '3h', '6h', '12h', '1d'])
      .optional()
      .describe('最近 N 分钟/小时的时间范围，与 startDate/endDate 互斥'),
    size: z.number().min(1).max(500).default(100).describe('返回条数，默认 100'),
  },
  async ({ traceId, startDate, endDate, timeRange, size }) => {
    const { timeFilter, timeDesc, index } = buildTimeQuery({ timeRange, startDate, endDate });
    const body = {
      size,
      sort: [{ '@timestamp': 'asc' }],
      query: {
        bool: {
          must: [
            { term: { traceId } },
            timeFilter,
          ],
        },
      },
      _source: DEFAULT_SOURCE_FIELDS,
    };
    const data = await esPost(`/${index}/_search?pretty`, body);
    return {
      content: [{ type: 'text', text: `${timeDesc}\n---\n${formatSearchResponse(data, size)}` }],
    };
  }
);

// ─── Tool 7: search_by_keyword ───
server.tool(
  'search_by_keyword',
  '按关键字在日志内容中全文搜索',
  {
    keyword: z.string().min(1).describe('搜索关键字'),
    service: z.string().optional().describe('限定某个微服务，不传则搜索所有服务'),
    startDate: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('开始日期，北京时间，格式 YYYY.MM.dd，与 endDate 一起构成日期范围'),
    endDate: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('结束日期，北京时间，格式 YYYY.MM.dd，与 startDate 一起构成日期范围'),
    timeRange: z
      .enum(['5m', '15m', '30m', '1h', '3h', '6h', '12h', '1d'])
      .optional()
      .describe('最近 N 分钟/小时的时间范围，与 startDate/endDate 互斥'),
    size: z.number().min(1).max(200).default(10).describe('返回条数，默认 10，最大 200'),
  },
  async ({ keyword, service, startDate, endDate, timeRange, size }) => {
    const { timeFilter, timeDesc, index } = buildTimeQuery({ timeRange, startDate, endDate, service });
    const body = {
      size,
      sort: [{ '@timestamp': 'desc' }],
      query: {
        bool: {
          must: [
            { match_phrase: { message: keyword } },
            timeFilter,
          ],
        },
      },
      _source: DEFAULT_SOURCE_FIELDS,
    };
    const data = await esPost(`/${index}/_search?pretty`, body);
    return {
      content: [{ type: 'text', text: `${timeDesc}\n---\n${formatSearchResponse(data, size)}` }],
    };
  }
);

// ─── Tool 8: count_errors ───
server.tool(
  'count_errors',
  '统计指定时间段各微服务的 ERROR 日志数量',
  {
    startDate: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('开始日期，北京时间，格式 YYYY.MM.dd，与 endDate 一起构成日期范围'),
    endDate: z
      .string()
      .regex(/^\d{4}\.\d{2}\.\d{2}$/)
      .optional()
      .describe('结束日期，北京时间，格式 YYYY.MM.dd，与 startDate 一起构成日期范围'),
    timeRange: z
      .enum(['5m', '15m', '30m', '1h', '3h', '6h', '12h', '1d'])
      .optional()
      .describe('最近 N 分钟/小时的时间范围，与 startDate/endDate 互斥'),
  },
  async ({ startDate, endDate, timeRange }) => {
    const { timeFilter, timeDesc, index } = buildTimeQuery({ timeRange, startDate, endDate });
    const body = {
      size: 0,
      query: {
        bool: {
          must: [
            { term: { level: 'ERROR' } },
            timeFilter,
          ],
        },
      },
      aggs: {
        by_service: {
          terms: { field: 'application', size: 20 },
        },
      },
    };
    const data = await esPost(`/${index}/_search?pretty`, body);
    const buckets = data.aggregations?.by_service?.buckets || [];
    if (buckets.length === 0) {
      return {
        content: [{ type: 'text', text: `${timeDesc}\n---\n未发现 ERROR 日志` }],
      };
    }
    const total = buckets.reduce((sum, b) => sum + b.doc_count, 0);
    const lines = buckets.map(
      (b) => `- ${b.key}: ${b.doc_count} 条`
    );
    return {
      content: [
        {
          type: 'text',
          text: `${timeDesc}\n---\n各服务 ERROR 统计（共 ${total} 条）:\n${lines.join('\n')}`,
        },
      ],
    };
  }
);

// ─── Start server ───
const transport = new StdioServerTransport();
await server.connect(transport);
