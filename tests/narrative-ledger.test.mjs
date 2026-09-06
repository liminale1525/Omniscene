import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  QIANMU_NARRATIVE_ENTRY_SCHEMA,
  QIANMU_NARRATIVE_LEDGER_SCHEMA,
  canExposeNarrativeLedgerEntryToMainline,
  invalidateNarrativeLedgerEntries,
  normalizeNarrativeLedgerEntry,
  validateNarrativeLedger,
  validateNarrativeLedgerEntry,
} from '../qianmu-narrative-ledger.js';

const proseFact = {
  owner: { chatKey: 'chat-a' },
  source: { kind: 'prose', authority: 'canon', recordId: 'message-12', floor: 12, revisionId: 'swipe-2' },
  fact: { subjectIds: ['alice'], predicate: 'wears', object: 'red coat', summary: 'Alice 穿着红外套。' },
  temporalState: 'present',
  confidence: { state: 'confirmed', score: 1 },
  readerVisibility: { scope: 'mainline' },
  continuity: { state: 'active', conditions: [{ kind: 'swipe_changed', refId: 'swipe-2' }] },
};

test('prose facts keep canonical source identity and may reach the mainline', () => {
  const result = validateNarrativeLedgerEntry(proseFact, 'chat-a');
  assert.equal(result.ok, true);
  assert.equal(result.entry.schema, QIANMU_NARRATIVE_ENTRY_SCHEMA);
  assert.equal(result.entry.source.authority, 'canon');
  assert.equal(result.entry.source.floor, 12);
  assert.equal(result.entry.confidence.state, 'confirmed');
  assert.equal(canExposeNarrativeLedgerEntryToMainline(result.entry, 'user'), true);
});

test('simulation possibilities cannot self-promote into prose facts or reader-visible truth', () => {
  const raw = {
    owner: { chatKey: 'chat-a' },
    source: { kind: 'simulation', authority: 'canon', recordId: 'director-plan-7', field: 'npc_updates' },
    fact: { summary: 'Alice 或许会烧掉来信。' },
    confidence: { state: 'confirmed', score: 1 },
    readerVisibility: { scope: 'mainline', viewerIds: ['user'] },
    continuity: { state: 'active' },
  };
  const result = validateNarrativeLedgerEntry(raw, 'chat-a');
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('source_authority_mismatch'));
  assert.ok(result.issues.includes('simulation_cannot_confirm'));
  assert.ok(result.issues.includes('simulation_cannot_reveal'));
  assert.equal(result.entry.source.authority, 'possibility');
  assert.equal(result.entry.confidence.state, 'possible');
  assert.equal(result.entry.confidence.score, .69);
  assert.equal(result.entry.readerVisibility.scope, 'director_only');
  assert.equal(canExposeNarrativeLedgerEntryToMainline(result.entry, 'user'), false);
});

test('unknown sources fail closed as director-only possibilities', () => {
  const raw = { owner: { chatKey: 'chat-a' }, source: { kind: 'model_guess', recordId: 'x' }, fact: { summary: '未知来源。' } };
  const result = validateNarrativeLedgerEntry(raw, 'chat-a');
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('source_kind_invalid'));
  assert.equal(result.entry.source.kind, 'simulation');
  assert.equal(result.entry.readerVisibility.scope, 'director_only');
});

test('ledger validation is bounded, chat-owned and rejects duplicate facts', () => {
  const first = normalizeNarrativeLedgerEntry(proseFact);
  const otherChat = { ...proseFact, owner: { chatKey: 'chat-b' }, entryId: 'other' };
  const result = validateNarrativeLedger({
    owner: { chatKey: 'chat-a' },
    entries: [first, { ...first }, otherChat],
  });
  assert.equal(result.ledger.schema, QIANMU_NARRATIVE_LEDGER_SCHEMA);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('entry_1_duplicate_id'));
  assert.ok(result.issues.includes('entry_2_owner_chat_mismatch'));
});

test('normalization strips prompts, credentials, URLs and arbitrary payloads', () => {
  const normalized = normalizeNarrativeLedgerEntry({
    ...proseFact,
    prompt: 'secret prompt',
    apiKey: 'secret-key',
    url: 'https://example.invalid/image.png',
    blob: new Blob(['x']),
    source: { ...proseFact.source, response: { raw: 'provider data' } },
    fact: { ...proseFact.fact, imageData: 'data:image/png;base64,AAAA' },
  });
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /secret prompt|secret-key|example\.invalid|provider data|base64/);
});

test('source lifecycle events invalidate matching facts but retain their audit trail', () => {
  const swipeFact = normalizeNarrativeLedgerEntry(proseFact);
  const otherFact = normalizeNarrativeLedgerEntry({
    ...proseFact,
    entryId: 'other-fact',
    source: { ...proseFact.source, recordId: 'message-15', floor: 15, revisionId: 'swipe-8' },
    continuity: { state: 'active', conditions: [{ kind: 'source_deleted', refId: 'message-15' }] },
  });
  const original = { owner: { chatKey: 'chat-a' }, entries: [swipeFact, otherFact], revision: 3 };
  const result = invalidateNarrativeLedgerEntries(original, {
    chatKey: 'chat-a', kind: 'swipe_changed', revisionId: 'swipe-2', updatedAt: '2026-09-03T10:00:00Z',
  });
  assert.deepEqual(result.invalidatedEntryIds, [swipeFact.entryId]);
  assert.equal(result.ledger.revision, 4);
  assert.equal(result.ledger.entries[0].continuity.state, 'invalidated');
  assert.deepEqual(result.ledger.entries[0].continuity.invalidatedBy, ['swipe_changed:swipe-2']);
  assert.equal(result.ledger.entries[1].continuity.state, 'active');
  assert.equal(canExposeNarrativeLedgerEntryToMainline(result.ledger.entries[0], 'user'), false);
  assert.equal(original.entries[0].continuity.state, 'active', 'the source ledger is not mutated');
});

test('floor deletion, explicit supersession and cross-chat requests fail safely', () => {
  const ledger = { owner: { chatKey: 'chat-a' }, entries: [proseFact], revision: 1 };
  const foreign = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-b', kind: 'source_deleted', floor: 12 });
  assert.equal(foreign.issue, 'owner_chat_mismatch');
  assert.equal(foreign.ledger.entries[0].continuity.state, 'active');
  const deleted = invalidateNarrativeLedgerEntries(ledger, { chatKey: 'chat-a', kind: 'source_deleted', floor: 12 });
  assert.equal(deleted.ledger.entries[0].continuity.state, 'invalidated');
  const superseded = invalidateNarrativeLedgerEntries(ledger, {
    chatKey: 'chat-a', kind: 'superseded', entryIds: [deleted.ledger.entries[0].entryId],
  });
  assert.equal(superseded.ledger.entries[0].continuity.state, 'superseded');
  const repeated = invalidateNarrativeLedgerEntries(deleted.ledger, { chatKey: 'chat-a', kind: 'source_deleted', floor: 12 });
  assert.equal(repeated.ledger.revision, deleted.ledger.revision, 'repeated events remain idempotent');
});

test('the ledger contract remains a lazy release chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
assert.match(source, /narrativeLedger:\s*\{[\s\S]*import\('\.\/qianmu-narrative-ledger\.js\?v=1\.59\.66'\)/);
  const init = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(init, /featureRuntime\.load\('narrativeLedger'\)/);
  assert.ok(release.files.includes('qianmu-narrative-ledger.js'));
});
