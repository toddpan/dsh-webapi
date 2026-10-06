/**
 * @dsh-external/dsh-web-service - 服务端渲染页面的 HARNESS 主题层
 *
 * 本插件的两个 SSR 页面（/docs、/docs/reference）与 API Key 设置页都是「一条路由 + 一个返回整页
 * HTML 的纯函数」，不经过构建链。为了让它们的配色与 DSH Web GUI 完全一致，这里把 HARNESS 的
 * 设计令牌原样搬过来（取值镜像 packages/client/ui-theme/src/styles/design-platform.css）：
 *
 * - 令牌名沿用 --dsw-*，与 HARNESS 同名，便于内嵌时直接对齐；
 * - 默认值是 HARNESS 的 **浅色** 主题；深色通过 body[data-ds-dark-theme] 覆盖（与 HARNESS 同构）；
 * - 被嵌进 DSH GUI 侧边栏 iframe（同源）时，HARNESS_THEME_SYNC_JS 会读取父文档 body 的
 *   计算值并以内联样式覆盖到本页 body —— 于是本页跟随的是 GUI 的**真实**主题（包含用户自定义
 *   主题），而不是这里的兜底值；父文档切换主题时通过 MutationObserver 实时跟随；
 * - 独立打开时按 prefers-color-scheme 决定明暗，并支持 ?theme=light|dark 强制指定。
 */

/** HARNESS 设计令牌（浅色默认 + html[data-ds-dark-theme] 深色覆盖） */
export const HARNESS_TOKENS_CSS = `
:root {
  /* 表面 */
  --dsw-alias-bg-base: rgb(255, 255, 255);
  --dsw-alias-bg-layer-1: rgb(255, 255, 255);
  --dsw-alias-bg-layer-2: rgb(255, 255, 255);
  --dsw-alias-bg-layer-3: rgb(255, 255, 255);
  --dsw-alias-bg-overlay: rgb(233, 236, 242);
  --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.24);
  --dsw-alias-bg-skeleton: rgba(0, 0, 0, 0.04);
  --dsw-specific-input-major: rgb(255, 255, 255);
  --dsw-specific-sidebar-fill: rgb(249, 250, 251);
  --dsw-specific-selector: rgb(245, 246, 247);
  /* 描边 */
  --dsw-alias-border-l1: rgba(0, 0, 0, 0.04);
  --dsw-alias-border-l2: rgba(0, 0, 0, 0.10);
  --dsw-alias-border-l3: rgba(0, 0, 0, 0.12);
  /* 文字 */
  --dsw-alias-label-primary: rgb(15, 17, 21);
  --dsw-alias-label-secondary: rgb(97, 102, 107);
  --dsw-alias-label-tertiary: rgb(129, 133, 140);
  --dsw-alias-label-caption: rgb(173, 178, 184);
  --dsw-alias-label-primary-foreground: rgb(255, 255, 255);
  /* 品牌与按钮 */
  --dsw-alias-brand-primary: rgb(15, 17, 21);
  --dsw-alias-button-primary-fill: rgb(15, 17, 21);
  --dsw-alias-button-primary-hover: rgb(67, 69, 74);
  --dsw-alias-button-ghost-active-fill: rgb(235, 238, 242);
  --dsw-alias-interactive-bg-hover: rgba(38, 49, 72, 0.06);
  --dsw-alias-interactive-bg-hover-solid: rgb(241, 243, 245);
  --dsw-alias-interactive-bg-hover-danger: rgba(236, 19, 19, 0.05);
  --dsw-alias-link: rgb(65, 118, 230);
  /* 状态 */
  --dsw-alias-state-error-primary: rgb(236, 19, 19);
  --dsw-alias-state-error-secondary: rgb(242, 90, 90);
  --dsw-alias-state-success-primary: rgb(34, 197, 94);
  --dsw-alias-state-success-secondary: rgb(78, 209, 126);
  --dsw-alias-state-success-tertiary: rgb(230, 250, 237);
  --dsw-alias-state-warn-primary: rgb(245, 158, 11);
  --dsw-alias-state-warn-secondary: rgb(247, 173, 49);
  --dsw-alias-state-warn-label: rgb(221, 134, 41);
  --dsw-alias-state-warn-tertiary: rgb(254, 245, 231);
  --dsw-alias-state-business-primary: rgb(65, 118, 230);
  --dsw-alias-state-business-tertiary: rgb(228, 237, 253);
  /* 浮层与代码 */
  --dsw-alias-toast-bg: rgb(53, 54, 56);
  --dsw-alias-tooltip-bg: rgb(44, 44, 46);
  --dsw-alias-markdown-code-block: rgb(250, 250, 250);
  --dsw-alias-markdown-inline-code: rgb(245, 245, 245);
  --dsw-alias-scrollbar-bg-l1: rgb(229, 229, 229);
  --dsw-alias-scrollbar-hover-l1: rgb(212, 212, 212);
  /* 字体与动效 */
  --dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --ds-font-family-code: 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei';
  --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --ds-transition-duration: 0.2s;
  --ds-transition-duration-fast: 0.1s;
}

html[data-ds-dark-theme] {
  --dsw-alias-bg-base: rgb(21, 21, 23);
  --dsw-alias-bg-layer-1: rgb(35, 35, 36);
  --dsw-alias-bg-layer-2: rgb(44, 44, 46);
  --dsw-alias-bg-layer-3: rgb(53, 54, 56);
  --dsw-alias-bg-overlay: rgb(97, 102, 107);
  --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.5);
  --dsw-alias-bg-skeleton: rgba(255, 255, 255, 0.08);
  --dsw-specific-input-major: rgb(44, 44, 46);
  --dsw-specific-sidebar-fill: rgb(27, 27, 28);
  --dsw-specific-selector: rgb(53, 54, 56);
  --dsw-alias-border-l1: rgba(255, 255, 255, 0.06);
  --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
  --dsw-alias-border-l3: rgba(255, 255, 255, 0.16);
  --dsw-alias-label-primary: rgb(249, 250, 251);
  --dsw-alias-label-secondary: rgb(207, 211, 214);
  --dsw-alias-label-tertiary: rgb(173, 178, 184);
  --dsw-alias-label-caption: rgb(129, 133, 140);
  --dsw-alias-label-primary-foreground: rgb(15, 17, 21);
  --dsw-alias-brand-primary: rgb(249, 250, 251);
  --dsw-alias-button-primary-fill: rgb(249, 250, 251);
  --dsw-alias-button-primary-hover: rgb(235, 238, 242);
  --dsw-alias-button-ghost-active-fill: rgb(67, 69, 74);
  --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.08);
  --dsw-alias-interactive-bg-hover-solid: rgb(53, 54, 56);
  --dsw-alias-interactive-bg-hover-danger: rgba(242, 90, 90, 0.15);
  --dsw-alias-link: rgb(103, 158, 254);
  --dsw-alias-state-error-primary: rgb(242, 90, 90);
  --dsw-alias-state-error-secondary: rgb(242, 90, 90);
  --dsw-alias-state-success-primary: rgb(34, 197, 94);
  --dsw-alias-state-success-secondary: rgb(78, 209, 126);
  --dsw-alias-state-success-tertiary: rgb(35, 60, 44);
  --dsw-alias-state-warn-primary: rgb(245, 158, 11);
  --dsw-alias-state-warn-secondary: rgb(247, 173, 49);
  --dsw-alias-state-warn-label: rgb(221, 134, 41);
  --dsw-alias-state-warn-tertiary: rgb(39, 36, 31);
  --dsw-alias-state-business-primary: rgb(103, 158, 254);
  --dsw-alias-state-business-tertiary: rgb(52, 65, 91);
  --dsw-alias-toast-bg: rgb(67, 69, 74);
  --dsw-alias-tooltip-bg: rgb(67, 69, 74);
  --dsw-alias-markdown-code-block: rgb(27, 27, 28);
  --dsw-alias-markdown-inline-code: rgb(41, 41, 41);
  --dsw-alias-scrollbar-bg-l1: rgb(60, 60, 61);
  --dsw-alias-scrollbar-hover-l1: rgb(84, 85, 87);
}
`

/**
 * 与 HARNESS 同源的通用控件皮肤：按钮、卡片、输入、表格、徽标、提示条、弹层、代码块、滚动条。
 * 两个 SSR 页面共用这一层，页面自己的 <style> 只放该页独有的布局。
 */
export const HARNESS_PRIMITIVES_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: var(--dsw-font-family);
  font-size: 14px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  /* 滚动条：沿用 HARNESS scrollbar skin 的 l1 基准 */
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l1);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l1);
}
@supports not selector(::-webkit-scrollbar) {
  body { scrollbar-color: var(--dsh-scrollbar-thumb) transparent; }
}
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--dsh-scrollbar-thumb); border-radius: 999px; }
::-webkit-scrollbar-thumb:hover { background: var(--dsh-scrollbar-thumb-hover); }

/* 布局 */
.container { max-width: 1100px; margin: 0 auto; }
.page-header {
  margin-bottom: 20px; padding-bottom: 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap;
}
h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; color: var(--dsw-alias-label-primary); }
h2 { color: var(--dsw-alias-label-primary); }
.subtitle { color: var(--dsw-alias-label-secondary); font-size: 13.5px; margin-top: 6px; }
.section-title { font-size: 16px; font-weight: 600; margin: 26px 0 12px; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 8px; }
.muted { color: var(--dsw-alias-label-secondary); font-size: 13px; }
.breadcrumb { font-size: 13px; color: var(--dsw-alias-label-secondary); margin-bottom: 12px; }
.breadcrumb a { color: var(--dsw-alias-link); text-decoration: none; }
.breadcrumb a:hover { text-decoration: underline; }
.version-tag {
  font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover-solid);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px; padding: 2px 10px; vertical-align: middle; margin-left: 8px;
}

/* 按钮 */
.btn {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font-family: inherit; font-size: 13.5px; font-weight: 500; line-height: 1;
  padding: 8px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer;
  text-decoration: none; white-space: nowrap;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  transition: background var(--ds-transition-duration) var(--ds-ease-in-out),
              border-color var(--ds-transition-duration) var(--ds-ease-in-out),
              opacity var(--ds-transition-duration-fast) linear;
}
.btn:hover { background: var(--dsw-alias-button-primary-hover); }
.btn:active { opacity: 0.88; }
.btn:disabled, .btn[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.btn:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; }
.btn-ghost { background: transparent; color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.btn-ghost:hover { background: var(--dsw-alias-interactive-bg-hover); }
.btn-danger { background: var(--dsw-alias-state-error-primary); color: #fff; }
.btn-danger:hover { background: var(--dsw-alias-state-error-secondary); }
.btn-sm { padding: 5px 10px; font-size: 12.5px; border-radius: 6px; }

/* 卡片 */
.card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px; padding: 16px;
}

/* 表单 */
label.field-label, .field-label { display: block; font-size: 12.5px; color: var(--dsw-alias-label-secondary); margin-bottom: 5px; }
input[type="text"], input[type="password"], input[type="number"], textarea, select {
  width: 100%; background: var(--dsw-specific-input-major);
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary);
  padding: 8px 12px; border-radius: 8px; font-size: 13.5px; font-family: inherit;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
              box-shadow var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
input::placeholder, textarea::placeholder { color: var(--dsw-alias-label-caption); }
input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: none; border-color: var(--dsw-alias-link);
  box-shadow: 0 0 0 3px var(--dsw-alias-state-business-tertiary);
}
.field { margin-bottom: 14px; }
.field-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 4px; }
.field-error { font-size: 12.5px; color: var(--dsw-alias-state-error-primary); margin-top: 4px; }
.input-invalid { border-color: var(--dsw-alias-state-error-primary) !important; }

/* 徽标 */
.badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; line-height: 1.6; }
.badge-active { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.badge-off { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.badge-revoked { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-secondary); }
.badge-config { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }

/* 提示条 */
.alert {
  border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; font-size: 13.5px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap;
}
.alert strong { display: block; margin-bottom: 2px; font-weight: 600; }
.alert-info { background: var(--dsw-alias-state-business-tertiary); border-color: transparent; }
.alert-warn { background: var(--dsw-alias-state-warn-tertiary); border-color: transparent; }
.alert-danger { background: var(--dsw-alias-interactive-bg-hover-danger); border-color: var(--dsw-alias-state-error-primary); }
.alert a { color: var(--dsw-alias-link); }

/* 表格 */
table.key-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.key-table th, .key-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: middle; }
.key-table th { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; }
.key-table tbody tr { transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
.key-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover); }
.key-table tr:last-child td { border-bottom: none; }
.key-table .cell-actions { text-align: right; white-space: nowrap; }
.key-masked { font-family: var(--ds-font-family-code); font-size: 12.5px; color: var(--dsw-alias-label-primary); }
.row-revoked { opacity: 0.5; }
.row-highlight { animation: row-hl 1.8s var(--ds-ease-in-out); }
@keyframes row-hl { from { background: var(--dsw-alias-state-business-tertiary); } to { background: transparent; } }

/* 代码 */
.mono, code, kbd, samp { font-family: var(--ds-font-family-code); }
code.inline {
  background: var(--dsw-alias-markdown-inline-code);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; padding: 1px 6px; font-size: 12.5px;
}
.code-block, .reveal-box {
  background: var(--dsw-alias-markdown-code-block);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; padding: 12px;
  font-family: var(--ds-font-family-code); font-size: 12.5px;
  white-space: pre-wrap; word-break: break-all; color: var(--dsw-alias-label-primary);
}

/* 弹层 */
dialog {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  border-radius: 12px; padding: 0; width: min(560px, calc(100vw - 32px));
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
}
dialog::backdrop { background: var(--dsw-alias-bg-mask-1); }
.modal-head { padding: 16px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 15px; font-weight: 600; }
.modal-body { padding: 20px; }
.modal-foot { padding: 14px 20px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }

/* toast */
#toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(6px);
  background: var(--dsw-alias-toast-bg); color: #fff;
  border-radius: 10px; padding: 10px 16px; font-size: 13.5px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  opacity: 0; pointer-events: none; z-index: 60;
  transition: opacity var(--ds-transition-duration) var(--ds-ease-in-out),
              transform var(--ds-transition-duration) var(--ds-ease-in-out);
}
#toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
`

/**
 * 主题同步脚本（置于 <head>，即刻执行，避免明暗闪烁）：
 * 1) 同源内嵌（DSH GUI 侧边栏 iframe）→ 直接读父文档 body 的 --dsw-* 计算值覆盖本页 :root，
 *    并用 MutationObserver 跟随父文档的明暗切换；
 * 2) 独立打开 → 按 prefers-color-scheme，可用 ?theme=light|dark 强制。
 */
export const HARNESS_THEME_SYNC_JS = `
(function () {
  var TOKENS = [
    '--dsw-alias-bg-base','--dsw-alias-bg-layer-1','--dsw-alias-bg-layer-2','--dsw-alias-bg-layer-3',
    '--dsw-alias-bg-overlay','--dsw-alias-bg-mask-1','--dsw-alias-bg-skeleton',
    '--dsw-specific-input-major','--dsw-specific-sidebar-fill','--dsw-specific-selector',
    '--dsw-alias-border-l1','--dsw-alias-border-l2','--dsw-alias-border-l3',
    '--dsw-alias-label-primary','--dsw-alias-label-secondary','--dsw-alias-label-tertiary',
    '--dsw-alias-label-caption','--dsw-alias-label-primary-foreground',
    '--dsw-alias-brand-primary','--dsw-alias-button-primary-fill','--dsw-alias-button-primary-hover',
    '--dsw-alias-button-ghost-active-fill','--dsw-alias-interactive-bg-hover',
    '--dsw-alias-interactive-bg-hover-solid','--dsw-alias-interactive-bg-hover-danger',
    '--dsw-alias-link','--dsw-alias-state-error-primary','--dsw-alias-state-error-secondary',
    '--dsw-alias-state-success-primary','--dsw-alias-state-success-secondary','--dsw-alias-state-success-tertiary',
    '--dsw-alias-state-warn-primary','--dsw-alias-state-warn-secondary','--dsw-alias-state-warn-label',
    '--dsw-alias-state-warn-tertiary','--dsw-alias-state-business-primary','--dsw-alias-state-business-tertiary',
    '--dsw-alias-toast-bg','--dsw-alias-markdown-code-block','--dsw-alias-markdown-inline-code',
    '--dsw-alias-scrollbar-bg-l1','--dsw-alias-scrollbar-hover-l1'
  ];
  var root = document.documentElement;

  function setDark(on) {
    if (on) root.setAttribute('data-ds-dark-theme', '');
    else root.removeAttribute('data-ds-dark-theme');
  }

  function mirrorParent() {
    var pbody = null;
    try {
      if (window.parent && window.parent !== window) pbody = window.parent.document.body;
    } catch (err) { pbody = null; }
    if (!pbody) return false;
    var cs = window.parent.getComputedStyle(pbody);
    for (var i = 0; i < TOKENS.length; i++) {
      var v = cs.getPropertyValue(TOKENS[i]);
      if (v && v.trim()) root.style.setProperty(TOKENS[i], v.trim());
    }
    setDark(pbody.hasAttribute('data-ds-dark-theme'));
    return true;
  }

  function followSystem() {
    var forced = null;
    try { forced = new URLSearchParams(location.search).get('theme'); } catch (err) {}
    if (forced === 'light' || forced === 'dark') { setDark(forced === 'dark'); return; }
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function sync() { setDark(!!(mq && mq.matches)); }
    sync();
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', sync);
      else if (mq.addListener) mq.addListener(sync);
    }
  }

  if (!mirrorParent()) {
    // 内嵌但跨源：读不到父文档，退回系统偏好
    if (window.self !== window.top) {
      try { followSystem(); return; } catch (err) {}
    }
    followSystem();
    return;
  }
  // 父文档主题可能在 GUI 启动后才落定，先补几次，再交给 MutationObserver
  var tries = 0;
  var timer = setInterval(function () {
    mirrorParent();
    if (++tries >= 20) clearInterval(timer);
  }, 250);
  try {
    new MutationObserver(function () { mirrorParent(); }).observe(window.parent.document.body, {
      attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
    });
  } catch (err) {}
})();
`
