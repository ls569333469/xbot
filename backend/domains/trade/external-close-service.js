const repository = require('./trade-repository');
const closeService = require('./close-service');
const { reconciler } = require('./reconciliation-service');
const { requireChain } = require('./chain-adapters');

const ACTIVE_STRATEGY_STATUSES = new Set(['pending', 'running', 'partially_filled']);
const UNSAFE_STRATEGY_STATUSES = new Set(['cancelling', 'unknown']);

function externalCloseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positionStrategyRow(position, state) {
  const firstLot = position.lots?.[0] || {};
  return {
    ...state.group,
    chain_id: position.chain_id,
    contract_address: position.contract_address,
    signal_id: position.signal_id,
    whitelist_id: position.whitelist_id,
    trace_id: position.signal_trace_id,
    wallet_address: state.group.wallet_address || firstLot.wallet_address,
    token_decimals: firstLot.token_decimals
  };
}

class ExternalCloseService {
  constructor(options = {}) {
    this.repository = options.repository || repository;
    this.closeService = options.closeService || closeService;
    this.reconciler = options.reconciler || reconciler;
    this.chainResolver = options.chainResolver || requireChain;
  }

  async sync(positionId, operatorId = 'admin') {
    const position = await this.repository.getPositionForClose(positionId);
    if (!position) throw externalCloseError('POSITION_NOT_FOUND', 'Position not found');
    if (position.execution_mode !== 'live') {
      throw externalCloseError('POSITION_NOT_CLOSABLE', 'Wallet synchronization is only available for live positions');
    }

    const lots = Array.isArray(position.lots) ? position.lots : [];
    if (lots.length === 0) {
      throw externalCloseError('POSITION_LOT_MISSING', 'Position has no verified lot');
    }
    const walletAddress = String(lots[0].wallet_address || '');
    const tokenDecimals = Number(lots[0].token_decimals);
    if (!walletAddress || !lots.every((lot) => String(lot.wallet_address) === walletAddress)) {
      throw externalCloseError('POSITION_LOT_WALLET_MISMATCH', 'Position lots disagree on managed wallet');
    }
    if (!Number.isInteger(tokenDecimals)
        || !lots.every((lot) => Number(lot.token_decimals) === tokenDecimals)) {
      throw externalCloseError('POSITION_LOT_DECIMALS_MISMATCH', 'Position lots disagree on token decimals');
    }

    let strategyStates = [];
    const result = await this.reconciler.reconcilePositionBalance(
      { id: position.id },
      {
        operatorId,
        holdExternalVerification: true,
        resolveActiveStrategies: async () => {
          strategyStates = await this.closeService.loadStrategyState(position);
          const triggered = strategyStates.find((item) => item.status === 'triggered');
          if (triggered) {
            const strategyResult = await this.reconciler.reconcileStrategy(
              positionStrategyRow(position, triggered),
              { prefetched: true, strategy: triggered.normalized }
            );
            return {
              handled: true,
              result: {
                status: 'protection_close_detected',
                strategyGroupId: strategyResult.strategyGroupId,
                orderId: strategyResult.orderId || null
              }
            };
          }
          const unsafe = strategyStates.find((item) => UNSAFE_STRATEGY_STATUSES.has(item.status));
          if (unsafe) {
            throw externalCloseError(
              'STRATEGY_STATE_UNSAFE',
              `Strategy ${unsafe.group.provider_order_id || unsafe.group.id} is ${unsafe.status}`
            );
          }
          return { handled: false };
        }
      }
    );

    if (result.status !== 'chain_verifying') return result;

    const cancellable = strategyStates.filter((item) => ACTIVE_STRATEGY_STATUSES.has(item.status));
    if (cancellable.length > 0) {
      if (!result.attemptId) {
        throw externalCloseError(
          'EXTERNAL_CLOSE_ATTEMPT_MISSING',
          'External sell evidence did not produce an auditable trade attempt'
        );
      }
      try {
        await this.closeService.cancelStrategies({
          position,
          chain: this.chainResolver(position.chain_id),
          wallet: { address: walletAddress },
          cancellableStrategies: cancellable
        }, {
          attemptId: result.attemptId,
          deadlineAt: Date.now() + 60_000
        });
      } catch (error) {
        await this.repository.markPositionBalanceMismatch(position.id, {
          reason: 'EXTERNAL_CLOSE_STRATEGY_CANCEL_UNCERTAIN',
          attempt_id: result.attemptId,
          error_code: error.code || 'STRATEGY_CANCEL_UNCERTAIN'
        });
        throw error;
      }
    }

    if (result.verificationHeld) {
      const released = await this.repository.releaseExternalCloseVerification(result.orderId);
      if (!released) {
        throw externalCloseError(
          'EXTERNAL_CLOSE_VERIFICATION_RELEASE_FAILED',
          'External close verification hold could not be released'
        );
      }
    }

    return {
      ...result,
      strategyAction: cancellable.length > 0 ? 'cancelled' : 'none',
      cancelledStrategyCount: cancellable.length
    };
  }
}

const externalCloseService = new ExternalCloseService();

module.exports = {
  ACTIVE_STRATEGY_STATUSES,
  ExternalCloseService,
  UNSAFE_STRATEGY_STATUSES,
  externalCloseService,
  positionStrategyRow
};
