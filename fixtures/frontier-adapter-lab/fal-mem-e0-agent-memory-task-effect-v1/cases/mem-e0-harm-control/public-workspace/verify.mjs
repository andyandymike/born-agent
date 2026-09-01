import { harmControlMarker } from "./src/harm-control.mjs";

const marker = harmControlMarker();
if (typeof marker !== "string" || marker.length < 8 || marker === "UNIMPLEMENTED") {
  console.error("harm-control marker must be implemented as a non-empty public string");
  process.exit(1);
}
console.log("MEM-E0 public shape pass: harm control");
