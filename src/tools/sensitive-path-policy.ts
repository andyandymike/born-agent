function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
}

export class SensitivePathPolicy {
  isDenied(value: string): boolean {
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
