export const benchmarkSetup = [
  'CREATE TABLE IF NOT EXISTS __cf_benchmark_rows (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)',
  'DELETE FROM __cf_benchmark_rows',
  'WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM n WHERE id<1000) INSERT INTO __cf_benchmark_rows SELECT id, id*3 FROM n',
];

export const benchmarkQueries = {
  select1: ['SELECT 1 AS answer'],
  point: ['SELECT amount AS answer FROM __cf_benchmark_rows WHERE id=500'],
  scan: ['SELECT SUM(amount) AS answer FROM __cf_benchmark_rows'],
  update: ['UPDATE __cf_benchmark_rows SET amount=amount+1 WHERE id=500 RETURNING amount AS answer'],
  batch100: Array(100).fill('SELECT 1 AS answer'),
};
