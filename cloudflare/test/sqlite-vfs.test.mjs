import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteVfs, createSchema, seedMetadata, PAGE_SIZE } from '../src/sqlite-vfs.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...args) {
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
    return { [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows };
  } };
  createSchema(sql);
  seedMetadata(sql, { dirs: ['/'], files: [] });
  return { db, sql, vfs: new SqliteVfs(sql) };
}

test('sparse writes, page boundaries and truncate/regrow preserve filesystem semantics', () => {
  const { sql, vfs } = fixture();
  const node = vfs.create('/test');
  vfs.write(node, PAGE_SIZE - 2, Uint8Array.of(1, 2, 3, 4));
  assert.deepEqual(vfs.read(node, PAGE_SIZE - 4, 8), Uint8Array.of(0, 0, 1, 2, 3, 4));
  vfs.truncate(node, PAGE_SIZE - 1);
  vfs.truncate(node, PAGE_SIZE + 2);
  assert.deepEqual(vfs.read(node, PAGE_SIZE - 2, 4), Uint8Array.of(1, 0, 0, 0));
  vfs.flush();
  const restored = new SqliteVfs(sql);
  assert.deepEqual(restored.read(restored.get('/test'), PAGE_SIZE - 2, 4), Uint8Array.of(1, 0, 0, 0));
});

test('seed bytes spanning pages are lazy and truncation masks their old contents', () => {
  const { sql } = fixture();
  const first = new Uint8Array(PAGE_SIZE).fill(7);
  const second = new Uint8Array(PAGE_SIZE).fill(9);
  sql.exec('INSERT INTO seed_pages VALUES (?, ?)', 0, first);
  sql.exec('INSERT INTO seed_pages VALUES (?, ?)', 1, second);
  seedMetadata(sql, { dirs: ['/'], files: [{ path: '/seed', off: PAGE_SIZE - 2, len: 4 }] });
  const vfs = new SqliteVfs(sql), node = vfs.get('/seed');
  assert.deepEqual(vfs.read(node, 0, 4), Uint8Array.of(7, 7, 9, 9));
  vfs.truncate(node, 1);
  vfs.truncate(node, 4);
  assert.deepEqual(vfs.read(node, 0, 4), Uint8Array.of(7, 0, 0, 0));
});

test('directory rename and unlink persist; unlinked open file retains its inode until request ends', () => {
  const { sql, vfs } = fixture();
  vfs.mkdir('/a');
  const node = vfs.create('/a/file');
  vfs.write(node, 0, Uint8Array.of(8));
  assert.equal(vfs.rename('/a', '/b'), 0);
  vfs.flush();
  const next = new SqliteVfs(sql);
  assert.equal(next.get('/a'), undefined);
  assert.deepEqual(next.read(next.get('/b/file'), 0, 1), Uint8Array.of(8));
  next.unlink('/b/file');
  next.flush();
  assert.equal(sql.exec('SELECT * FROM fs_pages').toArray().length, 0);
});

test('outer SQLite rollback discards page and metadata changes together', () => {
  const { db, sql, vfs } = fixture();
  db.exec('BEGIN');
  const node = vfs.create('/uncommitted');
  vfs.write(node, 0, Uint8Array.of(42));
  vfs.flush();
  db.exec('ROLLBACK');
  assert.equal(new SqliteVfs(sql).get('/uncommitted'), undefined);
  assert.equal(sql.exec('SELECT * FROM fs_pages').toArray().length, 0);
});
