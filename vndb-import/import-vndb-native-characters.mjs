#!/usr/bin/env node
'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ROOT = path.resolve('vndb-import');
const OUTPUT = path.join(ROOT, 'out');
const BITMAP_FILE = path.join(ROOT, 'ids.bitmap.gz.b64');
const CHECKPOINT_FILE = path.join(OUTPUT, 'checkpoint.json');
const API = 'https://api.vndb.org/kana/character';
const WORKS_PER_QUERY = 100;
const RESULTS_PER_PAGE = 100;
const INTERVAL_MS = 6500;
const TIMEOUT_MS = 2900;
const EXPECTED_IDS = 7200;
const EXPECTED_MAX_ID = 69757;
const FIELDS = 'id,name,original,aliases,image.url,vns{id,title,role,spoiler}';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(temp, value, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function loadVndbIds() {
  const encoded = fs.readFileSync(BITMAP_FILE, 'utf8').trim();
  const bitmap = zlib.gunzipSync(Buffer.from(encoded, 'base64'));
  if (bitmap.length !== Math.ceil((EXPECTED_MAX_ID + 1) / 8)) {
    throw new Error('VNDB ID bitmap length mismatch: ' + bitmap.length);
  }
  const ids = [];
  for (let id = 1; id <= EXPECTED_MAX_ID; id++) {
    if (bitmap[id >> 3] & (1 << (id & 7))) ids.push('v' + id);
  }
  if (ids.length !== EXPECTED_IDS || ids[0] !== 'v2' || ids[ids.length - 1] !== 'v' + EXPECTED_MAX_ID) {
    throw new Error('VNDB ID bitmap validation failed: count=' + ids.length + ', last=' + ids.at(-1));
  }
  return ids;
}

function safeImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function mergeCharacter(row, allowedWorks, characters) {
  const id = typeof row?.id === 'string' && /^c[1-9]\d{0,9}$/.test(row.id.trim()) ? row.id.trim() : null;
  const name = String(row?.name || '').trim();
  if (!id || !name) return;
  let item = characters[id];
  if (!item) {
    item = characters[id] = {
      id,
      vndbCharacterId: id,
      name,
      original: typeof row.original === 'string' ? row.original : null,
      aliases: [],
      imageUrl: safeImageUrl(row.image?.url),
      appearances: []
    };
  } else {
    if (!item.original && typeof row.original === 'string') item.original = row.original;
    if (!item.imageUrl) item.imageUrl = safeImageUrl(row.image?.url);
  }
  if (Array.isArray(row.aliases)) {
    item.aliases = [...new Set([...item.aliases, ...row.aliases
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => value.trim())])];
  }
  for (const appearance of Array.isArray(row.vns) ? row.vns : []) {
    const vndbId = typeof appearance?.id === 'string' && /^v[1-9]\d{0,9}$/.test(appearance.id) ? appearance.id : null;
    if (!vndbId || !allowedWorks.has(vndbId)) continue;
    const candidateRole = String(appearance.role || '').toLowerCase();
    const role = ['main', 'primary', 'side', 'appears'].includes(candidateRole) ? candidateRole : 'appears';
    const spoiler = Number.isSafeInteger(appearance.spoiler) && appearance.spoiler >= 0 ? appearance.spoiler : null;
    if (!item.appearances.some(a => a.vndbId === vndbId && a.role === role && a.spoiler === spoiler)) {
      item.appearances.push({ vndbId, role, spoiler });
    }
  }
}

function makeFilter(ids) {
  const clauses = ids.map(id => ['id', '=', id]);
  return ['vn', '=', clauses.length === 1 ? clauses[0] : ['or', ...clauses]];
}

let lastRequestAt = 0;
let requestCount = 0;
let pageCount = 0;

async function request(body) {
  const wait = INTERVAL_MS - (Date.now() - lastRequestAt);
  if (lastRequestAt && wait > 0) await sleep(wait);

  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    lastRequestAt = Date.now();
    requestCount++;
    try {
      const response = await fetch(API, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'AMQ-EMQ-VNDB-Character-Import/1.0'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (response.status === 429) {
        if (attempt === 3) throw new Error('VNDB rate limit persisted after bounded 5-minute recovery waits');
        const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000;
        await sleep(Math.max(300000, retryAfter));
        lastRequestAt = 0;
        continue;
      }
      if (response.status >= 500 && attempt < 3) {
        await sleep(30000 * (attempt + 1));
        lastRequestAt = 0;
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error('VNDB API HTTP ' + response.status + (text ? ': ' + text.slice(0, 500) : ''));
        error.status = response.status;
        throw error;
      }
      const data = await response.json();
      if (!data || !Array.isArray(data.results) || typeof data.more !== 'boolean') {
        throw new Error('VNDB character response has an invalid shape');
      }
      pageCount++;
      return data;
    } catch (error) {
      if (error?.status) throw error;
      if (attempt === 3) throw error;
      const aborted = error?.name === 'AbortError';
      await sleep(aborted ? 15000 * (attempt + 1) : 30000 * (attempt + 1));
      lastRequestAt = 0;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('VNDB request retry loop ended unexpectedly');
}

function writeCheckpoint(checkpoint) {
  checkpoint.updatedAt = new Date().toISOString();
  checkpoint.requestCount = requestCount;
  checkpoint.pageCount = pageCount;
  atomicWrite(CHECKPOINT_FILE, JSON.stringify(checkpoint) + '\n');
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const ids = loadVndbIds();
  const bitmapHash = sha256(fs.readFileSync(BITMAP_FILE));
  let checkpoint = {
    schemaVersion: 1,
    source: 'VNDB Kana API v2',
    bitmapSha256: bitmapHash,
    totalVndbWorks: ids.length,
    processedVndbIds: [],
    inProgressGroupVndbIds: null,
    nextPage: 1,
    characters: {},
    requestCount: 0,
    pageCount: 0
  };

  if (fs.existsSync(CHECKPOINT_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
    if (saved.schemaVersion !== 1 || saved.source !== checkpoint.source
      || saved.bitmapSha256 !== bitmapHash || saved.totalVndbWorks !== ids.length
      || !Array.isArray(saved.processedVndbIds) || !saved.characters || typeof saved.characters !== 'object') {
      throw new Error('Existing remote-run checkpoint does not match the exact VNDB ID set; refusing unsafe resume');
    }
    checkpoint = saved;
    requestCount = Number(saved.requestCount) || 0;
    pageCount = Number(saved.pageCount) || 0;
  }

  const processed = new Set(checkpoint.processedVndbIds);
  const pending = ids.filter(id => !processed.has(id));
  for (let offset = 0; offset < pending.length; offset += WORKS_PER_QUERY) {
    const group = pending.slice(offset, offset + WORKS_PER_QUERY);
    if (checkpoint.inProgressGroupVndbIds
      && JSON.stringify(checkpoint.inProgressGroupVndbIds) !== JSON.stringify(group)) {
      throw new Error('Checkpoint group does not match the first pending 100-work group');
    }
    const page = checkpoint.inProgressGroupVndbIds ? checkpoint.nextPage : 1;
    const allowedWorks = new Set(group);
    let currentPage = page;
    while (true) {
      let response;
      try {
        response = await request({
          filters: makeFilter(group),
          fields: FIELDS,
          sort: 'id',
          reverse: false,
          results: RESULTS_PER_PAGE,
          page: currentPage
        });
      } catch (error) {
        checkpoint.error = {
          at: new Date().toISOString(),
          message: error.message,
          code: error.code || null,
          status: error.status || null,
          group,
          page: currentPage
        };
        writeCheckpoint(checkpoint);
        throw error;
      }
      for (const row of response.results) mergeCharacter(row, allowedWorks, checkpoint.characters);
      checkpoint.error = null;
      if (response.more) {
        checkpoint.inProgressGroupVndbIds = group;
        checkpoint.nextPage = currentPage + 1;
        writeCheckpoint(checkpoint);
        currentPage++;
      } else {
        for (const id of group) processed.add(id);
        checkpoint.processedVndbIds = [...processed].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
        checkpoint.inProgressGroupVndbIds = null;
        checkpoint.nextPage = 1;
        writeCheckpoint(checkpoint);
        break;
      }
    }
    console.log(JSON.stringify({
      groupsCompleted: processed.size,
      totalWorks: ids.length,
      requests: requestCount,
      pages: pageCount,
      characters: Object.keys(checkpoint.characters).length
    }));
  }

  const characters = Object.values(checkpoint.characters)
    .map(item => ({
      ...item,
      aliases: [...new Set(item.aliases)].sort(),
      appearances: item.appearances.sort((a, b) =>
        a.vndbId.localeCompare(b.vndbId) || a.role.localeCompare(b.role) || (a.spoiler ?? -1) - (b.spoiler ?? -1))
    }))
    .sort((a, b) => a.vndbCharacterId.localeCompare(b.vndbCharacterId));

  const result = {
    schemaVersion: 1,
    source: 'VNDB Kana API v2',
    retrievedAt: new Date().toISOString(),
    bitmapSha256: bitmapHash,
    queriedVndbWorks: ids.length,
    requestCount,
    pageCount,
    counts: {
      characters: characters.length,
      uniqueAppearances: characters.reduce((sum, item) => sum + item.appearances.length, 0),
      worksWithCharacters: new Set(characters.flatMap(item => item.appearances.map(a => a.vndbId))).size
    },
    characters
  };
  const outputPath = path.join(OUTPUT, 'vndb-character-raw-export.json');
  atomicWrite(outputPath, JSON.stringify(result) + '\n');
  atomicWrite(path.join(OUTPUT, 'summary.json'), JSON.stringify({
    completed: true,
    retrievedAt: result.retrievedAt,
    source: result.source,
    queriedVndbWorks: result.queriedVndbWorks,
    requestCount: result.requestCount,
    pageCount: result.pageCount,
    counts: result.counts,
    bitmapSha256: bitmapHash
  }, null, 2) + '\n');
  atomicWrite(path.join(OUTPUT, 'sha256.txt'), sha256(fs.readFileSync(outputPath)) + '  vndb-character-raw-export.json\n');
  fs.unlinkSync(CHECKPOINT_FILE);
  console.log('VNDB native character import completed.');
}

main().catch(error => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  atomicWrite(path.join(OUTPUT, 'error.json'), JSON.stringify({
    at: new Date().toISOString(),
    message: error.message,
    code: error.code || null,
    status: error.status || null
  }, null, 2) + '\n');
  console.error(error.stack || error);
  process.exitCode = 1;
});
