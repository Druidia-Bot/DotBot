declare module "better-sqlite3" {
  interface Statement {
    all(...params: any[]): any[];
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  }
  interface Transaction<F extends (...args: any[]) => any> {
    (...args: Parameters<F>): ReturnType<F>;
  }
  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    close(): void;
    transaction<F extends (...args: any[]) => any>(fn: F): Transaction<F>;
  }
  interface DatabaseConstructor {
    new (filename: string, options?: { readonly?: boolean }): Database;
  }
  const Database: DatabaseConstructor;
  export default Database;
}
