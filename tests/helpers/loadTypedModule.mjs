import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the actual module with explicit fake platform dependencies. No
// credentials, IndexedDB, browser worker or live Nuvio account are required.
export function loadTypedModule(url, dependencies = {}, globals = {}) {
  const source = readFileSync(url, "utf8").replaceAll("import.meta.env", "({})");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(output, {
    module,
    exports: module.exports,
    require: (name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    URL, Headers, AbortController, AbortSignal, setTimeout, clearTimeout,
    ...globals,
  }, { filename: String(url) });
  return module.exports;
}

export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

export const tick = () => new Promise((resolve) => setImmediate(resolve));
