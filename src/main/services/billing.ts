export type ProviderBilling = "subscription" | "metered" | "local" | "unknown";

const SUBSCRIPTION_PROVIDERS = new Set([
  "opencode-go",
  "opencode-zen",
  "openai-codex",
  "openai-codex-device",
  "anthropic",
  "github-copilot",
  "cursor",
  "kimi-code",
  "zai-coding-plan",
  "zhipu-coding-plan",
  "minimax-code",
  "minimax-code-cn",
  "factory-droid",
  "xai-oauth",
  "google-antigravity",
  "google-gemini-cli",
  "qwen-portal",
  "umans",
  "devin",
  "devin-cli",
  "devin-windsurf",
  "gitlab-duo",
  "gitlab-duo-agent",
  "muse-code",
  "stencil",
  "cline-pass",
  "firepass",
  "alibaba-coding-plan",
  "alibaba-token-plan",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
]);

const LOCAL_PROVIDERS = new Set([
  "local",
  "ollama",
  "lm-studio",
  "llama.cpp",
  "vllm",
  "apple",
]);

export function providerBilling(providerId: string): ProviderBilling {
  if (LOCAL_PROVIDERS.has(providerId)) return "local";
  if (SUBSCRIPTION_PROVIDERS.has(providerId)) return "subscription";
  if (providerId === "openrouter" || providerId === "openai" || providerId === "google" || providerId === "xai" || providerId === "deepseek" || providerId === "mistral" || providerId === "groq" || providerId === "cerebras") return "metered";
  return "unknown";
}
