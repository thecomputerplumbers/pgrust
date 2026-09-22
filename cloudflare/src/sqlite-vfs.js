import { Vfs } from '../../wasm/pgrust-wasi.js';

export const PAGE_SIZE = 65536;
const MAX_FILE_SIZE = 64 * 1024 * 1024;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;

// One SQL request is one outer SQLite transaction. Never retain this object
// after an exception: its in-memory metadata may describe rolled-back writes.
export class SqliteVfs extends Vfs {
  constructor(sql) {
    super(new Uint8Array(), { dirs: [], files: [] });
    this.sql = sql;
    this.nodes.clear();
    this.original = new Map();
    this.operations = 0;
    for (const row of sql.exec('SELECT path, metadata FROM fs_nodes')) {
      const node = JSON.parse(row.metadata);
      this.nodes.set(row.path, node);
      this.original.set(row.path, row.metadata);
      this.nextIno = Math.max(this.nextIno, node.ino + 1);
    }
  }

  check() {
    if (++this.operations > 50000) throw new Error('Filesystem operation budget exceeded');
  }

  size(node) { return node.length; }

  create(path) {
    const node = super.create(path);
    delete node.data;
    node.length = 0;
    node.sourceLength = 0;
    return node;
  }

  seedRead(offset, length) {
    const bytes = new Uint8Array(length);
    for (let done = 0; done < length;) {
      const at = offset + done;
      const page = Math.floor(at / PAGE_SIZE);
      const within = at % PAGE_SIZE;
      const count = Math.min(length - done, PAGE_SIZE - within);
      const row = this.sql.exec('SELECT data FROM seed_pages WHERE page = ?', page).toArray()[0];
      if (row) bytes.set(new Uint8Array(row.data).subarray(within, within + count), done);
      done += count;
    }
    return bytes;
  }

  page(node, page) {
    this.check();
    const row = this.sql.exec('SELECT data FROM fs_pages WHERE ino = ? AND page = ?', node.ino, page).toArray()[0];
    if (row) return new Uint8Array(row.data).slice();
    const bytes = new Uint8Array(PAGE_SIZE);
    const start = page * PAGE_SIZE;
    const count = Math.min(PAGE_SIZE, (node.sourceLength || 0) - start);
    if (count > 0) bytes.set(this.seedRead(node.sourceOffset + start, count));
    return bytes;
  }

  read(node, offset, length) {
    const count = Math.max(0, Math.min(length, node.length - offset));
    const bytes = new Uint8Array(count);
    for (let done = 0; done < count;) {
      const at = offset + done;
      const page = Math.floor(at / PAGE_SIZE);
      const within = at % PAGE_SIZE;
      const n = Math.min(count - done, PAGE_SIZE - within);
      bytes.set(this.page(node, page).subarray(within, within + n), done);
      done += n;
    }
    return bytes;
  }

  savePage(node, page, bytes) {
    this.sql.exec('INSERT OR REPLACE INTO fs_pages (ino, page, data) VALUES (?, ?, ?)', node.ino, page, bytes);
  }

  write(node, offset, bytes) {
    if (offset < 0 || offset + bytes.length > MAX_FILE_SIZE) throw new Error('Experimental file size limit exceeded');
    for (let done = 0; done < bytes.length;) {
      const at = offset + done;
      const page = Math.floor(at / PAGE_SIZE);
      const within = at % PAGE_SIZE;
      const n = Math.min(bytes.length - done, PAGE_SIZE - within);
      const data = within === 0 && n === PAGE_SIZE ? new Uint8Array(PAGE_SIZE) : this.page(node, page);
      data.set(bytes.subarray(done, done + n), within);
      this.savePage(node, page, data);
      done += n;
    }
    node.length = Math.max(node.length, offset + bytes.length);
    node.mtime = Math.floor(Date.now() / 1000);
  }

  truncate(node, size) {
    if (size < 0 || size > MAX_FILE_SIZE) throw new Error('Experimental file size limit exceeded');
    if (size < node.length) {
      if (size % PAGE_SIZE) {
        const page = Math.floor(size / PAGE_SIZE);
        const data = this.page(node, page);
        data.fill(0, size % PAGE_SIZE);
        this.savePage(node, page, data);
      }
      this.sql.exec('DELETE FROM fs_pages WHERE ino = ? AND page >= ?', node.ino, Math.ceil(size / PAGE_SIZE));
      node.sourceLength = Math.min(node.sourceLength || 0, size);
    }
    node.length = size;
    node.mtime = Math.floor(Date.now() / 1000);
  }

  flush() {
    let logicalBytes = 0;
    for (const path of this.original.keys()) {
      if (!this.nodes.has(path)) this.sql.exec('DELETE FROM fs_nodes WHERE path = ?', path);
    }
    const liveInodes = new Set();
    for (const [path, node] of this.nodes) {
      logicalBytes += node.length || 0;
      liveInodes.add(node.ino);
      const metadata = JSON.stringify(node);
      if (this.original.get(path) !== metadata) {
        this.sql.exec('INSERT OR REPLACE INTO fs_nodes (path, metadata) VALUES (?, ?)', path, metadata);
      }
    }
    if (logicalBytes > MAX_DATABASE_BYTES) throw new Error('Experimental database size limit exceeded');
    for (const row of this.sql.exec('SELECT DISTINCT ino FROM fs_pages').toArray()) {
      if (!liveInodes.has(row.ino)) this.sql.exec('DELETE FROM fs_pages WHERE ino = ?', row.ino);
    }
    return { logicalBytes, filesystemOperations: this.operations };
  }
}

export function createSchema(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS fs_nodes (path TEXT PRIMARY KEY, metadata TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS fs_pages (ino INTEGER NOT NULL, page INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (ino, page))');
  sql.exec('CREATE TABLE IF NOT EXISTS seed_pages (page INTEGER PRIMARY KEY, data BLOB NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

export function seedMetadata(sql, manifest) {
  const vfs = new Vfs(new Uint8Array(), { dirs: manifest.dirs, files: [] });
  for (const file of manifest.files) {
    const node = vfs.create(file.path);
    delete node.data;
    Object.assign(node, { length: file.len, sourceOffset: file.off, sourceLength: file.len, mtime: file.mtime || 0 });
  }
  for (const [path, node] of vfs.nodes) {
    sql.exec('INSERT OR REPLACE INTO fs_nodes (path, metadata) VALUES (?, ?)', path, JSON.stringify(node));
  }
}
