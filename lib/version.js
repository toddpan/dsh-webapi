/**
 * @dsh-external/dsh-web-service - 插件版本号（单一来源）
 *
 * 直接读包内 package.json（lib/ 的上一级），避免与发布版本脱节。
 * 使用方：/system/status、/system/updates、/docs 页头版本徽标、API Key 设置页。
 */
import { readFileSync } from 'node:fs';
export const pluginVersion = (() => {
    try {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
})();
//# sourceMappingURL=version.js.map