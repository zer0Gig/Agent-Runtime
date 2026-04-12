import { Wallet } from "ethers";
// Your Private Key goes here
const privateKey =
  "0x196209f48c7fe77b166762fb777ed6a35f65b7986029a0ee1ad52d10e7af8bc8";

const wallet = new Wallet(privateKey);
console.log("✅ PUBLIC KEY:");
console.log(wallet.signingKey.publicKey);
