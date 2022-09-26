## 準備
### プロジェクト用意
- 既存プロジェクトからnode_module/package-lock.json以外をコピー

### 新規アカウント作成 * 2
- firefoxのsolletからアカウントAを新規作成
- private keyをexportしてphantomに追加
- ガスとペアの両方をAに送ってuserTokenAccountを作成
- serumで適当な注文を出してopenordersaccountを作成(0.024SOLくらいかかる)

### discord * 2
- チャンネル作成
- webhook作成

## パッケージ更新
### serum-amm-arbitrageを更新
- pools.js: 実際にスワップしてtxから確認する, base/quoteはpool source/destから正しいものを選択
- (tokens.js)
- markets.js: serumのmarket id
### git push

## プロジェクト更新
### npm i
パッケージが更新されない場合、node_modules/とpackage-lock.jsonを削除して再インストール
### lambda.jsの更新
コンストラクタの引数は以下の通り
- commitment,                 // String, コネクションのcommitment
- owner,                      // Keypair, 新規作成したアカウントの秘密鍵から生成
- userBaseTokenAccount,       // PublicKey, userのbaseToken(orca-usdcならorca)のAssociated Token Metadata
- userQuoteTokenAccount,      // PublicKey, userのquoteToken(orca-usdcならusdc)のAssociated Token Metadata
- userOpenOrdersAccount,      // PublicKey, serumで注文を出したときに作られたopenOrders
- pool,                       // POOLS.hoge, 
- swapProgram,                // "orca" or "step", swapに使用するPF
- marketInfo,                 // MARKETS.hoge, 
- webHookUrl,                 // String, discordのwebHookUrl
- minOrderQuantityDecimals,   // Number, 最小注文単位の小数点以下の桁数 0.0001なら4
- orderbookIgnoreAmount,      // Number, betterOrder判定の際に無視するbaseTokenAmountの閾値

## AWS Lambda
### lambda用パッケージ作成
- zip -r ../lambda/____-usdc.zip *
### 関数作成
- 関数作成 -> 一から作成 -> ____-____-arbitrage
- ロール等はデフォルト
### ランタイム設定
- ハンドラ: lambda.handler
### 設定
#### 一般設定
- メモリ: 256
- タイムアウト: 1m40s
#### 非同期呼び出し
- 最大有効期限: 5m
- 再試行: 0
### コードアップロード
### テスト実行
- デフォルトのまま実行
- placeOrder等のログがdiscordに出るか
- 異常終了していないか

## AWS CloudWatch
### ルール作成
#### イベントソース
- スケジュール
- Cron式: */1 * * * ? *
#### ターゲット
- Lambda関数: ____-____-arbitrage

### 確認
- ルールを有効にしてログが流れるのを確認
