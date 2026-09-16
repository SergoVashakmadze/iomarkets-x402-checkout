// Generate the receipt-signing keypair. Put the private key in .env; publish the public key.
import { generateKeypair } from "../src/receipt.js";
const { privateKey, publicKey } = generateKeypair();
console.log(`RECEIPT_PRIVATE_KEY=${privateKey}`);
console.log(`RECEIPT_PUBLIC_KEY=${publicKey}`);
