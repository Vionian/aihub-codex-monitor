# Relay Codex Monitor

面向 Codex 桌面客户端的本地监控与中转站计费插件。默认提供通用 OpenAI 兼容中转站适配器，并保留 AIHub 专用增强。

## 能力

- 从 Codex rollout 增量读取实际模型、推理强度、输入、缓存输入、输出、推理 Token、首字延迟、总耗时和错误。
- 通过 CDP 将 21px 单行摘要实时注入 Codex 桌面版输入框上方；点击摘要可展开完整监控抽屉，直接查看概览、供应商、余额、请求和路由设置。
- 读取 AIHub 分组、倍率、健康度、Key 当前分组和余额，并支持手动切组。手动切组只拦截明确不可用、禁用或黑名单分组；`stale`、`confidence`、延迟不足只影响自动路由，避免健康样本过期时锁死用户的显式选择。
- 提供经济、平衡、速度三种路由；权重依次为价格/速度 `90/10`、`50/50`、`10/90`。
- 代理观测到 429、502、503、504 或连接故障后，先切换分组，再把原失败交给 Codex 自身重试；代理不会隐藏重放请求。

## 通用中转站

在仪表盘“设置”中选择“通用中转站”，填写中转站名称、OpenAI 兼容根地址、全局倍率、币种、模型别名和费用表 JSON。也可以复制 [config.generic.example.json](./config.generic.example.json) 到本地配置目录后修改。

通用适配器不要求第三方登录接口，直接使用 Codex rollout 和本地回环代理提供模型、推理强度、上下文、输入/输出/缓存 Token、费用估算、首字延迟和总耗时。费用优先级为上游响应头/响应体，其次为本地价格表：非缓存输入 × 输入单价 + 缓存读取 × 缓存单价 + 输出 × 输出单价，再乘全局倍率。模型别名用于把中转站模型名映射到价格表键。

AIHub 适配器继续提供余额、公开分组、供应商健康、Key 管理、经济/平衡/速度路由和故障切组。其他中转站不会显示伪造的余额或健康数据。

需要扩展高级检测时，参见 [docs/relay-adapters.md](./docs/relay-adapters.md)。文档定义了基础字段、可选高级能力、响应契约、错误处理和测试要求。

## 实时状态栏

Codex 插件清单没有可供 MCP 直接挂载的原生状态栏插槽。状态栏主功能因此使用 Codex 桌面版的本地 CDP 调试端口，将 DOM 状态行放到真实输入框上方；它不依赖浏览器面板，也不会创建 iframe。

首次启动需要让 Codex 带 `--remote-debugging-port=9224` 运行一次。保存当前工作后，在 PowerShell 执行：

```powershell
& "<插件目录>\statusline\launch-statusline.ps1" -RestartCodex
```

之后可直接运行同一脚本启动注入器；状态行每约 1.5 秒刷新，并按当前侧栏线程与输入框 React 线程 ID 双重校验，避免串会话。安装器会创建当前用户的 `AIHub Codex Monitor.lnk` 启动项，只负责恢复本地服务和注入器，不会强制关闭或重启 Codex。当前机器上的 Endfield 主题启动器已提供本地 `9347` 调试端口，监控会直接复用它。

该 CDP 方案是桌面端显示所必需的本地辅助进程，MCP 插件本身仍用于 AIHub 查询、路由、余额和完整仪表盘能力。rollout 模式无需代理即可显示精确 Codex 指标；费用关联、请求所用分组以及同次重试前切组需要启用回环代理。

## 首次使用

1. 安装插件并重新启动 Codex。
2. 运行 `statusline\launch-statusline.ps1 -RestartCodex` 启用输入框上方的实时状态栏；后续只需运行不带 `-RestartCodex` 的脚本即可重连注入器。
3. 点击输入框上方的状态摘要展开完整监控抽屉；也可以在新任务中输入“打开 AIHub 监控面板”使用独立仪表盘。
4. 需要余额和切组时，在 PowerShell 中运行本地登录脚本：

```powershell
& "<插件目录>\scripts\set-credential.ps1"
```

脚本安全询问 AIHub 登录邮箱和密码，再由本地服务调用 `/api/v1/auth/login` 换取短期 access token；到期前优先用 refresh token 自动刷新，刷新被拒绝时重新登录。邮箱、密码以及可选的 Cloudflare Cookie/User-Agent 作为一个加密载荷，由 Windows DPAPI 按当前用户保护在 `%LOCALAPPDATA%\AIHubCodexMonitor\credential.xml`，不会进入聊天或命令行参数。

如果站点开启 Cloudflare 验证，脚本会继续询问可选 Cookie。请先在浏览器通过验证，再从开发者工具复制包含 `cf_clearance` 的整行 Cookie 和该浏览器的 User-Agent。未启用 Cloudflare 时直接按 Enter 跳过。

也可使用 `-ImportToken` 导入已经存在的登录 access token，或通过 `AIHUB_EMAIL`、`AIHUB_PASSWORD`、`AIHUB_COOKIE`、`AIHUB_USER_AGENT` 环境变量提供登录信息。保存后运行中的监控服务会热重载并验证登录，不需要重启 Codex。

5. 在仪表盘设置中填写要管理的 AIHub Key ID。
6. 需要代理故障切组时，将 [codex-config.example.toml](./codex-config.example.toml) 中的 provider 合并到 `%USERPROFILE%\.codex\config.toml`，然后重新启动 Codex。

也可以使用可恢复的配置脚本。它只修改当前 provider 节中的 `base_url`，并把原地址保存到本地数据目录：

```powershell
.\scripts\configure-codex-proxy.ps1 -Mode Enable
```

恢复直连：

```powershell
.\scripts\configure-codex-proxy.ps1 -Mode Disable
```

默认仪表盘为 `http://127.0.0.1:48160/`，模型代理为 `http://127.0.0.1:48160/v1`。服务只监听回环地址。

## 独立运行与诊断

```powershell
.\scripts\start-monitor.ps1
.\scripts\diagnose.ps1
```

启动器会把不可变运行时复制到 `%LOCALAPPDATA%\AIHubCodexMonitor\versions\<插件版本>`，随后离开插件缓存目录运行，从而避免 Windows 在插件更新时拒绝重命名缓存。

开发源码发布到个人插件目录时，先完全关闭 Codex，再运行：

```powershell
.\install.bat
```

脚本使用 Codex 官方缓存刷新辅助程序、验证插件、停止占用正式端口的旧监控服务、同步个人插件源，并把半安装的孤立缓存移动到带时间戳的可恢复备份后调用 `codex plugin add`。它不会手工编辑 `marketplace.json` 或 `config.toml`。

卸载插件：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-personal.ps1
```

## 费用口径

优先采用 AIHub 响应头或用量响应中的费用。若响应只返回 Token，则按 AIHub 用量页公式计算：`(输入 Token × 输入单价 + 输出 Token × 输出单价 + 缓存读取 Token × 缓存单价) / 1,000,000 × 分组倍率`。插件预置截图所示 `gpt-5.6-sol` 单价：输入 `$5/1M`、输出 `$30/1M`、缓存读取 `$0.5/1M`；可在设置中的费用表 JSON 覆盖。若账户余额在轮询期间下降，插件还会把真实余额扣款按 Token 比例归因到期间内的成功代理请求并标记为“余额扣款归因”。缺少可靠价格或扣款差额时显示“AIHub 未提供费用”，不会伪造金额。

## 开发验证

```powershell
npm test
python C:\Users\Iruo\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py .
```

路由设计参考 [AIHubRouter](https://github.com/OnRightPath/AIHubRouter) 的公开接口与算法思想，代码为独立实现。
