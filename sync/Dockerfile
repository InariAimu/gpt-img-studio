FROM debian:bookworm-slim
COPY studio-sync-server /usr/local/bin/studio-sync-server
USER 1026:100
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/studio-sync-server"]
