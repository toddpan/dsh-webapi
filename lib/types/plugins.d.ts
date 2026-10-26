/**
 * dsh-web-service — 本机已装 DSH 插件清单（GET /plugins）
 *
 * 数据源（实证于 ~/.dsh/profiles/ 布局）：
 *  - 主依据：profile `package.json`，dsh plugin add 会把每个插件记录为 profile 依赖
 *    （`dsh.profile.bundles` 内置捆绑与直接安装共用该清单）；
 *  - 兜底：扫描自身所在 node_modules 的兄弟包目录，逐个读 package.json；
 *  - 自身：从包内 package.json 读出 name/version/description 兜底（无 profile 也能返回）。
 *
 * 每条记录带 `family:'dsh'` —— 控制台「从节点导入插件」用该属性与目标 AGENT 引擎家族
 * （DSH / ZCODE / 未来扩展）做适用匹配；`sourcePath` 供导入端在节点上打包导出。
 */
import { HttpRouter } from './router.js';
export interface PluginEntry {
    name: string;
    family: 'dsh';
    version?: string;
    description?: string;
    /** node 上的绝对目录（导入端在节点上 npm pack 此目录得到归档） */
    sourcePath?: string;
    /** profile dsh.profile.bundles 内置捆绑的插件标记 */
    bundled?: boolean;
}
export interface PluginListResult {
    count: number;
    family: 'dsh';
    /** dsh-profile-*（找到时） */
    profile?: string;
    plugins: PluginEntry[];
}
export declare function listDshPlugins(): Promise<PluginListResult>;
export declare function registerPluginRoutes(router: HttpRouter): void;
