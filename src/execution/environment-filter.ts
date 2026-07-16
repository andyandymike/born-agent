import { createHash } from "node:crypto";

import { sanitizeChildEnvironment } from "../security/child-environment.js";

export const OFFLINE_NODE_GUARD_SOURCE = String.raw`
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
const deny=()=>{throw new Error("bornagent_network_denied")};
const patch=(target,names)=>{for(const name of names){if(name in target){Object.defineProperty(target,name,{configurable:false,enumerable:true,value:deny,writable:false})}}};
patch(http,["get","request","createServer"]);
patch(https,["get","request","createServer"]);
patch(http.Agent.prototype,["createConnection"]);
patch(https.Agent.prototype,["createConnection"]);
patch(net,["connect","createConnection","createServer"]);
patch(net.Socket.prototype,["connect"]);
patch(tls,["connect","createServer"]);
patch(tls.TLSSocket.prototype,["connect"]);
patch(dgram,["createSocket"]);
patch(dns,["lookup","lookupService","resolve","resolve4","resolve6","resolveAny","resolveCaa","resolveCname","resolveMx","resolveNaptr","resolveNs","resolvePtr","resolveSoa","resolveSrv","resolveTxt","reverse"]);
patch(dns.Resolver.prototype,["resolve","resolve4","resolve6","resolveAny","resolveCaa","resolveCname","resolveMx","resolveNaptr","resolveNs","resolvePtr","resolveSoa","resolveSrv","resolveTxt","reverse"]);
if(dns.promises){patch(dns.promises,["lookup","lookupService","resolve","resolve4","resolve6","resolveAny","resolveCaa","resolveCname","resolveMx","resolveNaptr","resolveNs","resolvePtr","resolveSoa","resolveSrv","resolveTxt","reverse"])}
syncBuiltinESMExports();
Object.defineProperty(globalThis,"fetch",{configurable:false,value:deny,writable:false});
if("WebSocket" in globalThis){Object.defineProperty(globalThis,"WebSocket",{configurable:false,value:deny,writable:false})}
`;

export const OFFLINE_NODE_GUARD_SHA256 = createHash("sha256")
  .update(OFFLINE_NODE_GUARD_SOURCE, "utf8")
  .digest("hex");

export const OFFLINE_NODE_GUARD_IDENTITY =
  "@bornagent/network-guard-v1";

const OFFLINE_NODE_IMPORT_OPTION = `--import=data:text/javascript,${encodeURIComponent(
  OFFLINE_NODE_GUARD_SOURCE,
)}`;

export const EXECUTION_ENVIRONMENT_POLICY = Object.freeze({
  id: "bornagent.local-minimal-env",
  version: "2",
});

export interface FilteredEnvironment {
  readonly values: Readonly<Record<string, string>>;
  readonly policy: {
    readonly id: string;
    readonly version: string;
    readonly variableNames: readonly string[];
  };
}

const SECRET_NAME =
  /(?:^|_)(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)(?:$|_)/iu;
const PROVIDER_NAME =
  /^(?:OPENAI|ANTHROPIC|AZURE|AWS|GOOGLE|GITHUB|GITLAB|HF|HUGGINGFACE|COHERE|MISTRAL|GROQ|TOGETHER|FIREWORKS|DEEPSEEK|OPENROUTER)_/iu;
const PROXY_NAME = /^(?:ALL|HTTP|HTTPS|NO)_PROXY$/iu;
const CREDENTIAL_INJECTION =
  /^(?:GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|GCM_|GH_TOKEN)/iu;

function findValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): { readonly key: string; readonly value: string } | undefined {
  const target = name.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === target && value !== undefined && value.length > 0) {
      return { key, value };
    }
  }
  return undefined;
}

function isForbiddenName(name: string): boolean {
  return (
    SECRET_NAME.test(name) ||
    PROVIDER_NAME.test(name) ||
    PROXY_NAME.test(name) ||
    CREDENTIAL_INJECTION.test(name)
  );
}

export function filterExecutionEnvironment(options: {
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}): FilteredEnvironment {
  // PHASE6: Child env starts empty so a newly-added host credential cannot silently
  // cross the execution trust boundary merely because nobody remembered to deny it.
  const values: Record<string, string> = {};
  const necessities =
    options.platform === "win32"
      ? ["Path", "SystemRoot", "USERPROFILE", "TEMP", "TMP"]
      : ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"];

  for (const name of necessities) {
    const entry = findValue(options.hostEnvironment, name);
    if (entry && !isForbiddenName(entry.key)) {
      const canonicalName = options.platform === "win32" && name === "Path" ? "Path" : name;
      values[canonicalName] = entry.value;
    }
  }

  values.CI = "1";
  values.NO_COLOR = "1";
  values.COREPACK_ENABLE_NETWORK = "0";
  values.NPM_CONFIG_OFFLINE = "true";
  values.YARN_ENABLE_NETWORK = "0";
  // PHASE6: shell:false does not stop reviewed code from opening sockets. The
  // inherited Node preload is a fail-closed, fingerprinted offline acceptance guard;
  // it is defense in depth for trusted fixtures, not an adversarial-code sandbox.
  values.NODE_OPTIONS = OFFLINE_NODE_IMPORT_OPTION;

  const sanitizedValues = sanitizeChildEnvironment(values);
  const variableNames = Object.keys(sanitizedValues).sort((left, right) =>
    left.localeCompare(right),
  );
  return Object.freeze({
    policy: Object.freeze({
      ...EXECUTION_ENVIRONMENT_POLICY,
      variableNames: Object.freeze(variableNames),
    }),
    values: sanitizedValues,
  });
}
