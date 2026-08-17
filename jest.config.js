/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      // One config governs test compilation, and keeps src/test-support in
      // scope (tsconfig.json excludes it so it stays out of dist/).
      tsconfig: 'tsconfig.test.json',
      diagnostics: {
        ignoreCodes: [151002],
      },
    }],
  },
};
