const { Connection, PublicKey } = require('@solana/web3.js');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

async function main() {
  const [walletArg, ...signatures] = process.argv.slice(2);
  if (!walletArg || signatures.length === 0) {
    throw new Error('Usage: node scripts/audit-solana-transactions.js <wallet> <signature...>');
  }

  const wallet = new PublicKey(walletArg).toBase58();
  const connection = new Connection(RPC_URL, 'confirmed');
  const results = [];

  for (const signature of signatures) {
    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    if (!transaction) {
      results.push({ signature, found: false });
      continue;
    }

    const accountKeys = transaction.transaction.message
      .getAccountKeys({ accountKeysFromLookups: transaction.meta?.loadedAddresses })
      .keySegments()
      .flat()
      .map((key) => key.toBase58());
    const walletIndex = accountKeys.indexOf(wallet);
    const preLamports = walletIndex >= 0 ? transaction.meta.preBalances[walletIndex] : null;
    const postLamports = walletIndex >= 0 ? transaction.meta.postBalances[walletIndex] : null;

    results.push({
      signature,
      found: true,
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      confirmationError: transaction.meta.err,
      networkFeeLamports: transaction.meta.fee,
      walletIndex,
      walletPreLamports: preLamports,
      walletPostLamports: postLamports,
      walletDeltaLamports: preLamports === null ? null : postLamports - preLamports
    });
  }

  console.log(JSON.stringify({ wallet, rpc: RPC_URL, transactions: results }, null, 2));
}

main().catch((error) => {
  console.error(`[audit-solana-transactions] ${error.message}`);
  process.exitCode = 1;
});
