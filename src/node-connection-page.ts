/** Node account binding is independent of the API-key management gate. */
export const NODE_CONNECTION_HTML = String.raw`<style>
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
  #nodeBoundActions[hidden] { display:none !important; }
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

  <div class="node-tabs" role="tablist" aria-label="节点连接设置">
    <button class="node-tab" type="button" id="nodeTab-account" role="tab" aria-selected="true" aria-controls="nodePanel-account" onclick="selectNodeTab('account')">账号登录</button>
    <button class="node-tab" type="button" id="nodeTab-workspace" role="tab" aria-selected="false" aria-controls="nodePanel-workspace" onclick="selectNodeTab('workspace')">工作区目录</button>
    <button class="node-tab" type="button" id="nodeTab-onenat" role="tab" aria-selected="false" aria-controls="nodePanel-onenat" onclick="selectNodeTab('onenat')">oneNat 客户端</button>
  </div>

  <div id="nodePanel-account" role="tabpanel" aria-labelledby="nodeTab-account">
    <p class="muted" style="margin:0 0 12px;">登录 WorkBuddy 后自动开通外网连接，并将这台机器添加为你的 DSH 节点。</p>
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
      <button class="btn" id="nodeLoginButton" type="submit">登录并绑定 DSH</button>
    </form>
    <div id="nodeBoundActions" hidden style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
      <strong id="nodeBoundAccount"></strong>
      <span class="badge" id="nodePasswordSaved" hidden>已记住密码</span>
      <button class="btn btn-ghost btn-sm" id="nodeForgetPassword" onclick="forgetNodePassword()" hidden>清除记住的密码</button>
      <a id="nodeOpenWorkBuddy" class="btn" target="_blank" rel="noopener noreferrer">打开 WorkBuddy</a>
      <button class="btn btn-ghost" id="nodeReconnectButton" onclick="loginWorkBuddy(null)">重新连接</button>
      <button class="btn btn-ghost" onclick="showNodeLoginForm()">重新登录</button>
      <button class="btn btn-ghost" id="nodeStopButton" onclick="stopNodeConnection()">断开外网连接</button>
    </div>
    <details style="margin-top:14px;"><summary style="cursor:pointer;">手动接入其他 WorkBuddy</summary>
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
    <p class="muted" style="margin:0 0 12px;">oneNat 客户端负责把本机 DSH 服务映射为外网 HTTPS 地址。登录绑定后会自动下载安装并启动。</p>
    <dl class="node-facts">
      <dt>安装状态</dt><dd id="nodeOnenatInstall">—</dd>
      <dt>客户端版本</dt><dd id="nodeOnenatVersion">—</dd>
      <dt>运行状态</dt><dd id="nodeOnenatRun">—</dd>
      <dt>进程</dt><dd id="nodeOnenatProcess">—</dd>
      <dt>最近错误</dt><dd id="nodeOnenatError">—</dd>
    </dl>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
      <button class="btn btn-ghost" id="nodeOnenatCheck" onclick="checkNodeOnenatUpdate()">检查更新</button>
      <button class="btn" id="nodeOnenatUpgrade" onclick="upgradeNodeOnenat(false)" hidden>升级</button>
      <button class="btn btn-ghost" id="nodeOnenatReinstall" onclick="upgradeNodeOnenat(true)">重新安装</button>
    </div>
    <p class="muted" id="nodeOnenatUpdateInfo" style="margin:10px 0 0;"></p>
    <div style="margin-top:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <strong style="font-size:14px;">最近日志</strong>
        <button class="btn btn-ghost btn-sm" id="nodeOnenatLogsRefresh" onclick="loadNodeOnenatLogs()">刷新</button>
      </div>
      <pre class="node-logs" id="nodeOnenatLogs">暂无日志</pre>
    </div>
  </div>
</section>`
export const NODE_CONNECTION_SCRIPT = String.raw`
    var NODE_SETUP_TOKEN = '';
    var NODE_BUSY = false;
    var NODE_TICKET_TIMER = 0;
    var NODE_STATE_TIMER = 0;
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
      'nodeWsSave', 'nodeWsReset', 'nodeOnenatCheck', 'nodeOnenatUpgrade', 'nodeOnenatReinstall',
      'nodeForgetPassword', 'nodeOnenatLogsRefresh'];
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
      document.getElementById('nodeOnenatProcess').textContent = t.startedAt
        ? '已运行 ' + nodeFormatDuration(Date.now() - t.startedAt) + ' · 本次会话自动重启 ' + t.restarts + ' 次'
        : '—';
      document.getElementById('nodeOnenatError').textContent = t.error || '—';
    }
    async function loadNodeConnection() {
      try {
        var data = await nodeApi(''), t = data.tunnel, a = data.account || {};
        var dot = document.getElementById('nodeStatusDot');
        dot.className = 'node-dot ' + (NODE_PHASE_CLASS[t.phase] || 'is-stopped');
        var errorText = data.error || t.error || '';
        document.getElementById('nodeStatusText').textContent = (NODE_PHASE_NAMES[t.phase] || t.phase) + (errorText ? ' · ' + errorText : '');
        var versionTag = document.getElementById('nodeClientVersion');
        versionTag.hidden = !t.releaseTag;
        if (t.releaseTag) versionTag.textContent = t.releaseTag;
        document.getElementById('nodePublicUrl').textContent = t.origin || t.publicUrl || '尚未连接';
        var form = document.getElementById('nodeAccountForm');
        if (!document.getElementById('nodeWorkBuddyUrl').value) document.getElementById('nodeWorkBuddyUrl').value = a.serverUrl || '';
        if (!document.getElementById('nodeWorkBuddyUsername').value) document.getElementById('nodeWorkBuddyUsername').value = a.username || '';
        if (!document.getElementById('nodeWorkBuddyName').value) document.getElementById('nodeWorkBuddyName').value = a.name || data.name || '';
        document.getElementById('nodeBoundActions').hidden = !a.nodeId;
        if (a.nodeId) {
          form.hidden = !NODE_SHOW_LOGIN_FORM;
          document.getElementById('nodeBoundAccount').textContent = a.username + ' · 已绑定';
          document.getElementById('nodeOpenWorkBuddy').href = a.serverUrl;
        }
        document.getElementById('nodePasswordSaved').hidden = !a.passwordSaved;
        document.getElementById('nodeForgetPassword').hidden = !a.passwordSaved;
        document.getElementById('nodeStopButton').hidden = !t.running;
        renderNodeWorkspace(data.workspace || { mode: 'default', defaults: [], custom: [], effective: [] });
        renderNodeOnenat(t);
        if (!NODE_BUSY) nodeStatusMessage('');
      } catch (err) { if (!NODE_BUSY) nodeStatusMessage(err.message || '请在本机 DSH 界面操作，或先输入管理令牌'); }
    }
    function nodeSetBusy(busy) {
      NODE_BUSY = busy;
      NODE_BUSY_IDS.forEach(function(id) { document.getElementById(id).disabled = busy; });
    }
    function showNodeLoginForm() {
      NODE_SHOW_LOGIN_FORM = true;
      document.getElementById('nodeAccountForm').hidden = false;
      document.getElementById('nodeWorkBuddyPassword').focus();
    }
    async function loginWorkBuddy(event) {
      if (event) event.preventDefault();
      if (NODE_BUSY) return;
      clearNodeTicket(); nodeSetBusy(true);
      nodeStatusMessage('正在登录、安装客户端并绑定节点，首次连接需要下载，请稍候…');
      try {
        var data = event ? await nodeApi('/login', {
          serverUrl: document.getElementById('nodeWorkBuddyUrl').value.trim(),
          username: document.getElementById('nodeWorkBuddyUsername').value.trim(),
          password: document.getElementById('nodeWorkBuddyPassword').value,
          rememberPassword: document.getElementById('nodeRememberPassword').checked,
          name: document.getElementById('nodeWorkBuddyName').value.trim()
        }) : await nodeApi('/bind', {});
        NODE_SHOW_LOGIN_FORM = false;
        nodeStatusMessage('绑定成功，这台 DSH 已加入你的 WorkBuddy。');
        toast('DSH 节点已绑定到 ' + data.username);
      } catch (err) { nodeStatusMessage(err.message || '绑定失败，请重试'); }
      finally {
        document.getElementById('nodeWorkBuddyPassword').value = '';
        nodeSetBusy(false); await loadNodeConnection(); if (AUTHED) loadService();
      }
    }
    async function forgetNodePassword() {
      if (NODE_BUSY) return;
      nodeSetBusy(true);
      try { await nodeApi('/forget-password', {}); toast('已清除记住的密码'); await loadNodeConnection(); }
      catch (err) { nodeStatusMessage(err.message); }
      finally { nodeSetBusy(false); }
    }
    async function stopNodeConnection() {
      if (NODE_BUSY) return;
      nodeSetBusy(true); clearNodeTicket();
      try { await nodeApi('/stop', {}); }
      catch (err) { nodeStatusMessage(err.message); }
      finally { nodeSetBusy(false); await loadNodeConnection(); }
    }
    async function generateNodeTicket() {
      if (NODE_BUSY) return;
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
      if (NODE_BUSY) return;
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
      if (NODE_BUSY) return;
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
      if (NODE_BUSY) return;
      nodeSetBusy(true);
      document.getElementById('nodeOnenatUpdateInfo').textContent = '正在检查更新…';
      try {
        var data = await nodeApi('/onenat/update');
        NODE_UPDATE = data;
        var info = document.getElementById('nodeOnenatUpdateInfo');
        var upgrade = document.getElementById('nodeOnenatUpgrade');
        if (!data.installed) { info.textContent = '客户端尚未安装；最新版本 ' + data.latest + '，登录绑定后会自动安装。'; upgrade.hidden = true; }
        else if (data.updateAvailable) {
          info.textContent = '发现新版本：本地 ' + data.current + ' → 最新 ' + data.latest;
          upgrade.textContent = '升级到 ' + data.latest;
          upgrade.hidden = false;
        } else { info.textContent = '已是最新版本 ' + data.current + '（远端最新 ' + data.latest + '）'; upgrade.hidden = true; }
      } catch (err) { document.getElementById('nodeOnenatUpdateInfo').textContent = err.message; }
      finally { nodeSetBusy(false); }
    }
    async function upgradeNodeOnenat(force) {
      if (NODE_BUSY) return;
      nodeSetBusy(true);
      nodeStatusMessage(force ? '正在重新安装 ONENAT 客户端，隧道会短暂中断…' : '正在升级 ONENAT 客户端，隧道会短暂中断…');
      try {
        var data = await nodeApi('/onenat/upgrade', { force: !!force });
        if (data.noop) toast(data.message || '已是最新版本');
        else toast('客户端已更新到 ' + (data.releaseTag || '最新版本'));
        await loadNodeConnection();
      } catch (err) { nodeStatusMessage(err.message); }
      finally {
        nodeSetBusy(false);
        if (!NODE_UPDATE || !NODE_UPDATE.updateAvailable) document.getElementById('nodeOnenatUpgrade').hidden = true;
      }
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
      NODE_STATE_TIMER = setInterval(function() { if (!NODE_BUSY) loadNodeConnection(); }, 15000);
    }
    window.addEventListener('pagehide', function() {
      clearNodeTicket(); clearInterval(NODE_STATE_TIMER); clearInterval(NODE_LOGS_TIMER); NODE_SETUP_TOKEN = '';
    });
    initNodeConnection();
`
