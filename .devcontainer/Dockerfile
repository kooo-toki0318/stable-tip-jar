FROM ghcr.io/foundry-rs/foundry:latest

USER root

# Dev Container Featureがbashを使えるようにする。
# Named Volume上にもfoundryユーザーが書き込めるようにする。
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash \
    && mkdir -p /home/foundry/.foundry/keystores \
    && chown -R foundry:foundry /home/foundry/.foundry \
    && usermod --shell /bin/bash foundry \
    && rm -rf /var/lib/apt/lists/*

# この後に追加されるDev Container FeatureのRUNもbashで実行する。
SHELL ["/bin/bash", "-c"]

USER foundry

# 公式イメージのENTRYPOINTを開発コンテナ向けに解除する。
ENTRYPOINT []
CMD ["sleep", "infinity"]