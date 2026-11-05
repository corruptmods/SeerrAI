// Must stay import-free: entity decorators read this while the datasource is
// evaluated.
export const isPgsql = process.env.DB_TYPE === 'postgres';
