// Single-session trusted-host checkpointing. A pending turn requires explicit
// recovery: filesystem/tool side effects cannot be rolled back by a transcript.
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const MAX_BYTES = 32 * 1024 * 1024;
export async function beginRequest(stateDir, turn) {
  if (!Number.isSafeInteger(turn) || turn < 0) throw new Error('Invalid request turn');
  const checkpoint = join(stateDir, 'request-checkpoint.json');
  const pending = join(stateDir, 'request-inflight.json');
  let lock;
  try { lock = await open(pending, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Request already active or interrupted; explicit recovery required'); throw e; }
  let history = null, committed = false, committing = false;
  try {
    await lock.writeFile(JSON.stringify({ version: 1, turn, pid: process.pid }));
    await lock.sync();
    await lock.close(); lock = null;
    await syncDirectory(stateDir);
    let saved, hasSaved = false;
    try {
      const h = await open(checkpoint, 'r');
      hasSaved = true;
      try {
        if ((await h.stat()).size > MAX_BYTES) throw new Error('Checkpoint exceeds 32 MiB');
        saved = JSON.parse(await h.readFile('utf8'));
      } finally { await h.close(); }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (hasSaved) {
      if (saved?.version !== 1 || !Number.isSafeInteger(saved.nextTurn) || saved.nextTurn < 1 || !Array.isArray(saved.messages)) throw new Error('Invalid checkpoint');
      if (saved.nextTurn !== turn) throw new Error(`Checkpoint expects turn ${saved.nextTurn}, requested ${turn}`);
      history = saved.messages;
    } else if (turn !== 0) throw new Error('Missing checkpoint for resumed request');
  } catch (e) {
    await lock?.close(); await unlink(pending); throw e;
  }
  return {
    turn, history,
    async commit(messages) {
      if (committed || committing) throw new Error('Request already committed or committing');
      if (!Array.isArray(messages)) throw new Error('Messages must be an array');
      const json = JSON.stringify({ version: 1, nextTurn: turn + 1, messages });
      if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('Checkpoint exceeds 32 MiB');
      committing = true;
      const temporary = join(stateDir, '.checkpoint-' + randomUUID());
      try {
        const h = await open(temporary, 'wx', 0o600);
        try { await h.writeFile(json); await h.sync(); } finally { await h.close(); }
        await rename(temporary, checkpoint);
        await syncDirectory(stateDir);
        await unlink(pending);
        await syncDirectory(stateDir);
        committed = true;
      } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    },
    // No automatic abort/replay: the pending marker intentionally survives failure.
  };
}
async function syncDirectory(path) {
  const h = await open(path, 'r');
  try { await h.sync(); } finally { await h.close(); }
}
