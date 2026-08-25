# Relay Adapter Extension Contract

本插件把“请求指标”和“中转站私有检测”分成两层。所有适配器都必须支持基础层；只有确实拥有对应接口的适配器才能声明高级能力。适配器不得为缺失的数据填充猜测值。

## 基础适配器

无需编写代码即可使用 `relayAdapter: "generic"`：

```json
{
  "relayName": "我的中转站",
  "relayBaseUrl": "https://relay.example.com",
  "relayMultiplier": 1,
  "relayCurrency": "USD",
  "modelAliases": { "relay-model": "gpt-5.6-sol" },
  "modelPricing": {
    "gpt-5.6-sol": {
      "inputPerMillion": 5,
      "cachedInputPerMillion": 0.5,
      "outputPerMillion": 30
    }
  }
}
```

`relayBaseUrl` 必须是 HTTPS；HTTP 只允许回环地址。代理将请求路径原样追加到该地址，只绑定 `127.0.0.1`，并删除会泄露给上游的本地连接头。费用单位由 `relayCurrency` 标记，价格均为每百万 Token。

状态栏和仪表盘基础字段：`model`、`reasoningEffort`、`contextWindow`、`contextTokens`、`inputTokens`、`cachedTokens`、`outputTokens`、`totalTokens`、`cost`、`costSource`、`firstByteMs`、`totalMs`。没有数据时使用 `null` 或“未采样”，不要使用 0 伪装成已检测。

## 高级适配器

若要增加余额、模型列表、供应商健康、分组、Key 或切换/故障转移，请在 `src/relay-adapters.mjs` 增加明确的适配器描述，并在 `src/service.mjs` 实现对应客户端。每个接口都必须：

1. 使用 HTTPS 或回环 HTTP，并限制响应大小和超时。
2. 返回稳定的内部字段：`id`、`name`、`models`、`multiplier`、`status`、`available`、`lastSampleAt`。
3. 对“接口未提供”“暂时失败”“明确不可用”分别返回 `null`、错误源或 `available: false`，不能把失败变成“可用”。
4. 在 `tests/` 添加正常响应、部分接口失败、认证失败和过期数据测试。
5. 在 `relayCapabilities()` 声明实际支持的 `enhancedMetrics`，UI 只渲染已声明且实际返回的能力。

推荐的高级响应形状：

```json
{
  "providers": [{
    "id": "relay-group-1",
    "name": "高速线路",
    "models": ["gpt-5.6-sol"],
    "multiplier": 1,
    "status": "available",
    "available": true,
    "lastSampleAt": "2026-08-26T00:00:00Z"
  }],
  "balance": { "amount": 12.5, "currency": "USD" }
}
```

切换接口必须是显式用户操作或适配器声明的安全故障转移，不得重放原始模型请求。失败时保留原始上游响应，让 Codex 自己决定是否重试。

## 发布检查

运行：

```powershell
npm test
python C:\Users\Iruo\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py .
```

不要在日志、配置示例或适配器返回值中写入密码、Cookie、Authorization、access token 或 refresh token。
