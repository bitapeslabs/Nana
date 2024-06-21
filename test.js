const { runestone } = require("@runeapes/apeutils");
const { Rune } = require("@ordjs/runestone");
const { getCommitment } = require("./src/lib/runeutils");
const { Script } = require("@cmdcode/tapscript");
const fs = require("fs");
const path = require("path");

const testEdictRune = JSON.parse(
  fs.readFileSync(path.join(__dirname, "./dumps/testEdictRune.json"), "utf8")
);

const batchDecode = async () => {
  let decodedScripts = testEdictRune.vin[0].txinwitness.map((item) => {
    try {
      let script = Script.decode(item);
      return script;
    } catch (e) {
      console.log(e);
      return false;
    }
  });

  console.log(decodedScripts);
};
//let commitment = getCommitment("RUNEAPESSHARES").toString("hex");
//console.log(getCommitment("RUNEAPESSHARES").toString("hex"));

//console.log(decoded);
batchDecode();
//let rune = Rune.fromString("ANEWRUNE");
/*
console.log(
  runestone.decipher(
    "02000000000101a2bcf8516f0d06f25a41dd5d3a32ae8aff6737a8c8e465a392610dc3125bb2590000000000fdffffff030000000000000000176a5d14020304de8a85e1ebd881c41c038006000a01080422020000000000001600143536bb237388b0366f74811671e11de5731135bcd250000000000000160014cea13cfd48e2fe823c0fcd06e2000bf6840b28a60340c4cb7c3240ebf90626cade3796bed0ef58ed44c2d0732a82ca78ea583c183b9a05931cde868677d48c23f40f754427dcfa03a3c2d5e64e501a19d1106ca80cc62e2054ce8c25aa339a03e91abe09c1155d3980b824d033b1014da252001a1631a0fcac0063085e4521bcc606881c6821c1c598ec0ffb550be1d255430784cc159eb95bb8fe9a346ac4170b46251929337e00000000"
  )
);
*/
