/** Node account binding is independent of the API-key management gate. */
export const NODE_CONNECTION_HTML = String.raw `<style>
  .node-tabs { display:flex; gap:2px; border-bottom:1px solid var(--dsw-alias-border-l2); margin:4px 0 16px; overflow-x:auto; scrollbar-width:none; }
  .node-tabs::-webkit-scrollbar { display:none; }
  .node-tab { appearance:none; background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-1px; padding:8px 14px; font:inherit; font-size:14px; color:var(--dsw-alias-label-secondary); cursor:pointer; white-space:nowrap; }
  .node-tab:hover { color:var(--dsw-alias-label-primary); }
  .node-tab[aria-selected="true"] { color:var(--dsw-alias-label-primary); border-bottom-color:var(--dsw-alias-label-primary); font-weight:600; }
  .node-dot { flex:none; display:inline-block; width:10px; height:10px; border-radius:50%; background:var(--dsw-alias-label-caption); }
  .node-dot.is-online { background:var(--dsw-alias-state-success-primary); }
  .node-dot.is-connecting { background:var(--dsw-alias-state-warn-primary); animation:nodePulse 1.2s var(--ds-ease-in-out) infinite; }
  .node-dot.is-error { background:var(--dsw-alias-state-error-primary); }
  @keyframes nodePulse { 50% { opacity:.35; } }
  .node-statusbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
  /* 行内 display:flex 会压过 hidden 属性的 UA 样式，这里用 !important 补上 */
  #nodeConnectionCard [hidden] { display:none !important; }
  .node-actions { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
  .node-account-summary { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px; }
  .node-secondary { border-top:1px solid var(--dsw-alias-border-l2); margin-top:18px; padding-top:14px; }
  .node-secondary > summary { cursor:pointer; color:var(--dsw-alias-label-secondary); }
  .node-note { padding:10px 12px; margin:0 0 14px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; color:var(--dsw-alias-label-secondary); line-height:1.6; }
  #nodeConnectionStatus:empty { display:none; }
  #nodeInstallProgress { border:1px solid var(--dsw-alias-border-l2); border-radius:10px; padding:12px 14px; }
  #nodeInstallBar { accent-color:var(--dsw-alias-state-business-primary,#4176e6); height:6px; }
  .node-facts { display:grid; grid-template-columns:auto 1fr; gap:6px 18px; margin:0 0 14px; }
  .node-facts dt { color:var(--dsw-alias-label-secondary); white-space:nowrap; }
  .node-facts dd { margin:0; word-break:break-all; }
  .node-root-list { margin:6px 0 0; padding-left:18px; }
  .node-root-list li { font-family:var(--ds-font-family-code); font-size:13px; word-break:break-all; }
  .node-root-rows { list-style:none; margin:8px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; }
  .node-root-row { display:flex; align-items:center; gap:8px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; padding:6px 10px; }
  .node-root-row code { flex:1; font-family:var(--ds-font-family-code); font-size:13px; word-break:break-all; }
  .node-picker { border:1px solid var(--dsw-alias-border-l2); border-radius:12px; padding:14px; width:min(560px,92vw); max-height:74vh; background:var(--dsw-alias-bg-layer-1); color:inherit; }
  .node-picker::backdrop { background:var(--dsw-alias-bg-mask-1); }
  .node-picker-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .node-picker-path { display:flex; gap:8px; align-items:flex-start; margin-bottom:8px; }
  .node-picker-path code { flex:1; font-family:var(--ds-font-family-code); font-size:12px; word-break:break-all; }
  .node-picker-list { list-style:none; margin:0; padding:0; max-height:280px; overflow:auto; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; }
  .node-picker-list li { padding:7px 12px; cursor:pointer; font-family:var(--ds-font-family-code); font-size:13px; border-bottom:1px solid var(--dsw-alias-border-l1); }
  .node-picker-list li:last-child { border-bottom:none; }
  .node-picker-list li:hover { background:var(--dsw-alias-interactive-bg-hover); }
  .node-picker-foot { display:flex; flex-direction:column; gap:8px; margin-top:10px; }
  .node-picker-manual { display:flex; gap:8px; }
  .node-picker-manual input { flex:1; }
  .node-logs { max-height:280px; overflow:auto; background:var(--dsw-alias-markdown-code-block); border:1px solid var(--dsw-alias-border-l2); border-radius:8px; padding:10px 12px; font-family:var(--ds-font-family-code); font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-all; margin:8px 0 0; }
  /* 安装进度条：percent 未知时走不定态动画（参考 dsh-onenat 引擎安装进度语义） */
  .node-progress { height:6px; border-radius:999px; overflow:hidden; background:var(--dsw-alias-border-l1); margin-top:10px; }
  .node-progress > i { display:block; height:100%; width:0; background:var(--dsw-alias-state-business-primary,#4176e6); transition:width .3s var(--ds-ease-in-out); }
  .node-progress.indeterminate > i { width:35%; animation:nodeSlide 1.1s var(--ds-ease-in-out) infinite; }
  @keyframes nodeSlide { from { margin-left:-35%; } to { margin-left:100%; } }
  @media (prefers-reduced-motion: reduce) { .node-progress.indeterminate > i { animation:none; width:100%; opacity:.5; } }
</style>
<div class="section-title">连接到 WorkBuddy</div>
<section class="card" id="nodeConnectionCard" aria-label="WorkBuddy 节点连接">
  <div class="node-statusbar">
    <span class="node-dot is-stopped" id="nodeStatusDot" aria-hidden="true"></span>
    <strong id="nodeStatusText">正在读取连接状态…</strong>
    <span class="badge" id="nodeClientVersion" hidden></span>
  </div>
  <div class="url-row" style="margin:0 0 12px;"><code class="inline svc-url" id="nodePublicUrl">尚未连接</code></div>
  <p id="nodeConnectionStatus" class="muted" role="status" aria-live="polite" style="margin:0 0 16px;"></p>

  <div id="nodeInstallProgress" hidden style="margin:0 0 16px;" role="status" aria-live="polite">
    <strong id="nodeInstallPhase"></strong>
    <p id="nodeInstallMessage" class="muted" style="margin:4px 0;"></p>
    <progress id="nodeInstallBar" max="100" aria-label="ONENAT 安装进度" style="width:100%;"></progress>
    <div id="nodeInstallDetails" class="muted" style="margin-top:4px;"></div>
  </div>

  <div class="node-tabs" role="tablist" aria-label="节点连接设置">
    <button class="node-tab" type="button" id="nodeTab-account" role="tab" aria-selected="true" aria-controls="nodePanel-account" onclick="selectNodeTab('account')">账号登录</button>
    <button class="node-tab" type="button" id="nodeTab-workspace" role="tab" aria-selected="false" aria-controls="nodePanel-workspace" onclick="selectNodeTab('workspace')">工作区目录</button>
    <button class="node-tab" type="button" id="nodeTab-onenat" role="tab" aria-selected="false" aria-controls="nodePanel-onenat" onclick="selectNodeTab('onenat')">oneNat 客户端</button>
  </div>

  <div id="nodePanel-account" role="tabpanel" aria-labelledby="nodeTab-account">
    <p class="muted" id="nodeAccountIntro" style="margin:0 0 12px;">登录 WorkBuddy，自动建立外网连接并绑定 DSH 节点。</p>
    <p class="node-note" id="nodePlatformNotice" hidden>Windows 支持 ONENAT 外网连接，暂不支持安全节点绑定和远程任务执行。</p>
    <form id="nodeAccountForm" onsubmit="loginWorkBuddy(event)">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;">
        <div class="field"><label class="field-label" for="nodeWorkBuddyUrl">WorkBuddy 地址</label><input id="nodeWorkBuddyUrl" type="url" autocomplete="url" required placeholder="https://你的 WorkBuddy 地址"></div>
        <div class="field"><label class="field-label" for="nodeWorkBuddyUsername">账号</label><input id="nodeWorkBuddyUsername" autocomplete="username" required></div>
        <div class="field"><label class="field-label" for="nodeWorkBuddyPassword">密码</label><input id="nodeWorkBuddyPassword" type="password" autocomplete="current-password" required></div>
      </div>
      <label style="display:flex;gap:8px;align-items:center;margin:12px 0 0;">
        <input type="checkbox" id="nodeRememberPassword">
        <span>记住密码<span class="muted">（加密保存在本机，会话过期后自动重新登录）</span></span>
      </label>
      <details style="margin:10px 0 14px;"><summary style="cursor:pointer;">节点名称（可选）</summary>
        <div class="field" style="margin-top:10px;max-width:420px;"><input id="nodeWorkBuddyName" maxlength="64" aria-label="节点名称" placeholder="默认使用本机名称"></div>
      </details>
      <div class="node-actions">
        <button class="btn" id="nodeLoginButton" type="submit">登录并连接</button>
        <button class="btn btn-ghost" id="nodeCancelLogin" type="button" onclick="cancelNodeLoginForm()" hidden>取消修改</button>
      </div>
    </form>
    <div id="nodeBoundActions" hidden>
      <div class="node-account-summary"><strong id="nodeBoundAccount"></strong><span class="badge" id="nodePasswordSaved" hidden>密码已加密保存</span></div>
      <div class="node-actions">
        <button class="btn" id="nodeReconnectButton" onclick="loginWorkBuddy(null)">连接</button>
        <a id="nodeOpenWorkBuddy" class="btn btn-ghost" target="_blank" rel="noopener noreferrer">打开 WorkBuddy</a>
        <button class="btn btn-ghost" id="nodeStopButton" onclick="stopNodeConnection()">断开连接</button>
      </div>
      <details class="node-secondary"><summary>账号设置</summary>
        <div class="node-actions" style="margin-top:12px;">
          <button class="btn btn-ghost btn-sm" id="nodeChangeAccount" onclick="showNodeLoginForm()">修改账号或密码</button>
          <button class="btn btn-ghost btn-sm" id="nodeForgetPassword" onclick="forgetNodePassword()" hidden>清除保存的密码</button>
        </div>
      </details>
    </div>
    <details class="node-secondary" id="nodeManualPairing"><summary>高级：手动接入其他 WorkBuddy</summary>
      <p class="muted">已建立公网连接时，可生成 5 分钟有效的一次性连接信息，在另一端手动粘贴添加。此操作需要本机管理令牌。</p>
      <button class="btn btn-ghost" id="nodeGenerateButton" onclick="generateNodeTicket()">生成连接信息</button>
      <div id="nodeConnectionResult" hidden style="margin-top:12px;">
        <textarea id="nodeConnectionInfo" aria-label="一次性连接信息" readonly autocomplete="off" spellcheck="false" rows="4" style="width:100%;font-family:monospace;resize:vertical;"></textarea>
        <p id="nodeConnectionExpiry" class="muted"></p>
        <button class="btn btn-ghost" onclick="copyNodeConnection()">复制连接信息</button>
      </div>
    </details>
  </div>

  <div id="nodePanel-workspace" role="tabpanel" aria-labelledby="nodeTab-workspace" hidden>
    <p class="muted" style="margin:0 0 12px;">工作区目录是注册节点后暴露给 WorkBuddy 的文件访问范围。默认跟随 DSH 当前打开的工作区；可切换为自定义目录列表。</p>
    <div role="radiogroup" aria-label="工作区目录来源" style="display:flex;gap:18px;flex-wrap:wrap;margin:0 0 12px;">
      <label style="display:flex;gap:6px;align-items:center;"><input type="radio" name="nodeWsMode" id="nodeWsModeDefault" value="default" onchange="onNodeWsModeChange()">跟随 DSH 工作区（默认）</label>
      <label style="display:flex;gap:6px;align-items:center;"><input type="radio" name="nodeWsMode" id="nodeWsModeCustom" value="custom" onchange="onNodeWsModeChange()">自定义目录</label>
    </div>
    <div id="nodeWsDefaultsBlock" hidden>
      <div class="field-label">默认目录（只读）</div>
      <ul id="nodeWsDefaults" class="node-root-list"></ul>
    </div>
    <div id="nodeWsCustomField" hidden style="margin-top:12px;">
      <div class="field-label">已选目录</div>
      <ul id="nodeWsSelected" class="node-root-rows"></ul>
      <p class="muted" id="nodeWsEmpty" style="margin:6px 0 0;">尚未选择目录，点下方按钮浏览选择。</p>
      <button class="btn btn-ghost" id="nodeWsBrowse" style="margin-top:10px;" onclick="openNodeWsPicker()">＋ 选择目录</button>
      <div class="field-hint" style="margin-top:8px;">不能使用根目录；最多 64 个。保存后如已绑定节点，会自动重新绑定并同步到 WorkBuddy。</div>
    </div>
    <div style="display:flex;gap:10px;margin-top:14px;">
      <button class="btn" id="nodeWsSave" onclick="saveNodeWorkspace()">保存并应用</button>
      <button class="btn btn-ghost" id="nodeWsReset" onclick="resetNodeWorkspace()">恢复默认</button>
    </div>
    <p class="muted" id="nodeWsStatus" role="status" style="margin:10px 0 0;"></p>
    <dialog id="nodeWsPicker" class="node-picker" aria-label="选择工作区目录">
      <div class="node-picker-head">
        <strong>选择目录</strong>
        <button class="btn btn-ghost btn-sm" type="button" onclick="closeNodeWsPicker()">关闭</button>
      </div>
      <div class="node-picker-path">
        <button class="btn btn-ghost btn-sm" type="button" id="nodeWsUp" onclick="upNodeWsDir()">上一级</button>
        <code id="nodeWsCurrent">读取中…</code>
      </div>
      <ul class="node-picker-list" id="nodeWsList"></ul>
      <div class="node-picker-foot">
        <button class="btn" type="button" id="nodeWsPick" onclick="pickNodeWsCurrent()">选择当前目录</button>
        <div class="node-picker-manual">
          <input id="nodeWsManual" placeholder="或手动输入绝对路径（支持 ~ 开头）" aria-label="手动输入目录路径" spellcheck="false">
          <button class="btn btn-ghost btn-sm" type="button" onclick="addNodeWsManual()">添加</button>
        </div>
      </div>
    </dialog>
  </div>

  <div id="nodePanel-onenat" role="tabpanel" aria-labelledby="nodeTab-onenat" hidden>
    <p class="muted" style="margin:0 0 12px;">客户端负责建立外网 HTTPS 连接。账号连接时会自动安装并启动，也可以在此提前下载（约 15 MB）。</p>
    <dl class="node-facts">
      <dt>安装状态</dt><dd id="nodeOnenatInstall">—</dd>
      <dt>客户端版本</dt><dd id="nodeOnenatVersion">—</dd>
      <dt>运行状态</dt><dd id="nodeOnenatRun">—</dd>
      <dt>进程</dt><dd id="nodeOnenatProcess">—</dd>
      <dt>最近错误</dt><dd id="nodeOnenatError">—</dd>
    </dl>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
      <button class="btn" id="nodeOnenatDownload" onclick="installNodeOnenat(false)">下载安装客户端</button>
      <button class="btn btn-ghost" id="nodeOnenatCheck" onclick="checkNodeOnenatUpdate()">检查更新</button>
      <button class="btn" id="nodeOnenatUpgrade" onclick="upgradeNodeOnenat(false)" hidden>升级</button>
    </div>
    <p class="muted" id="nodeOnenatUpdateInfo" style="margin:10px 0 0;"></p>
    <details class="node-secondary" id="nodeClientMaintenance"><summary>维护与诊断</summary>
      <p class="muted">客户端异常时可重新下载。运行中的连接请先断开，再重新安装。</p>
      <button class="btn btn-ghost btn-sm" id="nodeOnenatReinstall" onclick="upgradeNodeOnenat(true)">重新下载安装</button>
    <div style="margin-top:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <strong style="font-size:14px;">最近日志</strong>
        <button class="btn btn-ghost btn-sm" id="nodeOnenatLogsRefresh" onclick="loadNodeOnenatLogs()">刷新</button>
      </div>
      <pre class="node-logs" id="nodeOnenatLogs">暂无日志</pre>
    </div>
    </details>
  </div>
</section>`;
export const NODE_CONNECTION_SCRIPT = String.raw `
    var NODE_SETUP_TOKEN = '';
    var NODE_BUSY = false;
    var NODE_TICKET_TIMER = 0;
    var NODE_STATE_TIMER = 0;
    var NODE_STATE_REQUEST = null;
    var NODE_STATE_LAST_POLL = 0;
    var NODE_INSTALL_ACTIVE = false;
    var NODE_INSTALL_STARTED_AT = 0;
    var NODE_INSTALL_FINISHED_AT = 0;
    var NODE_LOGS_TIMER = 0;
    var NODE_SHOW_LOGIN_FORM = false;
    var NODE_WS_DIRTY = false;
    var NODE_WS_SELECTED = [];
    var NODE_WS_CURRENT = '';
    var NODE_WS_PARENT = '';
    var NODE_WS_HOME = '';
    var NODE_UPDATE = null;
    var NODE_PHASE_NAMES = { stopped: '外网连接已断开', installing: '正在安装客户端', connecting: '正在建立外网连接', online: '节点已在线', error: '连接失败' };
    var NODE_PHASE_CLASS = { online: 'is-online', connecting: 'is-connecting', installing: 'is-connecting', error: 'is-error', stopped: 'is-stopped' };
    var NODE_BUSY_IDS = ['nodeLoginButton', 'nodeReconnectButton', 'nodeStopButton', 'nodeGenerateButton',
      'nodeWsSave', 'nodeWsReset', 'nodeOnenatCheck', 'nodeOnenatUpgrade', 'nodeOnenatReinstall', 'nodeOnenatDownload',
      'nodeForgetPassword', 'nodeOnenatLogsRefresh'];
    var NODE_TUNNEL_CONFIGURED = false;
    var NODE_SAVED_ACCOUNT = null;
    var NODE_REMEMBER_INITIALIZED = false;
    var NODE_LAST_STATE = null;
    function updateNodeActions() {
      var data = NODE_LAST_STATE || {}, t = data.tunnel || {}, a = data.account || {};
      var blocked = NODE_BUSY || NODE_INSTALL_ACTIVE || t.phase === 'installing' || t.phase === 'connecting';
      NODE_BUSY_IDS.forEach(function(id) { document.getElementById(id).disabled = blocked; });
      document.getElementById('nodeChangeAccount').disabled = blocked;
      document.getElementById('nodeCancelLogin').disabled = blocked;
      document.getElementById('nodeReconnectButton').hidden = !!t.running;
      document.getElementById('nodeReconnectButton').textContent = t.phase === 'error' ? '重试连接' : '连接';
      document.getElementById('nodeStopButton').hidden = !t.running;
      document.getElementById('nodeGenerateButton').disabled = blocked || !t.running || t.phase !== 'online' || !!(data.node && data.node.platform === 'win32');
      document.getElementById('nodeOnenatReinstall').disabled = blocked || !!t.running;
      document.getElementById('nodeOnenatReinstall').title = t.running ? '请先断开连接再重新安装' : '';
      document.getElementById('nodeCancelLogin').hidden = !a.configured || !NODE_SHOW_LOGIN_FORM;
      document.getElementById('nodeOnenatUpgrade').hidden = !t.installed || !NODE_UPDATE || !NODE_UPDATE.updateAvailable;
    }
    function clearNodeTicket() {
      clearTimeout(NODE_TICKET_TIMER);
      document.getElementById('nodeConnectionInfo').value = '';
      document.getElementById('nodeConnectionResult').hidden = true;
    }
    function nodeStatusMessage(text) { document.getElementById('nodeConnectionStatus').textContent = text; }
    function nodeWsMessage(text) { document.getElementById('nodeWsStatus').textContent = text; }
    function nodeFormatDuration(ms) {
      var seconds = Math.max(0, Math.floor(ms / 1000));
      if (seconds < 60) return seconds + ' 秒';
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + ' 分 ' + (seconds % 60) + ' 秒';
      return Math.floor(minutes / 60) + ' 时 ' + (minutes % 60) + ' 分';
    }
    async function nodeApi(path, body) {
      var headers = { 'Content-Type': 'application/json' };
      if (NODE_SETUP_TOKEN) headers['X-Node-Setup-Token'] = NODE_SETUP_TOKEN;
      if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
      var response = await fetch(BASE + '/node-connection' + path, {
        method: body === undefined ? 'GET' : 'POST', headers: headers, cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      var result;
      try { result = await response.json(); } catch (_) { throw new Error('节点连接接口不可用，请检查插件版本'); }
      if (!response.ok || !result.ok) throw new Error(result.error || '节点连接失败');
      return result.data;
    }
    function renderNodeWorkspace(w) {
      document.getElementById('nodeWsModeDefault').checked = w.mode !== 'custom';
      document.getElementById('nodeWsModeCustom').checked = w.mode === 'custom';
      var list = document.getElementById('nodeWsDefaults');
      list.textContent = '';
      (w.defaults || []).forEach(function(root) {
        var li = document.createElement('li');
        li.textContent = root;
        list.appendChild(li);
      });
      document.getElementById('nodeWsDefaultsBlock').hidden = !(w.defaults || []).length;
      onNodeWsModeChange();
      if (!NODE_WS_DIRTY) {
        NODE_WS_SELECTED = (w.mode === 'custom' && (w.custom || []).length ? w.custom : w.effective || []).slice();
        renderNodeWsSelected();
      }
    }
    function renderNodeWsSelected() {
      var box = document.getElementById('nodeWsSelected');
      box.textContent = '';
      NODE_WS_SELECTED.forEach(function(root, index) {
        var row = document.createElement('li');
        row.className = 'node-root-row';
        var code = document.createElement('code');
        code.textContent = root;
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-ghost btn-sm';
        remove.textContent = '移除';
        remove.onclick = function() { NODE_WS_SELECTED.splice(index, 1); NODE_WS_DIRTY = true; renderNodeWsSelected(); };
        row.appendChild(code); row.appendChild(remove);
        box.appendChild(row);
      });
      document.getElementById('nodeWsEmpty').hidden = NODE_WS_SELECTED.length > 0;
    }
    function addNodeRoot(value) {
      var target = String(value || '').trim();
      if (!target) return;
      if (target.charAt(0) === '~') target = (NODE_WS_HOME || NODE_WS_CURRENT || '/') + target.slice(1);
      if (NODE_WS_SELECTED.indexOf(target) < 0) {
        NODE_WS_SELECTED.push(target);
        NODE_WS_DIRTY = true;
        renderNodeWsSelected();
      }
    }
    function renderNodeOnenat(t) {
      document.getElementById('nodeOnenatInstall').textContent = t.installed ? '已安装' : '未安装';
      document.getElementById('nodeOnenatVersion').textContent = t.releaseTag || '—';
      var runNames = { online: '在线', connecting: '连接中', installing: '安装/升级中', stopped: '已停止', error: '异常' };
      document.getElementById('nodeOnenatRun').textContent = (runNames[t.phase] || t.phase) + (t.running ? '（进程运行中）' : '');
      document.getElementById('nodeOnenatError').textContent = t.error || '—';
      NODE_TUNNEL_CONFIGURED = !!t.configured;
      document.getElementById('nodeOnenatDownload').hidden = !!t.installed;
      document.getElementById('nodeOnenatCheck').hidden = !t.installed;
      document.getElementById('nodeOnenatReinstall').hidden = !t.installed;
      document.getElementById('nodeOnenatProcess').textContent = t.running && t.startedAt
        ? '已运行 ' + nodeFormatDuration(Date.now() - t.startedAt) + ' · 自动重启 ' + t.restarts + ' 次' : '未运行';
    }
    function nodeFormatBytes(bytes) {
      var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], unit = 0;
      while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
      return bytes.toFixed(unit ? 1 : 0) + ' ' + units[unit];
    }
    function renderNodeInstallProgress(t) {
      var progress = t.installProgress;
      var box = document.getElementById('nodeInstallProgress');
      box.hidden = !progress || progress.phase === 'done';
      NODE_INSTALL_ACTIVE = !!progress && progress.phase !== 'done' && t.phase !== 'error';
      if (!progress) {
        NODE_INSTALL_STARTED_AT = 0;
        NODE_INSTALL_FINISHED_AT = 0;
        return;
      }
      var phases = { resolving: '解析下载地址', checksums: '获取校验信息', downloading: '下载客户端', verifying: '校验下载文件', installing: '安装客户端', done: '安装完成' };
      document.getElementById('nodeInstallPhase').textContent = 'ONENAT · ' + (phases[progress.phase] || progress.phase);
      document.getElementById('nodeInstallMessage').textContent = progress.message || '';
      var validNumber = function(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; };
      var hasDone = validNumber(progress.bytesDone);
      var hasTotal = validNumber(progress.bytesTotal) && progress.bytesTotal > 0;
      var percent = validNumber(progress.percent) ? Math.min(100, progress.percent)
        : hasDone && hasTotal ? Math.min(100, progress.bytesDone / progress.bytesTotal * 100) : null;
      var bar = document.getElementById('nodeInstallBar');
      bar.hidden = t.phase === 'error';
      if (progress.phase === 'done') bar.value = 100;
      else if (percent === null) bar.removeAttribute('value');
      else bar.value = percent;
      var details = [];
      if (hasDone) details.push('已下载 ' + nodeFormatBytes(progress.bytesDone) + (hasTotal ? ' / ' + nodeFormatBytes(progress.bytesTotal) : '（总大小未知）'));
      else if (hasTotal) details.push('下载大小 ' + nodeFormatBytes(progress.bytesTotal));
      if (percent !== null) details.push(percent.toFixed(1) + '%');
      if (validNumber(progress.startedAt) && progress.startedAt > 0) {
        if (NODE_INSTALL_STARTED_AT !== progress.startedAt) {
          NODE_INSTALL_STARTED_AT = progress.startedAt;
          NODE_INSTALL_FINISHED_AT = 0;
        }
        if (NODE_INSTALL_ACTIVE) NODE_INSTALL_FINISHED_AT = 0;
        else if (!NODE_INSTALL_FINISHED_AT) NODE_INSTALL_FINISHED_AT = Date.now();
        details.push('耗时 ' + nodeFormatDuration((NODE_INSTALL_FINISHED_AT || Date.now()) - progress.startedAt));
      }
      if (validNumber(progress.attempt) && progress.attempt > 0) details.push('第 ' + progress.attempt + ' 次尝试');
      document.getElementById('nodeInstallDetails').textContent = details.join(' · ');
    }
    function loadNodeConnection() {
      if (NODE_STATE_REQUEST) return NODE_STATE_REQUEST;
      NODE_STATE_LAST_POLL = Date.now();
      NODE_STATE_REQUEST = (async function() {
      try {
        var data = await nodeApi(''), t = data.tunnel, a = data.account || {};
        NODE_LAST_STATE = data;
        var dot = document.getElementById('nodeStatusDot');
        dot.className = 'node-dot ' + (NODE_PHASE_CLASS[t.phase] || 'is-stopped');
        var transportOnly = data.node && data.node.platform === 'win32';
        document.getElementById('nodeLoginButton').textContent = transportOnly ? '登录并连接' : '登录并绑定节点';
        document.getElementById('nodeAccountIntro').textContent = transportOnly ? '登录 WorkBuddy，自动建立本机的外网连接。' : '登录 WorkBuddy，自动建立外网连接并绑定 DSH 节点。';
        document.getElementById('nodePlatformNotice').hidden = !transportOnly;
        document.getElementById('nodeManualPairing').hidden = transportOnly;
        document.getElementById('nodeStatusText').textContent = t.phase === 'online' ? (a.nodeId ? '节点已在线' : '外网连接已就绪') : (NODE_PHASE_NAMES[t.phase] || t.phase);
        document.getElementById('nodeGenerateButton').disabled = NODE_BUSY || transportOnly;
        document.getElementById('nodeGenerateButton').title = transportOnly ? 'Windows 暂不支持安全节点绑定' : '';
        var errorText = data.error || t.error || '';
        if (errorText) document.getElementById('nodeStatusText').textContent += ' · ' + errorText;
        var versionTag = document.getElementById('nodeClientVersion');
        versionTag.hidden = !t.releaseTag;
        if (t.releaseTag) versionTag.textContent = t.releaseTag;
        document.getElementById('nodePublicUrl').textContent = t.origin || t.publicUrl || '尚未连接';
        var form = document.getElementById('nodeAccountForm');
        if (!document.getElementById('nodeWorkBuddyUrl').value) document.getElementById('nodeWorkBuddyUrl').value = a.serverUrl || '';
        if (!document.getElementById('nodeWorkBuddyUsername').value) document.getElementById('nodeWorkBuddyUsername').value = a.username || '';
        if (!document.getElementById('nodeWorkBuddyName').value) document.getElementById('nodeWorkBuddyName').value = a.name || data.name || '';
        NODE_SAVED_ACCOUNT = a;
        var canReuse = !!a.configured && (!!a.passwordSaved || !!a.nodeId);
        document.getElementById('nodeBoundActions').hidden = !canReuse || NODE_SHOW_LOGIN_FORM;
        form.hidden = canReuse && !NODE_SHOW_LOGIN_FORM;
        var passwordInput = document.getElementById('nodeWorkBuddyPassword');
        passwordInput.required = !a.passwordSaved;
        passwordInput.placeholder = a.passwordSaved ? '已加密保存，留空复用；填写可更换密码' : '';
        if (!NODE_REMEMBER_INITIALIZED) {
          document.getElementById('nodeRememberPassword').checked = !!a.passwordSaved;
          NODE_REMEMBER_INITIALIZED = true;
        }
        if (canReuse) {
          document.getElementById('nodeBoundAccount').textContent = a.username + (a.nodeId ? ' · 已绑定' : ' · 已保存登录');
          document.getElementById('nodeOpenWorkBuddy').href = a.serverUrl;
        }
        document.getElementById('nodePasswordSaved').hidden = !a.passwordSaved;
        document.getElementById('nodeForgetPassword').hidden = !a.passwordSaved;
        document.getElementById('nodeStopButton').hidden = !t.running;
        renderNodeWorkspace(data.workspace || { mode: 'default', defaults: [], custom: [], effective: [] });
        renderNodeOnenat(t);
        renderNodeInstallProgress(t);
        updateNodeActions();
      } catch (err) {
        nodeStatusMessage(NODE_BUSY || NODE_INSTALL_ACTIVE
          ? '暂时无法获取进度，正在重试；下载可能仍在进行，请勿重复提交。'
          : err.message || '请在本机 DSH 界面操作，或先输入管理令牌');
      }
      })().finally(function() { NODE_STATE_REQUEST = null; });
      return NODE_STATE_REQUEST;
    }
    function nodeSetBusy(busy) {
      NODE_BUSY = busy;
      if (busy) nodeStatusMessage('');
      updateNodeActions();
    }
    function showNodeLoginForm() {
      NODE_SHOW_LOGIN_FORM = true;
      document.getElementById('nodeAccountForm').hidden = false;
      document.getElementById('nodeBoundActions').hidden = true;
      updateNodeActions();
      document.getElementById('nodeWorkBuddyPassword').focus();
    }
    function cancelNodeLoginForm() {
      NODE_SHOW_LOGIN_FORM = false;
      document.getElementById('nodeWorkBuddyPassword').value = '';
      var a = NODE_SAVED_ACCOUNT || {};
      document.getElementById('nodeWorkBuddyUrl').value = a.serverUrl || '';
      document.getElementById('nodeWorkBuddyUsername').value = a.username || '';
      document.getElementById('nodeWorkBuddyName').value = a.name || '';
      loadNodeConnection();
    }
    async function loginWorkBuddy(event) {
      if (event) event.preventDefault();
      if (NODE_BUSY || NODE_INSTALL_ACTIVE) return;
      clearNodeTicket(); nodeSetBusy(true);
      nodeStatusMessage('正在建立连接，首次使用会自动安装客户端…');
      try {
        var saved = NODE_SAVED_ACCOUNT || {};
        var reuse = !document.getElementById('nodeWorkBuddyPassword').value && saved.passwordSaved
          && document.getElementById('nodeWorkBuddyUrl').value.trim() === saved.serverUrl
          && document.getElementById('nodeWorkBuddyUsername').value.trim() === saved.username;
        var data = event && !reuse ? await nodeApi('/login', {
          serverUrl: document.getElementById('nodeWorkBuddyUrl').value.trim(),
          username: document.getElementById('nodeWorkBuddyUsername').value.trim(),
          password: document.getElementById('nodeWorkBuddyPassword').value,
          rememberPassword: document.getElementById('nodeRememberPassword').checked,
          name: document.getElementById('nodeWorkBuddyName').value.trim()
        }) : await nodeApi('/bind', {});
        NODE_SHOW_LOGIN_FORM = false;
        nodeStatusMessage(data.transportOnly ? data.message : '绑定成功，这台 DSH 已加入你的 WorkBuddy。');
        toast(data.transportOnly ? 'ONENAT 外网连接已启动' : 'DSH 节点已绑定到 ' + data.username);
      } catch (err) { nodeStatusMessage(err.message || '绑定失败，请重试'); }
      finally {
        document.getElementById('nodeWorkBuddyPassword').value = '';
        nodeSetBusy(false); await loadNodeConnection(); if (AUTHED) loadService();
      }
    }
    async function forgetNodePassword() {
      if (NODE_BUSY || NODE_INSTALL_ACTIVE) return;
      nodeSetBusy(true);
      try { await nodeApi('/forget-password', {}); NODE_REMEMBER_INITIALIZED = false; toast('已清除记住的密码'); await loadNodeConnection(); }
      catch (err) { nodeStatusMessage(err.message); }
      finally { nodeSetBusy(false); }
    }
    async function stopNodeConnection() {
      if (NODE_BUSY || NODE_INSTALL_ACTIVE) return;
      nodeSetBusy(true); clearNodeTicket();
      try { await nodeApi('/stop', {}); }
      catch (err) { nodeStatusMessage(err.message); }
      finally { nodeSetBusy(false); await loadNodeConnection(); }
    }
    async function generateNodeTicket() {
      if (NODE_BUSY || NODE_INSTALL_ACTIVE) return;
      clearNodeTicket(); nodeSetBusy(true);
      try {
        var data = await nodeApi('/pairing', {});
        document.getElementById('nodeConnectionInfo').value = data.connectionInfo;
        document.getElementById('nodeConnectionResult').hidden = false;
        document.getElementById('nodeConnectionExpiry').textContent = '有效至 ' + new Date(data.expiresAt).toLocaleTimeString() + '，用后失效；重生成会使旧码失效。';
        NODE_TICKET_TIMER = setTimeout(clearNodeTicket, Math.max(0, data.expiresAt - Date.now()));
        await copyNodeConnection();
      } catch (err) { nodeStatusMessage(err.message); }
      finally { nodeSetBusy(false); }
    }
    async function copyNodeConnection() {
      var value = document.getElementById('nodeConnectionInfo').value;
      if (!value) return;
      try { await writeClipboard(value); toast('连接信息已复制'); }
      catch (_) { document.getElementById('nodeConnectionInfo').select(); toast('请复制已选中的连接信息'); }
    }
    function onNodeWsModeChange() {
      var custom = document.getElementById('nodeWsModeCustom').checked;
      document.getElementById('nodeWsCustomField').hidden = !custom;
    }
    async function saveNodeWorkspace() {
      if (NODE_BUSY || NODE_INSTALL_ACTIVE) return;
      var mode = document.getElementById('nodeWsModeCustom').checked ? 'custom' : 'default';
      var body = { mode: mode };
      if (mode === 'custom') {
        if (!NODE_WS_SELECTED.length) { nodeWsMessage('请至少选择一个目录'); return; }
        body.roots = NODE_WS_SELECTED.slice();
      }
      nodeSetBusy(true);
      nodeWsMessage('正在保存…');
      try {
        var data = await nodeApi('/workspace', body);
        NODE_WS_DIRTY = false;
        nodeWsMessage(data.applying ? '已保存，正在重新绑定以应用新目录（完成后顶部状态会恢复为「节点已在线」）…' : '已保存，下次连接时生效。');
        toast('工作区目录已保存');
        await loadNodeConnection();
      } catch (err) { nodeWsMessage(err.message); }
      finally { nodeSetBusy(false); }
    }
    async function resetNodeWorkspace() {
      if (NODE_BUSY || NODE_INSTALL_ACTIVE) return;
      document.getElementById('nodeWsModeDefault').checked = true;
      onNodeWsModeChange();
      NODE_WS_DIRTY = false;
      await saveNodeWorkspace();
    }
    function openNodeWsPicker() {
      document.getElementById('nodeWsModeCustom').checked = true;
      onNodeWsModeChange();
      document.getElementById('nodeWsPicker').showModal();
      loadNodeWsDirs('');
    }
    function closeNodeWsPicker() { document.getElementById('nodeWsPicker').close(); }
    async function loadNodeWsDirs(target) {
      var list = document.getElementById('nodeWsList');
      list.textContent = '';
      document.getElementById('nodeWsCurrent').textContent = '读取中…';
      try {
        var data = await nodeApi('/fs-dirs' + (target ? '?path=' + encodeURIComponent(target) : ''));
        NODE_WS_CURRENT = data.path;
        NODE_WS_PARENT = data.parent || '';
        NODE_WS_HOME = data.home || NODE_WS_HOME;
        document.getElementById('nodeWsCurrent').textContent = data.path;
        document.getElementById('nodeWsUp').disabled = !NODE_WS_PARENT;
        (data.dirs || []).forEach(function(name) {
          var li = document.createElement('li');
          li.textContent = name + '/';
          li.onclick = function() { loadNodeWsDirs(data.path.replace(/\/+$/, '') + '/' + name); };
          list.appendChild(li);
        });
        if (!(data.dirs || []).length) {
          var empty = document.createElement('li');
          empty.style.cursor = 'default';
          empty.textContent = '（没有子目录）';
          list.appendChild(empty);
        }
      } catch (err) { document.getElementById('nodeWsCurrent').textContent = err.message || '读取失败'; }
    }
    function upNodeWsDir() { if (NODE_WS_PARENT) loadNodeWsDirs(NODE_WS_PARENT); }
    function pickNodeWsCurrent() { addNodeRoot(NODE_WS_CURRENT); }
    function addNodeWsManual() {
      var input = document.getElementById('nodeWsManual');
      addNodeRoot(input.value);
      input.value = '';
    }
    async function checkNodeOnenatUpdate() {
      if (NODE_BUSY || NODE_INSTALL_ACTIVE) return;
      nodeSetBusy(true);
      document.getElementById('nodeOnenatUpdateInfo').textContent = '正在检查更新…';
      try {
        var data = await nodeApi('/onenat/update');
        NODE_UPDATE = data;
        var info = document.getElementById('nodeOnenatUpdateInfo');
        var upgrade = document.getElementById('nodeOnenatUpgrade');
        if (!data.installed) { info.textContent = '客户端尚未安装；最新版本 ' + data.latest + '。可点「下载安装客户端」手动下载，进度见上方安装卡片。'; upgrade.hidden = true; }
        else if (data.updateAvailable) {
          info.textContent = '发现新版本：本地 ' + data.current + ' → 最新 ' + data.latest;
          upgrade.textContent = '升级到 ' + data.latest;
          upgrade.hidden = false;
        } else { info.textContent = '已是最新版本 ' + data.current + '（远端最新 ' + data.latest + '）'; upgrade.hidden = true; }
      } catch (err) { document.getElementById('nodeOnenatUpdateInfo').textContent = err.message; }
      finally { nodeSetBusy(false); }
    }
    /** 手动下载/安装 ONENAT 客户端（不依赖 WorkBuddy 绑定，Windows 可用）；进度经状态轮询实时渲染。 */
    async function installNodeOnenat(force) {
      if (NODE_BUSY || NODE_INSTALL_ACTIVE) return;
      nodeSetBusy(true);
      nodeStatusMessage(force ? '正在重新下载 ONENAT 客户端…' : '正在下载 ONENAT 客户端，首次下载约 15 MB，请保持网络畅通…');
      try {
        var data = await nodeApi('/onenat/install', { force: !!force });
        var message = data.noop ? data.message || '客户端已安装' : '客户端已安装 ' + (data.releaseTag || '最新版本');
        nodeStatusMessage(message);
        toast(message);
        await loadNodeConnection();
      } catch (err) { nodeStatusMessage(err.message); }
      finally { nodeSetBusy(false); }
    }
    async function upgradeNodeOnenat(force) {
      if (NODE_BUSY || NODE_INSTALL_ACTIVE) return;
      // 未配置受管隧道时（如 Windows 预装）没有可升级的在线实例：退化为纯下载安装。
      if (!NODE_TUNNEL_CONFIGURED) return installNodeOnenat(force);
      nodeSetBusy(true);
      nodeStatusMessage(force ? '正在重新安装 ONENAT 客户端，隧道会短暂中断…' : '正在升级 ONENAT 客户端，隧道会短暂中断…');
      try {
        var data = await nodeApi('/onenat/upgrade', { force: !!force });
        var message = data.noop ? data.message || '已是最新版本' : '客户端已更新到 ' + (data.releaseTag || '最新版本');
        nodeStatusMessage(message);
        toast(message);
        NODE_UPDATE = null;
        document.getElementById('nodeOnenatUpdateInfo').textContent = message;
        await loadNodeConnection();
      } catch (err) { nodeStatusMessage(err.message); }
      finally { nodeSetBusy(false); }
    }
    async function loadNodeOnenatLogs() {
      try {
        var data = await nodeApi('/onenat/logs');
        document.getElementById('nodeOnenatLogs').textContent = data.lines.length ? data.lines.join('\n') : '暂无日志';
      } catch (_) {}
    }
    function selectNodeTab(name) {
      ['account', 'workspace', 'onenat'].forEach(function(tab) {
        var active = tab === name;
        document.getElementById('nodeTab-' + tab).setAttribute('aria-selected', active ? 'true' : 'false');
        document.getElementById('nodePanel-' + tab).hidden = !active;
      });
      try { localStorage.setItem('dsh_node_tab', name); } catch (_) {}
      clearInterval(NODE_LOGS_TIMER);
      NODE_LOGS_TIMER = 0;
      if (name === 'onenat') {
        loadNodeOnenatLogs();
        NODE_LOGS_TIMER = setInterval(function() { if (!NODE_BUSY) loadNodeOnenatLogs(); }, 5000);
      }
    }
    function restoreNodeTab() {
      var saved = '';
      try { saved = localStorage.getItem('dsh_node_tab') || ''; } catch (_) {}
      selectNodeTab(['account', 'workspace', 'onenat'].indexOf(saved) >= 0 ? saved : 'account');
    }
    async function initNodeConnection() {
      try {
        var response = await fetch(BASE + '/node-connection/local-token', { cache: 'no-store' });
        var result = await response.json();
        if (response.ok && result.ok) NODE_SETUP_TOKEN = result.data.token;
      } catch (_) {}
      document.getElementById('nodeWsManual').addEventListener('keydown', function(event) { if (event.key === 'Enter') { event.preventDefault(); addNodeWsManual(); } });
      restoreNodeTab();
      await loadNodeConnection();
      clearInterval(NODE_STATE_TIMER);
      NODE_STATE_TIMER = setInterval(function() {
        if (NODE_BUSY || NODE_INSTALL_ACTIVE || Date.now() - NODE_STATE_LAST_POLL >= 15000) loadNodeConnection();
      }, 1000);
    }
    window.addEventListener('pagehide', function() {
      clearNodeTicket(); clearInterval(NODE_STATE_TIMER); clearInterval(NODE_LOGS_TIMER); NODE_SETUP_TOKEN = '';
    });
    initNodeConnection();
`;
//# sourceMappingURL=node-connection-page.js.map