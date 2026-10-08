interface Db {
    query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

declare const db: Db;
declare const prisma: { $queryRawUnsafe(sql: string): Promise<unknown[]> };
declare const knex: { raw(sql: string): Promise<unknown[]> };
declare const sequelize: { query(sql: string): Promise<unknown[]> };

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

export function findUserByPrisma(id: string) {
    return prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id = '${id}'`); // planted: sql-prisma-unsafe
}

export function findUserByKnex(id: string) {
    return knex.raw('SELECT * FROM users WHERE id = ' + id); // planted: sql-knex-raw
}

export function findUserBySequelize(id: string) {
    return sequelize.query(`DELETE FROM users WHERE id = ${id}`); // planted: sql-sequelize
}
