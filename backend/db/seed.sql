-- seed.sql - 仅用于空配置库的执行基础设施默认值
-- 执行方式: psql -U pm_user -d xbot -f seed.sql

INSERT INTO config (key, value_json) VALUES

('chain_configs', '{
  "sol": {
    "retryEnabled": false,
    "maxRetries": 2,
    "retryWindowMs": 8000,
    "failureEvidenceWindowMs": 30000,
    "feeEscalationEnabled": false,
    "maxRetryFeeNative": 0,
    "exitGasReserve": 0
  },
  "bsc": {
    "retryEnabled": false,
    "maxRetries": 2,
    "retryWindowMs": 10000,
    "failureEvidenceWindowMs": 30000,
    "feeEscalationEnabled": false,
    "maxRetryFeeNative": 0,
    "exitGasReserve": 0
  },
  "base": {
    "retryEnabled": false,
    "maxRetries": 2,
    "retryWindowMs": 12000,
    "failureEvidenceWindowMs": 30000,
    "feeEscalationEnabled": false,
    "maxRetryFeeNative": 0,
    "exitGasReserve": 0
  },
  "eth": {
    "retryEnabled": false,
    "maxRetries": 2,
    "retryWindowMs": 30000,
    "failureEvidenceWindowMs": 30000,
    "feeEscalationEnabled": false,
    "maxRetryFeeNative": 0,
    "exitGasReserve": 0
  },
  "robinhood": {
    "retryEnabled": false,
    "maxRetries": 0,
    "retryWindowMs": 30000,
    "failureEvidenceWindowMs": 30000,
    "feeEscalationEnabled": false,
    "maxRetryFeeNative": 0,
    "exitGasReserve": 0
  }
}'),

('risk_config', '{
  "consecutive_failure_lock": 3
}')

ON CONFLICT (key) DO NOTHING;
