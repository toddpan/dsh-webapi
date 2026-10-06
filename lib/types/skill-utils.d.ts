/**
 * @dsh-external/dsh-web-service - Skill 工具函数
 *
 * 无第三方依赖：
 *  - frontmatter 解析/序列化（YAML 子集：顶层标量 + 续行折叠）
 *  - .zip 安全解压（Node 内置 zlib，拒绝 zip-slip / 绝对路径 / ..）
 *  - .tar / .tgz / .tar.gz 走系统 tar（macOS/Linux）
 *  - 技能根解析（user-dsh / user-agents / custom / project + cwd）
 */
export interface SkillFrontmatter {
    name?: string;
    description?: string;
    whenToUse?: string;
    modelInvocable: boolean;
    userInvocable: boolean;
    /** 原样保留的未知字段（用于回写） */
    [key: string]: unknown;
}
/** kebab-case 技能名校验（对齐 dsh-skill 的 SKILL_NAME） */
export declare const SKILL_NAME_RE: RegExp;
export declare function isSkillName(name: string): boolean;
export type SkillRootKind = 'user-dsh' | 'user-agents' | 'custom' | 'project' | 'bundled';
export interface SkillRoot {
    kind: SkillRootKind;
    path: string;
}
/** 解析技能根目录（缺省 user-dsh）。project 需要 cwd；custom 取服务配置。 */
export declare function resolveSkillRoot(kind: string | undefined, cwd: string | undefined, customSkillDirs?: string[], dshHome?: string, agentsHome?: string, bundledDir?: string | undefined): {
    ok: true;
    root: SkillRoot;
} | {
    ok: false;
    error: string;
};
export interface ParsedSkillFile {
    name: string;
    description: string;
    whenToUse?: string;
    frontmatter: SkillFrontmatter;
    body: string;
    raw: string;
}
/** 解析 SKILL.md / .md 的技能文件（frontmatter 用 YAML 子集解析）。 */
export declare function parseSkillFile(raw: string): ParsedSkillFile | undefined;
/** YAML 子集解析：顶层 `key: value`，2+ 空格续行进 value，支持布尔/数字/引号。 */
export declare function parseYamlSubset(text: string): SkillFrontmatter;
/** 序列化 frontmatter（key: value 单行；多行 value 用 > 折叠）。 */
export declare function serializeFrontmatter(data: Record<string, unknown>): string;
/**
 * 依赖零的 .zip 安全解压（store/deflate），落盘到 destDir。
 * 拒绝绝对路径、.. 段、\0、符号链接；每个文件先建父目录再写。
 */
export declare function extractZip(buffer: Buffer, destDir: string): Promise<{
    ok: true;
    count: number;
} | {
    ok: false;
    error: string;
}>;
/** tar / tgz / tar.gz 走系统 tar（strip 顶层包装目录）。返回是否成功。 */
export declare function extractTar(buffer: Buffer, destDir: string, strip: number): Promise<{
    ok: true;
    count: number;
} | {
    ok: false;
    error: string;
}>;
/** 列出技能根下所有技能（目录版 SKILL.md + 扁平 .md）。 */
export declare function discoverSkills(root: string): Promise<Array<{
    name: string;
    description: string;
    whenToUse?: string;
    source: string;
    path: string;
    root: string;
    size: number;
    modelInvocable: boolean;
    userInvocable: boolean;
}>>;
