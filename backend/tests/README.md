# Test isolation

`npm test` runs only pure unit tests and must not write the configured production database.

Database integration tests use the `.integration.js` suffix and are excluded from the default command. Run them only against a dedicated database whose name contains `test`:

```powershell
$env:XBOT_TEST_DB_NAME='xbot_test'
npm run test:integration
```

The runner and every integration test file independently refuse to start when `XBOT_TEST_DB_NAME` is missing, does not contain `test`, or resolves to the production database.
