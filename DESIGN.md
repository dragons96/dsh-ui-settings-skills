# ui-settings-skills 插件设计文档

> 状态：设计稿（M1 显示范围）。目标产物是一个**完全独立于 deepseek-harness 仓库**的 out-of-tree 插件，不改动 deepseek-harness 的任何基础代码。

## 1. 目标与范围

在 dsh Web 界面的设置（Settings）中新增一个独立的「技能管理」页面，实现：

- **M1（本次设计范围，只读展示）**：
  - 加载所有技能，覆盖 harness 支持的维度：harness 全局、每个工作区（workspace）、当前用户。
  - 每个技能显示作用域标签（`source` / `provider` / 维度归属）与调用面徽标（模型可调用 / 用户可调用）。
- **M2（设计契约，后续单独评审实现）**：允许按维度开启/关闭技能。

## 2. 硬约束

1. **不改 deepseek-harness 任何基础代码**：不修改 `packages/` 任何文件（含 `packages/bundle/web-app/cordis.patch.yml`），不新增 RPC 进 host 的 `rpc-map`，不改 `ctx.skills` 注册表。
2. 插件以独立 npm 包形式存在，通过 dsh 官方支持的 out-of-tree 挂载路径安装。
3. M2 的强制语义必须诚实评估：在不改基础代码的前提下，能强制到什么程度、有什么边界，文档必须写明。

## 3. 可行性结论（基于已验证的现有机制）

| 需求 | 结论 | 依据（deepseek-harness 现有机制） |
|---|---|---|
| 设置里新增独立页面 | ✅ 可行 | `settings.section` 槽（每 feature 一页），客户端插件 `ctx.slots.inject('settings.section', ...)` 注册即可，shell 自动渲染导航。参考 `packages/client/ui-agent-preset/src/client/index.ts` |
| 客户端插件 out-of-tree 挂载 | ✅ 可行 | `client-modules` 扫描 **host Loader 的条目**（任何被挂载的行，包括 profile patch 插入的行），包声明 `dsh.client`（platform `web`）+ `exports["./client"]` 即自动进 `__DSH_BOOT__`，bundle 由 `/plugins/<id>/client.js` 提供（`packages/client/modules/src/index.ts`） |
| host 侧插件 out-of-tree 挂载 | ✅ 可行 | `dsh plugin --profile <name> add <pkg>` 把包装进 profile 目录（`apps/cli/src/plugin.ts`）；profile 的 `cordis.patch.yml`（用户自有文件）insert 行；裸包名经 `healProfilesModuleFallback` 维护的 `profiles/node_modules` 解析 |
| host 插件给浏览器开数据通道 | ✅ 可行 | `ctx.webServer.register({ kind: 'prefix', path, handler })` 注册自定义 HTTP 路由（`packages/host/webserver/src/index.ts`；`client-modules` 自己的 `/plugins` 路由即此机制），浏览器同源 fetch |
| 加载"所有维度"的技能 | ✅ 可行（host 聚合） | `ctx.workspaceRegistry.list()` 返回每个工作区的 `path`（`packages/host/apiproxy/src/api/workspace.ts` WorkspaceView）；`ctx.skills.snapshot({ cwd })` 按项目根取目录。现有 `skill.list` RPC 是 session 寻址、只读（`packages/host/apiproxy/src/api/skills.ts`），覆盖不了所有维度，因此需要插件自己的聚合 API |
| 作用域标签 | ✅ 可行 | `SkillSummary.source`（`project-dsh`/`project-agents`/`runtime`/`user-dsh`/`user-agents`/`custom`/`bundled`）+ `provider` + `invocation`（`modelInvocable`/`userInvocable`）（`packages/skill/skill/src/index.ts`） |
| 开启/关闭（M2） | ⚠️ 有条件可行 | `ctx.skills` 是分层注册表（global + agent 作用域链），**最近层同名直接赢**；同层内按 `rank → providerOrder → localOrder` 决出。可用"策略 provider 以最高优先级（rank 0）返回 stub 候选遮蔽被禁技能"实现强制过滤，详见 §7。但存在诚实边界（见 §7.4） |
| "用户"维度 | ⚠️ 有产品限制 | 产品当前只有**单匿名用户**（`packages/identity/README.md`：一个 Harness-home 匿名 id，仅用于遥测/反馈）。不存在多用户模型，因此"枚举所有用户"不可能；M1 的"用户"维度 = 当前用户的偏好层（数据与全局同源，标签区分）。多用户枚举超出插件能力范围，属产品级决策 |

## 4. 架构总览

```
浏览器 (Web Client)                         host 进程 (dsh --profile web)
┌─────────────────────────┐               ┌──────────────────────────────────┐
│ ui-settings-skills        │               │ ui-settings-skills (node half)  │
│ (client half, 双面包)    │  fetch ①      │  inject: skills,                 │
│  settings.section 页面   │ ────────────▶ │          workspaceRegistry,      │
│  技能列表/标签/维度       │ ◀──────────── │          webServer               │
│                         │    JSON       │  GET /plugin/settings-skills/…    │
└─────────────────────────┘               │    聚合: 全局 + 每工作区 + 用户    │
                                          └──────────────────────────────────┘
```

- **双面包**：一个 npm 包同时含 node half（host 侧 `apply`）与 client half（`dsh.client` manifest + `exports["./client"]`），与 `ui-theme` 等双面插件的形态一致。node half 非空（承载数据 API），client half 承载页面。
- **通信**：M1 用 `ctx.webServer` HTTP 路由 + 浏览器同源 `fetch`（基线方案 A）。备选方案 B：typert gateway / Connection 自定义 RPC——需要验证插件能否向 gateway 注册新 Remote 描述符；实现阶段先验证，不行就用 A。A 是保底且完全公开的扩展点。

## 5. 挂载方式（不改仓库）

```sh
# 1) 把插件装进 web profile（在独立工程目录构建出产物后）
dsh plugin --profile web add <本地路径或 tarball 或 git>

# 2) 在 $DSH_HOME/profiles/web/cordis.patch.yml（用户自有文件）insert 一行：
#    - id: ui-settings-skills
#      name: '<插件包名>'
```

要点：

- profile 目录：`$DSH_HOME/profiles/<name>/`（默认 `~/.dsh/profiles/<name>/`），含 `package.json`（依赖 + `dsh.profile.bundles`）与用户自己的 `cordis.patch.yml`。
- 插件集（新增/移除行）变更后**需要重启**：`client-modules` 的包元数据缓存（`pkgMeta`）"never expires"，`internal/plugin` 事件只覆盖已挂载行的 bundle 内容热更新（`rebuilt()`），不会发现新包。
- 开发期 bundle 热更新：可仿照 harness 的 dev 流程自行起 watch（重新打包 client bundle 后走 `rebuilt()` 通知），或直接重启。
- 用 `dsh --profile web --dump-config` 验证行已进入组合树。

## 6. M1 设计：只读展示

### 6.1 数据模型

> **实现后的维度真相（重要）**：dsh-web-app bundle 把 host 层的 `skill-filesystem` / `skill-badge` / `tool-skill` 全部 `disabled`——技能 provider 由**每个会话挂载的 agent preset** 注册进该 agent 的**作用域层**。因此 web 组合下「全局层」天然为空。catalog API 据此实现三个维度：harness（全局层）、**user（用户级技能：所有活 agent 作用域视图中的 `user-agents`/`user-dsh` 行并集）**、workspace × N（**该工作区 per-cwd 全局层视图 ∪ 其名下活会话的作用域视图**，按名去重排序；工作区归属由 workspace 记录的 `sessionIds` 决定，不依赖 cwd 字符串匹配）。会话粒度不单独展示（用户要求最低粒度到工作区）。

host 聚合层每次请求现算（不做持久缓存；可加轻量 memo + 监听 `skills/change` 失效，M1 可不做）：

```
SkillRow {
  name: string                 // kebab-case 技能名
  description: string
  whenToUse?: string
  source: SkillSource          // 作用域标签: project-dsh / project-agents / runtime /
                               // user-dsh / user-agents / custom / bundled
  provider: string             // 提供者标签
  modelInvocable: boolean      // 调用面徽标
  userInvocable: boolean
  resourceBase?: { kind, ... } // 可选展示
}

DimensionView {
  kind: 'harness' | 'user' | 'workspace'
  id?: string                  // workspace 时为 WorkspaceId
  title: string                // workspace 标题；harness/user 为固定文案
  skills: SkillRow[]           // 该维度下的目录（按 name 排序）
  error?: { code, message }    // 该维度收集失败时携带
}

GET /plugin/settings-skills/catalog
→ 200 { dimensions: DimensionView[] }
→ 错误统一 JSON: { error: { code: string, message: string } } + 对应 4xx/5xx
```

维度枚举逻辑（host 侧）：

1. **harness（全局）**：`ctx.skills.snapshot({})`（无 scope、无 cwd）→ 全局层目录。web 组合下为空（provider 在 preset 层），TUI/headless 组合下有内容。
2. **user（当前用户）**：全局层与每个活 agent 作用域视图中的用户级行（`source ∈ {user-agents, user-dsh}`）并集——即"当前用户的技能"，与工作区无关。
3. **workspace × N**：`ctx.workspaceRegistry.list()` → 每个 `{ workspaceId, path, title, sessionIds }`：
   - 先取该工作区 per-cwd 全局层视图 `snapshot({ cwd: path })`（TUI 等有 host provider 的组合提供内容）；
   - 再对 `sessionIds` 中**有活 agent**（`ctx.agents` 按 id 查）的会话，以其 scope 键取 `snapshot({ scope: agent, cwd: path })`（web 组合的内容来源；会话失败被隔离，不影响同工作区其他会话）；
   - 两批按技能名去重（先到者保留）并排序——**会话粒度不进入 UI**，数据聚合到工作区层面。
4. （可选 M1.5，未做）**agent preset 静态枚举**：`ctx.agentPresets` 枚举 preset 组成——preset 的 scope 只在会话创建后存在，静态枚举只能展示组成，无法展示目录，价值有限。

### 6.2 页面设计

- **注册**：`settings.section`，`id: 'skill-management'`，`order: 30`（排在 Models / Agent Presets 之后），`label` 本地化（zh「技能」/ en「Skills」，对齐 ui-skill 的 Skill 术语），`locale` 命名空间 `settings.skillManagement`，`inject` face 提供 `load()`。
- **布局**：维度选择（tabs 或分组列表）：
  - 全局（harness）组：所有全局可见技能。
  - 工作区组：每个工作区一个分组，显示该工作区标题；组内列出该 cwd 下的技能；与全局目录的差异即"该工作区独有/缺失"的可见性信号（M1 可用并集展示 + 维度徽标，不做过拟合的 diff 逻辑）。
  - 用户组：当前用户偏好层（同源数据，标签区分）。
- **每行内容**：
  - 主行：技能名（等宽）+ 描述（+ `whenToUse` 次要文案）。
  - 标签组：`source` 徽标（即作用域标签：project/user/runtime/bundled/custom…）、`provider` 徽标、维度徽标（全局/工作区×N/用户）、调用面徽标（模型可调用 / 仅用户可调用——对应 `modelInvocable: false` 的 `disable-model-invocation` 技能）。
  - M1 **不渲染开关**（M2 再上），行尾预留开关位。
- **状态**：加载中（骨架）/ 错误（文案 + 重试按钮）/ 空（"未发现技能"）。
- **数据获取**：进入页面时 `load()`；M1 不做轮询，提供手动刷新。
- **组件状态**：单页内本地 state 即可（页面内自用、不跨 entry 共享、不须跨 remount 存活），不需要 store（遵循 client AGENTS.md 的三通道规则）。

### 6.3 客户端包结构（遵循 client 插件规范）

```
src/client/index.ts              # apply: locale 注册 + settings.section 注册
src/client/SkillManagementSection.tsx
src/client/locales.ts            # zh/en 词典，声明 LocaleNamespaceMap 合并
src/client/css-modules.d.ts
```

inject：`['slots', 'locale']`（M1 用 fetch 直连 host 路由，不需要 `remote`）。

## 7. M2 设计契约：开启/关闭（不实现，仅定契约）

### 7.1 目标语义

按维度（harness 全局 / 某工作区 / 当前用户）开关技能：关闭后，该维度下该技能从**所有消费面**消失——`/` 技能菜单、模型侧 `tool-skill` 目录与 `/name` 注入、TUI/ACP 入口。

### 7.2 不改基础代码的强制机制：分层遮蔽（shadowing）

`ctx.skills` 的合并规则（`packages/skill/skill/src/index.ts` `collectFresh`）：

- 合并顺序：global 层 → 作用域链各层（最远祖先 → 最近层），**最近层的同名条目直接覆盖**；
- 同层内重复名：按 `rank`（小者胜）→ `providerOrder`（先注册胜）→ `localOrder` 决出，胜者成为该层代表。

因此注册一个「策略 provider」可以**在不修改注册表的前提下**强制过滤：

1. **harness 全局禁用**：把策略 provider 注册进 global 层（无 scope 的上下文注册即全局层），对禁用的技能返回同名 stub 候选，声明 `rank: 0`（小于公开常量 `BUNDLED_SKILL_RANK = 600`、runtime `250`，以及预期第三方 provider 的正 rank）→ 同层内 stub 必胜 → 该技能在全 harness 的目录与 `get()` 都被 stub 接管。
2. **按 agent 作用域（preset）禁用**：把策略 provider 注册进某个 preset 的 layer（preset 的 cordis.yml 挂载行，`isolate` realm 可选）→ 最近层覆盖全局 → 仅该 preset 的 agent 受影响。
3. **stub 语义**：`list()` 返回候选（可保留原技能名/描述 + `source: 'custom'` + 描述前缀"已禁用"）；`get()` 返回 `undefined` 或"已禁用"定义——消费面自然拿不到正文。模型/用户两个面可分别控制：stub 的 `invocation` 可设为 `{ modelInvocable: false, userInvocable: false }`（或按面精细控制）。
4. **生效即时性**：策略变更后调 `SkillProviderControl.invalidate()`（公开 API）→ 注册表清缓存并发 `skills/change` → 所有消费面下次读取即生效。

### 7.3 持久化与 API

- host 插件注册一个 `ctx.settings` 命名空间 schema（公开 seam）：`{ harness: { [skill]: boolean }, workspace: { [workspaceId]: { [skill]: boolean } }, user: { [skill]: boolean } }`。
- 已知限制：settings 当前是"单用户单文档"（`packages/settings/settings/README.md` 的 known limitation），没有 per-workspace 文档层——M2 先以"全局文档内按 workspaceId 分键"落地，属于插件内部结构，不依赖产品新能力。
- 新路由：`GET /plugin/settings-skills/policy`（各维度当前生效状态）、`PUT /plugin/settings-skills/policy`（写入开关）。

### 7.4 诚实边界（M2 评审必须接受）

1. **rank 博弈**：stub 靠 `rank: 0` 赢同层竞争；若未来某基础/第三方 provider 也声明 `rank: 0` 且注册更早，同层内按 `providerOrder` 先注册者胜，策略 stub 可能输。当前基础 provider（skill-filesystem `BUNDLED_SKILL_RANK=600`、runtime `250`）不构成威胁，但这是对分层语义的依赖而非注册表提供的正式"禁用"API。
2. **`disable-model-invocation` 技能**：其 `modelInvocable: false` 来自技能自身声明，与我们的开关正交；关闭一个技能是整体移除，如需"仅模型侧禁用、用户仍可 `/` 调用"，用 stub 的 `invocation` 按面控制。
3. **作用域维度 ≠ 产品维度**：注册表的分层键是 agent 作用域（preset），没有 workspace/user 原生层。M2 的"工作区维度开关"实现为：策略 provider 在 `list()` 里根据 `options.cwd` 判断当前项目所属工作区，再决定是否遮蔽——**同一 provider 服务于所有维度**，靠 cwd/scope 区分。这是可行的（provider 的 `list(options)` 本来就读 `cwd`），但"按用户区分"在产品单用户模型下无意义。
4. **无法拦截的路径**：任何直接 import `ctx.skills` 的进程内消费者（未来基础代码新增的消费面）若绕过 provider 遮蔽逻辑，理论上仍可读到 stub 之外的原始候选——stub 已接管同名条目，所以实际读到的也是 stub；真正无法拦截的是"未经过注册表的直接文件读取"，超出插件职责。
5. **模型可见性**：被遮蔽技能从模型目录消失属预期语义（关闭=不可见不可用）；如需保留"目录可见但内容提示禁用"，属体验细节，M2 再定。

### 7.5 被否决的方案（记录）

- **改 `ctx.skills` 加过滤扩展点**：最干净的强制点，但违反硬约束（改基础代码）。
- **消费面逐个过滤（UI 菜单 / tool-skill / 注入边界）**：全是基础代码，且违背"在做出决定的操作用强制"的仓库铁律，无法拦截模型侧路径；否决。
- **HTTP 网关代理 skill.list RPC**：`rpc-map` 在基础代码中，无法注入；否决。

## 8. 独立工程布局（仓库外）

```
ui-settings-skills/                # 独立工程（D:\Codes\ui-settings-skills）
├── package.json                      # name/exports{".", "./client"}/dsh.client{platform:"web"}/files
├── tsconfig.json                     # 参考 harness tsconfig.base.client.json 的严格配置
├── tsdown.config.ts                  # node half + client half 两个产物；client 必须产出单文件 bundle（lib/client.js）
├── src/
│   ├── index.ts                      # node half: webServer 路由 + 维度聚合 (+ M2 策略)
│   ├── client/
│   │   ├── index.ts                  # client half: settings.section 注册
│   │   ├── SkillManagementSection.tsx
│   │   ├── locales.ts
│   │   └── css-modules.d.ts
│   └── invariant.ts                  # 遵循仓库惯例的包内 invariant 伴生
└── tests/
    ├── host.catalog.spec.ts          # 聚合逻辑（fixture provider）
    └── client.section.client.spec.ts # jsdom 组件测试
```

### 8.1 依赖分发（实现阶段第一风险，需先验证）

client half 编译期依赖 harness 的客户端类型包：

- `@deepseek-ai/dsh-client-ui-slots`（SlotMap 声明合并）
- `@deepseek-ai/dsh-client-ui-settings`（settings 槽类型 + `settingsScope` 类型）
- `@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-runtime`（`ClientContext` 类型）
- `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 等

若这些包未发布到 npm registry，唯一来源是**本地 harness 构建产物**：`pnpm run build` 后从 `packages/*/lib` 安装（`pnpm add file:...` 或 tarball）。这意味着：

- 插件与具体 harness 版本强耦合（client 槽位类型随版本演进）；
- 需要写一个安装脚本/文档化流程：harness 升级 → 重建 → 重装依赖 → 重新打包 client bundle。

node half 依赖 `@deepseek-ai/dsh-skill`（类型 + 注册表服务类型）、`@deepseek-ai/dsh-workspace`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/cordis`，同样处理。

### 8.2 构建产物契约

- client bundle 必须可被 `client-modules` 直接 serve：`exports["./client"]` 指向构建出的**单文件 JS bundle**（参考 harness 各 client 包的 tsdown `clientBundle` 模式），并带 sourcemap（`/plugins/<id>/client.js.map` 由同一路由提供）。
- node half 走常规 Node ESM 产物（`exports["."]` → `lib/index.js`）。
- 包内不得有模块级副作用（注册必须发生在 `apply` 内）。

## 9. 验证方案

| 层 | 方法 |
|---|---|
| host 聚合 | 单元测试：fixture 注册全局/项目级技能，断言三个维度的 rows 与标签；错误路径（provider 抛错 → 该维度标记降级而非整体失败） |
| client 页面 | jsdom 组件测试：直接喂 props（inject face 的 stub），断言加载/错误/空三态与标签渲染；不引入渲染框架 |
| 组装验证（手工） | 1) 安装插件 → 2) `dsh --profile web --dump-config` 确认行存在 → 3) 启动 Web，设置出现「技能」页 → 4) 对照 `skill.list`（某会话）与全局目录核对行数/标签 → 5) 在工作区目录建一个项目级 skill，确认对应工作区维度出现、全局维度不出现（验证 cwd 维度语义） |
| M2 验证（后续） | 关闭某技能后：`/` 菜单无该技能、模型目录无该技能、`/name` 注入不加载；`skill.list`（所有会话）无该技能；重新开启后恢复 |

## 10. 里程碑

- **M1.1 骨架** ✅ 已交付：独立工程脚手架、esbuild 双产物构建链（node + client）、依赖分发（npm 发布版 `@deepseek-ai/*@0.1.0-rc.6` 与已装 dsh rc.6 运行时对齐）、安装到测试 profile `skill-dev`、空页面挂载成功（`__DSH_BOOT__` 条目 + `/plugins/ui-settings-skills/client.js` 可 serve）。
- **M1.2 展示** ✅ 已交付：host 聚合 API（harness/user/workspace 三维度、会话数据按 cwd 聚合进工作区、逐维度容错）+ 设置页渲染（维度分组、作用域/调用面徽标、加载/错误/空三态）。组装验证：catalog 在 deepseek-harness 工作区返回 13 个真实技能（聚合语义正确），404/405 正确。
- **M2 开关**：策略 provider + settings 持久化 + policy API + 页面开关交互；需先评审 §7.4 边界。

## 11. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| `@deepseek-ai/dsh-client-*` 未发布 npm，依赖只能来自本地构建产物 | 插件与 harness 版本强耦合；安装流程复杂 | M1.1 最先验证；文档化重装流程；锁定版本快照 |
| client 槽位类型随 harness 版本演进（SlotMap 合并） | 升级 harness 后插件可能编译失败 | 锁版本；升级时重跑构建链；`dsh --profile web --dump-config` + 页面冒烟 |
| M2 rank 博弈（§7.4.1） | 极端情况下遮蔽失效 | rank 取 0 + 文档化假设；评审接受边界 |
| 插件集变更需重启才被发现（pkgMeta 缓存） | 开发迭代体验下降 | 文档化；bundle 内容走 `rebuilt()` 热更新（自建 watch） |
| `settings` 单用户单文档（M2） | workspace 维度状态没有独立文档层 | 全局文档内按 workspaceId 分键（插件内部结构） |
