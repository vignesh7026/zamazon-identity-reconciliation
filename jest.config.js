/** Jest config: run TS tests directly with ts-jest, single worker so the
 * SQLite test database doesn't see concurrent writes across test files. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  verbose: true,
};
