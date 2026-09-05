// Deliberately not lowered. Stream ponyfills inspect this native intrinsic;
// there is no user callback, await, or context-sensitive work in the exemplar.
export const nativeAsyncIteratorPrototype = Object.getPrototypeOf(
  Object.getPrototypeOf(async function* () {}).prototype,
);
