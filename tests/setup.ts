/**
 * Global test setup. CI (and fresh clones) have no `.env`, while several
 * suites exercise the DeepSeek client through injected fetch mocks — the
 * client still requires a non-empty key before it reaches the mock.
 * A default keeps unit tests hermetic; the real key is never used.
 */
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
