import type { ResolveSecureTempRoot } from "../infra/secure-temp-root.js";

type WorkerDeployRuntime = {
  highlightJs?: unknown;
  json5?: unknown;
  resolveSecureTempRoot?: ResolveSecureTempRoot;
};

const runtime: WorkerDeployRuntime = {};
let highlightLoader: (() => unknown) | undefined;

export function setWorkerDeployHighlightLoader(loader: () => unknown): void {
  highlightLoader = loader;
}


export function setWorkerDeployRuntime(next: Required<WorkerDeployRuntime>): void {
  highlightLoader = undefined;
  runtime.highlightJs = next.highlightJs;
  runtime.json5 = next.json5;
  runtime.resolveSecureTempRoot = next.resolveSecureTempRoot;
}

export function getWorkerDeployHighlightJs(): unknown {
  if (highlightLoader) {
    runtime.highlightJs = highlightLoader();
    highlightLoader = undefined;
  }
  return runtime.highlightJs;
}

export function getWorkerDeployJson5(): unknown {
  return runtime.json5;
}

export function getWorkerDeploySecureTempRoot(): ResolveSecureTempRoot | undefined {
  return runtime.resolveSecureTempRoot;
}
