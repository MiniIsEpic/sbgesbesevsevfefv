// Offline checks: derivation against published test vectors, multi-account paths, encryption, formatting.
import assert from 'node:assert/strict';
process.env.MASTER_KEY ??= '11'.repeat(32);

const { deriveAddresses, deriveMany, isValidPhrase } = await import('../src/derive.js');
const { encryptSeed, decryptSeed, encryptAuto, decryptAuto, hashPin, verifyPin } = await import('../src/crypto.js');
const { fmtAmount, parseAmount } = await import('../src/format.js');
const { btcValidAddress } = await import('../src/chains/btc.js');
const { solValidAddress } = await import('../src/chains/sol.js');

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
assert.ok(isValidPhrase(phrase));
assert.ok(!isValidPhrase('abandon abandon abandon'));

// Account 0 — published BIP-44/SLIP-0010/BIP-84 vectors for this well-known mnemonic.
const a0 = deriveAddresses(phrase, 0);
assert.equal(a0.evm, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', 'EVM m/44/60/0/0/0');
assert.equal(a0.sol, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', 'SOL account 0');
assert.equal(a0.btc, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'BTC account 0');

// Account 1 — must be valid and differ from account 0 on every chain (this is MetaMask's "Account 2" etc).
const [b0, b1] = deriveMany(phrase, [0, 1]);
assert.deepEqual(b0, a0, 'deriveMany[0] matches deriveAddresses');
assert.match(b1.evm, /^0x[0-9a-fA-F]{40}$/);
assert.notEqual(b1.evm, a0.evm);
assert.notEqual(b1.sol, a0.sol);
assert.notEqual(b1.btc, a0.btc);
assert.ok(solValidAddress(b1.sol) && btcValidAddress(b1.btc));

const enc = encryptSeed(phrase, 'pin123456');
assert.equal(decryptSeed(enc, 'pin123456'), phrase);
assert.throws(() => decryptSeed(enc, 'wrongpin'));

const auto = encryptAuto(phrase);
assert.equal(decryptAuto(auto), phrase);
assert.throws(() => decryptSeed(auto, 'pin123456'), 'auto copy must not open with the PIN key');

const h = hashPin('pin123456');
assert.ok(verifyPin('pin123456', h.pinSalt, h.pinHash));
assert.ok(!verifyPin('pin12345', h.pinSalt, h.pinHash));

assert.equal(fmtAmount(1_500_000_000n, 9), '1.5');
assert.equal(fmtAmount(parseAmount('1234.000001', 9), 9), '1,234.000001');
assert.throws(() => parseAmount('-1', 9));
assert.ok(btcValidAddress(a0.btc) && !btcValidAddress('bc1qnope'));
assert.ok(solValidAddress(a0.sol) && !solValidAddress('notanaddress'));

console.log('All self-tests passed. Account 0:', a0, '\nAccount 1 EVM:', b1.evm);
