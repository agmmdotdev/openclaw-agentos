// Compile-time verification only; no original runtime imports in generated JS.
import type { AgentOs } from '@rivet-dev/agentos-core';
import type { FileApi, ProcessApi, JavaScriptApi } from './sdk-surface.js';
type Assert<T extends true> = T;
type Same<A,B> = A extends B ? B extends A ? true : false : false;
type FileParity = Assert<Same<FileApi,Pick<AgentOs['filesystem'],keyof FileApi>>>;
type ProcessParity = Assert<Same<ProcessApi,Pick<AgentOs['process'],keyof ProcessApi>>>;
type JavaScriptParity = Assert<Same<JavaScriptApi,Pick<AgentOs['javascript'],keyof JavaScriptApi>>>;
export {};
