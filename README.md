# HID Hub Connect

ESP32-S3製HID Hubの設定用Webページです。

**設定画面：[HID Hub Connect](https://tmaru-eng.github.io/hid-hub-web/)**

## 使い方

1. PCのChromeまたはEdgeで設定画面を開く。
2. HID HubのUART側USBポートとPCをUSBケーブルで接続する。
3. 「UART USBに接続」を押し、対応するUSBシリアルポートを選択する。

設定用のUART通信は115200bpsです。ページはブラウザからUSBシリアルへ直接接続します。機器の状態や設定をサーバーへ送信する処理はありません。「デモを開く」で、本体を接続せず画面とLED表示の例を確認できます。

スマートフォンではページの閲覧・デモはできますが、実機設定にはWeb Serialに対応するPCのブラウザを使ってください。

## 現在の対応

- PC1〜3の共通転送先の選択
- キーボード1・2、マウス1・2の登録／入れ替え／解除
- 旧登録の割り当て、探索候補の選択、処理の確認／中止
- 入力機器とPCのUS/JIS配列設定
- PCごとのOS設定の保存・表示（OS自動判定・OS別キー変換は未対応）
- 本体の4つのボタンの並び（標準／逆）の設定

UART protocol v2に対応したHID Hubファームと組み合わせて使います。ファームのバイナリ配布やブラウザからのファーム書き込みは、このサイトには含まれません。

## 開発と公開

依存パッケージなしで動作します。Node.js 24で確認しています。

```sh
npm test --prefix web
npm run build --prefix web
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

`main`のWebファイルを更新すると、GitHub Actionsがテスト後にGitHub Pagesへ公開します。Pull Requestではテストとビルドのみを行います。Pagesの公開元はGitHub Actionsです。

配信対象は `index.html`、`app.js`、`protocol.js`、`styles.css` の4ファイルだけです。Web用ソースの書き出し元から更新し、生成側だけを編集して二重管理しない運用です。

[GitHub Pagesの公式カスタムワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
