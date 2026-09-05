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

// Differential checks run inside the real guest: compare the host collector
// against the untouched guest implementation, including Unicode column order.
const { DatabaseSync: ProfileDatabase } = await import('./compat/sqlite.mjs');
const profileDatabase = new ProfileDatabase(':memory:');
const profileSchema = 'CREATE TABLE delta (id INTEGER PRIMARY KEY, "é" TEXT, "z" TEXT, "Å" TEXT, "a" TEXT) STRICT; CREATE INDEX delta_idx ON delta("é")';
function compareProfileSchema() {
  const batched = collectSqliteSchemaIssues(profileDatabase, profileSchema);
  const batchedTable = collectSqliteTableContract(profileDatabase, 'delta');
  const batchedIndex = collectSqliteNamedIndexContract(profileDatabase, 'delta_idx');
  const batch = profileDatabase.collectOpenClawTableContract;
  const indexBatch = profileDatabase.collectOpenClawNamedIndexContract;
  let individual, individualTable, individualIndex;
  profileDatabase.collectOpenClawTableContract = undefined;
  profileDatabase.collectOpenClawNamedIndexContract = undefined;
  try {
    individual = collectSqliteSchemaIssues(profileDatabase, profileSchema);
    individualTable = collectSqliteTableContract(profileDatabase, 'delta');
    individualIndex = collectSqliteNamedIndexContract(profileDatabase, 'delta_idx');
  }
  finally { profileDatabase.collectOpenClawTableContract = batch; profileDatabase.collectOpenClawNamedIndexContract = indexBatch; }
  const serializeContract = value => JSON.stringify(value, (key, item) => item instanceof Map ? { entries: [...item] } : item);
  if (serializeContract(batchedTable) !== serializeContract(individualTable)) throw new Error('Batched table contract differs from guest collector');
  if (JSON.stringify(batched) !== JSON.stringify(individual)) throw new Error('Batched schema issues differ from guest collector');
  if (JSON.stringify(batchedIndex) !== JSON.stringify(individualIndex)) throw new Error('Batched named index differs from guest collector');
  return batched;
}
try {
  profileDatabase.exec(profileSchema);
  if (compareProfileSchema().length !== 0) throw new Error('Canonical schema was rejected');
  profileDatabase.exec('BEGIN; DROP INDEX delta_idx; ALTER TABLE delta ADD COLUMN unexpected TEXT');
  const drift = compareProfileSchema();
  if (!drift.some(issue => issue.code === 'missing-or-drifted-index') || !drift.some(issue => issue.code === 'unexpected-column')) throw new Error('Schema drift checks were lost');
  profileDatabase.exec('ROLLBACK');
  if (compareProfileSchema().length !== 0) throw new Error('Schema rollback was not observed');
} finally { profileDatabase.close(); }
console.log('SCHEMA_BATCH_RESULT=' + JSON.stringify({ differentialStates: 3, passed: true }));
