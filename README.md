# muse-code-test-n

超軽量 Worker（コンテナなし・エージェントなし・シークレットなし）。

経緯: 旧 Worker `muse-code-test` は削除済みリポジトリへの接続が残り、
再接続では直らなかったため、新規プロジェクトとして作り直したもの。
Worker 名のみ `muse-code-test-n` に変更し、リポジトリ名は
`nekoserver/muse-code-test` のまま。

役割は「新規プロジェクトでビルドとデプロイが成立すること」の確認まで。
Muse の実行系は `muse-code-wasm` 側に寄せてある
（Worker の WASM Tailscale ノードから muse-vm 上の receiver へ POST し、
receiver 自身が HTTP の待ち受けを兼ねる）。

エンドポイント:

- `GET /health` — `{"status":"ok","worker":"muse-code-test-n"}`
- `GET /` — 説明テキスト
- その他 — 404
