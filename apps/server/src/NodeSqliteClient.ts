import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const make = (options: { filename: string }) =>
  Effect.gen(function* () {
    const compiler = Statement.makeCompilerSqlite(undefined);

    const makeConnection = Effect.gen(function* () {
      const db = new DatabaseSync(options.filename);
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));

      const run = (sql: string, params: ReadonlyArray<unknown> = []) =>
        Effect.try({
          try: () => {
            const stmt = db.prepare(sql);
            return ((stmt.all as (...args: unknown[]) => unknown[])(...params)) ?? [];
          },
          catch: (cause) => new SqlError({ cause, message: "Failed to execute statement" }),
        });

      const runValues = (sql: string, params: ReadonlyArray<unknown> = []) =>
        Effect.try({
          try: () => {
            const stmt = db.prepare(sql);
            const rows =
              ((stmt.all as (...args: unknown[]) => Record<string, unknown>[])(...params)) ?? [];
            return rows.map(Object.values);
          },
          catch: (cause) => new SqlError({ cause, message: "Failed to execute statement" }),
        });

      return identity<Connection>({
        execute(sql, params, transformRows) {
          return transformRows
            ? Effect.map(run(sql, params), transformRows as unknown as (rows: unknown[]) => unknown[])
            : run(sql, params);
        },
        executeRaw(sql, params) {
          return run(sql, params);
        },
        executeValues(sql, params) {
          return runValues(sql, params);
        },
        executeUnprepared(sql, params, transformRows) {
          return this.execute(sql, params, transformRows);
        },
        executeStream(_sql, _params, _transformRows) {
          return Stream.die("executeStream not implemented");
        },
      });
    });

    const semaphore = yield* Semaphore.make(1);
    const connection = yield* makeConnection;

    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!;
      const scope = ServiceMap.getUnsafe(fiber.services, Scope.Scope);
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () =>
          Scope.addFinalizer(scope, semaphore.release(1)),
        ),
        connection,
      );
    });

    return yield* Client.make({
      acquirer,
      compiler,
      transactionAcquirer,
      spanAttributes: [["db.system.name", "sqlite"]],
    });
  });

export const layer = (config: {
  filename: string;
}): Layer.Layer<Client.SqlClient> =>
  Layer.effectServices(
    Effect.map(make(config), (client) => ServiceMap.make(Client.SqlClient, client)),
  ).pipe(Layer.provide(Reactivity.layer));
