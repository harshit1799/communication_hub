/**
 * Base repository (DAO) with the common PostgreSQL queries, the counterpart
 * of the backend's EncryptedAbstractRepository. Every repository extends it:
 *
 *   @Injectable()
 *   export class TenantRepository extends BaseRepository<Tenant> {
 *     constructor(@InjectRepository(Tenant) repository: Repository<Tenant>) {
 *       super(repository);
 *     }
 *     findBySlug(slug: string) { return this.findOne({ slug }); }
 *   }
 *
 * Repositories add their domain queries (named after what they mean, e.g.
 * markSent, claimStuck) on top of these helpers. Services only ever call
 * repositories, never TypeORM directly.
 *
 * All queries are parameterized (TypeORM find options, query builder
 * parameters, or $1..$n in rawQuery), never string-concatenated.
 */

import {
  Brackets,
  DeepPartial,
  EntityManager,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import { Cursor } from '../../common/dtos/common.dtos.js';

/** Every table has a uuid `id` and a `createdAt` (used by cursor pagination). */
export interface BaseEntity extends ObjectLiteral {
  id: string;
  createdAt: Date;
}

/** One page of a keyset-paginated list. */
export interface CursorPage<T> {
  data: T[];
  // Opaque; pass back as `cursor` for the next page. null on the last page.
  nextCursor: string | null;
}

export abstract class BaseRepository<T extends BaseEntity> {
  constructor(protected readonly repository: Repository<T>) {}

  // ---------- Create ----------

  /** Inserts one row and returns it with database defaults (id, timestamps). */
  create(data: DeepPartial<T>): Promise<T> {
    return this.repository.save(this.repository.create(data));
  }

  /** Inserts rows without reading them back (fastest; use for append-only data). */
  async insert(data: QueryDeepPartialEntity<T> | QueryDeepPartialEntity<T>[]): Promise<void> {
    await this.repository.insert(data);
  }

  /** INSERT ... ON CONFLICT (conflictPaths) DO UPDATE: atomic create-or-update. */
  async upsert(data: QueryDeepPartialEntity<T>, conflictPaths: (keyof T & string)[]): Promise<void> {
    await this.repository.upsert(data, { conflictPaths });
  }

  /** Persists changes to an entity loaded earlier. */
  save(entity: T): Promise<T> {
    return this.repository.save(entity);
  }

  // ---------- Read ----------

  /** Row by primary key, or null. */
  findById(id: string): Promise<T | null> {
    return this.repository.findOneBy({ id } as FindOptionsWhere<T>);
  }

  /** First row matching `where`, or null. `options` adds relations, order, select. */
  findOne(where: FindOptionsWhere<T>, options: Omit<FindOneOptions<T>, 'where'> = {}): Promise<T | null> {
    return this.repository.findOne({ ...options, where });
  }

  /** Rows matching `where`. `options` adds order, take (limit), select, relations. */
  findMany(where: FindOptionsWhere<T> | FindOptionsWhere<T>[], options: Omit<FindManyOptions<T>, 'where'> = {}): Promise<T[]> {
    return this.repository.find({ ...options, where });
  }

  /** Values of one column for the matching rows (SELECT column only). */
  async pluck<K extends keyof T & string>(
    column: K,
    where: FindOptionsWhere<T>,
    options: Omit<FindManyOptions<T>, 'where' | 'select'> = {},
  ): Promise<T[K][]> {
    const rows = await this.repository.find({ ...options, where, select: { [column]: true } as FindManyOptions<T>['select'] });
    return rows.map((row) => row[column]);
  }

  /** Whether any row matches (SELECT 1 ... LIMIT 1). */
  exists(where: FindOptionsWhere<T>): Promise<boolean> {
    return this.repository.exists({ where });
  }

  /** Number of matching rows. */
  count(where: FindOptionsWhere<T>): Promise<number> {
    return this.repository.countBy(where);
  }

  // ---------- Update / delete ----------

  /**
   * UPDATE ... WHERE `where`. Returns the number of rows changed. Put the
   * expected current state in `where` (e.g. { id, status: 'queued' }) to
   * make a state transition atomic: 0 means someone else changed it first.
   */
  async updateWhere(where: FindOptionsWhere<T>, data: QueryDeepPartialEntity<T>): Promise<number> {
    const result = await this.repository.update(where, data);
    return result.affected ?? 0;
  }

  /** UPDATE by primary key. Returns false if the row doesn't exist. */
  async updateById(id: string, data: QueryDeepPartialEntity<T>): Promise<boolean> {
    return (await this.updateWhere({ id } as FindOptionsWhere<T>, data)) > 0;
  }

  /** DELETE ... WHERE `where`. Returns the number of rows deleted. */
  async deleteWhere(where: FindOptionsWhere<T>): Promise<number> {
    const result = await this.repository.delete(where);
    return result.affected ?? 0;
  }

  // ---------- Pagination ----------

  /**
   * Keyset (cursor) pagination, newest first, on (created_at, id). Cost per
   * page stays constant however deep the client goes, and rows inserted
   * meanwhile don't shift pages. `qb` carries the filters; `alias` is its
   * main alias. Throws on a malformed cursor (callers validate first).
   */
  protected async paginateByCursor(
    qb: SelectQueryBuilder<T>,
    alias: string,
    limit: number,
    cursor?: string,
  ): Promise<CursorPage<T>> {
    qb.orderBy(`${alias}.created_at`, 'DESC').addOrderBy(`${alias}.id`, 'DESC').take(limit + 1);
    if (cursor) {
      const position = Cursor.decode(cursor);
      if (!position) throw new Error('Malformed cursor');
      qb.andWhere(
        new Brackets((w) =>
          w
            .where(`${alias}.created_at < :cursorCreatedAt`, { cursorCreatedAt: position.createdAt })
            .orWhere(`(${alias}.created_at = :cursorCreatedAt AND ${alias}.id < :cursorId)`, {
              cursorCreatedAt: position.createdAt,
              cursorId: position.id,
            }),
        ),
      );
    }
    // One extra row tells whether another page exists.
    const rows = await qb.getMany();
    const data = rows.slice(0, limit);
    const last = data.at(-1);
    return { data, nextCursor: rows.length > limit && last ? Cursor.encode(last.createdAt, last.id) : null };
  }

  /** Query builder on this table, for filters too dynamic for find options. */
  protected queryBuilder(alias: string): SelectQueryBuilder<T> {
    return this.repository.createQueryBuilder(alias);
  }

  // ---------- Raw SQL ----------

  /**
   * Runs parameterized SQL ($1, $2, ...) and always returns the rows. For
   * what TypeORM can't express (UPDATE ... RETURNING, FOR UPDATE SKIP
   * LOCKED). TypeORM's query() returns `[rows, count]` for UPDATE/DELETE
   * but `rows` for SELECT/INSERT; this normalises both.
   */
  protected async rawQuery<R>(sql: string, parameters: unknown[] = []): Promise<R[]> {
    const result: unknown = await this.repository.query(sql, parameters);
    const isUpdateResult = Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number';
    return (isUpdateResult ? result[0] : result) as R[];
  }

  // ---------- Transactions ----------

  /**
   * Runs `work` in one database transaction: all of it commits or none of
   * it does. Use `manager` (e.g. manager.getRepository(Entity)) for every
   * query inside, otherwise it runs outside the transaction.
   */
  transaction<R>(work: (manager: EntityManager) => Promise<R>): Promise<R> {
    return this.repository.manager.transaction(work);
  }
}
