/**
 * BaseRepository against a real PostgreSQL: the common queries every
 * repository inherits. Uses TenantRepository as the concrete subclass and
 * the e2e test database (see vitest.config.e2e.ts).
 */

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import configuration from '../src/config/configuration.js';
import { buildDataSourceOptions } from '../src/database/postgres/postgres.options.js';
import { Tenant } from '../src/models/index.js';
import { TenantRepository } from '../src/modules/tenant/tenant.repository.js';

/** Exposes the protected helpers for testing. */
class TestTenantRepository extends TenantRepository {
  raw<R>(sql: string, params: unknown[] = []) {
    return this.rawQuery<R>(sql, params);
  }
  page(limit: number, cursor?: string, slugPrefix?: string) {
    const qb = this.queryBuilder('t').where('t.slug LIKE :p', { p: `${slugPrefix}%` });
    return this.paginateByCursor(qb, 't', limit, cursor);
  }
}

describe('BaseRepository (PostgreSQL)', () => {
  let dataSource: DataSource;
  let repo: TestTenantRepository;
  // Unique per run, so tests never see each other's rows.
  const prefix = `base-${randomUUID().slice(0, 8)}-`;
  const slug = (n: number | string) => `${prefix}${n}`;

  beforeAll(async () => {
    dataSource = new DataSource({ ...buildDataSourceOptions(configuration().app.database), migrationsRun: true });
    await dataSource.initialize();
    await dataSource.runMigrations();
    repo = new TestTenantRepository(dataSource.getRepository(Tenant));
  });

  afterAll(async () => {
    await dataSource?.query(`DELETE FROM tenants WHERE slug LIKE $1`, [`${prefix}%`]);
    await dataSource?.destroy();
  });

  it('create returns the row with database defaults; findById / findOne read it back', async () => {
    const created = await repo.create({ name: 'A', slug: slug('a') });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.isActive).toBe(true);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect((await repo.findById(created.id))?.slug).toBe(slug('a'));
    expect((await repo.findOne({ slug: slug('a') }))?.id).toBe(created.id);
    expect(await repo.findById(randomUUID())).toBeNull();
  });

  it('exists, count, findMany and pluck', async () => {
    await repo.insert([
      { name: 'B', slug: slug('b') },
      { name: 'C', slug: slug('c') },
    ]);
    expect(await repo.exists({ slug: slug('b') })).toBe(true);
    expect(await repo.exists({ slug: slug('zzz') })).toBe(false);
    expect(await repo.count({ name: 'B' })).toBeGreaterThanOrEqual(1);
    const many = await repo.findMany([{ slug: slug('b') }, { slug: slug('c') }], { order: { slug: 'ASC' } });
    expect(many.map((t) => t.name)).toEqual(['B', 'C']);
    expect(await repo.pluck('name', { slug: slug('c') })).toEqual(['C']);
  });

  it('updateWhere is a conditional update: 0 rows when the expected state no longer holds', async () => {
    const t = await repo.create({ name: 'D', slug: slug('d') });
    // First "deactivate if active" wins...
    expect(await repo.updateWhere({ id: t.id, isActive: true }, { isActive: false })).toBe(1);
    // ...a concurrent second one sees no matching row.
    expect(await repo.updateWhere({ id: t.id, isActive: true }, { isActive: false })).toBe(0);
    expect(await repo.updateById(t.id, { name: 'D2' })).toBe(true);
    expect(await repo.updateById(randomUUID(), { name: 'nobody' })).toBe(false);
  });

  it('upsert inserts, then updates on conflict', async () => {
    await repo.upsert({ name: 'E', slug: slug('e') }, ['slug']);
    await repo.upsert({ name: 'E2', slug: slug('e') }, ['slug']);
    const rows = await repo.findMany({ slug: slug('e') });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('E2');
  });

  it('deleteWhere returns the number of deleted rows', async () => {
    await repo.create({ name: 'F', slug: slug('f') });
    expect(await repo.deleteWhere({ slug: slug('f') })).toBe(1);
    expect(await repo.deleteWhere({ slug: slug('f') })).toBe(0);
  });

  it('rawQuery returns rows for SELECT and for UPDATE ... RETURNING alike', async () => {
    const t = await repo.create({ name: 'G', slug: slug('g') });
    const selected = await repo.raw<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [t.id]);
    expect(selected).toEqual([{ name: 'G' }]);
    // TypeORM returns [rows, count] for UPDATE; rawQuery normalises it.
    const updated = await repo.raw<{ name: string }>(`UPDATE tenants SET name = $2 WHERE id = $1 RETURNING name`, [t.id, 'G2']);
    expect(updated).toEqual([{ name: 'G2' }]);
    const none = await repo.raw(`UPDATE tenants SET name = 'x' WHERE id = $1 RETURNING name`, [randomUUID()]);
    expect(none).toEqual([]);
  });

  it('paginateByCursor walks every row exactly once, newest first', async () => {
    const pagePrefix = `${prefix}page-`;
    for (let i = 0; i < 5; i++) await repo.create({ name: `P${i}`, slug: `${pagePrefix}${i}` });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.page(2, cursor, pagePrefix);
      seen.push(...page.data.map((t) => t.name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['P4', 'P3', 'P2', 'P1', 'P0']);
  });

  it('transaction commits all or nothing', async () => {
    await expect(
      repo.transaction(async (manager) => {
        await manager.getRepository(Tenant).save({ name: 'H', slug: slug('h') });
        throw new Error('fail after the first insert');
      }),
    ).rejects.toThrow('fail after the first insert');
    // Rolled back: the insert inside the failed transaction is gone.
    expect(await repo.exists({ slug: slug('h') })).toBe(false);

    await repo.transaction(async (manager) => {
      await manager.getRepository(Tenant).save({ name: 'I', slug: slug('i') });
    });
    expect(await repo.exists({ slug: slug('i') })).toBe(true);
  });
});
