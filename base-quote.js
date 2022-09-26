const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } = require("@solana/web3.js");
const { Market, OpenOrders, Orderbook } = require("@project-serum/serum");
const { Token, AccountLayout, u64 } = require("@solana/spl-token");
const { Buffer } = require('buffer');
const lo = require("buffer-layout");
const { POOLS } = require("./pools");
const { MARKETS } = require("./markets");
const { RPCS } = require("./rpcs");
const { Discord } = require("./discord");
const { User } = require("./user");
const { WrappedConnection, WrappedMarket } = require("./wrapped");

const TX_INTERVAL = 10000;
const PLACE_BETTER_ORDER_TRIGGER_RATE = 1.003;
const CANCEL_ORDER_TRIGGER_RATE = 1.002;
const ORCA_SWAP_FEE = 0.0025;
const STEP_SWAP_FEE = 0.003;
const serumProgram = new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

class Base_Quote {
    constructor(
        commitment,                 // String
        owner,                      // Keypair
        userBaseTokenAccount,       // PublicKey
        userQuoteTokenAccount,      // PublicKey
        userOpenOrdersAccount,      // PublicKey
        pool,                       // POOLS.hoge
        swapProgram,                // "orca" or "step"
        marketInfo,                 // MARKETS.hoge
        webHookUrl,                 // String
        minOrderQuantityDecimals,   // Number
        orderbookIgnoreAmount,      // Number
        isDebug                     // boolean
    ) {
        this.connections = RPCS.map(rpc => {
            return {
                connection: new WrappedConnection(rpc, new Connection(rpc, commitment)),
                weight: 1024,
            }
        });
        this.user = new User(
            owner,
            userBaseTokenAccount,
            userQuoteTokenAccount,
            userOpenOrdersAccount,
        );
        this.amm = {
            pool: pool,
            basePoolPublicKey: new PublicKey(pool.basePool),
            quotePoolPublicKey: new PublicKey(pool.quotePool),
            status: {
                quotePool: 0,
                basePool: 0,
                swapRate: 0,
            }
        };
        this.swapProgram = swapProgram;
        this.marketInfo = marketInfo;
        this.discord = new Discord(webHookUrl);
        this.minOrderQuantityDecimals = minOrderQuantityDecimals;
        this.minOrderQuantity = Math.pow(10, -1 * this.minOrderQuantityDecimals);
        this.orderbookIgnoreAmount = orderbookIgnoreAmount;
        this.isDebug = isDebug;

        this.serumOrderStatus = {
            asks: null,
            bids: null,
            l2: {
                asks: [[0, 0],],
                bids: [[0, 0],],
            },
        };
        this.actionUnixTime = {
            last: 0,
            swap: 0,
            settle: 0,
            cancel: 0,
            place: 0
        };
        this.cancelReason = {
            isNotBetterOrder: false,
            isMyOrderIsolated: false,
            isNarrowedDiviation: false,
        }
    }
    
    consoleDebug() {
        if (this.isDebug) {
            console.log(...arguments);
        }
    }

    getWrappedConnection() {
        const weightSum = this.connections.reduce((sum, con) => sum + con.weight, 0);
        const random = Math.random() * weightSum;
        let pointer = 0;
        let wrappedConnection = this.connections[0].connection;
        for (const con of this.connections) {
            if (random > pointer + con.weight) {
                pointer += con.weight;
            } else if (random >= pointer && random < pointer + con.weight) {
                wrappedConnection = con.connection;
                break;
            } else {
                wrappedConnection = con.connection;
            }
        }
        return wrappedConnection;
    }
    getConnection() {
        return this.getWrappedConnection().connection;
    }
    setConnectionWeightHalf(endpoint) {
        for (const con of this.connections) {
            if (con.connection.endpoint === endpoint) {
                con.weight = con.weight / 2 > 1 ? con.weight / 2 : 1;
            }
        }
    }
    async setConnectionWeightTwice() {
        for (const con of this.connections) {
            con.weight = con.weight * 2 < 1024 ? con.weight * 2 : 1024;
        }
    }
    async notifyError(title, message) {
        const pattern = /https:\/\/.*.com/;
        const endpoints = pattern.exec(message);
        if (endpoints !== null && endpoints.length > 0) {
            this.setConnectionWeightHalf(endpoints[0]);
        }
        await this.discord.error(title, message);
    }

    async main() {
        // this.consoleDebug(this.user.lastOrder)
        try {
            if (this.shouldSwap()) {
                // swap
                this.consoleDebug("Swapping...");
                // base
                await this.swap(
                    this.user.quoteToken.account,
                    this.amm.quotePoolPublicKey,
                    this.amm.basePoolPublicKey,
                    this.user.baseToken.account,
                    this.amm.pool.quoteToken,
                    this.amm.pool.baseToken,
                    this.user.quoteToken.amount.wallet);
            } else if (this.shouldSettle()) {
                const unsettled = this.user.quoteToken.amount.unsettled;
                // settle
                this.consoleDebug("Settling...");
                await this.settleFund();

                const myOrders = this.loadOrdersForOwner();
                const simpleMinMyOrder = { price: 0, size: 0 };
                if (myOrders.length > 0) {
                    const minMyOrder = myOrders.reduce((a, b) => a.price > b.price ? b : a);
                    simpleMinMyOrder.price = minMyOrder.price;
                    simpleMinMyOrder.size = minMyOrder.size;
                    // this.consoleDebug(minMyOrder.price, minMyOrder.size)
                }

                // this.consoleDebug(unsettled / this.user.lastOrder.price, this.user.lastOrder.size * 0.1);
                // this.consoleDebug(this.user.lastOrder.size - simpleMinMyOrder.size, this.user.lastOrder.size * 0.1);
                // unsettledは出たがmyOrderの更新がされていない場合に対応するためorで条件を緩める
                if (this.user.lastOrder.size - simpleMinMyOrder.size > this.user.lastOrder.size * 0.1
                    || unsettled / this.user.lastOrder.price > this.user.lastOrder.size * 0.1) {
                    // cancel
                    this.consoleDebug("Canceling...!");
                    await this.cancelOrder();
                }
            } else if (this.shouldCancelOrder()) {
                // cancel
                this.consoleDebug("Canceling...");
                await this.cancelOrder();
            } else if (this.shouldPlaceOrder()) {
                // place
                this.consoleDebug("Placing...");
                await this.placeOrder(this.user.baseToken.account);
            }
        } catch (err) {
            this.consoleDebug(err.message);
            await this.notifyError("action", err.message);
        }
    };

    async start() {
        this.market = await Market.load(this.getConnection(), new PublicKey(this.marketInfo.address), {}, serumProgram);
        this.wrappedMarket = new WrappedMarket(this.market);
        await this.initialize();
        await this.onSerumChange();
        await this.onUserChange();
        await this.onAmmChange();

        await this.main();
    }

    async initialize() {
        await this.initializeOpenOrders();
        await this.initializeUserBaseToken();
        await this.initializeUserQuoteToken();

        // base
        await this.initializeSerumAsks();

        await this.initializeAmmBasePool();
        await this.initializeAmmQuotePool();
        // update swapRate
        this.amm.status.swapRate = this.calculateSwapRate();

        const myOrders = this.loadOrdersForOwner();
        if (myOrders.length > 0) {
            const minMyOrder = myOrders.reduce((a, b) => a.price > b.price ? b : a);
            this.user.lastOrder.price = minMyOrder.price;
            this.user.lastOrder.size = minMyOrder.size;
        }
        // this.consoleDebug(this.user.lastOrder)
    }

    async initializeOpenOrders() {
        const accountInfo = await this.getConnection().getAccountInfo(this.user.openOrdersAccount);
        const decoded = OpenOrders.getLayout(serumProgram).decode(accountInfo.data);
        this.user.openOrders = new OpenOrders(this.user.openOrdersAccount, decoded, serumProgram);
        this.user.baseToken.amount.unsettled = this.market.baseSplSizeToNumber(decoded.baseTokenFree);
        this.user.quoteToken.amount.unsettled = this.market.quoteSplSizeToNumber(decoded.quoteTokenFree);
    }
    async initializeUserBaseToken() {
        const accountInfo = await this.getConnection().getAccountInfo(this.user.baseToken.account);
        const decoded = AccountLayout.decode(Buffer.from(accountInfo.data));
        this.user.baseToken.amount.wallet = this.market.baseSplSizeToNumber(u64.fromBuffer(decoded.amount));
    }
    async initializeUserQuoteToken() {
        const accountInfo = await this.getConnection().getAccountInfo(this.user.quoteToken.account);
        const decoded = AccountLayout.decode(Buffer.from(accountInfo.data));
        this.user.quoteToken.amount.wallet = this.market.quoteSplSizeToNumber(u64.fromBuffer(decoded.amount));
    }
    async initializeSerumAsks() {
        const accountInfo = await this.getConnection().getAccountInfo(new PublicKey(this.market.decoded.asks));
        const asks = Orderbook.decode(this.market, accountInfo.data);
        this.serumOrderStatus.asks = asks;
        this.serumOrderStatus.l2.asks = asks.getL2(20).map(order => [...order.slice(0, 2)]);
    }
    async initializeSerumBids() {
        const accountInfo = await this.getConnection().getAccountInfo(new PublicKey(this.market.decoded.bids));
        const bids = Orderbook.decode(this.market, accountInfo.data);
        this.serumOrderStatus.bids = bids;
        this.serumOrderStatus.l2.bids = bids.getL2(20).map(order => [...order.slice(0, 2)]);
    }
    async initializeAmmBasePool() {
        const accountInfo = await this.getConnection().getAccountInfo(this.amm.basePoolPublicKey);
        const decoded = AccountLayout.decode(Buffer.from(accountInfo.data));
        this.amm.status.basePool = this.market.baseSplSizeToNumber(u64.fromBuffer(decoded.amount));
    }
    async initializeAmmQuotePool() {
        const accountInfo = await this.getConnection().getAccountInfo(this.amm.quotePoolPublicKey);
        const decoded = AccountLayout.decode(Buffer.from(accountInfo.data));
        this.amm.status.quotePool = this.market.quoteSplSizeToNumber(u64.fromBuffer(decoded.amount));
    }

    // 100ドル分swapするときのrateを計算する
    calculateSwapRate() {
        // base
        const baseTokenAmountForSwap1quoteToken = this.amm.status.basePool * (1 - this.amm.status.quotePool / (this.amm.status.quotePool + 100)) / 100;
        let feeRate = 0;
        if (this.swapProgram === "orca") {
            feeRate = ORCA_SWAP_FEE;
        } else if (this.swapProgram === "step") {
            feeRate = STEP_SWAP_FEE;
        }
        return 1 / (baseTokenAmountForSwap1quoteToken * (1 - feeRate));
    }

    async onUserChange() {
        // unsettled
        this.getConnection().onAccountChange(
            this.user.openOrdersAccount,
            async (accountInfo) => {
                const decoded = OpenOrders.getLayout(serumProgram).decode(accountInfo.data);
                this.user.openOrders = new OpenOrders(this.user.openOrdersAccount, decoded, serumProgram);
                this.user.baseToken.amount.unsettled = this.market.baseSplSizeToNumber(decoded.baseTokenFree);
                this.user.quoteToken.amount.unsettled = this.market.quoteSplSizeToNumber(decoded.quoteTokenFree);
            }
        );

        // wallet
        // userBaseTokenAmount
        this.getConnection().onAccountChange(
            this.user.baseToken.account,
            async (accountInfo) => {
                const decoded = AccountLayout.decode(Buffer.from(accountInfo.data));
                this.user.baseToken.amount.wallet = this.market.baseSplSizeToNumber(u64.fromBuffer(decoded.amount));
            }
        );
        // userQuoteTokenAmount
        this.getConnection().onAccountChange(
            this.user.quoteToken.account,
            async (accountInfo) => {
                const decoded = AccountLayout.decode(Buffer.from(accountInfo.data));
                this.user.quoteToken.amount.wallet = this.market.quoteSplSizeToNumber(u64.fromBuffer(decoded.amount));
            }
        );
    }
    async onSerumChange() {
        // base
        this.getConnection().onAccountChange(
            new PublicKey(this.market.decoded.asks),
            async (accountInfo) => {
                const asks = Orderbook.decode(this.market, accountInfo.data);
                this.serumOrderStatus.asks = asks;
                this.serumOrderStatus.l2.asks = asks.getL2(20).map(order => [...order.slice(0, 2)]);
            }
        );
    }

    async onAmmChange(market) {
        // poolBaseTokenAmount
        this.getConnection().onAccountChange(
            this.amm.basePoolPublicKey,
            async (accountInfo) => {
                const decoded = AccountLayout.decode(Buffer.from(accountInfo.data));
                this.amm.status.basePool = this.market.baseSplSizeToNumber(u64.fromBuffer(decoded.amount));
                if (!(this.amm.status.basePool && this.amm.status.quotePool)) {
                    return;
                }
                // update swapRate
                this.amm.status.swapRate = this.calculateSwapRate();
            }
        );
        // poolQuoteTokenAmount
        this.getConnection().onAccountChange(
            this.amm.quotePoolPublicKey,
            async (accountInfo) => {
                const decoded = AccountLayout.decode(Buffer.from(accountInfo.data));
                this.amm.status.quotePool = this.market.quoteSplSizeToNumber(u64.fromBuffer(decoded.amount));
                if (!(this.amm.status.basePool && this.amm.status.quotePool)) {
                    return;
                }
                // update swapRate
                this.amm.status.swapRate = this.calculateSwapRate();
            }
        );
    }

    // base
    shouldSwap() {
        // 0.1ドル分あるときにswapする
        const walletAmount = this.user.quoteToken.amount.wallet;
        const threshold = 0.1;

        return walletAmount > threshold
            && this.actionUnixTime.swap + TX_INTERVAL < Date.now();
    }
    async swap(
        userSource,
        poolSource,
        poolDestination,
        userDestination,
        sourceToken,
        destToken,
        uiAmountIn,
        slippagePercentage = 1,
    ) {
        try {
            this.actionUnixTime.swap = Date.now();

            const amountIn = uiAmountIn * Math.pow(10, sourceToken.decimals);
            // approve tx
            const userTransferAuthorityKeypair = Keypair.generate();
            const tx = new Transaction().add(Token.createApproveInstruction(
                tokenProgram,
                userSource,
                userTransferAuthorityKeypair.publicKey,
                this.user.keypair.publicKey,
                [this.user.keypair, userTransferAuthorityKeypair],
                amountIn
            ));

            // swap tx
            const minAmountOut = uiAmountIn / this.amm.status.swapRate * (1 - slippagePercentage / 100) * Math.pow(10, destToken.decimals);
            if (this.swapProgram === "orca") {
                tx.add(this.buildOrcaSwapInstruction(
                    this.amm.pool,
                    userTransferAuthorityKeypair.publicKey,
                    userSource,
                    poolSource,
                    poolDestination,
                    userDestination,
                    amountIn,
                    minAmountOut,
                ));
            } else if (this.swapProgram === "step") {
                tx.add(this.buildStepSwapInstruction(
                    this.amm.pool,
                    userTransferAuthorityKeypair.publicKey,
                    userSource,
                    poolSource,
                    poolDestination,
                    userDestination,
                    amountIn,
                    minAmountOut,
                ));
            }

            this.consoleDebug("Amm Status       | SwapRate: " + this.amm.status.swapRate);
            this.consoleDebug("Swap             | UiAmount: " + uiAmountIn);

            const signature = await this.getWrappedConnection().sendTransaction(tx, [this.user.keypair, userTransferAuthorityKeypair]);

            this.actionUnixTime.swap = Date.now();

            const fields = [
                { "name": "SwapRate", "value": String(this.amm.status.swapRate), "inline": true },
                { "name": "Swap UiAmount", "value": String(uiAmountIn), "inline": true },
            ]

            this.consoleDebug("swap Tx     | " + signature);
            await this.discord.success("Swap", "", signature, fields);

            return signature;
        } catch (err) {
            this.consoleDebug(err.message);
            await this.notifyError("swap", err.message);
        }
    }
    buildOrcaSwapInstruction(
        pool,
        userTransferAuthority,
        userSource,
        poolSource,
        poolDestination,
        userDestination,
        amountIn,
        minAmountOut,
    ) {
        const orcaTokenSwapV2 = new PublicKey("9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP");

        const keys = [
            { pubkey: new PublicKey(pool.tokenSwap), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(pool.authority), isSigner: false, isWritable: false },
            { pubkey: userTransferAuthority, isSigner: true, isWritable: false },
            { pubkey: userSource, isSigner: false, isWritable: true },
            { pubkey: poolSource, isSigner: false, isWritable: true },
            { pubkey: poolDestination, isSigner: false, isWritable: true },
            { pubkey: userDestination, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(pool.poolMint), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(pool.feeAccount), isSigner: false, isWritable: true },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
        ];
        const dataLayout = lo.struct([lo.u8('instruction'), lo.nu64('amountIn'), lo.nu64('minAmountOut')]);
        const data = Buffer.alloc(dataLayout.span);
        dataLayout.encode(
            {
                instruction: 1,
                amountIn: amountIn,
                minAmountOut: minAmountOut,
            },
            data
        )
        return new TransactionInstruction({
            keys: keys,
            programId: orcaTokenSwapV2,
            data: data
        });
    }
    buildStepSwapInstruction(
        pool,
        userTransferAuthority,
        userSource,
        poolSource,
        poolDestination,
        userDestination,
        amountIn,
        minAmountOut,
    ) {
        const stepSwapProgram = new PublicKey("SSwpMgqNDsyV7mAgN9ady4bDVu5ySjmmXejXvy2vLt1");

        const keys = [
            { pubkey: new PublicKey(pool.tokenSwap), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(pool.authority), isSigner: false, isWritable: false },
            { pubkey: userTransferAuthority, isSigner: true, isWritable: false },
            { pubkey: userSource, isSigner: false, isWritable: true },
            { pubkey: poolSource, isSigner: false, isWritable: true },
            { pubkey: poolDestination, isSigner: false, isWritable: true },
            { pubkey: userDestination, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(pool.poolMint), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(pool.feeAccount), isSigner: false, isWritable: true },
            { pubkey: this.user.keypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
        ];
        const dataLayout = lo.struct([lo.u8('instruction'), lo.nu64('amountIn'), lo.nu64('minAmountOut')]);
        const data = Buffer.alloc(dataLayout.span);
        dataLayout.encode(
            {
                instruction: 1,
                amountIn: amountIn,
                minAmountOut: minAmountOut,
            },
            data
        )
        return new TransactionInstruction({
            keys: keys,
            programId: stepSwapProgram,
            data: data
        });
    }


    shouldSettle() {
        // unsettledが0.1ドル分あるときにsettleする
        // base
        const unsettledAmount = this.user.quoteToken.amount.unsettled;
        const threshold = 0.1;

        // quoteのunsettledがある(= 約定済み) -> settle
        return unsettledAmount > threshold
            && this.actionUnixTime.settle + TX_INTERVAL < Date.now();
    }

    async settleFund() {
        try {
            this.actionUnixTime.settle = Date.now();
            const wcon = this.getWrappedConnection();
            const signature = await this.wrappedMarket.settleFunds(
                wcon.endpoint,
                [wcon.connection,
                    this.user.keypair,
                    this.user.openOrders,
                    this.user.baseToken.account,
                    this.user.quoteToken.account]);

            this.actionUnixTime.settle = Date.now();
            this.consoleDebug("Settle Tx        | " + signature);
            await this.discord.info("Settle", "", signature);
        } catch (err) {
            this.consoleDebug(err.message);
            await this.notifyError("settleFund", err.message);
        }
    }

    // base
    shouldCancelOrder() {
        const myOrders = this.loadOrdersForOwner();
        if (myOrders.length === 0) {
            return false;
        }
        const betterAsk = this.getBetterAsk();
        const futureBetterAskPrice = round(betterAsk[0] - this.minOrderQuantity, this.minOrderQuantityDecimals);
        const minMyOrdersPrice = myOrders.map(order => order.price).reduce((a, b) => Math.min(a, b));
        const minMyOrders = myOrders.filter(order => order.price == minMyOrdersPrice);

        // 自分の注文の最高金額がbetterOrderではない、かつ
        // 次の注文がbetterOrderトリガーにかからずに出せそう（トリガーにかかる時は注文0の状態を避けるために0.5%利益の位置に注文をだす）
        // or 現在の注文価格とswapRateが離れすぎている（= あまりに約定しなさそうな指値）
        const isNotBetterOrder = minMyOrdersPrice > betterAsk[0]
            && (futureBetterAskPrice / this.amm.status.swapRate > PLACE_BETTER_ORDER_TRIGGER_RATE
                || minMyOrdersPrice / this.amm.status.swapRate > 1.01);

        // 自分の注文askが自分の注文分のみ、かつbetter+1askとの差額がトリガー以上
        const myOrdersAsk = this.serumOrderStatus.l2.asks.find(ask => ask[0] == minMyOrdersPrice);

        const isMyOrderIsolated = (myOrdersAsk != null ?
            myOrdersAsk[1] === minMyOrders.reduce((sum, o) => sum + Number(o.size), 0)
            : false)
            && round(this.getBetterAsk(1)[0] - minMyOrdersPrice, this.minOrderQuantityDecimals) > this.minOrderQuantity * 2;
        // ammと自分の注文の乖離がトリガー以下
        const isNarrowedDiviation = myOrders[0].price / this.amm.status.swapRate < CANCEL_ORDER_TRIGGER_RATE;

        this.cancelReason.isNotBetterOrder = isNotBetterOrder;
        this.cancelReason.isMyOrderIsolated = isMyOrderIsolated;
        this.cancelReason.isNarrowedDiviation = isNarrowedDiviation;

        const result = (isNotBetterOrder || isMyOrderIsolated || isNarrowedDiviation)
            && this.actionUnixTime.cancel + TX_INTERVAL < Date.now();

        return result;
    }

    // myOrders.lengthが2以上のときは正常ではないので
    // キャンセル判定されたらすべてのキャンセルtxを出す
    async cancelOrder() {
        try {
            const myOrders = this.loadOrdersForOwner();
            if (myOrders.length === 0) {
                return;
            }
            this.actionUnixTime.cancel = Date.now();   // cancelOrder中に次のtxを出さないため

            let signatures = []
            for (let order of myOrders) {
                const wcon = this.getWrappedConnection();
                signatures.push(await this.wrappedMarket.cancelOrder(
                    wcon.endpoint,
                    [wcon.connection,
                        this.user.keypair,
                        order]));
            }
            this.actionUnixTime.cancel = Date.now();
            const fields = [
                { "name": "isNotBetterOrder", "value": String(this.cancelReason.isNotBetterOrder), "inline": true },
                { "name": "isMyOrderIsolated", "value": String(this.cancelReason.isMyOrderIsolated), "inline": true },
                { "name": "isNarrowedDiviation", "value": String(this.cancelReason.isNarrowedDiviation), "inline": true },
            ]

            for (const signature of signatures) {
                this.consoleDebug("Cancel Order Tx  | " + signature);
                await this.discord.info("Cancel Order", "", signature, fields);
            }

            return signatures;
        } catch (err) {
            this.consoleDebug(err.message);
            await this.notifyError("cancelOrder", err.message);
        }
    }

    getBetterBid(offset = 0) {
        return this._getBetterOrder(this.serumOrderStatus.l2.bids, offset);
    }
    getBetterAsk(offset = 0) {
        return this._getBetterOrder(this.serumOrderStatus.l2.asks, offset);
    }
    _getBetterOrder(orderbook, offset) {
        let sumOrderbookAmount = 0;
        let i = 0;
        for (i = 0; i < orderbook.length; i++) {
            const bid = orderbook[i];
            sumOrderbookAmount += bid[1];
            if (sumOrderbookAmount > this.orderbookIgnoreAmount) {
                break;
            }
        }
        return orderbook[i + offset] ?? orderbook[i];
    }

    // base
    loadOrdersForOwner() {
        if (this.serumOrderStatus.asks === null) {
            return [];
        }
        return [...this.serumOrderStatus.asks].filter((order) => order.openOrdersAddress.equals(this.user.openOrdersAccount));
    }

    shouldPlaceOrder() {
        const myOrders = this.loadOrdersForOwner();
        return myOrders.length === 0
            && this.actionUnixTime.place + TX_INTERVAL < Date.now();
    }

    // base
    async placeOrder(payer) {
        try {

            const betterAsk = this.getBetterAsk();
            let price = round(betterAsk[0] - this.minOrderQuantity, this.minOrderQuantityDecimals);
            // betteraskとammの乖離が小さすぎるときは余裕を持った指値をする（betterbidを目指さない）
            if (price / this.amm.status.swapRate < PLACE_BETTER_ORDER_TRIGGER_RATE) {
                price = round(this.amm.status.swapRate * 1.005, this.minOrderQuantityDecimals);
            }
            const size = this.user.getBaseTokenAmount();
            const userQuoteTokenAmount = this.amm.status.swapRate * size;

            if (size < 1) {
                // throw new Error("size too small");
                return;
            }

            this.actionUnixTime.place = Date.now();   // placeOrder中に次のtxを出さないため

            this.consoleDebug("Amm Status       | SwapRate: " + this.amm.status.swapRate);
            this.consoleDebug("placeOrder       | price: " + price + ", size: " + size);


            const wcon = this.getWrappedConnection();
            const signature = await this.wrappedMarket.placeOrder(
                wcon.endpoint,
                [wcon.connection,
                    {
                        owner: this.user.keypair,
                        payer,
                        side: 'sell',
                        price: price,
                        size: size,
                        orderType: 'postOnly'}]);
            this.actionUnixTime.place = Date.now();

            this.user.lastOrder.price = price;
            this.user.lastOrder.size = size;

            const fields = [
                { "name": "SwapRate", "value": String(this.amm.status.swapRate), "inline": true },
                { "name": "placeOrder price", "value": String(price), "inline": true },
                { "name": "placeOrder size", "value": String(size), "inline": true },
            ]

            this.consoleDebug("Place Order Tx   | " + signature);
            const desc = "usd value: " + userQuoteTokenAmount;
            await this.discord.info("Place Order", desc, signature, fields);

            return signature;
        } catch (err) {
            this.consoleDebug(err.message);
            await this.notifyError("placeOrder", err.message);
        }
    }
}
module.exports.Base_Quote = Base_Quote;

function round(target, ndigits = 0) {
    return Math.round(target * Math.pow(10, ndigits)) / Math.pow(10, ndigits);
}