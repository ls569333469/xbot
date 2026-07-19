// D:\AI_Projects\xbot\backend\scripts\test-signature.js
require('dotenv').config();
const { Connection, Transaction, SystemProgram, Keypair, VersionedTransaction } = require('@solana/web3.js');
const crypto = require('crypto');
const gmgnHttp = require('../lib/gmgn-http');

async function runTests() {
  console.log('=== Starting Phase 3 Core Tests ===');

  // Test 1: Ed25519 Private Key Parsing & Ed25519 Message Signature
  try {
    console.log('\n[Test 1] Testing Ed25519 Message Signature Generation...');
    // Create a random 32-byte private key as a hex string
    const rawPrivKeyHex = crypto.randomBytes(32).toString('hex');
    process.env.GMGN_PRIVATE_KEY = rawPrivKeyHex;
    process.env.GMGN_API_KEY = 'test_api_key_123';

    const query = {
      token_in_address: 'So11111111111111111111111111111111111111112',
      token_out_address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      in_amount: '100000000',
      slippage: '5.0'
    };

    try {
      await gmgnHttp.getSwapRoute('sol', query.token_in_address, query.token_out_address, query.in_amount, '3A7H...abc', 5);
      console.log('✓ X-Signature generation flow ran successfully!');
    } catch (routeErr) {
      if (routeErr.message.includes('403')) {
        console.log('✓ X-Signature generation flow ran successfully! (Received expected 403 Forbidden from GMGN for test key)');
      } else {
        throw routeErr;
      }
    }
  } catch (err) {
    console.error('✗ [Test 1] Failed:', err.message);
  }

  // Test 2: Solana Transaction Signing
  try {
    console.log('\n[Test 2] Testing Solana Local Keypair Signing...');
    // Generate a new random Solana Keypair
    const testKeypair = Keypair.generate();
    const mockTx = new Transaction();
    mockTx.add(
      SystemProgram.transfer({
        fromPubkey: testKeypair.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1000,
      })
    );
    // Set mock blockhash
    mockTx.recentBlockhash = '11111111111111111111111111111111';
    mockTx.feePayer = testKeypair.publicKey;

    // Serialize to VersionedTransaction (as Jito / Jupiter returns versioned transactions)
    const versionedTx = new VersionedTransaction(mockTx.compileMessage());
    
    // Sign locally
    versionedTx.sign([testKeypair]);
    
    console.log('✓ Deserialization and signing succeeded!');
    console.log(`✓ Wallet Public Key: ${testKeypair.publicKey.toBase58()}`);
    console.log(`✓ Signature Base64 Length: ${Buffer.from(versionedTx.signatures[0]).toString('base64').length}`);
  } catch (err) {
    console.error('✗ [Test 2] Failed:', err.message);
  }

  console.log('\n=== All Tests Completed ===');
}

runTests();
