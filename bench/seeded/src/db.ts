interface Db {
    query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

declare const db: Db;

export function findUser(id: string) {
    return db.query(`SELECT * FROM users WHERE id = '${id}'`); // planted: sql-template
}

export function findUserByQuery(name: string) {
    const sql = `SELECT * FROM users WHERE name = '${name}'`;
    return db.query(sql); // planted: sql-via-variable
}

export function findUserSafely(id: string) {
    return db.query('SELECT * FROM users WHERE id = $1', [id]); // decoy: sql-parameterized
}
