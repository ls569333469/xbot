# Test isolation

`npm test` runs only pure unit tests and must not write the configured production database.

Database integration tests use the `.integration.js` suffix and are excluded from the default command. Run them only against a dedicated database whose name contains `test`:

```powershell
$env:XBOT_TEST_DB_NAME='xbot_test'
npm run test:integration
```

也可以显式传入测试库名，避免依赖当前终端环境变量：

```powershell
npm run test:integration -- xbot_integration_test
```

The runner and every integration test file independently refuse to start when `XBOT_TEST_DB_NAME` is missing, does not contain `test`, or resolves to the production database.

Use the guarded database manager when an empty database is needed. It accepts only names containing `test` and refuses the configured production database:

```powershell
npm run test:db:manage -- recreate xbot_p14_migration_test
npm run test:db:manage -- drop xbot_p14_migration_test
```

P12-P14 Migrations 013-016 must also be rehearsed against a separate, empty test database:

```powershell
$env:XBOT_TEST_DB_NAME='xbot_p12_migration_test'
npm run test:migration:p12
```

The rehearsal refuses non-test and non-empty databases. It creates a pre-P12 historical trade graph, applies Migrations 013-016, and verifies that legacy Orders, Receipts, Positions/Lots, Strategies, budgets, Ledger, and Outbox rows remain unchanged while Intent links, Robinhood chain constraints, relation events, Watch Outbox, P14 evidence context, and limited acceptance scopes are added.

P16 Migration 017 has a separate historical-data rehearsal. It verifies legacy exit-strategy equivalence, Tweet evidence migration, project account preservation, zero remote Watch writes, and monotonic research actor evidence:

```powershell
$env:XBOT_TEST_DB_NAME='xbot_p16_migration_test'
npm run test:migration:p16
```
