# Windows 节点注册修复部署说明

线上现象：映射 4193ac5a 在线，Windows 节点运行，但绑定失败返回 INVALID_DIRECTORY。

根因：服务端 src/access-center.ts 的 path() 仅接受 posix.isAbsolute 且禁止反斜杠，拒绝原生 Windows 盘符路径。

补丁基线：toddpan/onenat-workbuddy-web 的 feat/exec-place-ux，提交 7f75a99d35e56b27aa59ac1537c206345dea84a8。

补丁包含：
- src/access-center.ts：远程节点目录使用对应 OS 路径规则。
- src/node-directory.ts：Windows/Unix 路径校验及边界比较。
- src/node-directory.test.ts：路径与跨盘符边界测试。
- src/access-center.test.ts：Windows 原生目录配对持久化测试。

部署前核对线上源码与基线，先应用检查：

```sh
git apply --check workbuddy-windows-directory.patch
git apply workbuddy-windows-directory.patch
```

使用项目现有构建和接入测试流程构建，部署更新后的 access-center.js 和新增 node-directory.js。保留线上原文件备份，并按现有运维流程重载 onenat-workbuddy 服务。

验收：笔记本重新连接后，node.running=true、account.nodeId 非空，WorkBuddy 资源目录从待配对变为已配对；测试项目目录浏览和读取。Windows 文件修改与隔离命令执行仍禁用。

本会话尚未部署线上：SSH root@natpass.yikaihui.com 返回 Host key verification failed。需要已有可信 SSH 连接及主机指纹核验，不应关闭主机密钥检查。
