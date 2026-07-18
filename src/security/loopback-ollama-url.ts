export type LoopbackURLResult =
  | { readonly ok: true; readonly value: string }
  | { readonly error: string; readonly ok: false };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function resolveLoopbackOllamaURL(
  value: string,
): LoopbackURLResult {
  const selected = value.trim().replace(/\/+$/u, "");
  try {
    const url = new URL(selected);
    // PHASE15: 默认 local-free profile 在 transport 创建前只接受字面量 loopback；
    // “免费”、代理或可解析到本机的远程名称都不是可审计的零费用边界。
    if (
      url.protocol !== "http:" ||
      !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
      url.port !== "11434" ||
      url.pathname !== "/" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error("not a literal loopback Ollama URL");
    }
    // PHASE8: canonicalize the hostname to a numeric loopback address. This
    // preserves the user-facing localhost form without trusting DNS/hosts-file
    // resolution at the transport boundary.
    url.hostname = url.hostname.toLowerCase() === "localhost"
      ? "127.0.0.1"
      : url.hostname;
    return { ok: true, value: url.origin };
  } catch {
    return {
      error:
        "BORN_OLLAMA_BASE_URL must be a root HTTP loopback URL on port 11434",
      ok: false,
    };
  }
}
