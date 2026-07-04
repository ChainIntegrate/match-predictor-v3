#!/bin/bash
set -e
TOKEN_CID="bafybeibzxliriake5p22zpmkpwisrdn6kdpe6iwh2tk42sb5mynahpyk3i"
BANNER_CID="bafybeidnhowpyw6ir3bohonjnqepthmrypuniu4ld5movtyo3rzatfpdsa"
GATEWAY="https://peach-familiar-wombat-848.mypinata.cloud/ipfs"

curl -sL "$GATEWAY/$TOKEN_CID" -o /tmp/token-image.png
curl -sL "$GATEWAY/$BANNER_CID" -o /tmp/banner-image.png

echo "--- dimensioni ---"
file /tmp/token-image.png
file /tmp/banner-image.png

echo "--- hash keccak256 ---"
node -e "
const { ethers } = require('ethers');
const fs = require('fs');
console.log('TOKEN_HASH=' + ethers.keccak256(fs.readFileSync('/tmp/token-image.png')));
console.log('BANNER_HASH=' + ethers.keccak256(fs.readFileSync('/tmp/banner-image.png')));
"
