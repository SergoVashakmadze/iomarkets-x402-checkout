// Generate a fresh Algorand account (for PAY_TO, the refund wallet, or a test agent).
// Prints the mnemonic ONCE. Store it in a password manager, never in git.
import algosdk from "algosdk";
const label = process.argv[2] ?? "wallet";
const a = algosdk.generateAccount();
console.log(`${label} address:  ${a.addr.toString()}`);
console.log(`${label} mnemonic: ${algosdk.secretKeyToMnemonic(a.sk)}`);
