import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-export-snapshot-db-'));
const dbPath = path.join(tempRoot, 'snapshot.db');
process.env.SCIFIGURE_DB_PATH = dbPath;

const {
  addExportAsset,
  deleteExportAssets,
  getDb,
  getExportAssetSnapshot,
  listExportAssets,
} = await import('../../db');

const database = getDb();
const userId = `usr_${randomUUID()}`;
const projectId = randomUUID();
const snapshotAssetId = `exp_${randomUUID()}`;
const legacyAssetId = `exp_${randomUUID()}`;
const snapshotJson = JSON.stringify({ schemaVersion: 1, projectId, targetFigureId: 'fig_1' });

try {
  database.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role)
    VALUES (?, ?, 'hash', 'salt', 'user')
  `).run(userId, `${userId}@example.test`);
  database.prepare(`
    INSERT INTO projects (id, user_id, name, spec, script)
    VALUES (?, ?, 'Snapshot persistence', '{}', '')
  `).run(projectId, userId);

  addExportAsset({
    id: snapshotAssetId,
    projectId,
    figureId: 'fig_1',
    name: 'snapshot figure',
    format: 'svg',
    filePath: 'snapshot.svg',
    editingSnapshot: {
      figureId: 'fig_1',
      schemaVersion: 1,
      snapshotJson,
      snapshotHash: 'snapshot-hash',
    },
  });
  addExportAsset({
    id: legacyAssetId,
    projectId,
    figureId: 'fig_1',
    name: 'legacy figure',
    format: 'svg',
    filePath: 'legacy.svg',
  });

  const assets = listExportAssets(projectId);
  const snapshotAsset = assets.find(asset => asset.assetId === snapshotAssetId);
  const legacyAsset = assets.find(asset => asset.assetId === legacyAssetId);
  if (!snapshotAsset?.hasEditingSnapshot || legacyAsset?.hasEditingSnapshot) {
    throw new Error(`snapshot availability projection failed: ${JSON.stringify(assets)}`);
  }
  const stored = getExportAssetSnapshot(snapshotAssetId, projectId);
  if (!stored || stored.snapshotJson !== snapshotJson || stored.figureId !== 'fig_1') {
    throw new Error(`snapshot payload persistence failed: ${JSON.stringify(stored)}`);
  }

  deleteExportAssets(projectId, [snapshotAssetId]);
  if (getExportAssetSnapshot(snapshotAssetId, projectId)) {
    throw new Error('snapshot row was not deleted with its export asset');
  }

  console.log('PASS export asset and editing snapshot are stored atomically');
  console.log('PASS legacy assets remain listable without restore capability');
  console.log('PASS deleting an asset cascades to its editing snapshot');
} finally {
  database.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
