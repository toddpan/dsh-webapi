/**
 * @dsh-external/dsh-web-service - OpenAPI Spec & Built-in Interactive Web Docs
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServiceConfig } from './types.js'

export function registerOpenApiRoutes(router: any, config: WebServiceConfig): void {
  const prefix = config.pathPrefix || '/api/v1'

  // 1. OpenAPI 3.0.0 JSON 规范
  router.get('/openapi.json', (_req: IncomingMessage, res: ServerResponse) => {
    const spec = generateOpenApiSpec(prefix)
    const jsonStr = JSON.stringify(spec, null, 2)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(jsonStr)
  })

  // 2. 内置交互式 API 文档页面 (GET /docs)
  router.get('/docs', (_req: IncomingMessage, res: ServerResponse) => {
    const html = generateDocsHtml(prefix, config.apiKey ? true : false)
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(html)
  })
}

function generateOpenApiSpec(prefix: string) {
  return {
    openapi: '3.0.0',
    info: {
      title: 'DeepSeek Harness (DSH) Web Service API',
      version: '1.0.0',
      description: '提供给第三方系统调用的 DSH 全功能 Web Service API，支持工作区、会话生命周期、模型配置管理、SSE流式响应及OpenAI协议兼容。',
    },
    servers: [
      {
        url: prefix,
        description: 'DSH Web Service Endpoint',
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT / API-Key',
        },
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        },
      },
    },
    paths: {
      '/workspaces': {
        get: {
          summary: '查询工作区列表',
          tags: ['Workspaces'],
          responses: {
            200: { description: '工作区列表' },
          },
        },
        post: {
          summary: '添加工作区',
          tags: ['Workspaces'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['path'],
                  properties: {
                    path: { type: 'string', description: '本地目录路径' },
                    title: { type: 'string', description: '工作区自定义标题' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: '工作区创建成功' } },
        },
      },
      '/workspaces/{id}': {
        get: {
          summary: '查询指定工作区详情',
          tags: ['Workspaces'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: '工作区详情' }, 404: { description: '工作区不存在' } },
        },
        put: {
          summary: '修改工作区',
          tags: ['Workspaces'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title'],
                  properties: {
                    title: { type: 'string', description: '新工作区标题' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '更新成功' } },
        },
        delete: {
          summary: '删除工作区',
          tags: ['Workspaces'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: '删除成功' } },
        },
      },
      '/sessions': {
        get: {
          summary: '查询会话列表',
          tags: ['Sessions'],
          parameters: [
            { name: 'search', in: 'query', schema: { type: 'string' }, description: '关键词搜索' },
            { name: 'workspaceId', in: 'query', schema: { type: 'string' }, description: '按工作区过滤' },
          ],
          responses: { 200: { description: '会话列表' } },
        },
        post: {
          summary: '添加会话',
          tags: ['Sessions'],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workspaceId: { type: 'string', description: '关联的工作区ID' },
                    title: { type: 'string', description: '会话标题' },
                    provider: { type: 'string', description: '指定模型提供方' },
                    model: { type: 'string', description: '指定模型ID' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: '会话创建成功' } },
        },
      },
      '/sessions/{id}': {
        get: {
          summary: '查询单个会话',
          tags: ['Sessions'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: '会话详情' } },
        },
        put: {
          summary: '修改会话 (标题/模型)',
          tags: ['Sessions'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', description: '新标题' },
                    provider: { type: 'string', description: '模型提供方' },
                    model: { type: 'string', description: '模型名称' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '更新成功' } },
        },
        delete: {
          summary: '删除/归档会话',
          tags: ['Sessions'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: '删除/归档成功' } },
        },
      },
      '/sessions/{id}/history': {
        get: {
          summary: '查询会话历史消息 (分页)',
          tags: ['Sessions'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'maxMessages', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'beforeSeq', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: '历史消息分页列表' } },
        },
      },
      '/sessions/{id}/prompt-stream': {
        post: {
          summary: '会话流式对话 (SSE)',
          description: '发送提示词并通过 Server-Sent Events (SSE) 接收实时的思考链、文本增量和工具调用。',
          tags: ['Streaming'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['prompt'],
                  properties: {
                    prompt: { type: 'string', description: '发送的提示词内容' },
                    mode: { type: 'string', enum: ['normal', 'steer'], default: 'normal' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'SSE 事件流 (event: delta, reasoning, tool_call, done)',
              content: { 'text/event-stream': {} },
            },
          },
        },
      },
      '/sessions/{id}/events': {
        get: {
          summary: '会话全局事件订阅 (SSE)',
          tags: ['Streaming'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'SSE 会话事件流' } },
        },
      },
      '/sessions/{id}/files': {
        get: {
          summary: '列出会话工作区目录',
          description: '列出该会话 cwd（或 ?path= 指定的相对子目录）下的条目，目录在前、按名称排序；?path= 逐层浏览。',
          tags: ['Sessions'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'path', in: 'query', required: false, schema: { type: 'string' }, description: '相对会话工作区的子目录，默认根目录' },
          ],
          responses: {
            200: {
              description: '目录条目列表（name/type/size/mtime/path）',
              content: { 'application/json': {} },
            },
            400: { description: '路径越界或指向文件' },
            404: { description: '会话不存在或目录不存在' },
          },
        },
        post: {
          summary: '上传文件到会话工作区',
          description: '支持 multipart/form-data（多文件字段）或原始字节流（文件名取 ?filename= 或 X-Filename 头）。文件写入该会话的 cwd，同名自动追加 -1/-2 后缀，永不覆盖；返回的 path 可直接告知会话 AI 用文件工具读取。',
          tags: ['Sessions'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'filename', in: 'query', required: false, schema: { type: 'string' }, description: '原始字节流上传时的文件名' },
          ],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    files: { type: 'array', items: { type: 'string', format: 'binary' }, description: '一个或多个文件字段（字段名任意，带 filename 即保存）' },
                  },
                },
              },
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary', description: '原始字节流，配合 ?filename= 使用' },
              },
            },
          },
          responses: {
            200: {
              description: '保存结果（含落盘绝对路径）',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          sessionId: { type: 'string' },
                          cwd: { type: 'string' },
                          count: { type: 'integer' },
                          totalBytes: { type: 'integer' },
                          files: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                name: { type: 'string' },
                                path: { type: 'string' },
                                size: { type: 'integer' },
                                mimeType: { type: 'string' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: { description: '请求体为空或 multipart 中无文件字段' },
            404: { description: '会话不存在或无工作目录' },
            413: { description: '超过 maxUploadBytes 上限' },
          },
        },
      },
      '/sessions/{id}/files/download': {
        get: {
          summary: '下载会话工作区文件',
          description: '按相对路径下载 cwd 内的文件；?inline=1 时以 Content-Disposition: inline 返回（配合正确 MIME 可浏览器内预览）。禁止越出会话工作区。',
          tags: ['Sessions'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: '相对会话工作区的文件路径' },
            { name: 'inline', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1'] }, description: '1 = 内联预览（不触发下载）' },
          ],
          responses: {
            200: { description: '文件字节流', content: { '*/*': { schema: { type: 'string', format: 'binary' } } } },
            400: { description: '缺少 path / 路径越界 / 指向目录' },
            404: { description: '会话或文件不存在' },
          },
        },
      },
      '/models': {
        get: {
          summary: '查询可用模型列表',
          tags: ['Models & Settings'],
          responses: { 200: { description: '模型目录' } },
        },
      },
      '/models/default': {
        get: {
          summary: '获取全局默认模型配置',
          tags: ['Models & Settings'],
          responses: { 200: { description: '默认模型' } },
        },
        put: {
          summary: '修改全局默认模型配置',
          tags: ['Models & Settings'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['provider', 'model'],
                  properties: {
                    provider: { type: 'string' },
                    model: { type: 'string' },
                    reasoningEffort: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '配置更新成功' } },
        },
      },
      '/chat/completions': {
        post: {
          summary: 'OpenAI 兼容对话补全接口',
          description: '支持任何标准 OpenAI 客户端库（支持 stream: true/false）。',
          tags: ['OpenAI Compatibility'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['messages'],
                  properties: {
                    model: { type: 'string' },
                    messages: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          role: { type: 'string' },
                          content: { type: 'string' },
                        },
                      },
                    },
                    stream: { type: 'boolean', default: false },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'OpenAI 格式回复' } },
        },
      },
      '/skills': {
        get: {
          summary: '查询技能列表（管理视图）',
          description: '列出指定技能根目录下的全部技能（含 root/path/是否可模型/用户调用）。?root=user-dsh|user-agents|custom|project|bundled&cwd=&search=',
          tags: ['Skills'],
          parameters: [
            { name: 'root', in: 'query', schema: { type: 'string', enum: ['user-dsh', 'user-agents', 'custom', 'project', 'bundled'] }, description: '技能根，默认 user-dsh' },
            { name: 'cwd', in: 'query', schema: { type: 'string' }, description: 'root=project 时定位项目 .agents/.dsh/skills' },
            { name: 'search', in: 'query', schema: { type: 'string' }, description: '按 name/description 模糊搜索' },
          ],
          responses: { 200: { description: '技能列表' } },
        },
        post: {
          summary: '上传/创建技能',
          description: 'multipart（file=技能压缩包 .zip/.tgz，字段 root、name）或 JSON（name/description/whenToUse/content）。压缩包兼容 <name>/SKILL.md 目录或单独包装目录。',
          tags: ['Skills'],
          parameters: [
            { name: 'root', in: 'query', schema: { type: 'string' }, description: '技能根，默认 user-dsh' },
            { name: 'cwd', in: 'query', schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, root: { type: 'string' }, name: { type: 'string' } } },
              },
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'description'],
                  properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    whenToUse: { type: 'string' },
                    content: { type: 'string' },
                    root: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '技能落盘成功' }, 400: { description: '参数/解压失败' }, 413: { description: '超上传上限' } },
        },
      },
      '/skills/{name}': {
        get: {
          summary: '查询单技能详情（含全文）',
          tags: ['Skills'],
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'root', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: '技能详情（content=正文，raw=全文）' } },
        },
        put: {
          summary: '更新技能元数据/正文',
          tags: ['Skills'],
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { description: { type: 'string' }, whenToUse: { type: 'string' }, content: { type: 'string' }, modelInvocable: { type: 'boolean' }, userInvocable: { type: 'boolean' } },
                },
              },
            },
          },
          responses: { 200: { description: '更新成功' } },
        },
        delete: {
          summary: '删除技能',
          tags: ['Skills'],
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'root', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: '删除成功' } },
        },
      },
      '/skills/{name}/body': {
        get: {
          summary: '下载/预览 SKILL.md 全文',
          tags: ['Skills'],
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'root', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'text/markdown 全文' } },
        },
      },
      '/skills/{name}/archive': {
        get: {
          summary: '下载整个技能目录归档 (.tgz)',
          description: '含 SKILL.md 及 references/ 等资源，便于在不同 DSH 节点间迁移。',
          tags: ['Skills'],
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'root', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'application/gzip 归档' } },
        },
      },
    },
  }
}

function generateDocsHtml(prefix: string, requireAuth: boolean): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH Web Service API 交互式文档</title>
  <style>
    :root {
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --tag-get: #10b981;
      --tag-post: #3b82f6;
      --tag-put: #f59e0b;
      --tag-delete: #ef4444;
      --code-bg: #090d16;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5; }
    .container { max-width: 1100px; margin: 0 auto; }
    header { margin-bottom: 28px; border-bottom: 1px solid var(--border); padding-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-end; }
    h1 { font-size: 26px; font-weight: 700; color: #60a5fa; }
    .subtitle { color: var(--text-muted); font-size: 14px; margin-top: 6px; }
    .auth-box { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; display: flex; gap: 12px; align-items: center; margin-bottom: 24px; }
    .auth-box input { flex: 1; background: var(--code-bg); border: 1px solid var(--border); color: #fff; padding: 8px 12px; border-radius: 6px; font-size: 14px; }
    .btn { background: var(--primary); color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 14px; transition: background 0.2s; }
    .btn:hover { background: var(--primary-hover); }
    .section-title { font-size: 18px; margin: 28px 0 14px; color: #e2e8f0; display: flex; align-items: center; gap: 8px; }
    .api-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 14px; overflow: hidden; }
    .api-header { padding: 12px 16px; display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; }
    .method { font-weight: 700; font-size: 13px; padding: 4px 8px; border-radius: 4px; color: #fff; min-width: 60px; text-align: center; }
    .method.get { background: var(--tag-get); }
    .method.post { background: var(--tag-post); }
    .method.put { background: var(--tag-put); }
    .method.delete { background: var(--tag-delete); }
    .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; font-weight: 600; color: #e2e8f0; }
    .desc { color: var(--text-muted); font-size: 13px; margin-left: auto; }
    .api-body { padding: 16px; border-top: 1px solid var(--border); background: rgba(15, 23, 42, 0.5); display: none; }
    .api-card.open .api-body { display: block; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
    textarea, input[type="text"] { width: 100%; background: var(--code-bg); border: 1px solid var(--border); color: #fff; padding: 8px 12px; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 13px; }
    .test-actions { display: flex; gap: 12px; margin-top: 14px; }
    .response-box { margin-top: 14px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-family: ui-monospace, monospace; font-size: 13px; max-height: 280px; overflow-y: auto; white-space: pre-wrap; color: #38bdf8; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>DeepSeek Harness Web Service API</h1>
        <div class="subtitle">三方调用专属接口平台 &bull; 基础前缀: <code>${prefix}</code></div>
      </div>
      <div>
        <a href="${prefix}/openapi.json" target="_blank" class="btn" style="text-decoration:none;">查看 OpenAPI JSON</a>
      </div>
    </header>

    <div class="auth-box">
      <span style="font-size: 14px; font-weight: 600;">API Key 鉴权：</span>
      <input type="password" id="apiKeyInput" placeholder="${requireAuth ? '请输入配置的 Bearer Token' : '当前未开启强制鉴权，可留空'}">
      <button class="btn" onclick="saveApiKey()">保存凭据</button>
    </div>

    <!-- 1. 工作区管理 -->
    <div class="section-title">&#x1F4C2; 1. 工作区管理 (Workspaces)</div>

    <div class="api-card">
      <div class="api-header" onclick="toggleCard(this)">
        <span class="method get">GET</span>
        <span class="path">${prefix}/workspaces</span>
        <span class="desc">查询所有工作区</span>
      </div>
      <div class="api-body">
        <div class="test-actions">
          <button class="btn" onclick="sendReq('${prefix}/workspaces', 'GET', null, this)">发起测试</button>
        </div>
        <div class="response-box" style="display:none;"></div>
      </div>
    </div>

    <div class="api-card">
      <div class="api-header" onclick="toggleCard(this)">
        <span class="method post">POST</span>
        <span class="path">${prefix}/workspaces</span>
        <span class="desc">添加新工作区</span>
      </div>
      <div class="api-body">
        <div class="form-group">
          <label>请求参数 (JSON)</label>
          <textarea rows="3" class="req-body">{\n  "path": "/Users/tsbj/feyanggit/DHS-test",\n  "title": "测试工作区"\n}</textarea>
        </div>
        <div class="test-actions">
          <button class="btn" onclick="sendReq('${prefix}/workspaces', 'POST', this.parentElement.previousElementSibling.querySelector('textarea').value, this)">发起测试</button>
        </div>
        <div class="response-box" style="display:none;"></div>
      </div>
    </div>

    <!-- 2. 会话管理 -->
    <div class="section-title">&#x1F4AC; 2. 会话管理 (Sessions)</div>

    <div class="api-card">
      <div class="api-header" onclick="toggleCard(this)">
        <span class="method get">GET</span>
        <span class="path">${prefix}/sessions</span>
        <span class="desc">查询会话列表</span>
      </div>
      <div class="api-body">
        <div class="test-actions">
          <button class="btn" onclick="sendReq('${prefix}/sessions', 'GET', null, this)">发起测试</button>
        </div>
        <div class="response-box" style="display:none;"></div>
      </div>
    </div>

    <div class="api-card">
      <div class="api-header" onclick="toggleCard(this)">
        <span class="method post">POST</span>
        <span class="path">${prefix}/sessions</span>
        <span class="desc">创建新会话</span>
      </div>
      <div class="api-body">
        <div class="form-group">
          <label>请求参数 (JSON)</label>
          <textarea rows="3" class="req-body">{\n  "title": "新建外部会话"\n}</textarea>
        </div>
        <div class="test-actions">
          <button class="btn" onclick="sendReq('${prefix}/sessions', 'POST', this.parentElement.previousElementSibling.querySelector('textarea').value, this)">发起测试</button>
        </div>
        <div class="response-box" style="display:none;"></div>
      </div>
    </div>

    <!-- 3. 模型与设置 -->
    <div class="section-title">&#x2699;&#xFE0F; 3. 模型与设置管理 (Models & Settings)</div>

    <div class="api-card">
      <div class="api-header" onclick="toggleCard(this)">
        <span class="method get">GET</span>
        <span class="path">${prefix}/models</span>
        <span class="desc">查询所有可用模型</span>
      </div>
      <div class="api-body">
        <div class="test-actions">
          <button class="btn" onclick="sendReq('${prefix}/models', 'GET', null, this)">发起测试</button>
        </div>
        <div class="response-box" style="display:none;"></div>
      </div>
    </div>

    <div class="api-card">
      <div class="api-header" onclick="toggleCard(this)">
        <span class="method get">GET</span>
        <span class="path">${prefix}/models/default</span>
        <span class="desc">查询默认模型配置</span>
      </div>
      <div class="api-body">
        <div class="test-actions">
          <button class="btn" onclick="sendReq('${prefix}/models/default', 'GET', null, this)">发起测试</button>
        </div>
        <div class="response-box" style="display:none;"></div>
      </div>
    </div>

    <!-- 4. 会话流式接口 -->
    <div class="section-title">&#x26A1; 4. 会话流式接口 (Streaming)</div>

    <div class="api-card">
      <div class="api-header" onclick="toggleCard(this)">
        <span class="method post">POST</span>
        <span class="path">${prefix}/sessions/:id/prompt-stream</span>
        <span class="desc">SSE 实时流式交互对话</span>
      </div>
      <div class="api-body">
        <div class="form-group">
          <label>会话 ID</label>
          <input type="text" class="stream-sid" placeholder="输入已有 sessionId">
        </div>
        <div class="form-group">
          <label>Prompt 内容</label>
          <textarea rows="2" class="stream-prompt">你好，请告诉我 1+1 等于几？</textarea>
        </div>
        <div class="test-actions">
          <button class="btn" onclick="testStream(this)">启动 SSE 流式测试</button>
        </div>
        <div class="response-box" style="display:none;"></div>
      </div>
    </div>

    <!-- 5. OpenAI 兼容协议 -->
    <div class="section-title">&#x1F916; 5. OpenAI 协议兼容接口 (Chat Completions)</div>

    <div class="api-card">
      <div class="api-header" onclick="toggleCard(this)">
        <span class="method post">POST</span>
        <span class="path">${prefix}/chat/completions</span>
        <span class="desc">OpenAI 协议兼容对话接口</span>
      </div>
      <div class="api-body">
        <div class="form-group">
          <label>请求体 (JSON)</label>
          <textarea rows="6" class="req-body">{\n  "messages": [\n    { "role": "user", "content": "你好，请写一首五言绝句" }\n  ],\n  "stream": false\n}</textarea>
        </div>
        <div class="test-actions">
          <button class="btn" onclick="sendReq('${prefix}/chat/completions', 'POST', this.parentElement.previousElementSibling.querySelector('textarea').value, this)">发起测试</button>
        </div>
        <div class="response-box" style="display:none;"></div>
      </div>
    </div>

  </div>

  <script>
    function toggleCard(header) {
      header.parentElement.classList.toggle('open');
    }

    function saveApiKey() {
      const key = document.getElementById('apiKeyInput').value.trim();
      localStorage.setItem('dsh_api_key', key);
      alert('凭据已保存至浏览器本地缓存！');
    }

    window.onload = () => {
      const saved = localStorage.getItem('dsh_api_key');
      if (saved) document.getElementById('apiKeyInput').value = saved;
    };

    async function sendReq(url, method, body, btn) {
      const box = btn.parentElement.nextElementSibling;
      box.style.display = 'block';
      box.textContent = '请求中...';
      const key = document.getElementById('apiKeyInput').value.trim();
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers['Authorization'] = 'Bearer ' + key;

      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body ? body : undefined
        });
        const json = await res.json();
        box.textContent = JSON.stringify(json, null, 2);
      } catch (err) {
        box.textContent = '错误: ' + err.message;
      }
    }

    async function testStream(btn) {
      const card = btn.closest('.api-body');
      const sid = card.querySelector('.stream-sid').value.trim();
      const prompt = card.querySelector('.stream-prompt').value.trim();
      const box = btn.parentElement.nextElementSibling;
      if (!sid) {
        alert('请先输入会话 ID！');
        return;
      }
      box.style.display = 'block';
      box.textContent = '正在连接 SSE 流式服务...\n';

      const key = document.getElementById('apiKeyInput').value.trim();
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers['Authorization'] = 'Bearer ' + key;

      try {
        const res = await fetch('${prefix}/sessions/' + sid + '/prompt-stream', {
          method: 'POST',
          headers,
          body: JSON.stringify({ prompt })
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          box.textContent += chunk;
          box.scrollTop = box.scrollHeight;
        }
      } catch (err) {
        box.textContent += '\\n流连接错误: ' + err.message;
      }
    }
  </script>
</body>
</html>`
}
