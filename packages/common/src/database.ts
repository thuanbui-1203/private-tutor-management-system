/**
 * The smallest database surface the plumbing needs, so @tms/common never imports a
 * service's generated Prisma client. A Prisma client and a Prisma interactive
 * transaction client both satisfy SqlExecutor; `prismaDatabase()` adapts one.
 * Placeholders are PostgreSQL style: $1, $2, ...
 */
export interface SqlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface Database {
  /** Runs a query outside any transaction (health checks). */
  executor: SqlExecutor;
  /** Runs `fn` in one transaction; commits when it resolves, rolls back when it throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Structural type of a Prisma client: just what `prismaDatabase` uses. */
export interface PrismaLike extends SqlExecutor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction<R>(fn: (tx: any) => Promise<R>, options?: { timeout?: number }): Promise<R>;
}

/** Adapts a service's PrismaClient to the Database interface. */
export function prismaDatabase(prisma: PrismaLike): Database {
  return {
    executor: prisma,
    transaction: (fn) => prisma.$transaction((tx: SqlExecutor) => fn(tx), { timeout: 15_000 }),
  };
}
