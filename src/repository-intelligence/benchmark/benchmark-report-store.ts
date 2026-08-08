import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../../completion/canonical-json.js";
import { repositoryBenchmarkReportSchema, type RepositoryBenchmarkReportV1 } from "./benchmark-report-schema.js";

export class RepositoryBenchmarkReportStore {
  constructor(private readonly root: string) {}

  async write(reportInput: RepositoryBenchmarkReportV1): Promise<string> {
    const report = repositoryBenchmarkReportSchema.parse(reportInput);
    await mkdir(this.root, { recursive: true });
    const target = join(this.root, `${report.runId}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(report)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    return target;
  }

  async read(runId: string): Promise<RepositoryBenchmarkReportV1> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(runId)) throw new TypeError("invalid repository benchmark run ID");
    return repositoryBenchmarkReportSchema.parse(JSON.parse(await readFile(join(this.root, `${runId}.json`), "utf8")) as unknown);
  }
}
