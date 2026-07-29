FROM ghcr.io/foundry-rs/foundry:latest

USER root

# Named Volumeをマウントしたときもfoundryユーザーが
# keystoreや設定を書き込めるよう、保存先を先に作成する。
RUN mkdir -p /home/foundry/.foundry/keystores \
    && chown -R foundry:foundry /home/foundry/.foundry

USER foundry

# 公式イメージのENTRYPOINTを開発コンテナ向けに解除する。
ENTRYPOINT []
CMD ["sleep", "infinity"]
