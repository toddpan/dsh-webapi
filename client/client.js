/**
 * DSH Web Service · 浏览器半边（client half）。
 *
 * 在 DSH Web GUI 的侧边栏注册面板「API Key 管理」：点击后在中央栏内嵌
 * 本插件的密钥设置页（同源 iframe，`api/v1/settings/api-keys?embed=1`）。
 * Swagger 调试、GitHub、问题反馈、检查更新等入口都长在设置页页头，
 * 用户不必记住独立 URL——入口就长在 DSH 界面的侧边栏上。
 *
 * 装载格式：与官方 client 插件一致的 ModuleLoader 工厂（无构建步骤、
 * 零依赖——手写 React.createElement，不引 JSX 运行时）。面板座位由
 * ui-sidebar（sidebar.panellist）与 ui-layout（main）声明；`ctx.slots.inject`
 * 的回调只在座位就绪后运行，缺座位的 shell 只会让面板缺席，不会启动失败。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-web-service',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var react = require('react');

    /** 侧边栏面板 id（同时是 main 键位槽的 key，二者必须一致） */
    var PANEL_ID = 'web-service-api-keys';
    /** 内嵌页面：文档相对路径（GUI 以 <base href="./"> 服务，兼容子路径部署） */
    var PAGE_SRC = 'api/v1/settings/api-keys?embed=1';
    /** 排在官方面板之后（skill-explorer 用 30） */
    var PANEL_ORDER = 40;

    // ---------- 样式（材质化时注入一次，带去重标记） ----------
    var CSS_TAG = '@dsh-external/dsh-web-service/client/panel.css';
    var CSS = ''
      + '.dshw-view{height:100%;min-height:0;overflow:hidden;display:flex;flex-direction:column;'
      + 'background:var(--dsw-alias-bg-base,transparent)}'
      + '.dshw-frame{flex:1;width:100%;min-height:0;border:0;background:transparent}';

    function injectStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = '@dsh-external/dsh-web-service';
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------- 侧边栏图标（钥匙） ----------
    function PanelIcon(props) {
      var size = (props && props.size) || 16;
      return react.createElement('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        // 锁体 + 内孔
        react.createElement('rect', { x: '3.2', y: '7', width: '9.6', height: '6.2', rx: '1.4' }),
        react.createElement('path', { d: 'M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7' }),
        react.createElement('circle', { cx: '8', cy: '10.1', r: '1' })
      );
    }

    // ---------- 中央面板页（内嵌设置页） ----------
    function PanelPage() {
      return react.createElement('div', {
        className: 'dshw-view',
        'data-dsh-web-service-view': '',
        'data-dsh-plugin': 'dsh-web-service',
      },
        react.createElement('iframe', {
          className: 'dshw-frame',
          src: PAGE_SRC,
          title: 'API Key 管理',
        })
      );
    }

    /**
     * 注册侧边栏入口与中央面板。
     * @param ctx - client root context（服务：slots）
     */
    function apply(ctx) {
      injectStyles();
      ctx.effect(function () {
        var slots = ctx.slots;
        var disposers = [];
        disposers.push(slots.inject('sidebar.panellist', function () {
          return slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: 'API Key 管理',
          }, PanelIcon);
        }));
        disposers.push(slots.inject('main', function () {
          return slots.register({
            name: 'main',
            key: PANEL_ID,
          }, PanelPage);
        }));
        return function () {
          for (var i = 0; i < disposers.length; i++) disposers[i]();
        };
      }, 'dsh-web-service: api-keys panel');
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
