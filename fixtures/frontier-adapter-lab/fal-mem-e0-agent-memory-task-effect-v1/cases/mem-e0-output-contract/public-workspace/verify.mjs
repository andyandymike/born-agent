import { outputMarker } from "./src/output-contract.mjs";

const marker = outputMarker();
if (typeof marker !== "string" || marker.length < 8 || marker === "UNIMPLEMENTED") {
  console.error("output marker must be implemented as a non-empty public string");
  process.exit(1);
}
console.log("MEM-E0 public shape pass: output contract");
