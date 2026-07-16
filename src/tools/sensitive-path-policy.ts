function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
}

export class SensitivePathPolicy {
  isDenied(value: string): boolean {
    // PHASE3: 只读也可能泄露凭据。规则先统一分隔符并转小写，保证 Windows 大小写不敏感。
    const normalized = normalizedPath(value);
    const segments = normalized.split("/").filter(Boolean);
    if (
      segments.some((segment) =>
        [".git", ".bornagent", ".agents", ".codex"].includes(segment),
      )
    ) {
      return true;
    }

    const name = segments.at(-1) ?? "";
    if (name === ".env.example") {
      // PHASE3: 配置模板通常是可提交文档，因此作为明确例外保留可读性。
      return false;
    }
    return (
      name === ".env" ||
      name.startsWith(".env.") ||
      name.endsWith(".pem") ||
      name.endsWith(".key") ||
      name === "id_rsa" ||
      name === "id_ed25519"
    );
  }
}
