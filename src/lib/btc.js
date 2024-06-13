
const { decipherRunestone } = require('./decoder');

const getRunestonesInBlock = async (blockNumber, RpcClient) => {
    console.log(blockNumber)
    const block = await RpcClient.getVerboseBlock(blockNumber)
    const transactions = block.tx
    
    const runestones = transactions.map((tx, txIndex) => (
        {
            runestone: decipherRunestone(tx),
            hash: tx.txid,
            txIndex,
            block: blockNumber,
            vout: tx.vout,
            vin: tx.vin,
            hex: tx.hex
        }
    ))
    
    
    return runestones
}

module.exports = {
    getRunestonesInBlock
}


/*


edict types: mint / transfer / burn / etch

[
    {
        inputs: [
            {
                utxoid: txhash:id,
                owner: address,
                value: amount
                runeInfo: {
                    rune: rune,
                    runeValue: runeValue
                }

            }
        ],

        outputs: [
            {
                utxoid: txhash:id,
                owner: address,
                value: amount,
                lock: locktime blocks (if any),
                runeInfo: {
                    rune: rune,
                    runeValue: runeValue
                    edictType: edictType
                    runestoneJson
                },
                txHex
                txJson
            }
        ]
    }
]
*/