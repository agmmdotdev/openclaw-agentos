// Probe the generated profile's explicit unsupported boundaries after real turns.
for (const [invoke, message] of [
  [() => loadCompactRuntime(), 'Unsupported core profile: gateway compaction runtime'],
  [() => loadExtensionSourceTransformModule(), 'Unsupported core profile: source extension loader'],
]) {
  let observed;
  try { await invoke(); } catch (error) { observed = error.message; }
  if (observed !== message) throw new Error(`Core profile boundary did not fail explicitly: ${observed}`);
}
console.log('CORE_PROFILE_RESULT=' + JSON.stringify({ assertions: 2, passed: true }));
