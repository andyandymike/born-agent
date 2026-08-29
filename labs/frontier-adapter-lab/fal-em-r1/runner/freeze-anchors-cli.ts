import { resolve } from "node:path";

import { EM_R1_FIXTURE_DIRECTORY } from "../src/experiment-schema.js";
import { freezeReferenceAnchors } from "./freeze-anchors.js";

const repositoryRoot = process.cwd();
const result = await freezeReferenceAnchors({
  fixtureDirectory: resolve(repositoryRoot, EM_R1_FIXTURE_DIRECTORY),
  labRoot: resolve(repositoryRoot, "labs/frontier-adapter-lab/fal-em-r1"),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
