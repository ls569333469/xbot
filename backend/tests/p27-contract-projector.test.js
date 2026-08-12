const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  asset,
  closedPositionCsv,
  projectAttempt,
  projectPosition,
  projectSignal
} = require('../domains/trade/contract-projector');
const { assetSnapshot, authorizationSnapshot } = require('../domains/signal/contract-snapshot');
const { entityEnvelope } = require('../lib/entity-outbox');

const schemaDirectory = path.resolve(__dirname, '../contracts/p27');

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value;
}

function resolveSchemaReference(reference, sourceFile) {
  const [filePart, fragment = ''] = reference.split('#');
  const targetFile = filePart ? path.resolve(path.dirname(sourceFile), filePart) : sourceFile;
  let schema = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  if (fragment) {
    for (const segment of fragment.replace(/^\//, '').split('/')) {
      schema = schema[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
  }
  return { schema, sourceFile: targetFile };
}

function assertSchemaValue(schema, value, sourceFile, location = '$') {
  if (schema.$ref) {
    const resolved = resolveSchemaReference(schema.$ref, sourceFile);
    return assertSchemaValue(resolved.schema, value, resolved.sourceFile, location);
  }
  for (const member of schema.allOf || []) assertSchemaValue(member, value, sourceFile, location);
  if ('const' in schema) assert.deepEqual(value, schema.const, location);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location}: unexpected enum value ${value}`);
  if (schema.type) {
    const actual = valueType(value);
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const compatible = expected.includes(actual) || (actual === 'integer' && expected.includes('number'));
    assert.ok(compatible, `${location}: expected ${expected.join('|')}, received ${actual}`);
  }
  if (typeof value === 'string' && schema.minLength != null) {
    assert.ok(value.length >= schema.minLength, `${location}: shorter than minLength`);
  }
  if (typeof value === 'number' && schema.minimum != null) {
    assert.ok(value >= schema.minimum, `${location}: below minimum`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      assert.ok(Object.hasOwn(value, key), `${location}: missing required property ${key}`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) assertSchemaValue(childSchema, value[key], sourceFile, `${location}.${key}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => assertSchemaValue(schema.items, item, sourceFile, `${location}[${index}]`));
  }
}

function assertSchema(name, value) {
  const sourceFile = path.join(schemaDirectory, name);
  assertSchemaValue(JSON.parse(fs.readFileSync(sourceFile, 'utf8')), value, sourceFile);
}

test('P27 Signal projector keeps legacy fields and adds one canonical contract', () => {
  const snapshot = assetSnapshot({
    chain_id: 'robinhood', contract_address: '0x1234567890abcdef',
    symbol: 'CAT', project_name: 'Thinking Cat', project_handle: 'thinkingcatRH'
  });
  const row = {
    id: 21, whitelist_id: 4, strategy_type: 'follow_discovery',
    signal_type: 'follow_discovery', chain_id: 'robinhood',
    contract_address: '0x1234567890abcdef', asset_snapshot: snapshot,
    authorization_snapshot: authorizationSnapshot({
      execution_mode: 'live', follow_discovery_policy_id: 8,
      follow_discovery_policy_revision: 3, follow_discovery_context_hash: 'context'
    }, 'follow_discovery'),
    execution_mode: 'live', status: 'recorded', provider: '6551'
  };
  const dto = projectSignal(row, { status: 'auto_allowed', blockers: [] });
  assert.equal(dto.contract_version, 'p27.v1');
  assert.equal(dto.asset.display_label, 'CAT');
  assert.equal(dto.project.name, 'Thinking Cat');
  assert.equal(dto.live_authorization, 'auto_allowed');
  assert.equal(dto.authorization.execution_decision.status, 'not_attempted');
  assert.deepEqual(dto.execution.blockers, []);
  assert.deepEqual(dto.risk, { warnings: [], hard_failures: [] });
  assert.equal(dto.signal_type, 'follow_discovery');
});

test('risk observations never become execution blockers unless execution proves it', () => {
  const observed = projectSignal({
    id: 31, whitelist_id: 4, strategy_type: 'fixed_ca', signal_type: 'handle_match',
    chain_id: 'base', contract_address: '0x1234567890abcdef', status: 'recorded',
    risk_check: {
      passed: false,
      reasons: ['GMGN_SECURITY_RUG_RISK'],
      warnings: ['BUY_TAX_PRESENT']
    }
  });
  assert.deepEqual(observed.execution.blockers, []);
  assert.deepEqual(observed.risk.hard_failures, []);
  assert.deepEqual(observed.risk.warnings, ['BUY_TAX_PRESENT', 'GMGN_SECURITY_RUG_RISK']);

  const rejected = projectSignal({
    ...observed,
    status: 'rejected',
    reject_reason: 'GMGN_SECURITY_RUG_RISK',
    risk_check: { reasons: ['GMGN_SECURITY_RUG_RISK'], warnings: [] }
  });
  assert.deepEqual(rejected.execution.blockers, ['GMGN_SECURITY_RUG_RISK']);
  assert.deepEqual(rejected.risk.hard_failures, ['GMGN_SECURITY_RUG_RISK']);
});

test('asset fallback uses the shortened CA and never invents a token name', () => {
  assert.deepEqual(asset({ contract_address: '0x1234567890abcdef1234' }), {
    symbol: null,
    name: null,
    logo_url: null,
    display_label: '0x1234...1234',
    metadata_source: 'address_fallback'
  });
});

test('Position and Attempt infer only provable strategy attribution', () => {
  assert.equal(projectPosition({ id: 1, signal_id: null, whitelist_id: null,
    chain_id: 'base', contract_address: '0x1234567890abcdef', status: 'closed' }).strategy_type, 'unknown');
  assert.equal(projectAttempt({ id: 2, intent_id: 3, signal_id: null, position_id: null,
    chain: 'base', output_token: '0x1234567890abcdef', side: 'buy', status: 'rejected' }).strategy_type, 'unknown');
});

test('Closed Position CSV uses RFC 4180 escaping and neutralizes formulas', () => {
  const csv = closedPositionCsv([{
    id: 1, signal_id: 2, whitelist_id: 3, strategy_type: 'dynamic_policy',
    chain_id: 'base', contract_address: '0x1234567890abcdef',
    asset_snapshot: { symbol: '=IMPORTXML("x", "y")' },
    amount_in: '0.01', entry_price: '1', exit_price: '2', pnl: '1', pnl_pct: '100',
    status: 'closed', opened_at: '2026-08-12T00:00:00Z', closed_at: '2026-08-12T00:01:00Z'
  }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"'=IMPORTXML\(""x"", ""y""\)"/);
  assert.match(csv, /\r\n/);
});

test('entity outbox broadcasts a minimal stable envelope', () => {
  assert.deepEqual(entityEnvelope({
    id: 9, aggregate_type: 'signal', aggregate_id: '21',
    payload: { entity_type: 'signal', entity_id: '21', change_type: 'created' }
  }), {
    type: 'entity:changed', event_id: '9', contract_version: 'p27.events.v1',
    payload: { entity_type: 'signal', entity_id: '21', change_type: 'created' }
  });
});

test('P27 JSON schemas validate canonical projector fixtures', () => {
  const common = {
    id: 27,
    chain_id: 'robinhood',
    contract_address: '0x1234567890abcdef',
    strategy_type: 'follow_discovery',
    status: 'confirmed',
    asset_snapshot: assetSnapshot({
      chain_id: 'robinhood', contract_address: '0x1234567890abcdef',
      symbol: 'CAT', project_name: 'Thinking Cat'
    })
  };
  assertSchema('signal.schema.json', projectSignal({
    ...common,
    signal_type: 'follow_discovery',
    execution_mode: 'live',
    authorization_snapshot: authorizationSnapshot({
      execution_mode: 'live', follow_discovery_policy_id: 8
    }, 'follow_discovery')
  }, { status: 'auto_allowed', blockers: [] }));
  const position = projectPosition({
    ...common, signal_id: 27, whitelist_id: 4, execution_mode: 'live', closed_at: null
  });
  assertSchema('position.schema.json', position);
  assertSchema('closed-position.schema.json', { ...position, closed_at: '2026-08-12T12:00:00Z' });
  assertSchema('trade-attempt.schema.json', projectAttempt({
    ...common, id: 30, intent_id: 29, chain: 'robinhood', side: 'buy',
    output_token: common.contract_address, execution_mode: null
  }));
});
