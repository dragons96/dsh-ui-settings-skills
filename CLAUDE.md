## 项目概况

- 包名：`@dsh-mixxed/dsh-client-ui-settings-skills`（npm 公共源，MIT）
- 用途：dsh 客户端插件——Web 设置中的技能管理页（按工作区组织的目录 + 启用/禁用开关，out-of-tree，harness 零改动）
- 插件 id：`ui-settings-skills`（cordis 插件 id，与包名无关，**保持不变**）
- 仓库：`github.com/dsh-mixxed/dsh-client-ui-settings-skills`（分支 main）
- 构建产物：`lib/`（gitignore，由 `prepack: npm run build` 保证新鲜，勿手改）

## 版本发布流程（记忆）

用户要求发布新版本时，严格按此流程执行：

```powershell
# 1. 前置检查
git status --short          # 工作区干净或仅预期改动
npm run typecheck
npm test                    # 当前 29 个用例

# 2. 升版本（自动 git commit + tag）
npm version patch|minor|major

# 3. 发布（prepack 自动重新构建 lib/，无需手动 build；无需 2FA 验证码）
npm publish

# 4. 验证
npm view @dsh-mixxed/dsh-client-ui-settings-skills version
npm view @dsh-mixxed/dsh-client-ui-settings-skills dist-tags

# 5. 推送
git push origin main --tags
```

发布后核对：npm 网页显示 **Public**（非 Private）、版本号与 README 渲染正常、GitHub tags 与 npm 一致。

## 踩坑记录（重要！）

1. **`publishConfig.access: "public"` 必须保留**：`@dsh-mixxed` 是**组织** scope（owner 是个人账号 `dragons96999`），组织 scoped 包默认私有。去掉 access 配置会发布成私有包——表现是发布命令返回成功，但匿名访问 404，只有登录账号在网页能看到。

2. **client 注册 id 必须等于 npm 包名**：改包名时须同步 `scripts/build.mjs` 的 `PKG_ID`（用于 `/plugins/<id>/client.js` 路由与 `__ModuleLoader__` 注册）。cordis 插件 id `ui-settings-skills` 不受影响。

3. **发布后 5 分钟内 404 属正常**：发布前若探测过包名，CDN 会缓存 404 约 5 分钟（`max-age=300`），期间 `npm view`/`npm install` 可能 404。**不是发布失败**。判断发布成功：
   - 网页可见 ✓
   - 版本端点 200：`https://registry.npmjs.org/@dsh-mixxed%2Fdsh-client-ui-settings-skills/0.1.2`
   - tarball 可下载（scoped 包 tarball 文件名**不带 scope**）：`.../-/dsh-client-ui-settings-skills-<ver>.tgz`

4. **2FA**：账号已启用 2FA，但发布无需验证码——`.npmrc` 已有 bypass-2FA granular token（`//registry.npmjs.org/:_authToken`）。若 `npm publish` 报 `E403 ... bypass 2fa`：让用户去 https://www.npmjs.com/settings/dragons96999/tokens 重新生成带 "Bypass 2FA" 的 token 并 `npm config set //registry.npmjs.org/:_authToken=npm_xxx`。

5. **发布物清单**：`files: ["lib", "cordis.patch.yml"]` + 自动包含 LICENSE、README.md、package.json（共 7 个文件）。**`cordis.patch.yml` 必须随包发布**——`dsh.bundle.patch` 指向它，缺了 profile 启动会报错。`*.tgz` 已被 gitignore。

6. **README 同步**：版本号相关示例（tgz 文件名、安装命令）若随版本变化，需同步更新 README.md（tgz 文件名是 `dsh-mixxed-dsh-client-ui-settings-skills-<version>.tgz`，scoped 包 pack 出来的名字带 scope 前缀）。

7. **bundle 自动挂载**：包声明 `dsh.bundle.patch`（指向包内 `cordis.patch.yml`）后，`dsh plugin --profile <name> add <pkg>` 的 reconcile 步骤会自动把包追加进 profile 的 `dsh.profile.bundles`，下次启动即挂载——用户无需手改 `cordis.patch.yml`（该文件是用户层，CLI 永不自动改写，这是设计使然）。补丁内 `name` 必须是 scoped 包名且**加引号**（`@` 是 YAML 保留字符）。验证命令：`dsh --profile <name> --dump-config | Select-String ui-settings-skills` + 检查 profile package.json 的 `dsh.profile.bundles`。

## 账号对照

| 项 | 值 |
|---|---|
| npm 组织 scope | `@dsh-mixxed` |
| npm 个人账号 | `dragons96999`（组织 owner） |
| GitHub | `github.com/dsh-mixxed/dsh-client-ui-settings-skills` |
