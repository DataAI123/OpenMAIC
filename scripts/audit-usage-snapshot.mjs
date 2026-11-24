import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline preflight only. Presence of attribution is not proof of ownership.
// Keep raw rows and unknown fields out of the report; never load app config.
const MAX_LINE_BYTES = 1024 * 1024;
const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'reasoningTokens',
];
const UNITS = { image: 'image', video: 'second', tts: 'character', asr: 'second' };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const textField = (value) => typeof value === 'string' && value.trim().length > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function classify(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).trim();
  } catch {
    return { disposition: 'quarantined', reason: 'invalid-utf8' };
  }
  if (!text) return { disposition: 'excluded', reason: 'blank' };
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    return { disposition: 'quarantined', reason: 'invalid-json' };
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { disposition: 'quarantined', reason: 'invalid-record' };
  }
  const kind = row.kind === undefined ? 'llm' : row.kind;
  if (
    typeof kind !== 'string' ||
    (kind !== 'llm' && !Object.hasOwn(UNITS, kind)) ||
    !['id', 'source', 'providerId', 'modelId', 'modelString'].every((key) => textField(row[key])) ||
    !count(row.createdAt) ||
    !Number.isFinite(new Date(row.createdAt).getTime()) ||
    new Date(row.createdAt).getUTCFullYear() > 9999 ||
    !TOKEN_FIELDS.every((key) => count(row[key])) ||
    (row.quotaEstimatedTokens !== undefined && !count(row.quotaEstimatedTokens))
  )
    return { disposition: 'quarantined', reason: 'invalid-usage' };
  if (kind === 'llm') {
    if ((row.unit !== undefined && row.unit !== 'token') || row.quantity !== undefined) {
      return { disposition: 'quarantined', reason: 'invalid-usage' };
    }
  } else if (
    !Object.hasOwn(UNITS, kind) ||
    row.unit !== UNITS[kind] ||
    typeof row.quantity !== 'number' ||
    !Number.isFinite(row.quantity) ||
    row.quantity <= 0 ||
    row.quantity > Number.MAX_SAFE_INTEGER ||
    ((kind === 'image' || kind === 'tts') && !Number.isSafeInteger(row.quantity)) ||
    TOKEN_FIELDS.some((key) => row[key] !== 0) ||
    row.quotaEstimatedTokens !== undefined
  )
    return { disposition: 'quarantined', reason: 'invalid-usage' };
  if (!textField(row.ownerId) || !textField(row.tenantId)) {
    return { disposition: 'quarantined', reason: 'missing-attribution' };
  }
  return {
    disposition: 'reviewRequired',
    kind,
    scopeSha256: sha256(JSON.stringify([row.tenantId, row.ownerId])),
    period: new Date(row.createdAt).toISOString().slice(0, 7),
    ...Object.fromEntries(TOKEN_FIELDS.map((key) => [key, row[key]])),
    ...(row.quotaEstimatedTokens !== undefined
      ? { quotaEstimatedTokens: row.quotaEstimatedTokens }
      : {}),
    ...(kind !== 'llm' ? { quantity: row.quantity, unit: row.unit } : {}),
  };
}

/**
 * Reads an explicitly selected immutable JSONL snapshot with bounded memory.
 * Awaiting onRow provides backpressure. A report is complete only with the
 * final summary; rows emitted before any read/sink/change error are provisional.
 * sourceId identifies a logical file within a snapshot, independent of its path.
 */
export async function auditUsageSnapshot(file, sourceId, { onRow = () => {} } = {}) {
  if (!textField(sourceId) || sourceId.length > 512)
    throw new Error('Explicit source-id required (1–512 characters).');
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Snapshot must be a regular file.');
    const summary = {
      type: 'summary',
      version: 1,
      sourceIdSha256: sha256(sourceId),
      totalLines: 0,
      reviewRequired: 0,
      quarantined: 0,
      excluded: 0,
    };
    const snapshotHash = createHash('sha256');
    let lineHash = createHash('sha256');
    let parts = [];
    let lineBytes = 0;
    let byteOffset = 0;
    let totalBytes = 0;
    async function emitLine(newlineBytes) {
      const contentSha256 = lineHash.digest('hex');
      const result =
        lineBytes > MAX_LINE_BYTES
          ? { disposition: 'quarantined', reason: 'line-too-large' }
          : classify(Buffer.concat(parts, lineBytes));
      summary.totalLines++;
      summary[result.disposition]++;
      await onRow({
        type: 'row',
        line: summary.totalLines,
        byteOffset,
        byteLength: lineBytes,
        contentSha256,
        sourceKey: sha256(JSON.stringify([sourceId, byteOffset, contentSha256])),
        ...result,
      });
      byteOffset += lineBytes + newlineBytes;
      parts = [];
      lineBytes = 0;
      lineHash = createHash('sha256');
    }
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      snapshotHash.update(chunk);
      totalBytes += chunk.length;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        lineHash.update(part);
        lineBytes += part.length;
        if (lineBytes <= MAX_LINE_BYTES) parts.push(part);
        else parts = [];
        if (newline !== -1) await emitLine(1);
        start = end + 1;
      }
    }
    if (lineBytes > 0) await emitLine(0);
    const after = await handle.stat();
    if (
      before.size !== totalBytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('Snapshot changed during audit. Discard provisional rows.');
    }
    return { ...summary, totalBytes, snapshotSha256: snapshotHash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--file' || args[2] !== '--source-id') {
    throw new Error(
      'Usage: node scripts/audit-usage-snapshot.mjs --file <isolated-snapshot.jsonl> --source-id <snapshot/file-id>',
    );
  }
  const write = (entry) =>
    new Promise((resolve, reject) => {
      process.stdout.write(JSON.stringify(entry) + '\n', (error) =>
        error ? reject(error) : resolve(),
      );
    });
  const summary = await auditUsageSnapshot(args[1], args[3], { onRow: write });
  await write(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Avoid raw filesystem paths or row contents in diagnostics.
  process.stdout.on('error', () => {
    process.exitCode = 1;
  });
  main().catch(() => {
    process.stderr.write(
      'Usage snapshot audit failed. Require --file and --source-id; discard output without a final summary.\n',
    );
    process.exitCode = 1;
  });
}
