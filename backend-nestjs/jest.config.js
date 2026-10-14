/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  // Unitarias (*.spec.ts) y de integración HTTP (*.e2e-spec.ts); `npm test` ejecuta todo.
  testRegex: 'test/.*\\.(spec|e2e-spec)\\.ts$',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts', '!src/**/dto/**'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};
