// The dedicated core build resolves canonical SQL files with its text loader.
declare module '*.sql' {
  const sql: string;
  export default sql;
}
