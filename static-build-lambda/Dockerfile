# Container-image Lambda. Uses bun (like the greta-cloudrun container) to
# install deps + build the user's frontend. Only /tmp is writable at runtime,
# so node_modules and the bun cache go there (see index.mjs run() env).
FROM public.ecr.aws/lambda/nodejs:20

# Tools needed by the bun installer and for archive handling.
RUN dnf install -y tar gzip unzip findutils && dnf clean all

# Lambda starts the image as an unprivileged user. Keep Bun outside /root:
# chmodding /root/.bun/bin is insufficient because /root itself is not
# traversable by that user, which makes spawn() fail with EACCES.
ENV BUN_INSTALL=/opt/bun
RUN mkdir -p "${BUN_INSTALL}" && \
    curl -fsSL https://bun.sh/install | bash && \
    chmod -R a+rX "${BUN_INSTALL}" && \
    "${BUN_INSTALL}/bin/bun" --version
ENV BUN_PATH=/opt/bun/bin/bun
ENV PATH="/opt/bun/bin:${PATH}"

# Handler dependencies (archiver / extract-zip / glob) into the task root.
COPY package.json ${LAMBDA_TASK_ROOT}/
RUN npm install --omit=dev

# Handler code.
COPY index.mjs ${LAMBDA_TASK_ROOT}/

CMD [ "index.handler" ]
