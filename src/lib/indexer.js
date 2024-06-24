require("dotenv").config({ path: "../../.env" });

//Test libs
const fs = require("fs");
const path = require("path");
const { createRpcClient } = require("./rpcapi");
// ======

const { fromBigInt, toBigInt } = require("./tools");

const { Op } = require("sequelize");

const {
  isMintOpen,
  getReservedName,
  updateUnallocated,
  minimumLengthAtHeight,
  checkCommitment,
} = require("./runeutils");

const { SpacedRune, Rune: OrdRune } = require("@ordjs/runestone");

const { databaseConnection } = require("../database/createConnection");

//Conversions

const getAccount = async (address, db) => {
  //New runes minted from coinbase, or UTXO is not known
  /*

        The indexer starts keeping track of Utxos at RUNE GENESIS block 840,000. Any utxo before this in the explorer will be seen as genesis for inputs.

        GENESIS UTXOS BY DEFINITION CANNOT HAVE RUNES AND ARE NOT NEEDED FOR INDEXING.

        Any edicts with Genesis as an input should be ignored.
    */
  if (address === "GENESIS") {
    return { id: -1 };
  }

  const { Account } = db;

  let account = await Account.findOne({ where: { address: address } });

  if (account) {
    return account;
  }

  account = await Account.create({
    address: address,
    utxo_list: "[]",
  });

  return account;
};

const createTransaction = async (Transaction, Account, db) => {
  /*

    Rune Balances:
    {
        rune_id,
        amount
    }
    */

  const { Transactions } = db;

  const { runestone, hash, block, hex, vout, txIndex } = Transaction;

  let transaction = await Transactions.findOne({
    where: { hash: Transaction.hash },
  });

  if (transaction) {
    return transaction;
  }

  let NewTransactionData = {
    block_id: block,
    tx_index: txIndex,
    address_id: Account.id,
    value_sats:
      //Get all vout values and convert them to a big integer string
      vout
        .map((vout) => toBigInt(vout.value.toString(), 8))

        //Add big ints of all items to get sum
        .reduce((a, b) => BigInt(a) + BigInt(b), BigInt(0))

        //Convert back to string
        .toString(),
    hex,
    runestone: JSON.stringify(runestone),
    hash: hash,
  };

  transaction = await Transactions.create(NewTransactionData);

  return transaction;
};

const getUnallocatedRunesFromUtxos = (InputUtxos) => {
  /*
        Important: Rune Balances from this function are returned in big ints in the following format
        {
            [rune_protocol_id]: BigInt(amount)
        }

        rune_protocol_id => is the rune_id used by the Runes Protocol and is recognized, 
        different from rune_id which is used by the DB for indexing.
    */

  return (
    InputUtxos

      //Get allocated runes and store them in an array
      .reduce((acc, utxo) => {
        let RuneBalances = JSON.parse(utxo.rune_balances);

        //Sum up all Rune balances for each input UTXO
        RuneBalances.forEach((rune) => {
          acc[rune.rune_protocol_id] =
            (acc[rune.rune_protocol_id] ?? BigInt("0")) + BigInt(rune.amount);
        });

        return acc;
      }, {})
  );
};

const createNewUtxoBodies = async (vout, Transaction, db) => {
  const { Account } = db;

  const recipientAddresses = vout
    .map((utxo) => utxo.scriptPubKey.address)
    //remove the OP_RETURN
    .filter((address) => address);

  //Get all recipient addresses already in db and create a hash map
  const ignoreCreate = (
    await Account.findAll({
      where: { address: { [Op.in]: recipientAddresses } },
    })
  ).reduce((Acc, account) => ({ ...Acc, [account.address]: account }), {});

  //If an address is not in db, we should get it
  const toCreate = recipientAddresses.filter(
    (address) => !ignoreCreate[address]
  );

  //Create promises creating the new accounts
  const accountCreationPromises = toCreate.map((address) =>
    getAccount(address, db)
  );

  //Resolve promises and create a hash map of the new accounts
  const newAccounts = (await Promise.all(accountCreationPromises)).reduce(
    (Acc, account) => ({ ...Acc, [account.address]: account }),
    {}
  );

  //Finally concatenate the two account lists into voutAccounts for linkage to UTXOs
  const voutAccounts = { ...ignoreCreate, ...newAccounts };

  return vout.map((utxo, index) => {
    const voutAddress = utxo.scriptPubKey.address;

    return {
      /*
        SEE: https://docs.ordinals.com/runes.html#Burning
        "Runes may be burned by transferring them to an OP_RETURN output with an edict or pointer."

        This means that an OP_RETURN vout must be saved for processing edicts and unallocated runes,
        however mustnt be saved as a UTXO in the database as they are burnt.

        Therefore, we mark a utxo as an OP_RETURN by giving it an account id of 0
      */
      account: voutAddress ? voutAccounts[voutAddress].id : 0,
      transaction_id: Transaction.id,
      value_sats: toBigInt(utxo.value.toString(), 8),
      hash: Transaction.hash,
      vout_index: index,
      block: Transaction.block_id,
      rune_balances: {},
      block_spent: null,
    };
  });
};

const processEdicts = async (
  UnallocatedRunes,
  pendingUtxos,
  Transaction,
  db
) => {
  const { block, txIndex, runestone } = Transaction;
  const { Rune } = db;

  const { edicts } = runestone;

  if (runestone.cenotaph) {
    //Transaction is a cenotaph, input runes are burnt.
    //https://docs.ordinals.com/runes/specification.html#Transferring
    return {};
  }

  const transactionRuneId = `${block}:${txIndex}`;

  //Cache all runes that are currently in DB in a hashmap, if a rune doesnt exist edict will be ignored
  let existingRunes = await Rune.findAll({
    where: {
      rune_protocol_id: {
        [Op.in]: Object.keys(edicts.map((edict) => edict.id)),
      },
    },
  }).reduce((acc, rune) => ({ ...acc, [rune.rune_protocol_id]: rune }), {});

  //Replace all references of 0:0 with the actual rune id which we have stored on db (Transferring#5)
  edicts = edicts.map(
    (edict) => (edict.id = edict.id === "0:0" ? transactionRuneId : edict.id)
  );

  let allocate = (utxo, amount) => {
    //Allocate a rune to a utxo

    UnallocatedRunes[edict.id] =
      (UnallocatedRunes[edict.id] ?? BigInt(0)) - BigInt(amount);

    utxo.rune_balances[edict.id] =
      (utxo.rune_balances[edict.id] ?? BigInt(0)) + BigInt(amount);
  };

  //References are kept because filter does not clone the array
  let nonOpReturnOutputs = pendingUtxos.filter((utxo) => utxo.account !== 0);

  for (let edict in edicts) {
    //A runestone may contain any number of edicts, which are processed in sequence.

    if (!existingRunes[edict.id]) {
      //If the rune does not exist, the edict is ignored
      continue;
    }

    if (!UnallocatedRunes[edict.id]) {
      //If the rune is not in the unallocated runes, it is ignored
      continue;
    }

    if (edict.output === pendingUtxos.length) {
      //If an edict attempts to allocate more runes than in UnallocatedRunes while recursively allocating to all non-OP_RETURN outputs, the amount is replaced with Unallocated runes
      //This means that they are split evenly, so behavior is the same as edict.amount === 0
      if (
        edict.amount === 0 ||
        BigInt(edict.amount) * BigInt(edict.output) >
          BigInt(UnallocatedRunes[edict.id])
      ) {
        /*
            An edict with amount zero and output equal to the number of transaction outputs divides all unallocated units of rune id between each non OP_RETURN output.
        */

        const amountOutputs = BigInt(nonOpReturnOutputs.length);
        //By default all txs have exactly one OP_RETURN, because they are needed for runestones. More than 1 OP_RETURN is considered non-standard and ignored by btc nodes.

        const amount = BigInt(UnallocatedRunes[edict.id]) / amountOutputs;
        const remainder = BigInt(UnallocatedRunes[edict.id]) % amountOutputs;

        nonOpReturnOutputs.forEach((utxo, index) =>
          allocate(utxo, amount + (index < remainder ? BigInt(1) : BigInt(0)))
        );

        if (remainder !== BigInt(0)) {
          //If the number of unallocated runes is not divisible by the number of non-OP_RETURN outputs, 1 additional rune is assigned to the first R non-OP_RETURN outputs

          nonOpReturnOutputs
            //Get the first R outputs
            .slice(0, remainder)
            //Allocate 1 rune to each
            .forEach((utxo) => allocate(utxo, BigInt(1)));
        }
      }
      //If an edict would allocate more runes than are currently unallocated, the amount is reduced to the number of currently unallocated runes. In other words, the edict allocates all remaining unallocated units of rune id.

      nonOpReturnOutputs.forEach((utxo) =>
        allocate(utxo, BigInt(edict.amount))
      );
      continue;
    }
  }
};

const processMint = async (UnallocatedRunes, Transaction, db) => {
  const { block, txIndex, runestone } = Transaction;
  const mint = runestone?.mint;

  const { Rune } = db;

  if (!mint) {
    return UnallocatedRunes;
  }
  //We use the same  process used to calculate the Rune Id in the etch function if "0:0" is referred to
  const runeToMint = await Rune.findOne({
    where: {
      rune_protocol_id: mint === "0:0" ? `${block}:${txIndex}` : mint,
    },
  });

  if (!runeToMint) {
    //The rune requested to be minted does not exist.
    return UnallocatedRunes;
  }

  if (isMintOpen(block, runeToMint, true)) {
    //Update new mints to count towards cap
    runeToMint.mints = BigInt(runeToMint.mints) + BigInt(1);
    await runeToMint.save();

    if (runestone.cenotaph) {
      //If the mint is a cenotaph, the minted amount is burnt
      return UnallocatedRunes;
    }

    return updateUnallocated(UnallocatedRunes, {
      rune_id: runeToMint.rune_protocol_id,
      amount: BigInt(runeToMint.mint_amount),
    });
  } else {
    //Minting is closed
    return UnallocatedRunes;
  }
};

const processEtching = async (UnallocatedRunes, Transaction, rpc, db) => {
  const { block, txIndex, runestone } = Transaction;

  const etching = runestone?.etching;

  const { Rune } = db;

  //If no etching, return the input allocations
  if (!runestone.etching) {
    return UnallocatedRunes;
  }

  //If rune name already taken, it is non standard, return the input allocations

  //Cenotaphs dont have any other etching properties other than their name
  //If not a cenotaph, check if a rune name was provided, and if not, generate one

  let runeName = runestone.cenotaph
    ? etching
    : etching.rune ?? getReservedName(block, txIndex);

  //Check for valid commitment before doing anything (incase non reserved name)

  if (minimumLengthAtHeight(block) > runeName.length) {
    return UnallocatedRunes;
  }

  let spacedRune;

  if (etching.spacers && !runestone.cenotaph) {
    spacedRune = new SpacedRune(OrdRune.fromString(runeName), etching.spacers);
  }

  const isRuneNameTaken = !!(await Rune.findOne({
    where: { raw_name: runeName },
  }));

  if (isRuneNameTaken) {
    return UnallocatedRunes;
  }

  //This is processed last since it is the most computationally expensive call (we have to call RPC twice)
  const isReserved = !etching.rune;

  if (!isReserved) {
    const hasValidCommitment = await checkCommitment(
      runeName,
      Transaction,
      block,
      rpc
    );

    if (!hasValidCommitment) {
      return UnallocatedRunes;
    }
  }

  /*
    Runespec: Runes etched in a transaction with a cenotaph are set as unmintable.

    If the runestone decoded has the cenotaph flag set to true, the rune should be created with no allocationg created

    see unminable flag in rune model
  */

  const EtchedRune = await Rune.create({
    rune_protocol_id: `${block}:${txIndex}`,
    name: spacedRune ? spacedRune.name : runeName,
    raw_name: runeName,
    symbol: etching.symbol ?? "¤",
    spacers: etching.spacers ?? 0,

    //ORD describes no decimals being set as default 0
    decimals: etching.divisibility ?? 0,

    total_supply: etching.premine ?? "0",
    total_holders: 0, //This is updated on transfer edict
    mints: "0",
    premine: etching.premine ?? "0",

    /*

            ORD chooses the greater of the two values for mint start (height, offset)
            and the lesser of two values for mint_end (height, offset)

            See: https://github.com/ordinals/ord/blob/master/src/index/entry.rs LINE 112-146

            This is implemented in isMintOpen function
        */

    mint_cap: etching.terms?.cap ?? null, // null for no cap, otherwise the cap
    mint_amount: etching.terms?.amount ?? null,
    mint_start: etching.terms?.height?.[0] ?? null,
    mint_end: etching.terms?.height?.[1] ?? null,
    mint_offset_start: etching.terms?.offset?.[0] ?? null,
    mint_offset_end: etching.terms?.offset?.[1] ?? null,
    turbo: etching.turbo,

    //Unmintable is a flag internal to this indexer, and is set specifically for cenotaphs as per the rune spec (see above)
    unmintable: runestone.cenotaph ? 1 : 0,
  });

  //Add premine runes to input allocations

  if (runestone.cenotaph) {
    //No runes are premined if the tx is a cenotaph.
    return UnallocatedRunes;
  }

  return updateUnallocated(UnallocatedRunes, {
    rune_id: EtchedRune.rune_protocol_id,
    amount: BigInt(etching.premine),
  });
};

const processRunestone = async (Transaction, rpc, db) => {
  const { runestone, hash, vout, vin } = Transaction;

  const {
    Account,
    Balance,
    Rune,
    Runestone: RunestoneModel,
    Transactions,
    Utxo,
  } = db;

  // const SpenderAccount = await _getAccount(Transaction, db)

  let UtxoFilter = vin.map((vin) => vin.txid);

  //Setup Transaction for processing

  //If the utxo is not in db it was made before GENESIS (840,000) anmd therefore does not contain runes
  let InputUtxos = await Utxo.findAll({
    where: { hash: { [Op.in]: UtxoFilter } },
  });

  let SpenderAccount = await getAccount(
    InputUtxos[0]?.address ?? "GENESIS",
    db
  );
  let UnallocatedRunes = getUnallocatedRunesFromUtxos(InputUtxos);
  //let MappedTransactions = await getParentTransactionsMapFromUtxos(UtxoFilter, db)

  //Create A New Transaction to store UTXOs
  let NewTransaction = await createTransaction(Transaction, SpenderAccount, db);

  let pendingUtxos = await createNewUtxoBodies(vout, NewTransaction, db);

  //Delete UTXOs as they are being spent
  // => This should be processed at the end of the block, with filters concatenated.. await Utxo.deleteMany({hash: {$in: UtxoFilter}})

  UnallocatedRunes = await processEtching(
    UnallocatedRunes,
    Transaction,
    rpc,
    db
  );

  //Mints are processed next and added to the RuneAllocations, with caps being updated (and burnt in case of cenotaphs)

  UnallocatedRunes = await processMint(
    UnallocatedRunes,
    pendingUtxos,
    Transaction,
    db
  );

  //TODO: process edicts (and include processing with the pointer field)
  console.log(UnallocatedRunes);
};

const testEdictRune = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../dumps/testEdictRune.json"),
    "UTF-8"
  )
);

const test = async () => {
  const rpc_client = createRpcClient({
    url: process.env.BTC_RPC_URL,
    username: process.env.BTC_RPC_USERNAME,
    password: process.env.BTC_RPC_PASSWORD,
  });
  const db = await databaseConnection();

  //const rune = await db.Rune.findOne({where: {name: 'FIAT•IS•HELL•MONEY'}})
  //console.log(isMintOpen(844000, rune))

  processRunestone(testEdictRune, rpc_client, db);
};

test();

module.exports = processRunestone;