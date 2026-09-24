# **log-mcp 维护指南**

## **1. 项目简介**

`log-mcp` 是德科开发部门内部的 Elasticsearch 日志查询 MCP Server，通过标准 MCP 协议向 IDE/AI 助手暴露日志查询能力。

| 属性   | 说明                                      |
| ---- | --------------------------------------- |
| 包名   | `@derkee/log-mcp`                       |
| 协议   | MCP (Model Context Protocol) over stdio |
| 数据源  | 部门内部 Elasticsearch 集群                   |
| 目标用户 | 开发/运维人员，通过 Claude Code 等 MCP 客户端调用      |

***

## **2. 项目结构**

```plain&#x20;text
log-mcp/
├── src/
│   ├── index.js       # MCP Server 入口，注册所有 tools
│   └── es-client.js   # ES 客户端、索引构建、格式化、堆栈压缩
├── es-config.json     # 运行时配置（ES 地址、认证、服务列表）
├── package.json       # ESM 模块，依赖 @modelcontextprotocol/sdk + zod
└── .mcp.json          # MCP 客户端注册配置（如存在）
```

***

## **3. 快速开始/安装**

### **3.1 配置 npm 指向内部私仓**

`log-mcp` 发布在部门内部 Nexus 私仓，地址：http://172.16.91.163:8081/repository/npm-hosted/

**配置镜像源**

```bash
npm config set "@derkee:registry" "http://172.16.91.163:8081/repository/npm-hosted/"
```

**逻辑**：npm 会发现 `@derkee` 开头的去你的私有仓库找

### **3.2 配置文件位置**

MCP 客户端（如 Claude Code、Cursor、Cline 等）通过 `.mcp.json` 或 settings 文件发现和启动 Server。

| 客户端         | 配置文件路径                                              |
| ----------- | --------------------------------------------------- |
| Claude Code | 项目根目录 `.mcp.json` 或 `~/.claude/settings.local.json` |
| Cursor      | `~/.cursor/mcp.json`                                |
| Cline       | VS Code 插件设置中的 MCP Servers                          |

### **3.3 配置方式**

**npx 全局调用（推荐）**

```json
{
  "mcpServers": {
    "log-mcp": {
      "command": "npx",
      "args": ["-y", "@derkee/log-mcp"]
    }
  }
}
```

> `-y` 表示自动安装（如未全局安装），省去确认交互。

配置完一般需要重启 AGENT 生效

### **3.4 验证 MCP 注册**

重启完后，在 Claude Code 中输入：

```plain&#x20;text
/mcp
```

查看已注册的 Server 列表，确认 `log-mcp` 已加载，且 8 个工具（`list_services`、`query_log_summary`、`query_logs`、`query_log_by_id`、`trace_by_traceId` 等）正常显示。

***

### 3.5  验证

![](https://my.feishu.cn/space/api/box/stream/download/asynccode/?code=YTk3ZDYxZDc5NzhlN2RkNmJmMzlkZDJhZjkyMTg2ZDVfejlhZVE1ZmdmYkdoQVF4N3NlZEVUeUJtYXdRWGlIZXhfVG9rZW46RzFsVmIzSURTbzR1bUp4dUo3M2NxcEt3bnVlXzE3NzkxNTg4MjQ6MTc3OTE2MjQyNF9WNA)

## **4. 本地开发维护**

### **4.1 安装依赖**

```bash
npm install
```

### **4.2 配置**

编辑 `es-config.json`：

```json
{
  // Elasticsearch 集群地址，必须带协议头
  "esHost": "https://es.derkee.com",
  // ES API Key（Base64 编码），优先于 username/password
  "apiKey": "b0VzUE9wNEJwT0d0OU9vRDVVZlg6T2lyamdXWmlUNVc1S2dpZF9SSVhzdw==",
  // 索引前缀，最终索引名格式为 {prefix}-{service}-logs-{YYYY.MM.dd}
  "indexPrefix": "springcloud",
  // 已接入日志收集的微服务白名单，供 list_services 展示及索引通配查询使用
  "services": [
    "admin", "audit", "auth", "business", "crm",
    "personnel", "presence", "report", "sys_file", "wechat"
  ]
}
```

### **4.3 本地调试**

```bash
npm start
# 或
node src/index.js
```

Server 通过 **stdio** 与 MCP 客户端通信，无需监听端口。

***

## **5. 核心模块**

### **5.1\`src/index.js\` — MCP Server 入口**

基于 `@modelcontextprotocol/sdk` 的 `McpServer`，注册 8 个工具：

| Tool                | 功能                                      | 典型场景           |
| ------------------- | --------------------------------------- | -------------- |
| `list_services`     | 列出已接入日志的所有微服务                           | 用户不确定服务名时      |
| `list_indices`      | 查看某天可用的日志索引                             | 排查索引缺失问题       |
| `query_log_summary` | **【推荐优先使用】**日志统计摘要：级别分布、服务分布、ERROR 样本 | 先快速判断是否有值得细查的内容 |
| `query_logs`        | 通用组合查询，返回全量日志列表                        | 按条件自由检索        |
| `query_log_by_id`   | 根据日志 ID 精确查询，支持单个或多个逗号分隔的 ID        | 已知 ID 反查详情      |
| `trace_by_traceId`  | 按 traceId 追踪完整分布式链路                       | 链路追踪、定位跨服务 Bug |
| `search_by_keyword` | 全文关键字搜索                                 | 模糊搜索异常信息       |
| `count_errors`      | 统计指定时间段各服务的 ERROR 数量                    | 日报、异常趋势        |

**时间参数统一**：所有日志查询工具均支持 `startDate` + `endDate`（日期范围，**北京时间**，格式 `YYYY.MM.dd`）与 `timeRange`（最近 N 分钟/小时）两种互斥方式，都不填则默认查询最近 **30 分钟**。返回结果头部会展示实际查询的时间段。

**索引选择**：只要指定了 `startDate` / `endDate`，统一走通配符索引（如 `springcloud-*-logs-*`）。因为 ELK/Logstash 默认按 **UTC** 滚动索引，一个本地日期可能对应前后两个 UTC 日期；精确到单日容易漏查。实际过滤由 `@timestamp` range 查询完成，不会返回其他日期的数据。

所有工具参数均使用 **Zod** 做运行时校验，缺少必填参数时 MCP 客户端会自动提示。

### **5.2\`src/es-client.js\` — ES 交互与格式化**

| 导出项                                  | 说明                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `buildIndex(service?, date?)`        | 构建索引名，`service` 和 `date` 均可省略（通配）                                               |
| `buildTimeQuery({ timeRange?, startDate?, endDate?, service? })` | 统一处理时间参数：验证互斥、默认 30 分钟、生成 ES range filter 和时间段描述；日期范围统一使用通配符索引以避免 UTC 索引滚动导致的漏查 |
| `esGet(path)` / `esPost(path, body)` | 底层 HTTP 请求封装，自动附加认证头                                                            |
| `formatHit(hit)`                     | 将 ES `_source` 转换为内部结构化对象，含 **消息截断**（2000 字符）和 **堆栈压缩**                         |
| `formatSearchResponse(data, limit?)` | 将 ES 响应转换为可读文本                                                                  |
| `formatSummaryResponse(data)`        | 将 ES 聚合响应转换为统计摘要（级别分布、服务分布、ERROR 样本等）                                        |
| `compressStackTrace(stackTrace)`     | **堆栈压缩：**&#x8FC7;滤 Tomcat/Spring/Netty/JDK/Node 等框架内部帧，保留业务代码帧和 \`Caused by\` 行 |
| `DEFAULT_SOURCE_FIELDS`              | 默认 `_source` 字段列表，控制网络传输量                                                       |

## **6. 常见维护操作**

### **6.1 新增微服务**

在 `es-config.json` 的 `services` 数组中追加服务名，无需改代码。索引名会自动按 `{prefix}-{service}-logs-{date}` 生成。

### **6.2 调整返回字段**

修改 `DEFAULT_SOURCE_FIELDS`（`src/es-client.js:25`）。如果 ES 字段映射变更，同步更新此处。

### **6.3 增加堆栈过滤规则**

在 `src/es-client.js` 的 `FRAMEWORK_PATTERNS` 数组中追加正则，例如过滤公司内部的某个公共 SDK：

```json
/^at com\.derkee\.common\./,
```

### **6.4 修改输出格式**

调整 `formatSearchResponse` / `formatSummaryResponse` 中的拼接逻辑，或修改 `formatHit` 中的字段映射。单条日志的 **消息截断**（2000 字符）和 **堆栈压缩** 均收拢在 `formatHit` 中，避免各调用处重复处理。

***

## **7. 扩展开发**

### **7.1 新增工具**

在 `src/index.js` 中参照已有模式注册：

```javascript
server.tool(
  'tool_name',
  '工具描述，会展示给 AI 用户',
  {
    param1: z.string().describe('参数说明'),
    param2: z.number().optional().describe('可选参数'),
  },
  async ({ param1, param2 }) => {
    // 调用 esGet / esPost
    const data = await esPost(`/${index}/_search`, body);
    return {
      content: [{ type: 'text', text: formatSearchResponse(data) }],
    };
  }
);
```

### **7.2 发布新版本**

```bash
# 1. 更新版本号
npm version patch   # 或 minor / major

# 2. 发布到内部 registry
npm publish
```

`publishConfig.registry` 已指向 `http://172.16.91.163:8081/repository/npm-hosted/`。

***

