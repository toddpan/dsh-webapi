/**
 * dsh-web-service - Types & Interfaces
 */
export interface ApiResponse<T = unknown> {
    ok: boolean;
    data?: T;
    error?: string;
    code?: string;
    timestamp?: number;
}
export interface WorkspaceItem {
    id: string;
    path: string;
    title: string;
    sessionIds: string[];
    createdAt: number;
    updatedAt: number;
}
export interface WorkspaceCreateInput {
    path: string;
    title?: string;
}
export interface WorkspaceUpdateInput {
    title: string;
}
export interface SessionItem {
    id: string;
    title?: string;
    createdAt?: number;
    updatedAt?: number;
    workspaceId?: string;
    status?: 'idle' | 'running' | 'error';
    lastActivityAt?: number;
    model?: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    };
    /** 模式预设（建会话时的 agentPreset；宿主元数据可读则回带，否则来自本插件运行时记录） */
    agentPreset?: string;
}
export interface SessionCreateInput {
    workspaceId?: string;
    cwd?: string;
    title?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    agentPreset?: string;
    sessionId?: string;
    /** 运行权限 preset（danger-full-access / workspace-write …），建会话后经 permissionPresets 原生生效 */
    permission?: string;
}
export interface SessionUpdateInput {
    title?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    /** 模式预设：宿主支持运行时应用则立即生效，否则仅记录并返回 applied:false（上层任务级持久化兜底） */
    agentPreset?: string;
}
export interface SessionPromptInput {
    prompt: string;
    images?: Array<{
        mimeType: string;
        data: string;
    }>;
    mode?: 'normal' | 'steer';
    timeoutMs?: number;
}
export interface SessionHistoryQuery {
    beforeSeq?: number;
    throughSeq?: number;
    maxMessages?: number;
}
export interface SessionHistoryMessage {
    seq: number;
    type: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    reasoning?: string;
    toolCalls?: Array<{
        id?: string;
        name: string;
        arguments: unknown;
    }>;
    time?: number;
}
export interface ModelItem {
    id: string;
    provider: string;
    name?: string;
    description?: string;
    contextLimit?: number;
    inputModalities?: string[];
    reasoning?: {
        efforts: Array<{
            id: string;
            name: string;
            description?: string;
        }>;
        defaultEffort?: string;
    };
    /** 路由型 provider：无模型目录但可直接作为 provider/model 路由使用 */
    routeOnly?: boolean;
    isDefault?: boolean;
}
export interface DefaultModelSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
export interface ProviderItem {
    id: string;
    displayName?: string;
    models: string[];
}
export interface OpenAiChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | Array<{
        type: string;
        text?: string;
        image_url?: {
            url: string;
        };
    }>;
}
export interface OpenAiChatCompletionRequest {
    model?: string;
    messages: OpenAiChatMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    sessionId?: string;
}
export interface WebServiceConfig {
    /** API 路由前缀，默认 '/api/v1' */
    pathPrefix?: string;
    /** 鉴权 Token，若为空则不鉴权 */
    apiKey?: string;
    /** 独立监听 HTTP 端口，默认为 0（仅挂载主 webserver）；若 >0 则额外独立监听 */
    standalonePort?: number;
    /** 是否开启 CORS，默认 true */
    cors?: boolean;
    /** 默认工作空间目录，默认 process.cwd() */
    defaultCwd?: string;
    /** 文件上传大小上限（字节），默认 100MB */
    maxUploadBytes?: number;
    /**
     * 是否允许非回环地址访问 API Key 管理接口（/api-keys*），默认 false。
     * 默认仅允许本机（回环）管理密钥；确需远程管理时显式开启。
     */
    adminRemoteAccess?: boolean;
    /** 技能管理：额外自定义技能根目录（root=custom 时使用） */
    customSkillDirs?: string[];
    /** 技能管理：DSH 配置根（默认 $DSH_HOME 或 ~/.dsh） */
    dshHome?: string;
    /** 技能管理：共享 agent 配置根（默认 $DSH_AGENTS_HOME 或 ~/.agents） */
    agentsHome?: string;
    /** 技能管理：内置技能目录（默认 $DSH_BUNDLED_SKILL_DIR） */
    bundledSkillDir?: string;
}
