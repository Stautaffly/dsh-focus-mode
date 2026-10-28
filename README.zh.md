# dsh-focus-mode

[English](README.md) | 简体中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的外置预设插件，提供持久 shell、直接工具调用和 TypeScript 程序执行，无需修改 dsh 源码或前端。

兼容版本：dsh `0.2.1-rc.3`，已在上游提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` 上验证。要求 Node.js `>=24.9`。本仓库从已验收的 0.1.2 实现中抽出，运行时源码与 bundle 声明保持一致。

## 安装、更新与卸载

### 安装预编译包

安装包通过 [GitHub Releases](https://github.com/Stautaffly/dsh-focus-mode/releases) 分发，使用 dsh 官方 CLI 即可直接安装。普通用户不需要克隆源码、准备宿主源码目录或安装 TypeScript；本插件目前尚未发布到 npm。

请使用目标 DSH 应用对应的 CLI，并先初始化目标 Web profile。以名为 `web` 的 profile 为例：

```sh
dsh plugin --profile web add https://github.com/Stautaffly/dsh-focus-mode/releases/download/v0.1.2/dsh-focus-mode-0.1.2.tgz
```

把 `web` 换成实际使用的 profile 名称，例如 `web-vanilla`；命令只修改指定的 profile。安装完成后，重启对应的 DSH 应用、刷新浏览器，并在新会话中选择 **Focus mode**。安装只增加预设，不会更改现有的默认选择。

可以通过以下命令检查 bundle 是否被识别：

```sh
dsh --profile web --dump-config
```

输出应包含 `external-preset-focus-mode`。仍需满足本文开头的宿主兼容要求，安装插件不会升级 dsh。

### 更新

在 [Releases](https://github.com/Stautaffly/dsh-focus-mode/releases) 中选择兼容版本，把安装命令中的下载地址换成对应版本的 `.tgz` 地址，再执行 `dsh plugin --profile ... add <安装包地址>`，随后重启应用。上面的示例固定安装 `0.1.2`，重复执行只会重新安装该版本，不会自动选择未来版本。

### 卸载

先结束使用此预设的会话，再从同一个 profile 中移除插件：

```sh
dsh plugin --profile web remove dsh-focus-mode
```

卸载后重启应用并刷新浏览器。已有会话会保留其预设选择记录；不再安装本插件时，继续这些会话前应改选其他预设。

如需从源码构建或安装本地目录、归档包，见[开发](#开发)。

## 功能与行为

- `exec_command({cmd, session_id?, cwd?, run_in_background?})` 新建或复用 Agent 独有的持久 shell。工作目录、环境变量可跨调用保留；`cwd` 只适用于新会话。
- `write_stdin({session_id, chars?, run_in_background?, close?})` 读取新增输出或发送输入。换行提交输入，单独发送 Ctrl-C 中断；`close:true` 关闭 shell 并释放配额。
- `run_code` 使用上游 PTC 执行器。插件注册的可见工具会通过宿主注册表自动进入直接调用 schema 与程序 SDK，执行器不维护工具名称白名单。作用域、当前步骤准入、限制、审批、guard、取消和日志仍由宿主管理。
- 后台 job 监视整条 shell，直到它退出或关闭；`job_kill` 会关闭该 shell。每条 shell 最多有一个后台监视器。**shell 仍在运行或一次 send 已结算，都不能证明某条命令已经完成。**

预设保留 Agent 指令、时间上下文、compaction、skills、Web 工具、交付物、插件检查与管理、workflow 等能力。Agent Teams、会话搜索、worktree 和终端插件注册的额外可见工具会自动被继承。同时提供直接工具 schema 与程序 SDK 会增加提示词长度；PTC 可以减少进入会话历史的中间结果。

## 配置

插件默认允许每个 Agent 保有四条持久 shell，可配置为 1–64 条。上游 jobs 注册表另有并发 job 配额。[16 条 session / 16 个 job 的示例](examples/limits-16.patch.yml) 同时覆盖两项：

```sh
dsh --profile focus-sandbox --patch ./examples/limits-16.patch.yml --dump-config
dsh --profile focus-sandbox --patch ./examples/limits-16.patch.yml
```

`--patch` 只对本次启动生效。如需永久生效，将示例中的两行配置合并到目标 profile 的 `cordis.patch.yml`，保留其他配置以及 `jobs` 行原有的字段。示例文件可在本仓库和发行包的 `examples/` 目录中找到。

当前 dsh 的 profile patch 会替换匹配行的**整个 config**。命令工具位于预设声明内部，因此示例完整重述 `external-preset-focus-mode`，并修改 `persistent-shell → focus-commands → config.maxSessionsPerAgent`。不支持用顶层 `preset: focus-mode` / `id: focus-commands` 直接覆盖内层行。未来升级 bundle 时，需要同步检查复制的预设声明。

| 命令工具配置项 | 默认值 | 允许范围 |
| --- | --- | --- |
| `backendType` | `shell` | 已注册的终端后端 |
| `maxSessionsPerAgent` | 4 | 1–64 |
| `maxResultBytes` | 262144 | 256–16777216 字节 |
| `yieldMs` | 1000 | 0–60000 毫秒 |
| `pollMs` | 50 | 1–10000 毫秒 |
| `readLines` | 10000 | 1–100000 |

结果字节上限包含元信息。截断时保留尾部并提示可能丢失输出；需要已省略的输出时，应调大读取或保留量后重新执行命令。终端 send 超时及 scrollback 保留量由 `terminal-bash` / `terminal-pwsh` 配置控制。

## 开发

只有插件开发者需要准备宿主源码。当前基线依赖的 Native/PTC 执行器包尚未以 `0.2.1-rc.3` 发布到 npm，因此开发构建与集成测试使用准备好的源码目录，不以其他不兼容的 alpha 版本替代。`.npmrc` 关闭自动安装 peer 依赖，锁文件固定开发工具及普通依赖。

先准备独立的宿主源码目录并切换到兼容提交：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness
git -C ../deepseek-harness checkout 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
# 按宿主文档安装依赖并构建，包括其原生 addon 所需环境。
```

随后在本插件仓库目录执行：

```sh
npm ci --ignore-scripts
DSH_SOURCE="$PWD/../deepseek-harness" npm run link:host
npm run typecheck
npm run build
DSH_SOURCE="$PWD/../deepseek-harness" npm test
mkdir -p dist
npm run pack:release
```

用官方 CLI 把生成的归档包安装到开发 profile：

```sh
dsh plugin --profile focus-sandbox add ./dist/dsh-focus-mode-0.1.2.tgz
```

链接脚本只在本仓库已忽略的 `node_modules` 中创建链接，不会把插件安装到宿主，也不会修改宿主文件。执行 `npm ci` 后需要重新链接。开发 profile 应与生产 profile 分开。

`DSH_SOURCE` 是显式配置，不包含个人路径，也不把宿主源码复制到仓库。测试配置读取宿主的源码别名与 decorator 转换，并生成延迟加载的夹具模块映射。现有 24 项测试覆盖真实 Loader/PTY/jobs、工具动态注册与卸载、授权、取消与清理、分页、直接调用与 PTC 的执行顺序和日志、Web 与扩展插件组合，以及隔离 profile 的目录/归档包安装卸载，不需要模型密钥，也不发送真实模型请求。

运行时代码放在 `src/`，集成夹具和快照放在 `tests/`。多个插件的目录组织建议见[插件组织说明](docs/plugin-organization.md)。

## 已知限制

- 兼容范围固定在一个 pre-stable 宿主基线上，升级后需要重新验证。
- shell 会话只保存在内存中，不能跨进程重启恢复。已退出但未显式关闭的会话仍占配额；Agent 或插件卸载时会关闭其终端。
- scrollback 接口没有单调字节游标。如果完全相同的文本替换了整个保留窗口，不一定能分辨新旧；后端已经丢弃的字节无法恢复。
- profile 必须提供上游 Web 配套的 Host 能力与 PTC runtime。本 bundle 不启动服务器，也不配置模型或网络 provider。
- Linux 无密钥测试未覆盖完整浏览器 UI、真实 provider 和 Windows/macOS 行为。预设名称与描述尚未接入宿主内置预设的翻译表。

## 许可证

[MIT](LICENSE)。DeepSeek Harness 是独立的上游项目，本项目为独立维护的插件。
