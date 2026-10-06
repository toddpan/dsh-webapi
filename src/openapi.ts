/**
 * @dsh-external/dsh-web-service - OpenAPI Spec & Built-in Interactive Web Docs
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServiceConfig } from './types.js'
import { pluginVersion } from './version.js'

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
  }, { auth: 'public' })

  // 2. 内置交互式 API 文档页面 (GET /docs)
  router.get('/docs', (_req: IncomingMessage, res: ServerResponse) => {
    const html = generateDocsHtml(prefix, config.apiKey ? true : false)
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(html)
  }, { auth: 'public' })

  // 3. 在线接口文档（GET /docs/reference）：Redoc 渲染完整 OpenAPI，打开链接即可预览
  router.get('/docs/reference', (_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(generateReferenceHtml(prefix))
  }, { auth: 'public' })
}

function generateOpenApiSpec(prefix: string) {
  return {
    openapi: '3.0.0',
    info: {
      title: 'DeepSeek Harness (DSH) Web Service API',
      version: pluginVersion,
      description: '提供给第三方系统调用的 DSH 全功能 Web Service API，支持工作区、会话生命周期、模型配置管理、SSE流式响应及OpenAI协议兼容。',
    },
    servers: [
      {
        url: prefix,
        description: 'DSH Web Service Endpoint',
      },
    ],
    // 根级鉴权声明：Swagger UI 等调试工具据此渲染 Authorize 弹窗，鉴权后可对全部数据面接口在线试调；
    // 管理面接口各自声明的 AdminTokenAuth 会覆盖此默认值。
    security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
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
        AdminTokenAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Admin-Token',
          description: 'API Key 管理面令牌（也接受 Authorization: Bearer <admin-token>），与数据面 API Key 是两套凭证。',
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
      '/sessions/{id}/permission': {
        get: {
          summary: '查询会话运行权限 (sandbox + approval preset)',
          tags: ['Sessions'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: '{ preset, sandbox, approval, available[] }' }, 501: { description: '节点未装载 permissionPresets' } },
        },
        put: {
          summary: '切换会话运行权限（等价 /permission 命令，原生生效）',
          tags: ['Sessions'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['preset'],
                  properties: { preset: { type: 'string', description: 'danger-full-access / workspace-write（ask 为 workspace-write 别名）' } },
                },
              },
            },
          },
          responses: { 200: { description: '切换后的权限视图' }, 400: { description: '未知 preset' } },
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

      // ==================== API Key 管理（管理面，需 Admin Token） ====================
      '/api-keys': {
        get: {
          summary: '列出 API Key（脱敏）',
          description:
            '管理面接口：需携带 Admin Token（Authorization: Bearer / X-Admin-Token），默认仅允许回环地址访问。' +
            '响应只含前缀与掩码，绝不返回明文或哈希。',
          tags: ['API Keys'],
          security: [{ AdminTokenAuth: [] }],
          parameters: [
            { name: 'includeRevoked', in: 'query', schema: { type: 'string', enum: ['true', 'false'] }, description: '是否包含已吊销记录，默认 true' },
          ],
          responses: {
            200: { description: '脱敏 Key 列表' },
            401: { description: '缺少或错误的管理令牌' },
            403: { description: '跨源或非回环地址被拒绝' },
          },
        },
        post: {
          summary: '新建 API Key',
          description: '返回的 plaintext 是完整密钥，**仅此一次**出现在响应中，之后不可再取回。',
          tags: ['API Keys'],
          security: [{ AdminTokenAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', maxLength: 64, description: '名称，仅用于识别' },
                    note: { type: 'string', maxLength: 256, description: '备注' },
                    expiresInDays: { type: 'number', description: '多少天后过期；不传 = 永不过期' },
                    plaintext: {
                      type: 'string',
                      minLength: 16,
                      maxLength: 256,
                      pattern: '^[\\x21-\\x7e]+$',
                      description:
                        '自定义 Key 值（粘贴已有 Key）；不传则由服务端随机生成 256 位高熵 Key。' +
                        '只允许可见 ASCII、长度 16-256。自定义值只保存哈希，且不展示任何明文片段；' +
                        '若已有同值的**有效**记录会被拒绝（已吊销/已过期的值可重新登记）。',
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: '创建成功，含一次性明文 Key' },
            400: { description: '参数非法，或该 Key 值已有一条有效记录' },
            401: { description: '缺少或错误的管理令牌' },
            503: { description: '存储写入失败，本次没有产生 Key' },
          },
        },
      },
      '/api-keys/{id}': {
        patch: {
          summary: '修改名称 / 备注 / 过期时间',
          tags: ['API Keys'],
          security: [{ AdminTokenAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    note: { type: 'string' },
                    expiresAt: { type: 'number', nullable: true, description: 'epoch ms；传 null 清除过期时间' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '脱敏记录' },
            404: { description: 'Key 不存在，或来自插件配置不支持修改' },
          },
        },
        delete: {
          summary: '删除记录（仅限已吊销的 Key）',
          description:
            '从存储中永久移除一条**已吊销**的 managed Key 记录（清理审计残留）；' +
            '有效 Key、已过期未吊销的 Key 与插件配置遗留记录不可删除。',
          tags: ['API Keys'],
          security: [{ AdminTokenAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: '已删除' },
            404: { description: 'Key 不存在，或不是「已吊销」状态不可删除' },
            503: { description: '存储写入失败，记录仍保留' },
          },
        },
      },
      '/api-keys/{id}/rotate': {
        post: {
          summary: '轮换 Key（旧 Key 立即失效）',
          description: '旧记录标记为 revoked/rotated；新 Key 明文仅返回一次。',
          tags: ['API Keys'],
          security: [{ AdminTokenAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: '新 Key（含一次性明文）' },
            404: { description: 'Key 不存在，或来自插件配置不支持轮换' },
          },
        },
      },
      '/api-keys/{id}/revoke': {
        post: {
          summary: '吊销 Key（幂等，不可恢复）',
          tags: ['API Keys'],
          security: [{ AdminTokenAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: '已吊销' },
            404: { description: 'Key 不存在，或来自插件配置不支持吊销' },
          },
        },
      },
      '/api-keys/auth': {
        get: {
          summary: '查询鉴权状态',
          tags: ['API Keys'],
          security: [{ AdminTokenAuth: [] }],
          responses: { 200: { description: '鉴权开关、有效 Key 数、存储健康度' } },
        },
        put: {
          summary: '开启 / 关闭鉴权',
          description:
            '关闭鉴权必须传 confirm: "disable-auth"；插件配置中存在 apiKey 时鉴权被强制开启、不可关闭；' +
            '没有任何有效 Key 时不允许开启鉴权（避免把自己锁在外面）。',
          tags: ['API Keys'],
          security: [{ AdminTokenAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['enabled'],
                  properties: {
                    enabled: { type: 'boolean' },
                    confirm: { type: 'string', enum: ['disable-auth'] },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '已保存' },
            400: { description: '参数非法，或当前状态不允许该操作' },
          },
        },
      },
    },
  }
}

/** 项目主页（页头 GitHub 跳转按钮） */
const GITHUB_URL = 'https://github.com/toddpan/dsh-webapi'
/** 问题反馈（GitHub Issues） */
const ISSUES_URL = GITHUB_URL + '/issues'
/** GitHub Octicon 标志（fill=currentColor 随按钮变色） */
const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="flex:0 0 auto;"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>'
/** Octicon comment-16（问题反馈图标） */
const FEEDBACK_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="flex:0 0 auto;"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>'
/** Octicon sync-16（检查更新图标） */
const SYNC_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="flex:0 0 auto;"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>'

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
    .btn-ghost { background: transparent; color: var(--text); border: 1px solid var(--border); }
    .btn-ghost:hover { background: var(--card-bg); }
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
    .version-tag { font-size: 13px; font-weight: 500; color: var(--text-muted); background: var(--card-bg); border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; vertical-align: middle; margin-left: 8px; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    /* 检查更新弹层 */
    dialog { border: 1px solid var(--border); background: var(--card-bg); color: var(--text); border-radius: 8px; padding: 0; width: min(480px, calc(100vw - 32px)); box-shadow: 0 24px 64px rgba(0,0,0,.55); }
    dialog::backdrop { background: rgba(2,6,23,.72); }
    dialog .modal-head { padding: 16px 20px; border-bottom: 1px solid var(--border); font-size: 16px; font-weight: 600; }
    dialog .modal-body { padding: 20px; font-size: 14px; line-height: 1.7; white-space: pre-wrap; }
    dialog .modal-foot { padding: 14px 20px; border-top: 1px solid var(--border); display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
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
        <h1>DeepSeek Harness Web Service API <span class="version-tag">v${pluginVersion}</span></h1>
        <div class="subtitle">三方调用专属接口平台 &bull; 基础前缀: <code>${prefix}</code></div>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <a href="${prefix}/docs/reference" class="btn btn-ghost" style="text-decoration:none;">在线调试 (Swagger)</a>
        <a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" style="text-decoration:none; display:inline-flex; align-items:center; gap:6px;">${GITHUB_ICON}<span>GitHub</span></a>
        <a href="${ISSUES_URL}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" style="text-decoration:none; display:inline-flex; align-items:center; gap:6px;">${FEEDBACK_ICON}<span>问题反馈</span></a>
        <button class="btn btn-ghost" id="btnCheckUpdate" onclick="checkUpdate(this)" style="display:inline-flex; align-items:center; gap:6px;">${SYNC_ICON}<span>检查更新</span></button>
        <a href="${prefix}/settings/api-keys" class="btn" style="text-decoration:none;">管理 API Key</a>
        <a href="${prefix}/openapi.json" target="_blank" class="btn btn-ghost" style="text-decoration:none;">查看 OpenAPI JSON</a>
      </div>
    </header>

    <div class="auth-box">
      <span style="font-size: 14px; font-weight: 600;">API Key 鉴权：</span>
      <input type="password" id="apiKeyInput" placeholder="${requireAuth ? '请输入配置的 Bearer Token' : '当前未开启强制鉴权，可留空'}">
      <button class="btn" onclick="saveApiKey()">保存凭据</button>
      <span class="desc" style="margin-left:0; font-size:12px; color:var(--text-muted);">此处仅保存在浏览器本地，与服务器端的 Key 管理无关；生成 / 吊销密钥请到 <a href="${prefix}/settings/api-keys" style="color:#60a5fa;">设置页</a></span>
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

  <!-- 检查更新 -->
  <dialog id="dlgUpdate" aria-labelledby="dlgUpdateTitle">
    <div class="modal-head" id="dlgUpdateTitle">检查更新</div>
    <div class="modal-body">
      <div id="updateResult">正在检查更新…</div>
    </div>
    <div class="modal-foot">
      <a id="updateReleaseLink" href="${GITHUB_URL}/releases" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" style="text-decoration:none; display:none;">打开 Releases 页</a>
      <button class="btn" onclick="closeDialog()">关闭</button>
    </div>
  </dialog>

  <script>
    function closeDialog() {
      const d = document.getElementById('dlgUpdate');
      if (d && d.open) d.close();
    }

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

    // ---------- 检查更新（公开端点 /system/updates，失败时给出 Releases 链接兜底） ----------
    async function checkUpdate(btn) {
      const dlg = document.getElementById('dlgUpdate');
      const box = document.getElementById('updateResult');
      const link = document.getElementById('updateReleaseLink');
      if (btn) btn.disabled = true;
      box.textContent = '正在检查更新…';
      link.style.display = 'none';
      dlg.showModal();
      try {
        const res = await fetch('${prefix}/system/updates', { cache: 'no-store' });
        const json = await res.json();
        const d = (json && json.data) || {};
        if (!json || json.ok !== true) throw new Error((json && json.error) || ('HTTP ' + res.status));
        const lines = ['当前版本：v' + (d.current || '?')];
        if (d.latest) lines.push('最新版本：v' + d.latest);
        if (d.updateAvailable === true) {
          lines.push('✅ 有新版本可用，请到 Releases 页下载更新。');
          if (d.releaseUrl) { link.href = d.releaseUrl; link.style.display = ''; }
        } else if (d.updateAvailable === false) {
          lines.push(d.error ? 'ℹ️ ' + d.error + '，以本地版本为准。' : '✅ 已是最新版本。');
        } else {
          lines.push('⚠️ 检查失败：' + (d.error || '网络不可达') + '。可稍后重试，或直接访问 Releases 页。');
          link.style.display = '';
        }
        box.textContent = lines.join('\\n');
      } catch (err) {
        box.textContent = '⚠️ 检查失败：' + (err.message || err) + '\\n请确认本机能否访问 GitHub，或直接访问 Releases 页。';
        link.style.display = '';
      } finally {
        if (btn) btn.disabled = false;
      }
    }

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

/**
 * 在线接口文档与调试（GET /docs/reference）：Swagger UI 渲染 /openapi.json 全量规范，
 * 与 Swagger 一样支持 Authorize 预置凭证 + 每个接口 Try it out 在线调试。
 * 脚本走公共 CDN；加载失败时降级为指引（下载 openapi.json 或回到交互式 /docs）。
 */
function generateReferenceHtml(prefix: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>DSH Web Service 接口调试 · v${pluginVersion}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>
    html { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; background: #fff; }
    #cdn-fail { display: none; max-width: 720px; margin: 48px auto; padding: 20px 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #334155; line-height: 1.8; }
    #cdn-fail code { background: #f1f5f9; border-radius: 4px; padding: 1px 6px; font-size: 13px; }
    .version-float { position: fixed; right: 16px; bottom: 12px; z-index: 10; font-size: 12px; color: #64748b; background: rgba(255,255,255,.85); border: 1px solid #e2e8f0; border-radius: 999px; padding: 2px 10px; pointer-events: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <span class="version-float">v${pluginVersion}</span>
  <div id="cdn-fail">
    <strong>调试脚本加载失败（CDN 不可达）</strong><br>
    可以直接查看机器可读规范：<a href="${prefix}/openapi.json">openapi.json</a>；<br>
    或使用无需外网的内置交互式文档：<a href="${prefix}/docs">DeepSeek Harness Web Service API</a>。
  </div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" onerror="document.getElementById('cdn-fail').style.display='block'"></script>
  <script>
    if (window.SwaggerUIBundle) {
      window.SwaggerUIBundle({
        dom_id: '#swagger-ui',
        url: '${prefix}/openapi.json',
        // 在线调试：默认展开 Try it out；Authorize 后的凭证持久化到 localStorage
        tryItOutEnabled: true,
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'list',
        deepLinking: true,
        filter: true,
      });
    } else {
      document.getElementById('cdn-fail').style.display = 'block';
    }
  </script>
</body>
</html>`
}
