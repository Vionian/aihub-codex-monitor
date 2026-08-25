// The generic adapter deliberately has no private API assumptions. It uses
// OpenAI-compatible traffic plus local pricing; AIHub adds authenticated
// balance, group health, and failover data in service.mjs.
const ADAPTERS = Object.freeze({
  aihub: Object.freeze({ id: "aihub", displayName: "AIHub", privateData: true, routing: true }),
  generic: Object.freeze({ id: "generic", displayName: "通用中转站", privateData: false, routing: false }),
});

export function getRelayAdapter(id) {
  return ADAPTERS[String(id || "aihub").toLowerCase()] || ADAPTERS.generic;
}

export function relayCapabilities(id) {
  const adapter = getRelayAdapter(id);
  return {
    adapter: adapter.id,
    displayName: adapter.displayName,
    privateData: adapter.privateData,
    routing: adapter.routing,
    metrics: ["model", "reasoning", "context", "tokens", "cache", "cost", "ttft", "duration"],
    enhancedMetrics: adapter.privateData ? ["balance", "providerHealth", "groupRouting", "failover"] : [],
  };
}
