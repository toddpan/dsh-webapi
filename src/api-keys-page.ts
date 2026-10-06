/**
 * @dsh-external/dsh-web-service - API Key 设置页（服务端渲染 HTML）
 *
 * 与 src/openapi.ts 的 generateDocsHtml() 同构：一条路由 + 一个返回整页内联 HTML 的纯函数，
 * 零构建链、零依赖。视觉沿用 /docs 的 :root 变量与 kebab-case 命名。
 *
 * 安全约定：
 * - 页面 HTML 本身不含任何密钥，公开可访问（与 /docs 一致）；
 * - 所有数据请求都走 /api-keys*，服务端要求管理令牌；页面只把令牌存在 localStorage；
 * - 新建 / 轮换成功后弹层展示完整 Key（关闭即从 DOM 清除）；列表页另有「复制」按钮，
 *   通过管理令牌鉴权的 /api-keys/:id/reveal 现取现用，明文只进剪贴板、不落 DOM。
 */

import { pluginVersion } from './version.js'
import { HARNESS_TOKENS_CSS, HARNESS_PRIMITIVES_CSS, HARNESS_THEME_SYNC_JS, EMBED_NAV_JS } from './page-theme.js'

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return ch
    }
  })
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
/** Octicon code-16（SWAGGER 在线调试图标） */
const SWAGGER_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="flex:0 0 auto;"><path d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"/></svg>'

export function generateApiKeysHtml(prefix: string, adminTokenPath = '', embed = false): string {
  // 两种语境分开转义：HTML 文本/属性用实体转义，JS 字符串字面量用 JSON.stringify（script 内容不做实体解码）
  const base = escapeHtml(prefix)
  const jsBase = JSON.stringify(prefix)
  // 管理令牌的绝对路径（服务端注入）；为空时退回通用相对提示
  const tokenPath = escapeHtml(adminTokenPath || '~/.dsh/dsh-web-service/admin-token')
  const jsTokenPath = JSON.stringify(adminTokenPath || '~/.dsh/dsh-web-service/admin-token')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>API Key 管理 · DSH Web Service</title>
  <style>
    ${HARNESS_TOKENS_CSS}
    ${HARNESS_PRIMITIVES_CSS}
    body { padding: 24px; }
    h2 { font-size: 15px; font-weight: 600; }

    /* 状态卡 */
    .status-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }

    /* 空状态 */
    .empty { text-align: center; padding: 34px 20px; }
    .empty ol { text-align: left; display: inline-block; margin: 12px auto; color: var(--dsw-alias-label-secondary); font-size: 13px; }
    .empty li { margin: 4px 0; }

    .switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13.5px; }

    /* 内嵌模式（DSH GUI 侧边栏 iframe）：隐藏面包屑等导航冗余，收紧留白；
       页头 SWAGGER / GitHub / 问题反馈 / 检查更新 按钮保留可见 */
    body[data-embed] { padding: 16px 18px 20px; }
    body[data-embed] .breadcrumb { display: none !important; }
    body[data-embed] header.page-header { margin-bottom: 14px; padding-bottom: 12px; }
    body[data-embed] h1 { font-size: 18px; }

    /* 响应式：表格降级为卡片 */
    @media (max-width: 768px) {
      body { padding: 14px; }
      .key-table thead { display: none; }
      .key-table tr { display: block; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; margin-bottom: 10px; padding: 6px 4px; }
      .key-table td { display: flex; justify-content: space-between; gap: 12px; border-bottom: none; padding: 6px 10px; }
      .key-table tbody tr:hover { background: transparent; }
      .key-table td::before { content: attr(data-label); color: var(--dsw-alias-label-secondary); font-size: 12px; flex: 0 0 auto; }
      .key-table .cell-actions { text-align: left; justify-content: flex-end; flex-wrap: wrap; }
    }
    @media (max-width: 480px) {
      header.page-header { align-items: flex-start; }
      .modal-foot .btn { width: 100%; }
    }
  </style>
  <script>${HARNESS_THEME_SYNC_JS}</script>
</head>
<body${embed ? ' data-embed="1"' : ''}>
  <div class="container">
    <nav class="breadcrumb" aria-label="面包屑">
      <a href="${base}/docs">DSH Web Service API</a> &rsaquo; 设置 &rsaquo;
      <span aria-current="page">API Key 管理</span>
    </nav>

    <header class="page-header">
      <div>
        <h1>API Key 管理 <span class="version-tag">v${pluginVersion}</span></h1>
        <div class="subtitle">在此管理第三方程序调用 DSH API 时使用的访问密钥 &bull; 基础前缀 <code class="inline">${base}</code></div>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <a href="${base}/docs/reference" data-nav="frame" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" style="text-decoration:none; display:inline-flex; align-items:center; gap:6px;">${SWAGGER_ICON}<span>SWAGGER</span></a>
        <a href="${GITHUB_URL}" data-nav="external" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" style="text-decoration:none; display:inline-flex; align-items:center; gap:6px;">${GITHUB_ICON}<span>GitHub</span></a>
        <a href="${ISSUES_URL}" data-nav="external" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" style="text-decoration:none; display:inline-flex; align-items:center; gap:6px;">${FEEDBACK_ICON}<span>问题反馈</span></a>
        <button class="btn btn-ghost" onclick="checkUpdate(this)" style="display:inline-flex; align-items:center; gap:6px;">${SYNC_ICON}<span>检查更新</span></button>
        <button class="btn" id="btnCreate" style="display:none;" onclick="openCreate()">＋ 新建 API Key</button>
      </div>
    </header>

    <div id="bannerSlot"></div>

    <!-- 管理令牌闸门 -->
    <section id="gateCard" class="card" style="display:none;">
      <h2 style="font-size:16px; margin-bottom:8px;">需要管理令牌（Admin Token）</h2>
      <p class="muted" style="margin-bottom:14px;">
        本页面的密钥管理接口与普通 API 调用使用<strong>两套不同凭证</strong>：管理接口需要「管理令牌」，
        而不是普通 API Key。这样持有 API Key 的三方客户端无法为自己增发密钥。
      </p>
      <div class="field" style="max-width:520px;">
        <label class="field-label" for="adminTokenInput">管理令牌</label>
        <input type="password" id="adminTokenInput" autocomplete="current-password"
               placeholder="粘贴管理令牌" aria-describedby="adminTokenHint">
        <div class="field-hint" id="adminTokenHint">
          首次启动时由插件自动生成（权限 0600）。在<strong>运行 DSH 的那台机器</strong>上执行：
          <code class="inline">cat ${tokenPath}</code>
          然后把输出粘贴到上面。令牌会保存在本浏览器的 localStorage 中，公用电脑用完请清除。
        </div>
      </div>
      <button class="btn" onclick="saveAdminToken()">保存并进入</button>
    </section>

    <!-- 主体 -->
    <div id="main" style="display:none;">
      <div class="section-title">1. 鉴权状态</div>
      <div class="card">
        <div class="status-row">
          <span id="authBadge" class="badge">加载中…</span>
          <span class="muted" id="authSummary"></span>
          <span style="margin-left:auto; display:flex; gap:10px; align-items:center;">
            <label class="switch">
              <input type="checkbox" id="authToggle" onchange="onAuthToggle(this)">
              <span id="authToggleLabel">启用鉴权</span>
            </label>
          </span>
        </div>
        <p class="muted" style="margin-top:12px;">
          关闭鉴权后，任何能访问本服务端口的程序都无需 Key 即可调用全部接口（含文件读写、会话操作）。
          已生成的 Key 仍然有效，但不再校验。
        </p>
      </div>

      <div class="section-title">2. API Keys
        <label class="switch" style="margin-left:auto; font-size:13px;">
          <input type="checkbox" id="hideRevoked" onchange="boot()">
          <span>隐藏已吊销</span>
        </label>
      </div>
      <div class="card" style="padding:0; overflow:hidden;">
        <table class="key-table" id="keyTable" style="display:none;">
          <caption class="sr-only">API Key 列表</caption>
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">密钥（脱敏）</th>
              <th scope="col">创建时间</th>
              <th scope="col">最近使用</th>
              <th scope="col">状态</th>
              <th scope="col"><span class="sr-only">操作</span>操作</th>
            </tr>
          </thead>
          <tbody id="keyTbody"></tbody>
        </table>
        <div id="keyEmpty" class="empty" style="display:none;">
          <div style="font-size:15px; margin-bottom:6px;">还没有任何 API Key</div>
          <ol>
            <li>点击右上角「新建 API Key」生成密钥</li>
            <li>复制并保存到安全的地方（之后也可在列表里随时复制）</li>
            <li>在客户端请求头里带上 <code class="inline">Authorization: Bearer &lt;key&gt;</code></li>
          </ol>
          <button class="btn" onclick="openCreate()">生成第一条 Key</button>
        </div>
        <div id="keyLoading" class="empty muted">加载中…</div>
      </div>

      <div class="section-title">3. 如何在客户端使用</div>
      <div class="card">
        <p class="muted" style="margin-bottom:10px;">
          客户端请求需携带以下任一请求头。把 <code class="inline">&lt;key&gt;</code> 换成刚生成的完整密钥：
        </p>
        <div class="code-block" id="curlBox"></div>
        <div style="margin-top:12px;">
          <button class="btn btn-ghost btn-sm" onclick="copyCurl()">复制 curl 示例</button>
        </div>
        <p class="muted" style="margin-top:14px;">
          密钥明文在列表里可随时复制；管理接口只返回脱敏信息（不含哈希与明文），复制走单独的管理令牌鉴权接口。
          若密钥泄露，请立即吊销或轮换。
        </p>
        <p class="muted" style="margin-top:10px;">
          管理令牌保存在本浏览器的 localStorage 中；公用电脑用完请
          <button class="btn btn-ghost btn-sm" onclick="logoutToken()">清除本机管理令牌</button>
        </p>
      </div>
    </div>
  </div>

  <!-- 新建 -->
  <dialog id="dlgCreate" aria-labelledby="dlgCreateTitle">
    <div class="modal-head" id="dlgCreateTitle">新建 API Key</div>
    <div class="modal-body">
      <div class="field">
        <label class="field-label" for="fName">名称 <span style="color:#fca5a5;">*</span></label>
        <input type="text" id="fName" maxlength="64" placeholder="例如 py-client-prod" aria-describedby="fNameHint">
        <div class="field-hint" id="fNameHint">仅用于识别，可随时修改（1-64 字符）。</div>
        <div class="field-error" id="fNameError" style="display:none;"></div>
      </div>
      <div class="field">
        <label class="field-label" for="fKeyMode">Key 值</label>
        <select id="fKeyMode" onchange="onKeyModeChange()" aria-describedby="fKeyModeHint">
          <option value="random">随机生成（推荐 · 256 位熵）</option>
          <option value="custom">使用自定义 Key（粘贴已有 Key）</option>
        </select>
        <div class="field-hint" id="fKeyModeHint">由本服务生成随机值，强度有保证。</div>
      </div>
      <div class="field" id="fCustomWrap" style="display:none;">
        <label class="field-label" for="fCustomKey">Key 值 <span style="color:#fca5a5;">*</span></label>
        <input type="password" id="fCustomKey" autocomplete="new-password" placeholder="粘贴完整 Key（16-256 个可见 ASCII 字符）" aria-describedby="fCustomKeyHint">
        <div class="field-hint" id="fCustomKeyHint">
          自定义 Key 的强度取决于你选的值：常见词、生日、短语容易被字典猜中，建议 ≥24 位随机字符。
          <strong>本服务只保存哈希，之后无法查看或找回。</strong>
        </div>
        <div class="field-error" id="fCustomKeyError" style="display:none;"></div>
      </div>
      <div class="field">
        <label class="field-label" for="fNote">备注</label>
        <input type="text" id="fNote" maxlength="256" placeholder="选填">
      </div>
      <div class="field">
        <label class="field-label" for="fExpire">过期时间</label>
        <select id="fExpire">
          <option value="">永不过期</option>
          <option value="7">7 天后</option>
          <option value="30">30 天后</option>
          <option value="90">90 天后</option>
          <option value="365">365 天后</option>
        </select>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeDialog('dlgCreate')">取消</button>
      <button class="btn" id="btnCreateSubmit" onclick="submitCreate()">生成</button>
    </div>
  </dialog>

  <!-- 一次性展示 -->
  <dialog id="dlgReveal" aria-labelledby="dlgRevealTitle" role="alertdialog">
    <div class="modal-head" id="dlgRevealTitle">请立即保存完整 Key</div>
    <div class="modal-body">
      <div class="alert alert-warn" style="margin-bottom:14px;">
        <div id="revealHint"><strong>完整 Key</strong>关闭后列表里仍可随时「复制」，但请尽快存到安全的地方。</div>
      </div>
      <div class="reveal-box" id="revealBox" tabindex="0" aria-label="完整 API Key"></div>
      <div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn" id="btnCopyKey" onclick="copyReveal()">复制 Key</button>
      </div>
      <p class="muted" style="margin-top:12px;">
        下一步：把 Key 配置到客户端的 <code class="inline">Authorization: Bearer &lt;key&gt;</code> 头，并用页面底部的 curl 验证连通。
      </p>
    </div>
    <div class="modal-foot">
      <button class="btn" id="btnRevealDone" onclick="closeReveal()">我已保存，关闭</button>
    </div>
  </dialog>

  <!-- 改名 -->
  <dialog id="dlgRename" aria-labelledby="dlgRenameTitle">
    <div class="modal-head" id="dlgRenameTitle">重命名</div>
    <div class="modal-body">
      <div class="field">
        <label class="field-label" for="fRename">名称</label>
        <input type="text" id="fRename" maxlength="64">
      </div>
      <div class="field">
        <label class="field-label" for="fRenameNote">备注</label>
        <input type="text" id="fRenameNote" maxlength="256">
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeDialog('dlgRename')">取消</button>
      <button class="btn" onclick="submitRename()">保存</button>
    </div>
  </dialog>

  <!-- 轮换 -->
  <dialog id="dlgRotate" aria-labelledby="dlgRotateTitle">
    <div class="modal-head" id="dlgRotateTitle">轮换 Key</div>
    <div class="modal-body">
      <div class="alert alert-warn">
        <div>
          <strong>旧 Key 将立即失效</strong>
          所有正在使用该 Key 的客户端会同时收到 401。新 Key 可在列表里复制。
        </div>
      </div>
      <p class="muted">
        更稳妥的做法是：先「新建」一条替代 Key 并分发，确认客户端切换完成后再「吊销」旧 Key。
      </p>
      <div class="field" style="margin-top:14px;">
        <label class="field-label" for="fRotateName">确认名称</label>
        <input type="text" id="fRotateName" placeholder="输入 Key 名称以确认" aria-describedby="fRotateHint">
        <div class="field-hint" id="fRotateHint">目标：<strong id="rotateTargetName"></strong></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeDialog('dlgRotate')">取消</button>
      <button class="btn btn-danger" id="btnRotateSubmit" onclick="submitRotate()">仍要立即轮换</button>
    </div>
  </dialog>

  <!-- 吊销 -->
  <dialog id="dlgRevoke" aria-labelledby="dlgRevokeTitle">
    <div class="modal-head" id="dlgRevokeTitle">吊销 Key</div>
    <div class="modal-body">
      <div class="alert alert-danger">
        <div>
          <strong>此操作无法撤销</strong>
          吊销后，使用此 Key 的所有客户端会立即收到 401，需要重新生成 Key 才能恢复。
        </div>
      </div>
      <div class="field" style="margin-top:14px;">
        <label class="field-label" for="fRevokeName">输入 Key 名称以确认</label>
        <input type="text" id="fRevokeName" placeholder="输入 Key 名称以确认" aria-describedby="fRevokeHint">
        <div class="field-hint" id="fRevokeHint">目标：<strong id="revokeTargetName"></strong></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeDialog('dlgRevoke')">取消</button>
      <button class="btn btn-danger" id="btnRevokeSubmit" onclick="submitRevoke()" disabled>确认吊销</button>
    </div>
  </dialog>

  <!-- 删除已吊销记录 -->
  <dialog id="dlgDelete" aria-labelledby="dlgDeleteTitle">
    <div class="modal-head" id="dlgDeleteTitle">删除记录</div>
    <div class="modal-body">
      <div class="alert alert-danger">
        <div>
          <strong>将从列表中永久移除该记录</strong>
          目标：<strong id="deleteTargetName"></strong>
          <span class="key-masked" id="deleteTargetMasked"></span>。<br>
          该 Key 已吊销、本来就不可用；删除只是清理记录，操作无法撤销。
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeDialog('dlgDelete')">取消</button>
      <button class="btn btn-danger" id="btnDeleteSubmit" onclick="submitDelete()">确认删除</button>
    </div>
  </dialog>

  <!-- 检查更新 -->
  <dialog id="dlgUpdate" aria-labelledby="dlgUpdateTitle">
    <div class="modal-head" id="dlgUpdateTitle">检查更新</div>
    <div class="modal-body">
      <div id="updateResult" style="white-space:pre-wrap; line-height:1.8;">正在检查更新…</div>
    </div>
    <div class="modal-foot">
      <a id="updateReleaseLink" href="https://github.com/toddpan/dsh-webapi/releases" data-nav="external" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" style="text-decoration:none; display:none;">打开 Releases 页</a>
      <button class="btn" onclick="closeDialog('dlgUpdate')">关闭</button>
    </div>
  </dialog>

  <div id="toast" role="status" aria-live="polite"></div>

  <script>
    'use strict';
    const BASE = ${jsBase};
    const TOKEN_PATH = ${jsTokenPath};
    const TOKEN_KEY = 'dsh_admin_token';
    let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
    let AUTHED = false;
    let KEY_CACHE = [];
    let AUTH_STATE = null;
    let currentTargetId = null;

    // ---------- 基础 ----------
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function fmtTime(ts) {
      if (!ts) return '—';
      const d = new Date(ts);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0');
    }
    function toast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.classList.remove('show'); }, 3000);
    }
    function closeDialog(id) {
      const d = document.getElementById(id);
      if (d && d.open) d.close();
    }

    async function api(path, options) {
      const opts = options || {};
      const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
      const res = await fetch(BASE + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store',
      });
      let payload = null;
      try { payload = await res.json(); } catch (e) { payload = null; }
      const r = { status: res.status, body: payload };
      // 管理令牌缺失/失效/限流：统一带回令牌门并给出取令牌的具体命令，绝不留「点按钮→401」的死胡同
      if (r.status === 401 || r.status === 403 || r.status === 429) {
        AUTHED = false;
        showGate(true);
        const reason = r.status === 429
          ? '失败次数过多，被临时限流；请等待约 60 秒后再试。'
          : esc((r.body && r.body.error) || ('HTTP ' + r.status));
        banner('warn', '<strong>需要管理令牌</strong>' + reason +
          '<br>获取命令（在运行 DSH 的那台机器上执行）：<code class="inline">cat ' + esc(TOKEN_PATH) + '</code>' +
          ' &nbsp;<button class="btn btn-ghost btn-sm" onclick="focusTokenInput()">去输入管理令牌</button>');
      }
      return r;
    }

    function isAuthFail(r) {
      return r.status === 401 || r.status === 403 || r.status === 429;
    }

    // ---------- 管理令牌闸门 ----------
    function saveAdminToken() {
      const v = document.getElementById('adminTokenInput').value.trim();
      if (!v) { toast('请输入管理令牌'); return; }
      TOKEN = v;
      localStorage.setItem(TOKEN_KEY, v);
      boot();
    }

    function focusTokenInput() {
      const el = document.getElementById('adminTokenInput');
      if (el) el.focus();
    }

    /** 所有管理操作的统一前置：未通过令牌校验就把用户带回令牌门，而不是放行后撞 401 */
    function requireAuth() {
      if (AUTHED) return true;
      showGate(true);
      banner('warn', '<strong>请先输入管理令牌</strong>密钥管理接口与普通 API Key 是两套凭证，持有 API Key 的三方客户端不能管理密钥。' +
        '<br>获取命令（在运行 DSH 的那台机器上执行）：<code class="inline">cat ' + esc(TOKEN_PATH) + '</code>');
      toast('请先输入管理令牌');
      focusTokenInput();
      return false;
    }

    function showGate(show) {
      document.getElementById('gateCard').style.display = show ? '' : 'none';
      document.getElementById('main').style.display = show ? 'none' : '';
      // 未鉴权时把页头的「新建 API Key」一并收起，避免它成为通往 401 的死胡同入口
      const btn = document.getElementById('btnCreate');
      if (btn) btn.style.display = show ? 'none' : '';
    }

    function banner(kind, html) {
      const slot = document.getElementById('bannerSlot');
      slot.innerHTML = '<div class="alert alert-' + kind + '"><div>' + html + '</div></div>';
    }

    // ---------- 加载 ----------
    async function boot() {
      if (!TOKEN) { showGate(true); return; }
      const hideEl = document.getElementById('hideRevoked');
      const includeRevoked = hideEl && hideEl.checked ? 'false' : 'true';
      const r = await api('/api-keys?includeRevoked=' + includeRevoked);
      if (isAuthFail(r)) return; // api() 已把用户带回令牌门并给出获取命令
      if (r.status !== 200 || !r.body || !r.body.ok) {
        showGate(true);
        banner('danger', '<strong>加载失败</strong>' + esc((r.body && r.body.error) || ('HTTP ' + r.status)) +
          ' &nbsp;<button class="btn btn-ghost btn-sm" onclick="boot()">重试</button>');
        return;
      }
      AUTHED = true;
      showGate(false);
      KEY_CACHE = (r.body.data && r.body.data.keys) || [];
      renderAuth(r.body.data || {});
      renderKeys();
      renderCurl();
    }

    function logoutToken() {
      TOKEN = '';
      AUTHED = false;
      localStorage.removeItem(TOKEN_KEY);
      showGate(true);
      document.getElementById('bannerSlot').innerHTML = '';
    }

    // ---------- 鉴权状态 ----------
    function renderAuth(data) {
      AUTH_STATE = data;
      const on = !!data.authEnabled;
      const badge = document.getElementById('authBadge');
      badge.textContent = on ? '鉴权已开启' : '鉴权未开启';
      badge.className = 'badge ' + (on ? 'badge-active' : 'badge-off');
      const active = data.activeKeyCount || 0;
      document.getElementById('authSummary').textContent =
        (on ? ('当前 ' + active + ' 条有效 Key') : ('API 无鉴权保护，任何人可调用')) +
        (data.authEnforcedByConfig ? ' · 由插件配置 apiKey 强制开启' : '');

      const toggle = document.getElementById('authToggle');
      toggle.checked = on;
      toggle.disabled = !!data.authEnforcedByConfig;
      document.getElementById('authToggleLabel').textContent = data.authEnforcedByConfig
        ? '启用鉴权（配置强制，不可关闭）'
        : '启用鉴权';

      const slot = document.getElementById('bannerSlot');
      slot.innerHTML = '';
      if (data.storeDegraded) {
        banner('danger', '<strong>密钥存储降级</strong>' + esc(data.storeDegradedReason || '') +
          ' 目前不放松鉴权，但请尽快检查 ' + esc(BASE) + ' 同级的 api-keys.json 文件。');
      } else if (!on) {
        banner('danger', '<strong>当前 API 无鉴权保护</strong>任何能访问本服务端口的程序都可调用全部接口（含文件读写、会话操作）。建议开启鉴权。');
      } else if (active === 0 && !data.authEnforcedByConfig) {
        banner('danger', '<strong>鉴权已开启，但没有有效的 Key</strong>所有 API 请求都会被拒绝（返回 401）。请生成一条 Key，或暂时关闭鉴权。');
      }
    }

    function onAuthToggle(input) {
      const enable = input.checked;
      if (!enable) {
        const ok = window.confirm(
          '关闭 API 鉴权？\\n\\n' +
          '关闭后，任何能访问本服务端口的程序都无需 Key 即可调用全部接口。\\n' +
          '已生成的 Key 仍有效，但不再校验。\\n\\n' +
          '确定要关闭吗？');
        if (!ok) { input.checked = true; return; }
      }
      setAuth(enable);
    }

    async function setAuth(enable) {
      const body = { enabled: enable };
      if (!enable) body.confirm = 'disable-auth';
      const r = await api('/api-keys/auth', { method: 'PUT', body: body });
      if (isAuthFail(r)) return; // api() 已把页面带回令牌门
      if (r.status !== 200 || !r.body || !r.body.ok) {
        toast('操作失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)) + '（鉴权状态未改变）');
        boot();
        return;
      }
      toast((r.body.data && r.body.data.message) || '已保存');
      boot();
    }

    // ---------- Key 列表 ----------
    function renderKeys() {
      const tbody = document.getElementById('keyTbody');
      const table = document.getElementById('keyTable');
      const empty = document.getElementById('keyEmpty');
      const loading = document.getElementById('keyLoading');
      loading.style.display = 'none';

      if (!KEY_CACHE.length) {
        table.style.display = 'none';
        empty.style.display = '';
        return;
      }
      table.style.display = '';
      empty.style.display = 'none';

      tbody.innerHTML = KEY_CACHE.map(function (k) {
        const revoked = k.status !== 'active';
        const expired = !!k.expired;
        let badge;
        if (revoked) badge = '<span class="badge badge-revoked">已吊销</span>';
        else if (expired) badge = '<span class="badge badge-revoked">已过期</span>';
        else if (k.source === 'config') badge = '<span class="badge badge-config">来自配置</span>';
        else badge = '<span class="badge badge-active">有效</span>';
        if (k.custom) badge += ' <span class="badge badge-config">自定义</span>';

        const actions = [];
        if (k.source !== 'config' && !revoked) {
          actions.push(
            '<button class="btn btn-ghost btn-sm" data-act="copy"' +
              (k.recoverable
                ? ' title="复制完整 Key"'
                : ' data-norecover="1" title="明文不可恢复（创建于加密存储启用之前），请用轮换生成新 Key"') +
              '>复制</button>',
          );
          actions.push('<button class="btn btn-ghost btn-sm" data-act="rename">重命名</button>');
          actions.push('<button class="btn btn-ghost btn-sm" data-act="rotate">轮换</button>');
          actions.push('<button class="btn btn-danger btn-sm" data-act="revoke">吊销</button>');
        } else if (revoked) {
          actions.push('<span class="muted">已于 ' + fmtTime(k.revokedAt) + ' 吊销</span>');
          actions.push('<button class="btn btn-ghost btn-sm" data-act="del">删除</button>');
        }

        return '<tr class="' + (revoked ? 'row-revoked' : '') + '" data-id="' + esc(k.id) + '">' +
          '<td data-label="名称"><div>' + esc(k.name) + '</div>' +
            (k.note ? '<div class="muted">' + esc(k.note) + '</div>' : '') + '</td>' +
          '<td data-label="密钥"><span class="key-masked">' + esc(k.masked) + '</span>' +
            (k.prefix ? '<div class="muted">' + esc(k.prefix) + '&hellip;</div>' : '') + '</td>' +
          '<td data-label="创建时间" class="muted">' + fmtTime(k.createdAt) + '</td>' +
          '<td data-label="最近使用" class="muted">' + (k.lastUsedAt ? fmtTime(k.lastUsedAt) : '从未') + '</td>' +
          '<td data-label="状态">' + badge + '</td>' +
          '<td data-label="操作" class="cell-actions">' + actions.join(' ') + '</td>' +
          '</tr>';
      }).join('');
    }

    // 事件委托：不在 HTML 里拼 JS 字符串（避免事件上下文的转义层次错误）
    document.getElementById('keyTbody').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('tr[data-id]');
      if (!row) return;
      const id = row.getAttribute('data-id');
      const act = btn.getAttribute('data-act');
      if (act === 'rename') openRename(id);
      else if (act === 'rotate') openRotate(id);
      else if (act === 'revoke') openRevoke(id);
      else if (act === 'del') openDelete(id);
      else if (act === 'copy') copyExisting(btn, id);
    });

    // ---------- 复制已创建的 Key ----------
    /**
     * 剪贴板写入：优先 Clipboard API，失败回退到临时 textarea。
     * 页面常被嵌进 GUI 侧边栏的同源 iframe，权限策略可能拒绝 clipboard.writeText。
     */
    async function writeClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch (e) { /* 落到下面的回退 */ }
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (!ok) throw new Error('浏览器拒绝了剪贴板写入');
    }

    /**
     * 复制历史 Key：向 reveal 接口取回明文后**直接写入剪贴板**。
     * 明文只存在于本次调用的局部变量，不进 DOM、不写 localStorage、不做 console 输出。
     * 历史记录（加密存储上线前创建）拿不到明文，直接引导到「轮换」。
     */
    async function copyExisting(btn, id) {
      if (!requireAuth()) return;
      const rec = KEY_CACHE.find(function (x) { return x.id === id; });
      if (rec && !rec.recoverable) {
        toast('这条 Key 创建于加密存储启用之前，明文已不可恢复；请用「轮换」生成新 Key。');
        openRotate(id);
        return;
      }
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '读取中…';
      let plaintext = '';
      try {
        const r = await api('/api-keys/' + encodeURIComponent(id) + '/reveal', { method: 'POST' });
        if (isAuthFail(r)) return;
        if (r.status !== 200 || !r.body || !r.body.ok) {
          toast((r.body && r.body.error) || ('复制失败：HTTP ' + r.status));
          if (r.body && r.body.code === 'KEY_NOT_RECOVERABLE') openRotate(id);
          return;
        }
        plaintext = r.body.data.plaintext;
        await writeClipboard(plaintext);
        toast('已复制到剪贴板' + (rec ? '：' + rec.name : ''));
        if (rec) rec.recoverable = true;
      } catch (e) {
        toast('复制失败：' + ((e && e.message) || '未知错误'));
      } finally {
        plaintext = '';
        btn.disabled = false;
        btn.textContent = label;
      }
    }

    // ---------- 新建 ----------
    function onKeyModeChange() {
      const custom = document.getElementById('fKeyMode').value === 'custom';
      document.getElementById('fCustomWrap').style.display = custom ? '' : 'none';
      document.getElementById('fKeyModeHint').textContent = custom
        ? '使用你粘贴的值作为 Key，强度由你负责。'
        : '由本服务生成随机值，强度有保证。';
      document.getElementById('btnCreateSubmit').textContent = custom ? '保存' : '生成';
      if (custom) setTimeout(function () { document.getElementById('fCustomKey').focus(); }, 30);
    }

    function openCreate() {
      if (!requireAuth()) return;
      document.getElementById('fName').value = '';
      document.getElementById('fNote').value = '';
      document.getElementById('fExpire').value = '';
      document.getElementById('fKeyMode').value = 'random';
      document.getElementById('fCustomKey').value = '';
      document.getElementById('fNameError').style.display = 'none';
      document.getElementById('fName').classList.remove('input-invalid');
      document.getElementById('fCustomKeyError').style.display = 'none';
      document.getElementById('fCustomKey').classList.remove('input-invalid');
      onKeyModeChange();
      document.getElementById('dlgCreate').showModal();
      setTimeout(function () { document.getElementById('fName').focus(); }, 30);
    }

    async function submitCreate() {
      const nameEl = document.getElementById('fName');
      const name = nameEl.value.trim();
      const errEl = document.getElementById('fNameError');
      if (!name) {
        errEl.textContent = '名称不能为空';
        errEl.style.display = '';
        nameEl.classList.add('input-invalid');
        nameEl.focus();
        return;
      }

      const custom = document.getElementById('fKeyMode').value === 'custom';
      const customKeyEl = document.getElementById('fCustomKey');
      const customErrEl = document.getElementById('fCustomKeyError');
      const plaintext = custom ? customKeyEl.value : '';
      if (custom) {
        let msg = '';
        if (!plaintext) msg = '请粘贴要设置的 Key 值';
        else if (plaintext.length < 16 || plaintext.length > 256) msg = 'Key 长度需在 16-256 个字符之间';
        else if (!/^[\\x21-\\x7e]+$/.test(plaintext)) msg = 'Key 只能包含可见 ASCII 字符（不能含空格或换行）';
        if (msg) {
          customErrEl.textContent = msg;
          customErrEl.style.display = '';
          customErrEl.classList.add('input-invalid');
          customKeyEl.classList.add('input-invalid');
          customKeyEl.focus();
          return;
        }
        customErrEl.style.display = 'none';
        customKeyEl.classList.remove('input-invalid');
      }

      const days = document.getElementById('fExpire').value;
      const btn = document.getElementById('btnCreateSubmit');
      const busyText = btn.textContent;
      btn.disabled = true;
      btn.textContent = custom ? '保存中…' : '生成中…';
      try {
        const r = await api('/api-keys', {
          method: 'POST',
          body: {
            name: name,
            note: document.getElementById('fNote').value.trim(),
            expiresInDays: days ? Number(days) : undefined,
            plaintext: custom ? plaintext : undefined,
          },
        });
        if (isAuthFail(r)) { closeDialog('dlgCreate'); return; } // api() 已把页面带回令牌门
        if (r.status !== 201 || !r.body || !r.body.ok) {
          toast((custom ? '保存失败' : '生成失败') + '，本次没有产生 Key：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
          return;
        }
        closeDialog('dlgCreate');
        showReveal(r.body.data.plaintext, r.body.data.warning);
        await boot();
        highlightRow(r.body.data.key.id);
      } finally {
        btn.disabled = false;
        btn.textContent = busyText;
      }
    }

    function highlightRow(id) {
      setTimeout(function () {
        const row = document.querySelector('tr[data-id="' + id + '"]');
        if (row) row.classList.add('row-highlight');
      }, 60);
    }

    // ---------- 一次性展示 ----------
    function showReveal(plaintext, hint) {
      if (hint) document.getElementById('revealHint').innerHTML = esc(hint);
      document.getElementById('revealBox').textContent = plaintext;
      document.getElementById('btnCopyKey').textContent = '复制 Key';
      document.getElementById('dlgReveal').showModal();
      setTimeout(function () { document.getElementById('btnCopyKey').focus(); }, 30);
    }

    async function copyReveal() {
      const text = document.getElementById('revealBox').textContent;
      try {
        await navigator.clipboard.writeText(text);
        document.getElementById('btnCopyKey').textContent = '✓ 已复制到剪贴板';
      } catch (e) {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('revealBox'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast('复制失败，已为你选中，请手动复制');
      }
    }

    function closeReveal() {
      // 关闭即从 DOM / 内存清除，不留任何副本
      document.getElementById('revealBox').textContent = '';
      closeDialog('dlgReveal');
    }

    // 防误关：Esc / 遮罩关闭时先确认
    (function guardReveal() {
      const dlg = document.getElementById('dlgReveal');
      dlg.addEventListener('cancel', function (e) {
        e.preventDefault();
        if (window.confirm('完整 Key 尚未确认保存，关闭后无法再次查看，确定关闭？')) closeReveal();
      });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden && dlg.open) {
          document.getElementById('revealBox').textContent = '[已隐藏 — 完整 Key 无法再次显示；若尚未保存，请关闭后重新生成一条]';
        }
      });
    })();

    // ---------- 重命名 ----------
    function openRename(id) {
      if (!requireAuth()) return;
      const k = KEY_CACHE.find(function (x) { return x.id === id; });
      if (!k) return;
      currentTargetId = id;
      document.getElementById('fRename').value = k.name;
      document.getElementById('fRenameNote').value = k.note || '';
      document.getElementById('dlgRename').showModal();
    }

    async function submitRename() {
      const r = await api('/api-keys/' + encodeURIComponent(currentTargetId), {
        method: 'PATCH',
        body: {
          name: document.getElementById('fRename').value.trim(),
          note: document.getElementById('fRenameNote').value.trim(),
        },
      });
      if (isAuthFail(r)) { closeDialog('dlgRename'); return; }
      if (r.status !== 200 || !r.body || !r.body.ok) {
        toast('保存失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
        return;
      }
      closeDialog('dlgRename');
      toast('已保存');
      boot();
    }

    // ---------- 轮换 ----------
    function openRotate(id) {
      if (!requireAuth()) return;
      const k = KEY_CACHE.find(function (x) { return x.id === id; });
      if (!k) return;
      currentTargetId = id;
      document.getElementById('rotateTargetName').textContent = k.name;
      document.getElementById('fRotateName').value = '';
      document.getElementById('btnRotateSubmit').disabled = true;
      document.getElementById('dlgRotate').showModal();
      const input = document.getElementById('fRotateName');
      input.oninput = function () {
        document.getElementById('btnRotateSubmit').disabled = input.value.trim() !== k.name;
      };
      setTimeout(function () { input.focus(); }, 30);
    }

    async function submitRotate() {
      const btn = document.getElementById('btnRotateSubmit');
      btn.disabled = true;
      try {
        const r = await api('/api-keys/' + encodeURIComponent(currentTargetId) + '/rotate', { method: 'POST' });
        if (isAuthFail(r)) { closeDialog('dlgRotate'); return; }
        if (r.status !== 200 || !r.body || !r.body.ok) {
          toast('轮换失败，旧 Key 仍然有效：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
          return;
        }
        closeDialog('dlgRotate');
        showReveal(r.body.data.plaintext, r.body.data.warning);
        await boot();
        highlightRow(r.body.data.key.id);
      } finally {
        btn.disabled = false;
      }
    }

    // ---------- 吊销 ----------
    function openRevoke(id) {
      if (!requireAuth()) return;
      const k = KEY_CACHE.find(function (x) { return x.id === id; });
      if (!k) return;
      currentTargetId = id;
      document.getElementById('revokeTargetName').textContent = k.name;
      const input = document.getElementById('fRevokeName');
      input.value = '';
      document.getElementById('btnRevokeSubmit').disabled = true;
      document.getElementById('dlgRevoke').showModal();
      input.oninput = function () {
        document.getElementById('btnRevokeSubmit').disabled = input.value.trim() !== k.name;
      };
      setTimeout(function () { input.focus(); }, 30);
    }

    async function submitRevoke() {
      const r = await api('/api-keys/' + encodeURIComponent(currentTargetId) + '/revoke', { method: 'POST' });
      if (isAuthFail(r)) { closeDialog('dlgRevoke'); return; }
      if (r.status !== 200 || !r.body || !r.body.ok) {
        toast('吊销失败，该 Key 仍然有效：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
        return;
      }
      closeDialog('dlgRevoke');
      toast((r.body.data && r.body.data.message) || '已吊销');
      boot();
    }

    // ---------- 删除已吊销记录 ----------
    function openDelete(id) {
      if (!requireAuth()) return;
      const k = KEY_CACHE.find(function (x) { return x.id === id; });
      if (!k) return;
      currentTargetId = id;
      document.getElementById('deleteTargetName').textContent = k.name;
      document.getElementById('deleteTargetMasked').textContent = k.masked;
      document.getElementById('dlgDelete').showModal();
      setTimeout(function () { document.getElementById('btnDeleteSubmit').focus(); }, 30);
    }

    async function submitDelete() {
      const btn = document.getElementById('btnDeleteSubmit');
      btn.disabled = true;
      try {
        const r = await api('/api-keys/' + encodeURIComponent(currentTargetId), { method: 'DELETE' });
        if (isAuthFail(r)) { closeDialog('dlgDelete'); return; }
        if (r.status !== 200 || !r.body || !r.body.ok) {
          toast('删除失败，记录仍保留：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
          return;
        }
        closeDialog('dlgDelete');
        toast((r.body.data && r.body.data.message) || '已删除');
        boot();
      } finally {
        btn.disabled = false;
      }
    }

    // ---------- 检查更新（公开端点 /system/updates，失败时给出 Releases 链接兜底） ----------
    async function checkUpdate(btn) {
      const box = document.getElementById('updateResult');
      const link = document.getElementById('updateReleaseLink');
      if (btn) btn.disabled = true;
      box.textContent = '正在检查更新…';
      link.style.display = 'none';
      document.getElementById('dlgUpdate').showModal();
      try {
        const r = await fetch(BASE + '/system/updates', { cache: 'no-store' });
        const j = await r.json();
        const d = (j && j.data) || {};
        if (!j || j.ok !== true) throw new Error((j && j.error) || ('HTTP ' + r.status));
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

    // ---------- curl ----------
    function renderCurl() {
      document.getElementById('curlBox').textContent =
        'curl -H "Authorization: Bearer <key>" ' + BASE + '/system/status\\n\\n' +
        '# 或者使用 X-API-Key 头：\\n' +
        'curl -H "X-API-Key: <key>" ' + BASE + '/system/status';
    }
    function copyCurl() {
      navigator.clipboard.writeText(document.getElementById('curlBox').textContent)
        .then(function () { toast('已复制 curl 示例'); })
        .catch(function () { toast('复制失败，请手动选中复制'); });
    }

    boot();
  </script>
  <script>${EMBED_NAV_JS}</script>
</body>
</html>`
}
